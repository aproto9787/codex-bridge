#!/usr/bin/env bash

set -euo pipefail

payload="$(cat)"

result="$(
  PAYLOAD="$payload" python3 - <<'PY'
import json
import os
import re
import sys

try:
    data = json.loads(os.environ["PAYLOAD"] or "{}")
except json.JSONDecodeError:
    print("allow")
    sys.exit(0)

if str(data.get("tool_name", "")) != "Agent":
    print("allow")
    sys.exit(0)

tool_input = data.get("tool_input") or {}
if not isinstance(tool_input, dict):
    tool_input = {}

subagent_type = str(tool_input.get("subagent_type", ""))
if subagent_type in {"Explore", "explore", "user-advocate"}:
    print("allow")
    sys.exit(0)

# allow if team_name is set (legitimate team worker spawn)
if tool_input.get("team_name"):
    print("allow")
    sys.exit(0)

# block team worker names (claude-* / codex-*) spawned without team_name
name = str(tool_input.get("name", ""))
import re as _re
if _re.match(r"^(claude|codex)-", name):
    print("deny_worker")
    sys.exit(0)

prompt = str(tool_input.get("prompt", ""))
keyword_pattern = re.compile(
    r"(analyz|analys|debate|review|inspect|compare|implement|modif|refactor|test|bugfix|research|investigat|explor)",
    re.IGNORECASE
)

if keyword_pattern.search(prompt):
    print("deny")
else:
    print("allow")
PY
)"

if [[ "$result" == "deny_worker" ]]; then
  printf '❌ BLOCKED: Do not spawn team workers (claude-*/codex-*) as sub-agents without team_name. Use TeamCreate instead.\n' >&2
  exit 2
fi

if [[ "$result" == "deny" ]]; then
  printf '❌ BLOCKED: Use TeamCreate for this task, not Agent directly.\n' >&2
  exit 2
fi

exit 0
