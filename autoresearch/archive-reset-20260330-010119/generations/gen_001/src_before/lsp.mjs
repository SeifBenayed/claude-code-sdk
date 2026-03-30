// src/lsp.mjs — Language Server Protocol client for TypeScript + Python
//
// Manages language server processes, sends/receives JSON-RPC messages,
// and provides diagnostics to enrich tool results.
//
// Architecture:
//   LspManager → spawns LspClient per language
//   LspClient  → JSON-RPC over stdio to a language server process
//
// Integration points:
//   1. PostToolUse on Write/Edit → auto-diagnose modified files
//   2. Deferred LspDiagnostics tool → on-demand diagnostics
//   3. System prompt → workspace-level diagnostic summary

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log, sleep } from "./utils.mjs";

// ── Language Server Configs ──────────────────────────────────

const LANG_CONFIGS = {
  typescript: {
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    command: "npx",
    args: ["--yes", "typescript-language-server", "--stdio"],
    initOptions: {
      preferences: { includeCompletionsForModuleExports: true },
    },
    rootPatterns: ["tsconfig.json", "jsconfig.json", "package.json"],
  },
  python: {
    extensions: [".py", ".pyi"],
    command: "npx",
    args: ["--yes", "pyright-langserver", "--stdio"],
    initOptions: {},
    rootPatterns: ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
  },
};

// Severity mapping (LSP spec)
const SEVERITY = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

// ── JSON-RPC Transport ───────────────────────────────────────

class JsonRpcTransport {
  constructor(proc) {
    this._proc = proc;
    this._buf = "";
    this._pending = new Map(); // id → { resolve, reject, timer }
    this._nextId = 1;
    this._notifications = []; // collected notifications

    proc.stdout.on("data", (chunk) => this._onData(chunk.toString()));
    proc.stderr.on("data", (chunk) => {
      log(`[lsp-stderr] ${chunk.toString().trim()}`);
    });
  }

  _onData(data) {
    this._buf += data;

    while (true) {
      // Parse Content-Length header
      const headerEnd = this._buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this._buf.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        this._buf = this._buf.slice(headerEnd + 4);
        continue;
      }

      const len = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      if (this._buf.length < bodyStart + len) break;

      const body = this._buf.slice(bodyStart, bodyStart + len);
      this._buf = this._buf.slice(bodyStart + len);

      try {
        const msg = JSON.parse(body);
        this._handleMessage(msg);
      } catch (e) {
        log(`[lsp] JSON parse error: ${e.message}`);
      }
    }
  }

  _handleMessage(msg) {
    if (msg.id !== undefined && msg.id !== null && this._pending.has(msg.id)) {
      // Response to a request
      const { resolve, reject, timer } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (timer) clearTimeout(timer);
      if (msg.error) {
        reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        resolve(msg.result);
      }
    } else if (msg.method) {
      // Notification or server-initiated request
      if (msg.method === "textDocument/publishDiagnostics") {
        this._notifications.push(msg.params);
      }
      // Respond to server requests (window/workDoneProgress/create, etc.)
      if (msg.id !== undefined && msg.id !== null) {
        this._send({ jsonrpc: "2.0", id: msg.id, result: null });
      }
    }
  }

  _send(obj) {
    const body = JSON.stringify(obj);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    try {
      this._proc.stdin.write(header + body);
    } catch { /* process may have died */ }
  }

  request(method, params, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`LSP request timeout: ${method}`));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this._send({ jsonrpc: "2.0", method, params });
  }

  drainDiagnostics() {
    const all = [...this._notifications];
    this._notifications = [];
    return all;
  }

  destroy() {
    for (const { reject, timer } of this._pending.values()) {
      if (timer) clearTimeout(timer);
      reject(new Error("Transport destroyed"));
    }
    this._pending.clear();
  }
}

// ── LSP Client (per language) ────────────────────────────────

class LspClient {
  constructor(lang, config) {
    this.lang = lang;
    this.config = config;
    this._proc = null;
    this._transport = null;
    this._initialized = false;
    this._rootUri = null;
    this._openDocs = new Set(); // tracked open document URIs
    this._diagnosticCache = new Map(); // uri → diagnostics[]
  }

  async start(rootPath) {
    if (this._proc) return;

    this._rootUri = `file://${rootPath}`;

    try {
      this._proc = spawn(this.config.command, this.config.args, {
        cwd: rootPath,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      });

      this._proc.on("error", (e) => {
        log(`[lsp:${this.lang}] spawn error: ${e.message}`);
        this._proc = null;
        this._initialized = false;
      });

      this._proc.on("exit", (code) => {
        log(`[lsp:${this.lang}] exited (code ${code})`);
        this._proc = null;
        this._initialized = false;
      });

      this._transport = new JsonRpcTransport(this._proc);

      // Initialize
      const initResult = await this._transport.request("initialize", {
        processId: process.pid,
        rootUri: this._rootUri,
        rootPath,
        capabilities: {
          textDocument: {
            publishDiagnostics: { relatedInformation: true },
            synchronization: { didSave: true, willSave: false },
            completion: { completionItem: { snippetSupport: false } },
            hover: { contentFormat: ["plaintext", "markdown"] },
            definition: {},
            references: {},
            rename: {},
            signatureHelp: {},
          },
          workspace: {
            workspaceFolders: true,
            didChangeConfiguration: { dynamicRegistration: false },
          },
        },
        initializationOptions: this.config.initOptions,
        workspaceFolders: [{ uri: this._rootUri, name: path.basename(rootPath) }],
      });

      this._transport.notify("initialized", {});
      this._initialized = true;
      log(`[lsp:${this.lang}] initialized (capabilities: ${Object.keys(initResult?.capabilities || {}).length})`);

      return true;
    } catch (e) {
      log(`[lsp:${this.lang}] init failed: ${e.message}`);
      this.stop();
      return false;
    }
  }

  stop() {
    if (this._transport) {
      try { this._transport.request("shutdown", null, 3000).catch(() => {}); } catch { /* ignore: server may be dead */ }
      try { this._transport.notify("exit", null); } catch { /* ignore: server may be dead */ }
      this._transport.destroy();
      this._transport = null;
    }
    if (this._proc) {
      try { this._proc.kill(); } catch { /* ignore: server may be dead */ }
      this._proc = null;
    }
    this._initialized = false;
    this._openDocs.clear();
    this._diagnosticCache.clear();
  }

  get alive() {
    return this._initialized && this._proc && !this._proc.killed;
  }

  _fileUri(filePath) {
    return `file://${path.resolve(filePath)}`;
  }

  _languageId(filePath) {
    const ext = path.extname(filePath);
    if (this.lang === "typescript") {
      if (ext === ".tsx") return "typescriptreact";
      if (ext === ".jsx") return "javascriptreact";
      if ([".js", ".mjs", ".cjs"].includes(ext)) return "javascript";
      return "typescript";
    }
    return "python";
  }

  handles(filePath) {
    const ext = path.extname(filePath);
    return this.config.extensions.includes(ext);
  }

  async openFile(filePath) {
    if (!this.alive) return;
    const uri = this._fileUri(filePath);
    if (this._openDocs.has(uri)) return;

    let text;
    try { text = fs.readFileSync(filePath, "utf-8"); } catch { /* ignore: file unreadable */ return; }

    this._transport.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: this._languageId(filePath),
        version: 1,
        text,
      },
    });
    this._openDocs.add(uri);
  }

  async notifyChange(filePath) {
    if (!this.alive) return;
    const uri = this._fileUri(filePath);

    let text;
    try { text = fs.readFileSync(filePath, "utf-8"); } catch { /* ignore: file unreadable */ return; }

    if (!this._openDocs.has(uri)) {
      await this.openFile(filePath);
      return;
    }

    this._transport.notify("textDocument/didChange", {
      textDocument: { uri, version: Date.now() },
      contentChanges: [{ text }],
    });
  }

  async getDiagnostics(filePath, waitMs = 2000) {
    if (!this.alive) return [];
    const uri = this._fileUri(filePath);

    // Ensure file is open
    await this.openFile(filePath);
    // Notify change to trigger fresh diagnostics
    await this.notifyChange(filePath);

    // Wait for publishDiagnostics notification
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await sleep(200);
      const notifications = this._transport.drainDiagnostics();
      for (const n of notifications) {
        this._diagnosticCache.set(n.uri, n.diagnostics || []);
      }
      if (this._diagnosticCache.has(uri)) {
        return this._diagnosticCache.get(uri);
      }
    }

    return this._diagnosticCache.get(uri) || [];
  }

  async getHover(filePath, line, character) {
    if (!this.alive) return null;
    await this.openFile(filePath);
    try {
      return await this._transport.request("textDocument/hover", {
        textDocument: { uri: this._fileUri(filePath) },
        position: { line, character },
      });
    } catch { /* ignore: LSP request failed */ return null; }
  }

  async getDefinition(filePath, line, character) {
    if (!this.alive) return null;
    await this.openFile(filePath);
    try {
      return await this._transport.request("textDocument/definition", {
        textDocument: { uri: this._fileUri(filePath) },
        position: { line, character },
      });
    } catch { /* ignore: LSP request failed */ return null; }
  }

  async getReferences(filePath, line, character) {
    if (!this.alive) return null;
    await this.openFile(filePath);
    try {
      return await this._transport.request("textDocument/references", {
        textDocument: { uri: this._fileUri(filePath) },
        position: { line, character },
        context: { includeDeclaration: true },
      });
    } catch { /* ignore: LSP request failed */ return null; }
  }

  async getCompletions(filePath, line, character) {
    if (!this.alive) return null;
    await this.openFile(filePath);
    try {
      return await this._transport.request("textDocument/completion", {
        textDocument: { uri: this._fileUri(filePath) },
        position: { line, character },
      });
    } catch { /* ignore: LSP request failed */ return null; }
  }

  async getRename(filePath, line, character, newName) {
    if (!this.alive) return null;
    await this.openFile(filePath);
    try {
      return await this._transport.request("textDocument/rename", {
        textDocument: { uri: this._fileUri(filePath) },
        position: { line, character },
        newName,
      });
    } catch { /* ignore: LSP request failed */ return null; }
  }
}

// ── LSP Manager ──────────────────────────────────────────────

class LspManager {
  constructor() {
    this._clients = new Map(); // lang → LspClient
    this._rootPath = null;
    this._enabled = true;
    this._startPromise = null;
  }

  async start(rootPath) {
    if (this._startPromise) return this._startPromise;
    this._rootPath = rootPath;

    this._startPromise = (async () => {
      // Detect which languages are present
      const langs = this._detectLanguages(rootPath);

      for (const lang of langs) {
        const config = LANG_CONFIGS[lang];
        if (!config) continue;

        const client = new LspClient(lang, config);
        const ok = await client.start(rootPath);
        if (ok) {
          this._clients.set(lang, client);
          log(`[lsp] ${lang} server started`);
        }
      }
    })();

    return this._startPromise;
  }

  _detectLanguages(rootPath) {
    const langs = new Set();
    try {
      const scan = (dir, depth = 0) => {
        if (depth > 2) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.name === "node_modules" ||
              entry.name === "__pycache__" || entry.name === "dist" ||
              entry.name === "build" || entry.name === ".git") continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scan(full, depth + 1);
          } else {
            const ext = path.extname(entry.name);
            for (const [lang, cfg] of Object.entries(LANG_CONFIGS)) {
              if (cfg.extensions.includes(ext)) langs.add(lang);
            }
          }
          if (langs.size >= Object.keys(LANG_CONFIGS).length) return;
        }
      };
      scan(rootPath);
    } catch { /* ignore scan errors */ }
    return [...langs];
  }

  _clientFor(filePath) {
    for (const client of this._clients.values()) {
      if (client.handles(filePath) && client.alive) return client;
    }
    return null;
  }

  async getDiagnostics(filePath, waitMs = 2000) {
    if (!this._enabled) return [];
    const client = this._clientFor(filePath);
    if (!client) return [];
    try {
      return await client.getDiagnostics(filePath, waitMs);
    } catch (e) {
      log(`[lsp] getDiagnostics error: ${e.message}`);
      return [];
    }
  }

  async getHover(filePath, line, character) {
    const client = this._clientFor(filePath);
    if (!client) return null;
    return client.getHover(filePath, line, character);
  }

  async getDefinition(filePath, line, character) {
    const client = this._clientFor(filePath);
    if (!client) return null;
    return client.getDefinition(filePath, line, character);
  }

  async getReferences(filePath, line, character) {
    const client = this._clientFor(filePath);
    if (!client) return null;
    return client.getReferences(filePath, line, character);
  }

  async getCompletions(filePath, line, character) {
    const client = this._clientFor(filePath);
    if (!client) return null;
    return client.getCompletions(filePath, line, character);
  }

  async getRename(filePath, line, character, newName) {
    const client = this._clientFor(filePath);
    if (!client) return null;
    return client.getRename(filePath, line, character, newName);
  }

  shutdown() {
    for (const client of this._clients.values()) {
      client.stop();
    }
    this._clients.clear();
    this._startPromise = null;
  }

  get active() {
    return [...this._clients.values()].some(c => c.alive);
  }

  get languages() {
    return [...this._clients.entries()]
      .filter(([, c]) => c.alive)
      .map(([lang]) => lang);
  }
}

// ── Diagnostic Formatting ────────────────────────────────────

function formatDiagnostics(diagnostics, filePath, { compact = false } = {}) {
  if (!diagnostics || diagnostics.length === 0) return "";

  const seen = new Set();
  const deduped = diagnostics.filter((d) => {
    const key = JSON.stringify([
      path.resolve(filePath),
      d.severity || 4,
      d.message || "",
      d.source || "",
      typeof d.code === "object" ? d.code?.value : d.code,
      d.range?.start?.line ?? null,
      d.range?.start?.character ?? null,
      d.range?.end?.line ?? null,
      d.range?.end?.character ?? null,
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort: errors first, then warnings, then info
  const sorted = [...deduped].sort((a, b) => (a.severity || 4) - (b.severity || 4));

  const errors = sorted.filter(d => d.severity === 1);
  const warnings = sorted.filter(d => d.severity === 2);
  const infos = sorted.filter(d => d.severity === 3 || d.severity === 4);

  if (compact) {
    const parts = [];
    if (errors.length) parts.push(`${errors.length} error${errors.length > 1 ? "s" : ""}`);
    if (warnings.length) parts.push(`${warnings.length} warning${warnings.length > 1 ? "s" : ""}`);
    return parts.length ? `[LSP: ${parts.join(", ")} in ${path.basename(filePath)}]` : "";
  }

  const lines = [`\n<lsp-diagnostics file="${path.basename(filePath)}" errors="${errors.length}" warnings="${warnings.length}">`];

  for (const d of sorted) {
    const sev = SEVERITY[d.severity] || "info";
    const line = d.range?.start?.line ?? "?";
    const col = d.range?.start?.character ?? "?";
    const src = d.source ? ` (${d.source})` : "";
    const code = d.code ? ` [${typeof d.code === "object" ? d.code.value : d.code}]` : "";
    lines.push(`  ${sev} L${line + 1}:${col + 1}${src}${code}: ${d.message}`);

    if (d.relatedInformation) {
      for (const ri of d.relatedInformation.slice(0, 3)) {
        const rl = ri.location?.range?.start?.line ?? "?";
        const rf = ri.location?.uri ? path.basename(ri.location.uri.replace("file://", "")) : "?";
        lines.push(`    → ${rf}:${rl + 1}: ${ri.message}`);
      }
    }
  }

  lines.push("</lsp-diagnostics>");
  return lines.join("\n");
}

// ── Tool Registration ────────────────────────────────────────

function registerLspTools(registry, lspManager) {
  // Deferred tool — model can use on-demand for diagnostics, hover, go-to-def
  registry.register("LspDiagnostics", {
    description: `Get language server diagnostics (errors, warnings) for a file. Use this after writing or editing code to check for type errors, import issues, and other problems. Also supports hover info, go-to-definition, and find-references.

Available actions:
- "diagnostics": Get all errors/warnings for a file
- "hover": Get type info at a position (line + character)
- "definition": Go to definition of symbol at position
- "references": Find all references of symbol at position
- "workspace": Get diagnostic summary for the whole workspace`,
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["diagnostics", "hover", "definition", "references", "workspace"],
          description: "Action to perform",
        },
        file_path: {
          type: "string",
          description: "Absolute path to the file",
        },
        line: {
          type: "number",
          description: "0-based line number (for hover/definition/references)",
        },
        character: {
          type: "number",
          description: "0-based character offset (for hover/definition/references)",
        },
      },
      required: ["action"],
    },
  }, async (input) => {
    const action = input.action;

    if (action === "workspace") {
      const langs = lspManager.languages;
      if (langs.length === 0) return { content: "No language servers active.", is_error: false };
      return { content: `Active language servers: ${langs.join(", ")}`, is_error: false };
    }

    if (!input.file_path) return { content: "file_path is required", is_error: true };
    const filePath = path.resolve(input.file_path);

    if (action === "diagnostics") {
      const diags = await lspManager.getDiagnostics(filePath);
      if (diags.length === 0) return { content: `No diagnostics for ${path.basename(filePath)} — clean!`, is_error: false };
      return { content: formatDiagnostics(diags, filePath), is_error: false };
    }

    if (action === "hover") {
      if (input.line === undefined || input.character === undefined) {
        return { content: "line and character are required for hover", is_error: true };
      }
      const result = await lspManager.getHover(filePath, input.line, input.character);
      if (!result?.contents) return { content: "No hover info", is_error: false };
      const text = typeof result.contents === "string" ? result.contents
        : result.contents.value || JSON.stringify(result.contents);
      return { content: text, is_error: false };
    }

    if (action === "definition") {
      if (input.line === undefined || input.character === undefined) {
        return { content: "line and character are required for definition", is_error: true };
      }
      const result = await lspManager.getDefinition(filePath, input.line, input.character);
      if (!result) return { content: "No definition found", is_error: false };
      const locs = Array.isArray(result) ? result : [result];
      const lines = locs.map(l => {
        const uri = l.uri || l.targetUri || "";
        const range = l.range || l.targetRange || {};
        return `${uri.replace("file://", "")}:${(range.start?.line || 0) + 1}`;
      });
      return { content: lines.join("\n"), is_error: false };
    }

    if (action === "references") {
      if (input.line === undefined || input.character === undefined) {
        return { content: "line and character are required for references", is_error: true };
      }
      const result = await lspManager.getReferences(filePath, input.line, input.character);
      if (!result || result.length === 0) return { content: "No references found", is_error: false };
      const lines = result.slice(0, 50).map(l => {
        const f = (l.uri || "").replace("file://", "");
        return `${f}:${(l.range?.start?.line || 0) + 1}`;
      });
      return { content: `${result.length} references:\n${lines.join("\n")}`, is_error: false };
    }

    return { content: `Unknown action: ${action}`, is_error: true };
  }, { deferred: true });
}

// ── PostToolUse Diagnostic Injection ─────────────────────────

function createLspPostToolHook(lspManager) {
  // Returns a function compatible with HookRunner's hook interface.
  // Called after Write/Edit to append diagnostics to the tool result.
  return async function lspPostToolHook(toolName, toolInput, toolResult) {
    if (!lspManager.active) return null;

    // Only trigger on file mutation tools
    if (toolName !== "Write" && toolName !== "Edit") return null;

    const filePath = toolInput?.file_path;
    if (!filePath) return null;

    try {
      const diags = await lspManager.getDiagnostics(path.resolve(filePath), 3000);
      if (!diags || diags.length === 0) return null;

      const errors = diags.filter(d => d.severity === 1);
      const warnings = diags.filter(d => d.severity === 2);

      // Only inject if there are errors or warnings
      if (errors.length === 0 && warnings.length === 0) return null;

      return formatDiagnostics(diags, filePath);
    } catch { /* ignore: LSP hook non-fatal */
      return null;
    }
  };
}

// ── Exports ──────────────────────────────────────────────────

export {
  LspManager,
  LspClient,
  LANG_CONFIGS,
  SEVERITY,
  formatDiagnostics,
  registerLspTools,
  createLspPostToolHook,
};
