#!/bin/bash
# 启动飞书视频机器人（bsk 浏览器服务 + 长连接主进程）
# 用法：./start.sh
#
# 用 python 的 start_new_session 启动，进程脱离当前 shell 的进程组，
# 终端/WorkBuddy 会话结束也不会被带走（nohup 会被带走，别用）。

set -e
cd "$(dirname "$0")"
mkdir -p logs downloads

export PATH="$HOME/.local/bin:$PATH"
export BSK_AUTO_START=0
export TZ=Asia/Shanghai

# 别继承 WorkBuddy / 终端里的代理：那个本地代理随会话消失，机器人会全线 ECONNREFUSED
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
export NO_PROXY='*'
export no_proxy='*'

# 也别继承 WorkBuddy 注入的 Node shim（2026-10-28 踩到）：
# 从 WorkBuddy 的终端里起机器人时，NODE_OPTIONS 会带上 node-language-shim.cjs，
# 它要连 WorkBuddy 的 broker 才干活，broker 没了就报
#   Error: connect failed: Connection refused  → 上传子进程直接 exit 1
# 表现就是「下载完了、上传一开始就崩」。只清 NODE_OPTIONS，别动 PATH
# （PATH 里的 brokered-bin 是 WorkBuddy 沙箱的一部分，删掉会连 cat/python3 都找不到）。
case "${NODE_OPTIONS:-}" in
  *node-language-shim*|*node-brokered-fs-shim*) unset NODE_OPTIONS ;;
esac

# 找 Node（≥22）：先看 PATH（运行机上装了官方 Node），没有再退回 WorkBuddy 托管目录（小熊本机）
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
  echo "✗ 没找到 Node ≥22：先装 Node 22（https://nodejs.org 或 brew install node@22）再跑"
  exit 1
fi
export PATH="$(dirname "$NODE"):$HOME/.local/bin:$PATH"
BASE="$(pwd)"

# 已经在跑就别再起一个：两个进程会抢同一个应用的事件，消息会丢
if [ -f bot.pid ] && kill -0 "$(cat bot.pid)" 2>/dev/null; then
  echo "✗ 已经在跑了（pid $(cat bot.pid)），别重复启动。要重启先 ./stop.sh"
  exit 1
fi

if [ ! -f .env ]; then
  echo "✗ 缺 .env —— 复制 .env.example 为 .env，填 App ID / App Secret"
  exit 1
fi

# 0. 防重复上传：旧的轮询 daemon 还在跑就先停掉
# 0.5 清掉上次没跑完的 /tbpz 采集脚本（孤儿进程会一直开着浏览器页面占着 bsk）
pkill -f '[/]tbpz-collect(_v00[45])?\.sh' 2>/dev/null && echo "已清掉残留的 /tbpz 采集进程" || true
OLD_PID_FILE="$BASE/../video-to-mediatrack/daemon.pid"
# 不能只看 daemon.pid：它是陈旧值（78625）时就形同虚设。
# 注意旧 launchd 任务是通过软链 ~/wuxiaohe-upmedia 起的，命令行里不含 video-to-mediatrack，两个都要匹配。
OLD_PIDS="$(pgrep -f 'video-to-mediatrack/daemon\.js|wuxiaohe-upmedia/daemon\.js' 2>/dev/null | tr '\n' ' ')"
if [ -n "${OLD_PIDS// /}" ] || { [ -f "$OLD_PID_FILE" ] && kill -0 "$(cat "$OLD_PID_FILE")" 2>/dev/null; }; then
  echo "✗ 旧的 video-to-mediatrack daemon 还在跑（pid ${OLD_PIDS:-$(cat "$OLD_PID_FILE" 2>/dev/null)}）"
  echo "  两套同时跑会把同一个视频传两遍。先停："
  echo "  cd $BASE/../video-to-mediatrack && ./stop.sh"
  exit 1
fi

# 装了开机自启（LaunchAgent）就交给 launchd 托管，别自己起：
# 只有 launchd 管得住 KeepAlive（崩了自动拉），手动起的实例它管不到。
LABEL="com.wuxiaohe.videobot"
AGENT_PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ -f "$AGENT_PLIST" ] && ! launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  if launchctl bootstrap "gui/$(id -u)" "$AGENT_PLIST" 2>/dev/null; then
    sleep 4
    if [ -f bot.pid ] && kill -0 "$(cat bot.pid)" 2>/dev/null; then
      echo "✓ 已交给开机自启任务（${LABEL}）启动（pid $(cat bot.pid)）"
      echo "日志：tail -f $BASE/logs/bot.log"
      exit 0
    fi
    echo "! launchd 接走了但没看到进程，改回手动启动"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  fi
fi

# 1. bsk 浏览器服务（分秒帧上传靠它驱动 Chrome）
if bsk status --json >/dev/null 2>&1; then
  echo "✓ bsk 已在运行"
else
  echo "→ 启动 bsk…"
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
  sleep 5
  if bsk status --json >/dev/null 2>&1; then
    echo "✓ bsk 已启动"
  else
    echo "✗ bsk 启动失败，看 logs/bsk.log"
    exit 1
  fi
fi

# 2. 长连接主进程
python3 - "$BASE" "$NODE" <<'PY'
import subprocess, os, sys
base, node = sys.argv[1], sys.argv[2]
log = open(os.path.join(base, 'logs/bot.log'), 'a')
p = subprocess.Popen(
    [node, os.path.join(base, 'src/index.js')],
    cwd=base, stdout=log, stderr=subprocess.STDOUT,
    start_new_session=True, env=dict(os.environ),
)
open(os.path.join(base, 'bot.pid'), 'w').write(str(p.pid))
print(f'✓ 主进程已启动（pid {p.pid}）')
PY

sleep 3
echo
echo "机器人已上线：发视频 → 发 /upmedia 名字 → 传到分秒帧（重命名成那个名字）。"
echo "日志：tail -f $BASE/logs/bot.log"
