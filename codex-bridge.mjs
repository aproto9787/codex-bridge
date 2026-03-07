#!/usr/bin/env node
// codex-bridge.mjs — Codex CLI를 Claude Code 네이티브 팀원으로 동작시키는 래퍼
// zero-dependency (Node.js 내장 모듈만 사용)

import { readFile, writeFile, mkdir, rmdir, rename, stat as fsStat } from "node:fs/promises";
import { existsSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";

// ─── Constants ───
const POLL_INTERVAL_MS = 500;
const POLL_IDLE_MS = 2000;
const POLL_ACTIVE_MS = 100;
const SHUTDOWN_POLL_MS = 3000;
const MAX_RESULT_BYTES = 5 * 1024 * 1024; // 5MB
const TEAMS_BASE = join(homedir(), ".claude", "teams");
const TASKS_BASE = join(homedir(), ".claude", "tasks");
const LEADER_NAME = "team-lead";

let running = true;
let currentChild = null;
let viewerProc = null;
let logStream = null;
// Real session info from app-server (populated after thread/start)
let sessionInfo = null;
let lastInboxMtime = 0;
let currentPollMs = POLL_INTERVAL_MS;

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

// 현재 렌더링 상태 (스트리밍 모드 추적)
const renderState = {
  mode: "idle", // "idle" | "agent" | "exec" | "file" | "reasoning"
  lastItemId: null,
  lastTokenTotal: 0,
  lastCmd: null, // 현재 실행 중인 명령어 정보
  headerPrinted: false, // 세션 헤더 출력 여부
};

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
function renderLabel(label) {
  renderWrite(`${ANSI.bold}${ANSI.cyan}${label}${ANSI.reset}\n`);
}

function renderSessionHeader() {
  if (renderState.headerPrinted) return;
  renderState.headerPrinted = true;
  renderWrite(`${ANSI.dim}--------${ANSI.reset}\n`);
}

function renderNotificationANSI(method, params) {
  if (!params) return;

  switch (method) {
    // ── 턴 시작 ──
    case "turn/started": {
      endStreamMode();
      renderSessionHeader();
      break;
    }

    // ── 턴 완료 ──
    case "turn/completed": {
      endStreamMode();
      const turn = params.turn || {};
      const status = turn.status || "unknown";
      if (renderState.lastTokenTotal > 0) {
        renderWrite(`${ANSI.bold}tokens used${ANSI.reset}\n`);
        renderWrite(`${renderState.lastTokenTotal.toLocaleString()}\n`);
      }
      renderWrite(`${ANSI.dim}--------${ANSI.reset}\n`);
      if (status !== "completed") {
        renderWrite(`${ANSI.red}turn ${status}${ANSI.reset}\n`);
      }
      renderState.headerPrinted = false;
      break;
    }

    // ── 에이전트 메시지 스트리밍 ──
    case "item/agentMessage/delta": {
      if (renderState.mode !== "agent" || renderState.lastItemId !== params.itemId) {
        endStreamMode();
        renderLabel("codex");
        renderState.mode = "agent";
        renderState.lastItemId = params.itemId;
      }
      renderWrite(params.delta || "");
      break;
    }

    // ── 명령 실행 출력 (스트리밍) ──
    case "item/commandExecution/outputDelta": {
      if (renderState.mode !== "exec" || renderState.lastItemId !== params.itemId) {
        endStreamMode();
        renderState.mode = "exec";
        renderState.lastItemId = params.itemId;
      }
      renderWrite(params.delta || "");
      break;
    }

    // ── 파일 변경 출력 ──
    case "item/fileChange/outputDelta": {
      if (renderState.mode !== "file" || renderState.lastItemId !== params.itemId) {
        endStreamMode();
        renderState.mode = "file";
        renderState.lastItemId = params.itemId;
      }
      renderWrite(`${ANSI.yellow}${params.delta || ""}${ANSI.reset}`);
      break;
    }

    // ── 추론 요약 스트리밍 ──
    case "item/reasoning/summaryTextDelta": {
      if (renderState.mode !== "reasoning" || renderState.lastItemId !== params.itemId) {
        endStreamMode();
        renderWrite(`${ANSI.dim}${ANSI.italic}`);
        renderState.mode = "reasoning";
        renderState.lastItemId = params.itemId;
      }
      renderWrite(params.delta || "");
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
        // exec 헤더는 item/completed에서 결과와 함께 출력 (Codex 스타일)
      } else if (item.type === "fileChange") {
        endStreamMode();
        const files = (item.changes || []).map((c) => c.path || c.file || "").filter(Boolean);
        renderLabel("patch");
        if (files.length > 0) {
          renderWrite(`${files.join(", ")}\n`);
        }
      } else if (item.type === "webSearch") {
        endStreamMode();
        renderLabel("web search");
        renderWrite(`${item.query || ""}\n`);
      }
      break;
    }

    // ── 아이템 완료 ──
    case "item/completed": {
      const item = params.item;
      if (!item) break;
      if (item.type === "commandExecution") {
        endStreamMode();
        // Codex exec 스타일: "exec\ncommand in dir succeeded/failed in Xms:\noutput"
        const dur = item.durationMs != null ? `${item.durationMs}ms` : "";
        const succeeded = item.exitCode === 0;
        const statusWord = succeeded
          ? `${ANSI.green}succeeded${ANSI.reset}`
          : `${ANSI.red}failed (exit=${item.exitCode})${ANSI.reset}`;
        renderLabel("exec");
        renderWrite(`${ANSI.dim}${item.command}${ANSI.reset} in ${item.cwd} ${statusWord} in ${dur}:\n`);
        if (item.aggregatedOutput) {
          renderWrite(`${item.aggregatedOutput}${item.aggregatedOutput.endsWith("\n") ? "" : "\n"}`);
        }
        renderState.lastCmd = null;
      } else if (item.type === "agentMessage") {
        endStreamMode();
      } else if (item.type === "fileChange") {
        endStreamMode();
        const changes = item.changes || [];
        for (const c of changes) {
          const path = c.path || c.file || "";
          if (path) renderWrite(`  ${ANSI.green}+${ANSI.reset} ${path}\n`);
        }
      }
      break;
    }

    // ── 계획 업데이트 ──
    case "turn/plan/updated": {
      endStreamMode();
      renderLabel("plan");
      if (params.explanation) {
        renderWrite(`${ANSI.dim}${params.explanation}${ANSI.reset}\n`);
      }
      const steps = params.plan || [];
      for (const step of steps) {
        let marker;
        switch (step.status) {
          case "completed": marker = `${ANSI.green}\u2713${ANSI.reset}`; break;
          case "inProgress": marker = `${ANSI.yellow}>${ANSI.reset}`; break;
          default: marker = `${ANSI.dim}-${ANSI.reset}`; break;
        }
        renderWrite(`  ${marker} ${step.step}\n`);
      }
      break;
    }

    // ── Diff 업데이트 ──
    case "turn/diff/updated": {
      endStreamMode();
      renderLabel("diff");
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

    // ── 에러 ──
    case "error": {
      endStreamMode();
      const err = params.error;
      const willRetry = params.willRetry ? " (will retry)" : "";
      renderWrite(`${ANSI.red}${ANSI.bold}error${ANSI.reset}\n`);
      renderWrite(`${err?.message || JSON.stringify(err)}${willRetry}\n`);
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
    return { type: SANDBOX_CAMEL_TO_KEBAB[sandbox] || sandbox };
  }
  if (sandbox && typeof sandbox === "object" && sandbox.type) {
    return { ...sandbox, type: SANDBOX_CAMEL_TO_KEBAB[sandbox.type] || sandbox.type };
  }
  return { type: "danger-full-access" };
}

function renderNotification(method, params) {
  if (viewerProc && viewerProc.stdin && !viewerProc.stdin.destroyed) {
    try {
      if (viewerProc.viewerType === "real-tui") {
        // Real Codex TUI: write Event params directly (codex/event/* only)
        if (method.startsWith("codex/event/")) {
          // Inject fake SessionConfigured before first real event so the TUI
          // initializes its primary thread channel and starts rendering.
          if (!viewerProc._sessionSent && params.conversationId && sessionInfo) {
            const si = sessionInfo;
            const realSC = {
              id: params.id || "",
              msg: {
                type: "session_configured",
                session_id: params.conversationId,
                model: si.model,
                model_provider_id: si.modelProvider,
                approval_policy: si.approvalPolicy,
                sandbox_policy: normalizeSandboxPolicy(si.sandbox),
                cwd: si.cwd,
                history_log_id: 0,
                history_entry_count: 0,
              },
              conversationId: params.conversationId,
            };
            const scJson = JSON.stringify(realSC);
            viewerProc.stdin.write(scJson + "\n");
            viewerProc._sessionSent = true;
            log("TUI", `injected real SessionConfigured: model=${si.model} provider=${si.modelProvider}`);
          }
          viewerProc.stdin.write(JSON.stringify(params) + "\n");
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
    join(homedir(), "argoss", "_external", "openai-codex", "codex-rs", "target", "release", "codex-tui"),
    join(homedir(), ".local", "bin", "codex-tui"),
    "/usr/local/bin/codex-tui",
  ];
  for (const p of knownPaths) {
    if (existsSync(p)) return p;
  }
  return null;
}

function spawnTuiViewer(agentName) {
  // Try real Codex TUI binary first (patched with --pipe-fd support)
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

  // Fallback: blessed-based viewer
  const viewerPath = join(import.meta.dirname || new URL(".", import.meta.url).pathname, "codex-tui-viewer.mjs");
  if (!existsSync(viewerPath)) {
    log("TUI", "no viewer binary found, using ANSI fallback");
    return null;
  }

  log("TUI", "real codex-tui not found, falling back to blessed viewer");
  const proc = spawn("node", [viewerPath, "--name", agentName], {
    stdio: ["pipe", "inherit", "pipe"],
    env: { ...process.env, FORCE_COLOR: "1" },
  });
  proc.viewerType = "blessed";
  attachViewerHandlers(proc);
  log("TUI", `blessed viewer spawned (pid=${proc.pid})`);
  return proc;
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

async function readUnreadMessages(inboxPath) {
  return withLock(inboxPath, async () => {
    const messages = await readInbox(inboxPath);
    const unread = [];
    for (let i = 0; i < messages.length; i++) {
      if (!messages[i].read) {
        unread.push({ index: i, msg: messages[i] });
      }
    }
    return unread;
  });
}

async function markAsRead(inboxPath, indices) {
  await withLock(inboxPath, async () => {
    const messages = await readInbox(inboxPath);
    for (const idx of indices) {
      if (messages[idx]) messages[idx].read = true;
    }
    const readMessages = messages.filter((m) => m.read);
    let pruned = messages;
    if (readMessages.length > 100) {
      const unread = messages.filter((m) => !m.read);
      const recentRead = readMessages.slice(-50);
      pruned = [...recentRead, ...unread];
      log("INBOX-PRUNE", `pruned ${messages.length} → ${pruned.length} messages`);
    }
    await writeFile(inboxPath, JSON.stringify(pruned, null, 2), "utf-8");
  });
}

async function writeToInbox(inboxPath, message) {
  await ensureInbox(inboxPath);
  await withLock(inboxPath, async () => {
    const messages = await readInbox(inboxPath);
    messages.push(message);
    await writeFile(inboxPath, JSON.stringify(messages, null, 2), "utf-8");
  });
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

// ─── Leader Communication ───
async function sendToLeader(config, text, summary) {
  const leaderInbox = getLeaderInboxPath(config.teamName);
  const msg = makeMessage(config.agentName, text, config.agentColor, summary);
  await writeToInbox(leaderInbox, msg);
  log("SENT", summary || text.slice(0, 60));
}

async function sendToLeaderWithRetry(config, text, summary) {
  try {
    await sendToLeader(config, text, summary);
  } catch (err1) {
    log("SEND-RETRY", `first attempt failed: ${err1.message}, retrying...`);
    try {
      await sleep(500);
      await sendToLeader(config, text, summary);
    } catch (err2) {
      log("SEND-FAIL", `result delivery failed permanently: ${err2.message}`);
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

  const leaderInbox = getLeaderInboxPath(config.teamName);
  const notification = makeIdleNotification(config.agentName, opts);
  const msg = makeMessage(
    config.agentName,
    JSON.stringify(notification),
    config.agentColor,
    opts.summary || "Codex worker idle"
  );
  await writeToInbox(leaderInbox, msg);
  log("IDLE", opts.summary || "waiting for next task");
}

async function handleShutdown(config, request) {
  log("SHUTDOWN", `reason: ${request.reason || "none"}`);
  const response = makeShutdownApproved(config.agentName, request.requestId);
  const leaderInbox = getLeaderInboxPath(config.teamName);
  const msg = makeMessage(
    config.agentName,
    JSON.stringify(response),
    config.agentColor,
    "Shutdown approved"
  );
  await writeToInbox(leaderInbox, msg);
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
  if (!existsSync(taskDir)) return;

  try {
    const files = readdirSync(taskDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      const fp = join(taskDir, f);
      try {
        const raw = await readFile(fp, "utf-8");
        const task = JSON.parse(raw);
        if (task.owner === config.agentName && task.status === "in_progress") {
          task.status = "completed";
          await writeFile(fp, JSON.stringify(task, null, 2), "utf-8");
          log("TASK-DONE", `marked task ${task.id || f} as completed`);
        }
      } catch { /* skip invalid files */ }
    }
  } catch (err) {
    log("TASK-ERR", err.message);
  }
}

// ─── Codex App Server Session ───
// agentName으로 effort 결정: codex-xh-* → xhigh, 그 외 → high
let codexEffort = "high";

function truncateOutput(output) {
  if (MAX_RESULT_BYTES > 0 && output.length > MAX_RESULT_BYTES) {
    return output.slice(0, MAX_RESULT_BYTES) +
      `\n\n--- [TRUNCATED: output exceeded ${MAX_RESULT_BYTES / 1024}KB] ---`;
  }
  return output;
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
    const args = ["app-server", "-c", `model_reasoning_effort="${this.effort}"`];
    const child = spawn("codex", args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
      env: { ...process.env },
    });

    this.child = child;
    currentChild = child;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) log("APP-SERVER", text);
    });
    child.on("close", (code, signal) => this.handleClose(code, signal));
    child.on("error", (err) => this.handleFatal(err));

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
    } catch (err) {
      if (this.child === child) {
        log("STARTUP-FAIL", `cleaning up child (pid=${child.pid}): ${err.message}`);
        child.kill("SIGTERM");
        this.child = null;
        currentChild = null;
        this.threadId = null;
      }
      throw err;
    }
  }

  sendRaw(message) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      throw new Error("app-server process is not writable");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
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
          this.sendError(msg.id, -32601, `Unsupported server request: ${msg.method}`);
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
  lastInboxMtime = 0;
  currentPollMs = POLL_INTERVAL_MS;
  const session = new AppServerSession({
    cwd: process.cwd(),
    effort: codexEffort,
  });

  log("POLL", `inbox: ${myInbox}`);

  // 활성 턴의 완료를 추적하는 promise (null = 유휴 상태)
  let activeTurnPromise = null;
  // steer 직렬화 체인 + 실패 시 보관 큐
  let steerChain = Promise.resolve();
  let pendingSteerQueue = [];
  const MAX_PENDING_STEERS = 32;
  function enqueuePendingSteer(text) {
    if (pendingSteerQueue.length >= MAX_PENDING_STEERS) {
      const dropped = pendingSteerQueue.shift();
      log("STEER-DROP", `queue full (${MAX_PENDING_STEERS}), dropped oldest (len=${dropped.length})`);
    }
    pendingSteerQueue.push(text);
  }

  // 턴 완료 핸들러: 결과를 리더에게 전송
  function handleTurnResult(result) {
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

    if (result.success) {
      void sendToLeaderWithRetry(config, result.output, "Codex task completed");
      markMyTasksCompleted(config).catch(() => {});
      sendIdleNotification(config, {
        summary: "Task completed, ready for next",
        completedStatus: "completed",
      }).catch(() => {});
    } else {
      const errMsg = `[ERROR] Codex failed:\n${result.output}`;
      void sendToLeaderWithRetry(config, errMsg, "Codex task failed");
      sendIdleNotification(config, {
        idleReason: "error",
        summary: "Task failed",
        failureReason: result.output.slice(0, 200),
      }).catch(() => {});
    }
  }

  function handleTurnError(err) {
    activeTurnPromise = null;
    steerChain = Promise.resolve();
    if (!running) return;

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

    const errMsg = `[ERROR] Codex app-server error: ${err.message}`;
    void sendToLeaderWithRetry(config, errMsg, "Codex task failed");
    sendIdleNotification(config, {
      idleReason: "error",
      summary: "Task failed",
      failureReason: err.message.slice(0, 200),
    }).catch(() => {});
  }

  try {
    while (running) {
      const st = await fsStat(myInbox).catch(() => null);
      let sawMessages = false;
      if (st && st.mtimeMs !== lastInboxMtime) {
        lastInboxMtime = st.mtimeMs;
        const unread = await readUnreadMessages(myInbox);

        if (unread.length > 0) {
          sawMessages = true;
          currentPollMs = POLL_ACTIVE_MS;
          const processedIndices = [];

          for (const { index, msg } of unread) {
            if (!running) break;

            const protocol = tryParseProtocol(msg.text);

            // shutdown_request 처리: 활성 턴 완료 대기 후 승인
            if (protocol?.type === "shutdown_request") {
              if (activeTurnPromise) {
                log("SHUTDOWN", "waiting for active turn to complete (max 15s)...");
                const race = await Promise.race([
                  activeTurnPromise.then(() => "done"),
                  sleep(15000).then(() => "timeout"),
                ]).catch(() => "error");
                if (race === "timeout") {
                  log("SHUTDOWN", "timeout — interrupting active turn");
                  await session.interruptActiveTurn().catch(() => {});
                  await sleep(2000);
                }
              }
              processedIndices.push(index);
              await markAsRead(myInbox, processedIndices);
              await handleShutdown(config, protocol);
              return;
            }

            // 프로토콜 메시지 스킵
            if (protocol?.type === "permission_request") {
              log("SKIP", "permission_request (Codex uses own sandbox)");
              processedIndices.push(index);
              continue;
            }
            if (protocol?.type === "mode_set_request") {
              log("SKIP", `mode_set_request: ${protocol.mode}`);
              processedIndices.push(index);
              continue;
            }
            if (protocol?.type === "idle_notification") {
              log("SKIP", "idle_notification from leader");
              processedIndices.push(index);
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
                    log("STEER-ERR", steerErr.message);
                    // steer 실패 시 pendingSteerQueue에 보관 → 다음 턴에서 처리
                    enqueuePendingSteer(taskText);
                    log("STEER-QUEUED", `queued for next turn (${pendingSteerQueue.length} pending)`);
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
              if (pendingSteerQueue.length > 0) {
                const queued = pendingSteerQueue.splice(0);
                log("STEER-DRAIN", `draining ${queued.length} queued steer messages into new turn`);
                fullPrompt = [taskText, ...queued].join("\n\n---\n\n");
              }
              log("TASK", `from=${msg.from}, len=${fullPrompt.length}`);
              try {
                activeTurnPromise = session.runTurn(fullPrompt);
                activeTurnPromise.then(handleTurnResult, handleTurnError);
              } catch (err) {
                handleTurnError(err);
              }
            }

            processedIndices.push(index);
          }

          if (processedIndices.length > 0) {
            await markAsRead(myInbox, processedIndices);
          }
        }
      }

      if (running) {
        if (!sawMessages) {
          currentPollMs = Math.min(currentPollMs * 2, POLL_IDLE_MS);
        }
        await sleep(currentPollMs);
      }
    }
  } finally {
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
      if (shuttingDown) return;
      shuttingDown = true;
      log("SIGNAL", sig);
      running = false;
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
    || "/root/.local/bin/claude";
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

  // 이름 기반 라우팅: claude-* → Claude Code, 그 외 → Codex
  if (config.agentName.startsWith("claude-")) {
    return passthroughToClaude();
  }

  // Codex effort 라우팅: codex-xh-* → xhigh, 그 외 → high
  if (config.agentName.startsWith("codex-xh-")) {
    codexEffort = "xhigh";
  }

  log("INIT", `${config.agentName}@${config.teamName} (color=${config.agentColor})`);
  log("INFO", `cwd=${process.cwd()}`);
  log("INFO", `pid=${process.pid}`);

  // 스폰 후 리더 pane으로 포커스 자동 복원
  try {
    spawn("tmux", ["select-pane", "-l"], { stdio: "ignore", detached: true }).unref();
  } catch { /* tmux 없는 환경에서는 무시 */ }

  // TUI 뷰어 스폰
  viewerProc = spawnTuiViewer(config.agentName);

  // 뷰어 활성화 시 stderr 로그를 파일로 리다이렉트
  if (viewerProc) {
    initLogFile(config.agentName);
  }

  setupSignalHandlers(config);
  await pollLoop(config);

  log("EXIT", "bridge shutting down");
  closeViewer();
  closeLogFile();
  // 리더가 shutdown_approved를 읽을 시간 확보 후 pane 종료
  await sleep(2000);
  killMyPane();
  process.exit(0);
}

main().catch((err) => {
  console.error("[codex-bridge] Fatal:", err);
  closeViewer();
  closeLogFile();
  process.exit(1);
});
