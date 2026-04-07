#!/usr/bin/env bash

set -euo pipefail

payload="$(cat)"

analysis="$(
  PAYLOAD="$payload" python3 - <<'PY'
import json
import os
import re
import sys

try:
    data = json.loads(os.environ["PAYLOAD"] or "{}")
except json.JSONDecodeError:
    sys.exit(0)

prompt = str(data.get("prompt", ""))
keyword_pattern = re.compile(
    r"(debate|review|analyz|analys|inspect|compare|implement|modif|refactor|test|bugfix|research|investigat|explor|team|worker|parallel|concurrent)",
    re.IGNORECASE
)
number_patterns = [
    re.compile(r"(\d+)\s*workers?", re.IGNORECASE),
    re.compile(r"(\d+)\s*:\s*worker", re.IGNORECASE),
]

matched = bool(keyword_pattern.search(prompt))
worker_count = ""

for pattern in number_patterns:
    found = pattern.search(prompt)
    if found:
        worker_count = found.group(1)
        matched = True
        break

if matched:
    print("matched=1")
    if worker_count:
        print(f"worker_count={worker_count}")
PY
)"

if [[ "$analysis" == *"matched=1"* ]]; then
  printf '⚠️ Team routing detected: TeamCreate required, do not substitute with Agent.\n' >&2
  printf 'Debate/review/analysis requires at least 2 workers; follow explicit worker count if specified.\n' >&2
fi

exit 0
