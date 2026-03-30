// src/auto-memory.mjs — Automatic memory detection and persistence
//
// Two-tier architecture:
//   Tier 1: Cheap regex pre-filter — skips messages that are clearly not memorable
//   Tier 2: LLM classification — asks the model to decide what to save and how
//
// The LLM produces structured JSON: { save: bool, type, name, description, content }
// This handles nuance, multilingual input, and edge cases that regex can't.

import fs from "node:fs";
import path from "node:path";
import { log, getMemoryDir, ensureMemoryDir, getUserMemoryDir, ensureUserMemoryDir } from "./utils.mjs";

// ── Pre-filter (cheap gate — skip obvious non-memorable messages) ──

const SKIP_PATTERNS = [
  /^(?:hi|hello|hey|ok|sure|thanks|yes|no|y|n|lgtm|done|got it)\s*[.!?]?$/i,
  /^(?:\/\w|cloclo\s)/,  // slash commands, tool invocations
  // No "pure queries" filter — "explain my architecture choices" can contain project memory.
  // Let the LLM decide (tier 2). CC baseline confirms: no pre-filter on query intent.
];

const MAX_MSG_LENGTH = 5000; // don't analyze huge messages (code dumps)

function shouldAnalyze(userMessage) {
  if (!userMessage || typeof userMessage !== "string") return false;
  if (userMessage.length < 15) return false;  // too short to contain anything memorable
  if (userMessage.length > MAX_MSG_LENGTH) return false;
  for (const re of SKIP_PATTERNS) {
    if (re.test(userMessage.trim())) return false;
  }
  return true;
}

// ── LLM Classification ──────────────────────────────────────

const CLASSIFY_PROMPT = `You are a memory classifier. Analyze the user message below and decide if it contains information worth saving to long-term memory for future conversations.

Memory types:
- "user": info about the user's role, expertise, preferences, how they work
- "feedback": corrections or guidance about your behavior ("don't do X", "always Y", style preferences)
- "project": ongoing work, deadlines, team structure, architecture decisions, business context
- "reference": pointers to external systems (URLs, tools, dashboards, where things are tracked)

Memory scopes:
- "user": survives across projects and sessions for this user (preferences, workflow, corrections, stable identity)
- "project": specific to the current working directory/project (architecture, deadlines, systems, project references)

Rules:
- Only save things that will be useful in FUTURE conversations, not ephemeral task details
- Don't save things derivable from code, git history, or project files
- Convert relative dates to absolute when possible (today is {TODAY})
- Be selective — most messages should NOT be saved

Respond with EXACTLY one JSON object (no markdown, no explanation):
{"save":false}
or
{"save":true,"scope":"user","type":"feedback","name":"short slug","description":"one-line description for index","content":"the actual memory content to persist"}

Recent conversation context (for understanding the flow):
{HISTORY}

User message:
{MESSAGE}

Context (last assistant response, for understanding corrections):
{CONTEXT}`;

async function classifyWithLLM(client, provider, userMessage, assistantContext, exchangeHistory = []) {
  const today = new Date().toISOString().split("T")[0];
  // Build history string from last 4 exchanges (skip current), ~150 chars each
  const historyStr = exchangeHistory.slice(0, -1).slice(-4).map((ex, i) => {
    const u = (ex.user || "").slice(0, 150);
    const a = (ex.assistant || "").slice(0, 150);
    return `[${i + 1}] User: ${u}${u.length >= 150 ? "…" : ""}\n    Assistant: ${a}${a.length >= 150 ? "…" : ""}`;
  }).join("\n") || "(no prior context)";
  const prompt = CLASSIFY_PROMPT
    .replace("{TODAY}", today)
    .replace("{HISTORY}", historyStr)
    .replace("{MESSAGE}", userMessage.slice(0, 2000))
    .replace("{CONTEXT}", (assistantContext || "").slice(0, 500));

  try {
    // Use a fast/cheap model for classification
    const summaryModel = provider?.capabilities?.summaryModel;
    const model = summaryModel || "claude-haiku-4-5-20251001";

    const body = {
      model,
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    };

    // Collect full response (non-streaming for simplicity)
    let text = "";
    for await (const { event, data } of client.stream(body)) {
      if (event === "content_block_delta" && data?.delta?.text) {
        text += data.delta.text;
      }
    }

    // Parse JSON response — try full text first, then find first { to last }
    // CC baseline: direct JSON.parse with try-catch, no regex extraction
    let result;
    try {
      result = JSON.parse(text.trim());
    } catch {
      const start = text.indexOf("{");
      const end = text.lastIndexOf("}");
      if (start === -1 || end <= start) return null;
      result = JSON.parse(text.slice(start, end + 1));
    }
    if (!result.save) return null;

    // Validate required fields
    if (!result.type || !result.name || !result.content) return null;
    if (!["user", "feedback", "project", "reference"].includes(result.type)) return null;

    return {
      scope: (result.scope === "user" || result.scope === "project")
        ? result.scope
        : (result.type === "user" || result.type === "feedback" ? "user" : "project"),
      type: result.type,
      name: result.name.slice(0, 60),
      description: (result.description || result.content).slice(0, 100),
      content: result.content.slice(0, 500),
    };
  } catch (e) {
    log(`[auto-memory] LLM classification failed: ${e.message}`);
    return null;
  }
}

// ── Throttle / Dedup ─────────────────────────────────────────

const SAVE_COOLDOWN_MS = 60_000; // 1 minute between saves of same type
const CLASSIFY_COOLDOWN_MS = 10_000; // 10s between LLM calls

class AutoMemoryTracker {
  constructor() {
    this._lastSave = new Map();   // key → timestamp
    this._lastClassify = 0;       // last LLM call timestamp
  }

  _key(type, name) {
    return `${type}:${name.toLowerCase().replace(/\s+/g, "-").slice(0, 40)}`;
  }

  shouldSave(type, name) {
    const key = this._key(type, name);
    const last = this._lastSave.get(key);
    if (last && Date.now() - last < SAVE_COOLDOWN_MS) return false;
    return true;
  }

  canClassify() {
    return Date.now() - this._lastClassify >= CLASSIFY_COOLDOWN_MS;
  }

  markSaved(type, name) {
    this._lastSave.set(this._key(type, name), Date.now());
  }

  markClassified() {
    this._lastClassify = Date.now();
  }
}

// ── Memory File Operations ───────────────────────────────────

function _slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50)
    .replace(/-$/, "");
}

function _memoryExists(memDir, slug) {
  try {
    for (const entry of fs.readdirSync(memDir)) {
      if (!entry.endsWith(".md") || entry === "MEMORY.md") continue;
      if (entry.includes(slug)) return true;
    }
  } catch { /* ignore: dir may not exist */ }
  return false;
}

function saveAutoMemory(cwd, scope, type, name, description, content) {
  const dir = scope === "user" ? ensureUserMemoryDir() : ensureMemoryDir(cwd);
  const slug = _slugify(name);
  const filename = `auto_${type}_${slug}.md`;
  const filepath = path.join(dir, filename);

  const fileContent = `---
name: ${name}
description: ${description}
scope: ${scope}
type: ${type}
auto_saved: true
saved_at: ${new Date().toISOString()}
---

${content}
`;

  fs.writeFileSync(filepath, fileContent);
  _updateIndex(dir, filename, description);
  log(`[auto-memory] Saved ${type}: ${name} → ${filename}`);
  return filepath;
}

function _updateIndex(memDir, filename, description) {
  const indexPath = path.join(memDir, "MEMORY.md");
  let index = "";
  try { index = fs.readFileSync(indexPath, "utf-8"); } catch { /* ignore: new index */ }

  if (index.includes(filename)) return;

  const entry = `- [${filename}](${filename}) — ${description}\n`;

  // Prune if near limit
  const lines = index.split("\n");
  if (lines.length >= 190) {
    const pruned = lines.filter(l => !l.includes("auto_") || lines.indexOf(l) > lines.length - 30);
    index = pruned.join("\n");
  }

  index = index.trimEnd() + "\n" + entry;
  fs.writeFileSync(indexPath, index);
}

// ── Auto-Memory Engine ───────────────────────────────────────

class AutoMemory {
  constructor(cwd, client, provider) {
    this.cwd = cwd;
    this._client = client;     // API client for LLM classification
    this._provider = provider; // provider config (for summaryModel)
    this._tracker = new AutoMemoryTracker();
    this._lastAssistant = "";  // last assistant response (for correction context)
  }

  // Called after each user↔assistant exchange
  async processExchange(userMessage, assistantResponse, exchangeHistory = []) {
    this._lastAssistant = assistantResponse || "";

    // Tier 1: cheap pre-filter
    if (!shouldAnalyze(userMessage)) return [];

    // Tier 2: LLM classification (rate-limited)
    if (!this._client || !this._tracker.canClassify()) return [];
    this._tracker.markClassified();

    const result = await classifyWithLLM(
      this._client,
      this._provider,
      userMessage,
      this._lastAssistant,
      exchangeHistory
    );

    if (!result) return [];

    // Dedup check
    const slug = _slugify(result.name);
    const memDir = result.scope === "user" ? getUserMemoryDir() : getMemoryDir(this.cwd);
    if (_memoryExists(memDir, slug)) return [];
    if (!this._tracker.shouldSave(result.type, result.name)) return [];

    // Save
    const filepath = saveAutoMemory(
      this.cwd, result.scope, result.type, result.name, result.description, result.content
    );
    this._tracker.markSaved(result.type, result.name);

    return [{ scope: result.scope, type: result.type, name: result.name, filepath }];
  }
}

// ── Exports ──────────────────────────────────────────────────

export {
  AutoMemory,
  AutoMemoryTracker,
  shouldAnalyze,
  classifyWithLLM,
  saveAutoMemory,
  SKIP_PATTERNS,
};
