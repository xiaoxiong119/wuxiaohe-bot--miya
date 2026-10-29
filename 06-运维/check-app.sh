#!/bin/bash
# 验一个飞书应用到底通到哪一步
# 用法：./check-app.sh [profile]     默认 profile = 当前配置
#       ./check-app.sh [已脱敏]

export PATH="$HOME/.local/bin:$PATH"
PROFILE="${1:-}"

lark() {
  if [ -n "$PROFILE" ]; then
    lark-cli --profile "$PROFILE" "$@"
  else
    lark-cli "$@"
  fi
}

J() { python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    print('解析失败'); raise SystemExit
$1
"; }

echo "体检应用${PROFILE:+：$PROFILE}"
echo

echo "【1】身份"
lark whoami | J "
print('  · appId   ' + str(d.get('appId')))
print('  · 身份    ' + str(d.get('identity')) + ' / token ' + str(d.get('tokenStatus')))
"

echo
echo "【2】机器人"
lark api GET /open-apis/bot/v3/info --as bot | J "
if d.get('ok'):
    b = d['data']
    print('  ✓ ' + b.get('app_name', '?') + '（activate_status ' + str(b.get('activate_status')) + '）')
    print('  · open_id ' + b.get('open_id', '?'))
else:
    print('  ✗ ' + str((d.get('error') or {}).get('message', ''))[:110])
"

echo
echo "【3】业务权限"
ok=0

chk() {
  local label="$1"; shift
  local out
  out=$(lark "$@" 2>&1)
  if echo "$out" | grep -q '"ok": true'; then
    echo "  ✓ $label"
    ok=$((ok + 1))
  else
    local msg
    msg=$(echo "$out" | J "print(str((d.get('error') or {}).get('message', ''))[:100])" 2>/dev/null)
    echo "  ✗ $label —— ${msg:-调用失败}"
  fi
}

chk "列群（im:chat:read）"                    api GET /open-apis/im/v1/chats --as bot
chk "列斜杠命令（app_slash_command:read）"     application +slash-command-list

APPID=$(lark whoami | J "print(d.get('appId', ''))" 2>/dev/null)
if [ -n "$APPID" ]; then
  chk "读应用信息（self_manage）" api GET "/open-apis/application/v6/applications/$APPID" --as bot --params '{"lang":"zh_cn"}'
fi

echo
if [ "$ok" -ge 2 ]; then
  echo "过了 $ok 项，能干活。"
else
  echo "过 $ok 项 —— 权限还没申请，或申请了但版本没发布。"
  echo "开通入口：https://open.feishu.cn/app/${APPID}/auth"
fi
