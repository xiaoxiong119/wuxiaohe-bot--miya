#!/bin/bash
# 乌小河体检：一条命令看清机器人、进程、日志、磁盘
# 用法：./status.sh

W="$(cd "$(dirname "$0")/.." && pwd)"
VB="$W/05-工程/video-bot"
VM="$W/05-工程/video-to-mediatrack"
export PATH="$HOME/.local/bin:$PATH"

ok()   { printf '  ✓ %s\n' "$1"; }
bad()  { printf '  ✗ %s\n' "$1"; }
warn() { printf '  ! %s\n' "$1"; }

echo "乌小河体检 · $(date '+%Y-%m-%d %H:%M')"
echo

echo "【机器人】"
if [ -f "$VB/.env" ]; then
  APP=$(grep '^FEISHU_APP_ID=' "$VB/.env" | cut -d= -f2)
  echo "  · 应用：$APP"
else
  bad "video-bot 缺 .env"
fi
if [ -f "$VB/config.json" ]; then
  echo "  · 目标项目：$(python3 -c "import json;print(json.load(open('$VB/config.json'))['projectUrl'])" 2>/dev/null)"
fi

echo
echo "【进程】"
if [ -f "$VB/bot.pid" ] && kill -0 "$(cat "$VB/bot.pid")" 2>/dev/null; then
  ok "video-bot 在跑（pid $(cat "$VB/bot.pid")）"
else
  bad "video-bot 没起 —— 终端跑 $VB/start.sh"
fi
if launchctl print "gui/$(id -u)/com.wuxiaohe.videobot" >/dev/null 2>&1; then
  ok "开机自启：已加载（launchd 在管）"
elif [ -f "$HOME/Library/LaunchAgents/com.wuxiaohe.videobot.plist" ]; then
  warn "开机自启：已装未加载（下次登录生效；跑一次 $VB/start.sh 可立即加载）"
else
  warn "开机自启：没装"
fi
if [ -f "$VB/logs/bot.log" ]; then
  echo "  · 日志最后写入：$(date -r "$VB/logs/bot.log" '+%m-%d %H:%M')"
  echo "  · 末行：$(tail -n 1 "$VB/logs/bot.log" | cut -c1-88)"
else
  warn "还没有 bot.log"
fi

echo
echo "【浏览器服务 bsk】"
if bsk status --json >/dev/null 2>&1; then
  ok "在跑"
else
  bad "没在跑 —— 分秒帧上传会失败，先 ./start.sh"
fi

echo
echo "【历史链路 · 旧 daemon】"
if [ -f "$VM/daemon.pid" ] && kill -0 "$(cat "$VM/daemon.pid")" 2>/dev/null; then
  warn "还在跑（pid $(cat "$VM/daemon.pid")）—— 两条链路同时跑会重复上传，建议 ./stop.sh 停掉"
elif pgrep -f 'video-to-mediatrack/daemon\.js|wuxiaohe-upmedia/daemon\.js' >/dev/null 2>&1; then
  warn "有 daemon.js 在跑（pid $(pgrep -f 'video-to-mediatrack/daemon\.js|wuxiaohe-upmedia/daemon\.js' | tr '\n' ' ')）—— 重复上传风险，先停掉"
else
  echo "  · 未运行（正常；2026-10-30 已摘掉它的 launchd 自启任务）"
fi

echo
echo "【磁盘】"
for d in "$VB/downloads" "$VM/downloads"; do
  if [ -d "$d" ]; then
    echo "  · $(basename "$(dirname "$d")")/downloads：$(ls -1 "$d" 2>/dev/null | wc -l | tr -d ' ') 个，$(du -sh "$d" 2>/dev/null | cut -f1)"
  fi
done

echo
echo "更多：06-运维/排错手册.md"
