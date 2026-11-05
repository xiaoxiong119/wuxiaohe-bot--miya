#!/bin/bash
set -e
BASE="$(cd "$(dirname "$0")/../05-工程/video-bot" && pwd)"
NODE=~/.workbuddy/binaries/node/versions/22.22.2-6/bin/node
unset NODE_OPTIONS
mkdir -p "$BASE/logs"
if ! curl -fsS http://127.0.0.1:18765/ >/dev/null 2>&1; then
python3 - "$BASE" "$NODE" <<'PY'
import subprocess,sys,os
base,node=sys.argv[1:]
with open(os.path.join(base,'logs/admin.log'),'a') as log:
 subprocess.Popen([node,os.path.join(base,'admin/server.js')],cwd=base,stdout=log,stderr=log,start_new_session=True)
PY
sleep 1
fi
open http://127.0.0.1:18765/
