// src/share.mjs — Shareable Memories (Moments)
//
// Capture, sanitize, render, and store interesting conversation exchanges
// as shareable "moments". Supports markdown, HTML, JSON, and SVG formats.

import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "crypto";
import { log, ensureSharesDir, getSharesDir } from "./utils.mjs";

const SHARES_INDEX = "SHARES.md";

// ── Extract ────────────────────────────────────────────────────

/**
 * Extract the Nth-from-last exchange from the messages array.
 * An "exchange" = user message + all subsequent assistant/tool blocks until the next user message.
 * Returns { user, assistant, toolCalls[] } or null.
 */
function extractExchange(messages, n = 1) {
  if (!messages || messages.length === 0) return null;

  // Find user message indices
  const userIndices = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user" && typeof messages[i].content === "string") {
      userIndices.push(i);
    }
  }

  if (userIndices.length === 0) return null;
  const targetIdx = userIndices[userIndices.length - n];
  if (targetIdx === undefined) return null;

  const userMsg = messages[targetIdx];
  const userText = typeof userMsg.content === "string" ? userMsg.content : JSON.stringify(userMsg.content);

  // Collect assistant content and tool calls until next user message
  let assistantText = "";
  const toolCalls = [];
  const nextUserIdx = userIndices.find(i => i > targetIdx) ?? messages.length;

  for (let i = targetIdx + 1; i < nextUserIdx; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        assistantText += msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text") {
            assistantText += block.text;
          } else if (block.type === "tool_use") {
            toolCalls.push({
              name: block.name,
              input_summary: _summarizeInput(block.name, block.input),
              output_summary: null, // filled from tool_result
              _id: block.id,
            });
          }
        }
      }
    } else if (msg.role === "user" && Array.isArray(msg.content)) {
      // tool_result blocks
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          const tc = toolCalls.find(t => t._id === block.tool_use_id);
          if (tc) {
            const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
            tc.output_summary = content.length > 300 ? content.slice(0, 300) + "..." : content;
            tc.is_error = block.is_error || false;
          }
        }
      }
    }
  }

  // Clean up internal IDs
  for (const tc of toolCalls) delete tc._id;

  return { user: userText, assistant: assistantText.trim(), toolCalls };
}

function _summarizeInput(toolName, input) {
  if (!input) return "";
  if (toolName === "Bash") return input.command || "";
  if (toolName === "Read") return input.file_path || "";
  if (toolName === "Edit" || toolName === "Write") return input.file_path || "";
  if (toolName === "Glob") return input.pattern || "";
  if (toolName === "Grep") return `/${input.pattern}/ in ${input.path || "."}`;
  if (toolName === "Agent") return input.description || "";
  if (toolName === "WebFetch") return input.url || "";
  if (toolName === "WebSearch") return input.query || "";
  return JSON.stringify(input).slice(0, 100);
}

// ── Sanitize ───────────────────────────────────────────────────

const SECRET_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /gho_[a-zA-Z0-9]{36}/g,
  /xox[bpras]-[a-zA-Z0-9-]{10,}/g,
  /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, // JWT
  /(?:API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY)\s*[=:]\s*['"]?[^\s'"]{8,}/gi,
];

function sanitize(moment, cwd) {
  const home = os.homedir();
  const cwdResolved = path.resolve(cwd || process.cwd());

  function scrub(text) {
    if (!text) return text;
    // Secrets
    for (const pattern of SECRET_PATTERNS) {
      text = text.replace(new RegExp(pattern.source, pattern.flags), "[REDACTED]");
    }
    // Absolute paths → relative
    if (cwdResolved !== "/") {
      text = text.split(cwdResolved + "/").join("./");
      text = text.split(cwdResolved).join(".");
    }
    // Home dir
    text = text.split(home + "/").join("~/");
    text = text.split(home).join("~");
    return text;
  }

  moment.exchange.user = scrub(moment.exchange.user);
  moment.exchange.assistant = scrub(moment.exchange.assistant);
  for (const tc of moment.exchange.toolCalls || []) {
    tc.input_summary = scrub(tc.input_summary);
    tc.output_summary = scrub(tc.output_summary);
    // Truncate large outputs
    if (tc.output_summary && tc.output_summary.length > 500) {
      tc.output_summary = tc.output_summary.slice(0, 500) + `... (${tc.output_summary.length} chars total)`;
    }
  }
  moment.project = scrub(moment.project);
  return moment;
}

// ── Renderers ──────────────────────────────────────────────────

function renderMarkdown(moment) {
  let md = "";
  md += `# ${moment.title}\n\n`;
  if (moment.description) md += `> ${moment.description}\n\n`;

  md += `## Prompt\n\n`;
  md += `${moment.exchange.user}\n\n`;

  md += `## Response\n\n`;
  md += `${moment.exchange.assistant}\n\n`;

  if (moment.exchange.toolCalls?.length > 0) {
    md += `## Tool Calls\n\n`;
    for (const tc of moment.exchange.toolCalls) {
      const status = tc.is_error ? " (error)" : "";
      md += `- **${tc.name}**: \`${tc.input_summary}\`${status}\n`;
      if (tc.output_summary) {
        const preview = tc.output_summary.split("\n")[0].slice(0, 120);
        md += `  → ${preview}\n`;
      }
    }
    md += "\n";
  }

  if (moment.tags?.length > 0) {
    md += `**Tags**: ${moment.tags.map(t => `\`${t}\``).join(" ")}\n\n`;
  }

  md += `---\n`;
  md += `*Shared from [cloclo](https://github.com/anthropics/claude-code) | ${moment.model} | ${moment.created_at.slice(0, 10)}*\n`;
  return md;
}

function renderHTML(moment) {
  const md = renderMarkdown(moment);
  // Convert basic markdown to HTML (lightweight, no dependency)
  let html = md
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
    .replace(/^- \*\*(.+?)\*\*: `(.+?)`(.*)$/gm, '<li><strong>$1</strong>: <code>$2</code>$3</li>')
    .replace(/^  → (.+)$/gm, '<li class="output">$1</li>')
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^---$/gm, "<hr>")
    .replace(/\n\n/g, "</p><p>")
    .replace(/\n/g, "<br>");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${_escapeHtml(moment.title)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 2rem; max-width: 800px; margin: 0 auto; line-height: 1.6; }
  h1 { color: #f0f6fc; font-size: 1.8rem; margin-bottom: 0.5rem; border-bottom: 1px solid #30363d; padding-bottom: 0.5rem; }
  h2 { color: #8b949e; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 0.05em; margin: 1.5rem 0 0.5rem; }
  blockquote { color: #8b949e; border-left: 3px solid #30363d; padding-left: 1rem; margin: 0.5rem 0; }
  code { background: #161b22; color: #79c0ff; padding: 0.15em 0.4em; border-radius: 4px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85em; }
  pre { background: #161b22; padding: 1rem; border-radius: 8px; overflow-x: auto; margin: 0.5rem 0; }
  li { list-style: none; padding: 0.3rem 0; border-left: 2px solid #238636; padding-left: 0.8rem; margin-left: 0.5rem; }
  li.output { border-left-color: #30363d; color: #8b949e; font-size: 0.9em; }
  strong { color: #f0f6fc; }
  hr { border: none; border-top: 1px solid #30363d; margin: 1.5rem 0; }
  em { color: #8b949e; }
  p { margin: 0.5rem 0; }
  .copy-btn { position: fixed; top: 1rem; right: 1rem; background: #238636; color: #fff; border: none; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
  .copy-btn:hover { background: #2ea043; }
  .tags code { background: #1f2937; color: #a5d6ff; }
</style>
</head>
<body>
${html}
<button class="copy-btn" onclick="navigator.clipboard.writeText(document.body.innerText).then(()=>this.textContent='Copied!')">Copy</button>
</body>
</html>`;
}

function renderJSON(moment) {
  return JSON.stringify(moment, null, 2);
}

function renderSVG(moment) {
  const lines = [];
  const maxWidth = 80;
  const maxLines = 40;

  // Build text content
  lines.push({ text: `  ${moment.title}`, color: "#f0f6fc", bold: true });
  lines.push({ text: "", color: "" });
  lines.push({ text: "  > " + _truncLine(moment.exchange.user, maxWidth - 4), color: "#79c0ff" });
  lines.push({ text: "", color: "" });

  // Assistant response (wrap long lines)
  const respLines = _wrapText(moment.exchange.assistant, maxWidth - 2);
  for (const line of respLines.slice(0, maxLines - 10)) {
    lines.push({ text: "  " + line, color: "#c9d1d9" });
  }
  if (respLines.length > maxLines - 10) {
    lines.push({ text: `  ... (${respLines.length - (maxLines - 10)} more lines)`, color: "#8b949e" });
  }

  // Tool calls
  if (moment.exchange.toolCalls?.length > 0) {
    lines.push({ text: "", color: "" });
    for (const tc of moment.exchange.toolCalls.slice(0, 5)) {
      const icon = tc.is_error ? "\u2717" : "\u2713";
      const color = tc.is_error ? "#f85149" : "#238636";
      lines.push({ text: `  ${icon} ${tc.name}: ${_truncLine(tc.input_summary, maxWidth - tc.name.length - 6)}`, color });
    }
    if (moment.exchange.toolCalls.length > 5) {
      lines.push({ text: `  ... +${moment.exchange.toolCalls.length - 5} more`, color: "#8b949e" });
    }
  }

  // Footer
  lines.push({ text: "", color: "" });
  lines.push({ text: `  cloclo | ${moment.model} | ${moment.created_at.slice(0, 10)}`, color: "#8b949e" });

  // SVG generation
  const charW = 7.8;
  const lineH = 20;
  const padX = 16;
  const padY = 16;
  const chromeH = 36;
  const visibleLines = lines.slice(0, maxLines);
  const width = Math.max(600, maxWidth * charW + padX * 2);
  const height = chromeH + padY * 2 + visibleLines.length * lineH;
  const radius = 10;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" rx="${radius}" fill="#0d1117"/>
<circle cx="20" cy="18" r="6" fill="#f85149"/>
<circle cx="38" cy="18" r="6" fill="#e3b341"/>
<circle cx="56" cy="18" r="6" fill="#238636"/>
<text x="${width / 2}" y="20" text-anchor="middle" fill="#8b949e" font-family="SF Mono,Fira Code,monospace" font-size="11">${_escapeXml(moment.title.slice(0, 50))}</text>
`;

  for (let i = 0; i < visibleLines.length; i++) {
    const { text, color, bold } = visibleLines[i];
    if (!text) continue;
    const y = chromeH + padY + i * lineH;
    const weight = bold ? ' font-weight="bold"' : "";
    svg += `<text x="${padX}" y="${y}" fill="${color || '#c9d1d9'}" font-family="SF Mono,Fira Code,Consolas,monospace" font-size="13"${weight}>${_escapeXml(text)}</text>\n`;
  }

  svg += `</svg>`;
  return svg;
}

function _truncLine(text, max) {
  if (!text) return "";
  const line = text.replace(/\n/g, " ").trim();
  return line.length > max ? line.slice(0, max - 3) + "..." : line;
}

function _wrapText(text, width) {
  if (!text) return [];
  const result = [];
  for (const line of text.split("\n")) {
    if (line.length <= width) {
      result.push(line);
    } else {
      for (let i = 0; i < line.length; i += width) {
        result.push(line.slice(i, i + width));
      }
    }
  }
  return result;
}

function _escapeHtml(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function _escapeXml(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;"); }

// ── Save / List / Load ─────────────────────────────────────────

function saveMoment(cwd, moment, formats = ["markdown", "html", "json", "svg"]) {
  const dir = ensureSharesDir(cwd);
  const id = moment.id;
  const exports = {};

  // Always save raw JSON
  const jsonPath = path.join(dir, `${id}.json`);
  fs.writeFileSync(jsonPath, renderJSON(moment));
  exports.json = jsonPath;

  if (formats.includes("markdown") || formats.includes("all")) {
    const mdPath = path.join(dir, `${id}.md`);
    fs.writeFileSync(mdPath, renderMarkdown(moment));
    exports.markdown = mdPath;
  }

  if (formats.includes("html") || formats.includes("all")) {
    const htmlPath = path.join(dir, `${id}.html`);
    fs.writeFileSync(htmlPath, renderHTML(moment));
    exports.html = htmlPath;
  }

  if (formats.includes("svg") || formats.includes("all")) {
    const svgPath = path.join(dir, `${id}.svg`);
    fs.writeFileSync(svgPath, renderSVG(moment));
    exports.svg = svgPath;
  }

  moment.exports = exports;

  // Update SHARES.md index
  _rebuildSharesIndex(dir);

  return exports;
}

function listMoments(cwd) {
  const dir = getSharesDir(cwd);
  if (!fs.existsSync(dir)) return [];

  const moments = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      moments.push({
        id: raw.id,
        title: raw.title || "Untitled",
        created_at: raw.created_at,
        model: raw.model,
        tags: raw.tags || [],
        formats: Object.keys(raw.exports || {}),
      });
    } catch { /* skip corrupt files */ }
  }
  return moments.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
}

function loadMoment(cwd, id) {
  const dir = getSharesDir(cwd);
  const filePath = path.join(dir, `${id}.json`);
  if (!fs.existsSync(filePath)) {
    // Try partial match
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".json") && f.startsWith(id));
    if (files.length === 1) {
      return JSON.parse(fs.readFileSync(path.join(dir, files[0]), "utf-8"));
    }
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function _rebuildSharesIndex(dir) {
  const moments = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      moments.push(raw);
    } catch { /* skip */ }
  }
  moments.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));

  let index = "# Shared Moments\n\n";
  for (const m of moments) {
    const date = (m.created_at || "").slice(0, 10);
    const tags = m.tags?.length > 0 ? ` (${m.tags.join(", ")})` : "";
    index += `- [${m.title}](${m.id}.json) — ${date}${tags}\n`;
  }
  fs.writeFileSync(path.join(dir, SHARES_INDEX), index);
}

// ── Auto-Suggest Detection ─────────────────────────────────────

function detectShareworthyExchange(exchange, toolUseCount, toolErrors) {
  if (!exchange) return { shareable: false };

  const user = (exchange.user || "").toLowerCase();
  const assistant = (exchange.assistant || "").toLowerCase();
  const tools = exchange.toolCalls || [];
  const errorCount = tools.filter(t => t.is_error).length;

  // Bug fix: user describes problem → tools executed → success indicators
  if ((user.includes("bug") || user.includes("error") || user.includes("fix") || user.includes("broken")) &&
      tools.length >= 2 && errorCount === 0 &&
      (assistant.includes("fixed") || assistant.includes("resolved") || assistant.includes("the issue"))) {
    return { shareable: true, reason: "a successful bug fix" };
  }

  // Big refactor: 3+ file edits across different files
  const editedFiles = new Set(tools.filter(t => t.name === "Edit" || t.name === "Write").map(t => t.input_summary));
  if (editedFiles.size >= 3) {
    return { shareable: true, reason: "a multi-file refactor" };
  }

  // Impressive one-shot: 3+ tools, no errors, single turn
  if (toolUseCount >= 3 && (toolErrors || 0) === 0 && tools.length >= 3) {
    return { shareable: true, reason: "an impressive one-shot implementation" };
  }

  // Resolution: long exchange that ends well
  if (tools.length >= 5 && errorCount === 0 &&
      (user.includes("thanks") || user.includes("perfect") || user.includes("works") || user.includes("great"))) {
    return { shareable: true, reason: "a complex task completed successfully" };
  }

  return { shareable: false };
}

// ── Build Moment ───────────────────────────────────────────────

function buildMoment(exchange, opts = {}) {
  return {
    id: randomUUID().slice(0, 8),
    created_at: new Date().toISOString(),
    session_id: opts.sessionId || null,
    project: opts.cwd || process.cwd(),
    model: opts.model || "unknown",
    provider: opts.provider || "unknown",
    exchange: {
      user: exchange.user || "",
      assistant: exchange.assistant || "",
      toolCalls: exchange.toolCalls || [],
    },
    title: opts.title || exchange.user.slice(0, 60).replace(/\n/g, " ").trim(),
    description: opts.description || null,
    tags: opts.tags || [],
    exports: {},
  };
}

export {
  extractExchange,
  sanitize,
  renderMarkdown,
  renderHTML,
  renderJSON,
  renderSVG,
  saveMoment,
  listMoments,
  loadMoment,
  buildMoment,
  detectShareworthyExchange,
  SHARES_INDEX,
};
