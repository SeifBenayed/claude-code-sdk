// src/tools.mjs — Tool registry, all registrars, document tools, custom tools, official catalog

import { spawn, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import _http from "node:http";
import _https from "node:https";

import { log, sleep, EXIT, _VERSION, _httpGet, getMemoryDir, ensureMemoryDir, getUserMemoryDir, ensureUserMemoryDir } from "./utils.mjs";
import { PhoneManager, PhoneLiveSession } from "./phone.mjs";
import { appendMemoryMetric } from "./memory-metrics.mjs";
import { extractExchange, sanitize, buildMoment, saveMoment, renderMarkdown } from "./share.mjs";
import { detectProvider, PROVIDERS, isOpenAIModel } from "./providers.mjs";
import { isDomainPreapproved, _checkFilePath } from "./security.mjs";
import { TaskBoard } from "./teams.mjs";

// ── Security helpers ────────────────────────────────────────────
function _shellEscape(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

const _SENSITIVE_PATH_SEGMENTS = ['.ssh', '.aws', '.gnupg', '.env', 'credentials'];
function _isSensitivePath(filePath) {
  const fp = path.resolve(filePath);
  for (const s of _SENSITIVE_PATH_SEGMENTS) {
    if (fp.includes(path.sep + s)) return s;
  }
  return null;
}

function _isPrivateUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    // localhost is OK (used for local dev servers)
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.)/.test(hostname)) return true;
    if (hostname.endsWith('.internal') || hostname === 'metadata.google.internal') return true;
    return false;
  } catch { return false; }
}

// ── ToolRegistry ────────────────────────────────────────────────

class ToolRegistry {
  constructor() {
    this._tools = new Map(); // name → { definition, executor, deferred }
    this._allowed = null;
    this._disallowed = null;
    this._cwd = process.cwd();
    this._announcedDeferred = new Set(); // Track deferred tools announced to model
  }

  register(name, definition, executor, { deferred = false } = {}) {
    this._tools.set(name, { definition, executor, deferred });
  }

  _isVisible(name) {
    if (this._disallowed?.includes(name)) return false;
    if (this._allowed && !this._allowed.includes(name)) return false;
    return true;
  }

  // Returns only eager (non-deferred) tool definitions — sent to API every turn
  getDefinitions({ aicl = false } = {}) {
    const defs = [];
    for (const [name, { definition, deferred }] of this._tools) {
      if (!this._isVisible(name)) continue;
      if (deferred) continue;
      const desc = aicl ? (this._getAiclDesc?.(name, definition.description) || definition.description) : definition.description;
      defs.push({ name, description: desc, input_schema: definition.input_schema });
    }
    return defs;
  }

  // Returns ALL tool definitions (eager + deferred) — for sub-agents that need everything
  getAllDefinitions({ aicl = false } = {}) {
    const defs = [];
    for (const [name, { definition }] of this._tools) {
      if (!this._isVisible(name)) continue;
      const desc = aicl ? (this._getAiclDesc?.(name, definition.description) || definition.description) : definition.description;
      defs.push({ name, description: desc, input_schema: definition.input_schema });
    }
    return defs;
  }

  // Returns names of deferred tools (for system-reminder announcement)
  getDeferredNames() {
    const names = [];
    for (const [name, { deferred }] of this._tools) {
      if (!this._isVisible(name)) continue;
      if (deferred) names.push(name);
    }
    return names;
  }

  // Returns deferred tools delta: added/removed since last announcement
  getDeferredDelta() {
    const current = new Set(this.getDeferredNames());
    const added = [...current].filter((n) => !this._announcedDeferred.has(n));
    const removed = [...this._announcedDeferred].filter((n) => !current.has(n));
    this._announcedDeferred = current;
    return { added, removed, all: [...current] };
  }

  // Search deferred tools by query — used by ToolSearch tool
  searchDeferred(query) {
    const results = [];
    // "select:Name1,Name2" — exact match by name
    if (query.startsWith("select:")) {
      const names = query.slice(7).split(",").map((n) => n.trim());
      for (const name of names) {
        const tool = this._tools.get(name);
        if (tool && tool.deferred && this._isVisible(name)) {
          results.push({ name, description: tool.definition.description, input_schema: tool.definition.input_schema });
        }
      }
      return results;
    }

    // "+keyword terms" — require keyword in name, rank by remaining terms
    let requiredInName = null;
    let terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms[0]?.startsWith("+")) {
      requiredInName = terms[0].slice(1);
      terms = terms.slice(1);
    }

    const scored = [];
    for (const [name, { definition, deferred }] of this._tools) {
      if (!this._isVisible(name)) continue;
      if (!deferred) continue;
      const lowerName = name.toLowerCase();
      const lowerDesc = (definition.description || "").toLowerCase();
      if (requiredInName && !lowerName.includes(requiredInName)) continue;
      let score = 0;
      for (const t of terms) {
        if (lowerName.includes(t)) score += 2;
        if (lowerDesc.includes(t)) score += 1;
      }
      // If no search terms (just "+keyword"), give a base score
      if (terms.length === 0 && requiredInName) score = 1;
      if (score > 0 || (terms.length === 0 && !requiredInName)) {
        scored.push({ name, definition, score: score || 0 });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    for (const { name, definition } of scored) {
      results.push({ name, description: definition.description, input_schema: definition.input_schema });
    }
    return results;
  }

  async execute(name, input) {
    const tool = this._tools.get(name);
    if (!tool) return { content: `Unknown tool: ${name}`, is_error: true };
    if (!tool.executor) return null; // External tool — handled by caller
    try {
      const result = await tool.executor(input);
      return typeof result === "string"
        ? { content: result, is_error: false }
        : result;
    } catch (e) {
      return { content: `Error: ${e.message}`, is_error: true };
    }
  }

  has(name) { return this._tools.has(name); }
  isDeferred(name) { const t = this._tools.get(name); return t?.deferred || false; }

  // Promote a deferred tool to eager — makes it appear in getDefinitions() so the API
  // includes it in the tools array. Called by ToolSearch after fetching a schema.
  promote(name) {
    const tool = this._tools.get(name);
    if (tool) {
      tool.deferred = false;
      // Silently remove from announced set so getDeferredDelta doesn't report it as "removed"
      this._announcedDeferred.delete(name);
    }
  }

  unregister(name) { this._tools.delete(name); /* Keep _announcedDeferred so getDeferredDelta detects removal */ }
  isExternal(name) { const t = this._tools.get(name); return t && !t.executor; }

  setFilter(allowed, disallowed) {
    // Asymmetry between allowed/disallowed is intentional:
    //
    // _allowed: extract bare name from "Bash(echo *)" → "Bash" so the tool
    //   stays VISIBLE to the model. The pattern restriction is enforced by
    //   PermissionManager allow rules, not here. If we kept the raw entry,
    //   _allowed.includes("Bash") would fail and the tool would vanish.
    //
    // _disallowed: only include entries WITHOUT a pattern. "Bash(rm *)" should
    //   NOT hide Bash from definitions — PermissionManager deny rules handle
    //   the pattern. Only bare "Bash" (block the whole tool) belongs here.
    const normalizeAllowed = (list) => {
      if (!list || list.length === 0) return null;
      return [...new Set(list.map((entry) => entry.split("(")[0]).filter(Boolean))];
    };
    const normalizeDisallowed = (list) => {
      if (!list || list.length === 0) return null;
      const fullBlock = list.filter((entry) => !entry.includes("(")).map((e) => e.trim()).filter(Boolean);
      return fullBlock.length > 0 ? [...new Set(fullBlock)] : null;
    };
    this._allowed = normalizeAllowed(allowed);
    this._disallowed = normalizeDisallowed(disallowed);
  }
}
// ── Tool Manifest & Management ────────────────────────────────

const TOOL_MANIFEST_PATH = path.join(os.homedir(), ".claude", "tools", ".cloclo-tools.json");
function _loadToolManifest() { try { const d = fs.readFileSync(TOOL_MANIFEST_PATH, "utf-8"); const m = JSON.parse(d); if (!m.tools || typeof m.tools !== "object") return { tools: {} }; return m; } catch { return { tools: {} }; } }
function _saveToolManifest(manifest) { fs.mkdirSync(path.dirname(TOOL_MANIFEST_PATH), { recursive: true }); fs.writeFileSync(TOOL_MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n"); }

function _extractToolEnvRequirements(toolDef) {
  const envReqs = new Set(toolDef._meta?.env_required || toolDef.env || []);
  if (toolDef.headers) {
    for (const value of Object.values(toolDef.headers)) {
      for (const match of String(value).match(/\$\{([A-Z_][A-Z0-9_]*)\}/g) || []) {
        envReqs.add(match.slice(2, -1));
      }
    }
  }
  if (toolDef.url) {
    for (const match of String(toolDef.url).match(/\$\{([A-Z_][A-Z0-9_]*)\}/g) || []) {
      envReqs.add(match.slice(2, -1));
    }
  }
  return [...envReqs];
}

function _buildManifestEntry(toolDef, source, existing = {}, extras = {}) {
  const disabled = extras.disabled ?? existing.disabled ?? false;
  return {
    name: toolDef.name,
    type: toolDef.type,
    source,
    installSource: extras.installSource || existing.installSource || source,
    installedAt: existing.installedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    disabled,
    ...(disabled && existing.disabledAt ? { disabledAt: existing.disabledAt } : {}),
    version: extras.version || toolDef.version || existing.version || null,
    publisher: extras.publisher || toolDef._meta?.author || existing.publisher || null,
    category: extras.category || toolDef._meta?.category || existing.category || null,
    envRequired: _extractToolEnvRequirements(toolDef),
    ...(toolDef.type === "ai" ? { backend: toolDef.backend || "provider", model: toolDef.model, task: toolDef.task, device: toolDef.device || null } : {}),
  };
}

function _classifyToolType(name) {
  if (name.startsWith("mcp__")) return "connector";
  if (["Bash","Read","Write","Edit","Glob","Grep","WebFetch","WebSearch","ToolSearch","NotebookEdit","AskUserQuestion","SendUserMessage","TaskOutput","Agent","Browser","MemoryList","MemoryRead","MemorySave","MemoryForget","MemoryShare","PhoneCall","SendSMS","Screenshot"].includes(name)) return "builtin";
  if (name.startsWith("Task") || name.startsWith("Enter") || name.startsWith("Exit") || name.startsWith("ListMcp") || name.startsWith("ReadMcp")) return "builtin";
  return "custom";
}

function toolList(cfg, registry) {
  if (!registry) { process.stderr.write("Error: tool list requires an active session.\n"); return; }
  const manifest = _loadToolManifest(); const allTools = [];
  for (const [name, { definition, deferred }] of registry._tools) { const type = _classifyToolType(name); const enabled = !manifest.tools[name]?.disabled; allTools.push({ name, description: (definition.description || "").slice(0, 60), type, deferred, enabled }); }
  allTools.sort((a, b) => { const order = { builtin: 0, custom: 1, connector: 2 }; if (a.type !== b.type) return (order[a.type] || 3) - (order[b.type] || 3); return a.name.localeCompare(b.name); });
  if (allTools.length === 0) { process.stderr.write("No tools registered.\n"); return; }
  const nameW = Math.max(20, ...allTools.map(t => t.name.length)) + 2;
  process.stderr.write(`\n  ${"Name".padEnd(nameW)}${"Type".padEnd(12)}${"State".padEnd(10)}Description\n  ${"─".repeat(nameW)}${"─".repeat(12)}${"─".repeat(10)}${"─".repeat(30)}\n`);
  for (const t of allTools) { const state = !t.enabled ? "\x1b[31mdisabled\x1b[0m" : t.deferred ? "\x1b[2mdeferred\x1b[0m" : "\x1b[32menabled \x1b[0m"; const tc = t.type === "builtin" ? "36" : t.type === "connector" ? "35" : "33"; process.stderr.write(`  ${t.name.padEnd(nameW)}\x1b[${tc}m${t.type.padEnd(12)}\x1b[0m${state}  ${t.description}\n`); }
  const eager = allTools.filter(t => !t.deferred && t.enabled).length; const deferred = allTools.filter(t => t.deferred && t.enabled).length; const disabled = allTools.filter(t => !t.enabled).length;
  process.stderr.write(`\n  ${allTools.length} tools (${eager} active, ${deferred} deferred${disabled ? `, ${disabled} disabled` : ""})\n\n`);
}

function toolInfo(cfg, registry, name) {
  if (!name) { process.stderr.write("Usage: cloclo tool info <name>\n"); return; } if (!registry) { process.stderr.write("Error: tool info requires an active session.\n"); return; }
  const tool = registry._tools.get(name); if (!tool) { process.stderr.write(`Tool not found: ${name}\n`); return; }
  const manifest = _loadToolManifest(); const entry = manifest.tools[name] || {}; const type = _classifyToolType(name);
  process.stderr.write(`\n  Name:        ${name}\n  Description: ${tool.definition.description || "(none)"}\n  Type:        ${type}\n  Deferred:    ${tool.deferred ? "yes" : "no"}\n  Enabled:     ${entry.disabled ? "no" : "yes"}\n`);
  if (PROTECTED_TOOLS.has(name)) process.stderr.write(`  Protected:   yes (cannot be disabled)\n`);
  if (name.startsWith("mcp__")) { const parts = name.split("__"); process.stderr.write(`  MCP server:  ${parts[1]}\n`); }
  if (tool.definition.input_schema?.properties) { const params = Object.keys(tool.definition.input_schema.properties); const required = tool.definition.input_schema.required || []; process.stderr.write(`  Parameters:  ${params.map(p => required.includes(p) ? p : p + "?").join(", ")}\n`); }
  // Type-specific fields from TOOL.json on disk
  try {
    const toolJsonPath = path.join(CUSTOM_TOOLS_DIR, name, "TOOL.json");
    if (fs.existsSync(toolJsonPath)) {
      const td = JSON.parse(fs.readFileSync(toolJsonPath, "utf-8"));
      if (td.type === "cli") {
        process.stderr.write(`  Binary:      ${td.binary}\n`);
        if (td.parse_mode) process.stderr.write(`  Parse mode:  ${td.parse_mode}\n`);
        if (td.read_only !== undefined) process.stderr.write(`  Read-only:   ${td.read_only ? "yes" : "no"}\n`);
        if (Array.isArray(td.env) && td.env.length > 0) process.stderr.write(`  Env required:${td.env.map(v => " " + v + (process.env[v] ? " ✓" : " ✗")).join(",")}\n`);
        if (td.healthcheck) process.stderr.write(`  Healthcheck: ${td.healthcheck.join(" ")}\n`);
        if (td.install_hint) process.stderr.write(`  Install:     ${td.install_hint}\n`);
      }
      if (td.type === "http") {
        process.stderr.write(`  URL:         ${td.url}\n`);
        process.stderr.write(`  Method:      ${td.method}\n`);
        if (td.timeout) process.stderr.write(`  Timeout:     ${td.timeout}ms\n`);
        if (td.auth_env) process.stderr.write(`  Auth env:    ${td.auth_env}${process.env[td.auth_env] ? " ✓" : " ✗"}\n`);
        if (td.healthcheck_url) process.stderr.write(`  Healthcheck: ${td.healthcheck_url}\n`);
        if (td.error_map) process.stderr.write(`  Error map:   ${Object.keys(td.error_map).join(", ")}\n`);
        if (td.read_only !== undefined) process.stderr.write(`  Read-only:   ${td.read_only ? "yes" : "no"}\n`);
      }
    }
  } catch { /* no TOOL.json on disk — skip type-specific fields */ }
  if (entry.source) process.stderr.write(`  Source:      ${entry.source}\n`);
  if (entry.installSource && entry.installSource !== entry.source) process.stderr.write(`  Install via: ${entry.installSource}\n`);
  if (entry.version) process.stderr.write(`  Version:     ${entry.version}\n`);
  if (entry.publisher) process.stderr.write(`  Publisher:   ${entry.publisher}\n`);
  if (entry.backend) process.stderr.write(`  Backend:     ${entry.backend}\n`);
  if (entry.model) process.stderr.write(`  Model:       ${entry.model}\n`);
  if (Array.isArray(entry.envRequired) && entry.envRequired.length > 0) process.stderr.write(`  Env req:     ${entry.envRequired.join(", ")}\n`);
  if (entry.installedAt) process.stderr.write(`  Installed:   ${entry.installedAt.slice(0, 10)}\n`);
  process.stderr.write(`\n`);
}

function toolEnable(cfg, registry, name) {
  if (!name) { process.stderr.write("Usage: cloclo tool enable <name>\n"); return; } if (!registry?.has(name)) { process.stderr.write(`Tool not found: ${name}\n`); return; }
  const manifest = _loadToolManifest(); if (manifest.tools[name]) { delete manifest.tools[name].disabled; delete manifest.tools[name].disabledAt; _saveToolManifest(manifest); }
  if (registry._disallowed) { registry._disallowed = registry._disallowed.filter(t => t !== name); if (registry._disallowed.length === 0) registry._disallowed = null; }
  process.stderr.write(`Enabled: ${name}\n`);
}

const PROTECTED_TOOLS = new Set(["Read", "Glob", "Grep", "ToolSearch", "Agent", "AskUserQuestion"]);

function toolDisable(cfg, registry, name) {
  if (!name) { process.stderr.write("Usage: cloclo tool disable <name>\n"); return; } if (!registry?.has(name)) { process.stderr.write(`Tool not found: ${name}\n`); return; }
  if (PROTECTED_TOOLS.has(name)) { process.stderr.write(`Cannot disable ${name}: core tool required for cloclo to function.\n  Protected: ${[...PROTECTED_TOOLS].join(", ")}\n`); return; }
  const manifest = _loadToolManifest(); if (!manifest.tools[name]) manifest.tools[name] = {}; manifest.tools[name].disabled = true; manifest.tools[name].disabledAt = new Date().toISOString(); _saveToolManifest(manifest);
  if (!registry._disallowed) registry._disallowed = []; if (!registry._disallowed.includes(name)) registry._disallowed.push(name);
  process.stderr.write(`Disabled: ${name}\n`);
}

async function toolTest(cfg, registry, name) {
  if (!name) { process.stderr.write("Usage: cloclo tool test <name>\n"); return; } if (!registry?.has(name)) { process.stderr.write(`Tool not found: ${name}\n`); return; }
  const tool = registry._tools.get(name); process.stderr.write(`Testing ${name}...\n`);
  if (!tool.executor) { process.stderr.write(`  \x1b[32m✓\x1b[0m Registered${name.startsWith("mcp__") ? ` (MCP: ${name.split("__")[1]})` : " (external)"}\n`); return; }

  // Type-specific testing for custom tools
  try {
    const toolJsonPath = path.join(CUSTOM_TOOLS_DIR, name, "TOOL.json");
    if (fs.existsSync(toolJsonPath)) {
      const td = JSON.parse(fs.readFileSync(toolJsonPath, "utf-8"));

      if (td.type === "cli") {
        // 1. Check binary — auto-install if missing
        const toolDir = path.join(CUSTOM_TOOLS_DIR, name);
        const installResult = await _autoInstallBinary(td.binary, td.install_hint, toolDir, registry);
        if (installResult.error) { process.stderr.write(`  \x1b[31m✗\x1b[0m ${installResult.error}\n`); return; }
        process.stderr.write(`  \x1b[32m✓\x1b[0m Binary found: ${installResult.path}${installResult.installed ? " (just installed)" : ""}\n`);
        // 2. Check env vars
        const missing = _checkRequiredEnvVars(td);
        if (missing.length > 0) { process.stderr.write(`  \x1b[33m!\x1b[0m Missing env vars: ${missing.join(", ")}\n`); }
        else if (Array.isArray(td.env) && td.env.length > 0) { process.stderr.write(`  \x1b[32m✓\x1b[0m Env vars present\n`); }
        // 3. Healthcheck
        if (td.healthcheck) {
          try { execSync(td.healthcheck.join(" "), { encoding: "utf-8", timeout: 5000, stdio: "pipe" }); process.stderr.write(`  \x1b[32m✓\x1b[0m Healthcheck passed: ${td.healthcheck.join(" ")}\n`); }
          catch (e) { process.stderr.write(`  \x1b[31m✗\x1b[0m Healthcheck failed: ${(e.stderr || e.message).trim().slice(0, 100)}\n`); }
        }
        return;
      }

      if (td.type === "http") {
        // 1. Check env vars
        const missing = _checkRequiredEnvVars(td);
        if (missing.length > 0) { process.stderr.write(`  \x1b[33m!\x1b[0m Missing env vars: ${missing.join(", ")}\n`); }
        else { process.stderr.write(`  \x1b[32m✓\x1b[0m Env vars OK\n`); }
        // 2. Healthcheck URL
        if (td.healthcheck_url) {
          try {
            await new Promise((resolve, reject) => {
              const parsed = new URL(td.healthcheck_url);
              const mod = parsed.protocol === "https:" ? _https : _http;
              const req = mod.get(td.healthcheck_url, { timeout: 5000, headers: { "User-Agent": "cloclo-tool-test/1.0" } }, (res) => {
                res.resume();
                if (res.statusCode < 500) { process.stderr.write(`  \x1b[32m✓\x1b[0m Healthcheck reachable: ${td.healthcheck_url} (${res.statusCode})\n`); resolve(); }
                else { process.stderr.write(`  \x1b[31m✗\x1b[0m Healthcheck error: ${td.healthcheck_url} (${res.statusCode})\n`); resolve(); }
              });
              req.on("error", (e) => {
                if (e.code === "ECONNREFUSED") process.stderr.write(`  \x1b[31m✗\x1b[0m Healthcheck unreachable: ${td.healthcheck_url} (connection refused)\n`);
                else if (e.code === "ENOTFOUND") process.stderr.write(`  \x1b[31m✗\x1b[0m Healthcheck unreachable: ${td.healthcheck_url} (DNS not found)\n`);
                else process.stderr.write(`  \x1b[31m✗\x1b[0m Healthcheck error: ${e.message}\n`);
                resolve();
              });
              req.on("timeout", () => { req.destroy(); process.stderr.write(`  \x1b[31m✗\x1b[0m Healthcheck timed out: ${td.healthcheck_url}\n`); resolve(); });
            });
          } catch { /* handled above */ }
        } else { process.stderr.write(`  \x1b[2m○\x1b[0m No healthcheck_url configured\n`); }
        return;
      }
    }
  } catch { /* not a custom tool with TOOL.json — fall through to generic test */ }

  // Generic test for builtins
  const testInputs = { Bash: { command: "echo ok", timeout: 5000 }, Read: { file_path: "/dev/null" }, Glob: { pattern: "*.nonexistent-cloclo-test" }, Grep: { pattern: "cloclo-nonexistent-test", path: "/dev/null" }, WebFetch: null, WebSearch: null };
  const input = testInputs[name]; if (input === null) { process.stderr.write(`  \x1b[32m✓\x1b[0m Registered\n  \x1b[2m○\x1b[0m Skipped (requires external input)\n`); return; }
  if (input === undefined && !tool.deferred) { process.stderr.write(`  \x1b[32m✓\x1b[0m Registered\n  \x1b[2m○\x1b[0m No safe test input defined\n`); return; }
  if (tool.deferred) { process.stderr.write(`  \x1b[32m✓\x1b[0m Registered (deferred)\n`); return; }
  try { const start = Date.now(); const result = await registry.execute(name, input); const elapsed = Date.now() - start;
    if (result?.is_error) process.stderr.write(`  \x1b[31m✗\x1b[0m Execution failed: ${(result.content || "").slice(0, 100)}\n`);
    else process.stderr.write(`  \x1b[32m✓\x1b[0m Executed OK (${elapsed}ms)\n`);
  } catch (e) { process.stderr.write(`  \x1b[31m✗\x1b[0m Error: ${e.message}\n`); }
}

// ── Custom Tools (TOOL.json) ──────────────────────────────────

const CUSTOM_TOOLS_DIR = path.join(os.homedir(), ".claude", "tools");

function _validateToolJson(toolDef) {
  const errors = [];
  if (!toolDef.name || typeof toolDef.name !== "string") errors.push("'name' is required (string)");
  if (toolDef.name && !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(toolDef.name)) errors.push("'name' must start with letter, alphanumeric/hyphens/underscores");
  if (!toolDef.description) errors.push("'description' is required");
  if (!["shell", "cli", "http", "ai"].includes(toolDef.type)) errors.push("'type' must be one of: shell, cli, http, ai");
  if (!toolDef.input_schema || typeof toolDef.input_schema !== "object") errors.push("'input_schema' is required (object)");
  if (toolDef.type === "shell") { if (!toolDef.command) errors.push("shell tools require 'command'"); if (toolDef.read_only === undefined) errors.push("shell tools must declare 'read_only' (true/false)"); }
  if (toolDef.type === "cli") {
    if (!toolDef.binary) errors.push("cli tools require 'binary' (path to executable)");
    if (!["json", "text", "lines"].includes(toolDef.parse_mode || "text")) errors.push("cli parse_mode must be one of: json, text, lines");
    if (toolDef.read_only === undefined) errors.push("cli tools must declare 'read_only' (true/false)");
  }
  if (toolDef.type === "http") { if (!toolDef.url) errors.push("http tools require 'url'"); if (!toolDef.method) errors.push("http tools require 'method'"); if (!toolDef.timeout) errors.push("http tools require 'timeout'"); }
  if (toolDef.type === "ai") { if (!toolDef.task) errors.push("ai tools require 'task'"); if (!toolDef.model) errors.push("ai tools require 'model'");
    const validBackends = ["provider", "ollama", "openai-compatible", "transformers"];
    if (toolDef.backend && !validBackends.includes(toolDef.backend)) errors.push(`ai backend must be one of: ${validBackends.join(", ")}`);
    if (toolDef.backend === "openai-compatible" && !toolDef.base_url) errors.push("openai-compatible backend requires 'base_url'");
    if (toolDef.backend === "transformers") { const validTasks = ["classify","translation","ocr","rerank","stt","text-generation","summarization","fill-mask","ner","sentiment"]; if (toolDef.task && !validTasks.includes(toolDef.task)) errors.push(`transformers task must be one of: ${validTasks.join(", ")}`);
      if (toolDef.device && !["cpu", "cuda", "mps", "auto"].includes(toolDef.device)) errors.push("device must be one of: cpu, cuda, mps, auto"); }
  }
  return errors;
}

// ── Env var interpolation for tool definitions ────────────────
function _interpolateEnvVars(str) {
  if (typeof str !== "string") return str;
  return str.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name) => {
    const val = process.env[name];
    if (val === undefined) throw new Error(`Required env var ${name} is not set`);
    return val;
  });
}

function _checkRequiredEnvVars(toolDef) {
  const missing = [];
  // Check env array (cli tools)
  if (Array.isArray(toolDef.env)) { for (const v of toolDef.env) { if (!process.env[v]) missing.push(v); } }
  // Check auth_env (http tools)
  if (toolDef.auth_env && !process.env[toolDef.auth_env]) missing.push(toolDef.auth_env);
  // Check ${VAR} in headers
  if (toolDef.headers) { for (const val of Object.values(toolDef.headers)) { const matches = String(val).match(/\$\{([A-Z_][A-Z0-9_]*)\}/g) || []; for (const m of matches) { const name = m.slice(2, -1); if (!process.env[name]) missing.push(name); } } }
  return missing;
}

function _resolveBinary(binary, toolDir) {
  // Relative paths (./script.sh) resolve from the tool's directory
  if (binary.startsWith("./") || binary.startsWith("../")) {
    if (binary.includes("..")) throw new Error(`Binary path must not escape tool directory: ${binary}`);
    const resolved = toolDir ? path.resolve(toolDir, binary) : path.resolve(binary);
    return resolved;
  }
  // Absolute paths used as-is
  if (path.isAbsolute(binary)) return binary;
  // Bare names: resolve via PATH
  try { return execSync(`which ${binary}`, { encoding: "utf-8", timeout: 5000 }).trim(); } catch { return null; }
}

// ── Binary auto-install + discovery ───────────────────────────

// ── Binary auto-install via discovery ─────────────────────────
// Flow: which → install_hint → WebSearch discovery → install → verify

async function _discoverInstallCommand(binary, registry) {
  // Use WebSearch (if available in registry) to find the install command dynamically
  const platform = process.platform === "darwin" ? "macOS" : process.platform === "linux" ? "Linux" : process.platform;
  const query = `install ${binary} CLI ${platform} terminal command`;
  // Try WebSearch tool if registry is available
  if (registry?.has("WebSearch")) {
    try {
      const result = await registry.execute("WebSearch", { query, max_results: 3 });
      if (result && !result.is_error && result.content) {
        // Extract install command from search results
        const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
        // Look for common install patterns
        const patterns = [
          /(?:^|\n)\s*(brew install\s+\S+)/m,
          /(?:^|\n)\s*(npm install -g\s+\S+)/m,
          /(?:^|\n)\s*(pip install\s+\S+)/m,
          /(?:^|\n)\s*(sudo apt(?:-get)? install(?:\s+-y)?\s+\S+)/m,
          /(?:^|\n)\s*(curl\s+-[fsSL]+\s+\S+\s*\|\s*(?:ba)?sh)/m,
          /(?:^|\n)\s*(cargo install\s+\S+)/m,
          /(?:^|\n)\s*(go install\s+\S+)/m,
        ];
        for (const pat of patterns) {
          const m = text.match(pat);
          if (m) return m[1].trim();
        }
      }
    } catch { /* WebSearch not available or failed */ }
  }
  // Fallback: try common package managers directly (fast, no network)
  if (process.platform === "darwin") {
    try { execSync(`brew info ${binary} 2>/dev/null`, { encoding: "utf-8", timeout: 8000, stdio: "pipe" }); return `brew install ${binary}`; } catch { /* not in brew */ }
  }
  try { execSync(`npm view ${binary} name 2>/dev/null`, { encoding: "utf-8", timeout: 8000, stdio: "pipe" }); return `npm install -g ${binary}`; } catch { /* not in npm */ }
  return null;
}

async function _autoInstallBinary(binary, installHint, toolDir, registry) {
  // 1. Already installed?
  const existing = _resolveBinary(binary, toolDir);
  if (existing && fs.existsSync(existing)) return { installed: false, path: existing };

  // 2. Determine install command: hint > discovery
  const installCmd = installHint || await _discoverInstallCommand(binary, registry);
  if (!installCmd) return { installed: false, path: null, error: `Binary not found: ${binary}. No install_hint provided and discovery found nothing. Add "install_hint" to TOOL.json.` };

  // 3. Suggest install command instead of auto-executing
  process.stderr.write(`  \x1b[33m!\x1b[0m Binary "${binary}" not found. Suggested install: ${installCmd}\n`);
  process.stderr.write(`  Run it manually, then retry.\n`);
  return { installed: false, path: null, error: `Binary "${binary}" not found. Install manually: ${installCmd}` };
}

function _createShellExecutor(toolDef) { const timeout = toolDef.timeout || 30000; return async (input) => { let cmd = toolDef.command; cmd = cmd.replace(/\$INPUT_JSON/g, _shellEscape(JSON.stringify(input))); for (const [k, v] of Object.entries(input || {})) cmd = cmd.replace(new RegExp(`\\$${k.toUpperCase()}`, "g"), _shellEscape(String(v))); try { return { content: execSync(cmd, { encoding: "utf-8", timeout, cwd: toolDef.cwd || process.cwd(), env: { ...process.env, ...(toolDef.env || {}) }, maxBuffer: 10 * 1024 * 1024 }), is_error: false }; } catch (e) { return { content: e.stderr || e.message, is_error: true }; } }; }

// ── CLI executor (type: "cli") ────────────────────────────────
function _createCliExecutor(toolDef, toolDir) {
  const timeout = toolDef.timeout || 30000;
  const parseMode = toolDef.parse_mode || "text";
  const successCodes = new Set(toolDef.success_exit_codes || [0]);
  return async (input) => {
    // Check required env vars
    const missing = _checkRequiredEnvVars(toolDef);
    if (missing.length > 0) return { content: `Missing required env vars: ${missing.join(", ")}`, is_error: true };
    // Resolve binary — auto-install if missing
    const installResult = await _autoInstallBinary(toolDef.binary, toolDef.install_hint, toolDir, toolDef._registry);
    if (installResult.error) return { content: installResult.error, is_error: true };
    const binPath = installResult.path;
    // Build args from template — if a template is ONLY a variable (e.g. "$ARGS"), split its value as shell args
    const args = [];
    for (const a of (toolDef.args_template || [])) {
      let s = a.replace(/\$INPUT_JSON/g, JSON.stringify(input));
      for (const [k, v] of Object.entries(input || {})) s = s.replace(new RegExp(`\\$${k.toUpperCase()}`, "g"), String(v).replace(/[\0\n\r]/g, ""));
      // If the original template was a single variable (e.g. "$ARGS") and it expanded to a multi-word string, split it
      if (/^\$[A-Z_]+$/.test(a) && s.includes(" ")) args.push(...s.split(/\s+/).filter(Boolean));
      else args.push(s);
    }
    return new Promise((resolve) => {
      let stdout = "", stderr = "";
      const child = spawn(binPath, args, { cwd: toolDef.cwd || process.cwd(), env: process.env, timeout, stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.on("data", c => stdout += c);
      child.stderr.on("data", c => stderr += c);
      // Pipe stdin if template defined
      if (toolDef.stdin_template) {
        let stdinData = toolDef.stdin_template.replace(/\$INPUT_JSON/g, JSON.stringify(input));
        for (const [k, v] of Object.entries(input || {})) stdinData = stdinData.replace(new RegExp(`\\$${k.toUpperCase()}`, "g"), String(v));
        child.stdin.write(stdinData);
        child.stdin.end();
      } else { child.stdin.end(); }
      const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* already dead */ } resolve({ content: `Timeout after ${timeout}ms`, is_error: true }); }, timeout);
      child.on("close", (code) => {
        clearTimeout(timer);
        if (!successCodes.has(code || 0)) {
          const mapped = toolDef.exit_code_map?.[String(code)];
          resolve({ content: mapped || `Exit code ${code}${stderr ? ": " + stderr.trim() : ""}`, is_error: true });
          return;
        }
        try {
          if (parseMode === "json") resolve({ content: JSON.stringify(JSON.parse(stdout.trim()), null, 2), is_error: false });
          else if (parseMode === "lines") resolve({ content: JSON.stringify(stdout.split("\n").filter(Boolean)), is_error: false });
          else resolve({ content: stdout, is_error: false });
        } catch (e) { resolve({ content: `Parse error (${parseMode}): ${e.message}\nRaw output: ${stdout.slice(0, 500)}`, is_error: true }); }
      });
      child.on("error", (e) => { clearTimeout(timer); resolve({ content: `Spawn error: ${e.message}`, is_error: true }); });
    });
  };
}

// ── HTTP executor (type: "http" — hardened) ───────────────────
function _createHttpExecutor(toolDef) {
  const timeout = toolDef.timeout || 10000;
  return async (input) => {
    // Check required env vars before request
    const missing = _checkRequiredEnvVars(toolDef);
    if (missing.length > 0) return { content: `Missing required env vars: ${missing.join(", ")}`, is_error: true };
    // Interpolate ${ENV_VAR} in url and headers
    let url;
    try { url = _interpolateEnvVars(toolDef.url).replace(/\$INPUT_JSON/g, encodeURIComponent(JSON.stringify(input))); } catch (e) { return { content: e.message, is_error: true }; }
    const body = ["POST", "PUT", "PATCH"].includes(toolDef.method?.toUpperCase()) ? JSON.stringify(input) : null;
    let headers = { "Content-Type": "application/json" };
    try { for (const [k, v] of Object.entries(toolDef.headers || {})) headers[k] = _interpolateEnvVars(v); } catch (e) { return { content: e.message, is_error: true }; }
    return new Promise((resolve) => {
      const parsed = new URL(url);
      const mod = parsed.protocol === "https:" ? _https : _http;
      const req = mod.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method: toolDef.method?.toUpperCase() || "GET", headers, timeout }, (res) => {
        let d = ""; res.on("data", c => d += c);
        res.on("end", () => {
          if (res.statusCode < 400) { resolve({ content: d, is_error: false }); return; }
          // Apply error_map if defined
          const mapped = toolDef.error_map?.[String(res.statusCode)];
          resolve({ content: mapped ? `HTTP ${res.statusCode}: ${mapped}` : `HTTP ${res.statusCode}: ${d.slice(0, 500)}`, is_error: true });
        });
      });
      req.on("error", e => {
        if (e.code === "ECONNREFUSED") resolve({ content: `Connection refused: ${url} — is the service running?`, is_error: true });
        else resolve({ content: `Network error: ${e.message}`, is_error: true });
      });
      req.on("timeout", () => { req.destroy(); resolve({ content: `Request timed out after ${timeout}ms`, is_error: true }); });
      if (body) req.write(body);
      req.end();
    });
  };
}

function _aiToolRequest(url, body, timeout, extraHeaders) { return new Promise((resolve, reject) => { const parsed = new URL(url); const mod = parsed.protocol === "https:" ? _https : _http; const req = mod.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...(extraHeaders || {}) }, timeout }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => res.statusCode < 400 ? resolve(d) : reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`))); }); req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("AI tool timed out")); }); req.write(body); req.end(); }); }

function _createAiExecutor(toolDef, cfg) { const timeout = toolDef.timeout || 30000; return async (input) => { let prompt = toolDef.task; prompt = prompt.replace(/\$INPUT_JSON/g, JSON.stringify(input)); for (const [k, v] of Object.entries(input || {})) prompt = prompt.replace(new RegExp(`\\$${k.toUpperCase()}`, "g"), String(v)); try { const model = toolDef.model; const provider = toolDef.provider || null; const apiKey = cfg.apiKey || process.env.ANTHROPIC_API_KEY; const openaiKey = cfg.openaiApiKey || process.env.OPENAI_API_KEY; const isOAI = model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3") || ["openai","azure","groq","deepseek","mistral"].includes(provider); let url, headers, body; if (isOAI) { url = { openai: cfg.openaiApiUrl || "https://api.openai.com/v1/chat/completions", groq: "https://api.groq.com/openai/v1/chat/completions", deepseek: "https://api.deepseek.com/v1/chat/completions", mistral: "https://api.mistral.ai/v1/chat/completions" }[provider] || cfg.openaiApiUrl || "https://api.openai.com/v1/chat/completions"; headers = { Authorization: `Bearer ${toolDef.api_key || openaiKey || ""}` }; body = JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: toolDef.max_tokens || 4096 }); } else { url = cfg.apiUrl || "https://api.anthropic.com/v1/messages"; headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }; body = JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: toolDef.max_tokens || 4096 }); } const resp = await _aiToolRequest(url, body, timeout, headers); const result = JSON.parse(resp); return { content: result.content?.[0]?.text || result.choices?.[0]?.message?.content || JSON.stringify(result), is_error: false }; } catch (e) { return { content: `AI tool error: ${e.message}`, is_error: true }; } }; }

function _createOllamaExecutor(toolDef) { const timeout = toolDef.timeout || 30000; const baseUrl = toolDef.base_url || process.env.OLLAMA_API_URL || "http://localhost:11434"; return async (input) => { let prompt = toolDef.task; prompt = prompt.replace(/\$INPUT_JSON/g, JSON.stringify(input)); for (const [k, v] of Object.entries(input || {})) prompt = prompt.replace(new RegExp(`\\$${k.toUpperCase()}`, "g"), String(v)); try { const resp = await _aiToolRequest(`${baseUrl}/api/generate`, JSON.stringify({ model: toolDef.model, prompt, stream: false }), timeout); return { content: JSON.parse(resp).response || resp, is_error: false }; } catch (e) { return { content: `Ollama error: ${e.message}`, is_error: true }; } }; }

function _createOpenAICompatibleExecutor(toolDef) { const timeout = toolDef.timeout || 30000; return async (input) => { let prompt = toolDef.task; prompt = prompt.replace(/\$INPUT_JSON/g, JSON.stringify(input)); for (const [k, v] of Object.entries(input || {})) prompt = prompt.replace(new RegExp(`\\$${k.toUpperCase()}`, "g"), String(v)); try { const url = `${toolDef.base_url.replace(/\/$/, "")}/v1/chat/completions`; const apiKey = toolDef.api_key || process.env[toolDef.api_key_env || ""] || ""; const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}; const resp = await _aiToolRequest(url, JSON.stringify({ model: toolDef.model, messages: [{ role: "user", content: prompt }], max_tokens: toolDef.max_tokens || 4096 }), timeout, headers); return { content: JSON.parse(resp).choices?.[0]?.message?.content || resp, is_error: false }; } catch (e) { return { content: `OpenAI-compatible error: ${e.message}`, is_error: true }; } }; }

const _hfPipelineCache = new Map();
function _createTransformersExecutor(toolDef) { const timeout = toolDef.timeout || 60000; const TASK_MAP = { classify:"text-classification",sentiment:"text-classification",translation:"translation",ocr:"image-to-text",rerank:"text-classification",stt:"automatic-speech-recognition","text-generation":"text-generation",summarization:"summarization","fill-mask":"fill-mask",ner:"token-classification" }; return async (input) => { let hf; try { hf = await import("@huggingface/transformers"); } catch { return { content: "Error: @huggingface/transformers not installed.\n  Run: npm install @huggingface/transformers", is_error: true }; } const hfTask = TASK_MAP[toolDef.task] || toolDef.task; const modelId = toolDef.local_path || toolDef.model; const cacheKey = `${hfTask}:${modelId}`; try { const start = Date.now(); let pipe = _hfPipelineCache.get(cacheKey); if (!pipe) { pipe = await hf.pipeline(hfTask, modelId); _hfPipelineCache.set(cacheKey, pipe); } const textInput = input.text || input.input || input.image_path || input.path || Object.values(input).find(v => typeof v === "string") || JSON.stringify(input); const result = await Promise.race([pipe(textInput), new Promise((_, rej) => setTimeout(() => rej(new Error("Timed out")), timeout))]); const elapsed = Date.now() - start; let output; if (Array.isArray(result) && result.length > 0) { const f = result[0]; output = (toolDef.task === "classify" || toolDef.task === "sentiment") ? JSON.stringify({ label: f.label, score: Math.round(f.score * 10000) / 10000 }) : f.generated_text || f.translation_text || f.summary_text || f.text || JSON.stringify(f); } else output = String(result); return { content: `${output}\n\n[${toolDef.task} via ${modelId} in ${elapsed}ms]`, is_error: false }; } catch (e) { return { content: `Transformers error: ${e.message}`, is_error: true }; } }; }

function _registerCustomTool(registry, toolDef, cfg) {
  let executor;
  const toolDir = path.join(CUSTOM_TOOLS_DIR, toolDef.name);
  if (toolDef.type === "shell") executor = _createShellExecutor(toolDef);
  else if (toolDef.type === "cli") { toolDef._registry = registry; executor = _createCliExecutor(toolDef, toolDir); }
  else if (toolDef.type === "http") executor = _createHttpExecutor(toolDef);
  else if (toolDef.type === "ai" && toolDef.backend === "transformers") executor = _createTransformersExecutor(toolDef);
  else if (toolDef.type === "ai" && toolDef.backend === "ollama") executor = _createOllamaExecutor(toolDef);
  else if (toolDef.type === "ai" && toolDef.backend === "openai-compatible") executor = _createOpenAICompatibleExecutor(toolDef);
  else if (toolDef.type === "ai") executor = _createAiExecutor(toolDef, cfg);
  else return;
  registry.register(toolDef.name, { description: toolDef.description, input_schema: toolDef.input_schema }, executor);
}

function scanCustomTools(registry, cfg) { try { for (const entry of fs.readdirSync(CUSTOM_TOOLS_DIR, { withFileTypes: true })) { if (!entry.isDirectory() || entry.name.startsWith(".")) continue; try { const raw = fs.readFileSync(path.join(CUSTOM_TOOLS_DIR, entry.name, "TOOL.json"), "utf-8"); const toolDef = JSON.parse(raw); if (_validateToolJson(toolDef).length === 0) { _registerCustomTool(registry, toolDef, cfg); log(`Loaded custom tool: ${toolDef.name}`); } } catch { /* skip */ } } } catch { /* no tools dir */ } }

async function toolInstall(cfg, source) {
  if (!source) { process.stderr.write("Usage: cloclo tool install <path|official:name>\n"); return; }
  // Handle official:<name> prefix
  if (source.startsWith("official:")) { return await _installOfficialTool(source.slice(9)); }
  let toolDef; const resolved = path.resolve(source);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) { const jp = path.join(resolved, "TOOL.json"); if (!fs.existsSync(jp)) { process.stderr.write(`Error: No TOOL.json found in ${resolved}\n`); process.exit(EXIT.BAD_ARGS); } toolDef = JSON.parse(fs.readFileSync(jp, "utf-8")); }
  else if (fs.existsSync(resolved) && resolved.endsWith("TOOL.json")) { toolDef = JSON.parse(fs.readFileSync(resolved, "utf-8")); }
  else { process.stderr.write(`Error: ${source} is not a valid path\n  Tip: use "official:<name>" to install from the official catalog.\n`); process.exit(EXIT.BAD_ARGS); }
  const errors = _validateToolJson(toolDef); if (errors.length > 0) { process.stderr.write(`\x1b[31mInvalid TOOL.json:\x1b[0m\n`); for (const e of errors) process.stderr.write(`  - ${e}\n`); process.exit(EXIT.BAD_ARGS); }
  const targetDir = path.join(CUSTOM_TOOLS_DIR, toolDef.name); fs.mkdirSync(targetDir, { recursive: true });
  const srcDir = fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved);
  for (const e of fs.readdirSync(srcDir)) { const src = path.join(srcDir, e); if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(targetDir, e)); }
  const manifest = _loadToolManifest();
  manifest.tools[toolDef.name] = _buildManifestEntry(toolDef, resolved, manifest.tools[toolDef.name], { installSource: resolved });
  _saveToolManifest(manifest);
  process.stderr.write(`\x1b[32mInstalled tool: ${toolDef.name}\x1b[0m (${toolDef.type})\n  Restart cloclo or use /tool list to see it.\n`);
}

function toolRemove(cfg, name) {
  if (!name) { process.stderr.write("Usage: cloclo tool remove <name>\n"); return; }
  const toolDir = path.join(CUSTOM_TOOLS_DIR, name); if (!fs.existsSync(path.join(toolDir, "TOOL.json"))) { if (_classifyToolType(name) === "builtin") process.stderr.write(`Cannot remove ${name}: it's a built-in tool. Use 'tool disable' instead.\n`); else process.stderr.write(`Custom tool not found: ${name}\n`); return; }
  fs.rmSync(toolDir, { recursive: true, force: true }); const manifest = _loadToolManifest(); delete manifest.tools[name]; _saveToolManifest(manifest);
  process.stderr.write(`Removed tool: ${name}\n  Restart cloclo to fully unload.\n`);
}

async function toolUpdate(cfg, name) {
  if (!name) { process.stderr.write("Usage: cloclo tool update <name|all>\n"); return; }
  const manifest = _loadToolManifest();
  const targets = name === "all"
    ? Object.values(manifest.tools || {}).filter((entry) => entry.installSource || entry.source)
    : [manifest.tools[name]].filter(Boolean);

  if (targets.length === 0) {
    process.stderr.write(name === "all" ? "No installed tools to update.\n" : `Tool not found in manifest: ${name}\n`);
    return;
  }

  let updated = 0;
  for (const entry of targets) {
    const installSource = entry.installSource || entry.source;
    if (!installSource) continue;
    if (String(installSource).startsWith("official:")) {
      const result = await _installOfficialTool(String(installSource).slice(9), { mode: "update" });
      if (result?.updated) updated++;
      continue;
    }
    const resolved = path.resolve(String(installSource));
    if (!fs.existsSync(resolved)) {
      process.stderr.write(`\x1b[33mSkipping ${entry.name}:\x1b[0m source missing at ${installSource}\n`);
      continue;
    }
    await toolInstall(cfg, resolved);
    updated++;
  }
  process.stderr.write(updated > 0 ? `Updated ${updated} tool(s).\n` : "All targeted tools are already up to date.\n");
}

// ── Official Tool Catalog ─────────────────────────────────────
//
// Uses the same registry server as skills (CLOCLO_REGISTRY_URL).
// Falls back to a static embedded catalog if registry is unreachable.
// Install via: cloclo tool install official:<name>

const _OFFICIAL_CATALOG = {
  "gh": {
    name: "gh", type: "cli", description: "GitHub CLI — PRs, issues, repos, releases, actions, gists",
    binary: "gh", args_template: ["$ARGS"], input_schema: { type: "object", properties: { args: { type: "string", description: "gh subcommand and flags (e.g. 'pr list --json number,title', 'issue create --title Bug', 'repo view', 'run list')" } }, required: ["args"] },
    timeout: 30000, read_only: false, parse_mode: "text", healthcheck: ["gh", "--version"], install_hint: "brew install gh",
    _meta: { category: "devops", author: "cloclo", env_required: [], auth_note: "Run: gh auth login" }
  },
  "docker": {
    name: "docker", type: "cli", description: "Docker CLI — containers, images, volumes, networks, compose",
    binary: "docker", args_template: ["$ARGS"], input_schema: { type: "object", properties: { args: { type: "string", description: "docker subcommand and flags (e.g. 'ps --format json', 'logs --tail 100 mycontainer', 'images', 'compose up -d')" } }, required: ["args"] },
    timeout: 30000, read_only: false, parse_mode: "text", healthcheck: ["docker", "--version"], install_hint: "brew install docker",
    _meta: { category: "devops", author: "cloclo", env_required: [], auth_note: "Docker daemon must be running" }
  },
  "vercel": {
    name: "vercel", type: "cli", description: "Vercel CLI — deployments, domains, env, logs, projects",
    binary: "vercel", args_template: ["$ARGS"], input_schema: { type: "object", properties: { args: { type: "string", description: "vercel subcommand and flags (e.g. 'list --json', 'deploy', 'env pull', 'logs myproject')" } }, required: ["args"] },
    timeout: 30000, read_only: false, parse_mode: "text", healthcheck: ["vercel", "--version"], install_hint: "npm install -g vercel",
    _meta: { category: "deploy", author: "cloclo", env_required: ["VERCEL_TOKEN"], auth_note: "Set VERCEL_TOKEN or run: vercel login" }
  },
  "kubectl": {
    name: "kubectl", type: "cli", description: "Kubernetes CLI — pods, services, deployments, logs, config",
    binary: "kubectl", args_template: ["$ARGS"], input_schema: { type: "object", properties: { args: { type: "string", description: "kubectl subcommand and flags (e.g. 'get pods -o json', 'logs mypod', 'describe svc myservice', 'apply -f manifest.yaml')" } }, required: ["args"] },
    timeout: 30000, read_only: false, parse_mode: "text", healthcheck: ["kubectl", "version", "--client", "--short"], install_hint: "brew install kubectl",
    _meta: { category: "devops", author: "cloclo", env_required: [], auth_note: "Requires configured kubeconfig" }
  },
  "fly": {
    name: "fly", type: "cli", description: "Fly.io CLI — apps, machines, volumes, secrets, deploy",
    binary: "fly", args_template: ["$ARGS"], input_schema: { type: "object", properties: { args: { type: "string", description: "fly subcommand and flags (e.g. 'apps list', 'status', 'deploy', 'logs', 'secrets set KEY=value')" } }, required: ["args"] },
    timeout: 30000, read_only: false, parse_mode: "text", healthcheck: ["fly", "version"], install_hint: "brew install flyctl",
    _meta: { category: "deploy", author: "cloclo", env_required: [], auth_note: "Run: fly auth login" }
  },
  "aws": {
    name: "aws", type: "cli", description: "AWS CLI — S3, EC2, Lambda, IAM, CloudFormation, and 200+ services",
    binary: "aws", args_template: ["$ARGS"], input_schema: { type: "object", properties: { args: { type: "string", description: "aws subcommand and flags (e.g. 's3 ls', 'ec2 describe-instances', 'lambda list-functions', 'sts get-caller-identity')" } }, required: ["args"] },
    timeout: 30000, read_only: false, parse_mode: "text", healthcheck: ["aws", "--version"], install_hint: "brew install awscli",
    _meta: { category: "cloud", author: "cloclo", env_required: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"], auth_note: "Run: aws configure" }
  },
  "gcloud": {
    name: "gcloud", type: "cli", description: "Google Cloud CLI — compute, storage, run, functions, IAM",
    binary: "gcloud", args_template: ["$ARGS"], input_schema: { type: "object", properties: { args: { type: "string", description: "gcloud subcommand and flags (e.g. 'run services list', 'compute instances list', 'auth list')" } }, required: ["args"] },
    timeout: 30000, read_only: false, parse_mode: "text", healthcheck: ["gcloud", "--version"], install_hint: "brew install google-cloud-sdk",
    _meta: { category: "cloud", author: "cloclo", env_required: [], auth_note: "Run: gcloud auth login" }
  },
  "terraform": {
    name: "terraform", type: "cli", description: "Terraform CLI — plan, apply, destroy, state, import infrastructure",
    binary: "terraform", args_template: ["$ARGS"], input_schema: { type: "object", properties: { args: { type: "string", description: "terraform subcommand and flags (e.g. 'plan', 'apply -auto-approve', 'state list', 'output -json')" } }, required: ["args"] },
    timeout: 120000, read_only: false, parse_mode: "text", healthcheck: ["terraform", "--version"], install_hint: "brew install terraform",
    _meta: { category: "infra", author: "cloclo", env_required: [], auth_note: "Requires provider credentials" }
  },
  "jq": {
    name: "jq", type: "cli", description: "jq — lightweight JSON processor, filter, transform, query",
    binary: "jq", args_template: ["$EXPRESSION"], stdin_template: "$INPUT_JSON", input_schema: { type: "object", properties: { expression: { type: "string", description: "jq expression (e.g. '.[] | .name', 'keys', 'length', '.items[] | select(.status==\"active\")')" }, data: { type: "object", description: "JSON data to transform" } }, required: ["expression"] },
    timeout: 5000, read_only: true, parse_mode: "json", healthcheck: ["jq", "--version"], install_hint: "brew install jq",
    _meta: { category: "data", author: "cloclo", env_required: [] }
  },
  "rg": {
    name: "rg", type: "cli", description: "ripgrep — fast recursive regex search across files",
    binary: "rg", args_template: ["$ARGS"], input_schema: { type: "object", properties: { args: { type: "string", description: "rg flags and pattern (e.g. '--json \"TODO\"', '-l \"import.*react\"', '-t py \"def main\"', '-c \"error\" /var/log')" } }, required: ["args"] },
    timeout: 15000, read_only: true, parse_mode: "text", healthcheck: ["rg", "--version"], install_hint: "brew install ripgrep",
    _meta: { category: "search", author: "cloclo", env_required: [] }
  },
  "ffprobe": {
    name: "ffprobe", type: "cli", description: "ffprobe — inspect media files (video, audio, streams, formats)",
    binary: "ffprobe", args_template: ["$ARGS"], input_schema: { type: "object", properties: { args: { type: "string", description: "ffprobe flags and file (e.g. '-v quiet -print_format json -show_format -show_streams video.mp4')" } }, required: ["args"] },
    timeout: 15000, read_only: true, parse_mode: "text", healthcheck: ["ffprobe", "-version"], install_hint: "brew install ffmpeg",
    _meta: { category: "media", author: "cloclo", env_required: [] }
  },
  "hedi-fraud-check": {
    name: "hedi-fraud-check", type: "http", description: "Hedi AI — fraud detection on documents and transactions",
    method: "POST", url: "https://api.hedi.ai/v1/fraud/check",
    headers: { "Authorization": "Bearer ${HEDI_API_KEY}", "Content-Type": "application/json" },
    timeout: 15000, read_only: true, healthcheck_url: "https://api.hedi.ai/health",
    error_map: { "401": "Auth failed — set HEDI_API_KEY", "503": "Hedi service unavailable", "429": "Rate limit exceeded" },
    input_schema: { type: "object", properties: { document_text: { type: "string", description: "Document text to analyze for fraud" } }, required: ["document_text"] },
    _meta: { category: "enterprise", author: "hedi", env_required: ["HEDI_API_KEY"], auth_note: "Get API key at https://hedi.ai/dashboard" }
  },
  "slack": {
    name: "slack", type: "http", description: "Slack — post messages to channels via webhook",
    method: "POST", url: "${SLACK_WEBHOOK_URL}",
    headers: { "Content-Type": "application/json" },
    timeout: 10000, read_only: false,
    error_map: { "400": "Invalid payload", "403": "Webhook revoked", "404": "Webhook not found — check SLACK_WEBHOOK_URL" },
    input_schema: { type: "object", properties: { text: { type: "string", description: "Message text (supports Slack markdown)" }, channel: { type: "string", description: "Channel override (optional)" } }, required: ["text"] },
    _meta: { category: "communication", author: "cloclo", env_required: ["SLACK_WEBHOOK_URL"], auth_note: "Create webhook at https://api.slack.com/messaging/webhooks" }
  },
  "system-info": {
    name: "system-info", type: "cli", description: "System info — OS, CPU, memory, disk, network, uptime",
    binary: "uname", args_template: ["-a"], input_schema: { type: "object", properties: { args: { type: "string", description: "uname flags (default: -a for all info)" } } },
    timeout: 5000, read_only: true, parse_mode: "text", healthcheck: ["uname", "--version"],
    _meta: { category: "system", author: "cloclo", env_required: [] }
  },
};

async function toolCatalog(query) {
  const q = (query || "*").toLowerCase();
  let results = [];
  let fromRegistry = false;
  // Try registry first (same server as skills)
  try {
    const registryUrl = process.env.CLOCLO_REGISTRY_URL || "https://cloclo-registry-799190737906.europe-west1.run.app";
    const endpoint = q === "*" ? "/api/tools" : `/api/tools/search?q=${encodeURIComponent(q)}`;
    const resp = await _httpGet(`${registryUrl}${endpoint}`, { Accept: "application/json" });
    const data = JSON.parse(resp);
    results = (data.tools || []).map(t => ({ ...t, _meta: { category: t.category || "", author: t.author || "registry" } }));
    if (results.length > 0) fromRegistry = true;
  } catch { /* registry unreachable — fall back to static catalog */ }
  // Fallback to static catalog (also when registry returns empty)
  if (!fromRegistry) {
    const all = Object.values(_OFFICIAL_CATALOG);
    results = q === "*" ? all : all.filter(t => {
      const searchable = `${t.name} ${t.description} ${t.type} ${t._meta?.category || ""} ${t._meta?.author || ""}`.toLowerCase();
      return q.split(/\s+/).every(term => searchable.includes(term));
    });
  }
  // Group by category
  const byCategory = {};
  for (const t of results) {
    const cat = t._meta?.category || t.category || "other";
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(t);
  }
  const installed = new Set();
  try { const m = _loadToolManifest(); for (const k of Object.keys(m.tools || {})) installed.add(k); } catch { /* no manifest */ }
  // Render marketplace
  const w = process.stderr.columns || 80;
  process.stderr.write(`\n\x1b[1m  ${"═".repeat(w - 4)}\x1b[0m\n`);
  process.stderr.write(`\x1b[1m  TOOL MARKETPLACE\x1b[0m${fromRegistry ? "  \x1b[2m(registry)\x1b[0m" : "  \x1b[2m(built-in)\x1b[0m"}${q !== "*" ? `  \x1b[2mfilter: ${q}\x1b[0m` : ""}\n`);
  process.stderr.write(`\x1b[1m  ${"═".repeat(w - 4)}\x1b[0m\n`);
  if (results.length === 0) { process.stderr.write(`\n  No tools found${q !== "*" ? ` matching "${q}"` : ""}.\n\n`); return; }
  const categoryIcons = { devops: "\u2699", deploy: "\u2601", data: "\u2630", search: "\u2315", enterprise: "\u2302", communication: "\u2709", system: "\u2318", media: "\u266B", other: "\u2022" };
  const categoryColors = { devops: "36", deploy: "34", data: "32", search: "33", enterprise: "35", communication: "31", system: "37", media: "36", other: "2" };
  for (const [cat, tools] of Object.entries(byCategory).sort(([a], [b]) => a.localeCompare(b))) {
    const icon = categoryIcons[cat] || "\u2022";
    const cc = categoryColors[cat] || "2";
    process.stderr.write(`\n  \x1b[${cc};1m${icon} ${cat.toUpperCase()}\x1b[0m\n`);
    for (const t of tools) {
      const isInstalled = installed.has(t.name);
      const badge = isInstalled ? " \x1b[32m[installed]\x1b[0m" : "";
      const typeBadge = t.type === "cli" ? "\x1b[33mcli\x1b[0m" : t.type === "http" ? "\x1b[35mhttp\x1b[0m" : `\x1b[36m${t.type || "?"}\x1b[0m`;
      const ro = t.read_only === false ? " \x1b[33mmutating\x1b[0m" : "";
      process.stderr.write(`    \x1b[1m${t.name}\x1b[0m  ${typeBadge}${ro}${badge}\n`);
      process.stderr.write(`    \x1b[2m${(t.description || "").slice(0, w - 8)}\x1b[0m\n`);
      const details = [];
      if (t.version) details.push(`v${t.version}`);
      if (t.binary) details.push(`binary: ${t.binary}`);
      if (t.url) details.push(`url: ${(t.url || "").slice(0, 40)}`);
      if (t._meta?.author && t._meta.author !== "cloclo") details.push(`by ${t._meta.author}`);
      if (t._meta?.env_required?.length > 0) details.push(`env: ${t._meta.env_required.join(", ")}`);
      if (t.downloads) details.push(`${t.downloads} installs`);
      if (details.length > 0) process.stderr.write(`    \x1b[2m${details.join("  \u00B7  ")}\x1b[0m\n`);
    }
  }
  process.stderr.write(`\n\x1b[1m  ${"─".repeat(w - 4)}\x1b[0m\n`);
  process.stderr.write(`  ${results.length} tool(s) available\n`);
  process.stderr.write(`  Install:  \x1b[1mcloclo tool install official:<name>\x1b[0m\n`);
  process.stderr.write(`  Publish:  \x1b[1mcloclo tool publish <name>\x1b[0m\n\n`);
}

async function _installOfficialTool(name, opts = {}) {
  const mode = opts.mode || "install";
  let toolDef = null;
  let source = "official";
  let version = null;
  let publisher = "cloclo";
  let category = null;
  // Try registry first
  try {
    const registryUrl = process.env.CLOCLO_REGISTRY_URL || "https://cloclo-registry-799190737906.europe-west1.run.app";
    process.stderr.write(`\x1b[2mFetching ${name} from ${registryUrl}...\x1b[0m\n`);
    const resp = await _httpGet(`${registryUrl}/api/tools/${name}`, { Accept: "application/json" });
    const pkg = JSON.parse(resp);
    if (pkg.toolJson) {
      toolDef = typeof pkg.toolJson === "string" ? JSON.parse(pkg.toolJson) : pkg.toolJson;
      toolDef._meta = { category: pkg.category, author: pkg.author, env_required: toolDef.env || [], auth_note: toolDef._meta?.auth_note };
      source = "registry";
      version = pkg.version || toolDef.version || "1.0.0";
      publisher = pkg.author || toolDef._meta?.author || "registry";
      category = pkg.category || toolDef._meta?.category || null;
    }
  } catch { /* registry miss or unreachable */ }
  // Fallback to static catalog
  if (!toolDef) {
    toolDef = _OFFICIAL_CATALOG[name];
    version = toolDef?.version || "1.0.0";
    publisher = toolDef?._meta?.author || "cloclo";
    category = toolDef?._meta?.category || null;
  }
  if (!toolDef) {
    process.stderr.write(`\x1b[31mTool not found: ${name}\x1b[0m\n`);
    const suggestions = Object.keys(_OFFICIAL_CATALOG).filter(k => k.includes(name) || name.includes(k.split("-")[0]));
    if (suggestions.length > 0) process.stderr.write(`  Did you mean: ${suggestions.join(", ")}?\n`);
    process.stderr.write(`  Run "cloclo tool catalog ${name}" to browse.\n`);
    return;
  }
  const manifest = _loadToolManifest();
  const existing = manifest.tools[toolDef.name] || {};
  if (mode === "update" && existing.version && version && existing.version === version) {
    process.stderr.write(`\x1b[2m${toolDef.name} is already up to date (${version}).\x1b[0m\n`);
    return { updated: false, name: toolDef.name, version };
  }
  // Show safety-relevant metadata
  process.stderr.write(`\n  \x1b[1m${toolDef.name}\x1b[0m — ${toolDef.description}\n`);
  process.stderr.write(`  Type:       ${toolDef.type}\n`);
  process.stderr.write(`  Read-only:  ${toolDef.read_only ? "\x1b[32myes\x1b[0m" : "\x1b[33mno (mutating)\x1b[0m"}\n`);
  process.stderr.write(`  Version:    ${version}\n`);
  if (toolDef.type === "cli") process.stderr.write(`  Binary:     ${toolDef.binary}\n`);
  if (toolDef.type === "http") process.stderr.write(`  URL:        ${toolDef.url}\n`);
  // Show env requirements from _meta or by scanning headers/url for ${VAR}
  const envReqs = _extractToolEnvRequirements(toolDef);
  if (envReqs.length > 0) process.stderr.write(`  Env needed: ${envReqs.join(", ")}\n`);
  if (toolDef._meta?.auth_note) process.stderr.write(`  Auth:       ${toolDef._meta.auth_note}\n`);
  process.stderr.write(`  Author:     ${publisher}\n`);
  process.stderr.write(`  Source:     ${source}\n`);
  const targetDir = path.join(CUSTOM_TOOLS_DIR, toolDef.name);
  if (fs.existsSync(path.join(targetDir, "TOOL.json"))) process.stderr.write(`  \x1b[33mAlready installed — overwriting.\x1b[0m\n`);
  const cleanDef = { ...toolDef }; delete cleanDef._meta;
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "TOOL.json"), JSON.stringify(cleanDef, null, 2));
  manifest.tools[toolDef.name] = _buildManifestEntry(toolDef, source, existing, {
    installSource: `official:${toolDef.name}`,
    version,
    publisher,
    category,
  });
  _saveToolManifest(manifest);
  process.stderr.write(`\n  \x1b[32m${mode === "update" ? "Updated" : "Installed"}: ${toolDef.name}\x1b[0m\n  Restart cloclo or use /tool list to see it.\n\n`);
  return { updated: true, name: toolDef.name, version };
}

async function toolPublish(cfg, name) {
  if (!name) { process.stderr.write("Usage: cloclo tool publish <name>\n"); return; }
  const token = process.env.CLOCLO_REGISTRY_TOKEN;
  if (!token) { process.stderr.write("Error: Set CLOCLO_REGISTRY_TOKEN to publish tools.\n"); return; }
  const toolDir = path.join(CUSTOM_TOOLS_DIR, name);
  const toolJsonPath = path.join(toolDir, "TOOL.json");
  if (!fs.existsSync(toolJsonPath)) { process.stderr.write(`Tool not found: ${name}\n  Install it first, then publish.\n`); return; }
  const toolDef = JSON.parse(fs.readFileSync(toolJsonPath, "utf-8"));
  const errors = _validateToolJson(toolDef); if (errors.length > 0) { process.stderr.write(`\x1b[31mInvalid TOOL.json — fix before publishing:\x1b[0m\n`); for (const e of errors) process.stderr.write(`  - ${e}\n`); return; }
  const registryUrl = process.env.CLOCLO_REGISTRY_URL || "https://cloclo-registry-799190737906.europe-west1.run.app";
  process.stderr.write(`\x1b[2mPublishing ${name} to ${registryUrl}...\x1b[0m\n`);
  const body = JSON.stringify({ name: toolDef.name, description: toolDef.description, type: toolDef.type, category: toolDef._meta?.category || "", version: toolDef.version || "1.0.0", toolJson: toolDef });
  try {
    const resp = await new Promise((resolve, reject) => {
      const parsed = new URL(`${registryUrl}/api/tools/publish`);
      const mod = parsed.protocol === "https:" ? _https : _http;
      const req = mod.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "Content-Length": Buffer.byteLength(body) }, timeout: 15000 }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => res.statusCode < 400 ? resolve(d) : reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`))); });
      req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("Timed out")); }); req.write(body); req.end();
    });
    const result = JSON.parse(resp);
    process.stderr.write(`\x1b[32mPublished: ${name}\x1b[0m (${result.version || "1.0.0"})\n  Install: cloclo tool install official:${name}\n`);
  } catch (e) { process.stderr.write(`\x1b[31mPublish failed:\x1b[0m ${e.message}\n`); }
}

// ── Document Tools — Common Runtime ───────────────────────────────────────

function _validateDocPath(filePath, extensions) {
  if (!filePath) return { error: "file_path is required" };
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return { error: `File not found: ${resolved}` };
  const ext = path.extname(resolved).toLowerCase();
  if (extensions && !extensions.includes(ext)) return { error: `Unsupported file type: ${ext}. Expected: ${extensions.join(", ")}` };
  return { resolved };
}

function _docResult(data) { return { content: JSON.stringify(data, null, 2), is_error: false }; }
function _docError(msg) { return { content: msg, is_error: true }; }

// ── Spreadsheet Tool (xlsx) ──────────────────────────────────────────────

const SPREADSHEET_READ_ACTIONS = new Set(["inspect", "list_sheets", "get_sheet_info", "read_range", "find_text", "inspect_formulas", "check_errors", "export_csv"]);
const SPREADSHEET_WRITE_ACTIONS = new Set(["write_range", "append_rows", "set_cell", "format_cells", "set_column_width", "create", "add_sheet"]);

function registerSpreadsheetTools(registry) {
  registry.register("Spreadsheet", {
    description: "Spreadsheet operations on .xlsx/.xls/.csv files. Actions: inspect, list_sheets, get_sheet_info, read_range, write_range, append_rows, set_cell, find_text, inspect_formulas, check_errors, format_cells, set_column_width, create, add_sheet, export_csv. Use read_range for data, write_range/set_cell to modify, check_errors to validate formulas, format_cells for styling.",
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["inspect", "list_sheets", "get_sheet_info", "read_range", "write_range", "append_rows", "set_cell", "find_text", "inspect_formulas", "check_errors", "format_cells", "set_column_width", "create", "add_sheet", "export_csv"], description: "Spreadsheet action" },
      file_path: { type: "string", description: "Path to .xlsx/.xls/.csv file" },
      sheet: { type: "string", description: "Sheet name (defaults to first sheet)" },
      range: { type: "string", description: "Cell range e.g. 'A1:D10'" },
      cell: { type: "string", description: "Cell reference for set_cell e.g. 'A1'" },
      value: { type: "string", description: "Value or formula for set_cell (formulas start with =)" },
      values: { type: "array", description: "2D array of values for write_range, e.g. [[1,2],[3,4]]" },
      rows: { type: "array", description: "Array of row arrays for append_rows" },
      query: { type: "string", description: "Search text for find_text" },
      output_path: { type: "string", description: "Output file path for export_csv/write" },
      sheets: { type: "array", description: "Sheet names for create (e.g. ['Summary','Data'])" },
      format: { type: "object", description: "Format options for format_cells: {bold, italic, color, fill, numFmt, alignment}" },
      width: { type: "number", description: "Column width for set_column_width" },
      column: { type: "string", description: "Column letter for set_column_width (e.g. 'A')" },
    }, required: ["action", "file_path"] }
  }, async (input) => {
    let XLSX;
    try { XLSX = await import("xlsx"); if (XLSX.default) XLSX = XLSX.default; } catch { return _docError("xlsx not installed. Run: npm install xlsx"); }
    const a = input.action;
    const vp = _validateDocPath(input.file_path, [".xlsx", ".xls", ".csv"]);
    if (vp.error && a !== "write_range" && a !== "append_rows") return _docError(vp.error);
    try {
      if (a === "inspect") {
        const wb = XLSX.readFile(vp.resolved);
        return _docResult({ file: path.basename(vp.resolved), sheets: wb.SheetNames, sheetCount: wb.SheetNames.length, activeSheet: wb.SheetNames[0] });
      }
      if (a === "list_sheets") {
        const wb = XLSX.readFile(vp.resolved);
        const sheets = wb.SheetNames.map(name => { const ws = wb.Sheets[name]; const r = XLSX.utils.decode_range(ws["!ref"] || "A1"); return { name, rows: r.e.r + 1, cols: r.e.c + 1 }; });
        return _docResult(sheets);
      }
      if (a === "get_sheet_info") {
        const wb = XLSX.readFile(vp.resolved);
        const sheetName = input.sheet || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        if (!ws) return _docError(`Sheet not found: ${sheetName}. Available: ${wb.SheetNames.join(", ")}`);
        const r = XLSX.utils.decode_range(ws["!ref"] || "A1");
        const headers = [];
        for (let c = r.s.c; c <= r.e.c; c++) { const cell = ws[XLSX.utils.encode_cell({ r: 0, c })]; headers.push(cell ? String(cell.v) : ""); }
        return _docResult({ name: sheetName, range: ws["!ref"], rows: r.e.r + 1, cols: r.e.c + 1, headers });
      }
      if (a === "read_range") {
        const wb = XLSX.readFile(vp.resolved);
        const sheetName = input.sheet || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        if (!ws) return _docError(`Sheet not found: ${sheetName}`);
        let data;
        if (input.range) {
          const opts = { range: input.range, header: 1 };
          data = XLSX.utils.sheet_to_json(ws, opts);
        } else { data = XLSX.utils.sheet_to_json(ws); }
        // Truncate large outputs
        const total = data.length;
        if (total > 200) { data = data.slice(0, 200); return _docResult({ rows: data, rowCount: 200, totalRows: total, truncated: true }); }
        return _docResult({ rows: data, rowCount: total });
      }
      if (a === "write_range") {
        const filePath = vp.resolved || path.resolve(input.file_path);
        let wb;
        if (fs.existsSync(filePath)) { wb = XLSX.readFile(filePath); } else { wb = XLSX.utils.book_new(); }
        const sheetName = input.sheet || wb.SheetNames[0] || "Sheet1";
        let ws = wb.Sheets[sheetName];
        if (!ws) { ws = XLSX.utils.aoa_to_sheet([]); XLSX.utils.book_append_sheet(wb, ws, sheetName); }
        if (!input.range || !input.values) return _docError("write_range requires 'range' and 'values'");
        const origin = input.range.split(":")[0];
        XLSX.utils.sheet_add_aoa(ws, input.values, { origin });
        const out = input.output_path ? path.resolve(input.output_path) : filePath;
        XLSX.writeFile(wb, out);
        return { content: `Written ${input.values.length} row(s) to ${sheetName}!${input.range} → ${out}`, is_error: false };
      }
      if (a === "append_rows") {
        const filePath = vp.resolved || path.resolve(input.file_path);
        if (!input.rows || !Array.isArray(input.rows)) return _docError("append_rows requires 'rows' array");
        const wb = fs.existsSync(filePath) ? XLSX.readFile(filePath) : XLSX.utils.book_new();
        const sheetName = input.sheet || wb.SheetNames[0] || "Sheet1";
        let ws = wb.Sheets[sheetName];
        if (!ws) { ws = XLSX.utils.aoa_to_sheet([]); XLSX.utils.book_append_sheet(wb, ws, sheetName); }
        const r = XLSX.utils.decode_range(ws["!ref"] || "A1");
        XLSX.utils.sheet_add_aoa(ws, input.rows, { origin: { r: r.e.r + 1, c: 0 } });
        const out = input.output_path ? path.resolve(input.output_path) : filePath;
        XLSX.writeFile(wb, out);
        return { content: `Appended ${input.rows.length} row(s) to ${sheetName} → ${out}`, is_error: false };
      }
      if (a === "find_text") {
        if (!input.query) return _docError("find_text requires 'query'");
        const wb = XLSX.readFile(vp.resolved);
        const results = [];
        const q = input.query.toLowerCase();
        for (const sheetName of wb.SheetNames) {
          const ws = wb.Sheets[sheetName];
          const r = XLSX.utils.decode_range(ws["!ref"] || "A1");
          for (let row = r.s.r; row <= r.e.r; row++) {
            for (let col = r.s.c; col <= r.e.c; col++) {
              const cell = ws[XLSX.utils.encode_cell({ r: row, c: col })];
              if (cell && String(cell.v).toLowerCase().includes(q)) {
                results.push({ sheet: sheetName, cell: XLSX.utils.encode_cell({ r: row, c: col }), value: cell.v });
              }
            }
          }
          if (results.length > 100) break;
        }
        return _docResult(results);
      }
      if (a === "inspect_formulas") {
        const wb = XLSX.readFile(vp.resolved);
        const sheetName = input.sheet || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        if (!ws) return _docError(`Sheet not found: ${sheetName}`);
        const formulas = [];
        const r = XLSX.utils.decode_range(ws["!ref"] || "A1");
        for (let row = r.s.r; row <= r.e.r; row++) {
          for (let col = r.s.c; col <= r.e.c; col++) {
            const cell = ws[XLSX.utils.encode_cell({ r: row, c: col })];
            if (cell?.f) formulas.push({ cell: XLSX.utils.encode_cell({ r: row, c: col }), formula: cell.f });
          }
        }
        return _docResult(formulas);
      }
      if (a === "export_csv") {
        const wb = XLSX.readFile(vp.resolved);
        const sheetName = input.sheet || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        if (!ws) return _docError(`Sheet not found: ${sheetName}`);
        const csv = XLSX.utils.sheet_to_csv(ws);
        const out = input.output_path ? path.resolve(input.output_path) : vp.resolved.replace(/\.[^.]+$/, ".csv");
        fs.writeFileSync(out, csv);
        return { content: `Exported ${sheetName} to ${out}`, is_error: false };
      }
      // ── check_errors — scan for #REF!, #DIV/0!, #VALUE!, #N/A, #NAME?, #NULL! ──
      if (a === "check_errors") {
        const wb = XLSX.readFile(vp.resolved);
        const excelErrors = ["#REF!", "#DIV/0!", "#VALUE!", "#N/A", "#NAME?", "#NULL!"];
        const errorDetails = {}; for (const e of excelErrors) errorDetails[e] = [];
        let totalErrors = 0;
        for (const sheetName of wb.SheetNames) {
          const ws = wb.Sheets[sheetName]; if (!ws["!ref"]) continue;
          const r = XLSX.utils.decode_range(ws["!ref"]);
          for (let row = r.s.r; row <= r.e.r; row++) {
            for (let col = r.s.c; col <= r.e.c; col++) {
              const addr = XLSX.utils.encode_cell({ r: row, c: col });
              const cell = ws[addr];
              if (cell && typeof cell.v === "string") {
                for (const err of excelErrors) {
                  if (cell.v.includes(err)) { errorDetails[err].push(`${sheetName}!${addr}`); totalErrors++; break; }
                }
              }
              // Also check cell.w (formatted value) for errors
              if (cell && cell.w && typeof cell.w === "string") {
                for (const err of excelErrors) {
                  if (cell.w.includes(err) && !errorDetails[err].includes(`${sheetName}!${addr}`)) { errorDetails[err].push(`${sheetName}!${addr}`); totalErrors++; break; }
                }
              }
            }
          }
        }
        const summary = {};
        for (const [errType, locations] of Object.entries(errorDetails)) {
          if (locations.length > 0) summary[errType] = { count: locations.length, locations: locations.slice(0, 20) };
        }
        // Count formulas
        let formulaCount = 0;
        for (const sheetName of wb.SheetNames) {
          const ws = wb.Sheets[sheetName]; if (!ws["!ref"]) continue;
          const r = XLSX.utils.decode_range(ws["!ref"]);
          for (let row = r.s.r; row <= r.e.r; row++) { for (let col = r.s.c; col <= r.e.c; col++) { const cell = ws[XLSX.utils.encode_cell({ r: row, c: col })]; if (cell?.f) formulaCount++; } }
        }
        return _docResult({ status: totalErrors === 0 ? "success" : "errors_found", totalErrors, formulaCount, errorSummary: summary });
      }
      // ── set_cell — set a single cell value or formula ──
      if (a === "set_cell") {
        if (!input.cell) return _docError("set_cell requires 'cell' (e.g. 'A1')");
        if (input.value === undefined) return _docError("set_cell requires 'value'");
        const filePath = vp.resolved || path.resolve(input.file_path);
        const wb = fs.existsSync(filePath) ? XLSX.readFile(filePath) : XLSX.utils.book_new();
        const sheetName = input.sheet || wb.SheetNames[0] || "Sheet1";
        let ws = wb.Sheets[sheetName];
        if (!ws) { ws = XLSX.utils.aoa_to_sheet([]); XLSX.utils.book_append_sheet(wb, ws, sheetName); }
        const cellRef = input.cell.toUpperCase();
        if (String(input.value).startsWith("=")) {
          // Formula
          ws[cellRef] = { f: input.value.slice(1), t: "n" };
        } else {
          const numVal = Number(input.value);
          ws[cellRef] = isNaN(numVal) || input.value === "" ? { v: input.value, t: "s" } : { v: numVal, t: "n" };
        }
        // Update sheet range
        if (!ws["!ref"]) ws["!ref"] = `${cellRef}:${cellRef}`;
        else {
          const existing = XLSX.utils.decode_range(ws["!ref"]);
          const newCell = XLSX.utils.decode_cell(cellRef);
          if (newCell.r > existing.e.r) existing.e.r = newCell.r;
          if (newCell.c > existing.e.c) existing.e.c = newCell.c;
          ws["!ref"] = XLSX.utils.encode_range(existing);
        }
        const out = input.output_path ? path.resolve(input.output_path) : filePath;
        XLSX.writeFile(wb, out);
        return { content: `Set ${sheetName}!${cellRef} = ${input.value} → ${out}`, is_error: false };
      }
      // ── format_cells — apply formatting to a range ──
      if (a === "format_cells") {
        if (!input.range) return _docError("format_cells requires 'range'");
        if (!input.format) return _docError("format_cells requires 'format' object");
        const filePath = vp.resolved || path.resolve(input.file_path);
        const wb = XLSX.readFile(filePath);
        const sheetName = input.sheet || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        if (!ws) return _docError(`Sheet not found: ${sheetName}`);
        const rng = XLSX.utils.decode_range(input.range);
        let count = 0;
        for (let row = rng.s.r; row <= rng.e.r; row++) {
          for (let col = rng.s.c; col <= rng.e.c; col++) {
            const addr = XLSX.utils.encode_cell({ r: row, c: col });
            if (!ws[addr]) ws[addr] = { v: "", t: "s" };
            if (!ws[addr].s) ws[addr].s = {};
            const fmt = input.format;
            if (fmt.bold !== undefined) { if (!ws[addr].s.font) ws[addr].s.font = {}; ws[addr].s.font.bold = fmt.bold; }
            if (fmt.italic !== undefined) { if (!ws[addr].s.font) ws[addr].s.font = {}; ws[addr].s.font.italic = fmt.italic; }
            if (fmt.color) { if (!ws[addr].s.font) ws[addr].s.font = {}; ws[addr].s.font.color = { rgb: fmt.color.replace("#", "") }; }
            if (fmt.fill) { ws[addr].s.fill = { fgColor: { rgb: fmt.fill.replace("#", "") } }; }
            if (fmt.numFmt) ws[addr].z = fmt.numFmt;
            if (fmt.alignment) { ws[addr].s.alignment = fmt.alignment; }
            count++;
          }
        }
        const out = input.output_path ? path.resolve(input.output_path) : filePath;
        XLSX.writeFile(wb, out);
        return { content: `Formatted ${count} cell(s) in ${sheetName}!${input.range} → ${out}`, is_error: false };
      }
      // ── set_column_width ──
      if (a === "set_column_width") {
        if (!input.column || !input.width) return _docError("set_column_width requires 'column' and 'width'");
        const filePath = vp.resolved || path.resolve(input.file_path);
        const wb = XLSX.readFile(filePath);
        const sheetName = input.sheet || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        if (!ws) return _docError(`Sheet not found: ${sheetName}`);
        if (!ws["!cols"]) ws["!cols"] = [];
        const colIdx = XLSX.utils.decode_col(input.column.toUpperCase());
        while (ws["!cols"].length <= colIdx) ws["!cols"].push({});
        ws["!cols"][colIdx] = { wch: input.width };
        const out = input.output_path ? path.resolve(input.output_path) : filePath;
        XLSX.writeFile(wb, out);
        return { content: `Set column ${input.column} width to ${input.width} in ${sheetName} → ${out}`, is_error: false };
      }
      // ── create — create a new workbook ──
      if (a === "create") {
        const filePath = path.resolve(input.file_path);
        const wb = XLSX.utils.book_new();
        const sheetNames = input.sheets || ["Sheet1"];
        for (const name of sheetNames) { XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), name); }
        XLSX.writeFile(wb, filePath);
        return { content: `Created ${filePath} with sheets: ${sheetNames.join(", ")}`, is_error: false };
      }
      // ── add_sheet — add a new sheet to existing workbook ──
      if (a === "add_sheet") {
        if (!input.sheet) return _docError("add_sheet requires 'sheet' (sheet name)");
        const filePath = vp.resolved || path.resolve(input.file_path);
        const wb = fs.existsSync(filePath) ? XLSX.readFile(filePath) : XLSX.utils.book_new();
        if (wb.SheetNames.includes(input.sheet)) return _docError(`Sheet already exists: ${input.sheet}`);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), input.sheet);
        const out = input.output_path ? path.resolve(input.output_path) : filePath;
        XLSX.writeFile(wb, out);
        return { content: `Added sheet "${input.sheet}" → ${out}`, is_error: false };
      }
      return _docError(`Unknown action: ${a}`);
    } catch (e) { return _docError(`Spreadsheet error: ${e.message}`); }
  }, { deferred: true });
}

// ── PDF Tool ─────────────────────────────────────────────────────────────

const PDF_READ_ACTIONS = new Set(["inspect", "extract_text", "extract_pages_text", "get_form_fields"]);
const PDF_WRITE_ACTIONS = new Set(["create", "split", "merge", "fill_form", "add_text"]);

function registerPdfTools(registry) {
  registry.register("Pdf", {
    description: "PDF operations on .pdf files. Actions: create, inspect, extract_text, extract_pages_text, split, merge, fill_form, get_form_fields, add_text. Use create to make a blank PDF, extract_text for reading, split/merge for restructuring, fill_form for fillable forms, add_text for placing text on non-fillable PDFs.",
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["create", "inspect", "extract_text", "extract_pages_text", "split", "merge", "fill_form", "get_form_fields", "add_text"], description: "PDF action" },
      file_path: { type: "string", description: "Path to .pdf file" },
      file_paths: { type: "array", items: { type: "string" }, description: "Array of PDF paths for merge" },
      pages: { type: "string", description: "Page range e.g. '1-3' or '1,3,5'" },
      output_path: { type: "string", description: "Output file path" },
      field_values: { type: "object", description: "Form field name→value pairs for fill_form" },
      texts: { type: "array", items: { type: "object" }, description: "Array of {page, x, y, text, size?, color?} for add_text. Coordinates in PDF points (y=0 is bottom)." },
    }, required: ["action"] }
  }, async (input) => {
    const a = input.action;
    try {
      if (a === "create") {
        if (!input.output_path) return _docError("create requires 'output_path'");
        const { PDFDocument } = await import("pdf-lib");
        const pdf = await PDFDocument.create();
        const pages = input.pages || 1;
        for (let i = 0; i < pages; i++) pdf.addPage();
        const out = path.resolve(input.output_path);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, await pdf.save());
        return { content: `Created ${out} (${pages} page(s))`, is_error: false };
      }
      if (a === "inspect") {
        const vp = _validateDocPath(input.file_path, [".pdf"]);
        if (vp.error) return _docError(vp.error);
        const { PDFDocument } = await import("pdf-lib");
        const bytes = fs.readFileSync(vp.resolved);
        const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
        return _docResult({ file: path.basename(vp.resolved), pages: pdf.getPageCount(), title: pdf.getTitle() || null, author: pdf.getAuthor() || null, creator: pdf.getCreator() || null, subject: pdf.getSubject() || null, sizeKB: Math.round(bytes.length / 1024) });
      }
      if (a === "extract_text") {
        const vp = _validateDocPath(input.file_path, [".pdf"]);
        if (vp.error) return _docError(vp.error);
        const { extractText } = await import("unpdf");
        const buf = fs.readFileSync(vp.resolved);
        const { text, totalPages } = await extractText(new Uint8Array(buf));
        const fullText = Array.isArray(text) ? text.join("\n\n") : String(text);
        if (fullText.length > 20000) return _docResult({ text: fullText.slice(0, 20000), totalChars: fullText.length, truncated: true, pages: totalPages });
        return _docResult({ text: fullText, pages: totalPages });
      }
      if (a === "extract_pages_text") {
        const vp = _validateDocPath(input.file_path, [".pdf"]);
        if (vp.error) return _docError(vp.error);
        const { extractText } = await import("unpdf");
        const buf = fs.readFileSync(vp.resolved);
        const { text, totalPages } = await extractText(new Uint8Array(buf));
        const pages = Array.isArray(text) ? text : [String(text)];
        return _docResult(pages.map((t, i) => ({ page: i + 1, text: (t || "").slice(0, 5000) })));
      }
      if (a === "split") {
        const vp = _validateDocPath(input.file_path, [".pdf"]);
        if (vp.error) return _docError(vp.error);
        if (!input.pages) return _docError("split requires 'pages' (e.g. '1-3' or '1,3,5')");
        if (!input.output_path) return _docError("split requires 'output_path'");
        const { PDFDocument } = await import("pdf-lib");
        const srcBytes = fs.readFileSync(vp.resolved);
        const srcPdf = await PDFDocument.load(srcBytes);
        const newPdf = await PDFDocument.create();
        // Parse page range
        const pageIndices = [];
        for (const part of input.pages.split(",")) {
          const trimmed = part.trim();
          if (trimmed.includes("-")) { const [s, e] = trimmed.split("-").map(Number); for (let i = s; i <= e; i++) pageIndices.push(i - 1); }
          else pageIndices.push(Number(trimmed) - 1);
        }
        const copied = await newPdf.copyPages(srcPdf, pageIndices);
        for (const page of copied) newPdf.addPage(page);
        const out = path.resolve(input.output_path);
        fs.writeFileSync(out, await newPdf.save());
        return { content: `Split ${pageIndices.length} page(s) → ${out}`, is_error: false };
      }
      if (a === "merge") {
        if (!input.file_paths || !Array.isArray(input.file_paths) || input.file_paths.length < 2) return _docError("merge requires 'file_paths' array with at least 2 PDFs");
        if (!input.output_path) return _docError("merge requires 'output_path'");
        const { PDFDocument } = await import("pdf-lib");
        const merged = await PDFDocument.create();
        for (const fp of input.file_paths) {
          const vp = _validateDocPath(fp, [".pdf"]);
          if (vp.error) return _docError(`${fp}: ${vp.error}`);
          const src = await PDFDocument.load(fs.readFileSync(vp.resolved));
          const pages = await merged.copyPages(src, src.getPageIndices());
          for (const p of pages) merged.addPage(p);
        }
        const out = path.resolve(input.output_path);
        fs.writeFileSync(out, await merged.save());
        return { content: `Merged ${input.file_paths.length} PDFs → ${out}`, is_error: false };
      }
      if (a === "get_form_fields") {
        const vp = _validateDocPath(input.file_path, [".pdf"]);
        if (vp.error) return _docError(vp.error);
        const { PDFDocument } = await import("pdf-lib");
        const pdf = await PDFDocument.load(fs.readFileSync(vp.resolved));
        const form = pdf.getForm();
        const fields = form.getFields().map(f => ({ name: f.getName(), type: f.constructor.name.replace("PDF", "").replace("Field", "").toLowerCase() }));
        return _docResult(fields);
      }
      if (a === "fill_form") {
        const vp = _validateDocPath(input.file_path, [".pdf"]);
        if (vp.error) return _docError(vp.error);
        if (!input.field_values) return _docError("fill_form requires 'field_values' object");
        if (!input.output_path) return _docError("fill_form requires 'output_path'");
        const { PDFDocument } = await import("pdf-lib");
        const pdf = await PDFDocument.load(fs.readFileSync(vp.resolved));
        const form = pdf.getForm();
        let filled = 0;
        for (const [name, value] of Object.entries(input.field_values)) {
          try { const f = form.getTextField(name); f.setText(String(value)); filled++; } catch { /* field not found or not text field */ }
        }
        const out = path.resolve(input.output_path);
        fs.writeFileSync(out, await pdf.save());
        return { content: `Filled ${filled} field(s) → ${out}`, is_error: false };
      }
      if (a === "add_text") {
        const vp = _validateDocPath(input.file_path, [".pdf"]);
        if (vp.error) return _docError(vp.error);
        if (!input.texts || !Array.isArray(input.texts)) return _docError("add_text requires 'texts' array of {page, x, y, text, size?, color?}");
        if (!input.output_path) return _docError("add_text requires 'output_path'");
        const { PDFDocument, rgb } = await import("pdf-lib");
        const pdf = await PDFDocument.load(fs.readFileSync(vp.resolved));
        let added = 0;
        for (const t of input.texts) {
          if (!t.text || t.page == null || t.x == null || t.y == null) continue;
          const pageIdx = (t.page || 1) - 1;
          if (pageIdx < 0 || pageIdx >= pdf.getPageCount()) continue;
          const page = pdf.getPage(pageIdx);
          const fontSize = t.size || 12;
          const color = t.color ? rgb(
            parseInt(t.color.slice(0, 2), 16) / 255,
            parseInt(t.color.slice(2, 4), 16) / 255,
            parseInt(t.color.slice(4, 6), 16) / 255
          ) : rgb(0, 0, 0);
          page.drawText(String(t.text), { x: t.x, y: t.y, size: fontSize, color });
          added++;
        }
        const out = path.resolve(input.output_path);
        fs.writeFileSync(out, await pdf.save());
        return { content: `Added ${added} text annotation(s) → ${out}`, is_error: false };
      }
      return _docError(`Unknown action: ${a}`);
    } catch (e) { return _docError(`PDF error: ${e.message}`); }
  }, { deferred: true });
}

// ── Document Tool (Word .docx) ───────────────────────────────────────────

const DOCUMENT_READ_ACTIONS = new Set(["inspect", "read_text", "extract_headings", "extract_html", "export_text"]);

function registerDocumentTools(registry) {
  registry.register("Document", {
    description: "Word document operations on .docx files. Actions: inspect, read_text, extract_headings, extract_html, export_text, create, unpack, pack. Use create to generate new documents with the docx npm lib. Use unpack/pack to edit existing documents via XML.",
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["inspect", "read_text", "extract_headings", "extract_html", "export_text", "create", "unpack", "pack"], description: "Document action" },
      file_path: { type: "string", description: "Path to .docx file (or directory for pack)" },
      output_path: { type: "string", description: "Output file path" },
      content: { type: "object", description: "For create: {title?, sections: [{heading?, paragraphs: [string|{text,bold?,italic?,size?}], table?: [[cell,...]]}]}" },
    }, required: ["action"] }
  }, async (input) => {
    const a = input.action;
    try {
      // Write actions that don't need an existing file
      if (a === "create") {
        if (!input.output_path) return _docError("create requires 'output_path'");
        if (!input.content) return _docError("create requires 'content' object with sections[]");
        const docx = await import("docx");
        const content = typeof input.content === "string" ? JSON.parse(input.content) : input.content;
        const children = [];
        if (content.title) {
          children.push(new docx.Paragraph({ text: content.title, heading: docx.HeadingLevel.TITLE }));
        }
        for (const section of (content.sections || [])) {
          if (section.heading) {
            children.push(new docx.Paragraph({ text: section.heading, heading: docx.HeadingLevel.HEADING_1 }));
          }
          for (const para of (section.paragraphs || [])) {
            if (typeof para === "string") {
              children.push(new docx.Paragraph({ text: para }));
            } else if (para.text) {
              const runs = [new docx.TextRun({ text: para.text, bold: para.bold, italic: para.italic, size: para.size })];
              children.push(new docx.Paragraph({ children: runs }));
            }
          }
          if (section.table) {
            const rows = section.table.map(row =>
              new docx.TableRow({ children: row.map(cell =>
                new docx.TableCell({ children: [new docx.Paragraph({ text: String(cell) })] })
              )})
            );
            children.push(new docx.Table({ rows }));
          }
        }
        const doc = new docx.Document({ sections: [{ children }] });
        const buffer = await docx.Packer.toBuffer(doc);
        const out = path.resolve(input.output_path);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, buffer);
        return { content: `Created ${out} (${Math.round(buffer.length / 1024)}KB)`, is_error: false };
      }
      if (a === "unpack") {
        const vp = _validateDocPath(input.file_path, [".docx", ".pptx"]);
        if (vp.error) return _docError(vp.error);
        if (!input.output_path) return _docError("unpack requires 'output_path' directory");
        const outDir = path.resolve(input.output_path);
        fs.mkdirSync(outDir, { recursive: true });
        const { execSync } = await import("node:child_process");
        execSync(`unzip -o "${vp.resolved}" -d "${outDir}"`, { stdio: "pipe" });
        const files = [];
        const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { if (f.isFile()) files.push(path.relative(outDir, path.join(dir, f.name))); else walk(path.join(dir, f.name)); }};
        walk(outDir);
        return { content: `Unpacked ${path.basename(vp.resolved)} → ${outDir} (${files.length} files)`, is_error: false };
      }
      if (a === "pack") {
        if (!input.file_path) return _docError("pack requires 'file_path' (input directory)");
        if (!input.output_path) return _docError("pack requires 'output_path' (.docx file)");
        const srcDir = path.resolve(input.file_path);
        if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return _docError(`${srcDir} is not a directory`);
        const out = path.resolve(input.output_path);
        const { execSync } = await import("node:child_process");
        execSync(`cd "${srcDir}" && zip -r "${out}" . -x ".*"`, { stdio: "pipe" });
        const stat = fs.statSync(out);
        return { content: `Packed ${srcDir} → ${out} (${Math.round(stat.size / 1024)}KB)`, is_error: false };
      }
      // Read actions need an existing file
      const vp = _validateDocPath(input.file_path, [".docx"]);
      if (vp.error) return _docError(vp.error);
      const mammoth = (await import("mammoth")).default;
      if (a === "inspect") {
        const html = await mammoth.convertToHtml({ path: vp.resolved });
        const headings = (html.value.match(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gi) || []).length;
        const paragraphs = (html.value.match(/<p[^>]*>/gi) || []).length;
        const images = (html.value.match(/<img[^>]*>/gi) || []).length;
        const tables = (html.value.match(/<table[^>]*>/gi) || []).length;
        return _docResult({ file: path.basename(vp.resolved), headings, paragraphs, images, tables, sizeKB: Math.round(fs.statSync(vp.resolved).size / 1024) });
      }
      if (a === "read_text") {
        const result = await mammoth.extractRawText({ path: vp.resolved });
        const text = result.value || "";
        if (text.length > 20000) return _docResult({ text: text.slice(0, 20000), totalChars: text.length, truncated: true });
        return _docResult({ text });
      }
      if (a === "extract_headings") {
        const html = await mammoth.convertToHtml({ path: vp.resolved });
        const headings = [];
        const re = /<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi;
        let m;
        while ((m = re.exec(html.value)) !== null) { headings.push({ level: parseInt(m[1]), text: m[2].replace(/<[^>]*>/g, "").trim() }); }
        return _docResult(headings);
      }
      if (a === "extract_html") {
        const result = await mammoth.convertToHtml({ path: vp.resolved });
        const html = result.value || "";
        if (html.length > 30000) return _docResult({ html: html.slice(0, 30000), totalChars: html.length, truncated: true });
        return _docResult({ html });
      }
      if (a === "export_text") {
        const result = await mammoth.extractRawText({ path: vp.resolved });
        const out = input.output_path ? path.resolve(input.output_path) : vp.resolved.replace(/\.docx$/i, ".txt");
        fs.writeFileSync(out, result.value || "");
        return { content: `Exported text → ${out}`, is_error: false };
      }
      return _docError(`Unknown action: ${a}`);
    } catch (e) { return _docError(`Document error: ${e.message}`); }
  }, { deferred: true });
}

// ── Presentation Tool (PowerPoint .pptx) ─────────────────────────────────

const PRESENTATION_READ_ACTIONS = new Set(["inspect", "list_slides", "extract_text", "read_notes", "export_text_outline"]);

function registerPresentationTools(registry) {
  registry.register("Presentation", {
    description: "PowerPoint presentation operations on .pptx files. Actions: create, inspect, list_slides, extract_text, read_notes, export_text_outline, unpack, pack, visual_qa. Use create to generate new presentations, unpack/pack to edit existing ones via XML, visual_qa to convert slides to images for visual inspection.",
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["create", "inspect", "list_slides", "extract_text", "read_notes", "export_text_outline", "unpack", "pack", "visual_qa"], description: "Presentation action" },
      file_path: { type: "string", description: "Path to .pptx file (or directory for pack)" },
      slide_index: { type: "integer", description: "1-based slide index for specific slide operations" },
      output_path: { type: "string", description: "Output file/directory path (for visual_qa: directory for slide images)" },
      content: { type: "object", description: "For create: {layout?: '16x9'|'4x3', slides: [{title?, body?: [string], notes?}]}" },
    }, required: ["action"] }
  }, async (input) => {
    const a = input.action;
    // create uses pptxgenjs
    if (a === "create") {
      if (!input.output_path) return _docError("create requires 'output_path'");
      if (!input.content) return _docError("create requires 'content' object with slides[]");
      const pptxgen = (await import("pptxgenjs")).default;
      const content = typeof input.content === "string" ? JSON.parse(input.content) : input.content;
      const pres = new pptxgen();
      pres.layout = content.layout === "4x3" ? "LAYOUT_4x3" : "LAYOUT_16x9";
      for (const slideData of (content.slides || [])) {
        const slide = pres.addSlide();
        if (slideData.title) {
          slide.addText(slideData.title, { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 28, bold: true });
        }
        if (slideData.body && Array.isArray(slideData.body)) {
          const bodyItems = slideData.body.map((item, i) => ({
            text: String(item),
            options: { bullet: true, breakLine: i < slideData.body.length - 1 },
          }));
          slide.addText(bodyItems, { x: 0.5, y: 1.5, w: 9, h: 3.5, fontSize: 18 });
        }
        if (slideData.notes) {
          slide.addNotes(String(slideData.notes));
        }
      }
      const out = path.resolve(input.output_path);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await pres.writeFile({ fileName: out });
      return { content: `Created ${out} (${(content.slides || []).length} slide(s))`, is_error: false };
    }
    // unpack/pack don't need JSZip loading
    if (a === "unpack") {
      const vp = _validateDocPath(input.file_path, [".pptx"]);
      if (vp.error) return _docError(vp.error);
      if (!input.output_path) return _docError("unpack requires 'output_path' directory");
      const outDir = path.resolve(input.output_path);
      fs.mkdirSync(outDir, { recursive: true });
      const { execSync } = await import("node:child_process");
      execSync(`unzip -o "${vp.resolved}" -d "${outDir}"`, { stdio: "pipe" });
      let xmlCount = 0;
      const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) { const fp = path.join(dir, f.name); if (f.isFile() && (f.name.endsWith(".xml") || f.name.endsWith(".rels"))) xmlCount++; else if (f.isDirectory()) walk(fp); }};
      walk(outDir);
      return { content: `Unpacked ${path.basename(vp.resolved)} → ${outDir} (${xmlCount} XML/rels files)`, is_error: false };
    }
    if (a === "pack") {
      if (!input.file_path) return _docError("pack requires 'file_path' (input directory)");
      if (!input.output_path) return _docError("pack requires 'output_path' (.pptx file)");
      const srcDir = path.resolve(input.file_path);
      if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) return _docError(`${srcDir} is not a directory`);
      const out = path.resolve(input.output_path);
      const { execSync } = await import("node:child_process");
      execSync(`cd "${srcDir}" && zip -r "${out}" . -x ".*"`, { stdio: "pipe" });
      const stat = fs.statSync(out);
      return { content: `Packed ${srcDir} → ${out} (${Math.round(stat.size / 1024)}KB)`, is_error: false };
    }
    // visual_qa: PPTX → PDF (soffice) → images (pdftoppm) → return image paths for inspection
    if (a === "visual_qa") {
      const vp = _validateDocPath(input.file_path, [".pptx"]);
      if (vp.error) return _docError(vp.error);
      const { execSync } = await import("node:child_process");
      const outDir = input.output_path ? path.resolve(input.output_path) : path.join(os.tmpdir(), `pptx-qa-${Date.now()}`);
      fs.mkdirSync(outDir, { recursive: true });

      // Step 1: PPTX → PDF via LibreOffice
      const pdfPath = path.join(outDir, path.basename(vp.resolved).replace(/\.pptx$/i, ".pdf"));
      try {
        // Try soffice (LibreOffice)
        const sofficePaths = ["soffice", "/Applications/LibreOffice.app/Contents/MacOS/soffice", "/usr/bin/soffice"];
        let sofficeCmd = null;
        for (const p of sofficePaths) {
          try { execSync(`"${p}" --version`, { stdio: "pipe" }); sofficeCmd = p; break; } catch { /* try next */ }
        }
        if (!sofficeCmd) return _docError("visual_qa requires LibreOffice (soffice) installed for PPTX→PDF conversion");
        execSync(`"${sofficeCmd}" --headless --convert-to pdf --outdir "${outDir}" "${vp.resolved}"`, { stdio: "pipe", timeout: 60000, env: { ...process.env, SAL_USE_VCLPLUGIN: "svp" } });
        if (!fs.existsSync(pdfPath)) return _docError(`LibreOffice conversion failed — no PDF produced`);
      } catch (e) {
        return _docError(`PPTX→PDF conversion failed: ${e.message}`);
      }

      // Step 2: PDF → images via pdftoppm
      const images = [];
      try {
        execSync(`pdftoppm -jpeg -r 150 "${pdfPath}" "${path.join(outDir, "slide")}"`, { stdio: "pipe", timeout: 30000 });
        const files = fs.readdirSync(outDir).filter(f => f.startsWith("slide") && f.endsWith(".jpg")).sort();
        for (const f of files) images.push(path.join(outDir, f));
      } catch {
        // Fallback: if pdftoppm not available, return the PDF path for manual inspection
        return { content: `PDF created at ${pdfPath} but pdftoppm not found for image conversion.\nInstall poppler: brew install poppler (macOS) or apt install poppler-utils (Linux).\nYou can use the Read tool to view the PDF directly.`, is_error: false };
      }

      // Clean up PDF (keep images)
      try { fs.unlinkSync(pdfPath); } catch { /* ignore */ }

      return { content: `Visual QA: ${images.length} slide image(s) generated.\n\nUse the Read tool to inspect each image:\n${images.map((img, i) => `  Slide ${i + 1}: ${img}`).join("\n")}\n\nLook for: overlapping elements, text overflow, low contrast, misaligned columns, leftover placeholders.`, is_error: false };
    }
    // Read actions need an existing file
    const vp = _validateDocPath(input.file_path, [".pptx"]);
    if (vp.error) return _docError(vp.error);
    try {
      const JSZip = (await import("jszip")).default;
      const buf = fs.readFileSync(vp.resolved);
      const zip = await JSZip.loadAsync(buf);
      // Discover slides
      const slideFiles = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => {
        const na = parseInt(a.match(/slide(\d+)/)[1]); const nb = parseInt(b.match(/slide(\d+)/)[1]); return na - nb;
      });
      // Helper: extract text from slide XML
      const extractSlideText = async (slideFile) => {
        const xml = await zip.file(slideFile).async("string");
        const texts = []; const re = /<a:t>(.*?)<\/a:t>/g; let m;
        while ((m = re.exec(xml)) !== null) texts.push(m[1]);
        return texts;
      };
      // Helper: extract notes from slide XML
      const extractSlideNotes = async (slideFile) => {
        const xml = await zip.file(slideFile).async("string");
        const notesMatch = xml.match(/<p:notes>([\s\S]*?)<\/p:notes>/);
        if (!notesMatch) return null;
        const texts = []; const re = /<a:t>(.*?)<\/a:t>/g; let m;
        while ((m = re.exec(notesMatch[1])) !== null) texts.push(m[1]);
        return texts.length > 0 ? texts.join(" ") : null;
      };

      if (a === "inspect") {
        return _docResult({ file: path.basename(vp.resolved), slides: slideFiles.length, sizeKB: Math.round(buf.length / 1024), hasNotes: false });
      }
      if (a === "list_slides") {
        const slides = [];
        for (let i = 0; i < slideFiles.length; i++) {
          const texts = await extractSlideText(slideFiles[i]);
          const title = texts[0] || "(untitled)";
          const bodyPreview = texts.slice(1).join(" ").slice(0, 100);
          slides.push({ index: i + 1, title, bodyPreview, textCount: texts.length });
        }
        return _docResult(slides);
      }
      if (a === "extract_text") {
        if (input.slide_index) {
          const idx = input.slide_index - 1;
          if (idx < 0 || idx >= slideFiles.length) return _docError(`Slide ${input.slide_index} out of range (1-${slideFiles.length})`);
          const texts = await extractSlideText(slideFiles[idx]);
          return _docResult({ slide: input.slide_index, texts });
        }
        const allSlides = [];
        for (let i = 0; i < slideFiles.length; i++) {
          const texts = await extractSlideText(slideFiles[i]);
          allSlides.push({ slide: i + 1, texts });
        }
        return _docResult(allSlides);
      }
      if (a === "read_notes") {
        const notes = [];
        for (let i = 0; i < slideFiles.length; i++) {
          const note = await extractSlideNotes(slideFiles[i]);
          if (note) notes.push({ slide: i + 1, notes: note });
        }
        return _docResult(notes.length > 0 ? notes : []);
      }
      if (a === "export_text_outline") {
        const lines = [];
        for (let i = 0; i < slideFiles.length; i++) {
          const texts = await extractSlideText(slideFiles[i]);
          lines.push(`## Slide ${i + 1}: ${texts[0] || "(untitled)"}`);
          for (const t of texts.slice(1)) lines.push(`- ${t}`);
          const note = await extractSlideNotes(slideFiles[i]);
          if (note) lines.push(`  [Notes: ${note}]`);
          lines.push("");
        }
        const outline = lines.join("\n");
        if (input.output_path) { const out = path.resolve(input.output_path); fs.writeFileSync(out, outline); return { content: `Exported outline → ${out}`, is_error: false }; }
        return { content: outline, is_error: false };
      }
      return _docError(`Unknown action: ${a}`);
    } catch (e) { return _docError(`Presentation error: ${e.message}`); }
  }, { deferred: true });
}

// ── Desktop Tool (macOS accessibility) ────────────────────────────────────

const DESKTOP_READ_ACTIONS = new Set(["list_windows", "get_tree", "screenshot", "get_focused"]);
const DESKTOP_WRITE_ACTIONS = new Set(["focus_window", "click_element", "type_text", "send_keys", "open_app", "close_window"]);

function _osascript(script) {
  return new Promise((resolve) => {
    try {
      const result = execSync(`osascript -e '${script.replace(/'/g, "'\\''")}'`, { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] });
      resolve({ content: result.trim(), is_error: false });
    } catch (e) { resolve({ content: e.stderr?.trim() || e.message, is_error: true }); }
  });
}

function registerDesktopTools(registry) {
  if (process.platform !== "darwin") return; // macOS only for now

  registry.register("Desktop", {
    description: "Desktop automation via macOS accessibility. Actions: list_windows, focus_window, get_tree, click_element, type_text, send_keys, screenshot, get_focused, open_app, close_window. Use list_windows first to see apps, get_tree to inspect UI elements, then interact.",
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["list_windows", "focus_window", "get_tree", "click_element", "type_text", "send_keys", "screenshot", "get_focused", "open_app", "close_window"], description: "Desktop action" },
      app: { type: "string", description: "Application name (e.g. 'Safari', 'Excel', 'Finder')" },
      element_path: { type: "string", description: "Accessibility element path for click_element (e.g. 'button 1', 'text field 1')" },
      text: { type: "string", description: "Text to type for type_text" },
      keys: { type: "string", description: "Key combo for send_keys (e.g. 'command+s', 'return', 'tab')" },
      output_path: { type: "string", description: "Output path for screenshot" },
    }, required: ["action"] }
  }, async (input) => {
    const a = input.action;
    try {
      if (a === "list_windows") {
        const result = await _osascript('tell application "System Events" to get {name, title of first window} of every process whose visible is true');
        if (result.is_error) {
          // Fallback: just list app names
          const names = await _osascript('tell application "System Events" to get name of every process whose visible is true');
          if (names.is_error) return names;
          return _docResult(names.content.split(", ").map((name, i) => ({ index: i, app: name })));
        }
        return { content: result.content, is_error: false };
      }

      if (a === "get_focused") {
        const result = await _osascript('tell application "System Events" to get name of first process whose frontmost is true');
        return result;
      }

      if (a === "focus_window") {
        if (!input.app) return _docError("focus_window requires 'app'");
        const result = await _osascript(`tell application "${input.app}" to activate`);
        if (result.is_error) return result;
        return { content: `Focused: ${input.app}`, is_error: false };
      }

      if (a === "open_app") {
        if (!input.app) return _docError("open_app requires 'app'");
        const result = await _osascript(`tell application "${input.app}" to launch`);
        if (result.is_error) return result;
        await new Promise(r => setTimeout(r, 1000));
        return { content: `Opened: ${input.app}`, is_error: false };
      }

      if (a === "close_window") {
        if (!input.app) return _docError("close_window requires 'app'");
        const result = await _osascript(`tell application "${input.app}" to close front window`);
        if (result.is_error) return result;
        return { content: `Closed front window of ${input.app}`, is_error: false };
      }

      if (a === "get_tree") {
        if (!input.app) return _docError("get_tree requires 'app'");
        // Get accessibility tree of the front window
        const script = `tell application "System Events"
          tell process "${input.app}"
            set uiElements to {}
            try
              set frontWin to front window
              set winName to name of frontWin
              repeat with i from 1 to count of UI elements of frontWin
                set el to UI element i of frontWin
                set elRole to role of el
                set elName to ""
                try
                  set elName to name of el
                end try
                set elDesc to ""
                try
                  set elDesc to description of el
                end try
                set elVal to ""
                try
                  set elVal to value of el as text
                end try
                set end of uiElements to "[" & i & "] " & elRole & " \\"" & elName & "\\"" & " desc=\\"" & elDesc & "\\"" & " val=\\"" & (text 1 thru (min of {80, length of elVal}) of (elVal & "")) & "\\""
              end repeat
              return "Window: " & winName & return & (uiElements as text)
            on error errMsg
              return "Error: " & errMsg
            end try
          end tell
        end tell`;
        const result = await _osascript(script);
        return result;
      }

      if (a === "click_element") {
        if (!input.app || !input.element_path) return _docError("click_element requires 'app' and 'element_path'");
        const result = await _osascript(`tell application "System Events" to tell process "${input.app}" to click ${input.element_path} of front window`);
        if (result.is_error) return result;
        return { content: `Clicked: ${input.element_path} in ${input.app}`, is_error: false };
      }

      if (a === "type_text") {
        if (!input.app || !input.text) return _docError("type_text requires 'app' and 'text'");
        // Focus app then keystroke
        await _osascript(`tell application "${input.app}" to activate`);
        await new Promise(r => setTimeout(r, 200));
        const result = await _osascript(`tell application "System Events" to keystroke "${input.text.replace(/"/g, '\\"')}"`);
        if (result.is_error) return result;
        return { content: `Typed "${input.text}" in ${input.app}`, is_error: false };
      }

      if (a === "send_keys") {
        if (!input.keys) return _docError("send_keys requires 'keys'");
        if (input.app) await _osascript(`tell application "${input.app}" to activate`);
        await new Promise(r => setTimeout(r, 200));
        // Parse key combo: "command+s" → key code s using command down
        const parts = input.keys.split("+");
        const key = parts.pop();
        const modifiers = parts.map(m => m.trim().toLowerCase());
        let modStr = "";
        if (modifiers.length > 0) modStr = " using {" + modifiers.map(m => m === "cmd" || m === "command" ? "command down" : m === "shift" ? "shift down" : m === "alt" || m === "option" ? "option down" : m === "ctrl" || m === "control" ? "control down" : m + " down").join(", ") + "}";
        // Named keys
        const keyMap = { return: "return", enter: "return", tab: "tab", escape: "escape", space: "space", delete: "delete", backspace: "delete", up: "up arrow", down: "down arrow", left: "left arrow", right: "right arrow" };
        const mappedKey = keyMap[key.toLowerCase()];
        let script;
        if (mappedKey) { script = `tell application "System Events" to key code ${key === "return" || key === "enter" ? 36 : key === "tab" ? 48 : key === "escape" ? 53 : key === "space" ? 49 : key === "delete" || key === "backspace" ? 51 : key === "up" ? 126 : key === "down" ? 125 : key === "left" ? 123 : key === "right" ? 124 : 0}${modStr}`; }
        else { script = `tell application "System Events" to keystroke "${key}"${modStr}`; }
        const result = await _osascript(script);
        if (result.is_error) return result;
        return { content: `Sent keys: ${input.keys}${input.app ? " to " + input.app : ""}`, is_error: false };
      }

      if (a === "screenshot") {
        const dir = path.join(os.tmpdir(), "cloclo-screenshots");
        fs.mkdirSync(dir, { recursive: true });
        const fp = input.output_path || path.join(dir, `desktop-${Date.now()}.png`);
        if (input.app) {
          // Screenshot specific app window
          execSync(`screencapture -l $(osascript -e 'tell application "System Events" to get id of first window of process "${input.app}"' 2>/dev/null || echo 0) "${fp}"`, { timeout: 10000, stdio: "pipe" });
        } else {
          execSync(`screencapture -x "${fp}"`, { timeout: 10000, stdio: "pipe" });
        }
        if (fs.existsSync(fp)) return { content: `Screenshot saved: ${fp} (${(fs.statSync(fp).size / 1024).toFixed(1)} KB)`, is_error: false };
        return _docError("Screenshot failed");
      }

      return _docError(`Unknown action: ${a}`);
    } catch (e) { return _docError(`Desktop error: ${e.message}`); }
  }, { deferred: true });
}

// ── Browser Tool Pack (CDP-native, enterprise) ────────────────────────────
// ── Built-in Tools ──────────────────────────────────────────────

function registerBuiltinTools(registry) {
  // Bash
  registry.register("Bash", {
    description: `Executes a bash command and returns its output.

IMPORTANT: Avoid using this tool to run find, grep, cat, head, tail, sed, awk, or echo commands. Instead, use the appropriate dedicated tool:
 - File search: Use Glob (NOT find or ls)
 - Content search: Use Grep (NOT grep or rg)
 - Read files: Use Read (NOT cat/head/tail)
 - Edit files: Use Edit (NOT sed/awk)
 - Write files: Use Write (NOT echo >/cat <<EOF)

Reserve Bash exclusively for system commands and terminal operations that require shell execution (git, npm, docker, build commands, etc.).`,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The bash command to execute" },
        timeout: { type: "number", description: "Timeout in milliseconds (default: 120000, max: 600000)" },
      },
      required: ["command"],
    },
  }, async (input) => {
    const timeout = Math.min(input.timeout || 120000, 600000);
    return new Promise((resolve) => {
      const proc = spawn("bash", ["-c", input.command], {
        timeout,
        cwd: input.cwd || registry._cwd || process.cwd(),
        env: { ...process.env, TERM: "dumb" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "", stderr = "";
      proc.stdout.on("data", (d) => { stdout += d; });
      proc.stderr.on("data", (d) => { stderr += d; });

      proc.on("close", (code) => {
        const out = (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim();
        if (code !== 0 && code !== null) {
          resolve({ content: out || `Process exited with code ${code}`, is_error: true });
        } else {
          resolve({ content: out || "(no output)", is_error: false });
        }
      });

      proc.on("error", (e) => {
        resolve({ content: `Spawn error: ${e.message}`, is_error: true });
      });

      proc.stdin.end();
    });
  });

  // Read
  registry.register("Read", {
    description: `Read a file from the filesystem. Returns content with line numbers (cat -n format).

Use this tool instead of cat, head, or tail via Bash. You can read any file directly by path.
- By default reads up to 2000 lines from the beginning
- Use offset and limit for long files
- Can read images (PNG, JPG), PDFs (use pages param for large PDFs), and Jupyter notebooks
- Always use absolute paths, not relative paths`,
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to the file" },
        offset: { type: "number", description: "Line number to start from (1-indexed)" },
        limit: { type: "number", description: "Max lines to read" },
      },
      required: ["file_path"],
    },
  }, async (input) => {
    const sensitiveSeg = _isSensitivePath(input.file_path);
    if (sensitiveSeg) return { content: `Blocked: ${sensitiveSeg} is a sensitive path`, is_error: true };
    const content = await fs.promises.readFile(input.file_path, "utf-8");
    let lines = content.split("\n");
    const offset = (input.offset || 1) - 1;
    const limit = input.limit || 2000;
    lines = lines.slice(offset, offset + limit);
    const numbered = lines.map((l, i) => {
      const num = String(offset + i + 1).padStart(6, " ");
      const truncated = l.length > 2000 ? l.slice(0, 2000) + "..." : l;
      return `${num}\t${truncated}`;
    });
    return numbered.join("\n");
  });

  // Write
  registry.register("Write", {
    description: `Write content to a file. Creates parent directories if needed. Overwrites existing files.

Use this tool instead of echo/cat heredoc via Bash.
- You MUST use the Read tool first if the file already exists
- Prefer the Edit tool for modifying existing files — it only sends the diff
- Only use Write to create new files or for complete rewrites`,
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Absolute path to write to" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["file_path", "content"],
    },
  }, async (input) => {
    const sensitiveSeg = _isSensitivePath(input.file_path);
    if (sensitiveSeg) return { content: `Blocked: ${sensitiveSeg} is a sensitive path`, is_error: true };
    // Checkpoint before mutation
    if (registry._checkpoints) registry._checkpoints.backupBeforeMutation(input.file_path, registry._messageId);
    await fs.promises.mkdir(path.dirname(input.file_path), { recursive: true });
    await fs.promises.writeFile(input.file_path, input.content);
    const lines = input.content.split("\n").length;
    return `Wrote ${lines} lines to ${input.file_path}`;
  });

  // Edit
  registry.register("Edit", {
    description: `Performs exact string replacements in files.

Usage:
- You must use the Read tool at least once before editing a file.
- The edit will FAIL if old_string is not unique in the file. Provide more surrounding context to make it unique, or use replace_all.
- Use replace_all for renaming variables or replacing all occurrences across the file.
- When old_string is empty and the file doesn't exist, creates a new file with new_string as content.`,
    input_schema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The absolute path to the file to modify" },
        old_string: { type: "string", description: "The text to replace (must be unique in the file unless replace_all is true)" },
        new_string: { type: "string", description: "The replacement text (must be different from old_string)" },
        replace_all: { type: "boolean", description: "Replace all occurrences of old_string (default: false)", default: false },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  }, async (input) => {
    const sensitiveSeg = _isSensitivePath(input.file_path);
    if (sensitiveSeg) return { content: `Blocked: ${sensitiveSeg} is a sensitive path`, is_error: true };
    // Checkpoint before mutation
    if (registry._checkpoints) registry._checkpoints.backupBeforeMutation(input.file_path, registry._messageId);
    const filePath = input.file_path;
    const oldStr = input.old_string ?? "";
    const newStr = input.new_string ?? "";
    const replaceAll = input.replace_all ?? false;

    // Create new file if old_string is empty and file doesn't exist
    if (oldStr === "" && newStr !== "") {
      try {
        await fs.promises.access(filePath);
        // File exists — old_string="" means prepend or full replace
        const content = await fs.promises.readFile(filePath, "utf-8");
        if (content === "") {
          await fs.promises.writeFile(filePath, newStr);
          return `Created ${filePath}`;
        }
        return { content: "old_string is empty but file is not empty. Use Write to overwrite, or provide the text to replace.", is_error: true };
      } catch {
        // File doesn't exist — create it
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, newStr);
        return `Created ${filePath} (${newStr.split("\n").length} lines)`;
      }
    }

    if (oldStr === newStr) {
      return { content: "old_string and new_string are identical. No changes made.", is_error: true };
    }

    // Read file
    let content;
    try {
      content = await fs.promises.readFile(filePath, "utf-8");
    } catch {
      return { content: `File not found: ${filePath}`, is_error: true };
    }

    // Smart quote normalization — try matching with normalized quotes if exact match fails
    let matchStr = oldStr;
    if (!content.includes(oldStr)) {
      const normalized = oldStr
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201C\u201D]/g, '"');
      if (content.includes(normalized)) {
        matchStr = normalized;
      } else {
        // Try normalizing the content side too
        const normContent = content
          .replace(/[\u2018\u2019]/g, "'")
          .replace(/[\u201C\u201D]/g, '"');
        const idx = normContent.indexOf(normalized);
        if (idx !== -1) {
          matchStr = content.substring(idx, idx + oldStr.length);
        } else {
          return { content: "old_string not found in file. Make sure it matches exactly, including whitespace and indentation.", is_error: true };
        }
      }
    }

    // Uniqueness check (only when not replace_all)
    if (!replaceAll) {
      const firstIdx = content.indexOf(matchStr);
      const secondIdx = content.indexOf(matchStr, firstIdx + 1);
      if (secondIdx !== -1) {
        return { content: `old_string appears multiple times in the file (at least 2 occurrences). Provide more surrounding context to make it unique, or set replace_all: true.`, is_error: true };
      }
    }

    // Apply the replacement — if deleting (newStr="") and old_string+\n exists, remove the trailing newline too
    const target = (newStr === "" && !matchStr.endsWith("\n") && content.includes(matchStr + "\n") && !replaceAll)
      ? matchStr + "\n" : matchStr;
    let updated;
    if (replaceAll) {
      updated = content.replaceAll(target, newStr);
    } else {
      updated = content.replace(target, newStr);
    }

    if (updated === content) {
      return { content: "No changes resulted from the edit.", is_error: true };
    }

    await fs.promises.writeFile(filePath, updated);

    // Count changes
    const count = replaceAll
      ? (content.split(matchStr).length - 1)
      : 1;

    return `Applied ${count} edit${count > 1 ? "s" : ""} to ${filePath}`;
  });

  // WebFetch
  const _webFetchCache = new Map(); // url → { data, timestamp }
  const WEB_FETCH_CACHE_TTL = 15 * 60 * 1000; // 15 minutes
  const WEB_FETCH_MAX_CHARS = 100000;

  registry.register("WebFetch", {
    description: `Fetches content from a URL, converts HTML to readable text, and processes it with a prompt.

Use this tool when the user asks to read a webpage, documentation, article, or any URL. Do NOT use curl via Bash — use this tool instead.

Usage notes:
  - The URL must be a fully-formed valid URL
  - HTTP URLs will be automatically upgraded to HTTPS
  - The prompt should describe what information you want to extract from the page
  - Results may be summarized if the content is very large
  - Includes a self-cleaning 15-minute cache
  - For GitHub URLs, prefer using the gh CLI via Bash instead (gh pr view, gh issue view, gh api)`,
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to fetch content from" },
        prompt: { type: "string", description: "What information to extract from the page" },
      },
      required: ["url", "prompt"],
    },
  }, async (input) => {
    let url = input.url;
    const prompt = input.prompt;

    // Validate URL
    try { new URL(url); } catch {
      return { content: `Invalid URL: ${url}`, is_error: true };
    }
    if (_isPrivateUrl(url)) {
      return { content: `Blocked: fetching private/internal URLs is not allowed (${new URL(url).hostname})`, is_error: true };
    }

    // Upgrade HTTP → HTTPS
    if (url.startsWith("http://")) url = url.replace("http://", "https://");

    // Check cache
    const cached = _webFetchCache.get(url);
    if (cached && Date.now() - cached.timestamp < WEB_FETCH_CACHE_TTL) {
      log(`WebFetch cache hit: ${url}`);
      return cached.data;
    }

    // Fetch the page
    let resp;
    try {
      resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; claude-native/1.0)" },
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
    } catch (e) {
      return { content: `Fetch error: ${e.message}`, is_error: true };
    }

    // Handle redirects to different host
    if ([301, 302, 307, 308].includes(resp.status)) {
      const location = resp.headers.get("location");
      if (location) {
        try {
          const origHost = new URL(url).hostname;
          const redirHost = new URL(location, url).hostname;
          if (origHost !== redirHost) {
            return `REDIRECT DETECTED: The URL redirects to a different host.\n\nOriginal URL: ${url}\nRedirect URL: ${location}\nStatus: ${resp.status}\n\nTo complete your request, use WebFetch again with url: "${location}"`;
          }
          // Same host redirect — follow it
          resp = await fetch(new URL(location, url).href, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; claude-native/1.0)" },
            signal: AbortSignal.timeout(30000),
          });
        } catch {
          return `Redirect to: ${location}`;
        }
      }
    }

    if (!resp.ok) {
      return { content: `HTTP ${resp.status} ${resp.statusText}`, is_error: true };
    }

    const contentType = resp.headers.get("content-type") || "";
    let text = await resp.text();
    const bytes = Buffer.byteLength(text);

    // Convert HTML to readable text
    if (contentType.includes("text/html")) {
      text = htmlToText(text);
    }

    // Truncate if too large
    if (text.length > WEB_FETCH_MAX_CHARS) {
      text = text.substring(0, WEB_FETCH_MAX_CHARS) + "\n\n[Content truncated due to length...]";
    }

    // If it's already markdown and small enough, return directly
    if (contentType.includes("text/markdown") && text.length < WEB_FETCH_MAX_CHARS) {
      const result = `Content from ${url} (${bytes} bytes):\n\n${text}`;
      _webFetchCache.set(url, { data: result, timestamp: Date.now() });
      return result;
    }

    // Use the API to process the content with the prompt (summarization)
    // We make a separate small API call to extract what the user wants
    try {
      // Pick a small/fast model matching the current backend via provider capabilities
      const currentProvider = registry._provider || detectProvider(registry._currentModel || "");
      const summaryModel = currentProvider.capabilities?.summaryModel || "claude-haiku-4-5-20251001";
      const summaryBody = {
        model: summaryModel,
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: `Here is content fetched from ${url}:\n\n<content>\n${text}\n</content>\n\nBased on the above content, ${prompt}`,
        }],
      };

      let summaryText = "";
      for await (const { event, data } of registry._client.stream(summaryBody)) {
        if (event === "content_block_delta" && data.delta?.type === "text_delta") {
          summaryText += data.delta.text;
        }
      }

      const result = summaryText || `Content from ${url} (${bytes} bytes):\n\n${text.substring(0, 5000)}`;
      _webFetchCache.set(url, { data: result, timestamp: Date.now() });
      return result;
    } catch (e) {
      // Fallback: return raw content if summarization fails
      const result = `Content from ${url} (${bytes} bytes):\n\n${text.substring(0, 10000)}`;
      _webFetchCache.set(url, { data: result, timestamp: Date.now() });
      return result;
    }
  });

  // Glob
  registry.register("Glob", {
    description: `Fast file pattern matching tool that works with any codebase size. Returns matching file paths sorted by modification time.

Use this tool instead of find or ls via Bash.
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Use when you need to find files by name or extension
- Call multiple Glob searches in parallel when exploring broadly`,
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern (e.g. '**/*.js', 'src/**/*.ts')" },
        path: { type: "string", description: "Directory to search in (default: cwd)" },
      },
      required: ["pattern"],
    },
  }, async (input) => {
    let dir = input.path || registry._cwd || process.cwd();
    try { dir = fs.realpathSync(dir); } catch { /* keep original */ }
    const pattern = input.pattern;
    const regex = globToRegex(pattern);

    let entries;
    try {
      entries = await fs.promises.readdir(dir, { recursive: true, withFileTypes: true });
    } catch (e) {
      return { content: `Error reading directory: ${e.message}`, is_error: true };
    }

    const matches = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      // parentPath available in Node 20.12+; fallback to entry.path for older versions
      const parentDir = entry.parentPath || entry.path || "";
      const rel = parentDir
        ? path.relative(dir, path.join(parentDir, entry.name))
        : entry.name;
      if (regex.test(rel)) {
        const full = path.join(dir, rel);
        try {
          const stat = await fs.promises.stat(full);
          matches.push({ path: full, mtime: stat.mtimeMs });
        } catch { /* skip */ }
      }
    }

    matches.sort((a, b) => b.mtime - a.mtime);
    if (matches.length === 0) return "No files matched.";
    return matches.map((m) => m.path).join("\n");
  });

  // Grep
  registry.register("Grep", {
    description: `Search file contents using regex. Uses ripgrep (rg) if available, falls back to grep.

ALWAYS use this tool for content search. NEVER run grep or rg as a Bash command.
- Supports full regex syntax (e.g. "log.*Error", "function\\s+\\w+")
- Filter files with glob param (e.g. "*.js") or by directory with path param
- Output modes: "content" shows matching lines, "files_with_matches" shows only paths (default), "count" shows counts
- Use the Agent tool with subagent_type=Explore for open-ended searches requiring multiple rounds`,
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "File or directory to search (default: cwd)" },
        glob: { type: "string", description: "File glob filter (e.g. '*.js')" },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Output mode (default: files_with_matches)" },
        "-i": { type: "boolean", description: "Case insensitive search" },
        "-n": { type: "boolean", description: "Show line numbers" },
        "-C": { type: "number", description: "Context lines around each match" },
        "-A": { type: "number", description: "Lines after each match" },
        "-B": { type: "number", description: "Lines before each match" },
        head_limit: { type: "number", description: "Limit output to first N results" },
      },
      required: ["pattern"],
    },
  }, async (input) => {
    const dir = input.path || registry._cwd || process.cwd();
    const mode = input.output_mode || "files_with_matches";

    // Try rg first, fallback to grep
    const hasRg = await commandExists("rg");
    const cmd = hasRg ? "rg" : "grep";

    const args = [];
    if (hasRg) {
      if (mode === "files_with_matches") args.push("-l");
      else if (mode === "count") args.push("-c");
      else args.push("-n"); // content mode
      if (input["-i"]) args.push("-i");
      if (input["-C"]) args.push("-C", String(input["-C"]));
      if (input["-A"]) args.push("-A", String(input["-A"]));
      if (input["-B"]) args.push("-B", String(input["-B"]));
      if (input.glob) args.push("--glob", input.glob);
      args.push(input.pattern, dir);
    } else {
      args.push("-r");
      if (mode === "files_with_matches") args.push("-l");
      else if (mode === "count") args.push("-c");
      else args.push("-n");
      if (input["-i"]) args.push("-i");
      if (input["-C"]) args.push("-C", String(input["-C"]));
      if (input["-A"]) args.push("-A", String(input["-A"]));
      if (input["-B"]) args.push("-B", String(input["-B"]));
      args.push(input.pattern, dir);
    }

    return new Promise((resolve) => {
      const proc = spawn(cmd, args, { timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      proc.stdout.on("data", (d) => { out += d; });
      proc.stderr.on("data", () => {});
      proc.on("close", () => {
        let result = out.trim();
        if (input.head_limit && result) {
          const lines = result.split("\n");
          result = lines.slice(0, input.head_limit).join("\n");
        }
        resolve(result || "No matches found.");
      });
      proc.on("error", () => resolve("No matches found."));
      proc.stdin.end();
    });
  });
}

function globToRegex(pattern) {
  let re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\{\{GLOBSTAR\}\}/g, ".*");
  return new RegExp(`^${re}$`);
}

function htmlToText(html) {
  return html
    // Remove scripts and styles
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // Convert common block elements to newlines
    .replace(/<\/?(div|p|br|hr|h[1-6]|li|tr|section|article|header|footer|nav|blockquote|pre|table)[^>]*>/gi, "\n")
    // Convert links to markdown
    .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    // Remove all remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    // Clean up whitespace
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function commandExists(cmd) {
  return new Promise((resolve) => {
    const proc = spawn("which", [cmd], { stdio: ["pipe", "pipe", "pipe"] });
    proc.on("close", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

// ── McpManager ──────────────────────────────────────────────────
// ── AskUserQuestion Tool ─────────────────────────────────────

function registerAskUserQuestion(registry) {
  registry.register("AskUserQuestion", {
    description: "Ask the user a question and wait for their answer. Use when you need clarification, a decision between options, or confirmation before proceeding. The user will see the question and options in an interactive prompt.",
    input_schema: {
      type: "object",
      properties: {
        question: { type: "string", description: "The question to ask the user" },
        options: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Short label for this option (1-5 words)" },
              description: { type: "string", description: "Explanation of what this option means" },
            },
            required: ["label"],
          },
          description: "2-6 options for the user to choose from. An 'Other' option is always added automatically.",
        },
      },
      required: ["question"],
    },
  }, async (input) => {
    // This executor is replaced at runtime by InteractiveMode / NdjsonBridge
    // with a proper stdin prompt. Default: return a message asking to re-run interactively.
    return { content: "AskUserQuestion requires interactive mode.", is_error: true };
  });
}

// ── Memory Tools ──────────────────────────────────────────────

const MEMORY_INDEX_FILE = "MEMORY.md";
const MEMORY_TYPES = ["user", "feedback", "project", "reference"];
const MEMORY_SCOPES = ["user", "project", "all"];

function _memoryDirForScope(scope, cwd) {
  if (scope === "user") return ensureUserMemoryDir();
  return ensureMemoryDir(cwd);
}

function _getScopedMemoryRoots(cwd, scope = "all") {
  const roots = [];
  if (scope === "user" || scope === "all") roots.push({ scope: "user", dir: getUserMemoryDir() });
  if (scope === "project" || scope === "all") roots.push({ scope: "project", dir: getMemoryDir(cwd) });
  return roots;
}

function _toolsRealpathOrResolve(targetPath) {
  const resolved = path.resolve(String(targetPath || ""));
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function _toolsPathWithinRoot(filePath, rootPath) {
  const rel = path.relative(rootPath, filePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function _resolveScopedMemoryFile(cwd, scope, filePath) {
  const resolved = path.resolve(String(filePath || ""));
  if (!fs.existsSync(resolved)) return { error: "Memory not found." };

  const realFile = _toolsRealpathOrResolve(resolved);
  if (path.extname(realFile).toLowerCase() !== ".md" || path.basename(realFile) === MEMORY_INDEX_FILE) {
    return { error: "Memory file path must point to a markdown memory entry." };
  }

  for (const root of _getScopedMemoryRoots(cwd, scope || "all")) {
    const realRoot = _toolsRealpathOrResolve(root.dir);
    if (_toolsPathWithinRoot(realFile, realRoot)) {
      return { file: realFile, scope: root.scope };
    }
  }

  return { error: "Memory file path must be inside user or project memory directories." };
}

function _stripMemoryFrontmatter(raw) {
  return String(raw || "").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

function _parseMemoryFrontmatter(raw) {
  const text = String(raw || "");
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta = {};
  if (!match) return meta;
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    meta[key] = value;
  }
  return meta;
}

function _listMemoryEntries(cwd, scope = "all") {
  const scopes = scope === "all" ? ["user", "project"] : [scope];
  const entries = [];
  for (const s of scopes) {
    const dir = _memoryDirForScope(s, cwd);
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === MEMORY_INDEX_FILE) continue;
        const filePath = path.join(dir, entry.name);
        const raw = fs.readFileSync(filePath, "utf-8");
        const meta = _parseMemoryFrontmatter(raw);
        entries.push({
          scope: meta.scope || s,
          type: meta.type || "reference",
          name: meta.name || entry.name.replace(/\.md$/, ""),
          description: meta.description || "",
          file: filePath,
          saved_at: meta.saved_at || null,
        });
      }
    } catch { /* ignore missing scope dir */ }
  }
  entries.sort((a, b) => (a.scope + ":" + a.name).localeCompare(b.scope + ":" + b.name));
  return entries;
}

function _rebuildMemoryIndex(dir) {
  const lines = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === MEMORY_INDEX_FILE) continue;
      const raw = fs.readFileSync(path.join(dir, entry.name), "utf-8");
      const meta = _parseMemoryFrontmatter(raw);
      lines.push(`- [${entry.name}](${entry.name}) — ${meta.description || meta.name || entry.name}`);
    }
  } catch { /* ignore */ }
  lines.sort((a, b) => a.localeCompare(b));
  fs.writeFileSync(path.join(dir, MEMORY_INDEX_FILE), lines.join("\n") + (lines.length ? "\n" : ""));
}

function _findMemoryEntry(cwd, scope, { name, file_path }) {
  if (file_path) return _resolveScopedMemoryFile(cwd, scope || "all", file_path);
  const entries = _listMemoryEntries(cwd, scope || "all");
  const wanted = String(name || "").trim().toLowerCase();
  if (!wanted) return null;
  return entries.find((e) => e.name.toLowerCase() === wanted || path.basename(e.file).toLowerCase() === wanted || path.basename(e.file, ".md").toLowerCase() === wanted) || null;
}

function _saveMemoryEntry(cwd, scope, type, name, description, content) {
  const dir = _memoryDirForScope(scope, cwd);
  const slug = name.toLowerCase().replace(/[^a-z0-9\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 50).replace(/-$/, "") || "memory";
  const filename = `${type}_${slug}.md`;
  const filePath = path.join(dir, filename);
  const raw = `---
name: ${name}
description: ${description}
scope: ${scope}
type: ${type}
saved_at: ${new Date().toISOString()}
---

${content.trim()}
`;
  fs.writeFileSync(filePath, raw);
  _rebuildMemoryIndex(dir);
  return filePath;
}

function _forgetMemoryEntry(cwd, scope, name, file_path) {
  const found = _findMemoryEntry(cwd, scope, { name, file_path });
  if (found?.error) return found;
  if (!found) return null;
  fs.rmSync(found.file, { force: true });
  _rebuildMemoryIndex(_memoryDirForScope(found.scope, cwd));
  return found;
}

function registerMemoryTools(registry) {
  registry.register("MemoryList", {
    description: "List stored memories. Use scope=user for cross-project preferences and feedback, scope=project for this project, or scope=all for both.",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: MEMORY_SCOPES, description: "Memory scope: user, project, or all (default)." },
        type: { type: "string", enum: MEMORY_TYPES, description: "Optional memory type filter." },
        query: { type: "string", description: "Optional substring match on name/description/content filename." },
      },
    },
  }, async (input) => {
    const cwd = registry._cwd || process.cwd();
    let entries = _listMemoryEntries(cwd, input.scope || "all");
    if (input.type) entries = entries.filter((e) => e.type === input.type);
    if (input.query) {
      const q = String(input.query).toLowerCase();
      entries = entries.filter((e) => `${e.name} ${e.description} ${e.file}`.toLowerCase().includes(q));
    }
    return { content: JSON.stringify({ count: entries.length, entries }, null, 2), is_error: false };
  });

  registry.register("MemoryRead", {
    description: "Read a stored memory entry by name or file path.",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: MEMORY_SCOPES, description: "Optional memory scope to search." },
        name: { type: "string", description: "Memory name or filename stem." },
        file_path: { type: "string", description: "Direct path to a memory file inside the memory directories." },
      },
    },
  }, async (input) => {
    const cwd = registry._cwd || process.cwd();
    const found = _findMemoryEntry(cwd, input.scope || "all", input);
    if (found?.error) return { content: found.error, is_error: true };
    if (!found) return { content: "Memory not found.", is_error: true };
    const raw = fs.readFileSync(found.file, "utf-8");
    const meta = _parseMemoryFrontmatter(raw);
    const memName = meta.name || path.basename(found.file, ".md");
    // Emit memory_referenced metric
    try {
      appendMemoryMetric(cwd, found.scope || "project", {
        type: "memory_referenced",
        file: path.basename(found.file),
        name: memName,
      });
    } catch { /* non-fatal */ }
    return {
      content: JSON.stringify({
        scope: meta.scope || found.scope,
        type: meta.type || "reference",
        name: memName,
        description: meta.description || "",
        file: found.file,
        content: _stripMemoryFrontmatter(raw),
      }, null, 2),
      is_error: false,
    };
  });

  registry.register("MemorySave", {
    description: "Persist a memory entry. Use scope=user for stable preferences/feedback and scope=project for project-specific context.",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["user", "project"], description: "Memory scope." },
        type: { type: "string", enum: MEMORY_TYPES, description: "Memory type." },
        name: { type: "string", description: "Short memory title." },
        description: { type: "string", description: "One-line description for the memory index." },
        content: { type: "string", description: "Full memory content." },
      },
      required: ["scope", "type", "name", "description", "content"],
    },
  }, async (input) => {
    const cwd = registry._cwd || process.cwd();
    const file = _saveMemoryEntry(cwd, input.scope, input.type, input.name, input.description, input.content);
    return { content: JSON.stringify({ saved: true, scope: input.scope, type: input.type, name: input.name, file }, null, 2), is_error: false };
  });

  registry.register("MemoryForget", {
    description: "Delete a memory entry by name or file path.",
    input_schema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: MEMORY_SCOPES, description: "Optional memory scope to search." },
        name: { type: "string", description: "Memory name or filename stem." },
        file_path: { type: "string", description: "Direct path to a memory file inside the memory directories." },
      },
    },
  }, async (input) => {
    const cwd = registry._cwd || process.cwd();
    const forgotten = _forgetMemoryEntry(cwd, input.scope || "all", input.name, input.file_path);
    if (forgotten?.error) return { content: forgotten.error, is_error: true };
    if (!forgotten) return { content: "Memory not found.", is_error: true };
    return { content: JSON.stringify({ forgotten: true, scope: forgotten.scope, file: forgotten.file }, null, 2), is_error: false };
  });

  // ── MemoryShare — capture exchanges as shareable moments ────
  registry.register("MemoryShare", {
    description: `Capture the current conversation exchange as a shareable moment.

Use this when the conversation contains something noteworthy:
- A clever bug fix or debugging session
- An impressive multi-file refactor
- A complex task completed in one shot
- A useful explanation or learning moment

The moment is saved locally with markdown, HTML, JSON, and SVG exports.`,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the moment (e.g., 'Fixed race condition in connection pool')" },
        description: { type: "string", description: "One-line description" },
        tags: { type: "array", items: { type: "string" }, description: "Tags (e.g., ['debugging', 'concurrency'])" },
        format: { type: "string", enum: ["markdown", "html", "json", "svg", "all"], description: "Export format (default: all)" },
        exchange_index: { type: "number", description: "Which exchange to capture (1=last, 2=second-to-last). Default: 1" },
      },
      required: ["title"],
    },
  }, async (input) => {
    try {
      const cwd = registry._cwd || process.cwd();
      const messages = registry._currentMessages || [];
      const exchange = extractExchange(messages, input.exchange_index || 1);
      if (!exchange) return { content: "No exchange found to share.", is_error: true };

      const moment = buildMoment(exchange, {
        sessionId: registry._sessionId || null,
        cwd,
        model: registry._currentModel || "unknown",
        provider: registry._provider?.name || "unknown",
        title: input.title,
        description: input.description || null,
        tags: input.tags || [],
      });
      sanitize(moment, cwd);

      const formats = (input.format === "all" || !input.format)
        ? ["markdown", "html", "json", "svg"]
        : [input.format === "md" ? "markdown" : input.format];
      const exports = saveMoment(cwd, moment, formats);

      const md = renderMarkdown(moment);
      return {
        content: `Moment saved: "${moment.title}"\n\nExports:\n${Object.entries(exports).map(([f, p]) => `- ${f}: ${p}`).join("\n")}\n\n---\n\n${md}`,
        is_error: false,
      };
    } catch (e) {
      return { content: `Failed to save moment: ${e.message}`, is_error: true };
    }
  });
}

// ── Brief Mode Tools ─────────────────────────────────────────

function _resolveOutputAttachments(attachments) {
  const resolved = [];
  for (const filePath of attachments || []) {
    try {
      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].includes(ext);
      resolved.push({ path: filePath, size: stat.size, isImage });
    } catch {
      return { error: `Attachment not found: ${filePath}` };
    }
  }
  return { attachments: resolved };
}

function registerBriefTools(registry, cfg) {
  const resolveAttachments = typeof _resolveOutputAttachments === "function"
    ? _resolveOutputAttachments
    : (attachments) => {
      const resolved = [];
      for (const filePath of attachments || []) {
        try {
          const stat = fs.statSync(filePath);
          const ext = path.extname(filePath).toLowerCase();
          const isImage = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].includes(ext);
          resolved.push({ path: filePath, size: stat.size, isImage });
        } catch {
          return { error: `Attachment not found: ${filePath}` };
        }
      }
      return { attachments: resolved };
    };

  registry.register("SendUserMessage", {
    description: "Send a message the user will read. Text outside this tool is visible in the detail view, but most won't open it — the answer lives here.",
    input_schema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Message for the user. Supports markdown." },
        attachments: {
          type: "array", items: { type: "string" },
          description: "Optional file paths to attach (images, diffs, logs).",
        },
        status: {
          type: "string", enum: ["normal", "proactive"],
          description: "'normal' when replying to what they asked. 'proactive' when initiating (task finished, blocker hit, unsolicited update).",
        },
      },
      required: ["message"],
    },
  }, async (input) => {
    // Guard: some models send message as object instead of string
    const message = typeof input.message === "string" ? input.message : (input.message?.text || JSON.stringify(input.message));
    const status = input.status || "normal";
    const attachmentResult = resolveAttachments(input.attachments);
    if (attachmentResult.error) return { content: attachmentResult.error, is_error: true };

    const result = { kind: "user_message", message, attachments: attachmentResult.attachments, status, sentAt: new Date().toISOString() };
    return { content: JSON.stringify(result), is_error: false };
  });

  registry.register("TaskOutput", {
    description: "Send a structured task update the user will read. Use for background launches, progress checkpoints, remote launches, completions, failures, or blockers. This is the user-facing surface for async/proactive task status.",
    input_schema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task or agent identifier, if available." },
        status: {
          type: "string",
          enum: ["queued", "running", "async_launched", "remote_launched", "completed", "failed", "blocked", "cancelled"],
          description: "Current task lifecycle state.",
        },
        message: { type: "string", description: "User-visible task update. Supports markdown." },
        summary: { type: "string", description: "Optional compact summary or outcome." },
        prompt: { type: "string", description: "Optional original prompt or task description." },
        output_file: { type: "string", description: "Optional output file path for async work." },
        session_url: { type: "string", description: "Optional remote session URL." },
        attachments: {
          type: "array", items: { type: "string" },
          description: "Optional file paths to attach (images, logs, diffs).",
        },
        metadata: {
          type: "object",
          description: "Optional structured metadata for downstream renderers.",
        },
      },
      required: ["status", "message"],
    },
  }, async (input) => {
    const attachmentResult = resolveAttachments(input.attachments);
    if (attachmentResult.error) return { content: attachmentResult.error, is_error: true };
    const result = {
      kind: "task_output",
      task_id: input.task_id || null,
      status: input.status,
      message: input.message,
      summary: input.summary || null,
      prompt: input.prompt || null,
      output_file: input.output_file || null,
      session_url: input.session_url || null,
      attachments: attachmentResult.attachments,
      metadata: input.metadata || null,
      sentAt: new Date().toISOString(),
    };
    return { content: JSON.stringify(result), is_error: false };
  });
}

// ── ToolSearch (deferred tool loader) ────────────────────────

function registerToolSearch(registry) {
  // Only register if there are deferred tools to search
  const deferredNames = registry.getDeferredNames();
  if (deferredNames.length === 0) {
    registry.unregister("ToolSearch"); // Clean up if previously registered
    return;
  }

  registry.register("ToolSearch", {
    description: "Fetches full schema definitions for deferred tools so they can be called.\n\nDeferred tools appear by name in <system-reminder> messages. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked. This tool takes a query, matches it against the deferred tool list, and returns the matched tools' complete JSONSchema definitions inside a <functions> block. Once a tool's schema appears in that result, it is callable exactly like any tool defined at the top of the prompt.\n\nQuery forms:\n- \"select:Read,Edit,Grep\" — fetch these exact tools by name\n- \"notebook jupyter\" — keyword search, up to max_results best matches\n- \"+slack send\" — require \"slack\" in the name, rank by remaining terms",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Query to find deferred tools. Use \"select:<tool_name>\" for direct selection, or keywords to search.",
        },
        max_results: {
          type: "number",
          default: 5,
          description: "Maximum number of results to return (default: 5)",
        },
      },
      required: ["query"],
    },
  }, async (input) => {
    const results = registry.searchDeferred(input.query);
    const limited = results.slice(0, input.max_results || 5);

    if (limited.length === 0) {
      return { content: "No matching deferred tools found.", is_error: false };
    }

    // Promote fetched tools to eager so they appear in the API tools array next turn
    for (const tool of limited) {
      registry.promote(tool.name);
    }

    // Format as <functions> block matching the original Claude Code format
    const lines = limited.map((tool) => {
      return `<function>${JSON.stringify({ description: tool.description, name: tool.name, parameters: tool.input_schema })}</function>`;
    });

    return {
      content: `<functions>\n${lines.join("\n")}\n</functions>`,
      is_error: false,
    };
  });
}

// ── Deferred Built-in Tools (Task, Plan) ─────────────────────

function registerDeferredBuiltinTools(registry, cfg) {
  // ── Task Management Tools ──────────────────────────────────
  const board = cfg._taskBoard || (cfg._taskBoard = new TaskBoard(cfg.sessionId || "session"));
  cfg._completedWithoutVerification = cfg._completedWithoutVerification || 0;

  registry.register("TaskCreate", {
    description: "Create a task to track a unit of work. Use when breaking work into discrete steps or tracking progress through a multi-step plan.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the task" },
        description: { type: "string", description: "Detailed description of what needs to be done" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"], default: "pending" },
        priority: { type: "string", enum: ["low", "medium", "high"], default: "medium" },
      },
      required: ["title"],
    },
  }, async (input) => {
    const task = board.addTask(input.title, {
      description: input.description || "",
      priority: input.priority || "medium",
    });
    if (input.status && input.status !== "pending") board.updateTask(task.id, { status: input.status });
    return { content: JSON.stringify(board.getTask(task.id)), is_error: false };
  }, { deferred: true });

  registry.register("TaskUpdate", {
    description: "Update a task's status or details. Use to mark tasks as in_progress, completed, or blocked.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID (e.g. task_1 or task-1)" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"] },
        title: { type: "string" },
        description: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["id"],
    },
  }, async (input) => {
    const taskId = String(input.id || "").replace(/^task_(\d+)$/, "task-$1");
    const existing = board.getTask(taskId);
    if (!existing) return { content: `Task not found: ${input.id}`, is_error: true };
    const prevStatus = existing.status;
    const task = board.updateTask(taskId, {
      status: input.status,
      title: input.title,
      description: input.description,
      priority: input.priority,
    });

    // Track completions for verification auto-trigger
    let nudge = "";
    if (input.status === "completed" && prevStatus !== "completed") {
      cfg._completedWithoutVerification++;
      if (cfg._completedWithoutVerification >= 3) {
        nudge = `\n\n<system-reminder>NOTE: You just closed out ${cfg._completedWithoutVerification}+ tasks and none of them was a verification step. Before writing your final summary, spawn the verification agent (subagent_type="verification"). You cannot self-assign PARTIAL by listing caveats in your summary — only the verifier issues a verdict.</system-reminder>`;
      }
    }

    return { content: JSON.stringify(task) + nudge, is_error: false };
  }, { deferred: true });

  registry.register("TaskGet", {
    description: "Get details of a specific task by ID.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Task ID (e.g. task_1 or task-1)" },
      },
      required: ["id"],
    },
  }, async (input) => {
    const taskId = String(input.id || "").replace(/^task_(\d+)$/, "task-$1");
    const task = board.getTask(taskId);
    if (!task) return { content: `Task not found: ${input.id}`, is_error: true };
    return { content: JSON.stringify(task), is_error: false };
  }, { deferred: true });

  registry.register("TaskList", {
    description: "List all tasks, optionally filtered by status.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "in_progress", "completed", "blocked"], description: "Filter by status" },
      },
    },
  }, async (input) => {
    const tasks = board.listTasks({ status: input.status });
    return { content: JSON.stringify(tasks), is_error: false };
  }, { deferred: true });

  // ── Plan Mode Tools ────────────────────────────────────────

  registry.register("EnterPlanMode", {
    description: "Enter plan mode to design an implementation strategy before writing code. In plan mode, you can only use read-only tools (Read, Glob, Grep, WebFetch, WebSearch) and must produce a plan. Use when the task is complex and benefits from upfront design.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why you're entering plan mode" },
      },
      required: ["reason"],
    },
  }, async (input) => {
    cfg._planMode = true;
    return { content: `Entered plan mode: ${input.reason}\n\nYou are now in plan mode. Use read-only tools to research, then produce a plan. Call ExitPlanMode when done.`, is_error: false };
  }, { deferred: true });

  registry.register("ExitPlanMode", {
    description: "Exit plan mode and return to normal execution. Call this after you've finished designing your plan.",
    input_schema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "The implementation plan (markdown)" },
      },
      required: ["plan"],
    },
  }, async (input) => {
    cfg._planMode = false;
    const planFile = path.join(os.tmpdir(), `claude-plan-${Date.now()}.md`);
    fs.writeFileSync(planFile, input.plan);
    return { content: `Exited plan mode. Plan saved to ${planFile}\n\nYou can now implement the plan.`, is_error: false };
  }, { deferred: true });

  // ── WebSearch ──────────────────────────────────────────────
  registry.register("WebSearch", {
    description: "Search the web for information. Returns search result snippets.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "number", description: "Max results to return (default 5)" },
      },
      required: ["query"],
    },
  }, async (input) => {
    const maxResults = input.max_results || 5;
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "cloclo/1.0" },
        redirect: "follow",
      });
      if (!resp.ok) return { content: `Search failed: HTTP ${resp.status}`, is_error: true };
      const html = await resp.text();

      // Parse result snippets from DuckDuckGo HTML
      const results = [];
      const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let match;
      while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
        const link = match[1];
        const title = match[2].replace(/<[^>]+>/g, "").trim();
        const snippet = match[3].replace(/<[^>]+>/g, "").trim();
        if (title || snippet) {
          results.push(`${results.length + 1}. ${title}\n   ${link}\n   ${snippet}`);
        }
      }

      if (results.length === 0) {
        // Fallback: try simpler regex for result links
        const simpleRegex = /<a[^>]+class="result__url"[^>]*>([\s\S]*?)<\/a>/g;
        while ((match = simpleRegex.exec(html)) !== null && results.length < maxResults) {
          const text = match[1].replace(/<[^>]+>/g, "").trim();
          if (text) results.push(`${results.length + 1}. ${text}`);
        }
      }

      return { content: results.length > 0 ? results.join("\n\n") : "No results found.", is_error: false };
    } catch (e) {
      return { content: `Search error: ${e.message}`, is_error: true };
    }
  }, { deferred: true });

  // ── PhoneCall ─────────────────────────────────────────────
  registry.register("PhoneCall", {
    description: "Make a phone call to deliver a message. Uses Twilio to call a phone number and speak a message via TTS. Can optionally record the recipient's response and transcribe it. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER. Language and voice are auto-detected from the message content.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Phone number to call (E.164 format preferred, e.g. +33612345678)" },
        message: { type: "string", description: "Message to speak to the recipient" },
        language: { type: "string", description: "Language code (auto-detected if omitted, e.g. fr-FR, en-US, es-ES)" },
        voice: { type: "string", description: "Twilio voice name (auto-selected if omitted, e.g. Polly.Lea for French)" },
        record: { type: "boolean", description: "Record the recipient's response after the message (default false)" },
      },
      required: ["to", "message"],
    },
  }, async (input) => {
    try {
      const phone = new PhoneManager(cfg);
      const result = await phone.call({
        to: input.to,
        message: input.message,
        language: input.language || undefined,
        voice: input.voice || undefined,
        record: input.record || false,
      });

      const lines = [
        `Call ${result.status}: ${result.to}`,
        `Duration: ${result.duration}s`,
      ];
      if (result.answeredBy) lines.push(`Answered by: ${result.answeredBy}`);
      if (result.recordings && result.recordings.length > 0) {
        for (const rec of result.recordings) {
          lines.push(`Recording (${rec.duration}s): ${rec.status}`);
          if (rec.transcription) lines.push(`Transcription: ${rec.transcription}`);
        }
      }
      return { content: lines.join("\n"), is_error: false };
    } catch (e) {
      return { content: `Phone call failed: ${e.message}`, is_error: true };
    }
  }, { deferred: true });

  // ── SendSMS ───────────────────────────────────────────────
  registry.register("SendSMS", {
    description: "Send an SMS text message via Twilio. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Phone number to text (E.164 format, e.g. +33612345678)" },
        message: { type: "string", description: "SMS message body (max 1600 chars)" },
      },
      required: ["to", "message"],
    },
  }, async (input) => {
    try {
      const phone = new PhoneManager(cfg);
      const result = await phone.sendSms({ to: input.to, message: input.message });
      return { content: `SMS sent to ${result.to} (status: ${result.status}, sid: ${result.messageSid})`, is_error: false };
    } catch (e) {
      return { content: `SMS failed: ${e.message}`, is_error: true };
    }
  }, { deferred: true });

  // ── Screenshot ────────────────────────────────────────────
  registry.register("Screenshot", {
    description: "Capture a screenshot of the desktop screen or a specific window. Returns the image as a base64-encoded PNG that can be analyzed visually. macOS only (uses screencapture).",
    input_schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fullscreen", "window", "region"], description: "Capture mode: fullscreen (default), window (frontmost window), or region (interactive selection)" },
        display: { type: "number", description: "Display number for multi-monitor (default: main display)" },
      },
    },
  }, async (input) => {
    const { execSync } = await import("node:child_process");
    const tmpPng = path.join(os.tmpdir(), `cloclo-ss-${Date.now()}.png`);
    const tmpJpg = path.join(os.tmpdir(), `cloclo-ss-${Date.now()}.jpg`);

    try {
      const mode = input.mode || "fullscreen";
      const args = ["-x"]; // no sound

      if (mode === "window") {
        args.push("-l");
        try {
          const winId = execSync(`osascript -e 'tell application "System Events" to set fw to first window of (first process whose frontmost is true)' -e 'tell application "System Events" to return id of fw'`, { encoding: "utf-8", timeout: 5000 }).trim();
          args.push(winId);
        } catch {
          args.length = 0;
          args.push("-x", "-w");
        }
      } else if (mode === "region") {
        args.push("-i");
      }

      if (input.display) {
        args.push("-D", String(input.display));
      }

      args.push(tmpPng);
      execSync(`screencapture ${args.join(" ")}`, { timeout: 15000 });

      if (!fs.existsSync(tmpPng)) {
        return { content: "Screenshot cancelled or failed (no file created).", is_error: true };
      }

      // Resize to max 1280px wide + convert to JPEG for smaller size (uses sips, built-in macOS)
      try {
        execSync(`sips --resampleWidth 800 --setProperty format jpeg --setProperty formatOptions 40 "${tmpPng}" --out "${tmpJpg}"`, { timeout: 10000, stdio: "ignore" });
      } catch {
        // Fallback: use PNG as-is if sips fails
        fs.copyFileSync(tmpPng, tmpJpg);
      }

      const imgFile = fs.existsSync(tmpJpg) ? tmpJpg : tmpPng;
      const mediaType = imgFile === tmpJpg ? "image/jpeg" : "image/png";
      const imgData = fs.readFileSync(imgFile);
      const base64 = imgData.toString("base64");

      // Clean up
      try { fs.unlinkSync(tmpPng); } catch { /* already cleaned */ }
      try { fs.unlinkSync(tmpJpg); } catch { /* already cleaned */ }

      return {
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: `Screenshot captured (${mode}, ${(imgData.length / 1024).toFixed(0)}KB, 1280px wide JPEG)` },
        ],
        is_error: false,
      };
    } catch (e) {
      try { fs.unlinkSync(tmpPng); } catch { /* already cleaned */ }
      try { fs.unlinkSync(tmpJpg); } catch { /* already cleaned */ }
      return { content: `Screenshot failed: ${e.message}`, is_error: true };
    }
  }, { deferred: true });

}

// ── MCP Resource Tools ──────────────────────────────────────

function registerMcpResourceTools(registry) {
  registry.register("ListMcpResources", {
    description: "List available resources from MCP servers. Returns resource URIs, names, and descriptions.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string", description: "Filter by MCP server name (optional)" },
      },
    },
  }, async (input) => {
    const mcpManager = registry._mcpManager;
    if (!mcpManager) return { content: "No MCP servers configured.", is_error: false };

    const resources = [];
    for (const [name, server] of mcpManager._servers) {
      if (input.server && name !== input.server) continue;
      try {
        const result = await mcpManager._rpc(server, "resources/list", {});
        const serverResources = result?.resources || [];
        for (const r of serverResources) {
          resources.push({ uri: r.uri, name: r.name || r.uri, mimeType: r.mimeType || "", description: r.description || "", server: name });
        }
      } catch (e) {
        log(`MCP[${name}] resources/list failed: ${e.message}`);
      }
    }

    if (resources.length === 0) return { content: "No MCP resources available.", is_error: false };
    return { content: JSON.stringify(resources, null, 2), is_error: false };
  }, { deferred: true });

  registry.register("ReadMcpResource", {
    description: "Read a specific MCP resource by URI. Returns the resource content.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string", description: "MCP server name" },
        uri: { type: "string", description: "Resource URI to read" },
      },
      required: ["server", "uri"],
    },
  }, async (input) => {
    const mcpManager = registry._mcpManager;
    if (!mcpManager) return { content: "No MCP servers configured.", is_error: true };

    const server = mcpManager._servers.get(input.server);
    if (!server) return { content: `MCP server not found: ${input.server}`, is_error: true };

    try {
      const result = await mcpManager._rpc(server, "resources/read", { uri: input.uri });
      const contents = result?.contents || [];
      if (contents.length === 0) return { content: `Resource empty: ${input.uri}`, is_error: false };

      const parts = [];
      for (const c of contents) {
        if (c.text) {
          parts.push(c.text);
        } else if (c.blob) {
          const tmpFile = path.join(os.tmpdir(), `mcp-resource-${Date.now()}-${path.basename(input.uri)}`);
          fs.writeFileSync(tmpFile, Buffer.from(c.blob, "base64"));
          parts.push(`[Binary content saved to ${tmpFile}]`);
        } else {
          parts.push(JSON.stringify(c));
        }
      }
      return { content: parts.join("\n"), is_error: false };
    } catch (e) {
      return { content: `Error reading resource: ${e.message}`, is_error: true };
    }
  }, { deferred: true });
}

// ── Phone Tools (Twilio) ─────────────────────────────────────────

function registerPhoneTools(registry, cfg) {
  const _phone = () => new PhoneManager(cfg);

  registry.register("PhoneCall", {
    description: "Make a phone call via Twilio. Two modes:\n\n**Live AI mode** (provide `instructions`): An AI sub-agent handles a full voice conversation on the phone. The sub-agent follows your instructions autonomously — it listens (Twilio STT), thinks (any LLM), and speaks (Twilio TTS). Supports tool calling. Works with any provider (Anthropic, OpenAI, Gemini, Mistral, Qwen, Ollama...). Returns the full transcript when the call ends.\n\n**Simple TTS mode** (provide `message`): Speaks a pre-written message, optionally records and transcribes the response.\n\nRequires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER in .env.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Phone number to call (E.164 format, e.g. +14155551234)" },
        message: { type: "string", description: "Simple TTS mode: message to speak to the recipient" },
        instructions: { type: "string", description: "Live AI mode: context and instructions for the AI sub-agent. Describe who it's calling, why, what to say/ask, and any constraints. The AI will handle the full conversation autonomously." },
        voice: { type: "string", description: "TTS voice. Simple mode: Polly.Joanna etc. Live mode: alloy, echo, shimmer, etc." },
        language: { type: "string", description: "Language code (e.g. en-US, fr-FR). Auto-detected if omitted." },
        model: { type: "string", description: "LLM model for the phone sub-agent (default: inherits from parent). Any provider works: claude-sonnet-4-5-20250514, gpt-4o, gemini-2.0-flash, etc." },
        record: { type: "boolean", description: "Simple mode only: record the recipient's response (default: false)" },
        maxDuration: { type: "number", description: "Live mode: max call duration in seconds (default: 300)" },
      },
      required: ["to"],
    },
  }, async (input) => {
    if (!input.message && !input.instructions) {
      return { content: "Either `message` (simple TTS) or `instructions` (live AI) is required.", is_error: true };
    }
    try {
      const pm = _phone();

      // Live AI mode — spin up full agent sub-agent
      if (input.instructions) {
        const result = await pm.liveCall({
          to: input.to,
          instructions: input.instructions,
          voice: input.voice || "Polly.Joanna",
          language: input.language,
          model: input.model,
          maxDuration: input.maxDuration || 300,
          registry, // pass full tool registry — agent has access to everything
        });
        return { content: JSON.stringify(result, null, 2), is_error: false };
      }

      // Simple TTS mode
      const result = await pm.call({
        to: input.to,
        message: input.message,
        voice: input.voice,
        language: input.language,
        record: input.record || false,
        machineDetection: true,
      });
      return { content: JSON.stringify(result, null, 2), is_error: false };
    } catch (e) {
      return { content: `Phone call failed: ${e.message}`, is_error: true };
    }
  }, { deferred: true });

  registry.register("SendSMS", {
    description: "Send an SMS text message via Twilio. Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Phone number (E.164 format, e.g. +14155551234)" },
        message: { type: "string", description: "SMS message text" },
      },
      required: ["to", "message"],
    },
  }, async (input) => {
    try {
      const pm = _phone();
      const result = await pm.sendSms({ to: input.to, message: input.message });
      return { content: JSON.stringify(result, null, 2), is_error: false };
    } catch (e) {
      return { content: `SMS failed: ${e.message}`, is_error: true };
    }
  }, { deferred: true });

  registry.register("PhoneStatus", {
    description: "Check the status of a previous phone call by its Call SID.",
    input_schema: {
      type: "object",
      properties: {
        callSid: { type: "string", description: "The Twilio Call SID (e.g. CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx)" },
      },
      required: ["callSid"],
    },
  }, async (input) => {
    try {
      const pm = _phone();
      const result = await pm.getCallStatus(input.callSid);
      return { content: JSON.stringify(result, null, 2), is_error: false };
    } catch (e) {
      return { content: `Status check failed: ${e.message}`, is_error: true };
    }
  }, { deferred: true });
}

// ── Exports ──────────────────────────────────────────────────────

export {
  ToolRegistry,
  TOOL_MANIFEST_PATH,
  _loadToolManifest,
  _saveToolManifest,
  _classifyToolType,
  PROTECTED_TOOLS,
  toolList,
  toolInfo,
  toolEnable,
  toolDisable,
  toolTest,
  toolInstall,
  toolUpdate,
  toolRemove,
  toolCatalog,
  toolPublish,
  _OFFICIAL_CATALOG,
  scanCustomTools,
  _registerCustomTool,
  registerBuiltinTools,
  registerMemoryTools,
  registerSpreadsheetTools,
  registerPdfTools,
  registerDocumentTools,
  registerPresentationTools,
  registerDesktopTools,
  registerAskUserQuestion,
  registerBriefTools,
  registerToolSearch,
  registerDeferredBuiltinTools,
  registerMcpResourceTools,
  registerPhoneTools,
  globToRegex,
  htmlToText,
  commandExists,
};
