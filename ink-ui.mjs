// ink-ui.mjs — Ink-based terminal UI for cloclo interactive mode
//
// Components:
//   App                — Root layout with event-driven output pipeline
//   StreamingLine      — Real-time token streaming with cursor
//   PermissionDialog   — Interactive allow/deny/always dialog
//   ToolSpinner        — Active tool execution indicator
//   MarkdownRenderer   — Basic markdown → Ink elements
//   TokenUsageLine     — Per-turn token stats
//   SlashMenu          — Popup command palette
//   StatusBar          — Provider | model | modes | branch | ctx% | cost
//   OutputArea         — Scrollable conversation output
//   ThinkingBlock      — Extended thinking display
//   DiffRenderer       — Colorized diff output
//   HistorySearch      — Ctrl+R fuzzy history search
//   MarketplaceView    — Skill browser
//   ToolCatalogView    — Tool browser

import React, { useState, useEffect, useCallback, useRef } from "react";
import { render, Box, Text, Static, useInput, useApp, useStdout } from "ink";
import TextInput from "ink-text-input";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EXIT } from "./src/utils.mjs";

// ── Utility ──────────────────────────────────────────────────

function truncate(s, max = 80) {
  if (!s) return "";
  const str = typeof s === "string" ? s : JSON.stringify(s);
  return str.length > max ? str.slice(0, max - 3) + "..." : str;
}

function stripAnsi(s) {
  return (s || "").replace(/\x1b\[[0-9;]*m/g, "");
}

// ── Custom Input (handles text + history arrows) ─────────────
// ink-text-input captures arrow keys for cursor movement, preventing
// history navigation. This custom component leaves arrows to the parent useInput.

function CommandInput({ value, onChange, onSubmit, placeholder }) {
  const [cursorPos, setCursorPos] = useState(value.length);
  const [cursorVisible, setCursorVisible] = useState(true);

  // Sync cursor when value changes externally (history navigation)
  useEffect(() => { setCursorPos(value.length); }, [value]);

  // Blink cursor
  useEffect(() => {
    const t = setInterval(() => setCursorVisible(c => !c), 500);
    return () => clearInterval(t);
  }, []);

  useInput((ch, key) => {
    // Arrow up/down and Ctrl+C are NOT handled here — parent useInput gets them
    if (key.upArrow || key.downArrow) return;
    if (key.ctrl && ch === "c") return;

    // Submit
    if (key.return) { onSubmit(value); return; }

    // Arrow left/right for cursor movement within the line
    if (key.leftArrow) { setCursorPos(p => Math.max(0, p - 1)); return; }
    if (key.rightArrow) { setCursorPos(p => Math.min(value.length, p + 1)); return; }

    // Home/End
    if (key.ctrl && ch === "a") { setCursorPos(0); return; }
    if (key.ctrl && ch === "e") { setCursorPos(value.length); return; }

    // Delete
    if (key.backspace || key.delete) {
      if (cursorPos > 0) {
        const newVal = value.slice(0, cursorPos - 1) + value.slice(cursorPos);
        onChange(newVal);
        setCursorPos(cursorPos - 1);
      }
      return;
    }

    // Ctrl+U: clear line
    if (key.ctrl && ch === "u") { onChange(""); setCursorPos(0); return; }

    // Ctrl+W: delete word backwards
    if (key.ctrl && ch === "w") {
      const before = value.slice(0, cursorPos);
      const match = before.match(/^(.*?)\s*\S+\s*$/);
      const newBefore = match ? match[1] : "";
      onChange(newBefore + value.slice(cursorPos));
      setCursorPos(newBefore.length);
      return;
    }

    // Regular character input
    if (ch && !key.ctrl && !key.meta && !key.escape) {
      const newVal = value.slice(0, cursorPos) + ch + value.slice(cursorPos);
      onChange(newVal);
      setCursorPos(cursorPos + ch.length);
    }
  });

  // Render with cursor
  const before = value.slice(0, cursorPos);
  const cursorChar = cursorPos < value.length ? value[cursorPos] : " ";
  const after = value.slice(cursorPos + 1);
  const showPlaceholder = !value && placeholder;

  if (showPlaceholder) {
    return React.createElement(Text, { dimColor: true }, placeholder);
  }

  return React.createElement(Text, {},
    before,
    React.createElement(Text, { inverse: cursorVisible }, cursorChar),
    after,
  );
}

// ── Streaming Line ───────────────────────────────────────────

function StreamingLine({ text, isActive }) {
  const [cursorVisible, setCursorVisible] = useState(true);
  useEffect(() => {
    if (!isActive) return;
    const t = setInterval(() => setCursorVisible(c => !c), 500);
    return () => clearInterval(t);
  }, [isActive]);

  if (!text && !isActive) return null;
  return React.createElement(Text, { wrap: "wrap" },
    text || "",
    isActive && cursorVisible ? "\u258c" : "",
  );
}

// ── Tool Spinner ─────────────────────────────────────────────

const SPINNER_FRAMES = "\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f".split("");

function ToolSpinner({ tools }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (tools.size === 0) return;
    const t = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, [tools.size]);

  if (tools.size === 0) return null;

  return React.createElement(Box, { flexDirection: "column" },
    ...[...tools.values()].map(t => {
      const elapsed = ((Date.now() - t.start) / 1000).toFixed(1);
      const inputSummary = truncate(t.inputSummary || JSON.stringify(t.input), 50);
      return React.createElement(Text, { key: t.name + t.start },
        React.createElement(Text, { color: "cyan" }, SPINNER_FRAMES[frame] + " "),
        React.createElement(Text, { bold: true }, t.name),
        React.createElement(Text, { dimColor: true }, ": " + inputSummary + " (" + elapsed + "s)"),
      );
    })
  );
}

// ── Permission Dialog ────────────────────────────────────────

function PermissionDialog({ toolName, input, message, onResolve }) {
  useInput((ch, key) => {
    if (ch === "y" || key.return) onResolve({ allowed: true, permanent: false });
    else if (ch === "n" || key.escape) onResolve({ allowed: false });
    else if (ch === "a") onResolve({ allowed: true, permanent: true });
  });

  const inputStr = truncate(input, 200);

  return React.createElement(Box, {
    flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 1, marginY: 0,
  },
    React.createElement(Text, { bold: true, color: "yellow" }, "  Permission Required"),
    React.createElement(Text, {}, ""),
    React.createElement(Box, {},
      React.createElement(Text, {}, "  Tool: "),
      React.createElement(Text, { color: "cyan", bold: true }, toolName),
    ),
    React.createElement(Text, { dimColor: true, wrap: "wrap" }, "  " + inputStr),
    message ? React.createElement(Text, { dimColor: true, wrap: "wrap" }, "  " + message) : null,
    React.createElement(Text, {}, ""),
    React.createElement(Box, {},
      React.createElement(Text, { color: "green" }, "  [y]"),
      React.createElement(Text, {}, " Allow  "),
      React.createElement(Text, { color: "red" }, "[n]"),
      React.createElement(Text, {}, " Deny  "),
      React.createElement(Text, { color: "blue" }, "[a]"),
      React.createElement(Text, {}, " Always Allow"),
    ),
  );
}

// ── Token Usage Line ─────────────────────────────────────────

function TokenUsageLine({ usage }) {
  if (!usage) return null;
  const parts = [`${usage.input_tokens || 0} in`, `${usage.output_tokens || 0} out`];
  if (usage.cache_read_input_tokens > 0) parts.push(`${usage.cache_read_input_tokens} cached`);
  return React.createElement(Text, { dimColor: true }, "(" + parts.join(" / ") + ")");
}

// ── Markdown Renderer ────────────────────────────────────────

function MarkdownRenderer({ text }) {
  if (!text) return null;
  const lines = text.split("\n");
  const elements = [];
  let inCodeBlock = false;
  let codeLang = "";
  let codeLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block toggle
    if (line.startsWith("```")) {
      if (inCodeBlock) {
        // End code block
        elements.push(React.createElement(Box, {
          key: "code-" + i, flexDirection: "column", paddingLeft: 2, marginY: 0,
        },
          React.createElement(Text, { dimColor: true }, codeLang ? `\u250c\u2500 ${codeLang} ` + "\u2500".repeat(Math.max(0, 40 - codeLang.length)) : "\u250c" + "\u2500".repeat(42)),
          ...codeLines.map((cl, j) =>
            React.createElement(Text, { key: j }, React.createElement(Text, { dimColor: true }, "\u2502 "),
              ...highlightCode(cl, codeLang))
          ),
          React.createElement(Text, { dimColor: true }, "\u2514" + "\u2500".repeat(42)),
        ));
        codeLines = [];
        inCodeBlock = false;
        codeLang = "";
      } else {
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // Headers
    if (line.startsWith("### ")) {
      elements.push(React.createElement(Text, { key: i, bold: true, color: "blue" }, line.slice(4)));
      continue;
    }
    if (line.startsWith("## ")) {
      elements.push(React.createElement(Text, { key: i, bold: true, color: "blue" }, line.slice(3)));
      continue;
    }
    if (line.startsWith("# ")) {
      elements.push(React.createElement(Text, { key: i, bold: true, color: "cyan" }, line.slice(2)));
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(line) || /^\*{3,}$/.test(line)) {
      elements.push(React.createElement(Text, { key: i, dimColor: true }, "\u2500".repeat(40)));
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      elements.push(React.createElement(Text, { key: i, dimColor: true }, "\u2502 " + line.slice(2)));
      continue;
    }

    // List items
    if (/^[-*]\s/.test(line)) {
      elements.push(React.createElement(Box, { key: i, paddingLeft: 1 },
        React.createElement(Text, {}, "\u2022 "),
        React.createElement(Text, { wrap: "wrap" }, ...renderInline(line.slice(2))),
      ));
      continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const num = line.match(/^(\d+)\./)[1];
      elements.push(React.createElement(Box, { key: i, paddingLeft: 1 },
        React.createElement(Text, { dimColor: true }, num + ". "),
        React.createElement(Text, { wrap: "wrap" }, ...renderInline(line.replace(/^\d+\.\s/, ""))),
      ));
      continue;
    }

    // Empty line
    if (!line.trim()) {
      elements.push(React.createElement(Text, { key: i }, ""));
      continue;
    }

    // Regular text with inline formatting
    elements.push(React.createElement(Text, { key: i, wrap: "wrap" }, ...renderInline(line)));
  }

  return React.createElement(Box, { flexDirection: "column" }, ...elements);
}

// Inline markdown: **bold**, `code`, *italic*, [link](url)
function renderInline(text) {
  const parts = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold
    let m = remaining.match(/^(.*?)\*\*(.+?)\*\*(.*)/s);
    if (m) { if (m[1]) parts.push(m[1]); parts.push(React.createElement(Text, { key: key++, bold: true }, m[2])); remaining = m[3]; continue; }

    // Inline code
    m = remaining.match(/^(.*?)`([^`]+)`(.*)/s);
    if (m) { if (m[1]) parts.push(m[1]); parts.push(React.createElement(Text, { key: key++, color: "cyan" }, m[2])); remaining = m[3]; continue; }

    // Italic
    m = remaining.match(/^(.*?)\*(.+?)\*(.*)/s);
    if (m) { if (m[1]) parts.push(m[1]); parts.push(React.createElement(Text, { key: key++, dimColor: true }, m[2])); remaining = m[3]; continue; }

    // No more patterns
    parts.push(remaining);
    break;
  }
  return parts;
}

// ── Syntax Highlighting (basic regex) ────────────────────────

function highlightCode(line, lang) {
  if (!lang || !["js", "javascript", "ts", "typescript", "jsx", "tsx", "py", "python", "rust", "go", "java", "c", "cpp", "sh", "bash", "zsh"].includes(lang)) {
    return [React.createElement(Text, { key: 0 }, line)];
  }

  const parts = [];
  let remaining = line;
  let key = 0;

  while (remaining.length > 0) {
    // Comments
    let m = remaining.match(/^(.*?)(\/\/.*)$/);
    if (m) { if (m[1]) parts.push(...highlightCode(m[1], lang)); parts.push(React.createElement(Text, { key: key++, dimColor: true }, m[2])); break; }
    m = remaining.match(/^(.*?)(#.*)$/);
    if (lang === "py" || lang === "python" || lang === "sh" || lang === "bash" || lang === "zsh") {
      if (m) { if (m[1]) parts.push(...highlightCode(m[1], lang)); parts.push(React.createElement(Text, { key: key++, dimColor: true }, m[2])); break; }
    }

    // Strings
    m = remaining.match(/^(.*?)(["'`](?:[^"'`\\]|\\.)*?["'`])(.*)/);
    if (m) { if (m[1]) parts.push(...highlightTokens(m[1], lang, key)); key += 10; parts.push(React.createElement(Text, { key: key++, color: "green" }, m[2])); remaining = m[3]; continue; }

    // Keywords and numbers
    parts.push(...highlightTokens(remaining, lang, key));
    break;
  }
  return parts;
}

const JS_KEYWORDS = /\b(const|let|var|function|return|if|else|for|while|class|import|export|async|await|new|this|throw|try|catch|finally|yield|from|of|in|typeof|instanceof|void|delete|switch|case|default|break|continue|do)\b/g;
const PY_KEYWORDS = /\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|raise|with|yield|lambda|pass|break|continue|and|or|not|is|in|True|False|None|self|async|await)\b/g;

function highlightTokens(text, lang, startKey) {
  const kw = (lang === "py" || lang === "python") ? PY_KEYWORDS : JS_KEYWORDS;
  const parts = [];
  let last = 0;
  let key = startKey;
  kw.lastIndex = 0;
  let match;
  while ((match = kw.exec(text)) !== null) {
    if (match.index > last) parts.push(React.createElement(Text, { key: key++ }, text.slice(last, match.index)));
    parts.push(React.createElement(Text, { key: key++, color: "cyan" }, match[0]));
    last = match.index + match[0].length;
  }
  if (last < text.length) {
    // Numbers
    const remainder = text.slice(last);
    const numParts = remainder.split(/(\b\d+\.?\d*\b)/);
    for (const p of numParts) {
      if (/^\d+\.?\d*$/.test(p)) parts.push(React.createElement(Text, { key: key++, color: "yellow" }, p));
      else if (p) parts.push(React.createElement(Text, { key: key++ }, p));
    }
  }
  if (parts.length === 0) parts.push(React.createElement(Text, { key: key }, text));
  return parts;
}

// ── Diff Renderer ────────────────────────────────────────────

function DiffRenderer({ text }) {
  if (!text) return null;
  const lines = text.split("\n");
  return React.createElement(Box, { flexDirection: "column", paddingLeft: 1 },
    ...lines.map((line, i) => {
      if (line.startsWith("+")) return React.createElement(Text, { key: i, color: "green" }, line);
      if (line.startsWith("-")) return React.createElement(Text, { key: i, color: "red" }, line);
      if (line.startsWith("@@")) return React.createElement(Text, { key: i, color: "cyan" }, line);
      return React.createElement(Text, { key: i, dimColor: true }, line);
    })
  );
}

// ── Thinking Block ───────────────────────────────────────────

function ThinkingBlock({ text, isActive, duration }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!isActive) return;
    const t = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, [isActive]);

  const label = isActive
    ? `${SPINNER_FRAMES[frame]} Thinking... (${duration || 0}s)`
    : `Thought for ${duration || 0}s`;

  return React.createElement(Box, { borderStyle: "single", borderColor: "gray", paddingX: 1 },
    React.createElement(Text, { dimColor: true }, label),
  );
}

// ── Slash Menu ───────────────────────────────────────────────

function SlashMenu({ commands, filter, selectedIndex, visible }) {
  if (!visible || commands.length === 0) return null;

  return React.createElement(Box, {
    flexDirection: "column", borderStyle: "single", borderColor: "gray", paddingX: 1, marginBottom: 0,
  },
    React.createElement(Text, { bold: true, dimColor: true }, "Commands"),
    ...commands.map((cmd, i) => {
      const isSelected = i === selectedIndex;
      const nameStr = "/" + cmd.name + (cmd.argumentHint ? " " + cmd.argumentHint : "");
      const aliases = cmd.aliases?.length > 0 ? ` (${cmd.aliases.map(a => "/" + a).join(", ")})` : "";
      const tag = cmd.source === "skill" ? " [skill]" : "";

      return React.createElement(Box, { key: cmd.name },
        React.createElement(Text, {
          color: isSelected ? "black" : (cmd.source === "skill" ? "magenta" : "cyan"),
          backgroundColor: isSelected ? "cyan" : undefined,
        }, nameStr),
        React.createElement(Text, { dimColor: true }, "  " + cmd.description + aliases + tag),
      );
    })
  );
}

// ── Status Bar ───────────────────────────────────────────────

function StatusBar({ cfg, sessionId, messageCount, totalCost, gitBranch, contextPct, lastUsage }) {
  const provider = cfg._provider?.name || "?";
  const model = cfg.model || "?";
  const modes = [];
  if (cfg.briefMode) modes.push("brief");
  if (cfg.thinkingBudget > 0) modes.push("think");
  if (cfg._planMode) modes.push("plan");

  const cwd = (cfg.cwd || "").replace(os.homedir(), "~");
  const session = sessionId ? sessionId.slice(0, 8) : "-";
  const cost = totalCost > 0 ? "$" + totalCost.toFixed(4) : "";

  const parts = [
    React.createElement(Text, { key: "p", dimColor: true }, provider),
    React.createElement(Text, { key: "m", color: "cyan" }, model),
  ];

  if (modes.length > 0) {
    parts.push(React.createElement(Text, { key: "mo", color: "yellow" }, "[" + modes.join(",") + "]"));
  }

  // Context %
  if (contextPct > 0) {
    const ctxColor = contextPct < 60 ? "green" : contextPct < 80 ? "yellow" : "red";
    parts.push(React.createElement(Text, { key: "ctx", color: ctxColor }, "ctx:" + contextPct + "%"));
  }

  if (gitBranch) {
    parts.push(React.createElement(Text, { key: "g", color: "magenta" }, gitBranch));
  }
  parts.push(React.createElement(Text, { key: "c", dimColor: true }, cwd));
  parts.push(React.createElement(Text, { key: "msg", dimColor: true }, messageCount + "msg"));
  if (cost) {
    parts.push(React.createElement(Text, { key: "$", dimColor: true }, cost));
  }

  // Token usage from last turn
  if (lastUsage) {
    const cached = lastUsage.cache_read_input_tokens ? ` ${lastUsage.cache_read_input_tokens}c` : "";
    parts.push(React.createElement(Text, { key: "tok", dimColor: true },
      `${lastUsage.input_tokens || 0}in/${lastUsage.output_tokens || 0}out${cached}`));
  }

  const withSeps = [];
  parts.forEach((p, i) => {
    if (i > 0) withSeps.push(React.createElement(Text, { key: "sep" + i, dimColor: true }, " \u2502 "));
    withSeps.push(p);
  });

  return React.createElement(Box, { borderStyle: "single", borderColor: "gray", paddingX: 1 }, ...withSeps);
}

// ── Output Area ──────────────────────────────────────────────

function OutputArea({ lines }) {
  const staticLines = lines.slice(0, -1);
  const activeLine = lines.length > 0 ? lines[lines.length - 1] : null;

  return React.createElement(Box, { flexDirection: "column", flexGrow: 1 },
    React.createElement(Static, { items: staticLines },
      (line, i) => {
        // Detect if this is a markdown response
        if (typeof line === "object" && line.type === "markdown") {
          return React.createElement(Box, { key: i }, React.createElement(MarkdownRenderer, { text: line.text }));
        }
        if (typeof line === "object" && line.type === "diff") {
          return React.createElement(Box, { key: i }, React.createElement(DiffRenderer, { text: line.text }));
        }
        if (typeof line === "object" && line.type === "usage") {
          return React.createElement(Box, { key: i }, React.createElement(TokenUsageLine, { usage: line.usage }));
        }
        if (typeof line === "object" && line.type === "thinking") {
          return React.createElement(Box, { key: i }, React.createElement(ThinkingBlock, { text: line.text, duration: line.duration, isActive: false }));
        }
        return React.createElement(Text, { key: i, wrap: "wrap" }, String(line));
      }
    ),
    activeLine ? React.createElement(Text, { wrap: "wrap" },
      typeof activeLine === "string" ? activeLine : activeLine.text || String(activeLine)
    ) : null,
  );
}

// ── History Search ───────────────────────────────────────────

function HistorySearch({ history, onSelect, onCancel }) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  const filtered = query
    ? history.filter(h => h.toLowerCase().includes(query.toLowerCase()))
    : history;
  const visible = filtered.slice(0, 10);

  useEffect(() => {
    if (cursor >= visible.length) setCursor(Math.max(0, visible.length - 1));
  }, [visible.length]);

  useInput((ch, key) => {
    if (key.escape) { onCancel(); return; }
    if (key.return && visible.length > 0) { onSelect(visible[cursor]); return; }
    if (key.upArrow) { setCursor(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setCursor(i => Math.min(visible.length - 1, i + 1)); return; }
    if (key.backspace || key.delete) { setQuery(q => q.slice(0, -1)); setCursor(0); return; }
    if (ch && ch.length === 1 && !key.ctrl && !key.meta) { setQuery(q => q + ch); setCursor(0); }
  });

  return React.createElement(Box, { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1 },
    React.createElement(Box, {},
      React.createElement(Text, { color: "cyan" }, "search: "),
      React.createElement(Text, {}, query || React.createElement(Text, { dimColor: true }, "type to filter...")),
    ),
    React.createElement(Text, {}, ""),
    ...visible.map((h, i) =>
      React.createElement(Text, { key: i,
        color: i === cursor ? "black" : undefined,
        backgroundColor: i === cursor ? "cyan" : undefined,
      }, "  " + truncate(h, 70))
    ),
    visible.length === 0 ? React.createElement(Text, { dimColor: true }, "  No matches") : null,
    React.createElement(Text, {}, ""),
    React.createElement(Text, { dimColor: true }, "  Enter to select \u00b7 Esc to cancel"),
  );
}

// ── Spinner Tips ─────────────────────────────────────────────

const TIPS = [
  "Use /share to capture interesting moments",
  "Ctrl+R to search command history",
  "Try /marketplace to browse skills",
  "/compact to free context space",
  "/model to switch models mid-session",
  "/memory to view saved memories",
  "Use @file.ts to reference files in your prompt",
];

function SpinnerTip({ isActive }) {
  const [tipIdx, setTipIdx] = useState(Math.floor(Math.random() * TIPS.length));
  useEffect(() => {
    if (!isActive) return;
    const t = setInterval(() => setTipIdx(i => (i + 1) % TIPS.length), 5000);
    return () => clearInterval(t);
  }, [isActive]);

  if (!isActive) return null;
  return React.createElement(Text, { dimColor: true }, "  \u2192 " + TIPS[tipIdx]);
}

// ── Marketplace View (existing, preserved) ───────────────────

function MarketplaceView({ skills, installed, onInstall, onClose }) {
  const [cursor, setCursor] = useState(0);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [detailIdx, setDetailIdx] = useState(null);
  const [installing, setInstalling] = useState(null);
  const { stdout } = useStdout();
  const maxVisible = Math.max(3, (stdout?.rows || 24) - 10);

  const filtered = search
    ? skills.filter(s =>
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        (s.description || "").toLowerCase().includes(search.toLowerCase()) ||
        (s.author || "").toLowerCase().includes(search.toLowerCase())
      )
    : skills;

  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  useInput((ch, key) => {
    if (installing) return;
    if (detailIdx !== null) { if (key.escape || key.return) setDetailIdx(null); return; }
    if (key.escape) { if (search) { setSearch(""); setCursor(0); } else onClose(); return; }
    if (key.upArrow) { setCursor(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setCursor(i => Math.min(filtered.length - 1, i + 1)); return; }
    if (key.return && filtered.length > 0) { setDetailIdx(cursor); return; }
    if (ch === " " && filtered.length > 0) {
      const s = filtered[cursor];
      if (installed.has(s.name)) return;
      setInstalling(s.name);
      onInstall(s.name).then(() => {
        setInstalling(null);
        installed.add(s.name);
        setSelected(prev => { const n = new Set(prev); n.add(s.name); return n; });
      }).catch(() => setInstalling(null));
      return;
    }
    if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch !== " ") { setSearch(prev => prev + ch); setCursor(0); return; }
    if (key.backspace || key.delete) { setSearch(prev => prev.slice(0, -1)); setCursor(0); return; }
  });

  if (detailIdx !== null && filtered[detailIdx]) {
    const s = filtered[detailIdx];
    const isInst = installed.has(s.name) || selected.has(s.name);
    return React.createElement(Box, { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1 },
      React.createElement(Text, { bold: true, color: "cyan" }, "  " + s.name),
      React.createElement(Text, {}, ""),
      s.description ? React.createElement(Text, { wrap: "wrap" }, "  " + s.description) : null,
      React.createElement(Text, {}, ""),
      s.author ? React.createElement(Text, { dimColor: true }, "  Author:    " + s.author) : null,
      s.version ? React.createElement(Text, { dimColor: true }, "  Version:   " + s.version) : null,
      React.createElement(Text, { dimColor: true }, "  Status:    " + (isInst ? "\u2713 installed" : "not installed")),
      React.createElement(Text, {}, ""),
      React.createElement(Text, { dimColor: true }, "  Esc/Enter to go back" + (!isInst ? " \u00b7 Space to install" : "")),
    );
  }

  const scrollStart = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), filtered.length - maxVisible));
  const visible = filtered.slice(scrollStart, scrollStart + maxVisible);

  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Box, { borderStyle: "round", borderColor: "cyan", paddingX: 1 },
      React.createElement(Text, { bold: true, color: "cyan" }, "Skill Marketplace"),
      React.createElement(Text, { dimColor: true }, "  " + filtered.length + "/" + skills.length + " skills"),
    ),
    React.createElement(Box, { paddingX: 1 },
      React.createElement(Text, { dimColor: true }, "  search: "),
      React.createElement(Text, {}, search || React.createElement(Text, { dimColor: true }, "type to filter")),
    ),
    React.createElement(Text, {}, ""),
    scrollStart > 0 ? React.createElement(Text, { dimColor: true }, "   \u2191 more above") : null,
    ...visible.map((s, i) => {
      const realIdx = scrollStart + i;
      const isCursor = realIdx === cursor;
      const isInst = installed.has(s.name) || selected.has(s.name);
      const icon = isInst ? "\u25c9" : "\u25ef";
      const iconColor = isInst ? "green" : (isCursor ? "cyan" : "gray");
      const desc = truncate(s.description, 50);
      return React.createElement(Box, { key: s.name, flexDirection: "column", paddingLeft: 2 },
        React.createElement(Box, {},
          React.createElement(Text, { color: iconColor }, (isCursor ? "\u25b8 " : "  ") + icon + " "),
          React.createElement(Text, { bold: isCursor, color: isCursor ? "cyan" : undefined }, s.name),
          s.author ? React.createElement(Text, { dimColor: true }, " \u00b7 " + s.author) : null,
        ),
        React.createElement(Text, { dimColor: true }, "      " + desc),
        React.createElement(Text, {}, ""),
      );
    }),
    scrollStart + maxVisible < filtered.length ? React.createElement(Text, { dimColor: true }, "   \u2193 more below") : null,
    installing ? React.createElement(Text, { color: "yellow" }, "  Installing " + installing + "...") : null,
    React.createElement(Text, {}, ""),
    React.createElement(Text, { dimColor: true }, "  type to search \u00b7 Space to install \u00b7 Enter to details \u00b7 Esc to back"),
  );
}

// ── ToolCatalogView (existing, preserved) ────────────────────

function ToolCatalogView({ tools, installed, onInstall, onClose }) {
  const [cursor, setCursor] = useState(0);
  const [search, setSearch] = useState("");
  const [detailIdx, setDetailIdx] = useState(null);
  const [installing, setInstalling] = useState(null);
  const { stdout } = useStdout();
  const maxVisible = Math.max(3, (stdout?.rows || 24) - 10);

  const filtered = search
    ? tools.filter(t =>
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        (t.description || "").toLowerCase().includes(search.toLowerCase())
      )
    : tools;

  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  useInput((ch, key) => {
    if (installing) return;
    if (detailIdx !== null) { if (key.escape || key.return) setDetailIdx(null); return; }
    if (key.escape) { if (search) { setSearch(""); setCursor(0); } else onClose(); return; }
    if (key.upArrow) { setCursor(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setCursor(i => Math.min(filtered.length - 1, i + 1)); return; }
    if (key.return && filtered.length > 0) { setDetailIdx(cursor); return; }
    if (ch === " " && filtered.length > 0) {
      const t = filtered[cursor];
      if (installed.has(t.name)) return;
      setInstalling(t.name);
      onInstall(t.name).then(() => { setInstalling(null); installed.add(t.name); }).catch(() => setInstalling(null));
      return;
    }
    if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch !== " ") { setSearch(prev => prev + ch); setCursor(0); return; }
    if (key.backspace || key.delete) { setSearch(prev => prev.slice(0, -1)); setCursor(0); return; }
  });

  if (detailIdx !== null && filtered[detailIdx]) {
    const t = filtered[detailIdx];
    return React.createElement(Box, { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 1 },
      React.createElement(Text, { bold: true, color: "yellow" }, "  " + t.name),
      React.createElement(Text, {}, ""),
      t.description ? React.createElement(Text, { wrap: "wrap" }, "  " + t.description) : null,
      React.createElement(Text, {}, ""),
      React.createElement(Text, { dimColor: true }, "  Type: " + (t.type || "?")),
      React.createElement(Text, { dimColor: true }, "  Status: " + (installed.has(t.name) ? "\u2713 installed" : "not installed")),
      React.createElement(Text, {}, ""),
      React.createElement(Text, { dimColor: true }, "  Esc/Enter to go back" + (!installed.has(t.name) ? " \u00b7 Space to install" : "")),
    );
  }

  const scrollStart = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), filtered.length - maxVisible));
  const visible = filtered.slice(scrollStart, scrollStart + maxVisible);

  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Box, { borderStyle: "round", borderColor: "yellow", paddingX: 1 },
      React.createElement(Text, { bold: true, color: "yellow" }, "Tool Marketplace"),
      React.createElement(Text, { dimColor: true }, "  " + filtered.length + "/" + tools.length + " tools"),
    ),
    React.createElement(Box, { paddingX: 1 },
      React.createElement(Text, { dimColor: true }, "  search: "),
      React.createElement(Text, {}, search || React.createElement(Text, { dimColor: true }, "type to filter")),
    ),
    React.createElement(Text, {}, ""),
    ...visible.map((t, i) => {
      const realIdx = scrollStart + i;
      const isCursor = realIdx === cursor;
      const isInst = installed.has(t.name);
      return React.createElement(Box, { key: t.name, flexDirection: "column", paddingLeft: 2 },
        React.createElement(Box, {},
          React.createElement(Text, { color: isInst ? "green" : (isCursor ? "yellow" : "gray") }, (isCursor ? "\u25b8 " : "  ") + (isInst ? "\u25c9" : "\u25ef") + " "),
          React.createElement(Text, { bold: isCursor, color: isCursor ? "yellow" : undefined }, t.name),
          React.createElement(Text, { dimColor: true }, "  " + (t.type || "")),
        ),
        React.createElement(Text, { dimColor: true }, "      " + truncate(t.description, 50)),
        React.createElement(Text, {}, ""),
      );
    }),
    React.createElement(Text, {}, ""),
    React.createElement(Text, { dimColor: true }, "  type to search \u00b7 Space to install \u00b7 Enter to details \u00b7 Esc to back"),
  );
}

// ── App (root component) ───────────────────────────────────────

function App({ interactiveMode, onSubmit, onExit }) {
  const [input, setInput] = useState("");
  const [outputLines, setOutputLines] = useState([]);
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuCommands, setMenuCommands] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [streamBuffer, setStreamBuffer] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeTools, setActiveTools] = useState(new Map());
  const [pendingPermission, setPendingPermission] = useState(null);
  const [thinkingText, setThinkingText] = useState("");
  const [thinkingStart, setThinkingStart] = useState(null);
  const [contextPct, setContextPct] = useState(0);
  const [lastUsage, setLastUsage] = useState(null);
  const [marketplaceData, setMarketplaceData] = useState(null);
  const [catalogData, setCatalogData] = useState(null);
  const [historyMode, setHistoryMode] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1); // -1 = current input, 0 = most recent, etc.
  const [savedInput, setSavedInput] = useState(""); // save current input when browsing history
  const { exit } = useApp();

  // Refs for useInput closure (useInput doesn't re-subscribe on state changes)
  const historyRef = useRef([]);
  const historyIndexRef = useRef(-1);
  const inputRef = useRef("");
  const savedInputRef = useRef("");
  useEffect(() => { historyRef.current = history; }, [history]);
  useEffect(() => { historyIndexRef.current = historyIndex; }, [historyIndex]);
  useEffect(() => { inputRef.current = input; }, [input]);
  useEffect(() => { savedInputRef.current = savedInput; }, [savedInput]);

  const im = interactiveMode;

  const [gitBranch] = useState(() => {
    try {
      return execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", { cwd: im.cfg.cwd, encoding: "utf-8", timeout: 2000 }).trim();
    } catch { return ""; }
  });

  // Load command history (same file as readline REPL)
  const histFile = path.join(os.homedir(), ".claude-native", "history");
  useEffect(() => {
    try {
      if (fs.existsSync(histFile)) {
        const lines = fs.readFileSync(histFile, "utf-8").split("\n").filter(Boolean).reverse();
        setHistory([...new Set(lines)].slice(0, 500));
      }
    } catch { /* no history file */ }
  }, []);

  const addOutput = useCallback((line) => {
    setOutputLines(prev => [...prev, line]);
  }, []);

  const flushStream = useCallback(() => {
    setStreamBuffer(buf => {
      if (buf) {
        setOutputLines(prev => [...prev, { type: "markdown", text: buf }]);
      }
      return "";
    });
    setIsStreaming(false);
  }, []);

  // Slash menu
  useEffect(() => {
    if (input.startsWith("/") && !isProcessing) {
      const filter = input.slice(1).split(/\s/)[0].toLowerCase();
      const allCmds = im.slashCommands.list();
      const filtered = filter
        ? allCmds.filter(c => c.name.includes(filter) || c.aliases.some(a => a.includes(filter)) || c.description.toLowerCase().includes(filter))
        : allCmds;
      setMenuCommands(filtered.slice(0, 10));
      setMenuVisible(filtered.length > 0);
      setMenuIndex(0);
    } else {
      setMenuVisible(false);
      setMenuCommands([]);
    }
  }, [input, isProcessing]);

  // Key handling
  useInput((ch, key) => {
    if (pendingPermission || historyMode) return; // dialogs handle their own input

    // Ctrl+C: if processing, this helps terminals that send input instead of SIGINT
    if (key.ctrl && ch === "c") {
      if (!isProcessing) {
        // Not processing → exit
        onExit?.();
      }
      // If processing, SIGINT handler deals with it
      return;
    }

    if (isProcessing) return;

    if (menuVisible) {
      if (key.upArrow) { setMenuIndex(i => Math.max(0, i - 1)); return; }
      if (key.downArrow) { setMenuIndex(i => Math.min(menuCommands.length - 1, i + 1)); return; }
      if (key.tab && menuCommands.length > 0) { setInput("/" + menuCommands[menuIndex].name + " "); return; }
    }

    // Arrow up/down → browse command history
    if (key.upArrow && !menuVisible && historyRef.current.length > 0) {
      const curIdx = historyIndexRef.current;
      if (curIdx === -1) setSavedInput(inputRef.current); // save current input before browsing
      const newIdx = Math.min(curIdx + 1, historyRef.current.length - 1);
      setHistoryIndex(newIdx);
      setInput(historyRef.current[newIdx] || "");
      return;
    }
    if (key.downArrow && !menuVisible && historyIndexRef.current >= 0) {
      const newIdx = historyIndexRef.current - 1;
      setHistoryIndex(newIdx);
      setInput(newIdx >= 0 ? (historyRef.current[newIdx] || "") : savedInputRef.current);
      return;
    }

    // Ctrl+R → history search
    if (key.ctrl && ch === "r") {
      setHistoryMode(true);
      return;
    }

    if (key.escape) {
      if (menuVisible) setMenuVisible(false);
      else if (input) { setInput(""); setHistoryIndex(-1); }
    }
  });

  const handleSubmit = useCallback(async (value) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    setInput("");
    setMenuVisible(false);
    setHistoryIndex(-1);
    setSavedInput("");

    // Add to history and persist
    if (trimmed && !trimmed.startsWith("/exit")) {
      setHistory(prev => {
        const updated = [trimmed, ...prev.filter(h => h !== trimmed)].slice(0, 500);
        // Persist to disk (fire-and-forget)
        try {
          fs.mkdirSync(path.dirname(histFile), { recursive: true });
          fs.writeFileSync(histFile, updated.slice().reverse().join("\n") + "\n");
        } catch { /* non-fatal */ }
        return updated;
      });
    }

    if (menuVisible && menuCommands.length > 0 && trimmed === "/") {
      setInput("/" + menuCommands[menuIndex].name + " ");
      return;
    }

    setIsProcessing(true);
    addOutput("\x1b[36m> " + trimmed + "\x1b[0m");

    try {
      await onSubmit(trimmed, addOutput, {
        // Event-driven callbacks for Ink UI
        onText: (delta) => {
          setIsStreaming(true);
          setStreamBuffer(prev => prev + delta);
        },
        onThinking: (delta) => {
          if (!thinkingStart) setThinkingStart(Date.now());
          setThinkingText(prev => prev + delta);
        },
        onToolUse: (block) => {
          // Flush stream buffer before tool display
          flushStream();
          const inputSummary = block.input?.command || block.input?.file_path || block.input?.pattern || block.input?.description || JSON.stringify(block.input).slice(0, 60);
          setActiveTools(prev => new Map(prev).set(block.id, { name: block.name, input: block.input, inputSummary, start: Date.now() }));
        },
        onToolResult: (id, result, toolName) => {
          setActiveTools(prev => { const m = new Map(prev); m.delete(id); return m; });
          // Show tool result summary
          const content = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
          if (result.is_error) {
            addOutput("\x1b[31m[" + toolName + " error]\x1b[0m");
          } else if (content.includes("\n+") || content.includes("\n-") || content.includes("\n@@")) {
            // Diff output
            addOutput({ type: "diff", text: content.slice(0, 2000) });
          }
        },
        onPermissionRequest: (block, message) => {
          return new Promise(resolve => {
            setPendingPermission({ block, message, resolve });
          });
        },
        onPermissionDeny: (block, msg) => {
          addOutput("\x1b[33m[Denied: " + block.name + "] " + msg + "\x1b[0m");
        },
        onCompact: () => {
          addOutput("\x1b[2m[compacting conversation...]\x1b[0m");
        },
        onTurnComplete: (info) => {
          // Flush stream to output
          flushStream();
          // Thinking block
          if (thinkingText) {
            const duration = thinkingStart ? ((Date.now() - thinkingStart) / 1000).toFixed(1) : "?";
            addOutput({ type: "thinking", text: thinkingText.slice(0, 500), duration });
            setThinkingText("");
            setThinkingStart(null);
          }
          // Token usage
          if (info.usage) {
            addOutput({ type: "usage", usage: info.usage });
            setLastUsage(info.usage);
          }
          if (info.contextPct) setContextPct(info.contextPct);
        },
      });
    } catch (e) {
      flushStream();
      addOutput("\x1b[31mError: " + e.message + "\x1b[0m");
    }

    // Check for overlay data from slash commands (marketplace, catalog)
    if (im._overlayData) {
      const overlay = im._overlayData;
      im._overlayData = null;
      if (overlay.type === "marketplace") setMarketplaceData({ skills: overlay.skills, installed: overlay.installed });
      else if (overlay.type === "catalog") setCatalogData({ tools: overlay.tools, installed: overlay.installed });
    }

    setIsProcessing(false);
  }, [menuVisible, menuCommands, menuIndex, onSubmit, addOutput, flushStream, thinkingStart, thinkingText]);

  // Permission dialog resolution
  const handlePermissionResolve = useCallback((result) => {
    if (pendingPermission) {
      if (result.permanent) {
        im.permissions?.addRule(pendingPermission.block.name, null, "allow");
      }
      pendingPermission.resolve(result.allowed);
      setPendingPermission(null);
    }
  }, [pendingPermission, im.permissions]);

  // Overlays
  if (marketplaceData) {
    return React.createElement(MarketplaceView, {
      skills: marketplaceData.skills, installed: marketplaceData.installed,
      onInstall: async (name) => {
        const cmd = im.slashCommands.get("skill");
        if (cmd?.handler) await cmd.handler(["import", `registry:${name}`]);
      },
      onClose: () => setMarketplaceData(null),
    });
  }
  if (catalogData) {
    return React.createElement(ToolCatalogView, {
      tools: catalogData.tools, installed: catalogData.installed,
      onInstall: async (name) => {
        const cmd = im.slashCommands.get("tool");
        if (cmd?.handler) await cmd.handler(["install", `official:${name}`]);
      },
      onClose: () => setCatalogData(null),
    });
  }
  if (historyMode) {
    return React.createElement(HistorySearch, {
      history,
      onSelect: (entry) => { setHistoryMode(false); setInput(entry); },
      onCancel: () => setHistoryMode(false),
    });
  }

  return React.createElement(Box, { flexDirection: "column", height: "100%" },
    // Output
    React.createElement(OutputArea, { lines: outputLines }),

    // Streaming line (real-time token display)
    streamBuffer ? React.createElement(StreamingLine, { text: streamBuffer, isActive: isStreaming }) : null,

    // Active tool spinners
    activeTools.size > 0 ? React.createElement(ToolSpinner, { tools: activeTools }) : null,

    // Thinking indicator
    thinkingText && isProcessing ? React.createElement(ThinkingBlock, {
      text: thinkingText, isActive: true,
      duration: thinkingStart ? ((Date.now() - thinkingStart) / 1000).toFixed(1) : "0",
    }) : null,

    // Spinner tips
    React.createElement(SpinnerTip, { isActive: isProcessing && activeTools.size === 0 && !streamBuffer }),

    // Permission dialog
    pendingPermission ? React.createElement(PermissionDialog, {
      toolName: pendingPermission.block.name,
      input: pendingPermission.block.input,
      message: pendingPermission.message,
      onResolve: handlePermissionResolve,
    }) : null,

    // Slash menu
    React.createElement(SlashMenu, {
      commands: menuCommands, filter: input.slice(1),
      selectedIndex: menuIndex, visible: menuVisible && !isProcessing,
    }),

    // Input
    pendingPermission ? null : React.createElement(Box, {},
      React.createElement(Text, { color: "cyan" }, isProcessing ? "..." : "> "),
      isProcessing
        ? React.createElement(Text, { dimColor: true }, streamBuffer ? "streaming..." : "thinking...")
        : React.createElement(CommandInput, {
            value: input, onChange: setInput, onSubmit: handleSubmit,
            placeholder: "Type / for commands, \u2191\u2193 for history, or ask anything...",
          }),
    ),

    // Status bar
    React.createElement(StatusBar, {
      cfg: im.cfg, sessionId: im.sessionId,
      messageCount: im.messages.length, totalCost: im.totalCost,
      gitBranch, contextPct, lastUsage,
    }),
  );
}

// ── Public API ─────────────────────────────────────────────────

export function startInkUI(interactiveMode) {
  return new Promise((resolve) => {
    const im = interactiveMode;
    let inkInstance = null;
    let didExit = false;
    let pendingExitCode = EXIT.OK;

    const finish = (exitCode = EXIT.OK) => {
      if (didExit) return;
      didExit = true;
      pendingExitCode = exitCode;
      inkInstance?.unmount();
      resolve({ exitCode });
    };

    const onSubmit = async (input, addOutput, callbacks) => {
      // Bare "/" or "/help"
      if (input === "/" || input === "/help") {
        const cmds = im.slashCommands.list();
        addOutput("\x1b[1m  Commands\x1b[0m");
        for (const c of cmds) {
          const name = "/" + c.name + (c.argumentHint ? " " + c.argumentHint : "");
          const aliases = c.aliases.length > 0 ? ` (${c.aliases.map(a => "/" + a).join(", ")})` : "";
          const tag = c.source === "skill" ? " [skill]" : "";
          addOutput("  \x1b[36m" + name + "\x1b[0m  " + c.description + aliases + tag);
        }
        return;
      }

      // Slash commands
      if (input.startsWith("/")) {
        const [rawCmd, ...args] = input.split(/\s+/);
        const cmdName = rawCmd.slice(1);

        // Skills
        if (im.cfg._skillLoader?.has(cmdName)) {
          addOutput("\x1b[2mRunning skill: /" + cmdName + "\x1b[0m");
          const origWrite = process.stderr.write.bind(process.stderr);
          let buffer = "";
          process.stderr.write = (data) => {
            buffer += data;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) addOutput(line);
            return true;
          };
          try { await im._handleSlashCommand(input); }
          finally { process.stderr.write = origWrite; if (buffer.trim()) addOutput(buffer); }
          return;
        }

        const cmd = im.slashCommands.get(cmdName);
        if (cmd) {
          if (cmd.name === "exit") { finish(EXIT.OK); return; }
          if (cmd.handler) {
            im._inkMode = true; // Tell handler we're in Ink mode (skip text fallback)
            const origWrite = process.stderr.write.bind(process.stderr);
            let captured = "";
            process.stderr.write = (data) => { captured += data; return true; };
            try { await cmd.handler(args); }
            finally { process.stderr.write = origWrite; im._inkMode = false; }
            // Only show captured text if no overlay data (overlay is handled in App.handleSubmit)
            if (!im._overlayData && captured.trim()) {
              for (const line of captured.split("\n")) { if (line.trim()) addOutput(line); }
            }
            return;
          }
        }

        addOutput("\x1b[2mUnknown command: " + rawCmd + "\x1b[0m");
        return;
      }

      // Regular input — run through agent loop with event-driven callbacks
      try {
        await im._processInput(input, callbacks);
      } catch (e) {
        addOutput("\x1b[31mError: " + (e.message || e) + "\x1b[0m");
      }
    };

    const app = React.createElement(App, {
      interactiveMode: im, onSubmit,
      onExit: () => { finish(EXIT.OK); },
    });

    inkInstance = render(app, { exitOnCtrlC: false });

    // Ctrl+C handling: first press cancels current operation, second press quits
    let sigintCount = 0;
    let sigintTimer = null;
    const handleSigint = () => {
      sigintCount++;
      if (sigintTimer) clearTimeout(sigintTimer);
      sigintTimer = setTimeout(() => { sigintCount = 0; }, 2000); // reset after 2s
      if (sigintCount >= 2) {
        // Double Ctrl+C → exit immediately
        finish(128 + 2);
      }
      // Single Ctrl+C → abort current operation (AgentLoop will catch the AbortError)
      // The AbortController is on im.cfg, the AgentLoop checks it each turn
    };
    process.on("SIGINT", handleSigint);

    inkInstance.waitUntilExit().then(() => {
      process.removeListener("SIGINT", handleSigint);
      if (!didExit) resolve({ exitCode: pendingExitCode });
    });
  });
}

export { SlashMenu, StatusBar, OutputArea, App, MarkdownRenderer, PermissionDialog, ToolSpinner, StreamingLine, ThinkingBlock, DiffRenderer, HistorySearch };
