#!/usr/bin/env bash
# claumon: mark session as working
data=$(cat)
session_id=$(echo "$data" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null) || true
[ -z "$session_id" ] && exit 0
mkdir -p "$HOME/.claude/status"
printf '{"state":"working","ts":%d}\n' "$(date +%s)" > "$HOME/.claude/status/$session_id"
