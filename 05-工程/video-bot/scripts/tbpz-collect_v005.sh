#!/bin/bash
# 采集分秒帧批注 → JSON 行文件  v005 / 2026-11-04
# 用法：./tbpz-collect_v005.sh <链接> <输出文件> [最多几个视频] [since毫秒时间戳] [只采这些文件]
#   链接支持两种：
#     · 项目文件页  https://app.mediatrack.cn/projects/<项目id>/files?path=<目录id>
#     · 受邀审片空间 https://app.mediatrack.cn/reviews/<空间id>?fileId=…&inviteid=…
#
# v005 相对 v004 的改动（2026-11-04，小熊把精剪批注源换成审片空间 /reviews/ 链接）：
#   1) bsk 在「共享标签页」上跑时，每次 evaluate / navigate 都必须带 cooperate sync 给的
#      context + observation，否则直接报错；老脚本把它当超时吞成空字符串 → 页面明明有 130 张卡
#      却打出 ALL_CARDS 0 / TARGETS 0（v004 的排查现场）。现在所有浏览器读写都走 ev()/nav()，
#      失败自动 cooperate sync 后重试一次。
#   2) 打开列表后不再固定 sleep 7，改成「等 div.item 出现」（最多 40 秒）。
#   3) 审片空间的排序菜单只有 文件名称/文件类型/文件大小/文件名A-Z/Z-A，没有「更新时间」。
#      这种页面 SORT_TS=0：不做「滚过边界就停」，整张列表扫完再按卡片日期过滤增量。
#   4) 审片播放页（/reviews/<空间id>/<文件id>）先渲染播放器、批注面板晚一两秒才出来，
#      body.innerText 一开始只有「查看」。读批注前先等面板出现「筛选」，面板读不到也不算完。
#   5) 回列表用 navigate 到原链接，不用 navigate-back（共享标签页上 back 同样要 context）。
#
# v004 改动（沿用）：
#   · 新增第 5 参数 ONLY：按文件名过滤 targets，命中即不管更新时间。
#     为了不让「97」误匹配「970」，纯数字按「数字 + 扩展名前缀」匹配。
#   · ONLY 模式跳过「消息通知」补捞（那是增量用的），stderr 打 ONLY 命中数。
#
# v003 改动（沿用）：
#   1) 进列表先确保排序 =「更新时间 / 由近到远」。
#   2) 增量边界容差 10 分钟 → 2 分钟。
#   3) 水位语义不变，仍是「本轮采集开始时间（runStart）」。
#
# v002 改动（沿用）：
#   · 卡片角标 div[class*=comment_text] 可读，只点角标 > 0 的卡片（无角标 = 无批注）。
#   · 批注面板是虚拟滚动，必须滚到底合并，否则只拿到首屏。
set -u
export PATH="$HOME/.local/bin:$PATH"
export BSK_AUTO_START=0

URL="$1"
OUT="$2"
LIMIT="${3:-0}"
SINCE_MS="${4:-0}"
ONLY="${5:-}"
export ONLY
TMP="$(mktemp -d)"

SID=$(bsk session start --json 2>/dev/null | python3 -c "import sys,json;print(json.load(sys.stdin).get('session_id',''))")
if [ -z "$SID" ]; then
  echo "ERR 开不了浏览器会话" >&2
  exit 2
fi
trap 'bsk session stop "$SID" >/dev/null 2>&1; rm -rf "$TMP"' EXIT

# ---- bsk 读写：共享标签页要 cooperate context，失败自动同步重试一次 ----
# 共享页上 evaluate 会报 "shared page control or observation changed" /
# "requires the context returned by the latest cooperate sync"，老写法直接空返回。
coop_ids() {
  local s
  s=$(bsk cooperate sync --session "$SID" 2>/dev/null)
  printf '%s' "$s" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('context_id',''),d.get('observation_id',''))" 2>/dev/null
}

ev() {
  local js="$1" out err ctx obs ids
  err="$TMP/ev.err"
  out=$(bsk evaluate --session "$SID" "$js" 2>"$err")
  if [ -z "$out" ] || grep -qi "cooperate\|control context\|observation" "$err" 2>/dev/null; then
    ids=$(coop_ids)
    ctx=${ids% *}
    obs=${ids#* }
    if [ -n "$ctx" ] && [ -n "$obs" ]; then
      out=$(bsk evaluate --session "$SID" --context "$ctx" --observation "$obs" "$js" 2>>"$err")
    fi
  fi
  printf '%s\n' "$out"
}

nav() {
  local url="$1" out ctx obs ids
  out=$(bsk navigate --session "$SID" "$url" 2>"$TMP/nav.err")
  if [ $? -ne 0 ] || grep -qi "cooperate\|control context\|observation" "$TMP/nav.err" 2>/dev/null; then
    ids=$(coop_ids)
    ctx=${ids% *}
    obs=${ids#* }
    if [ -n "$ctx" ] && [ -n "$obs" ]; then
      bsk navigate --session "$SID" --context "$ctx" --observation "$obs" "$url" >/dev/null 2>&1
    fi
  fi
}

scroll_by() {
  ev "(()=>{const it=document.querySelector('div.item');if(!it)return '-1';let p=it.parentElement;while(p&&p.scrollHeight<=p.clientHeight+20)p=p.parentElement;if(!p)return '-1';const b=p.scrollTop;p.scrollTop=b+p.clientHeight*($1);return b+'->'+p.scrollTop})()" | tail -1
}

scroll_set() {
  ev "(()=>{const it=document.querySelector('div.item');if(!it)return '-1';let p=it.parentElement;while(p&&p.scrollHeight<=p.clientHeight+20)p=p.parentElement;if(!p)return '-1';p.scrollTop=$1;return String(p.scrollTop)})()" | tail -1
}

wait_items() {
  local n i
  for i in $(seq 1 20); do
    n=$(ev 'document.querySelectorAll("div.item").length' | tail -1)
    case "$n" in ''|*[!0-9]*) n=0 ;; esac
    if [ "$n" -gt 0 ]; then
      echo "LIST 列表已就绪：$n 张卡" >&2
      return 0
    fi
    sleep 2
  done
  echo "LIST 等了 40 秒没出现卡片（链接不对 / 没登录 / 页面改版）" >&2
  return 1
}

VISIBLE_JS='JSON.stringify([...document.querySelectorAll("div.item")].map(c=>{const i=c.querySelector("img[alt]");const b=c.querySelector("[class*=comment_text]");const m=/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.exec(c.innerText);return {n:i?i.getAttribute("alt"):"",c:b?(parseInt(b.innerText,10)||0):0,t:m?m[0]:""}}).filter(x=>x.n))'

# ---- 批注面板：定位 / 滚动 -----------------------------------------------------------
PANEL_FIND='(()=>{const c=[...document.querySelectorAll("*")].filter(e=>e.scrollHeight>e.clientHeight+15&&e.clientHeight>200);if(!c.length)return null;c.sort((a,b)=>a.getBoundingClientRect().left-b.getBoundingClientRect().left);return c[c.length-1]})()'

panel_top() {
  ev "(()=>{const p=$PANEL_FIND;if(!p)return 'NOPANEL';p.scrollTop=0;return 'TOP'})()" | tail -1
}

panel_step() {
  ev "(()=>{const p=$PANEL_FIND;if(!p)return 'NOPANEL';const b=p.scrollTop;p.scrollTop=Math.min(p.scrollHeight,p.scrollTop+p.clientHeight*0.7);return Math.round(b)+'->'+Math.round(p.scrollTop)+'/'+Math.round(p.scrollHeight)})()" | tail -1
}

# ---- 列表排序：能按「更新时间/由近到远」就切；审片空间没这项就不切 ---------------------
SORT_BTN_RE='^(文件名称|文件名|更新时间|文件类型|文件大小|创建时间|文件状态)$'
SORT_TS=0

open_sort_menu() {
  ev "(()=>{if([...document.querySelectorAll('[role=menu]')].some(u=>/更新时间|文件名称/.test(u.innerText||'')))return 'OPEN';const b=[...document.querySelectorAll('button,[role=button]')].find(e=>/$SORT_BTN_RE/.test((e.innerText||'').trim()));if(!b)return 'NOBTN';b.click();return 'OPENED'})()" | tail -1
}

sort_menu_items() {
  ev "(()=>{const ms=[...document.querySelectorAll('[role=menu]')];const m=ms.find(u=>/更新时间|文件名称/.test(u.innerText||''));if(!m)return 'NOMENU';return JSON.stringify([...m.querySelectorAll('[role=menuitem],li')].map(e=>(e.innerText||'').replace(/\\n/g,'|').trim()))})()" | tail -1
}

menu_pick() {
  local name="$1"
  ev "(()=>{const ms=[...document.querySelectorAll('[role=menu]')];const m=ms.find(u=>/更新时间|文件名称/.test(u.innerText||''));if(!m)return 'NOMENU';const name='$name';const t=[...m.querySelectorAll('[role=menuitem],li')].find(e=>(e.innerText||'').replace(/\\n/g,'|').trim()===name);if(!t)return 'NOITEM';t.click();return 'CLICKED'})()" | tail -1
}

menu_has() {
  case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac
}

list_sorted_desc() {
  ev '(()=>{const ts=[...document.querySelectorAll("div.item")].map(c=>{const m=/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.exec(c.innerText);return m?m[0]:""}).filter(Boolean);if(ts.length<3)return "NA";for(let i=1;i<ts.length;i++){if(ts[i]>ts[i-1])return "BAD"}return "OK"})()' | tail -1
}

ensure_sort() {
  local r items i
  SORT_TS=0
  r=$(list_sorted_desc)
  case "$r" in
    OK) echo "SORT 列表已是「更新时间/由近到远」" >&2; SORT_TS=1; return 0 ;;
    NA) echo "SORT 卡片不足 3 个，跳过校验" >&2; return 0 ;;
  esac
  for i in 1 2 3; do
    echo "SORT 当前不是更新时间倒序（${r}），看菜单…" >&2
    open_sort_menu >/dev/null
    sleep 2
    items=$(sort_menu_items)
    echo "SORT 菜单项：${items}" >&2
    if ! menu_has "$items" "更新时间"; then
      echo "SORT 该页面菜单里没有「更新时间」——不切排序，增量改按卡片日期过滤" >&2
      ev "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))" >/dev/null
      SORT_TS=0
      return 1
    fi
    menu_pick "更新时间" >/dev/null
    sleep 1.5
    if menu_has "$(sort_menu_items)" "由近到远"; then
      menu_pick "由近到远" >/dev/null
      sleep 1.5
    fi
    ev "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))" >/dev/null
    sleep 1.5
    r=$(list_sorted_desc)
    case "$r" in
      OK|NA) echo "SORT 已切到「更新时间/由近到远」" >&2; SORT_TS=1; return 0 ;;
    esac
  done
  echo "⚠️ 排序未能确认（${r}）——本轮不做提前停，整张列表扫完" >&2
  SORT_TS=0
  return 1
}

nav "$URL"
wait_items || exit 3
ensure_sort

# ---------- 阶段 1：枚举（能按时间排序就滚过边界停；不能就扫全） ----------
: > "$TMP/names.jsonl"
STEPS=0
for i in $(seq 1 80); do
  ev "$VISIBLE_JS" | tail -1 >> "$TMP/names.jsonl"
  if [ "$SINCE_MS" != "0" ] && [ "$SORT_TS" = "1" ]; then
    STOP=$(SINCE_MS="$SINCE_MS" python3 - "$TMP/names.jsonl" <<'PYEOF'
import json, sys, os
from datetime import datetime
since = datetime.fromtimestamp(int(os.environ['SINCE_MS']) / 1000 - 120).strftime('%Y-%m-%d %H:%M')
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
echo "SCANNED steps=$STEPS 排序=${SORT_TS}" >&2

# ---------- 阶段 1b：增量补捞「消息通知」里的新批注 ----------
: > "$TMP/notes.txt"
if [ "$SINCE_MS" != "0" ] && [ -z "$ONLY" ]; then
  ev "(()=>{const b=document.querySelector('[aria-label=\"消息通知\"]');if(!b)return 'NOBELL';b.click();return 'OK'})()" >/dev/null 2>&1
  sleep 3
  ev 'document.body.innerText' >> "$TMP/notes.txt"
  ev "(()=>{const leaves=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&/全部已读/.test(e.innerText||''));if(!leaves.length)return '0';let p=leaves[0];for(let k=0;k<6;k++){if(!p.parentElement)break;p=p.parentElement;if(p.scrollHeight>p.clientHeight+20){p.scrollTop=p.scrollHeight;return '1'}}return '0'})()" >/dev/null 2>&1
  sleep 2
  ev 'document.body.innerText' >> "$TMP/notes.txt"
  ev "(()=>{const b=document.querySelector('[aria-label=\"消息通知\"]');if(!b)return 'NOBELL';b.click();return 'OK'})()" >/dev/null 2>&1
  sleep 1
fi

SINCE_MS="$SINCE_MS" python3 - "$TMP/names.jsonl" "$TMP/targets.txt" "$LIMIT" "$TMP/notes.txt" <<'PYEOF'
import json, sys, re, os
from datetime import datetime, timedelta

since_ms = int(os.environ.get('SINCE_MS') or 0)
since_str = (datetime.fromtimestamp(since_ms / 1000) - timedelta(minutes=2)).strftime('%Y-%m-%d %H:%M') if since_ms else ''

only = [s.strip() for s in (os.environ.get('ONLY') or '').split(',') if s.strip()]

def hit_only(name):
    if not only:
        return True
    for o in only:
        if o == name:
            return True
        if re.fullmatch(r'\d+', o) and re.fullmatch(r'%s\.(mov|mp4|mkv|avi|m4v|webm)' % o, name, re.I):
            return True
    return False

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

targets = [(n, v['idx'], v['count']) for n, v in order.items()
           if is_video(n) and v['count'] > 0 and hit_only(n) and (only or not since_str or v['t'] >= since_str)]

if only:
    got = [(n, order[n]['count']) for n in order if hit_only(n)]
    if got:
        print('ONLY %s 命中卡片 %d：%s' % (','.join(only), len(got), ' '.join('%s(%d)' % (n, c) for n, c in got)), file=sys.stderr)
    else:
        print('ONLY %s 在当前列表里一张卡片都没命中（集数不在本目录 / 还没滚到）' % ','.join(only), file=sys.stderr)

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

if only:
    mode = '指定文件(%s)' % ','.join(only)
elif since_str:
    mode = '增量(卡片>= %s + 通知 %d 个)' % (since_str, len(note_files))
else:
    mode = '全量'
badged = len([1 for v in order.values() if v['count'] > 0])
print('MODE %s ALL_CARDS %d BADGED %d TARGETS %d' % (mode, len(order), badged, len(targets)), file=sys.stderr)
with open(os.path.join(os.path.dirname(sys.argv[2]), 'stat.txt'), 'w') as f:
    f.write('CARDS %d TARGETS %d\n' % (len(order), len(targets)))
with open(sys.argv[2], 'w') as f:
    for n, idx, c in targets:
        f.write('%s\t%d\t%d\n' % (n, idx, c))
PYEOF

# 一张卡都没枚举到 = 链接/登录/页面结构有问题，别让上层当成「采到 0 条批注」照常推水位
CARDS=$(awk '{print $2}' "$TMP/stat.txt" 2>/dev/null)
if [ "${CARDS:-0}" = "0" ]; then
  echo "ERR 一张视频卡片都没枚举到（ALL_CARDS 0）——链接/登录态/页面结构有问题，本轮作废" >&2
  exit 4
fi

: > "$OUT"
PROG="$OUT.progress"
: > "$PROG"

# ---------- 阶段 2：逐个打开 ----------
echo "TARGETS $(wc -l < "$TMP/targets.txt" | tr -d ' ')" >> "$PROG"
try_open() {
  local file="$1" from="$2" tries="$3" i r d a b
  scroll_set "$from" >/dev/null 2>&1
  for i in $(seq 1 "$tries"); do
    r=$(ev "(()=>{const cards=[...document.querySelectorAll('div.item')];const h=cards.find(c=>{const i=c.querySelector('img[alt]');return i&&i.getAttribute('alt')==='${file}'});if(!h)return 'NF';let p=h.parentElement;while(p&&p.scrollHeight<=p.clientHeight+20)p=p.parentElement;const pos=p?p.scrollTop:0;const th=h.querySelector('[class*=thumbnail]')||h;th.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,view:window}));return 'OK:'+pos})()" | tail -1)
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

# 抓一个视频的全部批注：等面板出现「筛选」→ 滚到顶 → 循环「快照 + 下滚」→ 合并去重
read_video_comments() {
  local dir="$1"
  local k prev cur R nopanel=0
  : > "$dir/snaps.txt"
  for k in $(seq 1 10); do
    if ev 'document.body.innerText' | grep -qx '筛选'; then break; fi
    sleep 2
  done
  panel_top >/dev/null 2>&1
  sleep 1
  for k in $(seq 1 30); do
    ev 'document.body.innerText' >> "$dir/snaps.txt"
    echo "@@SNAP@@" >> "$dir/snaps.txt"
    R=$(panel_step)
    case "$R" in
      *"->"*)
        prev=${R%%->*}; cur=${R##*->}; cur=${cur%%/*}
        [ "$prev" = "$cur" ] && break
        ;;
      *)
        nopanel=$((nopanel+1))
        [ "$nopanel" -ge 2 ] && break
        sleep 2
        ;;
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

  sleep 5
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

  # 回列表：审片空间用 navigate-back 不可靠，直接导航回原链接
  nav "$URL"
  wait_items >/dev/null 2>&1 || true
done < "$TMP/targets.txt"

echo "DONE $OUT" >&2
