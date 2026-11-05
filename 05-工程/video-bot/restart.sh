#!/bin/bash
# 重启机器人（本机/新机通用；日常用法：ssh 新机 'bash ~/video-bot/restart.sh'）
# 适用于：代码同步过来后让改动生效（index.js / reviewsync.js / config.json 要重启才生效）
#
# 装了开机自启（LaunchAgent com.wuxiaohe.videobot）时走 launchctl kickstart，
# 让 launchd 自己杀+拉，避免"kill 完被 KeepAlive 立刻拉回来"。
cd "$(dirname "$0")"

LABEL="com.wuxiaohe.videobot"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  echo "→ 已装开机自启，交给 launchd 重启…"
  launchctl kickstart -k "gui/$(id -u)/$LABEL" && echo "✓ 已重启（$LABEL）"
  sleep 4
  if [ -f bot.pid ] && kill -0 "$(cat bot.pid)" 2>/dev/null; then
    echo "✓ 新进程在跑（pid $(cat bot.pid)）"
    echo "日志：tail -f $(pwd)/logs/bot.log"
    exit 0
  fi
  echo "✗ 拉起来后没看到进程，看日志：tail -20 $(pwd)/logs/bot.log"
  exit 1
fi

./stop.sh
sleep 2
./start.sh
