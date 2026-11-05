#!/bin/bash
# 把本工作区同步到 GitHub（自动脱敏）
#
# 用法：./06-运维/github-push.sh ["提交说明"]
#
# 为什么不用 git push：本地是真实版（含 app id / open_id / 群 id / 本机路径），
# 远端仓库是公开的脱敏版。这个脚本在 /tmp 里克隆一份，把本地文件拷过去、
# 就地替换敏感串，再提交推送。本地文件一个字都不动。
set -euo pipefail

WS="$(cd "$(dirname "$0")/.." && pwd)"
URL="https://github.com/xiaoxiong119/wuxiaohe-bot--miya.git"
TMP="/tmp/wuxiaohe-gh-sync"
PROXY="http://127.0.0.1:6284"
MSG="${1:-同步工作区 $(date '+%Y-%m-%d %H:%M')}"

# 沙箱代理连 github.com 会 502，走系统代理
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy

echo "== 1/5 准备临时克隆 =="
if [ -d "$TMP/.git" ]; then
  git -C "$TMP" -c http.proxy="$PROXY" fetch origin --quiet
  git -C "$TMP" reset --hard origin/main --quiet
else
  rm -rf "$TMP"
  git -c http.proxy="$PROXY" clone --quiet "$URL" "$TMP"
fi

echo "== 2/5 拷贝本地文件 =="
cd "$WS"
git ls-files -z -co --exclude-standard | while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  mkdir -p "$TMP/$(dirname "$f")"
  cp -f "$f" "$TMP/$f"
done

echo "== 3/5 脱敏（内容）=="
find "$TMP" -path "$TMP/.git" -prune -o -type f \
  \( -name '*.md' -o -name '*.json' -o -name '*.js' -o -name '*.sh' \
     -o -name '*.html' -o -name '*.txt' -o -name '*.csv' -o -name '*.command' \
     -o -name '*.example' -o -name '*.slide' -o -name '*.flow' -o -name '*.yml' \) -print0 |
while IFS= read -r -d '' f; do
  perl -pi -e '
    s/cli_(?!x)[a-z0-9]{12,}/[已脱敏]/g;
    s/\bou_[a-f0-9]{20,}\b/[已脱敏]/g;
    s/\boc_[a-f0-9]{20,}\b/[已脱敏]/g;
    s/\bom_[a-f0-9]{20,}\b/[已脱敏]/g;
    s/\bob_[a-f0-9]{20,}\b/[已脱敏]/g;
    s{\Q~\E}{~}g;
  ' "$f"
done

echo "== 4/5 脱敏（文件名）=="
cd "$TMP"
find . -path ./.git -prune -o -type f -print0 |
while IFS= read -r -d '' f; do
  new="$(printf '%s' "$f" | sed -E 's/cli_[a-z0-9]{12,}/cli_已脱敏/g')"
  [ "$f" = "$new" ] || mv "$f" "$new"
done

# bot-info.json 沿用仓库原有占位写法
if [ -f "$TMP/01-身份/bot-info.json" ]; then
  perl -pi -e 's/\[已脱敏\]/请在部署时填写/g' "$TMP/01-身份/bot-info.json"
fi

echo "== 5/5 校验 + 提交 =="
cd "$TMP"
LEAK="$(perl -CSD -ne '
  if (/cli_(?!x)[a-z0-9]{12,}/ || /\bou_[a-f0-9]{20,}\b/ || /\boc_[a-f0-9]{20,}\b/ || m{~}) {
    print "$ARGV\n"; close ARGV;
  }
' $(find . -path ./.git -prune -o -type f \( -name '*.md' -o -name '*.json' -o -name '*.js' -o -name '*.sh' -o -name '*.html' -o -name '*.txt' -o -name '*.csv' -o -name '*.command' \) -print) 2>/dev/null || true)"
if [ -n "$LEAK" ]; then
  echo "!! 仍有敏感串残留，已中止，未推送："
  echo "$LEAK"
  exit 1
fi

git add -A
if git diff --cached --quiet; then
  echo "没有变化，不需要推送。"
  exit 0
fi
git -c user.name=xiaoxiong119 \
    -c user.email=128687063+xiaoxiong119@users.noreply.github.com \
    commit -q -m "$MSG"
git -c http.proxy="$PROXY" push origin main
echo "完成：$(git log --oneline -1)"
