#!/usr/bin/env node

import readline from "node:readline";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const blessed = require("blessed");

const RENDER_DEBOUNCE_MS = 50;
const MAX_CONTENT_LINES = 3000;
const DEFAULT_WORKER_NAME = "codex-worker";

function parseArgs(argv) {
  let name = DEFAULT_WORKER_NAME;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--name" && i + 1 < argv.length) {
      name = argv[++i];
    }
  }
  return { name };
}

const { name } = parseArgs(process.argv);

const screen = blessed.screen({
  smartCSR: true,
  title: "Codex TUI Viewer",
  fullUnicode: true,
});

const header = blessed.box({
  top: 0,
  left: 0,
  width: "100%",
  height: 1,
  content: "",
  style: { fg: "white", bg: "blue", bold: true },
});

const content = blessed.box({
  top: 1,
  left: 0,
  width: "100%",
  height: "100%-2",
  scrollable: true,
  alwaysScroll: true,
  scrollbar: { ch: "│", style: { fg: "cyan" } },
  tags: true,
  style: { fg: "white", bg: "black" },
});

const statusBar = blessed.box({
  bottom: 0,
  left: 0,
  width: "100%",
  height: 1,
  content: "",
  style: { fg: "white", bg: "blue" },
});

screen.append(header);
screen.append(content);
screen.append(statusBar);

const state = {
  workerName: name,
  workerStatus: "waiting",
  mode: "idle",
  turn: "waiting",
  tokens: 0,
  lastItemId: null,
  headerPrinted: false,
  lastCommandState: null,
  contentText: "",
  pendingChunks: [],
  renderTimer: null,
  headerDirty: true,
  statusDirty: true,
  exiting: false,
};

const commandStateById = new Map();
const itemsWithOutputDelta = new Set();

function escapeTags(value) {
  return String(value ?? "").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

function updateHeaderStatus(status) {
  if (!status || state.workerStatus === status) return;
  state.workerStatus = status;
  state.headerDirty = true;
  scheduleRender();
}

function updateStatusBar({ mode, turn, tokens } = {}) {
  let changed = false;
  if (typeof mode === "string" && state.mode !== mode) {
    state.mode = mode;
    changed = true;
  }
  if (typeof turn === "string" && state.turn !== turn) {
    state.turn = turn;
    changed = true;
  }
  if (typeof tokens === "number" && Number.isFinite(tokens) && state.tokens !== tokens) {
    state.tokens = tokens;
    changed = true;
  }
  if (changed) {
    state.statusDirty = true;
    scheduleRender();
  }
}

function getScreenWidth() {
  if (typeof screen.width === "number") return screen.width;
  if (typeof process.stdout.columns === "number") return process.stdout.columns;
  return 80;
}

function buildHeaderContent() {
  const left = ` Codex Worker: ${state.workerName} `;
  const right = ` ${state.workerStatus} `;
  const width = getScreenWidth();
  const padding = Math.max(1, width - left.length - right.length);
  return `${left}${" ".repeat(padding)}${right}`;
}

function buildStatusContent() {
  return ` tokens: ${state.tokens.toLocaleString()} │ mode: ${state.mode} │ turn: ${state.turn} `;
}

function flushRender() {
  if (state.pendingChunks.length > 0) {
    state.contentText += state.pendingChunks.join("");
    state.pendingChunks.length = 0;
    const lines = state.contentText.split("\n");
    if (lines.length > MAX_CONTENT_LINES) {
      state.contentText = lines.slice(lines.length - MAX_CONTENT_LINES).join("\n");
    }
    content.setContent(state.contentText);
    content.setScrollPerc(100);
  }

  if (state.headerDirty) {
    header.setContent(buildHeaderContent());
    state.headerDirty = false;
  }

  if (state.statusDirty) {
    statusBar.setContent(buildStatusContent());
    state.statusDirty = false;
  }

  screen.render();
}

function scheduleRender() {
  if (state.renderTimer) return;
  state.renderTimer = setTimeout(() => {
    state.renderTimer = null;
    flushRender();
  }, RENDER_DEBOUNCE_MS);
}

function appendContent(text) {
  if (!text) return;
  state.pendingChunks.push(text);
  scheduleRender();
}

function appendLabel(label) {
  appendContent(`{bold}{cyan-fg}${escapeTags(label)}{/}\n`);
}

function endStreamMode() {
  state.lastItemId = null;
  updateStatusBar({ mode: "idle" });
}

function renderSessionHeader() {
  if (state.headerPrinted) return;
  state.headerPrinted = true;
  appendContent("{bold}{black-bg}--------{/}\n");
}

function resolveItemId(params = {}) {
  const item = params.item || {};
  return params.itemId || item.id || item.itemId || null;
}

function handleNotification(method, params = {}) {
  switch (method) {
    case "turn/started": {
      endStreamMode();
      renderSessionHeader();
      updateHeaderStatus("active");
      updateStatusBar({ turn: "active" });
      break;
    }

    case "item/agentMessage/delta": {
      const itemId = resolveItemId(params);
      if (state.mode !== "agent" || state.lastItemId !== itemId) {
        endStreamMode();
        appendLabel("codex");
        state.lastItemId = itemId;
        updateStatusBar({ mode: "agent" });
      }
      appendContent(escapeTags(params.delta || ""));
      break;
    }

    case "item/commandExecution/outputDelta": {
      const itemId = resolveItemId(params);
      if (itemId) itemsWithOutputDelta.add(itemId);
      if (state.mode !== "exec" || state.lastItemId !== itemId) {
        endStreamMode();
        state.lastItemId = itemId;
        updateStatusBar({ mode: "exec" });
      }
      appendContent(escapeTags(params.delta || ""));
      break;
    }

    case "item/fileChange/outputDelta": {
      const itemId = resolveItemId(params);
      if (state.mode !== "file" || state.lastItemId !== itemId) {
        endStreamMode();
        state.lastItemId = itemId;
        updateStatusBar({ mode: "file" });
      }
      appendContent(`{yellow-fg}${escapeTags(params.delta || "")}{/}`);
      break;
    }

    case "item/reasoning/summaryTextDelta": {
      const itemId = resolveItemId(params);
      if (state.mode !== "reasoning" || state.lastItemId !== itemId) {
        endStreamMode();
        state.lastItemId = itemId;
        updateStatusBar({ mode: "reasoning" });
      }
      appendContent(`{gray-fg}{italic}${escapeTags(params.delta || "")}{/}`);
      break;
    }

    case "item/started": {
      const item = params.item || {};
      const itemId = resolveItemId(params);
      if (item.type === "commandExecution") {
        endStreamMode();
        const commandState = {
          command: item.command || "",
          cwd: item.cwd || "",
          startTime: Date.now(),
        };
        if (itemId) commandStateById.set(itemId, commandState);
        else state.lastCommandState = commandState;
      } else if (item.type === "fileChange") {
        endStreamMode();
        appendLabel("patch");
        updateStatusBar({ mode: "file" });
      } else if (item.type === "webSearch") {
        endStreamMode();
        appendLabel("web search");
      }
      break;
    }

    case "item/completed": {
      const item = params.item || {};
      const itemId = resolveItemId(params);
      if (item.type === "commandExecution") {
        endStreamMode();
        const saved = itemId ? commandStateById.get(itemId) : state.lastCommandState;
        const command = item.command || saved?.command || "";
        const cwd = item.cwd || saved?.cwd || "";
        const durationMs = typeof item.durationMs === "number"
          ? item.durationMs
          : (saved?.startTime ? Date.now() - saved.startTime : null);
        const statusWord = item.exitCode === 0
          ? "{green-fg}succeeded{/}"
          : `{red-fg}failed (exit=${escapeTags(item.exitCode ?? "?")}){/}`;
        const durationText = durationMs == null ? "" : ` in ${escapeTags(durationMs)}ms`;

        appendLabel("exec");
        appendContent(
          `${escapeTags(command)} in ${escapeTags(cwd)} ${statusWord}${durationText}:\n`,
        );
        if (item.aggregatedOutput && !(itemId && itemsWithOutputDelta.has(itemId))) {
          const out = String(item.aggregatedOutput);
          appendContent(escapeTags(out));
          if (!out.endsWith("\n")) appendContent("\n");
        }
        if (itemId) {
          commandStateById.delete(itemId);
          itemsWithOutputDelta.delete(itemId);
        } else {
          state.lastCommandState = null;
        }
      } else if (item.type === "agentMessage") {
        endStreamMode();
      } else if (item.type === "fileChange") {
        endStreamMode();
        for (const change of item.changes || []) {
          const filePath = change.path || change.file || "";
          if (filePath) appendContent(`  {green-fg}+{/} ${escapeTags(filePath)}\n`);
        }
      }
      break;
    }

    case "turn/plan/updated": {
      endStreamMode();
      appendLabel("plan");
      if (params.explanation) {
        appendContent(`{gray-fg}${escapeTags(params.explanation)}{/}\n`);
      }
      for (const step of params.plan || []) {
        let marker = "[ ]";
        if (step.status === "completed") marker = "[{green-fg}x{/}]";
        if (step.status === "inProgress" || step.status === "in_progress") marker = "[{yellow-fg}>{/}]";
        appendContent(`  ${marker} ${escapeTags(step.step || "")}\n`);
      }
      break;
    }

    case "turn/diff/updated": {
      endStreamMode();
      appendLabel("diff");
      const diff = String(params.diff || "");
      for (const line of diff.split("\n")) {
        if (line.startsWith("+")) {
          appendContent(`{green-fg}${escapeTags(line)}{/}\n`);
        } else if (line.startsWith("-")) {
          appendContent(`{red-fg}${escapeTags(line)}{/}\n`);
        } else if (line.startsWith("@@")) {
          appendContent(`{cyan-fg}${escapeTags(line)}{/}\n`);
        } else {
          appendContent(`${escapeTags(line)}\n`);
        }
      }
      break;
    }

    case "thread/tokenUsage/updated": {
      const usage = params.tokenUsage || {};
      const total = usage.total || {};
      const totalTokens = total.totalTokens ?? usage.totalTokens ?? 0;
      updateStatusBar({ tokens: Number(totalTokens) || 0 });
      break;
    }

    case "turn/completed": {
      endStreamMode();
      commandStateById.clear();
      itemsWithOutputDelta.clear();
      const turn = params.turn || {};
      const turnStatus = turn.status || "completed";
      if (state.tokens > 0) {
        appendContent("{bold}tokens used{/}\n");
        appendContent(`${state.tokens.toLocaleString()}\n`);
      }
      appendContent("{bold}{black-bg}--------{/}\n");
      if (turnStatus !== "completed") {
        appendContent(`{red-fg}turn ${escapeTags(turnStatus)}{/}\n`);
      }
      state.headerPrinted = false;
      updateHeaderStatus(turnStatus);
      updateStatusBar({ turn: turnStatus, mode: "idle" });
      break;
    }

    case "error": {
      endStreamMode();
      const err = params.error;
      const willRetry = params.willRetry ? " (will retry)" : "";
      appendContent("{red-fg}{bold}error{/}\n");
      appendContent(`${escapeTags(err?.message || JSON.stringify(err) || "unknown error")}${escapeTags(willRetry)}\n`);
      updateHeaderStatus("error");
      updateStatusBar({ turn: "error", mode: "idle" });
      break;
    }

    default:
      break;
  }
}

function shutdown(code = 0) {
  if (state.exiting) return;
  state.exiting = true;

  if (state.renderTimer) {
    clearTimeout(state.renderTimer);
    state.renderTimer = null;
  }

  try {
    flushRender();
  } catch {}

  try {
    screen.destroy();
  } catch {}

  process.exit(code);
}

screen.key(["q", "C-c"], () => shutdown(0));
screen.on("resize", () => {
  state.headerDirty = true;
  scheduleRender();
});
process.on("SIGTERM", () => shutdown(0));

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on("line", (line) => {
  if (!line || !line.trim()) return;
  try {
    const { method, params } = JSON.parse(line);
    handleNotification(method, params);
  } catch {
    // ignore malformed line
  }
});

rl.on("close", () => shutdown(0));

scheduleRender();
