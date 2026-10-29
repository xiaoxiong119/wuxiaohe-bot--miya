#!/bin/bash
# 生成飞书「一键开通权限」链接
# 用法：
#   ./scope-link.sh im:message:send_as_bot im:resource
#   APP_ID=cli_xxx ./scope-link.sh base:record:read
#   ./scope-link.sh --set 功能1        # 用下面预置的权限组

export PATH="$HOME/.local/bin:$PATH"
APP_ID="${APP_ID:-[已脱敏]}"

case "$1" in
  --set)
    case "$2" in
      功能1)   SCOPES="im:message.p2p_msg:readonly im:message:readonly im:resource im:message:send_as_bot" ;;
      功能1群) SCOPES="im:message.p2p_msg:readonly im:message.group_at_msg:readonly im:message:readonly im:resource im:message:send_as_bot" ;;
      功能2)   SCOPES="base:app:read base:record:read base:record:update im:chat:read im:message:send_as_bot" ;;
      功能3)   SCOPES="im:message.group_at_msg:readonly im:message:readonly im:resource im:message:send_as_bot" ;;
      文档)    SCOPES="docx:document:readonly sheets:spreadsheet:read wiki:node:read base:app:read base:record:read drive:file:download space:document:retrieve" ;;
      表格)    SCOPES="base:record:retrieve base:record:update base:record:read base:table:read base:field:read base:app:read" ;;
      运维)    SCOPES="application:app_slash_command:read application:app_slash_command:write application:application:self_manage" ;;
      全量)    SCOPES="im:message.p2p_msg:readonly im:message.group_at_msg:readonly im:message:readonly im:resource im:message:send_as_bot im:chat:read base:app:read base:record:read base:record:update docx:document:readonly sheets:spreadsheet:read wiki:node:read drive:file:download application:app_slash_command:read application:app_slash_command:write application:application:self_manage" ;;
      *) echo "未知权限组：$2"; echo "可选：功能1 功能1群 功能2 功能3 文档 表格 运维 全量"; exit 1 ;;
    esac
    ;;
  "" )
    echo "用法：./scope-link.sh <scope...>   或   ./scope-link.sh --set <组名>"; exit 1 ;;
  *)
    SCOPES="$*" ;;
esac

python3 - "$APP_ID" "$SCOPES" <<'PY'
import sys, urllib.parse
app, scopes = sys.argv[1], sys.argv[2].replace(' ', ',')
print('https://open.feishu.cn/page/scope-apply?clientID=%s&scopes=%s' % (app, urllib.parse.quote(scopes, safe='')))
PY
