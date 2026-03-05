# codex-bridge

Codex CLI를 Claude Code 네이티브 팀원으로 동작시키는 브릿지.

## 설치

```bash
npm ci
```

## 환경변수

```bash
export CLAUDE_CODE_TEAMMATE_COMMAND=/path/to/codex-bridge.mjs
```

## 선택 환경변수

| 변수 | 설명 |
|------|------|
| `CODEX_TUI_BIN` | patched codex-tui 바이너리 경로 (없으면 PATH → blessed fallback) |
| `CLAUDE_BIN` | Claude Code 바이너리 경로 (없으면 `which claude`) |

## 사용

```bash
# 직접 실행
node codex-bridge.mjs

# alias
alias clauded='CLAUDE_CODE_TEAMMATE_COMMAND=/path/to/codex-bridge.mjs claude'
```
