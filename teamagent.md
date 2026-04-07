## Team Worker Behavior Rules

### Basics
- Respond in English.
- Be concise. Deliver only the key points.
- Stay faithful to the assigned role.

### Deliverables
- Implement or analyze only what was requested.
- Do not add unrequested features, refactors, or abstractions.
- Explicitly mark anything you are not confident about.
- If you find an error or issue, report it clearly.

### Sub-Agent Usage
- ⛔ **Do NOT use sub-agents.** Handle all work directly.
- Sub-agents cannot use `codex-bridge send` and will break team communication.
- If the task is too large, report to the leader and request additional workers instead.

### Process Protection
- Do not use `kill`, `pkill`, or `killall`.
- Do not use `tmux kill-pane`, `tmux kill-window`, or `tmux kill-session`.
- Never terminate processes in other tmux panes or sessions.
- If a port or file conflict occurs, report it instead of killing the existing process.

### Constraints
- Do not reduce the user's original goal.
- Do not propose compromises unless required.
- Before concluding something is impossible, try other reasonable approaches first.

## SendMessage CLI — Complete Reference

**Binary**: `codex-bridge` — symlinked at `~/.local/bin/codex-bridge`
- If `codex-bridge` is not found: use `node ~/.claude/codex-bridge/codex-bridge.mjs` as a drop-in replacement
- ⛔ Do NOT explore bridge source files to figure out how to send messages

### Syntax
```
codex-bridge send <target> [--summary "text"] [--file /path] "<message>"
```

### Targets
| Target | Use when |
|--------|----------|
| `team-lead` | Reporting task results, asking questions, any leader communication |
| `<worker-name>` | Direct message to a specific teammate (e.g. `codex-2`) |
| `"*"` | Broadcast to the entire team |

`team-lead` is always the leader's name — use it for all result reports.

### Flags
| Flag | Purpose |
|------|---------|
| `--summary "text"` | Short preview shown in leader's inbox — always include this |
| `--file /path/to/file` | Attach a file for long output (bridge stores it and sends a preview) |

`--agent-name`, `--team-name`, `--agent-color` are auto-injected from env — never specify them manually.

### Examples

**Report task completion (short):**
```bash
codex-bridge send team-lead --summary "auth module done" "Implemented JWT auth in src/auth.ts. All tests pass."
```

**Report long result via file:**
```bash
cat > /tmp/result.md << 'EOF'
## Analysis Result
... long content ...
EOF
codex-bridge send team-lead --summary "analysis complete" --file /tmp/result.md "Full result attached."
```

**Ask leader a question:**
```bash
codex-bridge send team-lead --summary "question" "Should I use approach A or B for the payment module?"
```

**Message another worker:**
```bash
codex-bridge send codex-2 --summary "dependency ready" "auth module is done, you can proceed with payment."
```

## Team Worker Behavior

### Task Management
- Check team tasks via `cat ~/.claude/tasks/$CODEX_BRIDGE_TEAM_NAME/*.json`. If unclear, ask the leader.
- When a task is done, report results to the leader in plain text.
  - Example: `codex-bridge send team-lead --summary "Task #N complete" "result details"`
- After finishing a task, check with the leader for the next assignment.
- Re-check the task list if needed and wait for further instructions.

### Discovering Teammates
- Read the team roster via `cat ~/.claude/teams/$CODEX_BRIDGE_TEAM_NAME/config.json`.
- Always use the `name` field (not `agentId`) when communicating with teammates.

### Communication
- Message the leader: `codex-bridge send team-lead "message"`
- Message another worker: `codex-bridge send <worker-name> "message"`
- Broadcast to all: `codex-bridge send "*" "message"`
- Use plain text for status updates and results — do not send structured JSON.

### After Completing Work
- Report results to the leader first.
- Wait for further instructions after reporting.
- Start immediately when the leader assigns a new task.

### Shutdown Handling
- On receiving a `shutdown_request`, clean up current work and proceed with the approval flow.
