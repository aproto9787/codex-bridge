# codex-bridge integration

## Setup

Set the teammate command so Claude Code routes all team worker spawns through the bridge:

```bash
# Shell profile (~/.bashrc, ~/.zshrc, ~/.config/fish/config.fish, etc.)
export CLAUDE_CODE_TEAMMATE_COMMAND="/path/to/codex-bridge/codex-bridge.mjs"
```

Or use `~/.claude/settings.json` for a persistent, shell-independent config:

```json
{
  "env": {
    "CLAUDE_CODE_TEAMMATE_COMMAND": "/path/to/codex-bridge/codex-bridge.mjs"
  }
}
```

## Worker Naming Convention

The bridge routes by name prefix — the only thing that matters is how you name your workers:

| Prefix | Backend | Model |
|--------|---------|-------|
| `codex-*` | Codex CLI (App Server) | GPT 5.4 xhigh |
| `claude-*` | Claude Code passthrough | Claude Opus |

Examples: `codex-impl`, `codex-analyst`, `codex-test`, `claude-reviewer`, `claude-architect`

## TeamCreate Rules

When creating teams with codex-bridge:

- Name Codex workers with the `codex-` prefix, Claude workers with `claude-`
- Workers must NOT use sub-agents — use multiple top-level workers instead
  - Sub-agents cannot use `codex-bridge send` and will break team communication
  - If a task is too large for one worker, request additional workers from the leader
- Workers report results via `codex-bridge send team-lead --summary "..." "message"`

## Worker Communication

Codex workers use the `codex-bridge send` CLI for all inter-worker communication:

```bash
# Report task result to leader
codex-bridge send team-lead --summary "task done" "Details here."

# Ask the leader a question
codex-bridge send team-lead --summary "question" "Should I use approach A or B?"

# Message another worker directly
codex-bridge send codex-test --summary "impl ready" "Auth module is done, please test."

# Broadcast to the entire team
codex-bridge send "*" "Shared context: using postgres, not sqlite."
```

Full CLI reference is injected automatically into Codex workers via `teamagent.md`.
