#!/usr/bin/env bash
# PostToolUse(TeamCreate) hook — record owner Claude Code PID in team directory

set -euo pipefail

payload="$(cat)"
team_name="$(echo "$payload" | python3 -c "
import json, sys
try:
    d = json.loads(sys.stdin.read())
    print(d.get('tool_input', {}).get('team_name', ''))
except:
    pass
" 2>/dev/null)"

[ -z "$team_name" ] && exit 0

team_dir="$HOME/.claude/teams/$team_name"
[ -d "$team_dir" ] || exit 0

# walk up the process tree to find the Claude Code node process PID
get_claude_pid() {
  local pid=$$
  local depth=0
  while [ "$pid" -gt 1 ] && [ "$depth" -lt 10 ]; do
    local ppid cmd
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -z "$ppid" ] && break
    cmd=$(ps -o comm= -p "$ppid" 2>/dev/null | tr -d ' ')
    if [ "$cmd" = "node" ]; then
      echo "$ppid"
      return
    fi
    pid="$ppid"
    depth=$((depth + 1))
  done
  # fallback: parent of the current hook process
  echo "$PPID"
}

claude_pid="$(get_claude_pid)"
echo "$claude_pid" > "$team_dir/.owner-pid"
exit 0
