#!/usr/bin/env node
// codex-bridge.mjs — Codex CLI를 Claude Code 네이티브 팀원으로 동작시키는 래퍼
// zero-dependency (Node.js 내장 모듈만 사용)

import { readFile, writeFile, mkdir, rmdir, rename, stat as fsStat } from "node:fs/promises";
import { existsSync, readFileSync, createWriteStream, openSync, closeSync, unlinkSync, watch as fsWatch } from "node:fs";
import { join, basename } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { createServer } from "node:net";

// ─── Constants ───
const POLL_INTERVAL_MS = 500;
const POLL_IDLE_MS = 2000;
const POLL_ACTIVE_MS = 100;
const POLL_FALLBACK_MS = 5000; // fs.watch fallback timeout
const FLUSH_DEBOUNCE_MS = 50;  // leader outbox micro-batch 간격
const SHUTDOWN_POLL_MS = 3000;
const MAX_RESULT_BYTES = 5 * 1024 * 1024; // 5MB (파일 저장용)
const PREVIEW_CHARS = 500; // inbox 미리보기 글자수
const TEAMS_BASE = join(homedir(), ".claude", "teams");
const TASKS_BASE = join(homedir(), ".claude", "tasks");
const LEADER_NAME = "team-lead";

// ─── 팀 워커 기본 지시 (thread/start baseInstructions로 주입) ───
const BASE_INSTRUCTIONS_CORE = `\
# 팀 워커 행동 규칙

## 기본
- 한국어로 응답한다.
- 간결하게 핵심만 전달한다. 장황한 설명, 불필요한 서론/결론 금지.
- 부여받은 역할에 충실한다. 역할 범위를 벗어난 작업은 하지 않는다.

## 결과물
- 요청받은 것만 구현/분석한다. 요청하지 않은 추가 기능, 리팩토링, 추상화 금지.
- 결과에 확신이 없는 부분은 명시적으로 표시한다.
- 에러나 문제를 발견하면 숨기지 않고 보고한다.

## 멀티에이전트 활용 (적극 분할 원칙)
- **기본 자세: 의심스러우면 서브에이전트로 분할한다.**
- 서브에이전트 스폰 기준: 파일 2개 이상 수정 OR 탐색 범위가 디렉토리 3개 이상.
- 직접 처리 범위: **파일 1개, 단일 함수 수정만** 직접 처리한다.
- 리더가 "서브에이전트로 병렬 처리하라"고 명시한 경우, 하위 작업을 최대한 독립적으로 분할하여 동시 실행한다.
- 서브에이전트 수: 하위 작업 수만큼 스폰하되 **최대 4개**.
- 서브에이전트에게도 동일한 행동 규칙(간결, 범위 준수, 과잉 금지)을 적용한다.
- 서브에이전트 결과를 통합하여 하나의 응답으로 리더에게 보고한다.
- 서브에이전트 실패 시 해당 하위 작업만 재시도하고, 성공한 작업은 유지한다.

## 프로세스 보호
- kill, pkill, killall 명령 사용 금지.
- tmux kill-pane, tmux kill-window, tmux kill-session 사용 금지.
- 다른 tmux pane이나 세션의 프로세스를 절대 종료하지 않는다.
- 포트/파일 충돌 시 기존 프로세스를 죽이지 말고 보고한다.

## 제약
- 사용자의 원래 목표를 축소하거나 타협안을 제시하지 않는다.
- "불가능하다"고 결론 내리기 전에 다른 접근법을 먼저 탐색한다.
`;

// goal이 있으면 baseInstructions에 목적 컨텍스트를 주입
function buildBaseInstructions(teamGoal) {
  if (!teamGoal) return BASE_INSTRUCTIONS_CORE;
  return `${BASE_INSTRUCTIONS_CORE}
## 팀 목적 (Goal Context)
> ${teamGoal}

- 모든 작업은 위 팀 목적에 기여해야 한다.
- 작업의 "왜?"를 항상 의식하고, 목적에서 벗어나는 작업은 하지 않는다.
- 판단이 불확실할 때 팀 목적을 기준으로 우선순위를 결정한다.
`;
}

let running = true;
let shutdownRequested = false;
let currentChild = null;
let viewerProc = null;
let viewerFifoPath = null;   // tmux FIFO 경로 (cleanup용)
let viewerTmuxPaneId = null; // tmux pane ID (cleanup용)
let logStream = null;
// Real session info from app-server (populated after thread/start)
let sessionInfo = null;
let currentPollMs = POLL_INTERVAL_MS;
let leaderOutbox = null; // pollLoop에서 초기화
let _borderAgentName = null; // border-status용 에이전트 이름 (main에서 설정)
let nativeTuiPaneId = null;       // 네이티브 Codex TUI pane ID (cleanup용)
let nativeTuiSessionName = null;  // 네이티브 TUI tmux 세션 이름 (cleanup용)
let wsPort = null;                // WebSocket app-server 포트 (네이티브 TUI용)

// ─── Inline mkdir-based Lock (proper-lockfile compatible) ───
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withLock(filePath, fn) {
  const lockDir = `${filePath}.lock`;
  const maxRetries = 10;
  const staleMs = 10000;

  for (let i = 0; i < maxRetries; i++) {
    try {
      await mkdir(lockDir); // atomic mkdir
      try {
        return await fn();
      } finally {
        await rmdir(lockDir).catch(() => {});
      }
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const s = await fsStat(lockDir);
        if (Date.now() - s.mtimeMs > staleMs) {
          await rmdir(lockDir).catch(() => {});
          continue;
        }
      } catch {
        continue;
      }
      await sleep(5 + Math.random() * 95);
    }
  }
  throw new Error(`Lock timeout: ${filePath}`);
}

// ─── CLI Arg Parser ───
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (
      arg === "--dangerously-skip-permissions" ||
      arg === "--plan-mode-required"
    ) {
      args[arg.slice(2)] = true;
    } else if (arg.startsWith("--") && i + 1 < argv.length) {
      args[arg.slice(2)] = argv[++i];
    }
  }
  return {
    agentId: args["agent-id"], // "worker-1@my-team"
    agentName: args["agent-name"], // "worker-1"
    teamName: args["team-name"], // "my-team"
    agentColor: args["agent-color"] || "cyan",
    parentSessionId: args["parent-session-id"],
    agentType: args["agent-type"],
    model: args["model"],
  };
}

// ─── Goal Context (Paperclip-inspired "왜?" 추적) ───
function readTeamGoal(teamName) {
  try {
    const configPath = join(TEAMS_BASE, teamName, "config.json");
    if (!existsSync(configPath)) return null;
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return raw.description || null;
  } catch { return null; }
}

// ─── Path Helpers ───
function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function getInboxDir(teamName) {
  return join(TEAMS_BASE, sanitize(teamName), "inboxes");
}

function getInboxPath(agentName, teamName) {
  return join(getInboxDir(teamName), `${sanitize(agentName)}.json`);
}

function getLeaderInboxPath(teamName) {
  return join(getInboxDir(teamName), `${sanitize(LEADER_NAME)}.json`);
}

// ─── Visual Feedback (tmux pane) ───
function ts() {
  return new Date().toISOString().slice(11, 19);
}

function log(tag, msg) {
  const line = `[${ts()}] [${tag}] ${msg}`;
  if (logStream) {
    logStream.write(line + "\n");
  } else {
    process.stderr.write(line + "\n");
  }
}

function initLogFile(agentName) {
  const logPath = `/tmp/codex-bridge-${agentName}.log`;
  logStream = createWriteStream(logPath, { flags: "a" });
  log("LOG", `redirected to ${logPath}`);
}

function closeLogFile() {
  if (!logStream) return;
  const stream = logStream;
  logStream = null;
  stream.end();
}

function closeViewer() {
  if (!viewerProc) return;
  try {
    if (viewerProc.stdin && !viewerProc.stdin.destroyed) {
      viewerProc.stdin.end();
    }
  } catch {
    // best effort
  }
  // tmux pane cleanup
  if (viewerTmuxPaneId) {
    try {
      spawnSync("tmux", ["kill-pane", "-t", viewerTmuxPaneId], { stdio: "ignore", timeout: 2000 });
    } catch {}
    viewerTmuxPaneId = null;
  }
  if (viewerFifoPath) {
    try { unlinkSync(viewerFifoPath); } catch {}
    viewerFifoPath = null;
  }
  viewerProc = null;
}

// ─── Pane Renderer: app-server notification → Codex exec 스타일 출력 ───
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

// ─── Width-aware truncation helpers ───
function getPaneWidth() {
  try {
    const cols = process.stderr.columns || 80;
    return Math.max(cols, 40);
  } catch { return 80; }
}

function truncateMiddle(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  const ellipsis = "...";
  const half = Math.floor((maxLen - ellipsis.length) / 2);
  return str.slice(0, half) + ellipsis + str.slice(str.length - half);
}

// 현재 렌더링 상태 (스트리밍 모드 추적)
const renderState = {
  mode: "idle", // "idle" | "agent" | "exec" | "file" | "reasoning"
  lastItemId: null,
  lastTokenTotal: 0,
  lastCmd: null, // 현재 실행 중인 명령어 정보
  headerPrinted: false, // 세션 헤더 출력 여부
  // exec outputDelta를 스트리밍한 아이템 추적 (완료 시 aggregatedOutput 중복 방지)
  execStreamedItems: new Set(),
  // ── Compact mode state ──
  compactMode: process.env.CODEX_BRIDGE_VERBOSE !== "1",
  currentPhase: "idle",        // idle/exec/patch/search/plan/thinking
  lastMeaningfulEvent: "",     // 1-line summary of last significant event
  suppressedLines: 0,          // count of hidden output lines
  recentEvents: [],            // ring buffer, max 6 entries
  tailBuffer: [],              // last 20 lines of raw output for failure expansion
  turnStartedAt: 0,            // timestamp for elapsed time display
};

// 핵심 이벤트를 로그 + ANSI pane 양쪽에 출력
function logAndRender(tag, msg) {
  log(tag, msg);
  renderWrite(`${ANSI.yellow}[${tag}]${ANSI.reset} ${msg}\n`);
}

function logAndRenderError(tag, msg) {
  log(tag, msg);
  renderWrite(`${ANSI.red}${ANSI.bold}[${tag}]${ANSI.reset} ${msg}\n`);
}

function renderWrite(text) {
  process.stderr.write(text);
}

function endStreamMode() {
  if (renderState.mode !== "idle") {
    if (renderState.mode === "agent" || renderState.mode === "reasoning") {
      renderWrite(`${ANSI.reset}\n`);
    }
    renderState.mode = "idle";
    renderState.lastItemId = null;
  }
}

// Codex exec 스타일: "label\ncontent" 형식의 섹션 헤더
function renderLabel(label, color = ANSI.cyan) {
  renderWrite(`${ANSI.bold}${color}${label}${ANSI.reset}\n`);
}

function renderSessionHeader() {
  if (renderState.headerPrinted) return;
  renderState.headerPrinted = true;
  renderWrite(`${ANSI.dim}--------${ANSI.reset}\n`);
}

// ── Compact mode helpers ──
function addRecentEvent(text) {
  renderState.recentEvents.push(text);
  if (renderState.recentEvents.length > 6) {
    renderState.recentEvents.shift();
  }
  renderState.lastMeaningfulEvent = text;
}

function addToTailBuffer(line) {
  renderState.tailBuffer.push(line);
  if (renderState.tailBuffer.length > 20) {
    renderState.tailBuffer.shift();
  }
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `t+${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const PHASE_LABELS = {
  idle: "IDLE",
  exec: "EXEC",
  patch: "PATCH",
  search: "SEARCH",
  plan: "PLAN",
  thinking: "THINK",
};

const PHASE_COLORS = {
  idle: ANSI.dim,
  exec: ANSI.yellow,
  patch: ANSI.cyan,
  search: ANSI.blue,
  plan: ANSI.magenta,
  thinking: ANSI.dim,
};

function renderCompactView() {
  if (!renderState.compactMode) return;
  // Clear pane: move cursor to top-left and clear screen
  renderWrite("\x1b[2J\x1b[H");
  // Phase header line with elapsed time
  const phaseTag = PHASE_LABELS[renderState.currentPhase] || renderState.currentPhase.toUpperCase();
  const elapsed = renderState.turnStartedAt > 0
    ? formatElapsed(Date.now() - renderState.turnStartedAt)
    : "t+00:00";
  const pw = getPaneWidth();
  const summaryMax = pw - phaseTag.length - 2 - 10; // margin for [TAG] + elapsed
  const summary = renderState.lastMeaningfulEvent
    ? `  ${truncateMiddle(renderState.lastMeaningfulEvent, summaryMax)}`
    : "";
  const phaseColor = PHASE_COLORS[renderState.currentPhase] || ANSI.cyan;
  renderWrite(`${ANSI.bold}${phaseColor}[${phaseTag}]${ANSI.reset}${ANSI.dim}${summary}${ANSI.reset}`);
  // Right-align elapsed time
  const headerLen = phaseTag.length + 2 + summary.length;
  const pad = Math.max(1, pw - 20 - headerLen);
  renderWrite(`${" ".repeat(pad)}${ANSI.dim}${elapsed}${ANSI.reset}\n`);
  // Recent events list
  const evMax = pw - 6; // margin for "  • " prefix
  for (const ev of renderState.recentEvents) {
    renderWrite(`  ${ANSI.dim}\u2022${ANSI.reset} ${truncateMiddle(ev, evMax)}\n`);
  }
  // Suppressed count
  if (renderState.suppressedLines > 0) {
    renderWrite(`  ${ANSI.dim}(${renderState.suppressedLines} lines hidden)${ANSI.reset}\n`);
  }
  // Update tmux border-status header alongside compact view
  if (_borderAgentName) updateBorderStatus(_borderAgentName);
}

function renderNotificationANSI(method, params) {
  if (!params) return;
  const compact = renderState.compactMode;

  switch (method) {
    // ── 턴 시작 ──
    case "turn/started": {
      endStreamMode();
      if (compact) {
        renderState.turnStartedAt = Date.now();
        renderState.currentPhase = "idle";
        renderState.suppressedLines = 0;
        renderState.recentEvents = [];
        renderState.tailBuffer = [];
        renderCompactView();
      } else {
        renderSessionHeader();
      }
      break;
    }

    // ── 턴 완료 ──
    case "turn/completed": {
      endStreamMode();
      const turn = params.turn || {};
      const status = turn.status || "unknown";
      if (compact) {
        renderState.currentPhase = "idle";
        const durStr = renderState.turnStartedAt > 0
          ? formatElapsed(Date.now() - renderState.turnStartedAt)
          : "";
        const tokStr = renderState.lastTokenTotal > 0
          ? ` | ${renderState.lastTokenTotal.toLocaleString()} tokens`
          : "";
        addRecentEvent(`turn ${status} (${durStr}${tokStr})`);
        renderState.turnStartedAt = 0;
        renderCompactView();
        if (status !== "completed") {
          renderWrite(`${ANSI.red}${ANSI.bold}[ERR]${ANSI.reset} ${ANSI.red}turn ${status}${ANSI.reset}\n`);
        }
      } else {
        if (renderState.lastTokenTotal > 0) {
          renderWrite(`${ANSI.bold}tokens used${ANSI.reset}\n`);
          renderWrite(`${ANSI.dim}${renderState.lastTokenTotal.toLocaleString()}${ANSI.reset}\n`);
        }
        renderWrite(`${ANSI.dim}--------${ANSI.reset}\n`);
        if (status !== "completed") {
          renderWrite(`${ANSI.red}${ANSI.bold}[ERR]${ANSI.reset} ${ANSI.red}turn ${status}${ANSI.reset}\n`);
        }
        renderState.headerPrinted = false;
      }
      break;
    }

    // ── 에이전트 메시지 스트리밍 ──
    case "item/agentMessage/delta": {
      if (compact) {
        renderState.suppressedLines++;
        addToTailBuffer(params.delta || "");
        // accumulate text for summary on completion — no render
      } else {
        if (renderState.mode !== "agent" || renderState.lastItemId !== params.itemId) {
          endStreamMode();
          renderLabel("codex");
          renderState.mode = "agent";
          renderState.lastItemId = params.itemId;
        }
        renderWrite(params.delta || "");
      }
      break;
    }

    // ── 명령 실행 출력 (스트리밍) ──
    case "item/commandExecution/outputDelta": {
      if (compact) {
        if (params.itemId) renderState.execStreamedItems.add(params.itemId);
        renderState.suppressedLines++;
        addToTailBuffer(params.delta || "");
        // periodic compact refresh (every 20 suppressed lines)
        if (renderState.suppressedLines % 20 === 0) renderCompactView();
      } else {
        if (renderState.mode !== "exec" || renderState.lastItemId !== params.itemId) {
          endStreamMode();
          renderState.mode = "exec";
          renderState.lastItemId = params.itemId;
        }
        if (params.itemId) renderState.execStreamedItems.add(params.itemId);
        renderWrite(params.delta || "");
      }
      break;
    }

    // ── 파일 변경 출력 ──
    case "item/fileChange/outputDelta": {
      if (compact) {
        renderState.suppressedLines++;
        addToTailBuffer(params.delta || "");
      } else {
        if (renderState.mode !== "file" || renderState.lastItemId !== params.itemId) {
          endStreamMode();
          renderState.mode = "file";
          renderState.lastItemId = params.itemId;
        }
        renderWrite(`${ANSI.cyan}${params.delta || ""}${ANSI.reset}`);
      }
      break;
    }

    // ── 추론 요약 스트리밍 ──
    case "item/reasoning/summaryTextDelta": {
      if (compact) {
        renderState.suppressedLines++;
        // completely suppress reasoning deltas in compact mode
      } else {
        if (renderState.mode !== "reasoning" || renderState.lastItemId !== params.itemId) {
          endStreamMode();
          renderWrite(`${ANSI.dim}${ANSI.italic}`);
          renderState.mode = "reasoning";
          renderState.lastItemId = params.itemId;
        }
        renderWrite(params.delta || "");
      }
      break;
    }

    // ── 아이템 시작 ──
    case "item/started": {
      const item = params.item;
      if (!item) break;
      if (item.type === "commandExecution") {
        endStreamMode();
        renderState.lastCmd = {
          command: item.command,
          cwd: item.cwd,
          startTime: Date.now(),
        };
        if (compact) {
          const cmdShort = truncateMiddle(item.command || "", getPaneWidth() - 12);
          addRecentEvent(`exec: ${cmdShort}`);
          renderState.currentPhase = "exec";
          renderCompactView();
        } else {
          // exec 시작 헤더를 즉시 출력 (스트리밍 중 명령 식별)
          const cmdW = getPaneWidth() - 16;
          renderLabel("[RUN] exec", ANSI.yellow);
          renderWrite(`${ANSI.dim}\u25b6 ${truncateMiddle(item.command || "", cmdW)} in ${truncateMiddle(item.cwd || "", 30)}${ANSI.reset}\n`);
        }
      } else if (item.type === "fileChange") {
        endStreamMode();
        if (compact) {
          const files = (item.changes || []).map((c) => c.path || c.file || "").filter(Boolean);
          const summary = files.length > 0 ? files.map((f) => basename(f)).join(", ") : "files";
          addRecentEvent(`patch: ${truncateMiddle(summary, getPaneWidth() - 12)}`);
          renderState.currentPhase = "patch";
          renderCompactView();
        } else {
          const files = (item.changes || []).map((c) => c.path || c.file || "").filter(Boolean);
          renderLabel("[PATCH] patch", ANSI.cyan);
          if (files.length > 0) {
            renderWrite(`${ANSI.dim}${truncateMiddle(files.join(", "), getPaneWidth() - 4)}${ANSI.reset}\n`);
          }
        }
      } else if (item.type === "webSearch") {
        endStreamMode();
        if (compact) {
          const q = truncateMiddle(item.query || "", getPaneWidth() - 14);
          addRecentEvent(`search: "${q}"`);
          renderState.currentPhase = "search";
          renderCompactView();
        } else {
          renderLabel("[SEARCH] web search", ANSI.blue);
          renderWrite(`${truncateMiddle(item.query || "", getPaneWidth() - 4)}\n`);
        }
      }
      break;
    }

    // ── 아이템 완료 ──
    case "item/completed": {
      const item = params.item;
      if (!item) break;
      if (item.type === "commandExecution") {
        const alreadyStreamed = item.id && renderState.execStreamedItems.has(item.id);
        if (item.id) renderState.execStreamedItems.delete(item.id);
        endStreamMode();
        if (compact) {
          const dur = item.durationMs != null ? `${(item.durationMs / 1000).toFixed(1)}s` : "";
          const succeeded = item.exitCode === 0;
          const statusStr = succeeded ? "exit 0" : `exit ${item.exitCode}`;
          const suffixLen = statusStr.length + (dur ? dur.length + 2 : 0) + 10;
          const cmdShort = truncateMiddle(item.command || "", getPaneWidth() - suffixLen);
          addRecentEvent(`exec: ${cmdShort} (${statusStr}${dur ? `, ${dur}` : ""})`);
          renderState.currentPhase = "idle";
          renderState.lastCmd = null;
          // On failure, dump tail buffer for debugging
          if (!succeeded) {
            renderCompactView();
            renderWrite(`${ANSI.red}${ANSI.bold}[ERR] exec failed (exit=${item.exitCode})${ANSI.reset}\n`);
            const tail = renderState.tailBuffer.slice(-15);
            for (const line of tail) {
              renderWrite(`${ANSI.dim}${line}${ANSI.reset}\n`);
            }
            renderWrite(`${ANSI.red}${ANSI.bold}[ERR] end failure output${ANSI.reset}\n`);
          } else {
            renderCompactView();
          }
        } else {
          // Codex exec 스타일: "exec\ncommand in dir succeeded/failed in Xms:\noutput"
          const dur = item.durationMs != null ? `${item.durationMs}ms` : "";
          const succeeded = item.exitCode === 0;
          const statusWord = succeeded
            ? `${ANSI.green}succeeded${ANSI.reset}`
            : `${ANSI.red}failed (exit=${item.exitCode})${ANSI.reset}`;
          renderLabel(succeeded ? "[OK] exec" : "[ERR] exec", succeeded ? ANSI.green : ANSI.red);
          { const _cw = getPaneWidth() - 30; renderWrite(`${ANSI.dim}${truncateMiddle(item.command || "", _cw)} in ${truncateMiddle(item.cwd || "", 30)}${ANSI.reset} ${statusWord} ${ANSI.dim}in ${dur}${ANSI.reset}:\n`); }
          // 이미 스트리밍된 출력은 재출력하지 않음 (중복 방지)
          if (item.aggregatedOutput && !alreadyStreamed) {
            renderWrite(`${item.aggregatedOutput}${item.aggregatedOutput.endsWith("\n") ? "" : "\n"}`);
          }
          renderState.lastCmd = null;
        }
      } else if (item.type === "agentMessage") {
        if (compact) {
          // Build 1-line summary from tail buffer (last accumulated text)
          const fullText = renderState.tailBuffer.join("").replace(/\n/g, " ").trim();
          if (fullText.length > 0) {
            addRecentEvent(`agent: ${truncateMiddle(fullText, getPaneWidth() - 12)}`);
          }
          renderState.tailBuffer = [];
          renderCompactView();
        } else {
          endStreamMode();
        }
      } else if (item.type === "fileChange") {
        endStreamMode();
        if (compact) {
          const changes = item.changes || [];
          let added = 0, removed = 0;
          for (const c of changes) {
            added += c.additions || 0;
            removed += c.deletions || 0;
          }
          const files = changes.map((c) => basename(c.path || c.file || "")).filter(Boolean);
          const summary = files.length > 0 ? files.join(", ") : "files";
          const statsStr = ` +${added}/-${removed}`;
          addRecentEvent(`patch: ${truncateMiddle(summary, getPaneWidth() - 12 - statsStr.length)}${statsStr}`);
          renderState.currentPhase = "idle";
          renderCompactView();
        } else {
          const changes = item.changes || [];
          for (const c of changes) {
            const path = c.path || c.file || "";
            if (path) renderWrite(`  ${ANSI.green}+${ANSI.reset} ${truncateMiddle(path, getPaneWidth() - 6)}\n`);
          }
        }
      }
      break;
    }

    // ── 계획 업데이트 ──
    case "turn/plan/updated": {
      endStreamMode();
      if (compact) {
        const steps = params.plan || [];
        const inProgress = steps.find((s) => s.status === "inProgress");
        const completedCount = steps.filter((s) => s.status === "completed").length;
        const total = steps.length;
        const stepDesc = inProgress ? inProgress.step : (params.explanation || "planning");
        const planPrefix = `plan: step ${completedCount + (inProgress ? 1 : 0)}/${total} - `;
        addRecentEvent(`${planPrefix}${truncateMiddle(stepDesc, getPaneWidth() - 10 - planPrefix.length)}`);
        renderState.currentPhase = "plan";
        renderCompactView();
      } else {
        renderLabel("[PLAN] plan", ANSI.magenta);
        if (params.explanation) {
          renderWrite(`${ANSI.dim}${truncateMiddle(params.explanation, getPaneWidth() - 4)}${ANSI.reset}\n`);
        }
        const steps = params.plan || [];
        const stepW = getPaneWidth() - 6;
        for (const step of steps) {
          let marker;
          switch (step.status) {
            case "completed": marker = `${ANSI.green}\u2713${ANSI.reset}`; break;
            case "inProgress": marker = `${ANSI.yellow}>${ANSI.reset}`; break;
            default: marker = `${ANSI.dim}-${ANSI.reset}`; break;
          }
          renderWrite(`  ${marker} ${truncateMiddle(step.step, stepW)}\n`);
        }
      }
      break;
    }

    // ── Diff 업데이트 ──
    case "turn/diff/updated": {
      endStreamMode();
      if (compact) {
        const diff = params.diff || "";
        const lines = diff.split("\n");
        let addCount = 0, delCount = 0;
        const filesSet = new Set();
        for (const line of lines) {
          if (line.startsWith("+") && !line.startsWith("+++")) addCount++;
          else if (line.startsWith("-") && !line.startsWith("---")) delCount++;
          if (line.startsWith("--- a/") || line.startsWith("+++ b/")) {
            filesSet.add(basename(line.slice(6)));
          }
        }
        addRecentEvent(`diff: +${addCount}/-${delCount}, ${filesSet.size || "?"} files`);
        renderCompactView();
      } else {
        renderLabel("[PATCH] diff", ANSI.cyan);
        const diff = params.diff || "";
        const lines = diff.split("\n");
        for (const line of lines.slice(0, 50)) {
          if (line.startsWith("+")) {
            renderWrite(`${ANSI.green}${line}${ANSI.reset}\n`);
          } else if (line.startsWith("-")) {
            renderWrite(`${ANSI.red}${line}${ANSI.reset}\n`);
          } else if (line.startsWith("@@")) {
            renderWrite(`${ANSI.cyan}${line}${ANSI.reset}\n`);
          } else {
            renderWrite(`${line}\n`);
          }
        }
        if (lines.length > 50) {
          renderWrite(`${ANSI.dim}... (${lines.length - 50} more lines)${ANSI.reset}\n`);
        }
      }
      break;
    }

    // ── 토큰 사용량 ──
    case "thread/tokenUsage/updated": {
      const usage = params.tokenUsage;
      if (!usage) break;
      const total = usage.total || {};
      renderState.lastTokenTotal = total.totalTokens || 0;
      break;
    }

    // ── 에러 (always show in full) ──
    case "error": {
      endStreamMode();
      const err = params.error;
      const willRetry = params.willRetry ? " (will retry)" : "";
      renderWrite(`${ANSI.red}${ANSI.bold}[ERR] error${ANSI.reset}\n`);
      renderWrite(`${truncateMiddle(err?.message || JSON.stringify(err), getPaneWidth() - 4)}${willRetry}\n`);
      if (compact) {
        addRecentEvent(`[ERR] ${truncateMiddle(err?.message || "unknown", getPaneWidth() - 12)}`);
        renderCompactView();
      }
      break;
    }

    default:
      break;
  }
}

// ThreadStartResponse uses camelCase for SandboxPolicy type field,
// but SessionConfiguredEvent expects kebab-case. Convert accordingly.
const SANDBOX_CAMEL_TO_KEBAB = {
  dangerFullAccess: "danger-full-access",
  readOnly: "read-only",
  workspaceWrite: "workspace-write",
};
function normalizeSandboxPolicy(sandbox) {
  if (typeof sandbox === "string") {
    const mapped = SANDBOX_CAMEL_TO_KEBAB[sandbox];
    if (!mapped && sandbox !== "danger-full-access" && sandbox !== "read-only" && sandbox !== "workspace-write") {
      log("SANDBOX", `unknown policy "${sandbox}", passing through as-is`);
    }
    return { type: mapped || sandbox };
  }
  if (sandbox && typeof sandbox === "object" && sandbox.type) {
    const mapped = SANDBOX_CAMEL_TO_KEBAB[sandbox.type];
    if (!mapped && sandbox.type !== "danger-full-access" && sandbox.type !== "read-only" && sandbox.type !== "workspace-write") {
      log("SANDBOX", `unknown policy type "${sandbox.type}", passing through as-is`);
    }
    return { ...sandbox, type: mapped || sandbox.type };
  }
  return { type: "danger-full-access" };
}

function renderNotification(method, params) {
  // 네이티브 TUI 모드: resume으로 같은 thread를 공유하므로 bridge 렌더링 불필요
  if (nativeTuiPaneId) return;

  if (viewerProc && viewerProc.stdin && !viewerProc.stdin.destroyed) {
    try {
      if (viewerProc.viewerType === "real-tui") {
        // Real Codex TUI: forward item/* and turn/* events
        if (method.startsWith("item/") || method.startsWith("turn/")) {
          viewerProc.stdin.write(JSON.stringify({ method, params }) + "\n");
        }
      } else {
        // Blessed viewer: write full notification
        viewerProc.stdin.write(JSON.stringify({ method, params }) + "\n");
      }
      return;
    } catch {
      viewerProc = null;
    }
  }
  renderNotificationANSI(method, params);
}

function getCodexVersion() {
  try {
    const result = spawnSync("codex", ["--version"], { encoding: "utf8", timeout: 5000 });
    const m = (result.stdout || "").match(/(\d+\.\d+\.\d+[^\s]*)/);
    return m ? m[1] : null;
  } catch { return null; }
}

function findTuiBin() {
  // 1. CODEX_TUI_BIN env
  if (process.env.CODEX_TUI_BIN && existsSync(process.env.CODEX_TUI_BIN)) {
    return process.env.CODEX_TUI_BIN;
  }
  // 2. PATH lookup
  try {
    const result = spawnSync("which", ["codex-tui"], { encoding: "utf8", timeout: 3000 });
    const p = (result.stdout || "").trim();
    if (p && existsSync(p)) return p;
  } catch {}
  // 3. Known build paths
  const knownPaths = [
    join(homedir(), ".cargo", "bin", "codex-tui"),
    join(homedir(), ".local", "bin", "codex-tui"),
    "/usr/local/bin/codex-tui",
  ];
  for (const p of knownPaths) {
    if (existsSync(p)) return p;
  }
  return null;
}

function spawnTuiViewer(agentName) {
  // Real Codex TUI binary (--pipe-fd support) — 존재할 때만
  let tuiBin = findTuiBin();
  if (tuiBin && existsSync(tuiBin)) {
    const realVersion = getCodexVersion();
    log("TUI", `spawning real codex-tui: ${tuiBin} (codex version: ${realVersion || "unknown"})`);
    const tuiEnv = { ...process.env, FORCE_COLOR: "1" };
    if (realVersion) tuiEnv.CODEX_VERSION_OVERRIDE = realVersion;
    const proc = spawn(tuiBin, ["--pipe-fd", "0"], {
      stdio: ["pipe", "inherit", "pipe"],
      env: tuiEnv,
    });
    proc.viewerType = "real-tui";
    attachViewerHandlers(proc);
    log("TUI", `real codex-tui viewer spawned (pid=${proc.pid})`);
    return proc;
  }

  log("TUI", "no codex-tui binary found, using ANSI fallback");
  return null;
}

// ─── tmux pane 기반 TUI 뷰어 ───
function spawnTuiTmuxPane(agentName) {
  const fifoPath = `/tmp/codex-tui-${process.pid}.fifo`;

  // FIFO 생성
  try { unlinkSync(fifoPath); } catch {}
  const mkResult = spawnSync("mkfifo", [fifoPath], { timeout: 3000 });
  if (mkResult.status !== 0) {
    log("TUI", `mkfifo failed: ${mkResult.stderr?.toString().trim()}`);
    return null;
  }

  // tmux pane에서 Ink 뷰어 실행
  const baseDir = import.meta.dirname || new URL(".", import.meta.url).pathname;
  const viewerPath = join(baseDir, "codex-ink-viewer.mjs");
  if (!existsSync(viewerPath)) {
    log("TUI", "codex-ink-viewer.mjs not found, cannot spawn tmux pane");
    try { unlinkSync(fifoPath); } catch {}
    return null;
  }

  const cmd = `exec node ${JSON.stringify(viewerPath)} --name ${JSON.stringify(agentName)} --fifo ${JSON.stringify(fifoPath)}`;
  const splitResult = spawnSync("tmux", [
    "split-window", "-h", "-l", "45%",
    "-P", "-F", "#{pane_id}",  // pane ID 출력
    cmd,
  ], { encoding: "utf8", timeout: 5000 });

  if (splitResult.status !== 0) {
    log("TUI", `tmux split-window failed: ${splitResult.stderr?.trim()}`);
    try { unlinkSync(fifoPath); } catch {}
    return null;
  }

  const paneId = (splitResult.stdout || "").trim();
  log("TUI", `tmux pane created: ${paneId}`);

  // #3 근본 수정: break-pane 제거 — bridge와 viewer를 같은 윈도우에 유지
  // 이유: break-pane하면 viewer가 죽을 때 윈도우 pane이 0개 → tmux 윈도우 자동 삭제
  //       → bridge는 숨은 백그라운드 윈도우에서 돌지만 사용자에겐 "꺼짐"으로 보임
  // viewer pane에 포커스만 이동, bridge pane은 같은 윈도우에 split으로 유지
  try {
    spawnSync("tmux", ["select-pane", "-t", paneId], { stdio: "ignore", timeout: 2000 });
  } catch {}
  // 리더(team-lead) pane으로 포커스 복원
  try {
    spawnSync("tmux", ["select-pane", "-l"], { stdio: "ignore", timeout: 2000 });
  } catch {}

  // FIFO를 O_RDWR로 열기 (blocking 방지 Unix 트릭)
  let fd;
  try {
    fd = openSync(fifoPath, "r+"); // O_RDWR → reader 없어도 block 안 됨
  } catch (err) {
    log("TUI", `FIFO open failed: ${err.message}`);
    try { spawnSync("tmux", ["kill-pane", "-t", paneId], { stdio: "ignore" }); } catch {}
    try { unlinkSync(fifoPath); } catch {}
    return null;
  }

  const stream = createWriteStream(null, { fd, autoClose: true });
  stream.on("error", (err) => {
    log("TUI", `FIFO write error: ${err.code || err.message}`);
    viewerProc = null;
  });

  // viewerProc 호환 객체 (renderNotification이 viewerProc.stdin 사용)
  viewerFifoPath = fifoPath;
  viewerTmuxPaneId = paneId;

  return {
    stdin: stream,
    viewerType: "blessed",
    _sessionSent: false,
    _isTmux: true,
  };
}

// ─── 네이티브 Codex TUI (app-server WebSocket 경유) ───

function findCodexAlphaBin() {
  // 1. CODEX_ALPHA_BIN env
  if (process.env.CODEX_ALPHA_BIN && existsSync(process.env.CODEX_ALPHA_BIN)) {
    return process.env.CODEX_ALPHA_BIN;
  }
  // 2. Known paths (codex-alpha, codex-next)
  const knownPaths = [
    join(homedir(), ".local", "bin", "codex-alpha"),
    join(homedir(), ".local", "bin", "codex-next"),
    "/usr/local/bin/codex-alpha",
  ];
  for (const p of knownPaths) {
    if (existsSync(p)) return p;
  }
  // 3. 기본 codex가 0.117+이면 그대로 사용
  const ver = getCodexVersion();
  if (ver) {
    const m = ver.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (m && (Number(m[1]) > 0 || Number(m[2]) >= 117)) {
      try {
        const r = spawnSync("which", ["codex"], { encoding: "utf8", timeout: 3000 });
        const p = (r.stdout || "").trim();
        if (p && existsSync(p)) return p;
      } catch {}
    }
  }
  return null;
}

function getRandomPort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function spawnNativeTuiPane(agentName, port, threadId) {
  if (!process.env.TMUX) {
    log("NATIVE-TUI", "not in tmux, cannot spawn native TUI pane");
    return null;
  }

  const codexBin = findCodexAlphaBin();
  if (!codexBin) {
    log("NATIVE-TUI", "codex-alpha binary not found, skipping native TUI");
    return null;
  }

  // threadId가 있으면 resume으로 같은 thread에 붙음 (핵심!)
  const remoteArg = `--remote ws://127.0.0.1:${port}`;
  const cmd = threadId
    ? `${JSON.stringify(codexBin)} resume ${threadId} ${remoteArg} --enable tui_app_server`
    : `${JSON.stringify(codexBin)} ${remoteArg} --enable tui_app_server`;
  const myPane = process.env.TMUX_PANE;

  if (myPane) {
    // TUI를 bridge pane 아래에 생성 (세로 분할)
    const splitResult = spawnSync("tmux", [
      "split-window", "-v",          // 세로 분할 (위: bridge, 아래: TUI)
      "-t", myPane,
      "-d",                          // 포커스 안 빼앗김 (오케 유지)
      "-P", "-F", "#{pane_id}",
      cmd,
    ], { encoding: "utf8", timeout: 5000 });

    if (splitResult.status === 0) {
      const tuiPaneId = (splitResult.stdout || "").trim();

      // bridge pane을 1줄로 축소 → 에이전트 이름 표시 바 역할
      try {
        spawnSync("tmux", ["resize-pane", "-t", myPane, "-y", "1"], { stdio: "ignore", timeout: 2000 });
      } catch {}

      nativeTuiPaneId = tuiPaneId;
      log("NATIVE-TUI", `TUI=${tuiPaneId}, bridge=${myPane} as status bar (ws://127.0.0.1:${port}, thread=${threadId || "new"})`);

      try {
        spawnSync("tmux", ["set-option", "-p", "-t", tuiPaneId, "remain-on-exit", "on"], { stdio: "ignore", timeout: 2000 });
      } catch {}

      // 포커스를 오케(이전 pane)로 복원
      try {
        spawnSync("tmux", ["select-pane", "-l"], { stdio: "ignore", timeout: 2000 });
      } catch {}

      return tuiPaneId;
    }
    log("NATIVE-TUI", `split-window failed: ${splitResult.stderr?.trim()}, falling back to session`);
  }

  // fallback: 별도 tmux 세션 (TMUX_PANE 없을 때)
  const sessionName = `tui-${agentName}-${process.pid}`;
  const result = spawnSync("tmux", [
    "new-session", "-d",
    "-s", sessionName,
    "-x", "250", "-y", "60",
    "-P", "-F", "#{pane_id}",
    cmd,
  ], { encoding: "utf8", timeout: 5000 });

  if (result.status !== 0) {
    log("NATIVE-TUI", `tmux new-session failed: ${result.stderr?.trim()}`);
    return null;
  }

  const paneId = (result.stdout || "").trim();
  nativeTuiPaneId = paneId;
  nativeTuiSessionName = sessionName;
  log("NATIVE-TUI", `TUI session created: ${sessionName} pane=${paneId} (ws://127.0.0.1:${port})`);
  return paneId;
}

function closeNativeTuiPane() {
  if (nativeTuiSessionName) {
    try {
      spawnSync("tmux", ["kill-session", "-t", nativeTuiSessionName], { stdio: "ignore", timeout: 2000 });
    } catch {}
    nativeTuiSessionName = null;
    nativeTuiPaneId = null;
    return;
  }
  if (!nativeTuiPaneId) return;
  try {
    spawnSync("tmux", ["kill-pane", "-t", nativeTuiPaneId], { stdio: "ignore", timeout: 2000 });
  } catch {}
  nativeTuiPaneId = null;
}

function attachViewerHandlers(proc) {
  proc.on("error", (err) => {
    log("TUI", `viewer error: ${err.message}`);
    viewerProc = null;
  });
  proc.on("close", (code) => {
    log("TUI", `viewer exited (code=${code})`);
    viewerProc = null;
  });
  // EPIPE 방지: viewer가 먼저 죽으면 stdin.write()에서 에러 이벤트 발생
  if (proc.stdin) {
    proc.stdin.on("error", (err) => {
      log("TUI", `viewer stdin error: ${err.code || err.message}`);
      viewerProc = null;
    });
  }
  if (proc.stderr) {
    proc.stderr.on("data", (chunk) => {
      log("TUI-ERR", chunk.toString().trim());
    });
  }
}

// ─── Inbox I/O ───
async function ensureInbox(inboxPath) {
  const dir = join(inboxPath, "..");
  await mkdir(dir, { recursive: true });
  if (!existsSync(inboxPath)) {
    await writeFile(inboxPath, "[]", "utf-8");
  }
}

async function readInbox(inboxPath) {
  try {
    const raw = await readFile(inboxPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    const backupPath = `${inboxPath}.corrupt.${Date.now()}`;
    try {
      await rename(inboxPath, backupPath);
      log("INBOX-CORRUPT", `quarantined to ${backupPath}: ${err.message}`);
    } catch {}
    return [];
  }
}

// ─── Claim + MarkAsRead 통합: 1회 lock/parse/write ───
async function claimUnreadMessages(inboxPath) {
  return withLock(inboxPath, async () => {
    const messages = await readInbox(inboxPath);
    const unread = [];
    let changed = false;
    for (let i = 0; i < messages.length; i++) {
      if (!messages[i].read) {
        unread.push({ msg: messages[i] });
        messages[i].read = true;
        changed = true;
      }
    }
    if (changed) {
      const readMessages = messages.filter((m) => m.read);
      let pruned = messages;
      if (readMessages.length > 100) {
        const unreadMsgs = messages.filter((m) => !m.read);
        const recentRead = readMessages.slice(-50);
        pruned = [...recentRead, ...unreadMsgs];
        log("INBOX-PRUNE", `pruned ${messages.length} → ${pruned.length} messages`);
      }
      await writeFile(inboxPath, JSON.stringify(pruned), "utf-8");
    }
    return unread;
  });
}

async function writeToInbox(inboxPath, message) {
  await ensureInbox(inboxPath);
  await withLock(inboxPath, async () => {
    const messages = await readInbox(inboxPath);
    messages.push(message);
    await writeFile(inboxPath, JSON.stringify(messages), "utf-8");
  });
}

// ─── Leader Outbox (CAS + micro-batching + in-memory spool) ───
// 1) CAS+temp rename: lock 보유 시간 최소화
// 2) micro-batching: 50ms debounce로 여러 메시지를 1회 write
// 3) in-memory spool: 워커별 큐 → flush 시에만 leader inbox에 쓰기
class LeaderOutbox {
  constructor(leaderInboxPath) {
    this.path = leaderInboxPath;
    this.queue = [];
    this.timer = null;
    this.chain = Promise.resolve();
  }

  enqueue(msg) {
    this.queue.push(msg);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.chain = this.chain
          .then(() => this._drain())
          .catch((e) => log("OUTBOX-ERR", e.message));
      }, FLUSH_DEBOUNCE_MS);
    }
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.chain = this.chain
      .then(() => this._drain())
      .catch((e) => log("OUTBOX-ERR", e.message));
    return this.chain;
  }

  async _drain() {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    await ensureInbox(this.path);

    // Phase 1: prepare outside lock (heavy I/O)
    const pre = await fsStat(this.path).catch(() => null);
    const existing = await readInbox(this.path);
    existing.push(...batch);
    const tmp = `${this.path}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(existing), "utf-8");

    // Phase 2: CAS verify + atomic rename inside lock (minimal hold)
    let ok = false;
    try {
      ok = await withLock(this.path, async () => {
        const post = await fsStat(this.path).catch(() => null);
        if (pre && post && pre.mtimeMs !== post.mtimeMs) return false;
        await rename(tmp, this.path);
        return true;
      });
    } catch (e) {
      try { unlinkSync(tmp); } catch {}
      throw e;
    }

    // CAS 실패: 다른 워커가 변경 → fallback (전통적 lock+rewrite)
    if (!ok) {
      try { unlinkSync(tmp); } catch {}
      log("CAS-RETRY", `mtime changed, fallback to full lock`);
      await withLock(this.path, async () => {
        const msgs = await readInbox(this.path);
        msgs.push(...batch);
        await writeFile(this.path, JSON.stringify(msgs), "utf-8");
      });
    }

    // 로깅은 sendToLeader/sendIdleNotification에서 이미 수행
  }

  destroy() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}

// ─── Message Helpers ───
function tryParseProtocol(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && parsed.type) {
      return parsed;
    }
  } catch {
    // plain text
  }
  return null;
}

function makeMessage(from, text, color, summary) {
  return {
    from,
    text,
    timestamp: new Date().toISOString(),
    read: false,
    summary: summary || (text.length > 80 ? text.slice(0, 77) + "..." : text),
    color,
  };
}

function makeIdleNotification(agentName, opts = {}) {
  const notification = {
    type: "idle_notification",
    from: agentName,
    timestamp: new Date().toISOString(),
    idleReason: opts.idleReason || "available",
    ...(opts.summary && { summary: opts.summary }),
    ...(opts.completedTaskId && { completedTaskId: opts.completedTaskId }),
    ...(opts.completedStatus && { completedStatus: opts.completedStatus }),
    ...(opts.failureReason && { failureReason: opts.failureReason }),
  };
  return notification;
}

function makeShutdownApproved(agentName, requestId) {
  return {
    type: "shutdown_approved",
    requestId,
    from: agentName,
    timestamp: new Date().toISOString(),
    paneId: process.env.TMUX_PANE || "",
    backendType: "codex-bridge",
  };
}

// ─── tmux pane title 상태 업데이트 ───
function updatePaneTitle(agentName, status) {
  if (!process.env.TMUX) return;
  try {
    spawnSync("tmux", ["select-pane", "-T", `${agentName} [${status}]`], { stdio: "ignore", timeout: 1000 });
  } catch {}
}

// ─── tmux border-status 설정 (pane 상단에 타이틀 표시) ───
function setupPaneBorderStatus(paneId) {
  if (!paneId && !process.env.TMUX) return;
  try {
    const target = paneId ? ["-t", paneId] : [];
    spawnSync("tmux", ["set-option", "-p", ...target, "pane-border-status", "top"], { stdio: "ignore", timeout: 1000 });
    spawnSync("tmux", ["set-option", "-p", ...target, "pane-border-format", "#{pane_title}"], { stdio: "ignore", timeout: 1000 });
  } catch {}
}

// ─── tmux border-status 헤더 업데이트 (throttled) ───
let _lastBorderUpdateAt = 0;
const BORDER_UPDATE_THROTTLE_MS = 500;

function updateBorderStatus(agentName, config) {
  if (!process.env.TMUX) return;
  const now = Date.now();
  if (now - _lastBorderUpdateAt < BORDER_UPDATE_THROTTLE_MS) return;
  _lastBorderUpdateAt = now;

  const phase = renderState.currentPhase || "idle";
  const phaseTag = PHASE_LABELS[phase] || phase.toUpperCase();

  const elapsed = renderState.turnStartedAt > 0
    ? formatElapsed(Date.now() - renderState.turnStartedAt)
    : "";

  const parts = [`${agentName} [${phaseTag}]`];
  if (elapsed) parts.push(elapsed);
  if (renderState.suppressedLines > 0) parts.push(`${renderState.suppressedLines} hidden`);

  const title = truncateMiddle(parts.join(" | "), 60);
  try {
    spawnSync("tmux", ["select-pane", "-T", title], { stdio: "ignore", timeout: 1000 });
  } catch {}
}

// ─── Leader Communication ───
async function sendToLeader(config, text, summary) {
  const msg = makeMessage(config.agentName, text, config.agentColor, summary);
  if (leaderOutbox) {
    leaderOutbox.enqueue(msg);
  } else {
    const leaderInbox = getLeaderInboxPath(config.teamName);
    await writeToInbox(leaderInbox, msg);
  }
  log("SENT", summary || text.slice(0, 60));
}

async function sendToLeaderWithRetry(config, text, summary) {
  try {
    await sendToLeader(config, text, summary);
    if (leaderOutbox) await leaderOutbox.flush();
  } catch (err1) {
    log("SEND-RETRY", `first attempt failed: ${err1.message}, retrying...`);
    try {
      await sleep(500);
      await sendToLeader(config, text, summary);
      if (leaderOutbox) await leaderOutbox.flush();
    } catch (err2) {
      logAndRenderError("SEND-FAIL", `result delivery failed permanently: ${err2.message}`);
    }
  }
}

let lastIdleSentAt = 0;
const IDLE_COOLDOWN_MS = 30000;

async function sendIdleNotification(config, opts = {}) {
  // 상태 변경(완료/에러)은 항상 전송, 순수 idle 반복은 쿨다운
  const isStateChange = opts.completedStatus || opts.idleReason === "error";
  if (!isStateChange) {
    const now = Date.now();
    if (now - lastIdleSentAt < IDLE_COOLDOWN_MS) return;
    lastIdleSentAt = now;
  } else {
    lastIdleSentAt = Date.now();
  }

  const notification = makeIdleNotification(config.agentName, opts);
  const msg = makeMessage(
    config.agentName,
    JSON.stringify(notification),
    config.agentColor,
    opts.summary || "Codex worker idle"
  );
  if (leaderOutbox) {
    leaderOutbox.enqueue(msg);
    if (isStateChange) await leaderOutbox.flush();
  } else {
    const leaderInbox = getLeaderInboxPath(config.teamName);
    await writeToInbox(leaderInbox, msg);
  }
  log("IDLE", opts.summary || "waiting for next task");
  updatePaneTitle(config.agentName, "idle");
  updateBorderStatus(config.agentName);
}

async function handleShutdown(config, request) {
  log("SHUTDOWN", `reason: ${request.reason || "none"}`);
  shuttingDown = true; // #2 수정: 시그널 핸들러 재진입 방지
  const response = makeShutdownApproved(config.agentName, request.requestId);
  const leaderInbox = getLeaderInboxPath(config.teamName);
  const msg = makeMessage(
    config.agentName,
    JSON.stringify(response),
    config.agentColor,
    "Shutdown approved"
  );
  if (leaderOutbox) {
    leaderOutbox.enqueue(msg);
    await leaderOutbox.flush();
  } else {
    await writeToInbox(leaderInbox, msg);
  }
  running = false;
  closeViewer();

  // 네이티브 팀 프로토콜: config.json에서 자신을 제거 (process_shutdown_approved 역할)
  await removeSelfFromConfig(config).catch((err) => {
    log("CLEANUP-ERR", `Failed to remove self from config: ${err.message}`);
  });

  // killMyPane은 main() 최종 단계에서 호출 (session.close 이후)
}

// ─── Self-Cleanup: config.json에서 자신을 제거 ───
async function removeSelfFromConfig(config) {
  const configPath = join(TEAMS_BASE, sanitize(config.teamName), "config.json");
  if (!existsSync(configPath)) return;

  await withLock(configPath, async () => {
    const raw = await readFile(configPath, "utf-8");
    const teamConfig = JSON.parse(raw);
    const before = teamConfig.members?.length || 0;
    teamConfig.members = (teamConfig.members || []).filter(
      (m) => m.name !== config.agentName
    );
    const after = teamConfig.members.length;
    await writeFile(configPath, JSON.stringify(teamConfig, null, 2), "utf-8");
    log("CLEANUP", `removed self from config (${before} → ${after} members)`);
  });
}

function killMyPane() {
  if (process.env.TMUX_PANE) {
    try {
      // spawnSync: 모든 정리 완료 후 마지막에 호출되므로 동기 실행 안전
      spawnSync("tmux", ["kill-pane", "-t", process.env.TMUX_PANE], { stdio: "ignore", timeout: 2000 });
    } catch { /* best effort */ }
  }
}

// ─── Task Auto-Complete: 자기 이름으로 할당된 in_progress 태스크를 completed로 ───
import { readdirSync } from "node:fs";

async function markMyTasksCompleted(config) {
  const taskDir = join(TASKS_BASE, sanitize(config.teamName));
  if (!existsSync(taskDir)) return { completedTaskId: null, success: false };

  try {
    const files = readdirSync(taskDir).filter((f) => f.endsWith(".json"));
    let completedTaskId = null;
    for (const f of files) {
      const fp = join(taskDir, f);
      try {
        const raw = await readFile(fp, "utf-8");
        const task = JSON.parse(raw);
        if (task.owner === config.agentName && task.status === "in_progress") {
          task.status = "completed";
          await writeFile(fp, JSON.stringify(task, null, 2), "utf-8");
          completedTaskId = task.id || f;
          log("TASK-DONE", `marked task ${completedTaskId} as completed`);
        }
      } catch { /* skip invalid files */ }
    }
    return { completedTaskId, success: completedTaskId !== null };
  } catch (err) {
    log("TASK-ERR", err.message);
    return { completedTaskId: null, success: false };
  }
}

// ─── Codex App Server Session ───
// GPT 5.4 high 고정 — xhigh 사용 금지
const codexEffort = "high";

function truncateOutput(output) {
  if (MAX_RESULT_BYTES > 0 && output.length > MAX_RESULT_BYTES) {
    return output.slice(0, MAX_RESULT_BYTES) +
      `\n\n--- [TRUNCATED: output exceeded ${MAX_RESULT_BYTES / 1024}KB] ---`;
  }
  return output;
}

// ─── 2단계 저장: 전체 결과 → 파일, 미리보기 → inbox ───
function getResultsDir(teamName) {
  return join(TEAMS_BASE, sanitize(teamName), "results");
}

async function saveResultFile(config, output) {
  const dir = getResultsDir(config.teamName);
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${sanitize(config.agentName)}-${ts}.txt`;
  const filePath = join(dir, filename);
  await writeFile(filePath, output, "utf-8");
  return filePath;
}

function makePreview(output, filePath) {
  if (output.length <= PREVIEW_CHARS) {
    return output; // 짧으면 그대로
  }
  const preview = output.slice(0, PREVIEW_CHARS).trimEnd();
  return `${preview}\n\n... [전체 결과(${output.length}자): ${filePath}]`;
}

function formatRpcError(error) {
  if (!error) return "unknown RPC error";
  if (typeof error === "string") return error;
  const code = typeof error.code !== "undefined" ? ` (code=${error.code})` : "";
  const msg = error.message || JSON.stringify(error);
  return `${msg}${code}`;
}

class AppServerSession {
  constructor(opts) {
    this.cwd = opts.cwd;
    this.effort = opts.effort || "high";
    this.teamGoal = opts.teamGoal || null;
    this.useWebSocket = opts.useWebSocket || false;
    this.wsPort = opts.wsPort || null;
    this.ws = null;       // WebSocket 연결 (ws 모드)
    this.child = null;
    this.threadId = null;
    this.activeTurnId = null;
    this.acceptTurnStarted = false;
    this.currentTurn = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stdoutBuffer = "";
    this.startPromise = null;
    this.closed = false;
    // lifecycle 콜백
    this.onStatus = opts.onStatus || null;
    this.onError = opts.onError || null;
  }

  async ensureStarted() {
    if (this.closed) {
      throw new Error("AppServerSession is closed");
    }
    if (this.threadId && this.child) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.startInternal().finally(() => {
      this.startPromise = null;
    });
    await this.startPromise;
  }

  async startInternal() {
    const codexBin = (this.useWebSocket && findCodexAlphaBin()) || "codex";
    const args = ["app-server", "-c", `model_reasoning_effort="${this.effort}"`];
    if (this.useWebSocket && this.wsPort) {
      args.push("--listen", `ws://127.0.0.1:${this.wsPort}`);
    }
    const child = spawn(codexBin, args, {
      stdio: this.useWebSocket ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
      env: { ...process.env },
    });

    this.child = child;
    currentChild = child;

    child.stderr.setEncoding("utf8");

    if (this.useWebSocket && this.wsPort) {
      // WebSocket 모드: stderr에서 "listening on" 대기 → ws 연결
      child.stderr.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) log("APP-SERVER", text);
      });
      child.on("close", (code, signal) => this.handleClose(code, signal));
      child.on("error", (err) => this.handleFatal(err));

      // readyz 대기 후 WebSocket 연결
      const wsUrl = `ws://127.0.0.1:${this.wsPort}`;
      log("WS", `waiting for app-server on ${wsUrl}...`);
      await this.waitForReady(this.wsPort);

      const { default: WebSocket } = await import("ws");
      const ws = new WebSocket(wsUrl);
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
        setTimeout(() => reject(new Error("WebSocket connect timeout")), 10000);
      });
      this.ws = ws;
      ws.on("message", (data) => {
        const text = String(data);
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            this.handleRpcMessage(JSON.parse(line));
          } catch {
            log("WS", `non-JSON: ${line.slice(0, 120)}`);
          }
        }
      });
      ws.on("close", () => {
        log("WS", "WebSocket closed");
        this.ws = null;
      });
      ws.on("error", (err) => log("WS", `error: ${err.message}`));
      log("WS", "connected to app-server");
    } else {
      // stdio 모드 (기존)
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this.handleStdout(chunk));
      child.stderr.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) {
          log("APP-SERVER", text);
          this.onError?.("APP-SERVER", text);
        }
      });
      child.on("close", (code, signal) => this.handleClose(code, signal));
      child.on("error", (err) => this.handleFatal(err));
    }

    try {
      const initResult = await this.sendRequest("initialize", {
        clientInfo: { name: "codex-bridge", version: "0.1.0" },
      });
      this.sendNotification("initialized", {});

      const threadStartParams = {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        cwd: this.cwd,
        // model은 Codex 자체 설정 사용 (Claude 모델명 전달 방지)
        baseInstructions: buildBaseInstructions(this.teamGoal),
      };

      const started = await this.sendRequest("thread/start", threadStartParams);
      this.threadId = started?.thread?.id || null;
      if (!this.threadId) {
        throw new Error("thread/start returned no thread id");
      }

      // Store REAL session info from app-server responses
      sessionInfo = {
        userAgent: initResult?.userAgent || initResult?.user_agent || "",
        model: started?.model || "",
        modelProvider: started?.modelProvider || started?.model_provider || "",
        serviceTier: started?.serviceTier || started?.service_tier || null,
        approvalPolicy: started?.approvalPolicy || started?.approval_policy || "never",
        sandbox: started?.sandbox || { type: "danger-full-access" },
        cwd: started?.cwd || this.cwd,
        reasoningEffort: started?.reasoningEffort || started?.reasoning_effort || null,
      };
      log("SESSION", `real info: model=${sessionInfo.model} provider=${sessionInfo.modelProvider} ua=${sessionInfo.userAgent}`);
      this.onStatus?.("session ready");
    } catch (err) {
      if (this.child === child) {
        log("STARTUP-FAIL", `cleaning up child (pid=${child.pid}): ${err.message}`);
        this.onError?.("STARTUP-FAIL", err.message);
        child.kill("SIGTERM");
        this.child = null;
        currentChild = null;
        this.threadId = null;
      }
      throw err;
    }
  }

  async waitForReady(port, timeoutMs = 15000) {
    const { request } = await import("node:http");
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await new Promise((resolve) => {
        const req = request(`http://127.0.0.1:${port}/readyz`, { timeout: 1000 }, (res) => {
          resolve(res.statusCode === 200);
        });
        req.on("error", () => resolve(false));
        req.end();
      });
      if (ok) return;
      await sleep(200);
    }
    throw new Error(`app-server readyz timeout (${timeoutMs}ms)`);
  }

  sendRaw(message) {
    const json = JSON.stringify(message);
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(json);
      return;
    }
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      throw new Error("app-server process is not writable");
    }
    this.child.stdin.write(`${json}\n`);
  }

  sendNotification(method, params = {}) {
    this.sendRaw({
      jsonrpc: "2.0",
      method,
      params,
    });
  }

  sendResponse(id, result) {
    this.sendRaw({
      jsonrpc: "2.0",
      id,
      result,
    });
  }

  sendError(id, code, message) {
    this.sendRaw({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }

  sendRequest(method, params = {}) {
    const id = this.nextId++;
    const RPC_TIMEOUT_MS = 30000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC timeout (${RPC_TIMEOUT_MS}ms) for ${method}`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        method,
      });
      try {
        this.sendRaw({
          jsonrpc: "2.0",
          id,
          method,
          params,
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += String(chunk);
    let start = 0;
    while (true) {
      const idx = this.stdoutBuffer.indexOf("\n", start);
      if (idx < 0) break;
      const line = this.stdoutBuffer.slice(start, idx).trim();
      start = idx + 1;
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        log("APP-SERVER", `non-JSON output: ${line.slice(0, 120)}`);
        continue;
      }

      this.handleRpcMessage(msg);
    }
    if (start > 0) {
      this.stdoutBuffer = this.stdoutBuffer.slice(start);
    }
  }

  handleRpcMessage(msg) {
    if (typeof msg?.id !== "undefined" && typeof msg?.method === "string") {
      void this.handleServerRequest(msg);
      return;
    }

    if (typeof msg?.id !== "undefined" && ("result" in msg || "error" in msg)) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if ("error" in msg) {
        pending.reject(new Error(formatRpcError(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (typeof msg?.method === "string") {
      this.handleNotification(msg.method, msg.params || {});
    }
  }

  async handleServerRequest(msg) {
    try {
      switch (msg.method) {
        case "item/commandExecution/requestApproval":
          this.sendResponse(msg.id, { decision: "accept" });
          return;
        case "item/fileChange/requestApproval":
          this.sendResponse(msg.id, { decision: "accept" });
          return;
        case "execCommandApproval":
          this.sendResponse(msg.id, { decision: "approved" });
          return;
        case "applyPatchApproval":
          this.sendResponse(msg.id, { decision: "approved" });
          return;
        default:
          // full-auto 모드: 미지 승인 요청도 기본 accept (새 Codex 버전 호환)
          log("APPROVAL", `auto-accepting unknown server request: ${msg.method}`);
          this.sendResponse(msg.id, { decision: "accept" });
      }
    } catch (err) {
      this.sendError(msg.id, -32603, `Approval handler error: ${err.message}`);
    }
  }

  handleNotification(method, params) {
    if (!params) return;

    // ★ Pane 렌더러: 모든 notification을 ANSI 시각 피드백으로 출력
    renderNotification(method, params);

    if (method === "turn/started") {
      if (!this.currentTurn || !this.acceptTurnStarted) {
        log("TURN-LATE", `ignoring late turn/started (acceptTurnStarted=${this.acceptTurnStarted})`);
        return;
      }
      const turnId = params.turn?.id;
      if (turnId) {
        this.activeTurnId = turnId;
        if (this.currentTurn && !this.currentTurn.turnId) {
          this.currentTurn.turnId = turnId;
        }
      }
      this.acceptTurnStarted = false;
      this.onStatus?.("turn started");
      return;
    }

    if (method === "item/agentMessage/delta") {
      const current = this.currentTurn;
      if (!current) return;
      if (current.turnId && params.turnId !== current.turnId) return;
      if (typeof params.delta === "string") {
        current.chunks.push(params.delta);
        if (params.itemId) current.itemsWithDelta.add(params.itemId);
      }
      if (!current.turnId && params.turnId) {
        current.turnId = params.turnId;
      }
      return;
    }

    if (method === "item/completed") {
      const current = this.currentTurn;
      if (!current) return;
      if (current.turnId && params.turnId !== current.turnId) return;
      const item = params.item;
      if (item?.type === "agentMessage" && typeof item.text === "string") {
        if (!current.itemsWithDelta.has(item.id)) {
          current.chunks.push(item.text);
        }
      }
      if (!current.turnId && params.turnId) {
        current.turnId = params.turnId;
      }
      return;
    }

    if (method === "turn/completed") {
      const turn = params.turn || {};
      const completedTurnId = turn.id || null;
      if (completedTurnId && this.activeTurnId === completedTurnId) {
        this.activeTurnId = null;
      }

      const current = this.currentTurn;
      if (!current) return;
      if (current.turnId && completedTurnId && current.turnId !== completedTurnId) return;
      if (!current.turnId && completedTurnId) {
        current.turnId = completedTurnId;
      }

      this.acceptTurnStarted = false;
      this.currentTurn = null;
      const output = truncateOutput(current.chunks.join(""));
      if (turn.status === "completed" || turn.status === "interrupted") {
        current.resolve({
          success: true,
          output: output || "(no output)",
        });
      } else {
        const reason = turn.error?.message || `Turn ended with status ${turn.status || "unknown"}`;
        current.resolve({
          success: false,
          output: output || reason,
        });
      }
    }
  }

  handleFatal(err) {
    const error = new Error(`Codex app-server error: ${err.message}`);
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
    if (this.currentTurn) {
      this.currentTurn.reject(error);
      this.currentTurn = null;
    }
    this.acceptTurnStarted = false;
    this.threadId = null;
    this.activeTurnId = null;
    if (viewerProc) viewerProc._sessionSent = false;
  }

  handleClose(code, signal) {
    currentChild = null;
    this.child = null;
    this.stdoutBuffer = "";
    if (viewerProc) viewerProc._sessionSent = false;
    const reason = signal
      ? `Codex app-server exited via signal ${signal}`
      : `Codex app-server exited with code ${code}`;
    const error = new Error(reason);

    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();

    if (this.currentTurn) {
      this.currentTurn.reject(error);
      this.currentTurn = null;
    }
    this.acceptTurnStarted = false;
    this.threadId = null;
    this.activeTurnId = null;
  }

  async runTurn(prompt) {
    await this.ensureStarted();
    if (!this.threadId) {
      throw new Error("app-server thread is not initialized");
    }

    // 활성 turn이 있으면 steer로 이어 붙인다.
    if (this.currentTurn) {
      const activeTurnId = this.activeTurnId || this.currentTurn.turnId;
      if (!activeTurnId) {
        throw new Error("active turn exists but turn id is unknown");
      }
      await this.sendRequest("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: activeTurnId,
        input: [{ type: "text", text: `[STEER — 리더로부터 실시간 메시지]\n${prompt}` }],
      });
      return;
    }

    const turnState = {
      turnId: null,
      chunks: [],
      itemsWithDelta: new Set(),
      resolve: null,
      reject: null,
      completion: null,
    };
    turnState.completion = new Promise((resolve, reject) => {
      turnState.resolve = resolve;
      turnState.reject = reject;
    });
    this.currentTurn = turnState;

    try {
      this.acceptTurnStarted = true;
      const started = await this.sendRequest("turn/start", {
        threadId: this.threadId,
        effort: this.effort,
        input: [{ type: "text", text: prompt }],
      });
      const turnId = started?.turn?.id;
      if (turnId) {
        this.activeTurnId = turnId;
        if (!turnState.turnId) {
          turnState.turnId = turnId;
        }
      }
      // acceptTurnStarted is consumed by the turn/started notification handler.
      // Keep it true here until turn/started arrives or the turn is otherwise cleaned up.
    } catch (err) {
      this.acceptTurnStarted = false;
      this.activeTurnId = null;
      if (this.currentTurn === turnState) {
        this.currentTurn = null;
      }
      throw err;
    }

    return turnState.completion;
  }

  async interruptActiveTurn() {
    if (!this.child || !this.threadId) return false;
    const turnId = this.activeTurnId || this.currentTurn?.turnId;
    if (!turnId) return false;
    try {
      await this.sendRequest("turn/interrupt", {
        threadId: this.threadId,
        turnId,
      });
      return true;
    } catch (err) {
      log("INTERRUPT-FAIL", err.message);
      return false;
    }
  }

  async close() {
    this.closed = true;
    await this.interruptActiveTurn().catch(() => {});
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }
}

// ─── Main Poll Loop (Phase 2: 양방향 — 턴 실행 중에도 inbox 폴링) ───
async function pollLoop(config) {
  const myInbox = getInboxPath(config.agentName, config.teamName);
  await ensureInbox(myInbox);
  currentPollMs = POLL_INTERVAL_MS;

  // ─── Leader Outbox 초기화 ───
  leaderOutbox = new LeaderOutbox(getLeaderInboxPath(config.teamName));

  // lifecycle 상태 이벤트: 리더에게 중간 진행 보고
  let lastStatusSentAt = 0;
  const STATUS_COOLDOWN_MS = 3000;
  function emitStatus(status) {
    const now = Date.now();
    if (now - lastStatusSentAt < STATUS_COOLDOWN_MS) return;
    lastStatusSentAt = now;
    sendToLeader(config, `[STATUS] ${status}`, status).catch(() => {});
    updateBorderStatus(config.agentName);
    // 네이티브 TUI 모드: bridge pane 1줄에 상태 표시
    if (nativeTuiPaneId) {
      const label = `\x1b[1;36m ${config.agentName} \x1b[0m \x1b[33m${status}\x1b[0m`;
      process.stderr.write(`\r\x1b[2K${label}`);
    }
  }

  // Goal Context: 팀 config.json에서 목적(description) 읽기
  const teamGoal = readTeamGoal(sanitize(config.teamName));
  if (teamGoal) {
    log("GOAL", `team goal: ${teamGoal.slice(0, 100)}`);
  }

  const session = new AppServerSession({
    cwd: process.cwd(),
    effort: codexEffort,
    teamGoal,
    useWebSocket: !!config._useNativeTui,
    wsPort: wsPort,
    onStatus: (status) => {
      emitStatus(status);
      // 네이티브 TUI: session ready 시점에 tmux pane 스폰 (threadId로 resume)
      if (config._useNativeTui && status === "session ready" && !nativeTuiPaneId && wsPort) {
        spawnNativeTuiPane(config.agentName, wsPort, session.threadId);
      }
    },
    onError: (tag, msg) => {
      logAndRenderError(tag, msg);
      sendToLeader(config, `[ERROR] [${tag}] ${msg}`, `Error: ${tag}`).catch(() => {});
    },
  });

  log("POLL", `inbox: ${myInbox}`);

  // ─── fs.watch 기반 inbox 감시 (polling fallback 겸용) ───
  const inboxDir = join(myInbox, "..");
  const inboxBasename = basename(myInbox);
  let watchResolve = null;
  let fsWatcher = null;
  try {
    fsWatcher = fsWatch(inboxDir, { persistent: false }, (eventType, filename) => {
      // 내 inbox 파일 변경에만 반응 (thundering herd 방지)
      if (filename && filename !== inboxBasename) return;
      if (watchResolve) {
        const r = watchResolve;
        watchResolve = null;
        r();
      }
    });
    fsWatcher.on("error", (err) => {
      logAndRenderError("WATCH-ERR", `${err.message}, falling back to polling`);
      sendToLeader(config, `[ERROR] [WATCH-ERR] ${err.message}`, "Watch error").catch(() => {});
      try { fsWatcher.close(); } catch {}
      fsWatcher = null;
    });
    log("WATCH", `fs.watch active on ${inboxDir}`);
  } catch (err) {
    log("WATCH-FALLBACK", `fs.watch unavailable: ${err.message}`);
  }

  function waitForInboxChange(timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      if (fsWatcher) {
        watchResolve = () => { clearTimeout(timer); resolve(); };
      }
    });
  }

  // 활성 턴의 완료를 추적하는 promise (null = 유휴 상태)
  let activeTurnPromise = null;
  // steer 직렬화 체인 + 실패 시 보관 큐
  let steerChain = Promise.resolve();
  let pendingSteerQueue = [];
  const MAX_PENDING_STEERS = 32;
  function enqueuePendingSteer(text) {
    if (pendingSteerQueue.length >= MAX_PENDING_STEERS) {
      const dropped = pendingSteerQueue.shift();
      logAndRenderError("STEER-DROP", `queue full (${MAX_PENDING_STEERS}), dropped oldest (len=${dropped.length})`);
      sendToLeader(config, `[WARN] steer queue full (${MAX_PENDING_STEERS}), dropped oldest message (len=${dropped.length}). Messages may be lost.`, "Steer queue overflow").catch(() => {});
    }
    pendingSteerQueue.push(text);
  }

  // 메시지 중복 처리 방지 (content hash + 시간 기반)
  const DEDUP_MAX = 100;
  const DEDUP_TTL_MS = 60_000; // 60초 후 만료
  const recentMessageHashes = new Map(); // hash → timestamp
  const recentMessageOrder = []; // { hash, ts } FIFO
  function makeMessageHash(msg) {
    // from + text 앞부분으로 경량 해시 생성
    const key = `${msg.from}|${msg.text.slice(0, 512)}`;
    let h = 0;
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }
  function isDuplicateMessage(msg) {
    const now = Date.now();
    // 만료된 항목 정리
    while (recentMessageOrder.length > 0 && (now - recentMessageOrder[0].ts > DEDUP_TTL_MS || recentMessageOrder.length > DEDUP_MAX)) {
      const old = recentMessageOrder.shift();
      recentMessageHashes.delete(old.hash);
    }
    const hash = makeMessageHash(msg);
    if (recentMessageHashes.has(hash)) return true;
    recentMessageHashes.set(hash, now);
    recentMessageOrder.push({ hash, ts: now });
    return false;
  }

  // 턴 완료 핸들러: 결과를 리더에게 전송
  async function handleTurnResult(result) {
    activeTurnPromise = null;
    steerChain = Promise.resolve();
    if (!running) return;

    if (pendingSteerQueue.length > 0) {
      const queued = pendingSteerQueue.splice(0);
      const fullPrompt = queued.join("\n\n---\n\n");
      log("STEER-AUTODRAIN", `draining ${queued.length} queued messages into new turn`);
      try {
        activeTurnPromise = session.runTurn(fullPrompt);
        activeTurnPromise.then(handleTurnResult, handleTurnError);
      } catch (err) {
        handleTurnError(err);
      }
      return;
    }

    updatePaneTitle(config.agentName, result.success ? "done" : "error");
    updateBorderStatus(config.agentName);

    // 결과 summary에 첫 줄 키워드 포함 (구분 용이)
    const summaryHint = result.output
      ? result.output.split("\n").find((l) => l.trim())?.slice(0, 60) || ""
      : "";

    if (result.success) {
      // 2단계 저장: 전체 → 파일, 미리보기 → inbox
      const filePath = await saveResultFile(config, result.output).catch((e) => {
        logAndRenderError("SAVE-ERR", `result file save failed: ${e.message}`);
        return null;
      });
      const msg = filePath
        ? makePreview(result.output, filePath)
        : result.output;
      const summary = summaryHint ? `Done: ${summaryHint}` : "Codex task completed";
      // await로 결과 전송 완료 후 idle 전송 (순서 보장)
      await sendToLeaderWithRetry(config, msg, summary);
      if (shutdownRequested) return;
      // 태스크 완료를 먼저 마킹한 후 idle 전송 (순서 보장으로 재스케줄링 방지)
      const taskResult = await markMyTasksCompleted(config);
      if (shutdownRequested) return;
      if (taskResult.success) {
        sendIdleNotification(config, {
          summary: "Task completed, ready for next",
          completedStatus: "completed",
        }).catch(() => {});
      } else {
        sendIdleNotification(config, {
          summary: "Task completed, ready for next",
          completedStatus: "available",
        }).catch(() => {});
      }
    } else {
      const fullErr = `[ERROR] Codex failed:\n${result.output}`;
      const filePath = await saveResultFile(config, fullErr).catch(() => null);
      const errMsg = filePath
        ? makePreview(fullErr, filePath)
        : fullErr;
      const summary = summaryHint ? `Failed: ${summaryHint}` : "Codex task failed";
      // await로 결과 전송 완료 후 idle 전송 (순서 보장)
      await sendToLeaderWithRetry(config, errMsg, summary);
      if (shutdownRequested) return;
      sendIdleNotification(config, {
        idleReason: "error",
        summary: "Task failed",
        failureReason: result.output.slice(0, 200),
      }).catch(() => {});
    }
  }

  async function handleTurnError(err) {
    activeTurnPromise = null;
    steerChain = Promise.resolve();
    if (!running || shutdownRequested) return;

    if (pendingSteerQueue.length > 0) {
      const queued = pendingSteerQueue.splice(0);
      const fullPrompt = queued.join("\n\n---\n\n");
      log("STEER-AUTODRAIN", `draining ${queued.length} queued messages after error`);
      try {
        activeTurnPromise = session.runTurn(fullPrompt);
        activeTurnPromise.then(handleTurnResult, handleTurnError);
      } catch (e) {
        handleTurnError(e);
      }
      return;
    }

    updatePaneTitle(config.agentName, "error");
    updateBorderStatus(config.agentName);

    const fullErr = `[ERROR] Codex app-server error: ${err.message}`;
    const filePath = await saveResultFile(config, fullErr).catch(() => null);
    const errMsg = filePath
      ? makePreview(fullErr, filePath)
      : fullErr;
    const errSummary = `Failed: ${err.message.slice(0, 50)}`;
    await sendToLeaderWithRetry(config, errMsg, errSummary);
    if (shutdownRequested) return;
    sendIdleNotification(config, {
      idleReason: "error",
      summary: "Task failed",
      failureReason: err.message.slice(0, 200),
    }).catch(() => {});
  }

  try {
    while (running) {
      const unread = await claimUnreadMessages(myInbox);
      let sawMessages = false;

      if (unread.length > 0) {
        sawMessages = true;
        currentPollMs = POLL_ACTIVE_MS;

        for (const { msg } of unread) {
          if (!running) break;

          const protocol = tryParseProtocol(msg.text);

          // shutdown_request 처리: 즉시 플래그 설정 후 활성 턴 완료 대기
          if (protocol?.type === "shutdown_request") {
            running = false;
            shutdownRequested = true;
            pendingSteerQueue.length = 0;
            if (activeTurnPromise) {
              log("SHUTDOWN", "waiting for active turn to complete (max 5s)...");
              const race = await Promise.race([
                activeTurnPromise.then(() => "done"),
                sleep(5000).then(() => "timeout"),
              ]).catch(() => "error");
              if (race === "timeout") {
                log("SHUTDOWN", "timeout — interrupting active turn");
                // #4 수정: interrupt도 5초 제한 (기존 RPC 30초 대기 방지)
                await Promise.race([
                  session.interruptActiveTurn(),
                  sleep(5000),
                ]).catch(() => {});
                await sleep(500);
              }
            }
            await handleShutdown(config, protocol);
            return;
          }

          // 프로토콜 메시지 스킵
          if (protocol?.type === "permission_request") {
            log("SKIP", "permission_request (Codex uses own sandbox)");
            continue;
          }
          if (protocol?.type === "mode_set_request") {
            log("SKIP", `mode_set_request: ${protocol.mode}`);
            continue;
          }
          if (protocol?.type === "idle_notification") {
            log("SKIP", "idle_notification from leader");
            continue;
          }

          // 메시지 중복 처리 방지 (동일 메시지 재전송 감지)
          if (isDuplicateMessage(msg)) {
            log("DEDUP", `skipping duplicate message from=${msg.from}, len=${msg.text.length}`);
            continue;
          }

          const taskText = msg.text;

          // ★ Phase 2 핵심: 활성 턴이 있으면 steer, 없으면 새 턴
          if (activeTurnPromise) {
            if (session.currentTurn) {
              // 양방향: 실행 중인 Codex에 실시간 메시지 주입
              log("STEER", `injecting mid-turn message, len=${taskText.length}`);
              // steer는 직렬화: 이전 steer 완료 후 다음 steer 전송
              steerChain = steerChain.then(async () => {
                if (!session.currentTurn) {
                  enqueuePendingSteer(taskText);
                  log("STEER-DEFERRED", `turn ended, queued for next turn (${pendingSteerQueue.length} pending)`);
                  return;
                }
                try {
                  await session.runTurn(taskText);
                } catch (steerErr) {
                  logAndRenderError("STEER-ERR", steerErr.message);
                  // steer 실패 시 pendingSteerQueue에 보관 → 다음 턴에서 처리
                  enqueuePendingSteer(taskText);
                  logAndRender("STEER-QUEUED", `queued for next turn (${pendingSteerQueue.length} pending)`);
                }
              }).catch(() => {});
            } else {
              log("STEER-STARTING", `turn starting, queuing message (len=${taskText.length})`);
              enqueuePendingSteer(taskText);
            }
          } else {
            // 유휴 상태: 새 턴 시작 (비동기 — 블로킹하지 않음!)
            // pendingSteerQueue에 실패한 steer가 있으면 본문에 포함
            let fullPrompt = taskText;
            // Goal Context: 첫 턴에 팀 목적을 프롬프트에 포함
            if (teamGoal && !session.threadId) {
              fullPrompt = `[GOAL] ${teamGoal}\n\n${fullPrompt}`;
            }
            if (pendingSteerQueue.length > 0) {
              const queued = pendingSteerQueue.splice(0);
              log("STEER-DRAIN", `draining ${queued.length} queued steer messages into new turn`);
              fullPrompt = [fullPrompt, ...queued].join("\n\n---\n\n");
            }
            log("TASK", `from=${msg.from}, len=${fullPrompt.length}`);
            // 리더에게 작업 수락 ack 전송 (비동기, 블로킹 안 함)
            const coldStart = !session.threadId;
            const ackMsg = coldStart
              ? `[STATUS] task accepted, starting codex app-server...`
              : `[STATUS] task accepted (len=${fullPrompt.length})`;
            sendToLeader(config, ackMsg, coldStart ? "Cold start..." : "Task accepted").catch(() => {});
            updatePaneTitle(config.agentName, coldStart ? "starting" : "busy");
            updateBorderStatus(config.agentName);
            try {
              activeTurnPromise = session.runTurn(fullPrompt);
              activeTurnPromise.then(handleTurnResult, handleTurnError);
            } catch (err) {
              handleTurnError(err);
            }
          }
        }
      }

      if (running) {
        if (fsWatcher) {
          // fs.watch: 이벤트 대기 + fallback timeout
          await waitForInboxChange(sawMessages ? POLL_ACTIVE_MS : POLL_FALLBACK_MS);
        } else {
          // fallback: adaptive polling (기존 동작)
          if (!sawMessages) {
            currentPollMs = Math.min(currentPollMs * 2, POLL_IDLE_MS);
          }
          await sleep(currentPollMs);
        }
      }
    }
  } finally {
    // fs.watch 정리
    if (fsWatcher) {
      try { fsWatcher.close(); } catch {}
      fsWatcher = null;
    }
    // outbox flush + 정리
    if (leaderOutbox) {
      await leaderOutbox.flush().catch(() => {});
      leaderOutbox.destroy();
      leaderOutbox = null;
    }
    // 활성 턴이 있으면 완료를 잠시 기다려본다
    if (activeTurnPromise) {
      await Promise.race([activeTurnPromise, sleep(2000)]).catch(() => {});
    }
    await session.close().catch(() => {});
  }
}

// ─── Signal Handlers ───
let shuttingDown = false;

function setupSignalHandlers(config) {
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, async () => {
      if (shuttingDown) {
        // #2 수정: 이미 종료 중이면 즉시 강제 종료
        log("SIGNAL", `${sig} received during shutdown — force exit`);
        closeViewer();
        closeLogFile();
        killMyPane();
        process.exit(1);
        return;
      }
      shuttingDown = true;
      log("SIGNAL", sig);
      running = false;
      // #2 수정: 5초 내 종료 못 하면 강제 종료
      const forceTimer = setTimeout(() => {
        log("SIGNAL", "force exit after 5s timeout");
        closeViewer();
        closeLogFile();
        killMyPane();
        process.exit(1);
      }, 5000);
      forceTimer.unref();
      if (currentChild) {
        currentChild.kill("SIGTERM");
      }
      try {
        await sendIdleNotification(config, {
          idleReason: "terminated",
          summary: `Terminated by ${sig}`,
        });
      } catch {
        // best effort
      }
      // 시그널 종료 시에도 config.json에서 자신 제거
      await removeSelfFromConfig(config).catch(() => {});
      closeViewer();
      closeLogFile();
      killMyPane();
      process.exit(sig === "SIGTERM" ? 0 : 1);
    });
  }
}

// ─── Claude Passthrough ───
// 에이전트 이름이 "claude-"로 시작하면 원래 Claude Code 바이너리로 패스스루
function passthroughToClaude() {
  const claudeBin = process.env.CLAUDE_BIN
    || spawnSync("which", ["claude"], { encoding: "utf8", timeout: 3000 }).stdout?.trim()
    || join(homedir(), ".local", "bin", "claude");
  const originalArgs = process.argv.slice(2);
  log("PASSTHROUGH", `Forwarding to Claude Code: ${claudeBin}`);

  // 스폰 후 리더 pane으로 포커스 자동 복원
  try {
    spawn("tmux", ["select-pane", "-l"], { stdio: "ignore", detached: true }).unref();
  } catch { /* tmux 없는 환경에서는 무시 */ }

  const child = spawn(claudeBin, [...originalArgs, "--effort", "high"], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: { ...process.env, CLAUDE_CODE_TEAMMATE_COMMAND: "" }, // bridge 재귀 방지
  });

  const forwardSignal = (sig) => {
    if (!child.killed) {
      child.kill(sig);
    }
  };
  const cleanupSignalHandlers = () => {
    process.removeListener("SIGTERM", forwardSignal);
    process.removeListener("SIGINT", forwardSignal);
  };

  process.on("SIGTERM", forwardSignal);
  process.on("SIGINT", forwardSignal);

  child.on("close", (code) => {
    cleanupSignalHandlers();
    killMyPane();
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    cleanupSignalHandlers();
    console.error("[codex-bridge] Claude passthrough error:", err);
    killMyPane();
    process.exit(1);
  });
}

// ─── Entry Point ───
async function main() {
  const config = parseArgs(process.argv);

  if (!config.agentName || !config.teamName) {
    console.error("Usage: codex-bridge.mjs --agent-name NAME --team-name TEAM");
    console.error("Received args:", process.argv.slice(2).join(" "));
    process.exit(1);
  }

  // 라우팅: codex-* → 항상 Codex, claude-* → Claude, 그 외 → 모델명으로 판단
  if (!config.agentName.startsWith("codex-")) {
    const modelLower = typeof config.model === "string" ? config.model.toLowerCase() : "";
    const isClaudeModel = /claude|sonnet|opus|haiku/i.test(modelLower);
    if (config.agentName.startsWith("claude-") || isClaudeModel) {
      return passthroughToClaude();
    }
  }

  log("INIT", `${config.agentName}@${config.teamName} (color=${config.agentColor})`);
  log("INFO", `cwd=${process.cwd()}`);
  log("INFO", `pid=${process.pid}`);

  // tmux pane title 설정 (워커명 표시)
  if (process.env.TMUX) {
    try {
      spawnSync("tmux", ["select-pane", "-T", `${config.agentName} [idle]`], { stdio: "ignore", timeout: 2000 });
    } catch {}
    setupPaneBorderStatus(); // pane 상단 border에 타이틀 표시
  }
  _borderAgentName = config.agentName;

  // ─── 네이티브 Codex TUI 자동 감지 ───
  // 1. CODEX_BRIDGE_NATIVE_TUI=1 → 강제 활성화
  // 2. codex 0.117+ → 자동 활성화
  // 3. codex-alpha 바이너리 존재 → 자동 활성화
  // 4. CODEX_BRIDGE_NATIVE_TUI=0 → 강제 비활성화
  const nativeTuiBin = findCodexAlphaBin();
  const codexVersion = getCodexVersion();
  const codexSupportsNativeTui = codexVersion && (() => {
    const m = codexVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return false;
    const [, major, minor] = m.map(Number);
    return major > 0 || minor >= 117;
  })();
  const useNativeTui = process.env.CODEX_BRIDGE_NATIVE_TUI !== "0"
    && process.env.TMUX
    && (process.env.CODEX_BRIDGE_NATIVE_TUI === "1" || codexSupportsNativeTui || nativeTuiBin);
  log("TUI-DETECT", `codex=${codexVersion || "?"}, alpha=${nativeTuiBin || "none"}, native=${useNativeTui}`);
  if (useNativeTui) {
    wsPort = await getRandomPort();
    log("NATIVE-TUI", `WebSocket mode enabled, port=${wsPort}, bin=${nativeTuiBin}`);
    // 네이티브 TUI pane은 app-server ready 후 스폰 (pollLoop 진입 전)
    config._useNativeTui = true;
  }

  // TUI 뷰어: 기본 비활성 (ANSI fallback)
  // CODEX_BRIDGE_TUI=1로 Ink 뷰어, CODEX_BRIDGE_NATIVE_TUI=1로 네이티브 TUI
  if (!useNativeTui && process.env.CODEX_BRIDGE_TUI === "1") {
    if (process.env.TMUX) {
      viewerProc = spawnTuiTmuxPane(config.agentName);
      if (!viewerProc) {
        log("TUI", "tmux pane spawn failed, falling back to ANSI");
      }
    } else {
      viewerProc = spawnTuiViewer(config.agentName);
    }
  } else if (!useNativeTui) {
    // ANSI fallback (기본값) — bridge pane에서 직접 렌더링
    log("TUI", "using ANSI fallback (default)");
    if (process.env.TMUX) {
      try {
        spawn("tmux", ["select-pane", "-l"], { stdio: "ignore", detached: true }).unref();
      } catch {}
    }
  }

  // ANSI 출력이 stderr로 가므로 항상 로그 파일로 분리
  initLogFile(config.agentName);

  setupSignalHandlers(config);
  await pollLoop(config);

  log("EXIT", "bridge shutting down");
  closeNativeTuiPane();
  closeViewer();
  closeLogFile();
  // 리더가 shutdown_approved를 읽을 시간 확보 후 pane 종료
  await sleep(2000);
  killMyPane();
  process.exit(0);
}

main().catch((err) => {
  const msg = err?.message || String(err);
  console.error("[codex-bridge] Fatal:", msg);
  logAndRenderError("FATAL", msg);
  closeViewer();
  closeLogFile();
  process.exit(1);
});
