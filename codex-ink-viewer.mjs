#!/usr/bin/env node
// codex-ink-viewer.mjs — Ink(React for Terminal) 기반 Codex 워커 TUI 뷰어
// FIFO 또는 stdin에서 JSON-line 이벤트를 받아 터미널에 렌더링

import React, { useState, useEffect, useRef, useCallback } from "react";
import { render, Box, Text, useStdout, useApp } from "ink";
import readline from "node:readline";
import { createReadStream } from "node:fs";

// ─── Args ───
function parseArgs(argv) {
  let name = "codex-worker";
  let fifo = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--name" && i + 1 < argv.length) name = argv[++i];
    else if (argv[i] === "--fifo" && i + 1 < argv.length) fifo = argv[++i];
  }
  return { name, fifo };
}

const { name, fifo } = parseArgs(process.argv);

// ─── Content Block Types ───
const BLOCK_AGENT = "agent";
const BLOCK_EXEC = "exec";
const BLOCK_EXEC_OUTPUT = "exec_output";
const BLOCK_DIFF = "diff";
const BLOCK_PLAN = "plan";
const BLOCK_REASONING = "reasoning";
const BLOCK_LABEL = "label";
const BLOCK_ERROR = "error";

// ─── Render Helpers ───

function Header({ name: workerName, status, model, tokens }) {
  const statusColor = status === "active" ? "green" : status === "error" ? "red" : "yellow";
  const dot = status === "active" ? "●" : status === "error" ? "✕" : "○";
  return (
    React.createElement(Box, {
      borderStyle: "single",
      borderBottom: false,
      paddingX: 1,
      justifyContent: "space-between",
    },
      React.createElement(Text, { bold: true },
        React.createElement(Text, { color: statusColor }, dot, " "),
        React.createElement(Text, { color: "cyan" }, workerName),
      ),
      React.createElement(Box, { gap: 2 },
        model ? React.createElement(Text, { dimColor: true }, model) : null,
        React.createElement(Text, { dimColor: true }, `${tokens.toLocaleString()} tokens`),
      ),
    )
  );
}

function StatusBar({ mode, turn }) {
  return (
    React.createElement(Box, {
      borderStyle: "single",
      borderTop: false,
      paddingX: 1,
      justifyContent: "space-between",
    },
      React.createElement(Text, { dimColor: true },
        `mode: `, React.createElement(Text, { color: "cyan" }, mode),
      ),
      React.createElement(Text, { dimColor: true },
        `turn: `, React.createElement(Text, { color: turn === "active" ? "green" : "yellow" }, turn),
      ),
    )
  );
}

function ExecBlock({ command, cwd, exitCode, duration }) {
  const success = exitCode === 0;
  return (
    React.createElement(Box, { flexDirection: "column", marginY: 0 },
      React.createElement(Text, { dimColor: true }, "── exec ─────────────────────────────────"),
      React.createElement(Box, { gap: 1 },
        React.createElement(Text, { color: "gray" }, "$ "),
        React.createElement(Text, { bold: true }, command),
        cwd ? React.createElement(Text, { dimColor: true }, ` (${cwd})`) : null,
      ),
      exitCode != null
        ? React.createElement(Text, { color: success ? "green" : "red" },
            success ? "✓ " : "✕ ",
            `exit ${exitCode}`,
            duration != null ? `  (${duration}ms)` : "",
          )
        : null,
    )
  );
}

function DiffBlock({ lines }) {
  return (
    React.createElement(Box, { flexDirection: "column", marginY: 0 },
      React.createElement(Text, { dimColor: true }, "── diff ─────────────────────────────────"),
      ...lines.map((line, i) => {
        let color = undefined;
        if (line.startsWith("+")) color = "green";
        else if (line.startsWith("-")) color = "red";
        else if (line.startsWith("@@")) color = "cyan";
        return React.createElement(Text, { key: i, color }, line);
      }),
    )
  );
}

function PlanBlock({ steps, explanation }) {
  return (
    React.createElement(Box, { flexDirection: "column", marginY: 0 },
      React.createElement(Text, { dimColor: true }, "── plan ─────────────────────────────────"),
      explanation ? React.createElement(Text, { dimColor: true, italic: true }, explanation) : null,
      ...steps.map((step, i) => {
        let marker = "[ ]";
        let markerColor = "gray";
        if (step.status === "completed") { marker = "[✓]"; markerColor = "green"; }
        if (step.status === "inProgress" || step.status === "in_progress") { marker = "[▸]"; markerColor = "yellow"; }
        return React.createElement(Box, { key: i, gap: 1 },
          React.createElement(Text, { color: markerColor }, marker),
          React.createElement(Text, null, step.step || ""),
        );
      }),
    )
  );
}

const MAX_EXEC_OUTPUT_LINES = 6;

function truncateExecOutput(text) {
  const lines = text.split("\n");
  if (lines.length <= MAX_EXEC_OUTPUT_LINES) return text;
  return lines.slice(0, MAX_EXEC_OUTPUT_LINES).join("\n") + `\n… (${lines.length - MAX_EXEC_OUTPUT_LINES} lines more)`;
}

// 블록 → 텍스트 줄로 변환 (렌더링용)
function blockToLines(block) {
  switch (block.type) {
    case BLOCK_AGENT:
    case BLOCK_REASONING:
      return (block.text || "").split("\n");
    case BLOCK_EXEC:
      return [`── exec ──`, `$ ${block.command}`, block.exitCode != null ? `${block.exitCode === 0 ? "✓" : "✕"} exit ${block.exitCode}${block.duration != null ? `  (${block.duration}ms)` : ""}` : null].filter(Boolean);
    case BLOCK_EXEC_OUTPUT:
      return truncateExecOutput(block.text || "").split("\n");
    case BLOCK_DIFF:
      return ["── diff ──", ...(block.lines || []).slice(0, 20)];
    case BLOCK_PLAN:
      return ["── plan ──", ...(block.steps || []).map(s => {
        const m = s.status === "completed" ? "[✓]" : s.status === "inProgress" || s.status === "in_progress" ? "[▸]" : "[ ]";
        return `${m} ${s.step || ""}`;
      })];
    case BLOCK_LABEL:
      return [block.text || ""];
    case BLOCK_ERROR:
      return [`✕ ${block.text || ""}`];
    default:
      return (block.text || "").split("\n");
  }
}

function ContentArea({ blocks, height, width }) {
  const visibleHeight = Math.max(height - 4, 5); // header + statusbar + borders
  const contentWidth = Math.max((width || 80) - 4, 20); // borders + padding

  // 모든 블록 → 줄 배열로 변환 (wrap 고려)
  const allEntries = [];
  for (const block of blocks) {
    const rawLines = blockToLines(block);
    for (const line of rawLines) {
      // 긴 줄은 터미널 너비에 맞게 줄바꿈 계산
      const wrappedCount = Math.max(1, Math.ceil((line.length || 1) / contentWidth));
      allEntries.push({ line, block, wrappedCount });
    }
  }

  // 아래에서부터 visibleHeight만큼 잘라내기 (auto-scroll)
  let usedHeight = 0;
  let startIdx = allEntries.length;
  for (let i = allEntries.length - 1; i >= 0; i--) {
    usedHeight += allEntries[i].wrappedCount;
    if (usedHeight > visibleHeight) break;
    startIdx = i;
  }
  const visibleEntries = allEntries.slice(startIdx);

  const rendered = visibleEntries.map((entry, i) => {
    const { line, block } = entry;
    switch (block.type) {
      case BLOCK_REASONING:
        return React.createElement(Text, { key: i, color: "gray", italic: true }, line);
      case BLOCK_EXEC:
        if (line.startsWith("── exec")) return React.createElement(Text, { key: i, dimColor: true }, line);
        if (line.startsWith("$")) return React.createElement(Text, { key: i, bold: true }, line);
        if (line.startsWith("✓")) return React.createElement(Text, { key: i, color: "green" }, line);
        if (line.startsWith("✕")) return React.createElement(Text, { key: i, color: "red" }, line);
        return React.createElement(Text, { key: i }, line);
      case BLOCK_EXEC_OUTPUT:
        return React.createElement(Text, { key: i, dimColor: true }, line);
      case BLOCK_DIFF:
        if (line.startsWith("── diff")) return React.createElement(Text, { key: i, dimColor: true }, line);
        if (line.startsWith("+")) return React.createElement(Text, { key: i, color: "green" }, line);
        if (line.startsWith("-")) return React.createElement(Text, { key: i, color: "red" }, line);
        if (line.startsWith("@@")) return React.createElement(Text, { key: i, color: "cyan" }, line);
        return React.createElement(Text, { key: i }, line);
      case BLOCK_PLAN:
        if (line.startsWith("── plan")) return React.createElement(Text, { key: i, dimColor: true }, line);
        if (line.startsWith("[✓]")) return React.createElement(Text, { key: i, color: "green" }, line);
        if (line.startsWith("[▸]")) return React.createElement(Text, { key: i, color: "yellow" }, line);
        return React.createElement(Text, { key: i }, line);
      case BLOCK_LABEL:
        return React.createElement(Text, { key: i, bold: true, color: "cyan" }, line);
      case BLOCK_ERROR:
        return React.createElement(Text, { key: i, color: "red", bold: true }, line);
      default:
        return React.createElement(Text, { key: i }, line);
    }
  });

  return (
    React.createElement(Box, {
      flexDirection: "column",
      borderStyle: "single",
      borderTop: false,
      borderBottom: false,
      paddingX: 1,
      height: visibleHeight,
    }, ...rendered)
  );
}

// ─── Main App ───
function App({ workerName, fifoPath }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [status, setStatus] = useState("waiting");
  const [mode, setMode] = useState("idle");
  const [turn, setTurn] = useState("waiting");
  const [tokens, setTokens] = useState(0);
  const [model, setModel] = useState("");
  const [blocks, setBlocks] = useState([]);

  const stateRef = useRef({
    lastItemId: null,
    itemsWithNewDelta: new Set(),
    commandStates: new Map(),
    itemsWithOutputDelta: new Set(),
    pendingText: "",
    flushTimer: null,
  });

  const FLUSH_MS = 50;

  const flushPendingText = useCallback(() => {
    const st = stateRef.current;
    if (!st.pendingText) return;
    const text = st.pendingText;
    st.pendingText = "";
    setBlocks(prev => {
      const last = prev[prev.length - 1];
      if (last && last.type === BLOCK_AGENT && last.streaming) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { type: BLOCK_AGENT, text, streaming: true }];
    });
  }, []);

  const appendDelta = useCallback((delta) => {
    const st = stateRef.current;
    st.pendingText += delta;
    if (!st.flushTimer) {
      st.flushTimer = setTimeout(() => {
        st.flushTimer = null;
        flushPendingText();
      }, FLUSH_MS);
    }
  }, [flushPendingText]);

  const endStream = useCallback(() => {
    const st = stateRef.current;
    if (st.flushTimer) { clearTimeout(st.flushTimer); st.flushTimer = null; }
    if (st.pendingText) flushPendingText();
    st.lastItemId = null;
    st.itemsWithNewDelta.clear();
    // 마지막 streaming block 닫기
    setBlocks(prev => {
      const last = prev[prev.length - 1];
      if (last && last.streaming) {
        return [...prev.slice(0, -1), { ...last, streaming: false }];
      }
      return prev;
    });
    setMode("idle");
  }, [flushPendingText]);

  const handleNotification = useCallback((method, params = {}) => {
    const st = stateRef.current;
    const resolveItemId = (p) => p.itemId || p.item?.id || p.item?.itemId || null;

    switch (method) {
      case "turn/started": {
        endStream();
        setStatus("active");
        setTurn("active");
        break;
      }

      case "codex/event/agent_message_content_delta": {
        const msg = params.msg || {};
        const itemId = msg.item_id || resolveItemId(params);
        const delta = msg.delta || params.delta || "";
        if (st.lastItemId !== itemId) {
          endStream(); // clear old set first
          st.lastItemId = itemId;
          setMode("agent");
        }
        if (itemId) st.itemsWithNewDelta.add(itemId); // add AFTER endStream
        appendDelta(delta);
        break;
      }

      case "item/agentMessage/delta": {
        const itemId = resolveItemId(params);
        if (itemId && st.itemsWithNewDelta.has(itemId)) break;
        if (st.lastItemId !== itemId) {
          endStream();
          st.lastItemId = itemId;
          setMode("agent");
        }
        appendDelta(params.delta || "");
        break;
      }

      case "item/commandExecution/outputDelta": {
        const itemId = resolveItemId(params);
        if (itemId) st.itemsWithOutputDelta.add(itemId);
        const delta = params.delta || "";
        setBlocks(prev => {
          const last = prev[prev.length - 1];
          if (last && last.type === BLOCK_EXEC_OUTPUT && last.itemId === itemId) {
            return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
          }
          return [...prev, { type: BLOCK_EXEC_OUTPUT, text: delta, itemId }];
        });
        setMode("exec");
        break;
      }

      case "item/reasoning/summaryTextDelta": {
        const delta = params.delta || "";
        setBlocks(prev => {
          const last = prev[prev.length - 1];
          if (last && last.type === BLOCK_REASONING && last.streaming) {
            return [...prev.slice(0, -1), { ...last, text: last.text + delta }];
          }
          return [...prev, { type: BLOCK_REASONING, text: delta, streaming: true }];
        });
        setMode("reasoning");
        break;
      }

      case "item/started": {
        const item = params.item || {};
        const itemId = resolveItemId(params);
        if (item.type === "commandExecution") {
          endStream();
          st.commandStates.set(itemId, {
            command: item.command || "",
            cwd: item.cwd || "",
            startTime: Date.now(),
          });
        } else if (item.type === "fileChange") {
          endStream();
          setMode("file");
        }
        break;
      }

      case "item/completed": {
        const item = params.item || {};
        const itemId = resolveItemId(params);
        if (item.type === "commandExecution") {
          endStream();
          const saved = st.commandStates.get(itemId);
          const command = item.command || saved?.command || "";
          const cwd = item.cwd || saved?.cwd || "";
          const duration = typeof item.durationMs === "number" ? item.durationMs
            : saved?.startTime ? Date.now() - saved.startTime : null;
          setBlocks(prev => [...prev, {
            type: BLOCK_EXEC,
            command, cwd,
            exitCode: item.exitCode ?? null,
            duration,
          }]);
          // aggregatedOutput 표시 (outputDelta 없었을 때)
          if (item.aggregatedOutput && !(itemId && st.itemsWithOutputDelta.has(itemId))) {
            setBlocks(prev => [...prev, { type: BLOCK_EXEC_OUTPUT, text: item.aggregatedOutput }]);
          }
          st.commandStates.delete(itemId);
          st.itemsWithOutputDelta.delete(itemId);
        } else if (item.type === "agentMessage") {
          endStream();
        } else if (item.type === "fileChange") {
          endStream();
          const changes = item.changes || [];
          if (changes.length > 0) {
            const lines = changes.map(c => `+ ${c.path || c.file || ""}`);
            setBlocks(prev => [...prev, { type: BLOCK_DIFF, lines }]);
          }
        }
        break;
      }

      case "turn/plan/updated": {
        endStream();
        setBlocks(prev => [...prev, {
          type: BLOCK_PLAN,
          steps: params.plan || [],
          explanation: params.explanation || "",
        }]);
        break;
      }

      case "turn/diff/updated": {
        endStream();
        const diffLines = String(params.diff || "").split("\n");
        setBlocks(prev => [...prev, { type: BLOCK_DIFF, lines: diffLines }]);
        break;
      }

      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage || {};
        const total = usage.total || {};
        const t = total.totalTokens ?? usage.totalTokens ?? 0;
        setTokens(Number(t) || 0);
        break;
      }

      case "turn/completed": {
        endStream();
        st.commandStates.clear();
        st.itemsWithOutputDelta.clear();
        const turnStatus = params.turn?.status || "completed";
        setStatus(turnStatus === "completed" ? "done" : turnStatus);
        setTurn(turnStatus);
        setMode("idle");
        setBlocks(prev => [...prev, {
          type: BLOCK_LABEL,
          text: `──────── turn ${turnStatus} ────────`,
        }]);
        break;
      }

      case "error": {
        endStream();
        const err = params.error;
        const msg = err?.message || JSON.stringify(err) || "unknown error";
        const retry = params.willRetry ? " (will retry)" : "";
        setBlocks(prev => [...prev, { type: BLOCK_ERROR, text: msg + retry }]);
        setStatus("error");
        setTurn("error");
        break;
      }
    }
  }, [endStream, appendDelta]);

  // FIFO/stdin 읽기
  useEffect(() => {
    const inputStream = fifoPath
      ? createReadStream(fifoPath, { encoding: "utf8" })
      : process.stdin;

    const rl = readline.createInterface({ input: inputStream, terminal: false });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const { method, params } = JSON.parse(line);
        handleNotification(method, params);
      } catch {}
    });

    rl.on("close", () => {
      setTimeout(() => exit(), 500);
    });

    return () => rl.close();
  }, [fifoPath, handleNotification, exit]);

  const rows = stdout?.rows || 24;

  return (
    React.createElement(Box, { flexDirection: "column", height: rows },
      React.createElement(Header, { name: workerName, status, model, tokens }),
      React.createElement(ContentArea, { blocks, height: rows, width: stdout?.columns || 80 }),
      React.createElement(StatusBar, { mode, turn }),
    )
  );
}

// ─── Render ───
const { waitUntilExit } = render(
  React.createElement(App, { workerName: name, fifoPath: fifo }),
);

waitUntilExit().then(() => process.exit(0));
