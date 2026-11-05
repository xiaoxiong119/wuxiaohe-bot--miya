#!/bin/bash
# 采集分秒帧批注 → JSON 行文件（支持增量）  v002 / 2026-11-02
# 用法：./tbpz-collect_v002.sh <项目链接> <输出文件> [最多几个视频] [since毫秒时间戳]
#
# 相对 v001 的改动（2026-11-02）：
#   1) 卡片角标恢复可用：新版 UI 的角标是 div[class*=comment_text]，读得到数字（实测 40.mp4=10）。
#      v001 以为角标恒为 0 → 全量时把 99 个视频全点了一遍，大量空跑。
#      现在 v002 只点「角标 > 0」的卡片；无角标准确判定为没有批注，直接跳过。
#   2) 批注列表是虚拟滚动（懒加载）：只抓一次 document.body.innerText 只能拿到首屏。
#      实测 40.mp4 角标 10 条，首屏只渲染 6 条，滚到底才补齐。
#      v002 改为：面板滚到顶 → 反复「抓快照 + 向下滚 0.7 屏」→ 直到滚不动 → 合并去重。
#   3) 每行输出结构化 comments 数组（不再依赖 Node 端二次解析整页文本）。
#   4) 记录「读到 N 条 / 角标 M 条」，不一致时在 stderr 打 SHORT，方便排查。
#
# 做法：
#   1) 把列表从头往下滚，累计「视频名 + 出现顺序 + 更新时间 + 角标数」；增量传了 since
#      就在滚过「比 since 旧的整屏卡片」时提前停。
#   2) 增量再补一条路：打开右上「消息通知」，把带「添加了评论」的条目里的文件名捞出来
#      （批注不刷新文件更新时间，只按更新时间筛会漏）。
#   3) 按顺序逐个打开读批注（只读角标 > 0 的）；用 cursor 记住上次位置。
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

VISIBLE_JS='JSON.stringify([...document.querySelectorAll("div.item")].map(c=>{const i=c.querySelector("img[alt]");const b=c.querySelector("[class*=comment_text]");const m=/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.exec(c.innerText);return {n:i?i.getAttribute("alt"):"",c:b?(parseInt(b.innerText,10)||0):0,t:m?m[0]:""}}).filter(x=>x.n))'

# ---- 批注面板：定位 / 滚动 -----------------------------------------------------------
# 播放页上唯一的大滚动容器就是右侧批注面板。不能靠类名（jssNNN 每次加载都变），
# 也不能靠「筛选」标签向上找祖先（工具栏和列表不在同一棵子树，实测找不到）。
# 取「高度 > 200 且内容超高」容器里最靠右的那个，稳定命中（left≈907 / h≈864）。
PANEL_FIND='(()=>{const c=[...document.querySelectorAll("*")].filter(e=>e.scrollHeight>e.clientHeight+15&&e.clientHeight>200);if(!c.length)return null;c.sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left);return c[c.length-1]})()'

panel_top() {
  bsk evaluate --session "$SID" "(()=>{const p=$PANEL_FIND;if(!p)return 'NOPANEL';p.scrollTop=0;return 'TOP'})()" 2>/dev/null | tail -1
}

panel_step() {
  bsk evaluate --session "$SID" "(()=>{const p=$PANEL_FIND;if(!p)return 'NOPANEL';const b=p.scrollTop;p.scrollTop=Math.min(p.scrollHeight,p.scrollTop+p.clientHeight*0.7);return Math.round(b)+'->'+Math.round(p.scrollTop)+'/'+Math.round(p.scrollHeight)})()" 2>/dev/null | tail -1
}

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
since = datetime.fromtimestamp(int(os.environ['SINCE_MS']) / 1000 - 600).strftime('%Y-%m-%d %H:%M')
best = ''
for line in list(open(sys.argv[1]))[-1:]:
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
: > "$TMP/notes.txt"
if [ "$SINCE_MS" != "0" ]; then
  bsk click --session "$SID" --selector "[aria-label='消息通知']" >/dev/null 2>&1
  sleep 3
  bsk evaluate --session "$SID" 'document.body.innerText' 2>/dev/null >> "$TMP/notes.txt"
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

def is_video(n):
    return bool(re.search(r'\.(mov|mp4|mkv|avi|m4v|webm)$', n, re.I))

# 角标 > 0 才算有批注 —— 2026-11-02 实测有效（40.mp4=10 / 2.mp4=5 / 12-16.mp4 无角标且确实零批注）
targets = [(n, v['idx'], v['count']) for n, v in order.items()
           if is_video(n) and v['count'] > 0 and (not since_str or v['t'] >= since_str)]

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
    if any(t[0] == n for t in targets) or not is_video(n):
        continue
    order[n] = {'idx': len(order), 'count': 0, 't': ''}
    targets.append((n, -1, 0))

targets.sort(key=lambda t: t[1] if t[1] >= 0 else 10 ** 6)
limit = int(sys.argv[3] or 0)
if limit > 0:
    targets = targets[:limit]

mode = '增量(卡片>= %s + 通知 %d 个)' % (since_str, len(note_files)) if since_str else '全量'
badged = len([1 for v in order.values() if v['count'] > 0])
print('MODE %s ALL_CARDS %d BADGED %d TARGETS %d' % (mode, len(order), badged, len(targets)), file=sys.stderr)
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

# 抓一个视频的全部批注：面板滚到顶 → 循环「快照 + 下滚」→ 合并去重 → 输出 JSON 数组
read_video_comments() {
  local dir="$1"
  local k prev cur R
  : > "$dir/snaps.txt"
  panel_top >/dev/null 2>&1
  sleep 1
  for k in $(seq 1 30); do
    bsk evaluate --session "$SID" 'document.body.innerText' 2>/dev/null >> "$dir/snaps.txt"
    echo "@@SNAP@@" >> "$dir/snaps.txt"
    R=$(panel_step)
    case "$R" in
      *"->"*)
        prev=${R%%->*}; cur=${R##*->}; cur=${cur%%/*}
        [ "$prev" = "$cur" ] && break
        ;;
      *) break ;;
    esac
    sleep 0.9
  done
  python3 - "$dir/snaps.txt" <<'PYEOF'
import json, re, sys

def unwrap(seg):
    s = seg.strip()
    if not s:
        return ''
    try:
        v = json.loads(s)
        if isinstance(v, str):
            return v
    except Exception:
        pass
    return s

TL = re.compile(r'^\d{1,2}:\d{2}(?::\d{2})?$')
DATE = re.compile(r'^(今天|昨天|前天)')
MONTHDAY = re.compile(r'^\d{1,2}-\d{1,2}(\s|$)')

def parse(text):
    lines = [l.strip() for l in text.split('\n')]
    lines = [l for l in lines if l]
    start = -1
    for i, l in enumerate(lines):
        if l == '筛选':
            start = i
    seg = lines[start + 1:] if start >= 0 else lines
    out = []
    i = 0
    while i < len(seg):
        if not TL.match(seg[i]):
            i += 1
            continue
        timeline = seg[i]
        author = ''
        for k in range(i - 1, max(-1, i - 5), -1):
            if len(seg[k]) > 1:
                author = seg[k]
                break
        content = []
        date = ''
        j = i + 1
        while j < len(seg):
            line = seg[j]
            if DATE.match(line) or MONTHDAY.match(line):
                date = line
                break
            if TL.match(line):
                break
            content.append(line)
            j += 1
        if content:
            out.append({'author': author, 'timeline': timeline,
                        'content': ' '.join(content).strip(), 'dateText': date})
        i = j + 1 if j > i else i + 1
    return out

merged = {}
for chunk in open(sys.argv[1], encoding='utf-8', errors='ignore').read().split('@@SNAP@@'):
    for c in parse(unwrap(chunk)):
        key = (c['timeline'], re.sub(r'\s+', '', c['content']))
        old = merged.get(key)
        # 同一时间点、正文互为前缀 → 留更长的那条（虚拟滚动偶尔抓到半截正文）
        if old is not None and len(old['content']) >= len(c['content']):
            continue
        merged[key] = c
print(json.dumps(list(merged.values()), ensure_ascii=False))
PYEOF
}

CURSOR=0
SEQ=0
while IFS=$'\t' read -r FILE IDX COUNT; do
  [ -z "$FILE" ] && continue
  [ "${COUNT:-0}" = "0" ] && { echo "SKIP $FILE (无角标)" >&2; continue; }

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
  SEQ=$((SEQ+1))
  DIR="$TMP/rd_$SEQ"
  mkdir -p "$DIR"
  COMMENTS=$(read_video_comments "$DIR")
  N=$(printf '%s' "$COMMENTS" | python3 -c "import sys,json;print(len(json.load(sys.stdin)))" 2>/dev/null || echo 0)
  FILE="$FILE" COUNT="$COUNT" COMMENTS="$COMMENTS" N="$N" python3 - >> "$OUT" <<'PYEOF'
import json, os
print(json.dumps({'file': os.environ['FILE'], 'count': int(os.environ['COUNT']),
                  'got': int(os.environ['N']),
                  'comments': json.loads(os.environ['COMMENTS'])}, ensure_ascii=False))
PYEOF
  if [ "$N" -lt "$COUNT" ]; then
    echo "SHORT $FILE 读到 $N / 角标 $COUNT" >&2
  fi
  echo "GOT $FILE $N/$COUNT" >&2
  echo "DONE $FILE $N" >> "$PROG"

  bsk navigate-back --session "$SID" >/dev/null 2>&1
  sleep 2
done < "$TMP/targets.txt"

echo "DONE $OUT" >&2
