#!/usr/bin/env node
// codex-bridge.mjs — Wrapper that runs Codex CLI as a native Claude Code teammate
// zero-dependency (uses only built-in Node.js modules)

import { readFile, writeFile, mkdir, rmdir, rename, stat as fsStat } from "node:fs/promises";
import { existsSync, readFileSync, createWriteStream, openSync, closeSync, unlinkSync, watch as fsWatch } from "node:fs";
import { join, basename } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

// ─── Constants ───
const POLL_INTERVAL_MS = 500;
const POLL_IDLE_MS = 2000;
const POLL_ACTIVE_MS = 100;
const POLL_FALLBACK_MS = 5000; // fs.watch fallback timeout
const FLUSH_DEBOUNCE_MS = 50;  // leader outbox micro-batch interval
const SHUTDOWN_POLL_MS = 3000;
const MAX_RESULT_BYTES = 5 * 1024 * 1024; // 5MB (for file storage)
const PREVIEW_CHARS = 500; // inbox preview character count
const TEAMS_BASE = join(homedir(), ".claude", "teams");
const TASKS_BASE = join(homedir(), ".claude", "tasks");
const LEADER_NAME = "team-lead";
const MODULE_DIR = import.meta.dirname || fileURLToPath(new URL(".", import.meta.url));
const TEAMAGENT_MD_PATH = join(MODULE_DIR, "teamagent.md");

// ─── Team worker base instructions (injected via thread/start baseInstructions) ───
const BASE_INSTRUCTIONS_CORE = `\
# Team Worker Behavior Rules

## Basics
- Respond in English.
- Be concise. Deliver only the key points. No lengthy explanations or unnecessary introductions/conclusions.
- Stay faithful to the assigned role. Do not do work outside your scope.

## Deliverables
- Implement/analyze only what was requested. No unrequested extra features, refactoring, or abstraction.
- Explicitly mark any parts you are not confident about.
- If you find an error or issue, report it without hiding it.

## Multi-Agent Usage (Proactive Splitting Principle)
- **Default stance: when in doubt, split work to a sub-agent.**
- Criteria for spawning sub-agents: modify 2 or more files OR explore 3 or more directories.
- Direct handling scope: handle only **one file, one function change** yourself.
- If the leader explicitly says "process in parallel with sub-agents," split subtasks as independently as possible and run them concurrently.
- Number of sub-agents: spawn as many as there are subtasks, up to **4 maximum**.
- Apply the same behavior rules to sub-agents as well (concise, scope discipline, no overreach).
- Integrate sub-agent results and report them back to the leader in a single response.
- If a sub-agent fails, retry only that subtask and keep the successful work.

## Process Protection
- Do not use kill, pkill, or killall commands.
- Do not use tmux kill-pane, tmux kill-window, or tmux kill-session.
- Never terminate processes in other tmux panes or sessions.
- If a port/file conflict occurs, report it instead of killing the existing process.

## Constraints
- Do not reduce the user's original goal or propose compromises.
- Before concluding "impossible," explore other approaches first.
`;

const SEND_INSTRUCTIONS_FALLBACK = `\
## SendMessage CLI
- Use \`codex-bridge send <target> [--summary "text"] [--file path] "<message>"\` for teammate updates.
- Targets: teammate name or \`*\` for broadcast.
- Prefer short status updates. Use \`--summary\` for inbox previews.
- Use \`--file\` for long text. The bridge stores the full text in \`results/\` and sends a preview to the inbox.
- Default sender context is injected automatically via:
  - \`CODEX_BRIDGE_AGENT_NAME\`
  - \`CODEX_BRIDGE_TEAM_NAME\`
  - \`CODEX_BRIDGE_AGENT_COLOR\`
`;

function loadTeamAgentInstructions() {
  try {
    return readFileSync(TEAMAGENT_MD_PATH, "utf8").trimEnd();
  } catch (err) {
    console.warn(`[codex-bridge] teamagent.md load failed (${TEAMAGENT_MD_PATH}): ${err.message}`);
    return SEND_INSTRUCTIONS_FALLBACK;
  }
}

// If goal exists, inject goal context into baseInstructions
function buildBaseInstructions({ teamGoal = null, teamName = null, agentName = null } = {}) {
  const teammates = readTeamMemberNames(teamName, agentName);
  const teammatesLine = teammates.length > 0
    ? `- Available teammates: ${teammates.join(", ")}`
    : "- Available teammates: none";
  const teamAgentInstructions = loadTeamAgentInstructions();

  let instructions = `${BASE_INSTRUCTIONS_CORE}
${teamAgentInstructions}
${teammatesLine}
`;

  if (!teamGoal) return instructions;
  instructions += `
## Team Goal (Goal Context)
> ${teamGoal}

- All work must contribute to the team goal above.
- Always keep the "why?" of the task in mind, and do not do work that strays from the goal.
- When judgment is uncertain, prioritize based on the team goal.
`;
  return instructions;
}

let running = true;
let shutdownRequested = false;
let currentChild = null;
let viewerProc = null;
let viewerFifoPath = null;   // tmux FIFO path (for cleanup)
let viewerTmuxPaneId = null; // tmux pane ID (for cleanup)
let logStream = null;
// Real session info from app-server (populated after thread/start)
let sessionInfo = null;
let currentPollMs = POLL_INTERVAL_MS;
let messageRouter = null; // initialized in pollLoop
let _borderAgentName = null; // agent name for border-status (set in main)
let nativeTuiPaneId = null;       // native Codex TUI pane ID (for cleanup)
let nativeTuiSessionName = null;  // native TUI tmux session name (for cleanup)
let wsPort = null;                // WebSocket app-server port (for native TUI)
let ansiFallbackLogged = false;   // limit ANSI fallback transition log to once
let nativeTuiSpawning = false;    // flag indicating TUI spawn is in progress

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

function printSendUsage() {
  console.error('Usage: codex-bridge send <target> [--summary "text"] [--file path] [--agent-name NAME] [--team-name TEAM] [--agent-color COLOR] "<message>"');
}

function parseSendCommandArgs(argv) {
  const parsed = {
    target: null,
    message: null,
    summary: null,
    file: null,
    agentName: process.env.CODEX_BRIDGE_AGENT_NAME || null,
    teamName: process.env.CODEX_BRIDGE_TEAM_NAME || null,
    agentColor: process.env.CODEX_BRIDGE_AGENT_COLOR || "cyan",
  };
  const positional = [];

  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--summary" || arg === "--file" || arg === "--agent-name" || arg === "--team-name" || arg === "--agent-color") {
      if (i + 1 >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      const value = argv[++i];
      if (arg === "--summary") parsed.summary = value;
      else if (arg === "--file") parsed.file = value;
      else if (arg === "--agent-name") parsed.agentName = value;
      else if (arg === "--team-name") parsed.teamName = value;
      else if (arg === "--agent-color") parsed.agentColor = value;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  if (positional.length < 2) {
    throw new Error("send requires both <target> and <message>");
  }
  if (positional.length > 2) {
    throw new Error("send accepts exactly one <target> and one <message>");
  }

  parsed.target = positional[0];
  parsed.message = positional[1];

  if (!parsed.agentName) throw new Error("Missing agent name (--agent-name or CODEX_BRIDGE_AGENT_NAME)");
  if (!parsed.teamName) throw new Error("Missing team name (--team-name or CODEX_BRIDGE_TEAM_NAME)");
  if (!parsed.target) throw new Error("Missing target");
  if (typeof parsed.message === "undefined") throw new Error("Missing message");

  return parsed;
}

// ─── Goal Context (Paperclip-inspired "why?" tracking) ───
function getTeamConfigPath(teamName) {
  return join(TEAMS_BASE, sanitize(teamName), "config.json");
}

function readTeamConfig(teamName) {
  try {
    if (!teamName) return null;
    const configPath = getTeamConfigPath(teamName);
    if (!existsSync(configPath)) return null;
    return JSON.parse(readFileSync(configPath, "utf-8"));
  } catch { return null; }
}

function readTeamGoal(teamName) {
  return readTeamConfig(teamName)?.description || null;
}

function readTeamMemberNames(teamName, selfName = null) {
  const members = readTeamConfig(teamName)?.members || [];
  return [...new Set(
    members
      .map((member) => member?.name)
      .filter(Boolean)
      .filter((name) => name !== selfName)
  )];
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
  const safeAgentName = String(agentName).replace(/[^a-zA-Z0-9_\-@.]/g, "_");
  const logPath = `/tmp/codex-bridge-${safeAgentName}.log`;
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

// ─── Pane Renderer: app-server notifications → Codex exec-style output ───
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

// Current render state (tracking streaming mode)
const renderState = {
  mode: "idle", // "idle" | "agent" | "exec" | "file" | "reasoning"
  lastItemId: null,
  lastTokenTotal: 0,
  lastCmd: null, // info about the currently running command
  headerPrinted: false, // whether the session header was printed
  // track items whose exec outputDelta was streamed (avoid duplicating aggregatedOutput on completion)
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

// Output key events to both the log and ANSI pane
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

// Codex exec style: section header in "label\ncontent" format
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
    // ── Turn started ──
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

    // ── Turn completed ──
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

    // ── Agent message streaming ──
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

    // ── Command execution output (streaming) ──
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

    // ── File change output ──
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

    // ── Reasoning summary streaming ──
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

    // ── Item started ──
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
          // print the exec start header immediately (identify command during streaming)
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

    // ── Item completed ──
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
          // Codex exec style: "exec\ncommand in dir succeeded/failed in Xms:\noutput"
          const dur = item.durationMs != null ? `${item.durationMs}ms` : "";
          const succeeded = item.exitCode === 0;
          const statusWord = succeeded
            ? `${ANSI.green}succeeded${ANSI.reset}`
            : `${ANSI.red}failed (exit=${item.exitCode})${ANSI.reset}`;
          renderLabel(succeeded ? "[OK] exec" : "[ERR] exec", succeeded ? ANSI.green : ANSI.red);
          { const _cw = getPaneWidth() - 30; renderWrite(`${ANSI.dim}${truncateMiddle(item.command || "", _cw)} in ${truncateMiddle(item.cwd || "", 30)}${ANSI.reset} ${statusWord} ${ANSI.dim}in ${dur}${ANSI.reset}:\n`); }
          // do not reprint output already streamed (avoid duplication)
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

    // ── Plan update ──
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

    // ── Diff update ──
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

    // ── Token usage ──
    case "thread/tokenUsage/updated": {
      const usage = params.tokenUsage;
      if (!usage) break;
      const total = usage.total || {};
      renderState.lastTokenTotal = total.totalTokens || 0;
      break;
    }

    // ── Error (always show in full) ──
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
  // Native TUI mode: no bridge rendering needed because resume shares the same thread
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
  if (!ansiFallbackLogged && !nativeTuiSpawning) {
    ansiFallbackLogged = true;
    log("TUI", "falling back to ANSI renderer (viewer/native TUI unavailable)");
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
  // Real Codex TUI binary (--pipe-fd support) — only if present
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

// ─── TUI viewer based on a tmux pane ───
function spawnTuiTmuxPane(agentName) {
  const fifoPath = `/tmp/codex-tui-${process.pid}.fifo`;

  // Create FIFO
  try { unlinkSync(fifoPath); } catch {}
  const mkResult = spawnSync("mkfifo", [fifoPath], { timeout: 3000 });
  if (mkResult.status !== 0) {
    log("TUI", `mkfifo failed: ${mkResult.stderr?.toString().trim()}`);
    return null;
  }

  // Run Ink viewer in a tmux pane
  const baseDir = import.meta.dirname || new URL(".", import.meta.url).pathname;
  const viewerPath = join(baseDir, "codex-ink-viewer.mjs");
  if (!existsSync(viewerPath)) {
    log("TUI", "codex-ink-viewer.mjs not found, cannot spawn tmux pane");
    try { unlinkSync(fifoPath); } catch {}
    return null;
  }

  const cmd = `exec node ${JSON.stringify(viewerPath)} --name ${JSON.stringify(agentName)} --fifo ${JSON.stringify(fifoPath)}`;
  const splitResult = spawnSync("tmux", [
    "split-window", "-d", "-h", "-l", "45%",
    "-P", "-F", "#{pane_id}",  // print pane ID
    cmd,
  ], { encoding: "utf8", timeout: 5000 });

  if (splitResult.status !== 0) {
    log("TUI", `tmux split-window failed: ${splitResult.stderr?.trim()}`);
    try { unlinkSync(fifoPath); } catch {}
    return null;
  }

  const paneId = (splitResult.stdout || "").trim();
  log("TUI", `tmux pane created: ${paneId}`);

  // #3 root fix: remove break-pane — keep bridge and viewer in the same window
  // Reason: if break-pane is used and the viewer dies, the window ends up with 0 panes → tmux auto-deletes the window
  //       → bridge keeps running in a hidden background window, but appears "closed" to the user

  // Open FIFO with O_RDWR (Unix trick to prevent blocking)
  let fd;
  try {
    fd = openSync(fifoPath, "r+"); // O_RDWR → does not block even without a reader
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

  // viewerProc-compatible object (renderNotification uses viewerProc.stdin)
  viewerFifoPath = fifoPath;
  viewerTmuxPaneId = paneId;

  return {
    stdin: stream,
    viewerType: "blessed",
    _sessionSent: false,
    _isTmux: true,
  };
}

// ─── Native Codex TUI (via app-server WebSocket) ───

function findCodexAlphaBin() {
  // 1. CODEX_ALPHA_BIN env
  if (process.env.CODEX_ALPHA_BIN) {
    log("TUI-DETECT", `checking CODEX_ALPHA_BIN=${process.env.CODEX_ALPHA_BIN}`);
    if (existsSync(process.env.CODEX_ALPHA_BIN)) {
      log("TUI-DETECT", `using CODEX_ALPHA_BIN: ${process.env.CODEX_ALPHA_BIN}`);
      return process.env.CODEX_ALPHA_BIN;
    }
    log("TUI-DETECT", `CODEX_ALPHA_BIN not found: ${process.env.CODEX_ALPHA_BIN}`);
  } else {
    log("TUI-DETECT", "CODEX_ALPHA_BIN not set");
  }
  // 2. Known paths (codex-alpha, codex-next)
  log("TUI-DETECT", "checking known native TUI paths");
  const knownPaths = [
    join(homedir(), ".local", "bin", "codex-alpha"),
    join(homedir(), ".local", "bin", "codex-next"),
    "/usr/local/bin/codex-alpha",
  ];
  for (const p of knownPaths) {
    if (existsSync(p)) {
      log("TUI-DETECT", `found native TUI binary at ${p}`);
      return p;
    }
  }
  log("TUI-DETECT", "known native TUI paths not found");
  // 3. PATH lookup (codex-alpha, codex-next)
  log("TUI-DETECT", "searching PATH for codex-alpha/codex-next");
  for (const binName of ["codex-alpha", "codex-next"]) {
    try {
      const result = spawnSync("which", [binName], { encoding: "utf8", timeout: 3000 });
      const p = (result.stdout || "").trim();
      if (p && existsSync(p)) {
        log("TUI-DETECT", `found ${binName} on PATH: ${p}`);
        return p;
      }
    } catch (err) {
      log("TUI-DETECT", `PATH lookup failed for ${binName}: ${err.message}`);
    }
  }
  log("TUI-DETECT", "codex-alpha/codex-next not found on PATH");
  // 4. If default codex is 0.117+, use it as-is
  const ver = getCodexVersion();
  log("TUI-DETECT", `checking codex native TUI support (version=${ver || "unknown"})`);
  if (ver) {
    const m = ver.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (m && (Number(m[1]) > 0 || Number(m[2]) >= 117)) {
      try {
        const r = spawnSync("which", ["codex"], { encoding: "utf8", timeout: 3000 });
        const p = (r.stdout || "").trim();
        if (p && existsSync(p)) {
          log("TUI-DETECT", `using codex 0.117+ binary: ${p}`);
          return p;
        }
      } catch (err) {
        log("TUI-DETECT", `PATH lookup failed for codex: ${err.message}`);
      }
    }
  }
  log("TUI-DETECT", "no native TUI-compatible codex binary found");
  return null;
}

function formatSessionPathPart(value) {
  return String(value).padStart(2, "0");
}

function getCodexSessionFilePath(threadId) {
  if (!threadId) return null;
  const compact = String(threadId).replace(/-/g, "");
  if (!/^[0-9a-f]{12,}$/i.test(compact)) return null;
  try {
    const startedAt = new Date(Number(BigInt(`0x${compact.slice(0, 12)}`)));
    if (Number.isNaN(startedAt.getTime())) return null;
    const yyyy = String(startedAt.getFullYear());
    const mm = formatSessionPathPart(startedAt.getMonth() + 1);
    const dd = formatSessionPathPart(startedAt.getDate());
    const hh = formatSessionPathPart(startedAt.getHours());
    const min = formatSessionPathPart(startedAt.getMinutes());
    const ss = formatSessionPathPart(startedAt.getSeconds());
    const fileName = `rollout-${yyyy}-${mm}-${dd}T${hh}-${min}-${ss}-${threadId}.jsonl`;
    return join(homedir(), ".codex", "sessions", yyyy, mm, dd, fileName);
  } catch {
    return null;
  }
}

async function waitForFile(filePath, timeoutMs = 5000, intervalMs = 100) {
  if (!filePath) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return true;
    await sleep(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
  }
  return existsSync(filePath);
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

let nativeTuiChild = null; // native TUI child process

function attachNativeTuiChildHandlers(child, onAbnormalExit = null) {
  let recoveryTriggered = false;
  const triggerRecovery = (info) => {
    if (!onAbnormalExit || recoveryTriggered) return;
    if (child._bridgeClosing || shuttingDown) return;
    recoveryTriggered = true;
    Promise.resolve(onAbnormalExit(info)).catch((err) => {
      log("NATIVE-TUI", `recovery error: ${err.message}`);
    });
  };

  child.on("close", (code, signal) => {
    log("NATIVE-TUI", `TUI exited (code=${code}, signal=${signal || "none"})`);
    if (nativeTuiPaneId) {
      log("NATIVE-TUI", "post-ready crash detected, reverting to ANSI renderer");
      ansiFallbackLogged = false;
    }
    nativeTuiChild = null;
    nativeTuiPaneId = null;
    if (signal || (typeof code === "number" && code !== 0)) {
      triggerRecovery({ child, code, signal });
    }
  });

  child.on("error", (err) => {
    log("NATIVE-TUI", `TUI error: ${err.message}`);
    nativeTuiChild = null;
    nativeTuiPaneId = null;
    triggerRecovery({ child, error: err });
  });
}

function waitForNativeTuiReady(child, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onClose = (code, signal) => {
      finish(reject, new Error(`early exit (code=${code}, signal=${signal || "none"})`));
    };
    const onError = (err) => {
      finish(reject, err);
    };
    const timer = setTimeout(() => {
      finish(resolve);
    }, timeoutMs);
    child.on("close", onClose);
    child.on("error", onError);
  });
}

async function spawnNativeTuiInPlace(agentName, port, threadId, sessionFilePath = null, onAbnormalExit = null) {
  let codexBin = findCodexAlphaBin();
  if (!codexBin) {
    const ver = getCodexVersion();
    const m = ver && ver.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (m && (Number(m[1]) > 0 || Number(m[2]) >= 117)) {
      codexBin = "codex";
      log("NATIVE-TUI", "native TUI supported by codex, falling back to plain codex binary");
    }
  }
  if (!codexBin) {
    log("NATIVE-TUI", "native TUI binary not found, skipping native TUI");
    return null;
  }

  const resolvedSessionFilePath = sessionFilePath || getCodexSessionFilePath(threadId);
  if (threadId && resolvedSessionFilePath && !existsSync(resolvedSessionFilePath)) {
    log("NATIVE-TUI", `waiting for session file: ${resolvedSessionFilePath}`);
    const sessionFileReady = await waitForFile(resolvedSessionFilePath, 5000, 100);
    if (sessionFileReady) {
      log("NATIVE-TUI", `session file detected: ${resolvedSessionFilePath}`);
    } else {
      log("NATIVE-TUI", `session file wait timed out after 5000ms, resuming anyway: ${resolvedSessionFilePath}`);
    }
  }

  // Run TUI in the same pane as bridge (stdio: "inherit" → shared terminal)
  // bridge only handles IPC in the background while TUI takes over the screen
  const args = threadId
    ? ["resume", threadId, "--remote", `ws://127.0.0.1:${port}`]
    : ["--remote", `ws://127.0.0.1:${port}`];

  const maxRetries = 2;
  for (let retry = 0; retry <= maxRetries; retry++) {
    const attempt = retry + 1;
    log("NATIVE-TUI", `spawning in-place (attempt ${attempt}/${maxRetries + 1}): ${codexBin} ${args.join(" ")}`);

    const child = spawn(codexBin, args, {
      stdio: ["inherit", "inherit", "pipe"],  // capture stderr only
      cwd: process.cwd(),
      env: { ...process.env },
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) log("NATIVE-TUI-STDERR", text);
    });

    nativeTuiChild = child;
    nativeTuiPaneId = "in-place"; // indicates no pane split

    // Set pane title to the agent name
    if (process.env.TMUX) {
      try {
        spawnSync("tmux", ["select-pane", "-T", `${agentName} [codex-tui]`], { stdio: "ignore", timeout: 2000 });
      } catch {}
    }

    try {
      await waitForNativeTuiReady(child, 500);
      attachNativeTuiChildHandlers(child, onAbnormalExit);
      log("NATIVE-TUI", `TUI running in-place (pid=${child.pid}, thread=${threadId || "new"})`);
      return "in-place";
    } catch (err) {
      nativeTuiChild = null;
      nativeTuiPaneId = null;
      log("NATIVE-TUI", `spawn attempt ${attempt}/${maxRetries + 1} failed: ${err.message}`);
      if (retry < maxRetries) {
        await sleep(500);
        continue;
      }
      log("NATIVE-TUI", "spawn failed after retries, falling back to ANSI");
      return null;
    }
  }
  return null;
}

function closeNativeTuiPane() {
  if (nativeTuiChild) {
    nativeTuiChild._bridgeClosing = true;
    if (!nativeTuiChild.killed) {
      nativeTuiChild.kill("SIGTERM");
    }
    nativeTuiChild = null;
  }
  nativeTuiPaneId = null;
  nativeTuiSessionName = null;
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
  // Prevent EPIPE: if the viewer dies first, stdin.write() emits an error event
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

// ─── Claim + MarkAsRead combined: one lock/parse/write cycle ───
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

// ─── Message Router (CAS + micro-batching + in-memory spool) ───
// 1) CAS+temp rename: minimize lock hold time
// 2) micro-batching: one write for multiple messages with 50ms debounce
// 3) in-memory spool: per-target queue → write to inbox only on flush
class MessageRouter {
  constructor(teamName) {
    this.teamName = teamName;
    this.targets = new Map();
  }

  getState(target) {
    if (!this.targets.has(target)) {
      this.targets.set(target, {
        path: getInboxPath(target, this.teamName),
        queue: [],
        timer: null,
        chain: Promise.resolve(),
      });
    }
    return this.targets.get(target);
  }

  enqueue(target, msg) {
    const state = this.getState(target);
    state.queue.push(msg);
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        state.chain = state.chain
          .then(() => this._drain(target, state))
          .catch((e) => log("ROUTER-ERR", `${target}: ${e.message}`));
      }, FLUSH_DEBOUNCE_MS);
    }
  }

  flush(target) {
    const state = this.targets.get(target);
    if (!state) return Promise.resolve();
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    state.chain = state.chain
      .then(() => this._drain(target, state))
      .catch((e) => log("ROUTER-ERR", `${target}: ${e.message}`));
    return state.chain;
  }

  flushAll() {
    return Promise.all([...this.targets.keys()].map((target) => this.flush(target)));
  }

  async _drain(target, state) {
    if (state.queue.length === 0) return;
    const batch = state.queue.splice(0);
    await ensureInbox(state.path);

    // Phase 1: prepare outside lock (heavy I/O)
    const pre = await fsStat(state.path).catch(() => null);
    const existing = await readInbox(state.path);
    existing.push(...batch);
    const tmp = `${state.path}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(existing), "utf-8");

    // Phase 2: CAS verify + atomic rename inside lock (minimal hold)
    let ok = false;
    try {
      ok = await withLock(state.path, async () => {
        const post = await fsStat(state.path).catch(() => null);
        if (pre && post && pre.mtimeMs !== post.mtimeMs) return false;
        await rename(tmp, state.path);
        return true;
      });
    } catch (e) {
      try { unlinkSync(tmp); } catch {}
      throw e;
    }

    // CAS failed: another writer changed it → fallback (traditional lock+rewrite)
    if (!ok) {
      try { unlinkSync(tmp); } catch {}
      log("CAS-RETRY", `${target}: mtime changed, fallback to full lock`);
      await withLock(state.path, async () => {
        const msgs = await readInbox(state.path);
        msgs.push(...batch);
        await writeFile(state.path, JSON.stringify(msgs), "utf-8");
      });
    }

    // Logging is already handled in higher-level send helpers
  }

  destroy() {
    for (const state of this.targets.values()) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
    }
    this.targets.clear();
  }
}

function resolveSendTargets(target, teamName, agentName) {
  if (target !== "*") return [target];

  const members = readTeamMemberNames(teamName, agentName);
  if (members.length === 0) {
    throw new Error("Broadcast target '*' has no recipients");
  }
  return members;
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

// ─── Update tmux pane title status ───
function updatePaneTitle(agentName, status) {
  if (!process.env.TMUX) return;
  try {
    spawnSync("tmux", ["select-pane", "-T", `${agentName} [${status}]`], { stdio: "ignore", timeout: 1000 });
  } catch {}
}

// ─── Configure tmux border-status (show title at the top of pane) ───
function setupPaneBorderStatus(paneId) {
  if (!paneId && !process.env.TMUX) return;
  try {
    const target = paneId ? ["-t", paneId] : [];
    spawnSync("tmux", ["set-option", "-p", ...target, "pane-border-status", "top"], { stdio: "ignore", timeout: 1000 });
    spawnSync("tmux", ["set-option", "-p", ...target, "pane-border-format", "#{pane_title}"], { stdio: "ignore", timeout: 1000 });
  } catch {}
}

// ─── Update tmux border-status header (throttled) ───
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
async function sendEnvelope(config, target, msg, opts = {}) {
  if (messageRouter) {
    messageRouter.enqueue(target, msg);
    if (opts.flush) await messageRouter.flush(target);
  } else {
    await writeToInbox(getInboxPath(target, config.teamName), msg);
  }
}

async function sendToLeader(config, text, summary) {
  const msg = makeMessage(config.agentName, text, config.agentColor, summary);
  await sendEnvelope(config, LEADER_NAME, msg);
  log("SENT", summary || text.slice(0, 60));
}

async function sendToLeaderWithRetry(config, text, summary) {
  try {
    await sendToLeader(config, text, summary);
    if (messageRouter) await messageRouter.flush(LEADER_NAME);
  } catch (err1) {
    log("SEND-RETRY", `first attempt failed: ${err1.message}, retrying...`);
    try {
      await sleep(500);
      await sendToLeader(config, text, summary);
      if (messageRouter) await messageRouter.flush(LEADER_NAME);
    } catch (err2) {
      logAndRenderError("SEND-FAIL", `result delivery failed permanently: ${err2.message}`);
    }
  }
}

async function handleSendCommand(argv) {
  let parsed;
  try {
    parsed = parseSendCommandArgs(argv);
  } catch (err) {
    console.error(`[codex-bridge] ${err.message}`);
    printSendUsage();
    return 1;
  }

  try {
    const config = {
      agentName: parsed.agentName,
      teamName: parsed.teamName,
      agentColor: parsed.agentColor,
    };
    const targets = resolveSendTargets(parsed.target, config.teamName, config.agentName);
    const text = await buildSendText(config, parsed.message, parsed.file);
    const msg = makeMessage(config.agentName, text, config.agentColor, parsed.summary);

    for (const target of targets) {
      await writeToInbox(getInboxPath(target, config.teamName), { ...msg });
    }
    return 0;
  } catch (err) {
    console.error(`[codex-bridge] ${err.message}`);
    return err?.message?.startsWith("Lock timeout:") ? 3 : 2;
  }
}

let lastIdleSentAt = 0;
const IDLE_COOLDOWN_MS = 30000;

async function sendIdleNotification(config, opts = {}) {
  // Always send state changes (completed/error); pure idle repeats use cooldown
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
  await sendEnvelope(config, LEADER_NAME, msg, { flush: isStateChange });
  log("IDLE", opts.summary || "waiting for next task");
  updatePaneTitle(config.agentName, "idle");
  updateBorderStatus(config.agentName);
}

async function handleShutdown(config, request) {
  log("SHUTDOWN", `reason: ${request.reason || "none"}`);
  shuttingDown = true; // #2 fix: prevent signal handler re-entry
  const response = makeShutdownApproved(config.agentName, request.requestId);
  const msg = makeMessage(
    config.agentName,
    JSON.stringify(response),
    config.agentColor,
    "Shutdown approved"
  );
  await sendEnvelope(config, LEADER_NAME, msg, { flush: true });
  running = false;
  closeViewer();

  // Native team protocol: remove self from config.json (process_shutdown_approved role)
  await removeSelfFromConfig(config).catch((err) => {
    log("CLEANUP-ERR", `Failed to remove self from config: ${err.message}`);
  });

  // killMyPane is called in the final step of main() (after session.close)
}

// ─── Self-Cleanup: remove self from config.json ───
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
      // spawnSync: safe to run synchronously because this is the last call after all cleanup completes
      spawnSync("tmux", ["kill-pane", "-t", process.env.TMUX_PANE], { stdio: "ignore", timeout: 2000 });
    } catch { /* best effort */ }
  }
}

// ─── Task Auto-Complete: mark in_progress tasks assigned to this agent as completed ───
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
// GPT 5.4 xhigh fixed
const codexEffort = "xhigh";

function truncateOutput(output) {
  if (MAX_RESULT_BYTES > 0 && output.length > MAX_RESULT_BYTES) {
    return output.slice(0, MAX_RESULT_BYTES) +
      `\n\n--- [TRUNCATED: output exceeded ${MAX_RESULT_BYTES / 1024}KB] ---`;
  }
  return output;
}

// ─── Two-stage storage: full result → file, preview → inbox ───
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
    return output; // if short, return as-is
  }
  const preview = output.slice(0, PREVIEW_CHARS).trimEnd();
  return `${preview}\n\n... [Full output (${output.length} chars): ${filePath}]`;
}

async function buildSendText(config, message, filePath) {
  if (!filePath) return message;

  const fullText = await readFile(filePath, "utf-8");
  const storedPath = await saveResultFile(config, fullText);
  const preview = makePreview(fullText, storedPath);

  if (!message) return preview;
  return `${message}\n\n${preview}`;
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
    this.agentName = opts.agentName || null;
    this.teamName = opts.teamName || null;
    this.agentColor = opts.agentColor || null;
    this.useWebSocket = opts.useWebSocket || false;
    this.wsPort = opts.wsPort || null;
    this.ws = null;       // WebSocket connection (ws mode)
    this.child = null;
    this.threadId = null;
    this.sessionFilePath = null;
    this.activeTurnId = null;
    this.acceptTurnStarted = false;
    this.currentTurn = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stdoutBuffer = "";
    this.startPromise = null;
    this.wsRestartPromise = null;
    this.closed = false;
    // lifecycle callbacks
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
    const childEnv = { ...process.env };
    if (this.agentName) childEnv.CODEX_BRIDGE_AGENT_NAME = this.agentName;
    if (this.teamName) childEnv.CODEX_BRIDGE_TEAM_NAME = this.teamName;
    if (this.agentColor) childEnv.CODEX_BRIDGE_AGENT_COLOR = this.agentColor;
    const child = spawn(codexBin, args, {
      stdio: this.useWebSocket ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      cwd: this.cwd,
      env: childEnv,
    });

    this.child = child;
    currentChild = child;

    child.stderr.setEncoding("utf8");

    if (this.useWebSocket && this.wsPort) {
      // WebSocket mode: wait for "listening on" on stderr → connect ws
      child.stderr.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) log("APP-SERVER", text);
      });
      child.on("close", (code, signal) => this.handleClose(child, code, signal));
      child.on("error", (err) => this.handleFatal(err, child));

      // connect WebSocket after readyz
      const wsUrl = `ws://127.0.0.1:${this.wsPort}`;
      log("WS", `waiting for app-server on ${wsUrl}...`);
      await this.waitForReady(this.wsPort);

      const { default: WebSocket } = await import("ws");
      let ws = null;
      let lastWsError = null;
      for (let retry = 0; retry <= 3; retry++) {
        try {
          ws = await new Promise((resolve, reject) => {
            const socket = new WebSocket(wsUrl);
            const cleanup = () => {
              clearTimeout(timer);
              socket.removeListener("open", onOpen);
              socket.removeListener("error", onError);
            };
            const onOpen = () => {
              cleanup();
              resolve(socket);
            };
            const onError = (err) => {
              cleanup();
              try { socket.close(); } catch {}
              reject(err);
            };
            const timer = setTimeout(() => {
              cleanup();
              try { socket.close(); } catch {}
              reject(new Error("WebSocket connect timeout"));
            }, 10000);
            socket.on("open", onOpen);
            socket.on("error", onError);
          });
          break;
        } catch (err) {
          lastWsError = err;
          if (retry >= 3) break;
          log("WS", `retry ${retry + 1}/3...`);
          await sleep(1000);
        }
      }
      if (!ws) throw lastWsError || new Error("WebSocket connect failed");
      this.ws = ws;
      let wsErrorCloseTimer = null;
      const clearWsErrorCloseTimer = () => {
        if (!wsErrorCloseTimer) return;
        clearTimeout(wsErrorCloseTimer);
        wsErrorCloseTimer = null;
      };
      ws.on("message", (data) => {
        if (this.ws !== ws) return;
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
        if (this.ws !== ws) return;
        clearWsErrorCloseTimer();
        log("WS", "WebSocket closed");
        this.ws = null;
        if (!shuttingDown && !this.closed) {
          void this.restartAfterWsClose(new Error("WebSocket closed unexpectedly"));
        }
      });
      ws.on("error", (err) => {
        if (this.ws !== ws) return;
        log("WS", `error: ${err.message}`);
        if (wsErrorCloseTimer) return;
        wsErrorCloseTimer = setTimeout(() => {
          wsErrorCloseTimer = null;
          if (this.ws !== ws) return;
          log("WS", "error without close for 2000ms, forcing close");
          try { ws.close(); } catch {}
        }, 2000);
        wsErrorCloseTimer.unref?.();
      });
      log("WS", "connected to app-server");
    } else {
      // stdio mode (existing)
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this.handleStdout(chunk));
      child.stderr.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) {
          log("APP-SERVER", text);
          this.onError?.("APP-SERVER", text);
        }
      });
      child.on("close", (code, signal) => this.handleClose(child, code, signal));
      child.on("error", (err) => this.handleFatal(err, child));
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
        // use Codex's own model setting (prevent passing a Claude model name)
        baseInstructions: buildBaseInstructions({
          teamGoal: this.teamGoal,
          teamName: this.teamName,
          agentName: this.agentName,
        }),
      };

      const started = await this.sendRequest("thread/start", threadStartParams);
      this.threadId = started?.thread?.id || null;
      if (!this.threadId) {
        throw new Error("thread/start returned no thread id");
      }
      this.sessionFilePath = getCodexSessionFilePath(this.threadId);

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
        sessionFilePath: this.sessionFilePath,
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
        this.sessionFilePath = null;
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

  async waitForChildExit(child, timeoutMs = 5000) {
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        child.removeListener("close", onClose);
        child.removeListener("error", onError);
      };
      const onExit = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`app-server exit timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      child.once("exit", onExit);
      child.once("close", onClose);
      child.once("error", onError);
    });
  }

  isWebSocketAlive() {
    return !!(
      this.useWebSocket &&
      this.ws &&
      this.ws.readyState === 1 &&
      this.child &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    );
  }

  clearTransportState(sourceChild = null) {
    const activeChild = sourceChild || this.child;
    if (activeChild && currentChild === activeChild) currentChild = null;
    if (activeChild && this.child === activeChild) this.child = null;
    this.ws = null;
    this.stdoutBuffer = "";
  }

  resetSessionState() {
    this.acceptTurnStarted = false;
    this.threadId = null;
    this.sessionFilePath = null;
    this.activeTurnId = null;
    if (viewerProc) viewerProc._sessionSent = false;
  }

  failInflight(error) {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
    if (this.currentTurn) {
      this.currentTurn.reject(error);
      this.currentTurn = null;
    }
    this.resetSessionState();
  }

  async restartAfterWsClose(err) {
    if (!this.useWebSocket || this.closed || shuttingDown) return false;
    if (this.wsRestartPromise) return this.wsRestartPromise;

    let restartSucceeded = false;
    this.wsRestartPromise = (async () => {
      const oldChild = this.child;
      const error = new Error(`Codex app-server error: ${err.message}`);
      log("WS", "WebSocket closed unexpectedly, restarting app-server (1/1)");

      nativeTuiSpawning = true;
      closeNativeTuiPane();
      this.ws = null;
      this.stdoutBuffer = "";
      this.failInflight(error);

      if (oldChild && oldChild.exitCode === null && oldChild.signalCode === null) {
        log("APP-SERVER", `stopping old child before restart (pid=${oldChild.pid ?? "unknown"})`);
        oldChild.kill("SIGTERM");
        try {
          await this.waitForChildExit(oldChild, 5000);
        } catch (waitErr) {
          log("APP-SERVER", `${waitErr.message}; sending SIGKILL`);
          try { oldChild.kill("SIGKILL"); } catch {}
          await sleep(1000);
        }
      }
      if (this.child === oldChild) this.child = null;
      if (currentChild === oldChild) currentChild = null;

      this.wsPort = await getRandomPort();
      wsPort = this.wsPort;
      log("WS", `restart with fresh port ${this.wsPort}`);

      await this.ensureStarted();
      restartSucceeded = true;
      log("WS", "app-server restart succeeded");
      return true;
    })().catch((restartErr) => {
      nativeTuiSpawning = false;
      log("WS", `app-server restart failed: ${restartErr.message}`);
      this.handleFatal(new Error(`WebSocket restart failed: ${restartErr.message}`));
      return false;
    }).finally(() => {
      if (!restartSucceeded) {
        this.clearTransportState();
      }
      this.wsRestartPromise = null;
    });

    return this.wsRestartPromise;
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
          // full-auto mode: default-accept unknown approval requests too (compatible with new Codex versions)
          log("APPROVAL", `auto-accepting unknown server request: ${msg.method}`);
          this.sendResponse(msg.id, { decision: "accept" });
      }
    } catch (err) {
      this.sendError(msg.id, -32603, `Approval handler error: ${err.message}`);
    }
  }

  handleNotification(method, params) {
    if (!params) return;

    // ★ Pane renderer: print all notifications as ANSI visual feedback
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

  handleFatal(err, sourceChild = null) {
    if (sourceChild && this.child && sourceChild !== this.child) return;
    this.clearTransportState(sourceChild);
    const error = new Error(`Codex app-server error: ${err.message}`);
    this.failInflight(error);
  }

  handleClose(sourceChild, code, signal) {
    if (sourceChild && this.child && sourceChild !== this.child) return;
    this.clearTransportState(sourceChild);
    const reason = signal
      ? `Codex app-server exited via signal ${signal}`
      : `Codex app-server exited with code ${code}`;
    const error = new Error(reason);
    this.failInflight(error);
  }

  async runTurn(prompt) {
    await this.ensureStarted();
    if (!this.threadId) {
      throw new Error("app-server thread is not initialized");
    }

    // If there is an active turn, append via steer.
    if (this.currentTurn) {
      const activeTurnId = this.activeTurnId || this.currentTurn.turnId;
      if (!activeTurnId) {
        throw new Error("active turn exists but turn id is unknown");
      }
      await this.sendRequest("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: activeTurnId,
        input: [{ type: "text", text: `[STEER — Real-time message from leader]\n${prompt}` }],
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

// ─── Main Poll Loop (Phase 2: bidirectional — poll inbox even during turn execution) ───
async function pollLoop(config) {
  const myInbox = getInboxPath(config.agentName, config.teamName);
  await ensureInbox(myInbox);
  currentPollMs = POLL_INTERVAL_MS;

  // ─── Initialize Message Router ───
  messageRouter = new MessageRouter(config.teamName);

  // lifecycle status events: report intermediate progress to the leader
  let lastStatusSentAt = 0;
  const STATUS_COOLDOWN_MS = 3000;
  function emitStatus(status) {
    const now = Date.now();
    if (now - lastStatusSentAt < STATUS_COOLDOWN_MS) return;
    lastStatusSentAt = now;
    sendToLeader(config, `[STATUS] ${status}`, status).catch(() => {});
    updateBorderStatus(config.agentName);
    // Native TUI mode: show status on a single line in the bridge pane
    if (nativeTuiPaneId) {
      const label = `\x1b[1;36m ${config.agentName} \x1b[0m \x1b[33m${status}\x1b[0m`;
      process.stderr.write(`\r\x1b[2K${label}`);
    }
  }

  // Goal Context: read purpose (description) from team config.json
  const teamGoal = readTeamGoal(config.teamName);
  if (teamGoal) {
    log("GOAL", `team goal: ${teamGoal.slice(0, 100)}`);
  }

  let session = null;

  const spawnNativeTuiForSession = () => {
    if (!config._useNativeTui || !session) return Promise.resolve(null);
    const port = session.wsPort || wsPort;
    if (!port) return Promise.resolve(null);
    nativeTuiSpawning = true;
    return spawnNativeTuiInPlace(
      config.agentName,
      port,
      session.threadId,
      session.sessionFilePath,
      handleNativeTuiAbnormalExit,
    )
      .catch((err) => {
        log("NATIVE-TUI", `spawn error: ${err.message}`);
        return null;
      })
      .finally(() => { nativeTuiSpawning = false; });
  };

  const handleNativeTuiAbnormalExit = async ({ code = null, signal = null, error = null } = {}) => {
    if (!config._useNativeTui || !session || session.closed || shuttingDown) return;
    const detail = error?.message || (signal ? `signal ${signal}` : `code ${code}`);
    if (!session.isWebSocketAlive()) {
      log("NATIVE-TUI", `abnormal exit with WS down (${detail}), restarting app-server`);
      await session.restartAfterWsClose(new Error(`native TUI exited unexpectedly (${detail})`));
      return;
    }
    log("NATIVE-TUI", `abnormal exit but WS is alive (${detail}), restarting TUI`);
    await spawnNativeTuiForSession();
  };

  session = new AppServerSession({
    cwd: process.cwd(),
    effort: codexEffort,
    teamGoal,
    agentName: config.agentName,
    teamName: config.teamName,
    agentColor: config.agentColor,
    useWebSocket: !!config._useNativeTui,
    wsPort: wsPort,
    onStatus: (status) => {
      emitStatus(status);
      // Native TUI: spawn tmux pane when session is ready (resume by threadId)
      if (config._useNativeTui && status === "session ready" && !nativeTuiPaneId && wsPort) {
        void spawnNativeTuiForSession();
      }
    },
    onError: (tag, msg) => {
      logAndRenderError(tag, msg);
      sendToLeader(config, `[ERROR] [${tag}] ${msg}`, `Error: ${tag}`).catch(() => {});
    },
  });

  log("POLL", `inbox: ${myInbox}`);

  // ─── Inbox watch based on fs.watch (also used as polling fallback) ───
  const inboxDir = join(myInbox, "..");
  const inboxBasename = basename(myInbox);
  let watchResolve = null;
  let fsWatcher = null;
  try {
    fsWatcher = fsWatch(inboxDir, { persistent: false }, (eventType, filename) => {
      // React only to changes in my inbox file (prevent thundering herd)
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

  // promise tracking completion of the active turn (null = idle)
  let activeTurnPromise = null;
  // steer serialization chain + queue to hold failures
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

  // prevent duplicate message handling (content hash + time based)
  const DEDUP_MAX = 100;
  const DEDUP_TTL_MS = 60_000; // expires after 60 seconds
  const recentMessageHashes = new Map(); // hash → timestamp
  const recentMessageOrder = []; // { hash, ts } FIFO
  function makeMessageHash(msg) {
    // generate lightweight hash from from + start of text
    const key = `${msg.from}|${msg.text.slice(0, 512)}`;
    let h = 0;
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }
  function isDuplicateMessage(msg) {
    const now = Date.now();
    // clean up expired entries
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

  // turn completion handler: send result to the leader
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

    // include first-line keyword in result summary (easy to distinguish)
    const summaryHint = result.output
      ? result.output.split("\n").find((l) => l.trim())?.slice(0, 60) || ""
      : "";

    if (result.success) {
      // two-stage storage: full result → file, preview → inbox
      const filePath = await saveResultFile(config, result.output).catch((e) => {
        logAndRenderError("SAVE-ERR", `result file save failed: ${e.message}`);
        return null;
      });
      const msg = filePath
        ? makePreview(result.output, filePath)
        : result.output;
      const summary = summaryHint ? `Done: ${summaryHint}` : "Codex task completed";
      // send idle after result delivery completes with await (preserve order)
      await sendToLeaderWithRetry(config, msg, summary);
      if (shutdownRequested) return;
      // mark tasks completed before sending idle (preserve order to prevent rescheduling)
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
      // send idle after result delivery completes with await (preserve order)
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

          // handle shutdown_request: set flag immediately, then wait for active turn to finish
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
                // #4 fix: limit interrupt to 5 seconds too (prevent waiting for old 30s RPC timeout)
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

          // skip protocol messages
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

          // prevent duplicate message handling (detect resend of same message)
          if (isDuplicateMessage(msg)) {
            log("DEDUP", `skipping duplicate message from=${msg.from}, len=${msg.text.length}`);
            continue;
          }

          const taskText = msg.text;

          // ★ Core of Phase 2: if an active turn exists, steer; otherwise start a new turn
          if (activeTurnPromise) {
            if (session.currentTurn) {
              // bidirectional: inject real-time messages into running Codex
              log("STEER", `injecting mid-turn message, len=${taskText.length}`);
              // serialize steer: send next steer only after previous steer finishes
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
                  // if steer fails, store in pendingSteerQueue → handle on next turn
                  enqueuePendingSteer(taskText);
                  logAndRender("STEER-QUEUED", `queued for next turn (${pendingSteerQueue.length} pending)`);
                }
              }).catch(() => {});
            } else {
              log("STEER-STARTING", `turn starting, queuing message (len=${taskText.length})`);
              enqueuePendingSteer(taskText);
            }
          } else {
            // idle state: start a new turn (async — do not block!)
            // if pendingSteerQueue has failed steers, include them in the body
            let fullPrompt = taskText;
            // Goal Context: include team goal in the first-turn prompt
            if (teamGoal && !session.threadId) {
              fullPrompt = `[GOAL] ${teamGoal}\n\n${fullPrompt}`;
            }
            if (pendingSteerQueue.length > 0) {
              const queued = pendingSteerQueue.splice(0);
              log("STEER-DRAIN", `draining ${queued.length} queued steer messages into new turn`);
              fullPrompt = [fullPrompt, ...queued].join("\n\n---\n\n");
            }
            log("TASK", `from=${msg.from}, len=${fullPrompt.length}`);
            // send task acceptance ack to the leader (async, non-blocking)
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
          // fs.watch: wait for event + fallback timeout
          await waitForInboxChange(sawMessages ? POLL_ACTIVE_MS : POLL_FALLBACK_MS);
        } else {
          // fallback: adaptive polling (existing behavior)
          if (!sawMessages) {
            currentPollMs = Math.min(currentPollMs * 2, POLL_IDLE_MS);
          }
          await sleep(currentPollMs);
        }
      }
    }
  } finally {
    // clean up fs.watch
    if (fsWatcher) {
      try { fsWatcher.close(); } catch {}
      fsWatcher = null;
    }
    // flush + cleanup outbox
    if (messageRouter) {
      await messageRouter.flushAll().catch(() => {});
      messageRouter.destroy();
      messageRouter = null;
    }
    // if there is an active turn, wait briefly for completion
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
        // #2 fix: if already shutting down, force exit immediately
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
      // #2 fix: if unable to exit within 5 seconds, force exit
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
      // remove self from config.json even on signal shutdown
      await removeSelfFromConfig(config).catch(() => {});
      closeViewer();
      closeLogFile();
      killMyPane();
      process.exit(sig === "SIGTERM" ? 0 : 1);
    });
  }
}

// ─── Claude Passthrough ───
// If the agent name starts with "claude-", pass through to the original Claude Code binary
function passthroughToClaude() {
  const claudeBin = process.env.CLAUDE_BIN
    || spawnSync("which", ["claude"], { encoding: "utf8", timeout: 3000 }).stdout?.trim()
    || join(homedir(), ".local", "bin", "claude");
  const originalArgs = process.argv.slice(2);

  // Filter bridge-only flags (things that must not be passed to Claude CLI)
  // Note: --agent-name, --team-name, --agent-id, --parent-session-id, and --agent-type
  // are used by the Claude Code team system, so they must not be filtered out
  const BRIDGE_ONLY_FLAGS = new Set([
    "--agent-color"
  ]);
  const filteredArgs = [];
  for (let i = 0; i < originalArgs.length; i++) {
    if (BRIDGE_ONLY_FLAGS.has(originalArgs[i])) {
      i++; // skip value too
      continue;
    }
    if (originalArgs[i] === "--effort") {
      i++; // skip existing --effort value (re-added below)
      continue;
    }
    filteredArgs.push(originalArgs[i]);
  }

  log("PASSTHROUGH", `Forwarding to Claude Code: ${claudeBin}`);

  const child = spawn(claudeBin, [...filteredArgs, "--effort", "high"], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: {
      ...process.env,
      CLAUDE_CODE_TEAMMATE_COMMAND: "",  // prevent bridge recursion
      CLAUDE_CODE_SKIP_TRUST: "1",       // skip trust dialog
    },
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
  if (process.argv[2] === "send") {
    const exitCode = await handleSendCommand(process.argv);
    process.exit(exitCode);
  }

  const config = parseArgs(process.argv);

  if (!config.agentName || !config.teamName) {
    console.error("Usage: codex-bridge.mjs --agent-name NAME --team-name TEAM");
    console.error("Received args:", process.argv.slice(2).join(" "));
    process.exit(1);
  }

  // Initialize as early as possible so ANSI/TUI detection logs are also written to file
  initLogFile(config.agentName);

  // Routing: codex-* → always Codex, claude-* → Claude, otherwise decide by model name
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

  // Set tmux pane title (show worker name)
  if (process.env.TMUX) {
    try {
      spawnSync("tmux", ["select-pane", "-T", `${config.agentName} [idle]`], { stdio: "ignore", timeout: 2000 });
    } catch {}
    setupPaneBorderStatus(); // show title in the top pane border
  }
  _borderAgentName = config.agentName;

  // ─── Native Codex TUI auto-detection ───
  // 1. CODEX_BRIDGE_NATIVE_TUI=1 → force enable
  // 2. codex 0.117+ → auto-enable
  // 3. codex-alpha binary exists → auto-enable
  // 4. CODEX_BRIDGE_NATIVE_TUI=0 → force disable
  let nativeTuiBin = findCodexAlphaBin();
  const codexVersion = getCodexVersion();
  const codexSupportsNativeTui = !!(codexVersion && (() => {
    const m = codexVersion.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return false;
    const [, major, minor] = m.map(Number);
    return major > 0 || minor >= 117;
  })());
  if (!nativeTuiBin && codexSupportsNativeTui) {
    nativeTuiBin = "codex";
    log("TUI-DETECT", "codex 0.117+ detected without dedicated alpha/next bin, using codex fallback");
  }
  const useNativeTui = process.env.CODEX_BRIDGE_NATIVE_TUI !== "0" && (!!nativeTuiBin || codexSupportsNativeTui);
  log("TUI-DETECT", `codex=${codexVersion || "?"}, alpha=${nativeTuiBin || "none"}, supported=${codexSupportsNativeTui}, native=${useNativeTui}`);
  if (useNativeTui) {
    wsPort = await getRandomPort();
    log("NATIVE-TUI", `WebSocket mode enabled, port=${wsPort}, bin=${nativeTuiBin}`);
    // Native TUI pane is spawned after app-server ready (before entering pollLoop)
    config._useNativeTui = true;
    nativeTuiSpawning = true;   // suppress ANSI fallback even for notifications before session ready
  }

  // TUI viewer: disabled by default (ANSI fallback)
  // CODEX_BRIDGE_TUI=1 for Ink viewer, CODEX_BRIDGE_NATIVE_TUI=1 for native TUI
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
    // ANSI fallback (default) — render directly in bridge pane
    log("TUI", "using ANSI fallback (default)");
  }

  setupSignalHandlers(config);
  await pollLoop(config);

  log("EXIT", "bridge shutting down");
  closeNativeTuiPane();
  closeViewer();
  closeLogFile();
  // close the pane after giving the leader time to read shutdown_approved
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
