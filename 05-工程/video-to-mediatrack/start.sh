#!/bin/bash
# 启动乌小河视频转存常驻服务（bsk 浏览器服务 + daemon 监听）
# 用法：./start.sh
#
# 关键：用 python 的 start_new_session 启动，进程会脱离当前 shell 的进程组，
# 这样即使启动它的终端 / WorkBuddy 会话结束，服务也不会被一起带走。

set -e
cd "$(dirname "$0")"
mkdir -p logs

export PATH="/Users/fanxiaoli/.local/bin:/Users/fanxiaoli/.workbuddy/binaries/node/versions/20.18.0/bin:/Users/fanxiaoli/.workbuddy/binaries/node/versions/22.22.2-6/bin:$PATH"
export BSK_AUTO_START=0

NODE=/Users/fanxiaoli/.workbuddy/binaries/node/versions/22.22.2-6/bin/node
BASE="$(pwd)"

# 1. bsk 浏览器服务
if bsk status --json >/dev/null 2>&1; then
  echo "✓ bsk 已在运行"
else
  echo "→ 启动 bsk…"
  python3 - "$BASE" <<'PY'
import subprocess, os, sys
base = sys.argv[1]
log = open(os.path.join(base, 'logs/bsk.log'), 'a')
subprocess.Popen(
    ['/Users/fanxiaoli/.local/bin/bsk', 'daemon', 'start', '--foreground'],
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

# 2. daemon 监听
python3 - "$BASE" "$NODE" <<'PY'
import subprocess, os, sys
base, node = sys.argv[1], sys.argv[2]
log = open(os.path.join(base, 'logs/daemon.log'), 'a')
p = subprocess.Popen(
    [node, os.path.join(base, 'daemon.js')],
    cwd=base, stdout=log, stderr=subprocess.STDOUT,
    start_new_session=True, env=dict(os.environ),
)
open(os.path.join(base, 'daemon.pid'), 'w').write(str(p.pid))
print(f'✓ daemon 已启动（pid {p.pid}）')
PY

sleep 2
echo
echo "收到视频会自动传到分秒帧，不用发命令。"
echo "日志：tail -f $(pwd)/logs/daemon.log"
