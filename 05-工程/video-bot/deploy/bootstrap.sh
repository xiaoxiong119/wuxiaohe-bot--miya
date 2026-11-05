#!/bin/bash
# 新机一键初始化：ssh 进新机后跑 bash ~/video-bot/deploy/bootstrap.sh（可重复执行）
set -e
cd "$(dirname "$0")/.."
BASE="$(pwd)"
echo "→ 初始化 $BASE"
echo

echo "== 1/5 Node ≥22 =="
if command -v node >/dev/null 2>&1 && [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ] 2>/dev/null; then
  echo "✓ Node $(node -v)"
else
  echo "✗ 缺 Node ≥22。两种装法任选，装完重跑本脚本："
  echo "   ① 官网 pkg：https://nodejs.org（22 LTS）"
  echo "   ② brew install node@22（没装 brew 先装 brew）"
  exit 1
fi

echo "== 2/5 npm 依赖 =="
npm install --omit=dev
if [ -f .env ]; then echo "✓ .env 已就位"; else echo "✗ 缺 .env（migrate-first-copy.sh 应该带过来了）"; exit 1; fi
if [ -f config.json ]; then echo "✓ config.json 已就位"; else echo "✗ 缺 config.json"; exit 1; fi

echo "== 3/5 bsk（分秒帧上传链路） =="
if [ -x "$HOME/.local/bin/bsk" ]; then
  echo "✓ bsk 二进制已就位"
else
  echo "✗ 缺 ~/.local/bin/bsk —— 在小熊本机重跑 deploy/migrate-first-copy.sh 会顺带拷过来"
fi
echo "  ⚠️ 手动项：装 Chrome → 登录分秒帧 → 装 bsk 浏览器扩展（不做这个上传必挂）"

echo "== 4/5 launchd 开机自启 =="
mkdir -p logs
PLIST="$HOME/Library/LaunchAgents/com.feishu-videobot.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.feishu-videobot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$BASE/start.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>Crashed</key><true/></dict>
  <key>StandardOutPath</key><string>$BASE/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$BASE/logs/launchd.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/com.feishu-videobot" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "✓ launchd 已装（开机自动起，崩溃自动拉起）"

echo "== 5/5 Syncthing =="
if command -v syncthing >/dev/null 2>&1 || [ -d /Applications/Syncthing.app ]; then
  echo "✓ Syncthing 已装"
else
  echo "→ 装 Syncthing：brew install --cask syncthing（或 https://syncthing.net 下 app）"
  echo "  装好启动后，按 deploy/README-迁移到新机.md 的「迁移步骤 C」和小熊本机配对。"
fi

echo
echo "== 初始化完成 =="
echo "缺项按上面提示补齐。正式上线前先看 README-迁移到新机.md 的「切换日」清单："
echo "本机停机器人 → 本机停 bsk → 这边 start.sh → 飞书发消息验证。"
echo "（同一时间只能一台机器跑机器人，两台同跑会丢消息）"
