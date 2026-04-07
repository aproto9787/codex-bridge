---
name: team
description: Team composition guide for codex-bridge. Reference when using TeamCreate with mixed Codex/Claude workers.
user_invocable: true
---

# Team Composition Guide (codex-bridge)

## Worker Routing

The bridge routes automatically by name prefix — no extra config needed:

| Prefix | Backend | Typical roles |
|--------|---------|---------------|
| `codex-*` | Codex CLI (GPT 5.4 xhigh) | impl, analyst, test, architect |
| `claude-*` | Claude Code (Opus) | reviewer, planner, frontend, architect |

## When to Use TeamCreate

Use TeamCreate for any non-trivial task:
- **Analysis / research** — spawn `codex-analyst` or multiple analysts for parallel research
- **Implementation** — `codex-impl` for backend, `claude-impl` for frontend/UI
- **Review / debate** — `claude-reviewer` for judgment, multiple debaters for tradeoffs
- **Full pipeline** — analyst → impl → test → reviewer

Skip TeamCreate only for single-file edits or one-sentence answers.

## Team Templates

### Minimal (backend task)

```
codex-impl        → implements the feature
claude-reviewer   → reviews the result
```

### Standard (backend + review)

```
codex-analyst     → explores codebase, reports findings
codex-impl        → implements based on analysis
codex-test        → writes and runs tests
claude-reviewer   → final review
```

### Full (high-complexity)

```
codex-architect   → design review, feasibility check
codex-analyst     → impact analysis (parallel with architect)
codex-impl        → implementation
codex-test        → test coverage
claude-reviewer   → code review
user-advocate     → verifies result matches original intent
```

### Frontend / fullstack

```
codex-analyst     → backend analysis
claude-impl       → frontend implementation  ← Claude only, Codex is weak on UI
codex-impl        → backend implementation
claude-reviewer   → final review
```

> ⛔ Never use Codex for frontend/UI work — use `claude-impl` or `claude-frontend`.

## Worker Rules

- Each worker gets a clear, non-overlapping scope (file, module, or role)
- Parallel workers must not overwrite each other's files
- Workers report via `codex-bridge send team-lead --summary "..." "result"`
- Workers must NOT spawn sub-agents — request additional teammates from the leader instead

## Instruction Priority (highest wins on conflict)

```
1. Claude Code system prompt
2. CLAUDE.md (global policy)
3. This skill (/team)
4. ~/.codex/AGENTS.md (Codex environment)
5. baseInstructions (bridge auto-inject)
6. Per-worker role prompt (TeamCreate)
```
