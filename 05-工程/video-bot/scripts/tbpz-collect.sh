#!/bin/bash
# 采集分秒帧批注 → JSON 行文件（支持增量）
# 用法：./tbpz-collect.sh <项目链接> <输出文件> [最多几个视频] [since毫秒时间戳]
#
# 做法：
#   1) 把列表从头往下滚，累计「视频名 + 出现顺序 + 更新时间」；列表按更新时间倒序，
#      传了 since 就在滚过「比 since 旧的整屏卡片」时提前停（增量只要 1-2 屏）
#   2) 增量再补一条路：打开右上「消息通知」，把带「添加了评论」的条目里的文件名捞出来。
#      ——2026-10-28 起必须这么做：批注不会刷新文件的更新时间，只按更新时间筛会漏掉
#        「老视频上新增的批注」（比如 107/108 是 17:19 更新、18:09 才被批注）
#   3) 按顺序逐个打开读批注；用 cursor 记住上次位置，找不到就从头再来一轮
#
# 2026-10-28 改版要点：
#   · 列表卡片的批注角标（[class*="_comment_"]）在新版 UI 里已经没有了 →
#     不再用角标筛目标，否则 targets 恒为 0（这就是「视频 0 个 / 读到批注 0 条」的根因）。
#     现在增量按更新时间 + 消息通知取候选，全量就是所有视频。
#   · 诊断行（MODE / SCANNED / TARGETS）打到 stderr，会进 bot.log，方便下次排查。
#
# 为什么用 bash 而不是 Node 里 execFileSync 调 bsk：Node 里连续调会卡住（等不到 EOF）。
set -u
export PATH="$HOME/.local/bin:$PATH"
export BSK_AUTO_START=0

URL="$1"
OUT="$2"
LIMIT="${3:-0}"
SINCE_MS="${4:-0}"
TMP="$(mktemp -d)"

SID=$(bsk session start --json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))")
if [ -z "$SID" ]; then
  echo "ERR 开不了浏览器会话" >&2
  exit 2
fi
trap 'bsk session stop "$SID" >/dev/null 2>&1; rm -rf "$TMP"' EXIT

scroll_by() {
  bsk evaluate --session "$SID" "(()=>{const it=document.querySelector('div.item');if(!it)return '-1';let p=it.parentElement;while(p&&p.scrollHeight<=p.clientHeight+20)p=p.parentElement;if(!p)return '-1';const b=p.scrollTop;p.scrollTop=b+p.clientHeight*($1);return b+'->'+p.scrollTop})()" 2>/dev/null | tail -1
}

scroll_set() {
  bsk evaluate --session "$SID" "(()=>{const it=document.querySelector('div.item');if(!it)return '-1';let p=it.parentElement;while(p&&p.scrollHeight<=p.clientHeight+20)p=p.parentElement;if(!p)return '-1';p.scrollTop=$1;return String(p.scrollTop)})()" 2>/dev/null | tail -1
}

VISIBLE_JS='JSON.stringify([...document.querySelectorAll("div.item")].map(c=>{const i=c.querySelector("img[alt]");const b=c.querySelector("[class*=_comment_]");const m=/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.exec(c.innerText);return {n:i?i.getAttribute("alt"):"",c:b?(parseInt(b.innerText,10)||0):0,t:m?m[0]:""}}).filter(x=>x.n))'

bsk navigate --session "$SID" "$URL" >/dev/null 2>&1
sleep 7

# ---------- 阶段 1：枚举（增量模式滚过边界就停） ----------
: > "$TMP/names.jsonl"
STEPS=0
for i in $(seq 1 80); do
  bsk evaluate --session "$SID" "$VISIBLE_JS" 2>/dev/null | tail -1 >> "$TMP/names.jsonl"
  if [ "$SINCE_MS" != "0" ]; then
    STOP=$(SINCE_MS="$SINCE_MS" python3 - "$TMP/names.jsonl" <<'PYEOF'
import json, sys, os
from datetime import datetime
since = datetime.fromtimestamp(int(os.environ['SINCE_MS']) / 1000).strftime('%Y-%m-%d %H:%M')
best = ''
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    try:
        arr = json.loads(line)
    except Exception:
        continue
    for x in arr:
        t = x.get('t') or ''
        if t > best:
            best = t
# 本轮见过的最新时间都老于 since → 边界已过，可以停
print('STOP' if best and best < since else 'GO')
PYEOF
)
    [ "$STOP" = "STOP" ] && { echo "增量边界已过，停止滚动" >&2; break; }
  fi
  R=$(scroll_by 0.9)
  STEPS=$((STEPS+1))
  case "$R" in
    *"->"*) prev=${R%%->*}; cur=${R##*->}; [ "$prev" = "$cur" ] && break ;;
  esac
  sleep 0.9
done
echo "SCANNED steps=$STEPS" >&2

# ---------- 阶段 1b：增量补捞「消息通知」里的新批注 ----------
# 批注不刷新文件更新时间，只靠更新时间筛会漏。通知里有「添加了评论：… + 文件名」。
: > "$TMP/notes.txt"
if [ "$SINCE_MS" != "0" ]; then
  bsk click --session "$SID" --selector "[aria-label='消息通知']" >/dev/null 2>&1
  sleep 3
  bsk evaluate --session "$SID" 'document.body.innerText' 2>/dev/null >> "$TMP/notes.txt"
  # 再滚一下通知列表，多捞几条
  bsk evaluate --session "$SID" "(()=>{const leaves=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&/全部已读/.test(e.innerText||''));if(!leaves.length)return '0';let p=leaves[0];for(let k=0;k<6;k++){if(!p.parentElement)break;p=p.parentElement;if(p.scrollHeight>p.clientHeight+20){p.scrollTop=p.scrollHeight;return '1'}}return '0'})()" >/dev/null 2>&1
  sleep 2
  bsk evaluate --session "$SID" 'document.body.innerText' 2>/dev/null >> "$TMP/notes.txt"
  bsk click --session "$SID" --selector "[aria-label='消息通知']" >/dev/null 2>&1
  sleep 1
fi

SINCE_MS="$SINCE_MS" python3 - "$TMP/names.jsonl" "$TMP/targets.txt" "$LIMIT" "$TMP/notes.txt" <<'PYEOF'
import json, sys, re, os
from datetime import datetime, timedelta

since_ms = int(os.environ.get('SINCE_MS') or 0)
# 往前多要 10 分钟，防止边界卡片的时间在两次运行间被四舍五入吃掉
since_str = (datetime.fromtimestamp(since_ms / 1000) - timedelta(minutes=10)).strftime('%Y-%m-%d %H:%M') if since_ms else ''

order = {}
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    try:
        arr = json.loads(line)
    except Exception:
        continue
    for x in arr:
        n = x.get('n') or ''
        if not n:
            continue
        cur = order.setdefault(n, {'idx': len(order), 'count': 0, 't': ''})
        cur['count'] = max(cur['count'], int(x.get('c') or 0))
        cur['t'] = max(cur['t'], x.get('t') or '')

# 卡片候选：增量按更新时间；全量全要。
# 注意：不再要求 count>0 —— 新版列表已经没有批注角标，那个字段恒为 0。
def is_video(n):
    return bool(re.search(r'\.(mov|mp4|mkv|avi|m4v|webm)$', n, re.I))

targets = [(n, v['idx'], v['count']) for n, v in order.items()
           if is_video(n) and (not since_str or v['t'] >= since_str)]

# 通知补充：带「添加了评论」的条目 → 文件名
note_files = []
txt = ''
if len(sys.argv) > 4:
    try:
        txt = open(sys.argv[4], encoding='utf-8', errors='ignore').read()
    except Exception:
        txt = ''
lines = [l.strip() for l in txt.split('\n')]
for i, l in enumerate(lines):
    if '添加了评论' not in l:
        continue
    fname = ''
    for k in range(i + 1, min(i + 6, len(lines))):
        m = re.search(r'([^\s/]+\.(?:mov|mp4|mkv|avi|m4v|webm))', lines[k], re.I)
        if m:
            fname = m.group(1)
            break
    if fname and fname not in note_files:
        note_files.append(fname)

for n in note_files:
    if n in order or not is_video(n):
        continue
    order[n] = {'idx': len(order), 'count': 0, 't': ''}
    targets.append((n, -1, 0))

targets.sort(key=lambda t: t[1] if t[1] >= 0 else 10 ** 6)
limit = int(sys.argv[3] or 0)
if limit > 0:
    targets = targets[:limit]

mode = '增量(卡片>= %s + 通知 %d 个)' % (since_str, len(note_files)) if since_str else '全量'
print('MODE %s ALL_CARDS %d TARGETS %d' % (mode, len(order), len(targets)), file=sys.stderr)
with open(sys.argv[2], 'w') as f:
    for n, idx, c in targets:
        f.write('%s\t%d\t%d\n' % (n, idx, c))
PYEOF

: > "$OUT"
PROG="$OUT.progress"
: > "$PROG"

# ---------- 阶段 2：逐个打开 ----------
echo "TARGETS $(wc -l < "$TMP/targets.txt" | tr -d ' ')" >> "$PROG"
try_open() {
  local file="$1" from="$2" tries="$3" i r d a b
  scroll_set "$from" >/dev/null 2>&1
  for i in $(seq 1 "$tries"); do
    r=$(bsk evaluate --session "$SID" "(()=>{const cards=[...document.querySelectorAll('div.item')];const h=cards.find(c=>{const i=c.querySelector('img[alt]');return i&&i.getAttribute('alt')==='${file}'});if(!h)return 'NF';let p=h.parentElement;while(p&&p.scrollHeight<=p.clientHeight+20)p=p.parentElement;const pos=p?p.scrollTop:0;const th=h.querySelector('[class*=thumbnail]')||h;th.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window}));return 'OK:'+pos})()" 2>/dev/null | tail -1)
    case "$r" in
      OK:*) echo "$r"; return 0 ;;
    esac
    d=$(scroll_by 0.9)
    sleep 0.9
    case "$d" in
      *"->"*) a=${d%%->*}; b=${d##*->}; [ "$a" = "$b" ] && break ;;
    esac
  done
  echo "NF"
  return 1
}

CURSOR=0
while IFS=$'\t' read -r FILE IDX COUNT; do
  [ -z "$FILE" ] && continue

  R=$(try_open "$FILE" "$CURSOR" 40)
  if [ "${R%%:*}" != "OK" ]; then
    R=$(try_open "$FILE" 0 40)
  fi
  if [ "${R%%:*}" != "OK" ]; then
    echo "MISS $FILE" >&2
    continue
  fi
  CURSOR=${R#OK:}

  sleep 6
  BODY=$(bsk evaluate --session "$SID" 'document.body.innerText' 2>/dev/null)
  FILE="$FILE" COUNT="$COUNT" BODY="$BODY" python3 - >> "$OUT" <<'PYEOF'
import json, os
print(json.dumps({'file': os.environ['FILE'], 'count': int(os.environ['COUNT']), 'body': os.environ.get('BODY', '')}, ensure_ascii=False))
PYEOF
  echo "GOT $FILE" >&2
  echo "DONE $FILE $COUNT" >> "$PROG"

  bsk navigate-back --session "$SID" >/dev/null 2>&1
  sleep 2
done < "$TMP/targets.txt"

echo "DONE $OUT" >&2
