#!/bin/bash
# 停止乌小河视频转存常驻服务
cd "$(dirname "$0")"

if [ -f daemon.pid ] && kill -0 "$(cat daemon.pid)" 2>/dev/null; then
  PID=$(cat daemon.pid)
  kill "$PID" 2>/dev/null || true
  rm -f daemon.pid
  echo "✓ daemon 已停止（pid $PID）"
else
  rm -f daemon.pid
  echo "· daemon 没在跑"
fi

if [ "$1" = "--with-bsk" ]; then
  PIDS=$(pgrep -f "bsk daemon start" 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill 2>/dev/null || true
    echo "✓ bsk 已停止（$PIDS）"
  fi
fi

echo "提示：只在 daemon 出问题时停 bsk，否则分秒帧上传会失败。"
