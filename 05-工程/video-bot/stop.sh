#!/bin/bash
# 停止飞书视频机器人
cd "$(dirname "$0")"

# 提醒：正在跑的 /tbpz 会被一并杀掉，那一轮同步就白跑了
if pgrep -f 'tbpz-collect.sh' >/dev/null 2>&1; then
  echo "⚠️  有个 /tbpz 采集正在跑，停机会把它打断（这一轮的批注就白采了）"
  echo "    要等它跑完就 30 秒后再看 tail -f logs/bot.log；坚持要停 5 秒后自动继续…"
  sleep 5
fi

if [ -f bot.pid ] && kill -0 "$(cat bot.pid)" 2>/dev/null; then
  PID=$(cat bot.pid)
  kill "$PID" 2>/dev/null || true
  rm -f bot.pid
  echo "✓ 主进程已停止（pid $PID）"
else
  rm -f bot.pid
  echo "· 主进程没在跑"
fi

if [ "$1" = "--with-bsk" ]; then
  PIDS=$(pgrep -f "bsk daemon start" 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "$PIDS" | xargs kill 2>/dev/null || true
    echo "✓ bsk 已停止（$PIDS）"
  fi
fi
