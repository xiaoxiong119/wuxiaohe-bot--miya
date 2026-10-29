#!/bin/bash
# 看乌小河的工作日志
#
# 用法（在终端里跑）：
#   ./logs.sh            最近 50 行
#   ./logs.sh 200        最近 200 行
#   ./logs.sh -f         实时跟随，Ctrl+C 退出
#   ./logs.sh err        只看出错的行（❌ / 失败 / ⚠️ / 异常）
#   ./logs.sh 73         只看跟 73 有关的行
#
# 日志文件：05-工程/video-bot/logs/bot.log（一直追加，别删）

set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$HERE/../05-工程/video-bot/logs/bot.log"

if [ ! -f "$LOG" ]; then
  echo "✗ 还没日志：$LOG"
  echo "  机器人还没启动过？在 05-工程/video-bot 里跑 ./start.sh"
  exit 1
fi

ARG="${1:-50}"

case "$ARG" in
  -f|follow|tail)
    echo "→ 实时日志（Ctrl+C 退出）：$LOG"
    tail -f "$LOG"
    ;;
  err|error|错误)
    echo "→ 最近的出错行（最多 50 条）"
    grep -nE "❌|失败|⚠️|异常|Error|error" "$LOG" | tail -50 || echo "（没有错误，干净）"
    ;;
  *[!0-9]*)
    echo "→ 含「$ARG」的行（最多 50 条）"
    grep -n -- "$ARG" "$LOG" | tail -50 || echo "（没找到「$ARG」）"
    ;;
  *)
    echo "→ 最近 $ARG 行：$LOG"
    tail -n "$ARG" "$LOG"
    ;;
esac
