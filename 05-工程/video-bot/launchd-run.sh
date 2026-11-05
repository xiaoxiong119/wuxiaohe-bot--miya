#!/bin/bash
# launchd 入口 —— 开机/登录自启用（由 ~/Library/LaunchAgents/com.wuxiaohe.videobot.plist 调用）
#
# 和 start.sh 的区别：
#   start.sh 用 python start_new_session 把主进程甩脱、自己立刻退出（给人手动用，终端关了也不死）；
#   这里不能甩脱 —— launchd 要知道"主进程是谁"才能管它（崩了自动拉）。所以最后 exec node，exec 不换 pid。
#
# 用法：
#   ./launchd-run.sh            正常启动（launchd 调用它）
#   ./launchd-run.sh --check    只做自检、不启动：打印解析到的 Node / bsk 状态 / 锁状态
#
# 让位规则：如果已有实例持有 .bot.lock，本脚本 exit 0 直接退出。
#   配合 plist 里 KeepAlive.SuccessfulExit=false，成功退出不会被重拉 → 不会和手动实例抢事件。

set -e
cd "$(dirname "$0")"
BASE="$(pwd)"
mkdir -p logs downloads

CHECK=0
[ "$1" = "--check" ] && CHECK=1

# ---- launchd 给的环境极简（PATH 只有 /usr/bin:/bin:...），下面补齐 start.sh 里踩过的所有坑 ----
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export BSK_AUTO_START=0

# 别继承代理：本地代理随会话消失，机器人会全线 ECONNREFUSED
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NO_PROXY='*'
export no_proxy='*'

# 别继承 WorkBuddy 注入的 Node shim（broker 不在就 connect refused）
unset NODE_OPTIONS

# ---- Node ≥22：先看 PATH，再退回 WorkBuddy 托管目录（新 Mac 装了官方 Node 就走前一条）----
NODE="$(command -v node 2>/dev/null || true)"
if [ -n "$NODE" ]; then
  "$NODE" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' 2>/dev/null || NODE=""
fi
if [ -z "$NODE" ]; then
  for _c in "$HOME"/.workbuddy/binaries/node/versions/*/bin/node; do
    [ -x "$_c" ] || continue
    "$_c" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' 2>/dev/null && NODE="$_c" && break
  done
fi
if [ -z "$NODE" ]; then
  echo "✗ 没找到 Node ≥22，装 Node 22（https://nodejs.org）后重试"
  exit 1
fi
export PATH="$(dirname "$NODE"):$PATH"

# ---- 自检模式：只报告不启动（放最前，锁着也能看）----
LOCKP="$BASE/.bot.lock"
if [ "$CHECK" = "1" ]; then
  echo "BASE    = $BASE"
  echo "NODE    = $NODE ($("$NODE" -v))"
  echo ".env    = $([ -f .env ] && echo 有 || echo 缺)"
  if bsk status --json >/dev/null 2>&1; then echo "bsk     = 在跑"; else echo "bsk     = 没跑（正式启动时会拉起）"; fi
  if [ -f "$LOCKP" ]; then
    OLD="$(/usr/bin/python3 -c 'import json,sys;print(int(json.load(open(sys.argv[1])).get("pid",0)))' "$LOCKP" 2>/dev/null || echo 0)"
    if [ "${OLD:-0}" != "0" ] && kill -0 "$OLD" 2>/dev/null; then
      echo "锁      = 有，持有者 pid $OLD 活着 → 正式启动会让位"
    else
      echo "锁      = 有，持有者 pid ${OLD:-?} 已死 → 正式启动会接管"
    fi
  else
    echo "锁      = 无"
  fi
  exit 0
fi

# ---- 已有实例在跑就让位（exit 0，不触发 KeepAlive 重拉）----
if [ -f "$LOCKP" ]; then
  OLD="$(/usr/bin/python3 -c 'import json,sys;print(int(json.load(open(sys.argv[1])).get("pid",0)))' "$LOCKP" 2>/dev/null || echo 0)"
  if [ "${OLD:-0}" != "0" ] && kill -0 "$OLD" 2>/dev/null; then
    echo "[$(date '+%F %T')] 已有实例在跑（pid $OLD 持有 .bot.lock），launchd 这次让位"
    exit 0
  fi
fi

# ---- bsk 浏览器服务（分秒帧上传靠它驱动 Chrome）----
# 用 start_new_session 甩出去：bsk 是独立守护，不该跟着主进程重启一起死
if ! bsk status --json >/dev/null 2>&1; then
  echo "[$(date '+%F %T')] bsk 没在跑，拉起…"
  python3 - "$BASE" <<'PY'
import subprocess, os, sys
base = sys.argv[1]
log = open(os.path.join(base, 'logs/bsk.log'), 'a')
subprocess.Popen(
    [os.path.expanduser('~/.local/bin/bsk'), 'daemon', 'start', '--foreground'],
    cwd=base, stdout=log, stderr=subprocess.STDOUT,
    start_new_session=True, env=dict(os.environ),
)
PY
fi

# bot.pid 指到即将 exec 的进程（exec 不换 pid，status.sh / stop.sh 照旧认）
echo $$ > bot.pid

echo "[$(date '+%F %T')] launchd 拉起主进程 pid $$（$NODE）"
exec "$NODE" src/index.js
