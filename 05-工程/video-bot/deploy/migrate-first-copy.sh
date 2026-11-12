#!/bin/bash
# 首次全量拷贝：本机 video-bot → 新机 ~/video-bot（在小熊本机跑）
# 用法：./migrate-first-copy.sh 新机用户名@新机IP
# 前提：新机已开「远程登录」（SSH）
set -e

SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:?用法: ./migrate-first-copy.sh 新机用户名@新机IP}"

echo "→ 目标：$DEST:~/video-bot"
echo "→ 源：$SRC"
echo

# 架构检查：bsk 二进制是 arm64，新机必须是 Apple Silicon 才能直接拷
ARCH="$(uname -m)"
if [ "$ARCH" != "arm64" ]; then
  echo "⚠️ 本机不是 Apple Silicon？bsk 二进制可能拷不过去，新机需自行安装 bsk"
fi

# 1. 代码全量（含 .env / config.json / 状态快照；不含本地缓存和垃圾）
echo "→ 拷贝代码…"
rsync -a \
  --exclude node_modules --exclude logs --exclude downloads --exclude inbox \
  --exclude backups --exclude review-preview --exclude '.workbuddy' \
  --exclude '.DS_Store' --exclude '.bot.lock' --exclude '.bot.lock-recovery' --exclude 'bot.pid' \
  --exclude 'admin-commands' --exclude 'admin-runtime.json' --exclude '.restart-feedback.json' \
  "$SRC/" "$DEST:video-bot/"

# 2. bsk 二进制（同架构直接拷，省得新机翻墙找官方仓库）
if [ "$ARCH" = "arm64" ]; then
  echo "→ 拷贝 bsk 二进制…"
  ssh "$DEST" 'mkdir -p ~/.local/bin'
  rsync -a "$HOME/.local/bin/bsk" "$DEST:.local/bin/bsk"
fi

echo
echo "✓ 拷贝完成。下一步（在小熊本机执行）："
echo "  ssh $DEST 'bash ~/video-bot/deploy/bootstrap.sh'"
echo
echo "别忘了新机上手动做三件事：装 Chrome 并登录分秒帧、装 bsk 扩展、（装 Syncthing）。"
echo "完整步骤看 README-迁移到新机.md。"
