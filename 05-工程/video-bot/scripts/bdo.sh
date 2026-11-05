#!/bin/bash
# bsk 0.4.1 起每次动作都要「cooperate sync 的 context + 一次性 observation」，
# 这个包装把两步合一：bdo <js>
set -u
export PATH="$HOME/.local/bin:$PATH"
export BSK_AUTO_START=0
SID=$(cat /tmp/tbpz_sid.txt)
SYNC=$(bsk cooperate sync --session "$SID" --json 2>/dev/null)
CTX=$(printf '%s' "$SYNC" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('context_id',''))" 2>/dev/null)
OBS=$(printf '%s' "$SYNC" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('observation_id',''))" 2>/dev/null)
bsk evaluate --session "$SID" --context "$CTX" --observation "$OBS" "$1" 2>&1 | tail -3
