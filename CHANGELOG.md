# Changelog

## [Unreleased]

## [2026-03-27] - WebSocket and native TUI crash recovery hardening
- Restart the Codex app-server after unexpected WebSocket closure, including fresh-port relaunches.
- Escalate stuck shutdowns from `SIGTERM` to `SIGKILL` and bridge `ws error` into a forced `close` path.
- Recover the in-place native TUI differently depending on whether the WebSocket transport is still healthy.

## [2026-03-24] - ANSI fallback and TUI stability improvements
- Harden ANSI fallback detection, retry behavior, and logging.
- Reduce TUI crash deadlocks and improve passthrough stability.

## [2026-03-21] - Native Codex TUI support
- Add native Codex TUI support over the WebSocket app-server transport.
- Auto-detect compatible native TUI binaries and newer Codex releases without extra environment variables.
- Improve redraw, focus restoration, layout handling, and in-place TUI execution.

## [2026-03-20] - Goal context injection and distribution metadata
- Inject team goal context from config descriptions into worker instructions.
- Improve Codex 0.116 compatibility and general runtime stability.
- Add the MIT license file to the repository.

## [2026-03-19] - Routing cleanup and worker guardrails
- Simplify routing logic and remove legacy event handling.
- Add process-protection rules to the default worker instructions.
- Rewrite the README for a broader audience.

## [2026-03-14] - File watching and leader outbox batching
- Add `fs.watch`-based inbox detection with polling fallback.
- Batch leader outbox writes to reduce file churn.
- Improve viewer stability around message delivery.

## [2026-03-12] - Streaming compatibility and viewer/runtime upgrades
- Add compatibility for newer Codex streaming events and fix hard-coded path assumptions.
- Store full results separately from inbox previews to keep orchestration context lean.
- Inject default worker `baseInstructions`, switch to the Ink viewer, and fix message dedup behavior.

## [2026-03-07] - Planning document updates
- Revise `IMPLEMENTATION_PLAN.md` for Phase 2 and Phase 3 redesign decisions.
- Record the final reevaluation notes for the implementation plan.

## [2026-03-06] - Repository initialization and early runtime work
- Initialize the standalone `codex-bridge` repository.
- Add the bridge entrypoint, launcher script, and initial package metadata.
- Land early Phase 1-3 fixes covering architecture and stability foundations.
