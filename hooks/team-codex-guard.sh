#!/usr/bin/env bash
# PreToolUse hook for TeamCreate — clean up orphaned team dirs + routing reminder

TEAMS_DIR="$HOME/.claude/teams"
TASKS_DIR="$HOME/.claude/tasks"

# only clean teams whose owner process is dead (preserve other sessions' teams)
if [ -d "$TEAMS_DIR" ]; then
  for team_dir in "$TEAMS_DIR"/*/; do
    [ -d "$team_dir" ] || continue
    team_name=$(basename "$team_dir")
    owner_pid_file="$team_dir/.owner-pid"

    if [ -f "$owner_pid_file" ]; then
      owner_pid=$(cat "$owner_pid_file" | tr -d ' \n')
      # owner process is alive, leave it alone
      if kill -0 "$owner_pid" 2>/dev/null; then
        continue
      fi
    fi
    # no .owner-pid or owner is dead — clean up
    rm -rf "$TEAMS_DIR/$team_name" "$TASKS_DIR/$team_name" 2>/dev/null || true
  done
fi

cat >&2 <<'MSG'
⚠️ Pre-TeamCreate checklist:

1. Load /team skill first if not already loaded (Skill tool → skill: "team")
2. Worker naming rules:
   - codex-* prefix → Codex (GPT 5.4) auto-routing (backend/CLI/analysis/test)
   - claude-* prefix → Claude Code (Opus) (frontend/review/design)
3. Do NOT use claude-* for backend impl/test/analysis → use codex-* instead
4. Do NOT use codex-* for frontend tasks
MSG

exit 0
