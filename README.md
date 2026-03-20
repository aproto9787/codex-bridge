# codex-bridge

A bridge that integrates **OpenAI Codex CLI** as a native teammate within [Claude Code](https://docs.anthropic.com/en/docs/claude-code)'s team system — enabling **cross-model multi-agent collaboration** from a single orchestrator.

## What it does

Claude Code's `TeamCreate` system can spawn multiple AI agents that collaborate on tasks. By default, all teammates are Claude instances. **codex-bridge** lets you mix in Codex (GPT) workers alongside Claude workers, all managed by the same team leader.

```
┌─────────────────────────────────────────┐
│            Claude Code (Leader)          │
│         TeamCreate / TeamDelete          │
├───────────┬───────────┬─────────────────┤
│ claude-*  │ codex-*   │ codex-*         │
│ Claude    │ Codex CLI │ Codex CLI       │
│ (native)  │ (bridge)  │ (bridge)        │
└───────────┴───────────┴─────────────────┘
```

### Key features

- **Dual routing** — Agent name prefix determines the backend: `codex-*` → Codex App Server, `claude-*` → Claude Code passthrough, otherwise routes by model name
- **File-based IPC** — Uses `~/.claude/teams/` inbox/outbox JSON files with `fs.watch` + polling for reliable cross-process communication
- **Leader outbox batching** — Micro-batches leader messages (50ms debounce) to reduce file I/O
- **2-stage result storage** — Full output saved to `results/` directory; only a preview (500 chars) goes to the inbox, keeping context windows lean
- **Atomic file locking** — `mkdir`-based locks with stale detection for safe concurrent reads/writes
- **TUI viewer** — Optional tmux pane with real-time streaming (ANSI fallback by default)
- **Auto base instructions** — Injects worker behavior rules (scope control, sub-agent policies, process protection) via `thread/start`
- **Graceful shutdown** — Coordinated shutdown with pane cleanup and leader notification

## Requirements

- **Node.js** ≥ 18
- **Claude Code** CLI installed and configured
- **OpenAI Codex CLI** (`codex`) in PATH (for Codex workers)
- **tmux** (optional, for TUI viewer panes)

## Installation

```bash
git clone https://github.com/aproto9787/codex-bridge.git
cd codex-bridge
npm ci
```

## Setup

Set the teammate command so Claude Code spawns workers through the bridge:

```bash
export CLAUDE_CODE_TEAMMATE_COMMAND="$(pwd)/codex-bridge.mjs"
```

Or add it to your shell profile for persistence.

## Usage

Once configured, use Claude Code's team system as usual. The bridge automatically routes agents based on naming convention:

```bash
# Start Claude Code — team workers will route through the bridge
claude

# Inside Claude Code, create a team:
# TeamCreate with agent names like "codex-analyst", "codex-coder" → Codex
# TeamCreate with agent names like "claude-reviewer" → Claude
```

### Routing rules

| Agent name pattern | Backend | Notes |
|---|---|---|
| `codex-*` | Codex CLI (App Server) | Always routes to Codex |
| `claude-*` | Claude Code (passthrough) | Always routes to Claude |
| Other | Auto-detect by model name | Falls back to Codex if not a Claude model |

### Direct execution (debugging)

```bash
node codex-bridge.mjs --agent-name codex-worker --team-name my-team
```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `CLAUDE_CODE_TEAMMATE_COMMAND` | Path to bridge script (required for auto-spawn) | — |
| `CODEX_TUI_BIN` | Path to patched codex-tui binary | Search PATH → ANSI fallback |
| `CLAUDE_BIN` | Path to Claude Code binary | `which claude` |
| `CODEX_BRIDGE_TUI` | Set to `1` to enable TUI viewer pane | `0` (ANSI fallback) |

## Architecture

```
codex-bridge.mjs (single file, ~2300 lines)
├── CLI arg parser & routing logic
├── File-based IPC (inbox/outbox with fs.watch)
├── Leader outbox batcher (micro-batch writes)
├── Codex App Server session (WebSocket JSON-RPC)
├── Claude Code passthrough (stdio forwarding)
├── ANSI renderer (compact/full modes)
├── TUI viewer (tmux pane integration)
├── Task management (file-based status tracking)
└── Graceful shutdown & signal handling
```

The bridge is **zero-dependency for core functionality** — only `ink` and `react` are used for the optional TUI viewer.

## How team communication works

1. **Leader** writes a task to the worker's inbox (`~/.claude/teams/<team>/inboxes/<worker>.json`)
2. **Bridge** detects the file change via `fs.watch` (with polling fallback)
3. **Bridge** sends the prompt to Codex App Server via JSON-RPC over stdio
4. **Codex** processes the task, streaming events back through the bridge
5. **Bridge** collects the full response, saves it to `results/`, and writes a preview to the leader's inbox
6. **Leader** reads the result and continues orchestration

## License

MIT License - see [LICENSE](LICENSE) for details.

Copyright (c) 2025-2026 [aproto9787](https://github.com/aproto9787)
