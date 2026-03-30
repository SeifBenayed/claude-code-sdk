// src/session.mjs — SessionManager, CheckpointStore, NdjsonBridge, SlashCommandRegistry, RemoteSessionManager, InteractiveMode

import { spawn, execSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import _http from "node:http";
import _https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { log, sleep, EXIT, _VERSION } from "./utils.mjs";
import { resolveModel } from "./config.mjs";
import { detectProvider, PROVIDERS } from "./providers.mjs";
import { PermissionManager } from "./security.mjs";
import { AgentLoop, buildSystemPrompt, SkillLoader, SkillExecutionContext, HookRunner, AgentLoader, loadSettings, applySettings, loadRules, loadClaudeMdFiles, findProjectRoot, PROVIDER_CONVENTION_FILES, ensureMemoryDir, loadMemoryIndex, skillImport, skillList, skillInfo, skillRemove, skillUpdate, skillExport, skillVerify, skillSearch, skillPublish, registerAgentTool, SubAgentRunner, BackgroundAgentManager, _scanProjectStructure, ensureSkillDataDir, getMemoryDir } from "./engine.mjs";
import { ToolRegistry, registerBuiltinTools, registerMemoryTools, registerDeferredBuiltinTools, registerBriefTools, registerToolSearch, registerAskUserQuestion, scanCustomTools, registerMcpResourceTools, registerDesktopTools, registerSpreadsheetTools, registerPdfTools, registerDocumentTools, registerPresentationTools, _OFFICIAL_CATALOG, _loadToolManifest, toolList, toolInfo, toolEnable, toolDisable, toolTest, toolInstall, toolUpdate, toolRemove, toolCatalog, toolPublish } from "./tools.mjs";
import { registerBrowserTools } from "./browser.mjs";
import { oauthLogin, oauthLogout, openaiOAuthLogin, openaiOAuthLogout, getOAuthAccessToken, getOpenAIAccessToken } from "./auth.mjs";
import { AutoMemory } from "./auto-memory.mjs";
import { shouldDream, runDream, incrementDreamSessionCount } from "./memory-dream.mjs";
import { readSkillMetrics, summarizeSkillMetrics } from "./skill-metrics.mjs";
import { expandContextRefs } from "./context-refs.mjs";
import { routeModel } from "./smart-routing.mjs";

// ── Background Review Nudge Constants ──────────────────────────

const DEFAULT_SKILL_NUDGE_INTERVAL = 20;
const DEFAULT_MEMORY_NUDGE_INTERVAL = 10;

const _SKILL_REVIEW_PROMPT = `Review the conversation and consider if repetitive patterns could be automated. If you identify a pattern, create it using the skill-creator skill via the Skill tool.
Skill performance metrics:
{METRICS}
Existing skills: {SKILLS}
Guidance:
- High error rate skills need fixing or replacing
- Zero uses skills should be pruned
- Don't create duplicates of existing skills`;

const _MEMORY_REVIEW_PROMPT = `Review the conversation and identify important facts or decisions. If you find something worth remembering, save it using MemorySave.`;

const _COMBINED_REVIEW_PROMPT = `Review the conversation for both skill automation and memory-worthy facts. Don't create duplicates. For skills use the skill-creator skill via the Skill tool. For memories use MemorySave.`;

function _extractReviewActions(result) {
  const text = result?.text || "";
  if (!text) return [];
  const actions = [];
  if (text.includes("Skill created")) actions.push("Skill created");
  if (text.includes("Skill updated")) actions.push("Skill updated");
  if (text.includes("Memory saved")) actions.push("Memory saved");
  return actions;
}

function _parseStructuredOutput(toolName, result) {
  if (result?.is_error) return null;
  if (toolName !== "SendUserMessage" && toolName !== "TaskOutput") return null;
  try {
    return JSON.parse(result.content);
  } catch {
    return null;
  }
}

function _renderStructuredOutput(parsed, toolName) {
  if (!parsed) return "";
  if (toolName === "TaskOutput") {
    const status = parsed.status ? `[${parsed.status}] ` : "";
    return `${status}${parsed.message || ""}`.trim();
  }
  return parsed.message || "";
}

function _flattenUserFacingOutputs(outputs, fallbackText = "") {
  if (!Array.isArray(outputs) || outputs.length === 0) return fallbackText || "";
  const parts = outputs.map((output) => {
    if (!output || typeof output !== "object") return "";
    if (output.kind === "task_output") return output.message || output.summary || "";
    return output.message || "";
  }).filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : (fallbackText || "");
}

// ── SessionManager ──────────────────────────────────────────────

class SessionManager {
  constructor(cwd) {
    // Scope sessions by project directory
    const sanitized = (cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").slice(0, 100);
    this.dir = path.join(os.homedir(), ".claude-native", "projects", sanitized, "sessions");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  create() {
    const id = randomUUID();
    const filePath = path.join(this.dir, `${id}.jsonl`);
    fs.writeFileSync(filePath, "");
    return id;
  }

  load(id) {
    const filePath = this._findFile(id);
    if (!filePath || !fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    return lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean).filter((m) => m.role); // Only load actual messages (not metadata)
  }

  append(id, message) {
    const filePath = path.join(this.dir, `${id}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(message) + "\n");
  }

  // Rewrite session file with compacted messages (preserves metadata)
  rewrite(id, messages) {
    const filePath = this._findFile(id);
    if (!filePath) return;
    // Preserve metadata lines from the old file
    const oldLines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    const metaLines = [];
    for (const line of oldLines) {
      try {
        const obj = JSON.parse(line);
        if (obj._meta) metaLines.push(line);
      } catch { /* skip */ }
    }
    // Write compaction marker + compacted messages + preserved metadata
    const lines = [
      JSON.stringify({ _meta: "compacted", value: true, timestamp: new Date().toISOString() }),
      ...messages.map(m => JSON.stringify(m)),
      ...metaLines,
    ];
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
  }

  // Save session metadata (title, summary, etc.)
  setMeta(id, key, value) {
    const filePath = path.join(this.dir, `${id}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify({ _meta: key, value, timestamp: new Date().toISOString() }) + "\n");
  }

  getMeta(id, key) {
    const filePath = this._findFile(id);
    if (!filePath) return null;
    const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    // Return last matching meta entry
    let result = null;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj._meta === key) result = obj.value;
      } catch { /* ignore: malformed JSONL line */ }
    }
    return result;
  }

  // Auto-generate title from first user message
  autoTitle(id) {
    const msgs = this.load(id);
    const firstUser = msgs.find((m) => m.role === "user" && typeof m.content === "string");
    if (!firstUser) return null;
    const title = firstUser.content.substring(0, 80).replace(/\n/g, " ").trim();
    return title + (firstUser.content.length > 80 ? "..." : "");
  }

  // List all sessions for this project, sorted by recency
  listAll() {
    try {
      return fs.readdirSync(this.dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => {
          const id = f.replace(".jsonl", "");
          const stat = fs.statSync(path.join(this.dir, f));
          const title = this.getMeta(id, "title") || this.autoTitle(id) || "(empty)";
          // Count messages (lines that have a "role" field)
          let msgCount = 0;
          try {
            const content = fs.readFileSync(path.join(this.dir, f), "utf-8");
            msgCount = content.split("\n").filter((l) => l.includes('"role"')).length;
          } catch { /* ignore: session file may be unreadable */ }
          return { id, title, msgCount, mtime: stat.mtimeMs, size: stat.size };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch { return []; }
  }

  latest() {
    const sessions = this.listAll();
    return sessions[0]?.id || null;
  }

  // Find session file — supports full UUID or prefix match
  _findFile(id) {
    const exact = path.join(this.dir, `${id}.jsonl`);
    if (fs.existsSync(exact)) return exact;
    // Prefix match
    try {
      const match = fs.readdirSync(this.dir).find((f) => f.startsWith(id) && f.endsWith(".jsonl"));
      return match ? path.join(this.dir, match) : null;
    } catch { return null; }
  }
}

// ── CheckpointStore ─────────────────────────────────────────────
//
// Backs up files before Write/Edit mutations. Supports dry-run preview
// and live rewind to any snapshot. Persists manifest to disk.

class CheckpointStore {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.dir = path.join(os.homedir(), ".claude-native", "file-history", sessionId);
    this.manifestPath = path.join(this.dir, "manifest.jsonl");
    this.snapshots = [];
    this.trackedFiles = new Set();
    this.maxSnapshots = 100;
    fs.mkdirSync(this.dir, { recursive: true });
    this._loadManifest();
  }

  _loadManifest() {
    try {
      const data = fs.readFileSync(this.manifestPath, "utf-8");
      for (const line of data.split("\n").filter(Boolean)) {
        try {
          const snap = JSON.parse(line);
          this.snapshots.push(snap);
          if (snap.trackedFiles) snap.trackedFiles.forEach((f) => this.trackedFiles.add(f));
        } catch { /* skip malformed */ }
      }
      // Trim to max
      if (this.snapshots.length > this.maxSnapshots) {
        this.snapshots = this.snapshots.slice(-this.maxSnapshots);
      }
    } catch { /* no manifest yet */ }
  }

  _appendManifest(snapshot) {
    fs.appendFileSync(this.manifestPath, JSON.stringify(snapshot) + "\n");
  }

  _rewriteManifest() {
    // Rewrite entire manifest with current snapshots (after in-place updates)
    const data = this.snapshots.map((s) => JSON.stringify(s)).join("\n") + "\n";
    fs.writeFileSync(this.manifestPath, data);
  }

  _backupName(absPath, version) {
    const hash = createHash("sha256").update(absPath).digest("hex").slice(0, 16);
    return `${hash}@v${version}`;
  }

  _backupPath(backupFile) {
    return path.join(this.dir, backupFile);
  }

  _backupFile(absPath, version) {
    const backupFile = this._backupName(absPath, version);
    const dest = this._backupPath(backupFile);
    try {
      const content = fs.readFileSync(absPath, "utf-8");
      fs.writeFileSync(dest, content, { encoding: "utf-8", flush: true });
      // Preserve permissions
      try { const stat = fs.statSync(absPath); fs.chmodSync(dest, stat.mode); } catch { /* ignore: permissions may not be readable */ }
    } catch { /* file might not exist */ }
    return { backupFile, version, backupTime: new Date().toISOString() };
  }

  _restoreFile(absPath, backupFile) {
    const src = this._backupPath(backupFile);
    const content = fs.readFileSync(src, "utf-8");
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, { encoding: "utf-8" });
    try { const stat = fs.statSync(src); fs.chmodSync(absPath, stat.mode); } catch { /* ignore: permissions may not be readable */ }
  }

  _diffFile(absPath, backupFile) {
    const backupPath = this._backupPath(backupFile);
    let currentExists = false, backupExists = false;
    let currentContent = "", backupContent = "";

    try { currentContent = fs.readFileSync(absPath, "utf-8"); currentExists = true; } catch { /* ignore: file may not exist */ }
    try { backupContent = fs.readFileSync(backupPath, "utf-8"); backupExists = true; } catch { /* ignore: backup may not exist */ }

    if (!currentExists && !backupExists) return { changed: false, conflict: false, insertions: 0, deletions: 0 };
    if (currentContent === backupContent) return { changed: false, conflict: false, insertions: 0, deletions: 0 };

    // Count insertions/deletions (simple line diff)
    const curLines = currentContent.split("\n");
    const bakLines = backupContent.split("\n");
    const insertions = Math.max(0, bakLines.length - curLines.length);
    const deletions = Math.max(0, curLines.length - bakLines.length);

    // Conflict: file was modified externally (not by our tools) since backup
    let conflict = false;
    if (currentExists && backupExists) {
      try {
        const curStat = fs.statSync(absPath);
        const bakStat = fs.statSync(backupPath);
        // If current file is newer than backup AND content differs, potential conflict
        if (curStat.mtimeMs > bakStat.mtimeMs) conflict = true;
      } catch { /* ignore: stat may fail if file was just deleted */ }
    }

    return { changed: true, conflict, insertions, deletions };
  }

  // Create a snapshot for all tracked files at a user message boundary
  createSnapshot(messageId) {
    const backups = {};
    const trackedArr = [...this.trackedFiles];

    for (const relPath of trackedArr) {
      const absPath = path.resolve(relPath);
      const prevSnap = this.snapshots[this.snapshots.length - 1];
      const prevBackup = prevSnap?.backups?.[relPath];

      if (!fs.existsSync(absPath)) {
        // File was deleted — record null backup
        backups[relPath] = { backupFile: null, version: (prevBackup?.version || 0) + 1, backupTime: new Date().toISOString() };
      } else if (prevBackup?.backupFile) {
        // Check if file changed since last backup
        const diff = this._diffFile(absPath, prevBackup.backupFile);
        if (!diff.changed) {
          backups[relPath] = prevBackup; // Reuse
        } else {
          backups[relPath] = this._backupFile(absPath, (prevBackup.version || 0) + 1);
        }
      } else {
        backups[relPath] = this._backupFile(absPath, 1);
      }
    }

    const snapshot = {
      messageId,
      timestamp: new Date().toISOString(),
      backups,
      trackedFiles: trackedArr,
    };

    this.snapshots.push(snapshot);
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots = this.snapshots.slice(-this.maxSnapshots);
    }
    this._appendManifest(snapshot);
    log(`Checkpoint created: ${messageId} (${trackedArr.length} files)`);
    return snapshot;
  }

  // Backup a file before Write/Edit mutates it
  backupBeforeMutation(filePath, messageId) {
    const absPath = path.resolve(filePath);
    const relPath = path.relative(process.cwd(), absPath);
    this.trackedFiles.add(relPath);

    // Find current snapshot (last one matching this messageId)
    let snap = this.snapshots.findLast((s) => s.messageId === messageId);
    if (!snap) {
      // No snapshot for this message yet — create one
      snap = this.createSnapshot(messageId);
    }

    // Already backed up in this snapshot?
    if (snap.backups[relPath]) return;

    // Backup the file (or record null if it doesn't exist)
    if (fs.existsSync(absPath)) {
      const prevBackup = snap.backups[relPath];
      const version = (prevBackup?.version || 0) + 1;
      snap.backups[relPath] = this._backupFile(absPath, version);
    } else {
      snap.backups[relPath] = { backupFile: null, version: 1, backupTime: new Date().toISOString() };
    }

    // Update tracked files in snapshot
    if (!snap.trackedFiles.includes(relPath)) {
      snap.trackedFiles = [...snap.trackedFiles, relPath];
    }

    // Persist updated snapshot to manifest
    this._rewriteManifest();
    log(`Backed up: ${relPath} (before mutation)`);
  }

  // Rewind to a snapshot. dryRun=true returns preview without restoring.
  rewind(messageId, dryRun = false) {
    const snap = this.snapshots.findLast((s) => s.messageId === messageId);
    if (!snap) return { canRewind: false, error: "No checkpoint found for this message." };

    const conflicts = [];
    const created = [];   // Files that will be deleted (didn't exist at snapshot)
    const deleted = [];   // Files that will be recreated (were deleted since)
    const restored = [];  // Files that will be reverted
    let insertions = 0, deletions = 0;

    for (const relPath of snap.trackedFiles || []) {
      const absPath = path.resolve(relPath);
      const backup = snap.backups[relPath];

      if (!backup || backup.backupFile === null) {
        // File didn't exist at snapshot time — if it exists now, it should be deleted
        if (fs.existsSync(absPath)) {
          created.push(relPath);
          if (!dryRun) {
            try { fs.unlinkSync(absPath); } catch { /* ignore: file may have been removed externally */ }
          }
        }
        continue;
      }

      // File had a backup
      const diff = this._diffFile(absPath, backup.backupFile);
      if (!diff.changed) continue; // Same content, skip

      if (diff.conflict) {
        conflicts.push({ file: relPath, reason: "File modified externally since checkpoint" });
      }

      insertions += diff.insertions;
      deletions += diff.deletions;

      if (!fs.existsSync(absPath)) {
        deleted.push(relPath);
      } else {
        restored.push(relPath);
      }

      if (!dryRun) {
        this._restoreFile(absPath, backup.backupFile);
      }
    }

    return {
      canRewind: true,
      targetMessageId: messageId,
      conflicts,
      created,
      deleted,
      restored,
      insertions,
      deletions,
    };
  }

  getSnapshots() {
    return this.snapshots.map((s) => ({
      messageId: s.messageId,
      timestamp: s.timestamp,
      fileCount: (s.trackedFiles || []).length,
    }));
  }
}

// ── NdjsonBridge ────────────────────────────────────────────────

class NdjsonBridge {
  constructor(cfg, registry, client, mcpManager, permissions = null) {
    this.cfg = cfg;
    this.registry = registry;
    this.client = client;
    this.mcpManager = mcpManager;
    this.permissions = permissions;
    this.sessions = new SessionManager(this.cfg.cwd);
    this._pendingToolCalls = new Map(); // id → { resolve }
    this._pendingPermissions = new Map(); // requestId → { resolve }
  }

  emit(obj) {
    process.stdout.write(JSON.stringify(obj) + "\n");
  }

  async run() {
    const sessionId = this.sessions.create();
    this.checkpoints = new CheckpointStore(sessionId);
    this.emit({ type: "ready", version: _VERSION, mode: "native", session_id: sessionId });

    // Non-blocking stdin reader: pushes messages to a queue and resolves waiters
    const queue = [];
    let waiter = null;

    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try { msg = JSON.parse(trimmed); } catch { return; }

      // tool_result goes directly to pending tool calls (unblocks agent loop)
      if (msg.type === "tool_result") {
        this._handleToolResult(msg);
        return;
      }

      // permission_response goes directly to pending permission requests
      if (msg.type === "permission_response") {
        const pending = this._pendingPermissions.get(msg.request_id);
        if (pending) {
          this._pendingPermissions.delete(msg.request_id);
          pending.resolve(msg.allow === true);
          // Optionally add permanent rule
          if (msg.allow && msg.remember && this.permissions) {
            this.permissions.addRule(msg.tool || "*", null, "allow");
          }
        }
        return;
      }

      // Everything else queued for the main loop
      if (waiter) { const w = waiter; waiter = null; w(msg); }
      else queue.push(msg);
    });

    rl.on("close", () => {
      if (waiter) { const w = waiter; waiter = null; w(null); }
    });

    const nextMessage = () => {
      if (queue.length > 0) return Promise.resolve(queue.shift());
      return new Promise((r) => { waiter = r; });
    };

    while (true) {
      const msg = await nextMessage();
      if (msg === null) break;

      switch (msg.type) {
        case "message":
          await this._handleMessage(msg, sessionId);
          break;

        case "set_model":
          if (msg.model) this.cfg.model = resolveModel(msg.model);
          break;

        case "interrupt":
          break;

        case "end_session":
          this.mcpManager.shutdown();
          process.exit(0);
          break;

        case "ping":
          this.emit({ type: "pong" });
          break;

        case "rewind":
          if (this.checkpoints) {
            const result = this.checkpoints.rewind(msg.message_id, msg.dry_run ?? true);
            this.emit({ type: "checkpoint_result", ...result });
          } else {
            this.emit({ type: "checkpoint_result", canRewind: false, error: "Checkpointing not enabled." });
          }
          break;

        case "checkpoint_list":
          this.emit({ type: "checkpoint_list_result", snapshots: this.checkpoints?.getSnapshots() || [] });
          break;

        case "set_brief":
          this.cfg.briefMode = !!msg.enabled;
          registerToolSearch(this.registry); // Re-evaluate ToolSearch availability
          this.emit({ type: "brief_mode", enabled: this.cfg.briefMode });
          break;

        default:
          this.emit({ type: "error", error: `Unknown message type: ${msg.type}` });
      }
    }
  }

  async _handleMessage(msg, sessionId) {
    // Register external tools if provided
    const externalTools = new Set();
    if (msg.tools) {
      for (const tool of msg.tools) {
        if (!this.registry.has(tool.name)) {
          externalTools.add(tool.name);
          this.registry.register(tool.name, {
            description: tool.description || "",
            input_schema: tool.input_schema || tool.parameters || { type: "object", properties: {} },
          }, null, { deferred: !!tool.deferred }); // External tools optionally deferred
        }
      }
      registerToolSearch(this.registry); // Re-evaluate ToolSearch after external tools added
    }

    // Build system prompt
    const systemBlocks = buildSystemPrompt({
      ...this.cfg,
      appendSystemPrompt: [this.cfg.appendSystemPrompt, msg.system, msg.context].filter(Boolean).join("\n\n"),
    });

    // Load session messages
    const messageId = randomUUID();
    const messages = this.sessions.load(sessionId);
    messages.push({ role: "user", content: msg.content, messageId });

    // Snapshot before agent runs
    if (this.checkpoints) {
      this.checkpoints.createSnapshot(messageId);
      this.registry._checkpoints = this.checkpoints;
      this.registry._messageId = messageId;
    }

    const loop = new AgentLoop(this.client, this.registry, this.cfg, {
      onText: (delta) => {
        this.emit({ type: "stream", event_type: "text_delta", data: { text: delta, ...(this.cfg.briefMode ? { is_trace: true } : {}) } });
      },
      onToolUse: (block) => {
        this.emit({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      },
      onExternalToolUse: (block) => {
        this.emit({ type: "tool_use", id: block.id, name: block.name, input: block.input });
        return new Promise((resolve) => {
          this._pendingToolCalls.set(block.id, { resolve });
        });
      },
      onToolResult: (id, result, toolName) => {
        const parsed = _parseStructuredOutput(toolName, result);
        if (toolName === "SendUserMessage" && parsed) {
          this.emit({ type: "user_message", message: parsed.message, attachments: parsed.attachments, status: parsed.status, sentAt: parsed.sentAt });
        } else if (toolName === "TaskOutput" && parsed) {
          this.emit({
            type: "task_output",
            task_id: parsed.task_id,
            status: parsed.status,
            message: parsed.message,
            summary: parsed.summary,
            output_file: parsed.output_file,
            session_url: parsed.session_url,
            attachments: parsed.attachments,
            metadata: parsed.metadata,
            sentAt: parsed.sentAt,
          });
        }
      },
      onPermissionDeny: (block, msg) => {
        this.emit({ type: "permission_denied", tool: block.name, message: msg });
      },
      onPermissionAsk: this.permissions?.callbacks ? (block, message) => {
        // Forward permission request to NDJSON agent
        const requestId = randomUUID();
        this.emit({
          type: "permission_request",
          request_id: requestId,
          tool: block.name,
          input: block.input,
          message,
        });
        return new Promise((resolve) => {
          this._pendingPermissions.set(requestId, { resolve: (allow) => resolve(allow) });
        });
      } : undefined,
    }, this.permissions);

    try {
      const result = await loop.run(messages, systemBlocks);
      const fallbackOutputs = (result.userFacingOutputs || []).filter((output) => output?.source === "plain_text_fallback");
      for (const output of fallbackOutputs) {
        this.emit({
          type: "user_message",
          message: output.message,
          attachments: output.attachments || [],
          status: output.status || "normal",
          sentAt: output.sentAt,
          source: output.source,
        });
      }

      // Save messages to session
      for (const m of messages) {
        this.sessions.append(sessionId, m);
      }

      this.emit({
        type: "response",
        content: result.text,
        user_facing_outputs: result.userFacingOutputs || [],
        session_id: sessionId,
        iterations: result.turns,
        usage: result.usage,
        stop_reason: result.stopReason,
        model: this.cfg.model,
      });
    } catch (e) {
      this.emit({ type: "error", error: e.message });
    }
  }

  _handleToolResult(msg) {
    const pending = this._pendingToolCalls.get(msg.id);
    if (pending) {
      this._pendingToolCalls.delete(msg.id);
      pending.resolve({ content: msg.content, is_error: msg.is_error || false });
    }
  }
}

// ── InteractiveMode ─────────────────────────────────────────────

// ── Slash Command Registry ─────────────────────────────────────

// ── Interactive Form — generic input collector ─────────────────
//
// Works in both readline and Ink modes. Each field is:
//   { name, label, type: "text"|"choice"|"confirm", default, options: [{label, value}] }
//
// Returns: { fieldName: value, ... } or null if cancelled.

async function interactiveForm(fields, { title = null } = {}) {
  const answers = {};

  if (title) process.stderr.write(`\n\x1b[1m  ${title}\x1b[0m\n\n`);

  for (const field of fields) {
    const answer = await _askField(field);
    if (answer === null && field.required !== false) return null; // cancelled
    answers[field.name] = answer !== null ? answer : (field.default ?? "");
  }

  return answers;
}

function _askField(field) {
  return new Promise((resolve) => {
    if (field.type === "confirm") {
      const def = field.default === true ? "Y/n" : "y/N";
      process.stderr.write(`\x1b[33m${field.label} (${def}): \x1b[0m`);
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question("", (answer) => {
        rl.close();
        const a = answer.trim().toLowerCase();
        if (!a) resolve(field.default ?? false);
        else resolve(a === "y" || a === "yes");
      });

    } else if (field.type === "choice" && field.options?.length > 0) {
      process.stderr.write(`\x1b[33m${field.label}\x1b[0m\n`);
      for (let i = 0; i < field.options.length; i++) {
        const opt = field.options[i];
        const desc = opt.description ? `  \x1b[2m${opt.description}\x1b[0m` : "";
        process.stderr.write(`  \x1b[36m${i + 1}.\x1b[0m ${opt.label}${desc}\n`);
      }
      const defHint = field.default ? `, default: ${field.default}` : "";
      process.stderr.write(`\x1b[33mChoose (1-${field.options.length}${defHint}): \x1b[0m`);
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question("", (answer) => {
        rl.close();
        const num = parseInt(answer.trim(), 10);
        if (num >= 1 && num <= field.options.length) {
          resolve(field.options[num - 1].value ?? field.options[num - 1].label);
        } else if (!answer.trim() && field.default) {
          resolve(field.default);
        } else {
          resolve(answer.trim() || field.default || null);
        }
      });

    } else {
      // text input
      const defHint = field.default ? ` (default: ${field.default})` : "";
      process.stderr.write(`\x1b[33m${field.label}${defHint}: \x1b[0m`);
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      rl.question("", (answer) => {
        rl.close();
        resolve(answer.trim() || field.default || "");
      });
    }
  });
}

// Multi-line text input (end with empty line)
async function interactiveMultiline(label) {
  process.stderr.write(`\x1b[33m${label} (end with empty line):\x1b[0m\n`);
  const lines = [];
  while (true) {
    const line = await _askField({ name: "_", label: "", type: "text" });
    if (!line) break;
    lines.push(line);
  }
  return lines.join("\n");
}

class SlashCommandRegistry {
  constructor() { this._commands = []; }

  register(cmd) {
    this._commands.push({ aliases: [], source: "builtin", argumentHint: "", isEnabled: () => true, isHidden: false, immediate: false, handler: null, ...cmd });
  }

  get(nameWithSlash) {
    const n = nameWithSlash.startsWith("/") ? nameWithSlash.slice(1) : nameWithSlash;
    return this._commands.find((c) => c.name === n || c.aliases.includes(n));
  }

  list(source = null) {
    return this._commands.filter((c) => {
      if (c.isHidden) return false;
      if (typeof c.isEnabled === "function" && !c.isEnabled()) return false;
      if (source && c.source !== source) return false;
      return true;
    });
  }

  completionNames() {
    const names = [];
    for (const c of this._commands) {
      if (c.isHidden) continue;
      if (typeof c.isEnabled === "function" && !c.isEnabled()) continue;
      names.push("/" + c.name);
      for (const a of c.aliases) names.push("/" + a);
    }
    return names;
  }
}

// ── Remote Session Manager ────────────────────────────────────────────────

// Permission tier constants for remote sessions
const REMOTE_TIERS = ["view", "chat", "control", "privileged"];
const REMOTE_BROWSER_MUTATING = new Set(["Browser_click", "Browser_type", "Browser_fill", "Browser_select", "Browser_navigate", "Browser_submit", "Browser_upload"]);
const REMOTE_DESKTOP_WRITE = new Set(["Write", "Edit", "Bash", "NotebookEdit"]);
const REMOTE_BROWSER_PRIVILEGED = new Set(["Bash", "Write"]);

class RemoteSessionManager {
  constructor() {
    this._relayUrl = process.env.CLOCLO_RELAY_URL || process.env.CLOCLO_REGISTRY_URL || "https://cloclo-registry-799190737906.europe-west1.run.app";
    this._token = null; this._url = null; this._expiresAt = null; this._mode = null;
    this._ws = null; this._active = false; this._clients = 0;
    this._pendingApprovals = new Map(); // id → { resolve, reject, toolName, input, requestedAt }
    this._auditLog = []; // { ts, event, ... }
    this._inputIsRemote = false;
    this._reconnectTimer = null;
    this._reconnectAttempts = 0;
  }

  async start(sessionId, mode = "control", expiryMinutes = 60) {
    // Register with relay
    const body = JSON.stringify({ session_id: sessionId, mode, expiry_minutes: expiryMinutes });
    const resp = await new Promise((resolve, reject) => {
      const parsed = new URL(`${this._relayUrl}/api/remote/register`);
      const mod = parsed.protocol === "https:" ? _https : _http;
      const req = mod.request({ hostname: parsed.hostname, port: parsed.port || (parsed.protocol === "https:" ? 443 : 80), path: parsed.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 10000 }, (res) => { let d = ""; res.on("data", c => d += c); res.on("end", () => res.statusCode < 400 ? resolve(d) : reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`))); });
      req.on("error", reject); req.on("timeout", () => { req.destroy(); reject(new Error("Relay timeout")); }); req.write(body); req.end();
    });
    const data = JSON.parse(resp);
    this._token = data.token; this._url = data.url; this._expiresAt = data.expires_at; this._mode = mode;
    // Connect outbound WS to relay as host
    await this._connectRelay();
    this._active = true;
    this._audit("session_started", { sessionId, mode, token: this._token.slice(0, 8) });
    return { token: this._token, url: this._url, expiresAt: this._expiresAt };
  }

  async stop() {
    if (!this._active) return;
    // Revoke on relay
    try {
      const body = JSON.stringify({ token: this._token });
      await new Promise((resolve) => {
        const parsed = new URL(`${this._relayUrl}/api/remote/revoke`);
        const mod = parsed.protocol === "https:" ? _https : _http;
        const req = mod.request({ hostname: parsed.hostname, port: parsed.port || (parsed.protocol === "https:" ? 443 : 80), path: parsed.pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 5000 }, (res) => { res.resume(); resolve(); });
        req.on("error", () => resolve()); req.write(body); req.end();
      });
    } catch { /* best effort */ }
    if (this._ws) { try { this._ws.destroy(); } catch { /* already closed */ } this._ws = null; }
    this._audit("session_stopped");
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    // Deny all pending approvals
    for (const [id, p] of this._pendingApprovals) { p.resolve(false); }
    this._pendingApprovals.clear();
    this._active = false; this._token = null; this._url = null;
  }

  async status() {
    if (!this._active) return { active: false };
    return { active: true, mode: this._mode, url: this._url, expiresAt: this._expiresAt, clients: this._clients };
  }

  isActive() { return this._active; }

  emit(event) {
    if (!this._ws || !this._active) return;
    const data = typeof event === "string" ? event : JSON.stringify(event);
    // Send as masked WS frame (client→server must be masked)
    const payload = Buffer.from(data, "utf-8");
    const mask = Buffer.from(Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)));
    let header;
    if (payload.length < 126) { header = Buffer.alloc(2); header[0] = 0x81; header[1] = 0x80 | payload.length; }
    else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
    const masked = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    try { this._ws.write(Buffer.concat([header, mask, masked])); } catch { /* ws dead */ }
  }

  // ── Permission Tiers ──────────────────────────────────────────
  canSendPrompt() { return this._mode !== "view"; }

  canExecuteTool(toolName, isReadOnly = false) {
    if (this._mode === "view") return false;
    if (this._mode === "chat") return isReadOnly;
    return true; // control and privileged can execute
  }

  needsApproval(toolName) {
    if (this._mode === "control") {
      return REMOTE_BROWSER_MUTATING.has(toolName) || REMOTE_DESKTOP_WRITE.has(toolName);
    }
    if (this._mode === "privileged") {
      return REMOTE_BROWSER_PRIVILEGED.has(toolName);
    }
    return false;
  }

  setMode(mode) {
    if (!REMOTE_TIERS.includes(mode)) return false;
    const prev = this._mode;
    this._mode = mode;
    this._audit("mode_changed", { from: prev, to: mode });
    this.emit({ type: "mode_changed", mode });
    return true;
  }

  // ── Approval Flow ─────────────────────────────────────────────
  requestApproval(toolName, input) {
    const id = Math.random().toString(36).slice(2, 10);
    this._audit("approval_requested", { id, toolName, mode: this._mode });
    this.emit({ type: "approval_pending", id, toolName });
    return new Promise((resolve, reject) => {
      this._pendingApprovals.set(id, { resolve, reject, toolName, input, requestedAt: Date.now() });
      // Auto-deny after 5 minutes
      setTimeout(() => {
        if (this._pendingApprovals.has(id)) {
          this._pendingApprovals.delete(id);
          this._audit("approval_resolved", { id, approved: false, reason: "timeout" });
          this.emit({ type: "approval_resolved", id, approved: false, reason: "Approval timed out" });
          resolve(false);
        }
      }, 300000);
    });
  }

  resolveApproval(id, approved, reason = "") {
    const pending = this._pendingApprovals.get(id);
    if (!pending) return false;
    this._pendingApprovals.delete(id);
    this._audit("approval_resolved", { id, approved, reason });
    this.emit({ type: "approval_resolved", id, approved, reason });
    pending.resolve(approved);
    return true;
  }

  getPendingApprovals() {
    return Array.from(this._pendingApprovals.entries()).map(([id, p]) => ({ id, toolName: p.toolName, requestedAt: p.requestedAt }));
  }

  // ── Audit Log ─────────────────────────────────────────────────
  _audit(event, details = {}) {
    this._auditLog.push({ ts: new Date().toISOString(), event, ...details });
    if (this._auditLog.length > 500) this._auditLog = this._auditLog.slice(-500);
  }

  getAuditLog(count = 20) {
    return this._auditLog.slice(-count);
  }

  _connectRelay() {
    return new Promise((resolve, reject) => {
      const wsUrl = this._relayUrl.replace(/^http/, "ws") + "/ws/remote/" + this._token;
      const parsed = new URL(wsUrl);
      const mod = parsed.protocol === "wss:" ? _https : _http;
      const key = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString("base64");
      const req = mod.request({ hostname: parsed.hostname, port: parsed.port || (parsed.protocol === "wss:" ? 443 : 80), path: parsed.pathname, headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13", "X-Remote-Role": "host" } });
      req.on("upgrade", (res, socket) => {
        this._ws = socket;
        let buf = Buffer.alloc(0);
        socket.on("data", (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 2) {
            const opcode = buf[0] & 0x0f;
            const pLen = buf[1] & 0x7f; let off = 2, len = pLen;
            if (pLen === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
            else if (pLen === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
            if (buf.length < off + len) break;
            const payload = buf.slice(off, off + len); buf = buf.slice(off + len);
            if (opcode === 0x9) { // ping → respond with masked pong
              const pongMask = Buffer.from([0,0,0,0]);
              const pong = Buffer.alloc(6); pong[0] = 0x8a; pong[1] = 0x80;
              pong.set(pongMask, 2);
              try { socket.write(pong); } catch { /* socket dead */ }
              continue;
            }
            if (opcode === 0xa || opcode === 0x8) continue; // pong or close
            try {
              const msg = JSON.parse(payload.toString("utf-8"));
              if (msg.type === "remote_status") { this._clients = msg.clients; }
              else if (this._onRemoteMessage) { this._onRemoteMessage(msg); }
            } catch { /* non-JSON */ }
          }
        });
        socket.on("close", () => {
          this._ws = null;
          this._audit("host_disconnected");
          // Grace period: try to reconnect instead of deactivating immediately
          if (this._active && this._token) {
            this._reconnectAttempts = 0;
            this._tryReconnect();
          }
        });
        socket.on("error", () => { this._ws = null; });
        resolve();
      });
      req.on("error", reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error("WS relay timeout")); });
      req.end();
    });
  }

  _tryReconnect() {
    if (!this._token || !this._active) return;
    if (this._reconnectAttempts >= 6) { // ~5 min with backoff
      this._active = false;
      this._audit("host_disconnected_permanent");
      return;
    }
    const delay = Math.min(5000 * Math.pow(1.5, this._reconnectAttempts), 60000);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectAttempts++;
      try {
        await this._connectRelay();
        this._reconnectAttempts = 0;
        this._audit("host_reconnected");
        this.emit({ type: "host_reconnected" });
      } catch {
        this._tryReconnect();
      }
    }, delay);
  }

  _onRemoteMessage = null; // set by InteractiveMode
}

let _remoteManager = null;
function _getRemoteManager() { if (!_remoteManager) _remoteManager = new RemoteSessionManager(); return _remoteManager; }

class InteractiveMode {
  constructor(cfg, registry, client, mcpManager, permissions = null) {
    this.cfg = cfg;
    this.registry = registry;
    this.client = client;
    this.mcpManager = mcpManager;
    this.permissions = permissions;
    this.sessions = new SessionManager(this.cfg.cwd);
    this.sessionId = null;
    this.messages = [];
    this.totalCost = 0;
    this.slashCommands = new SlashCommandRegistry();
    this._rl = null;
    this._statuslineScript = null;
    this._exchangeBuffer = [];  // ring buffer of last 5 exchanges for auto-memory context
    this._lastUsage = null;     // last API call usage (for /context)
    this._sessionMetrics = null; // cumulative session metrics (written to disk on exit)
    this._toolCallsSinceSkillReview = 0;
    this._turnsSinceMemoryReview = 0;
    this._nudgeEnabled = true;
    this._skillNudgeInterval = this.cfg._skillNudgeInterval || DEFAULT_SKILL_NUDGE_INTERVAL;
    this._memoryNudgeInterval = this.cfg._memoryNudgeInterval || DEFAULT_MEMORY_NUDGE_INTERVAL;
  }

  // ── Background Review Nudge ──────────────────────────────────
  async _spawnBackgroundReview(type) {
    if (!this._nudgeEnabled || this.cfg._isSubAgent) return;
    let prompt = type === "skill" ? _SKILL_REVIEW_PROMPT
      : type === "memory" ? _MEMORY_REVIEW_PROMPT
      : _COMBINED_REVIEW_PROMPT;

    // Inject skill metrics reinforcement
    if (type === "skill" || type === "combined") {
      try {
        const events = readSkillMetrics(this.cfg.cwd);
        const summary = summarizeSkillMetrics(events);
        const metricsStr = summary.map(s =>
          `${s.skill}: ${s.uses} uses, error rate ${s.uses ? ((s.errors / s.uses) * 100).toFixed(0) : 0}%`
        ).join(", ");
        prompt = prompt.replace("{METRICS}", metricsStr || "(none)");
        const skillList = this.cfg._skillLoader?.list() || [];
        prompt = prompt.replace("{SKILLS}", skillList.map(s => s.name).join(", ") || "(none)");
      } catch { prompt = prompt.replace("{METRICS}", "(unavailable)").replace("{SKILLS}", "(unavailable)"); }
    }

    const messagesSnapshot = [...this.messages].slice(-10);
    try {
      await this.registry.execute("Agent", {
        prompt, subagent_type: "general-purpose",
        description: `Background ${type} review`,
        run_in_background: true,
        _isSubAgent: true,
        conversationContext: messagesSnapshot,
      });
    } catch (e) { log(`[nudge] Error: ${e.message}`); }
  }

  // ── Command Registration ─────────────────────────────────────
  _initSlashCommands() {
    const self = this;
    const s = this.slashCommands;

    // Session
    s.register({ name: "exit", aliases: ["quit", "q"], description: "Exit the REPL", immediate: true, handler: () => "exit" });
    s.register({ name: "clear", aliases: ["reset", "new"], description: "Clear conversation history", immediate: true,
      handler: () => { self.messages = []; self.sessionId = self.sessions.create(); process.stderr.write(`\x1b[2mNew session: ${self.sessionId}\x1b[0m\n`); } });
    s.register({ name: "session", description: "Show session info", immediate: true,
      handler: () => { process.stderr.write(`\x1b[2mSession: ${self.sessionId} (${self.messages.length} messages)\x1b[0m\n`); } });
    s.register({ name: "sessions", description: "List recent sessions or resume one", argumentHint: "[id]",
      handler: async (args) => {
        if (args[0]) {
          // Resume specific session by ID or prefix
          const id = args[0];
          const sessions = self.sessions.listAll();
          const match = sessions.find((s) => s.id === id || s.id.startsWith(id));
          if (!match) { process.stderr.write(`\x1b[31mSession not found: ${id}\x1b[0m\n`); return; }
          self.messages = self.sessions.load(match.id);
          self.sessionId = match.id;
          process.stderr.write(`\x1b[2mResumed session ${match.id.slice(0,8)} (${self.messages.length} messages): ${match.title}\x1b[0m\n`);
          return;
        }
        // List sessions
        const sessions = self.sessions.listAll();
        if (sessions.length === 0) { process.stderr.write(`\x1b[2mNo sessions yet.\x1b[0m\n`); return; }
        process.stderr.write(`\x1b[1m  Recent Sessions\x1b[0m\n`);
        const shown = sessions.slice(0, 10);
        for (const s of shown) {
          const ago = Date.now() - s.mtime;
          const agoStr = ago < 60000 ? "just now" : ago < 3600000 ? `${Math.floor(ago/60000)}m ago` : ago < 86400000 ? `${Math.floor(ago/3600000)}h ago` : `${Math.floor(ago/86400000)}d ago`;
          const active = s.id === self.sessionId ? " \x1b[32m●\x1b[0m" : "";
          process.stderr.write(`  \x1b[2m${s.id.slice(0,8)}\x1b[0m  ${s.title.substring(0, 60)}  \x1b[2m${s.msgCount}msg ${agoStr}\x1b[0m${active}\n`);
        }
        if (sessions.length > 10) process.stderr.write(`\x1b[2m  ... and ${sessions.length - 10} more\x1b[0m\n`);
        process.stderr.write(`\n\x1b[2m  /sessions <id> to resume. --resume to auto-resume latest.\x1b[0m\n`);
      } });
    s.register({ name: "cost", description: "Show total cost estimate", immediate: true,
      handler: () => { process.stderr.write(`\x1b[2mTotal cost: ~$${self.totalCost.toFixed(4)}\x1b[0m\n`); } });

    // Model / Provider
    s.register({ name: "model", argumentHint: "[name]", description: "Switch model or show current",
      handler: (args) => { self._handleModel(args); } });
    s.register({ name: "login", description: "Login to Anthropic (OAuth)", isHidden: true,
      handler: async () => { await oauthLogin(); try { const { authToken, subscriptionType } = await getOAuthAccessToken(false); self.cfg.authToken = authToken; self.client = new AnthropicClient({ apiKey: self.cfg.apiKey, authToken: self.cfg.authToken, apiUrl: self.cfg.apiUrl }); process.stderr.write(`\x1b[2mSwitched to ${subscriptionType} subscription\x1b[0m\n`); } catch { /* ignore: token refresh may fail silently */ } } });
    s.register({ name: "logout", description: "Remove Anthropic credentials", isHidden: true, handler: () => { oauthLogout(); } });
    s.register({ name: "openai-login", description: "Login to OpenAI (OAuth)", isHidden: true,
      handler: async () => { try { const t = await openaiOAuthLogin(); self.cfg.openaiApiKey = t; process.stderr.write(`\x1b[2mOpenAI auth ready. Use /model codex to switch.\x1b[0m\n`); } catch (e) { process.stderr.write(`\x1b[31mOpenAI login failed: ${e.message}\x1b[0m\n`); } } });
    s.register({ name: "openai-logout", description: "Remove OpenAI credentials", isHidden: true, handler: () => { openaiOAuthLogout(); } });

    // Modes
    s.register({ name: "thinking", argumentHint: "[budget]", description: "Toggle extended thinking", immediate: true,
      handler: (args) => { const b = parseInt(args[0], 10); self.cfg.thinkingBudget = b || (self.cfg.thinkingBudget ? 0 : 10000); process.stderr.write(`\x1b[2mThinking: ${self.cfg.thinkingBudget ? `enabled (${self.cfg.thinkingBudget} tokens)` : "disabled"}\x1b[0m\n`); } });
    s.register({ name: "brief", description: "Toggle brief mode", immediate: true,
      handler: () => { self.cfg.briefMode = !self.cfg.briefMode; self.messages.push({ role: "user", content: self.cfg.briefMode ? "<system-reminder>Brief mode enabled. Use SendUserMessage for all direct replies and TaskOutput for async/proactive task updates.</system-reminder>" : "<system-reminder>Brief mode disabled. Plain text replies are allowed, but SendUserMessage and TaskOutput remain available.</system-reminder>" }); registerToolSearch(self.registry); process.stderr.write(`\x1b[2mBrief mode: ${self.cfg.briefMode ? "enabled" : "disabled"}\x1b[0m\n`); } });
    s.register({ name: "permission", aliases: ["permissions", "mode"], argumentHint: "[mode]", description: "Get/set permission mode", immediate: true,
      handler: (args) => { if (args[0]) { self.permissions?.setMode(args[0]); process.stderr.write(`\x1b[2mPermission mode: ${args[0]}\x1b[0m\n`); } else { process.stderr.write(`\x1b[2mPermission mode: ${self.permissions?.mode || "default"}\x1b[0m\n`); process.stderr.write(`\x1b[2mModes: default, plan, acceptEdits, bypassPermissions, dontAsk\x1b[0m\n`); } } });

    // Memory / Checkpoints
    s.register({ name: "memory", aliases: ["mem"], description: "Show user/project memory indexes", immediate: true,
      handler: (args) => {
        const scope = args[0] || "all";
        const projectDir = ensureMemoryDir(self.cfg.cwd);
        const userDir = path.join(os.homedir(), ".claude-native", "user-memory");
        const projectIdx = loadMemoryIndex(self.cfg.cwd, "project");
        const userIdx = loadMemoryIndex(self.cfg.cwd, "user");
        if (scope === "user" || scope === "all") {
          process.stderr.write(`\x1b[2mUser memory: ${userDir}\x1b[0m\n`);
          if (userIdx) {
            process.stderr.write(`\x1b[2m${userIdx.split("\n").length} lines in user MEMORY.md:\x1b[0m\n`);
            process.stderr.write(`\x1b[2m${userIdx.substring(0, 500)}\x1b[0m\n`);
          } else {
            process.stderr.write(`\x1b[2mNo user memories yet.\x1b[0m\n`);
          }
        }
        if (scope === "all") process.stderr.write("\n");
        if (scope === "project" || scope === "all") {
          process.stderr.write(`\x1b[2mProject memory: ${projectDir}\x1b[0m\n`);
          if (projectIdx) {
            process.stderr.write(`\x1b[2m${projectIdx.split("\n").length} lines in project MEMORY.md:\x1b[0m\n`);
            process.stderr.write(`\x1b[2m${projectIdx.substring(0, 500)}\x1b[0m\n`);
          } else {
            process.stderr.write(`\x1b[2mNo project memories yet.\x1b[0m\n`);
          }
        }
      } });
    s.register({ name: "checkpoints", aliases: ["ckpt"], description: "List file checkpoints", immediate: true,
      handler: () => { if (!self.checkpoints) { process.stderr.write("\x1b[2mCheckpointing not enabled.\x1b[0m\n"); return; } const snaps = self.checkpoints.getSnapshots(); if (snaps.length === 0) { process.stderr.write("\x1b[2mNo checkpoints yet.\x1b[0m\n"); return; } for (const sn of snaps) { const ago = Math.floor((Date.now() - new Date(sn.timestamp).getTime()) / 1000); const agoStr = ago < 60 ? `${ago}s ago` : ago < 3600 ? `${Math.floor(ago/60)}m ago` : `${Math.floor(ago/3600)}h ago`; process.stderr.write(`\x1b[2m  [${sn.messageId.slice(0,8)}] ${sn.fileCount} files | ${agoStr}\x1b[0m\n`); } } });
    s.register({ name: "rewind", argumentHint: "[id]", description: "Rewind to a checkpoint",
      handler: async (args) => { await self._handleRewind(args); } });

    // UI
    s.register({ name: "help", argumentHint: "[filter]", description: "Show command palette", immediate: true,
      handler: (args) => { self._renderHelp(args.join(" ")); } });
    s.register({ name: "status", description: "Show status line", immediate: true,
      handler: () => { self._renderStatusLine(); } });
    s.register({ name: "statusline", argumentHint: "[path|off]", description: "Configure status line script", immediate: true,
      handler: (args) => { self._handleStatuslineConfig(args); } });

    // Webhooks
    s.register({ name: "webhook", argumentHint: "<event> <url> | list | remove <event>", description: "Add a webhook to a hook event (Slack, Discord, or any URL)",
      handler: (args) => {
        if (!args[0] || args[0] === "list") {
          // List current webhooks
          const config = self.cfg._hooksConfig || {};
          let found = false;
          for (const [event, groups] of Object.entries(config)) {
            for (const group of groups) {
              for (const hook of group.hooks || []) {
                if (hook.type === "webhook") {
                  process.stderr.write(`  \x1b[36m${event}\x1b[0m → ${hook.url}\n`);
                  found = true;
                }
              }
            }
          }
          if (!found) process.stderr.write(`\x1b[2mNo webhooks configured. Usage: /webhook <event> <url>\x1b[0m\n`);
          process.stderr.write(`\x1b[2mEvents: SessionStart, SessionEnd, Stop, UserPromptSubmit, SubagentStart, SubagentStop, PreCompact, PostCompact, Notification, PreToolUse, PostToolUse\x1b[0m\n`);
          return;
        }

        if (args[0] === "remove") {
          const event = args[1];
          if (!event) { process.stderr.write(`\x1b[2mUsage: /webhook remove <event>\x1b[0m\n`); return; }
          const config = self.cfg._hooksConfig || {};
          if (config[event]) {
            for (const group of config[event]) {
              group.hooks = (group.hooks || []).filter(h => h.type !== "webhook");
            }
            config[event] = config[event].filter(g => (g.hooks || []).length > 0);
            if (config[event].length === 0) delete config[event];
          }
          process.stderr.write(`\x1b[2mRemoved webhooks for ${event}.\x1b[0m\n`);
          return;
        }

        // Add webhook: /webhook <event> <url>
        const event = args[0];
        const url = args[1];
        if (!url) { process.stderr.write(`\x1b[2mUsage: /webhook <event> <url>\x1b[0m\n`); return; }
        try { new URL(url); } catch { process.stderr.write(`\x1b[31mInvalid URL: ${url}\x1b[0m\n`); return; }

        if (!self.cfg._hooksConfig) self.cfg._hooksConfig = {};
        if (!self.cfg._hooksConfig[event]) self.cfg._hooksConfig[event] = [];
        self.cfg._hooksConfig[event].push({ hooks: [{ type: "webhook", url }] });

        // Rebuild hook runner with updated config
        self.cfg._hookRunner = new HookRunner(self.cfg._hooksConfig);

        const platform = url.includes("hooks.slack.com") ? " (Slack format)"
          : url.includes("discord.com/api/webhooks") ? " (Discord format)" : "";
        process.stderr.write(`\x1b[32mWebhook added:\x1b[0m ${event} → ${url}${platform}\n`);
      } });

    // Plan mode
    s.register({ name: "plan", argumentHint: "[open|description]", description: "Enable plan mode or view current plan",
      handler: (args) => {
        if (!self.cfg._planMode) {
          // Not in plan mode → enable it
          self.cfg._planMode = true;
          self.permissions?.setMode("plan");
          self.messages.push({ role: "user", content: "<system-reminder>Plan mode enabled. Use read-only tools to research, then produce a plan. Call ExitPlanMode when done.</system-reminder>" });
          process.stderr.write(`\x1b[2mPlan mode enabled. Read-only tools only. Type /plan to view plan, /plan open to edit.\x1b[0m\n`);
          if (args.length > 0 && args[0] !== "open") {
            // Description provided — pass it as context
            const desc = args.join(" ");
            process.stderr.write(`\x1b[2mPlan focus: ${desc}\x1b[0m\n`);
          }
        } else {
          // Already in plan mode → show plan or open in editor
          if (args[0] === "open") {
            // Find plan file and open in $EDITOR
            const planFiles = [];
            try {
              const planDir = path.join(os.homedir(), ".claude", "plans");
              if (fs.existsSync(planDir)) {
                for (const f of fs.readdirSync(planDir)) {
                  if (f.endsWith(".md")) planFiles.push(path.join(planDir, f));
                }
              }
            } catch { /* ignore: plans directory may not exist */ }
            if (planFiles.length > 0) {
              const latest = planFiles.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
              const editor = process.env.EDITOR || process.env.VISUAL || "vi";
              process.stderr.write(`\x1b[2mOpening ${latest} in ${editor}...\x1b[0m\n`);
              try { execSync(`${editor} "${latest}"`, { stdio: "inherit" }); } catch { /* ignore: editor may exit with error */ }
            } else {
              process.stderr.write(`\x1b[2mNo plan files found.\x1b[0m\n`);
            }
          } else {
            // Show current plan
            const planDir = path.join(os.homedir(), ".claude", "plans");
            let shown = false;
            try {
              if (fs.existsSync(planDir)) {
                const files = fs.readdirSync(planDir).filter(f => f.endsWith(".md")).sort((a, b) =>
                  fs.statSync(path.join(planDir, b)).mtimeMs - fs.statSync(path.join(planDir, a)).mtimeMs
                );
                if (files.length > 0) {
                  const content = fs.readFileSync(path.join(planDir, files[0]), "utf-8");
                  process.stderr.write(`\x1b[1mCurrent plan:\x1b[0m \x1b[2m${path.join(planDir, files[0])}\x1b[0m\n`);
                  process.stderr.write(`${content.substring(0, 2000)}\n`);
                  if (content.length > 2000) process.stderr.write(`\x1b[2m... (${content.length - 2000} more chars, /plan open to see full)\x1b[0m\n`);
                  shown = true;
                }
              }
            } catch { /* ignore: plans directory may not exist */ }
            if (!shown) process.stderr.write(`\x1b[2mNo plan yet. The model will create one in plan mode.\x1b[0m\n`);
            process.stderr.write(`\x1b[2mUse /plan open to edit in $EDITOR.\x1b[0m\n`);
          }
        }
      } });

    // Agents
    s.register({ name: "agents", argumentHint: "[kill <id>]", description: "Show running/recent agents, or kill a background agent",
      handler: (args) => {
        // /agents kill <id>
        if (args[0] === "kill" && args[1]) {
          const id = args[1];
          // Try full ID or prefix match
          const agents = _backgroundManager.list();
          const match = agents.find(a => a.agentId === id || a.agentId.startsWith(id));
          if (!match) { process.stderr.write(`\x1b[31mAgent not found: ${id}\x1b[0m\n`); return; }
          _backgroundManager.stop(match.agentId);
          process.stderr.write(`\x1b[33mCancelled agent ${match.agentId.slice(0,8)} (${match.description || match.status})\x1b[0m\n`);
          return;
        }

        // Show running + recent agents
        const agents = _backgroundManager.list();
        if (agents.length > 0) {
          process.stderr.write(`\x1b[1m  Agents\x1b[0m\n`);
          for (const a of agents) {
            const elapsed = a.elapsedMs < 60000 ? `${Math.floor(a.elapsedMs / 1000)}s` : `${Math.floor(a.elapsedMs / 60000)}m`;
            const icon = a.status === "running" ? "\x1b[33m●\x1b[0m"
              : a.status === "completed" ? "\x1b[32m✓\x1b[0m"
              : a.status === "cancelled" ? "\x1b[31m✗\x1b[0m"
              : a.status === "failed" ? "\x1b[31m!\x1b[0m" : "\x1b[2m○\x1b[0m";
            process.stderr.write(`  ${icon} \x1b[2m${a.agentId.slice(0,8)}\x1b[0m  ${a.description || "agent"}  \x1b[2m${a.status} ${elapsed}\x1b[0m\n`);
          }
          const running = agents.filter(a => a.status === "running").length;
          if (running > 0) process.stderr.write(`\n\x1b[2m  ${running} running. Use /agents kill <id> to cancel.\x1b[0m\n`);
          process.stderr.write("\n");
        } else {
          process.stderr.write(`\x1b[2mNo agents running or recent.\x1b[0m\n\n`);
        }

        // Show available types
        process.stderr.write(`\x1b[1m  Agent Types\x1b[0m\n`);
        const agentTypes = [
          { name: "general-purpose", desc: "Full tool access. Complex multi-step tasks.", model: "inherits" },
          { name: "Explore", desc: "Read-only codebase exploration. Fast.", model: "haiku" },
          { name: "Plan", desc: "Architecture and implementation planning. Read-only.", model: "inherits" },
          { name: "claude-code-guide", desc: "Claude Code/API docs. Read-only.", model: "haiku" },
          { name: "verification", desc: "Adversarial testing. Cannot modify project files.", model: "inherits" },
          { name: "orchestrator", desc: "Smart task router. Decomposes, routes, runs in parallel.", model: "inherits" },
        ];
        const maxName = Math.max(...agentTypes.map(a => a.name.length));
        for (const a of agentTypes) {
          const pad = " ".repeat(maxName + 2 - a.name.length);
          process.stderr.write(`  \x1b[36m${a.name}\x1b[0m${pad}${a.desc}  \x1b[2m(${a.model})\x1b[0m\n`);
        }
        // Custom agents from disk
        const customAgents = self.cfg._agentLoader?.list() || [];
        if (customAgents.length > 0) {
          process.stderr.write(`\n\x1b[1m  Custom Agents\x1b[0m \x1b[35m[disk]\x1b[0m\n`);
          for (const a of customAgents) {
            const modelHint = a.model ? ` (${a.model})` : "";
            process.stderr.write(`  \x1b[35m${a.name}\x1b[0m  ${a.description}${modelHint}  \x1b[2m[${a.source}]\x1b[0m\n`);
          }
        }

        process.stderr.write(`\n\x1b[2m  Ask Claude to launch agents: "Use an Explore agent to find all API endpoints"\x1b[0m\n\n`);
      } });

    // Agent create — interactive agent builder (uses interactiveForm)
    s.register({ name: "agent-create", argumentHint: "[name]", description: "Create a custom agent interactively",
      handler: async (args) => {
        // Step 1: Name
        let name = args[0] || "";
        if (!name) {
          const nameForm = await interactiveForm([
            { name: "name", label: "Agent name (kebab-case)", type: "text" },
          ], { title: "Create Custom Agent" });
          if (!nameForm) { process.stderr.write(`\x1b[2mCancelled.\x1b[0m\n`); return; }
          name = nameForm.name;
        }
        if (!name) { process.stderr.write(`\x1b[2mCancelled.\x1b[0m\n`); return; }
        name = name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

        const projectDir = path.join(self.cfg.cwd, ".claude", "agents", name);
        const personalDir = path.join(os.homedir(), ".claude", "agents", name);

        // Step 2: Collect all fields via form
        const form = await interactiveForm([
          { name: "scope", label: "Scope", type: "choice", default: "project",
            options: [{ label: "project", description: "Visible in this project only" }, { label: "personal", description: "Visible in all projects" }] },
          { name: "description", label: "Description (1 line)", type: "text" },
          { name: "model", label: "Model (haiku/sonnet/opus/gpt-5/gpt-4o/ollama/... or empty to inherit)", type: "text", default: "", required: false },
          { name: "provider", label: "Provider (anthropic/openai/ollama/lmstudio/vllm/... or empty to auto-detect)", type: "text", default: "", required: false },
          { name: "readOnly", label: "Read-only agent?", type: "confirm", default: false },
          { name: "disallowedTools", label: "Disallowed tools (comma-separated, or empty)", type: "text", default: "", required: false },
          { name: "workload", label: "Workload category", type: "choice", default: "",
            options: [
              { label: "exploration", description: "Search, grep, fast scan" },
              { label: "planning", description: "Architecture, design, tradeoffs" },
              { label: "implementation", description: "Code writing, tool-heavy" },
              { label: "verification", description: "Testing, adversarial, review" },
              { label: "documentation", description: "Docs, summaries, retrieval" },
              { label: "reasoning", description: "Complex logic, deep analysis" },
            ] },
        ]);
        if (!form) { process.stderr.write(`\x1b[2mCancelled.\x1b[0m\n`); return; }

        const scope = form.scope || "project";
        const targetDir = scope === "personal" ? personalDir : projectDir;

        // Warn on override
        if (fs.existsSync(path.join(targetDir, "AGENT.md"))) {
          const overwrite = await interactiveForm([
            { name: "confirm", label: `Agent "${name}" exists in ${scope} scope. Overwrite?`, type: "confirm", default: false },
          ]);
          if (!overwrite?.confirm) { process.stderr.write(`\x1b[2mCancelled.\x1b[0m\n`); return; }
        } else if (scope === "project" && fs.existsSync(path.join(personalDir, "AGENT.md"))) {
          process.stderr.write(`\x1b[2mNote: "${name}" exists in personal scope. Project version will take priority.\x1b[0m\n`);
        }

        // Step 3: System prompt (multi-line)
        const systemPrompt = await interactiveMultiline("System prompt (what this agent does)") || `You are ${name}. ${form.description}`;

        // Build AGENT.md
        const frontmatter = [`---`, `name: ${name}`, `description: ${form.description}`];
        if (form.model) frontmatter.push(`model: ${form.model}`);
        if (form.provider) frontmatter.push(`provider: ${form.provider}`);
        if (form.readOnly) frontmatter.push(`read_only: true`);
        if (form.disallowedTools) frontmatter.push(`disallowed_tools: ${form.disallowedTools}`);
        if (form.workload) frontmatter.push(`workload: ${form.workload}`);
        frontmatter.push(`---`);

        const content = frontmatter.join("\n") + "\n\n" + systemPrompt + "\n";

        // Write
        fs.mkdirSync(targetDir, { recursive: true });
        const filePath = path.join(targetDir, "AGENT.md");
        fs.writeFileSync(filePath, content);

        // Reload agents
        self.cfg._agentLoader = new AgentLoader().scan(self.cfg.cwd);

        process.stderr.write(`\n\x1b[32mAgent created:\x1b[0m ${filePath}\n`);
        process.stderr.write(`\x1b[2mUse it: "Use the ${name} agent to ..."\x1b[0m\n`);
        process.stderr.write(`\x1b[2mOr: Agent({ subagent_type: "${name}", prompt: "..." })\x1b[0m\n\n`);
      } });

    // Orchestrate (convenience)
    s.register({ name: "orchestrate", argumentHint: "<task>", description: "Route a complex task through the smart orchestrator",
      handler: async (args) => {
        const task = args.join(" ");
        if (!task) { process.stderr.write(`\x1b[2mUsage: /orchestrate <task description>\x1b[0m\n`); return; }
        process.stderr.write(`\x1b[2mLaunching orchestrator...\x1b[0m\n`);
        await self._processInput(`Use the orchestrator agent to handle this task: ${task}`);
      } });

    // Diff
    s.register({ name: "diff", description: "View uncommitted git changes", immediate: true,
      handler: () => {
        try {
          const status = execSync("git status --short 2>/dev/null", { cwd: self.cfg.cwd, encoding: "utf-8", timeout: 5000 }).trim();
          if (!status) { process.stderr.write(`\x1b[2mNo uncommitted changes.\x1b[0m\n`); return; }
          process.stderr.write(`\x1b[1m  Uncommitted changes\x1b[0m\n`);
          for (const line of status.split("\n")) {
            const code = line.slice(0, 2);
            const file = line.slice(3);
            const color = code.includes("M") ? "33" : code.includes("A") || code.includes("?") ? "32" : code.includes("D") ? "31" : "0";
            process.stderr.write(`  \x1b[${color}m${code}\x1b[0m ${file}\n`);
          }
          // Show diff stats
          const stats = execSync("git diff --stat 2>/dev/null", { cwd: self.cfg.cwd, encoding: "utf-8", timeout: 5000 }).trim();
          if (stats) {
            const lastLine = stats.split("\n").pop();
            process.stderr.write(`\n\x1b[2m  ${lastLine}\x1b[0m\n`);
          }
        } catch {
          process.stderr.write(`\x1b[2mNot in a git repository.\x1b[0m\n`);
        }
      } });

    // Compact
    s.register({ name: "compact", argumentHint: "[instructions]", description: "Compact conversation with summary to free context", aliases: [],
      handler: async (args) => {
        const instructionText = args.join(" ") || "Summarize the conversation so far, preserving key decisions, file paths mentioned, and current task state.";
        const msgCount = self.messages.length;
        if (msgCount < 4) { process.stderr.write(`\x1b[2mConversation too short to compact (${msgCount} messages).\x1b[0m\n`); return; }

        process.stderr.write(`\x1b[2mCompacting ${msgCount} messages...\x1b[0m\n`);

        // Build a summary request
        const summaryMessages = [
          ...self.messages,
          { role: "user", content: `<system-reminder>Summarize this conversation so it can be resumed later. ${instructionText}\n\nInclude: key decisions made, file paths mentioned or modified, current task state, blockers, and any exact literals that may matter later (IDs, markers, commands, errors, filenames, code snippets). If the conversation contains short exact strings, copy them verbatim. Be concise but complete enough to resume work. Output only the summary.</system-reminder>` },
        ];

        try {
          const systemBlocks = buildSystemPrompt(self.cfg);
          const loop = new AgentLoop(self.client, self.registry, self.cfg, {}, self.permissions);
          const result = await loop.run(summaryMessages, systemBlocks);

          // Replace conversation with summary
          self.messages = [
            { role: "user", content: "Previous conversation summary:" },
            { role: "assistant", content: result.text },
          ];
          process.stderr.write(`\x1b[2mCompacted ${msgCount} → 2 messages. Summary:\x1b[0m\n`);
          process.stderr.write(`\x1b[2m${result.text.substring(0, 500)}${result.text.length > 500 ? "..." : ""}\x1b[0m\n`);
        } catch (e) {
          process.stderr.write(`\x1b[31mCompact failed: ${e.message}\x1b[0m\n`);
        }
      } });

    // Context — rich breakdown by category (CC-style)
    s.register({ name: "context", description: "Show context window usage breakdown", immediate: true,
      handler: () => {
        const W = (s) => process.stderr.write(s);
        const provider = self.cfg._provider || detectProvider(self.cfg.model);
        const contextLimit = provider?.capabilities?.contextWindow || 128000;

        // Estimate each category
        const systemBlocks = buildSystemPrompt(self.cfg);
        const systemTokens = Math.ceil(systemBlocks.reduce((s, b) => s + (b.text || "").length, 0) / 3.5);
        const toolDefs = self.registry.getDefinitions();
        const toolTokens = Math.ceil(JSON.stringify(toolDefs).length / 3.5);
        const msgTokens = Math.ceil(self.messages.reduce((s, m) => s + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0) / 3.5);

        // Memory: extract from system prompt
        const memBlock = systemBlocks.find(b => b.text?.includes("# Memory"));
        const memTokens = memBlock ? Math.ceil(memBlock.text.length / 3.5) : 0;

        // Skills
        const skills = self.cfg._skillLoader?.list() || [];
        const skillTokens = Math.ceil(skills.reduce((s, sk) => s + (sk.body?.length || 100), 0) / 3.5);

        const totalEstimated = systemTokens + toolTokens + msgTokens;
        const pct = Math.min(100, Math.round((totalEstimated / contextLimit) * 100));
        const free = contextLimit - totalEstimated;

        // Real usage from API (if available)
        const realIn = self._lastUsage?.input_tokens;
        const realOut = self._lastUsage?.output_tokens;
        const cacheRead = self._lastUsage?.cache_read_input_tokens || 0;
        const cacheCreate = self._lastUsage?.cache_creation_input_tokens || 0;

        W(`\x1b[1m  Context Usage\x1b[0m\n`);
        W(`  ${self.cfg.model} · ~${(totalEstimated/1000).toFixed(1)}k/${(contextLimit/1000).toFixed(0)}k tokens (${pct}%)\n\n`);
        W(`  \x1b[2mEstimated by category:\x1b[0m\n`);
        W(`    System prompt: ~${(systemTokens/1000).toFixed(1)}k tokens\n`);
        W(`    Tool definitions: ~${(toolTokens/1000).toFixed(1)}k tokens (${toolDefs.length} tools)\n`);
        W(`    Memory: ~${(memTokens/1000).toFixed(1)}k tokens\n`);
        W(`    Skills: ~${(skillTokens/1000).toFixed(1)}k tokens (${skills.length} skills)\n`);
        W(`    Messages: ~${(msgTokens/1000).toFixed(1)}k tokens (${self.messages.length} messages)\n`);
        W(`    Free: ~${(free/1000).toFixed(0)}k tokens (${100-pct}%)\n`);
        if (realIn) {
          W(`\n  \x1b[2mLast API call:\x1b[0m\n`);
          W(`    Input: ${realIn} | Output: ${realOut}\n`);
          if (cacheRead || cacheCreate) W(`    Cache: ${cacheRead} read, ${cacheCreate} created\n`);
        }
        if (pct > 70) W(`\n  \x1b[33mConsider /compact to free context.\x1b[0m\n`);
      } });

    // Tasks — list background tasks (from TaskList tool)
    s.register({ name: "tasks", aliases: ["bashes"], description: "List tasks and their status", immediate: true,
      handler: async () => {
        const result = await self.registry.execute("TaskList", {});
        if (result.is_error) { process.stderr.write(`\x1b[2mNo tasks yet.\x1b[0m\n`); return; }
        try {
          const tasks = JSON.parse(result.content);
          if (tasks.length === 0) { process.stderr.write(`\x1b[2mNo tasks yet.\x1b[0m\n`); return; }
          process.stderr.write(`\x1b[1m  Tasks\x1b[0m\n`);
          for (const t of tasks) {
            const statusIcon = t.status === "completed" ? "\x1b[32m✓\x1b[0m"
              : t.status === "in_progress" ? "\x1b[33m●\x1b[0m"
              : t.status === "blocked" ? "\x1b[31m✗\x1b[0m"
              : "\x1b[2m○\x1b[0m";
            const pri = t.priority === "high" ? " \x1b[31m!\x1b[0m" : t.priority === "low" ? " \x1b[2m↓\x1b[0m" : "";
            process.stderr.write(`  ${statusIcon} ${t.id} ${t.title}${pri}\n`);
          }
        } catch { process.stderr.write(`\x1b[2mNo tasks yet.\x1b[0m\n`); }
      } });

    // Skills — list available skills
    s.register({ name: "skills", description: "List available skills", immediate: true,
      handler: () => {
        const allSkills = self.cfg._skillLoader?.list() || [];
        if (allSkills.length === 0) { process.stderr.write(`\x1b[2mNo skills installed. Add skills to .claude/skills/\x1b[0m\n`); return; }
        process.stderr.write(`\x1b[1m  Installed Skills\x1b[0m\n`);
        for (const sk of allSkills) {
          process.stderr.write(`  \x1b[35m/${sk.name}\x1b[0m  ${sk.description || ""}\n`);
        }
      } });

    // Copy — copy last response to clipboard
    s.register({ name: "copy", argumentHint: "[n]", description: "Copy last response to clipboard", immediate: true,
      handler: (args) => {
        const n = parseInt(args[0], 10) || 1;
        const assistantMsgs = self.messages.filter(m => m.role === "assistant");
        const target = assistantMsgs[assistantMsgs.length - n];
        if (!target) { process.stderr.write(`\x1b[2mNo response to copy.\x1b[0m\n`); return; }
        const text = typeof target.content === "string" ? target.content
          : Array.isArray(target.content) ? target.content.filter(b => b.type === "text").map(b => b.text).join("") : "";
        try {
          const cmd = process.platform === "darwin" ? "pbcopy" : process.platform === "win32" ? "clip" : "xclip -selection clipboard";
          execSync(cmd, { input: text, timeout: 3000 });
          process.stderr.write(`\x1b[2mCopied ${text.length} chars to clipboard.\x1b[0m\n`);
        } catch {
          process.stderr.write(`\x1b[31mClipboard not available.\x1b[0m\n`);
        }
      } });

    // Init — generate provider-aware convention file
    s.register({ name: "init", description: "Generate or update project convention file for the active provider",
      handler: async () => {
        const providerName = (self.cfg._provider || {}).name || "Anthropic";
        const filename = PROVIDER_CONVENTION_FILES[providerName] || "INIT.md";
        const targetPath = path.join(self.cfg.cwd, filename);

        // Scan project structure
        const structure = _scanProjectStructure(self.cfg.cwd);

        // Read existing file if present
        let existing = "";
        const isUpdate = fs.existsSync(targetPath);
        if (isUpdate) {
          try { existing = fs.readFileSync(targetPath, "utf-8"); } catch { /* unreadable */ }
        }

        let prompt;
        if (isUpdate && existing) {
          prompt = `You are updating a ${filename} project convention file. Below is the EXISTING file and the CURRENT project structure. Produce the COMPLETE updated ${filename} file.\n\nEXISTING ${filename}:\n\`\`\`\n${existing}\n\`\`\`\n\nCURRENT project structure:\n${structure}\n\nInstructions:\n- Output the FULL updated file content — not a diff, not a summary, not a changelog\n- Keep everything from the existing file that is still accurate\n- Add any missing build/test commands, architecture patterns, or constraints you discover\n- Remove anything that no longer matches the project\n- Keep it under 100 lines\n- Output ONLY the raw markdown content. No code fences, no preamble, no explanation.`;
        } else {
          prompt = `Generate a ${filename} project convention file for this repository. Scan the following project structure and create concise, useful instructions for an AI coding agent working in this codebase.\n\nProject structure:\n${structure}\n\nThe file should include:\n- Brief project description\n- Key architecture patterns\n- Testing conventions\n- Build/run commands\n- Any important constraints\n\nKeep it under 100 lines. Output ONLY the markdown content, no code fences.`;
        }

        // Prepend file-generator instruction to the user prompt to avoid summaries/changelogs
        const fullPrompt = `IMPORTANT: Your entire response will be written directly to a file. Output ONLY the raw markdown content of the ${filename} file. No preamble, no summary, no changelog, no code fences, no "Here's what I changed". Start with the first line of the file (e.g. "# Project Name").\n\n${prompt}`;
        const systemBlocks = buildSystemPrompt(self.cfg);
        const messages = [{ role: "user", content: fullPrompt }];
        const initCfg = { ...self.cfg, maxTurns: 1, thinkingBudget: 0 };
        const emptyRegistry = new ToolRegistry();
        const loop = new AgentLoop(self.client, emptyRegistry, initCfg, {
          onText: () => {},
        }, self.permissions);

        process.stderr.write(`\x1b[2m${isUpdate ? "Auditing" : "Generating"} ${filename}...\x1b[0m\n`);
        const result = await loop.run(messages, systemBlocks);

        fs.writeFileSync(targetPath, result.text);
        process.stderr.write(`\x1b[32m${isUpdate ? "Updated" : "Created"} ${targetPath}\x1b[0m\n`);
        process.stderr.write(`\x1b[2mEdit to customize. It will be loaded into context for all future conversations.\x1b[0m\n`);
      } });

    // Review — code + security review of current changes
    s.register({ name: "review", description: "Run code + security review on current changes", argumentHint: "[--staged]",
      handler: async () => {
        // Check git repo
        try {
          execSync("git rev-parse --is-inside-work-tree", { cwd: self.cfg.cwd, stdio: ["pipe", "pipe", "pipe"] });
        } catch {
          process.stderr.write("\x1b[31mNot a git repository.\x1b[0m\n");
          return;
        }

        // Get diffs
        let unstaged = "", staged = "";
        try { unstaged = execSync("git diff", { cwd: self.cfg.cwd, encoding: "utf-8", timeout: 10000 }); } catch { /* no unstaged */ }
        try { staged = execSync("git diff --staged", { cwd: self.cfg.cwd, encoding: "utf-8", timeout: 10000 }); } catch { /* no staged */ }

        if (!unstaged.trim() && !staged.trim()) {
          process.stderr.write("\x1b[2mNo changes to review.\x1b[0m\n");
          return;
        }

        // Build diff with sections
        let diff = "";
        if (unstaged.trim()) diff += `=== Unstaged Changes ===\n${unstaged}\n`;
        if (staged.trim()) diff += `=== Staged Changes ===\n${staged}\n`;

        // Truncate if too large
        const MAX_DIFF = 50000;
        if (diff.length > MAX_DIFF) {
          let fileList = "";
          try { fileList = execSync("git diff --name-only && git diff --staged --name-only", { cwd: self.cfg.cwd, encoding: "utf-8", timeout: 5000 }); } catch { /* ignore */ }
          diff = diff.substring(0, MAX_DIFF) + `\n\n... (diff truncated at ${MAX_DIFF} chars)\n\nAffected files:\n${fileList}`;
        }

        const runner = self.cfg._subAgentRunner;
        if (!runner) {
          process.stderr.write("\x1b[31mAgent runner not available.\x1b[0m\n");
          return;
        }

        process.stderr.write("\x1b[2mReviewing...\x1b[0m\n");
        const reviewPrompt = `Review the following git diff for issues.\n\n${diff}`;

        try {
          const [codeResult, secResult] = await Promise.all([
            runner.run({ prompt: reviewPrompt, subagentType: "code-reviewer", description: "Code review" }),
            runner.run({ prompt: reviewPrompt, subagentType: "security-reviewer", description: "Security review" }),
          ]);

          // Extract verdicts
          const codeVerdict = (codeResult.content.match(/VERDICT:\s*(PASS|WARN|BLOCK)/i) || [])[1] || "PASS";
          const secVerdict = (secResult.content.match(/VERDICT:\s*(PASS|WARN|BLOCK)/i) || [])[1] || "PASS";
          const overall = aggregateVerdicts(codeVerdict, secVerdict);

          // Display
          process.stderr.write(`\n\x1b[1m${"═".repeat(50)}\x1b[0m\n`);
          process.stderr.write(`\x1b[1m  Code Review\x1b[0m\n`);
          process.stderr.write(`\x1b[1m${"─".repeat(50)}\x1b[0m\n`);
          process.stderr.write(`${codeResult.content}\n\n`);

          process.stderr.write(`\x1b[1m${"═".repeat(50)}\x1b[0m\n`);
          process.stderr.write(`\x1b[1m  Security Review\x1b[0m\n`);
          process.stderr.write(`\x1b[1m${"─".repeat(50)}\x1b[0m\n`);
          process.stderr.write(`${secResult.content}\n\n`);

          const vColor = overall === "PASS" ? "32" : overall === "WARN" ? "33" : "31";
          process.stderr.write(`\x1b[1m${"═".repeat(50)}\x1b[0m\n`);
          process.stderr.write(`\x1b[1m  Verdict: \x1b[${vColor}m${overall}\x1b[0m\n`);
          process.stderr.write(`\x1b[1m${"═".repeat(50)}\x1b[0m\n\n`);
        } catch (e) {
          process.stderr.write(`\x1b[31mReview failed: ${e.message}\x1b[0m\n`);
        }
      } });

    // Skill management
    s.register({ name: "skill", description: "Skill management", argumentHint: "<subcommand> [args]",
      handler: async (args) => {
        const sub = args[0];
        if (sub === "import") { const source = args.slice(1).join(" "); if (!source) { process.stderr.write("Usage: /skill import <source>\n"); return; } await skillImport(self.cfg, self.client, self.registry, self.permissions, source); self.cfg._skillLoader = new SkillLoader().scan(self.cfg.cwd); }
        else if (sub === "list") { skillList(self.cfg); }
        else if (sub === "info") { skillInfo(self.cfg, args[1]); }
        else if (sub === "remove") { await skillRemove(self.cfg, args[1]); self.cfg._skillLoader = new SkillLoader().scan(self.cfg.cwd); }
        else if (sub === "update") { await skillUpdate(self.cfg, self.client, self.registry, self.permissions, args[1]); self.cfg._skillLoader = new SkillLoader().scan(self.cfg.cwd); }
        else if (sub === "export") { skillExport(self.cfg, args[1]); }
        else if (sub === "verify") { skillVerify(self.cfg, args[1]); }
        else if (sub === "search") { await skillSearch(self.cfg, args.slice(1).join(" ")); }
        else if (sub === "publish") { await skillPublish(self.cfg, args[1]); }
        else { process.stderr.write("Usage: /skill <subcommand>\n  import, list, info, remove, update, export, verify, search, publish\n"); }
      } });

    // Tool management
    s.register({ name: "tool", description: "Tool management", argumentHint: "<subcommand> [args]",
      handler: async (args) => {
        const sub = args[0];
        if (sub === "list") toolList(self.cfg, self.registry);
        else if (sub === "info") toolInfo(self.cfg, self.registry, args[1]);
        else if (sub === "enable") toolEnable(self.cfg, self.registry, args[1]);
        else if (sub === "disable") toolDisable(self.cfg, self.registry, args[1]);
        else if (sub === "test") await toolTest(self.cfg, self.registry, args[1]);
        else if (sub === "install") { await toolInstall(self.cfg, args.slice(1).join(" ")); scanCustomTools(self.registry, self.cfg); }
        else if (sub === "update") { await toolUpdate(self.cfg, args[1]); scanCustomTools(self.registry, self.cfg); }
        else if (sub === "remove") { toolRemove(self.cfg, args[1]); if (args[1] && self.registry.has(args[1])) self.registry.unregister(args[1]); }
        else if (sub === "catalog") { await toolCatalog(args.slice(1).join(" ") || "*"); }
        else if (sub === "publish") { await toolPublish(self.cfg, args[1]); }
        else process.stderr.write("Usage: /tool <subcommand>\n  list, info, enable, disable, test, install, update, remove, catalog, publish\n");
      } });

    // Catalog shortcut — /catalog [query]
    s.register({ name: "catalog", description: "Browse the tool marketplace", argumentHint: "[query]",
      handler: async (args) => { await toolCatalog(args.join(" ") || "*"); } });

    // Remote session
    s.register({ name: "remote", description: "Remote session access", argumentHint: "[status|stop|renew|mode|approve|deny|log]",
      handler: async (args) => {
        const sub = args[0];
        const mgr = _getRemoteManager();
        if (!sub || sub === "start") {
          if (mgr.isActive()) { const s = await mgr.status(); process.stderr.write(`\n  Remote already active\n  Link: ${s.url}\n  Mode: ${s.mode}\n  Expires: ${s.expiresAt}\n  Clients: ${s.clients}\n\n`); return; }
          try {
            const sessionId = self.sessionManager?.currentSessionId() || "session-" + Date.now();
            const result = await mgr.start(sessionId);
            // Wire remote input to processInput
            mgr._onRemoteMessage = (msg) => {
              if (msg.type === "message" && msg.content) {
                if (!mgr.canSendPrompt()) {
                  mgr._audit("prompt_blocked", { reason: "view mode" });
                  mgr.emit({ type: "permission_denied", reason: "View mode: prompts are read-only" });
                  return;
                }
                mgr._audit("prompt_received", { prompt: msg.content.slice(0, 100) });
                mgr._inputIsRemote = true;
                process.stderr.write(`\n\x1b[36m[remote]\x1b[0m ${msg.content.slice(0, 80)}\n`);
                self._processInput(msg.content).finally(() => { mgr._inputIsRemote = false; });
              } else if (msg.type === "remote_status") {
                mgr._clients = msg.clients;
                mgr._audit(msg.clients > (mgr._prevClients || 0) ? "client_connected" : "client_disconnected", { count: msg.clients });
                mgr._prevClients = msg.clients;
              }
            };
            process.stderr.write(`\n  \x1b[32mRemote session ready\x1b[0m\n  Link:    ${result.url}\n  Mode:    ${mgr._mode}\n  Expires: ${new Date(result.expiresAt).toLocaleTimeString()}\n\n`);
          } catch (e) { process.stderr.write(`\x1b[31mRemote failed:\x1b[0m ${e.message}\n`); }
        } else if (sub === "status") {
          const s = await mgr.status();
          if (!s.active) { process.stderr.write("  No active remote session.\n"); return; }
          process.stderr.write(`\n  Active:  yes\n  Link:    ${s.url}\n  Mode:    ${s.mode}\n  Clients: ${s.clients}\n  Expires: ${s.expiresAt}\n\n`);
        } else if (sub === "stop") {
          await mgr.stop();
          process.stderr.write("  Remote session stopped.\n");
        } else if (sub === "renew") {
          if (!mgr.isActive()) { process.stderr.write("  No active remote session to renew.\n"); return; }
          await mgr.stop();
          const sessionId = self.sessionManager?.currentSessionId() || "session-" + Date.now();
          const result = await mgr.start(sessionId);
          mgr._onRemoteMessage = (msg) => {
              if (msg.type === "message" && msg.content) {
                if (!mgr.canSendPrompt()) {
                  mgr._audit("prompt_blocked", { reason: "view mode" });
                  mgr.emit({ type: "permission_denied", reason: "View mode: prompts are read-only" });
                  return;
                }
                mgr._audit("prompt_received", { prompt: msg.content.slice(0, 100) });
                mgr._inputIsRemote = true;
                process.stderr.write(`\n\x1b[36m[remote]\x1b[0m ${msg.content.slice(0, 80)}\n`);
                self._processInput(msg.content).finally(() => { mgr._inputIsRemote = false; });
              } else if (msg.type === "remote_status") {
                mgr._clients = msg.clients;
                mgr._audit(msg.clients > (mgr._prevClients || 0) ? "client_connected" : "client_disconnected", { count: msg.clients });
                mgr._prevClients = msg.clients;
              }
            };
          process.stderr.write(`\n  \x1b[32mRemote renewed\x1b[0m\n  Link:    ${result.url}\n  Expires: ${new Date(result.expiresAt).toLocaleTimeString()}\n\n`);
        } else if (sub === "mode") {
          if (!mgr.isActive()) { process.stderr.write("  No active remote session.\n"); return; }
          const tier = args[1];
          if (!tier) { process.stderr.write(`  Current mode: ${mgr._mode}\n  Tiers: view, chat, control, privileged\n`); return; }
          if (mgr.setMode(tier)) {
            process.stderr.write(`  Mode changed to: ${tier}\n`);
          } else {
            process.stderr.write(`  Invalid mode. Use: view, chat, control, privileged\n`);
          }
        } else if (sub === "approve") {
          const pending = mgr.getPendingApprovals();
          if (pending.length === 0) { process.stderr.write("  No pending approvals.\n"); return; }
          const id = args[1] || pending[0].id;
          if (mgr.resolveApproval(id, true)) {
            process.stderr.write(`  Approved: ${id}\n`);
          } else {
            process.stderr.write(`  Approval not found: ${id}\n`);
          }
        } else if (sub === "deny") {
          const pending = mgr.getPendingApprovals();
          if (pending.length === 0) { process.stderr.write("  No pending approvals.\n"); return; }
          const id = args[1] || pending[0].id;
          const reason = args.slice(2).join(" ") || "denied by host";
          if (mgr.resolveApproval(id, false, reason)) {
            process.stderr.write(`  Denied: ${id}\n`);
          } else {
            process.stderr.write(`  Approval not found: ${id}\n`);
          }
        } else if (sub === "log") {
          if (!mgr.isActive()) { process.stderr.write("  No active remote session.\n"); return; }
          const count = parseInt(args[1], 10) || 20;
          const events = mgr.getAuditLog(count);
          if (events.length === 0) { process.stderr.write("  No audit events.\n"); return; }
          process.stderr.write(`\n  \x1b[1mAudit Log (last ${events.length})\x1b[0m\n`);
          for (const e of events) {
            const ts = e.ts.slice(11, 19);
            const details = Object.entries(e).filter(([k]) => k !== "ts" && k !== "event").map(([k, v]) => `${k}=${v}`).join(" ");
            process.stderr.write(`  \x1b[2m${ts}\x1b[0m ${e.event} ${details}\n`);
          }
          process.stderr.write("\n");
        } else { process.stderr.write("Usage: /remote [status|stop|renew|mode|approve|deny|log]\n"); }
      } });

    // Doctor — basic installation health check
    s.register({ name: "doctor", description: "Diagnose installation and connectivity", immediate: true,
      handler: async () => {
        process.stderr.write(`\x1b[1m  Diagnostics\x1b[0m\n`);
        // Node version
        process.stderr.write(`  \x1b[32m✓\x1b[0m Node ${process.version}\n`);
        // Auth
        const hasAuth = !!(self.cfg.apiKey || self.cfg.authToken);
        process.stderr.write(`  ${hasAuth ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} Anthropic auth ${hasAuth ? "configured" : "missing"}\n`);
        const hasOAI = !!self.cfg.openaiApiKey;
        process.stderr.write(`  ${hasOAI ? "\x1b[32m✓\x1b[0m" : "\x1b[2m○\x1b[0m"} OpenAI auth ${hasOAI ? "configured" : "not set"}\n`);
        // Git
        let hasGit = false;
        try { execSync("git --version", { encoding: "utf-8", timeout: 2000 }); hasGit = true; } catch { /* ignore: git may not be installed */ }
        process.stderr.write(`  ${hasGit ? "\x1b[32m✓\x1b[0m" : "\x1b[33m!\x1b[0m"} Git ${hasGit ? "available" : "not found"}\n`);
        // Tools
        const toolCount = self.registry.getAllDefinitions().length;
        const deferredCount = self.registry.getDeferredNames().length;
        process.stderr.write(`  \x1b[32m✓\x1b[0m ${toolCount} tools registered (${deferredCount} deferred)\n`);
        // MCP
        const mcpCount = self.registry.getAllDefinitions().filter(t => t.name.startsWith("mcp__")).length;
        process.stderr.write(`  ${mcpCount > 0 ? "\x1b[32m✓\x1b[0m" : "\x1b[2m○\x1b[0m"} ${mcpCount} MCP tools\n`);
        // Skills
        const skillCount = self.cfg._skillLoader?.list().length || 0;
        process.stderr.write(`  ${skillCount > 0 ? "\x1b[32m✓\x1b[0m" : "\x1b[2m○\x1b[0m"} ${skillCount} skills\n`);
        // Model
        const provider = (self.cfg._provider || detectProvider(self.cfg.model))?.name || "?";
        process.stderr.write(`  \x1b[32m✓\x1b[0m Model: ${self.cfg.model} (${provider})\n`);
      } });

    // Skills (dynamic)
    const skills = this.cfg._skillLoader?.list() || [];
    for (const skill of skills) {
      s.register({ name: skill.name, description: skill.description || `Skill: ${skill.name}`, argumentHint: "[args]", source: "skill", handler: null });
    }
  }

  _promptLabel() {
    const m = this.cfg.model;
    let short = m;
    if (m.startsWith("claude-")) short = m.replace(/^claude-/, "").replace(/-\d.*$/, "");
    else if (m.includes("-codex")) short = "codex";
    return `\x1b[36m${short}>\x1b[0m `;
  }

  // ── Status Line ──────────────────────────────────────────────
  _renderStatusLine() {
    const provider = (this.cfg._provider || detectProvider(this.cfg.model))?.name || "?";
    const model = this.cfg.model;
    const modes = [];
    if (this.cfg.briefMode) modes.push("brief");
    if (this.cfg.thinkingBudget > 0) modes.push(`think:${this.cfg.thinkingBudget}`);
    if (this.cfg._planMode) modes.push("plan");
    const modeStr = modes.length > 0 ? modes.join(",") : "";

    let gitBranch = "";
    try { gitBranch = execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", { cwd: this.cfg.cwd, encoding: "utf-8", timeout: 2000 }).trim(); } catch { /* ignore: not in a git repo */ }

    const cwd = this.cfg.cwd.replace(os.homedir(), "~");
    const session = this.sessionId ? this.sessionId.slice(0, 8) : "-";
    const cost = this.totalCost > 0 ? `$${this.totalCost.toFixed(4)}` : "";
    const msgs = `${this.messages.length}msg`;

    // Dynamic context usage % (like CC's inline indicator)
    const contextLimit = (this.cfg._provider || detectProvider(this.cfg.model))?.capabilities?.contextWindow || 128000;
    const realInput = this._lastUsage?.input_tokens || 0;
    const ctxPct = realInput > 0 ? Math.min(100, Math.round((realInput / contextLimit) * 100)) : 0;
    const ctxColor = ctxPct > 80 ? "\x1b[31m" : ctxPct > 60 ? "\x1b[33m" : "\x1b[2m";
    const ctxStr = ctxPct > 0 ? `${ctxColor}${ctxPct}%ctx\x1b[0m` : "";

    const parts = [
      `\x1b[2m${provider}\x1b[0m`,
      `\x1b[36m${model}\x1b[0m`,
      modeStr ? `\x1b[33m[${modeStr}]\x1b[0m` : "",
      gitBranch ? `\x1b[35m${gitBranch}\x1b[0m` : "",
      `\x1b[2m${cwd}\x1b[0m`,
      `\x1b[2m${session}\x1b[0m`,
      `\x1b[2m${msgs}\x1b[0m`,
      cost ? `\x1b[2m${cost}\x1b[0m` : "",
      ctxStr,
    ].filter(Boolean);

    let statusStr = parts.join(" \x1b[2m|\x1b[0m ");

    // Custom statusline script (trust-gated)
    if (this._statuslineScript) {
      try {
        const custom = execSync(this._statuslineScript, { cwd: this.cfg.cwd, encoding: "utf-8", timeout: 3000 }).trim();
        if (custom) statusStr += ` \x1b[2m|\x1b[0m ${custom}`;
      } catch { /* ignore: statusline script may fail */ }
    }

    process.stderr.write(`${statusStr}\n`);
  }

  _handleStatuslineConfig(args) {
    if (!args[0] || args[0] === "off") {
      this._statuslineScript = null;
      process.stderr.write(`\x1b[2mStatusline script: off\x1b[0m\n`);
      return;
    }
    const scriptPath = path.resolve(this.cfg.cwd, args[0]);
    if (!fs.existsSync(scriptPath)) {
      process.stderr.write(`\x1b[31mScript not found: ${scriptPath}\x1b[0m\n`);
      return;
    }
    const home = os.homedir();
    if (!scriptPath.startsWith(home) && !scriptPath.startsWith(this.cfg.cwd)) {
      process.stderr.write(`\x1b[31mStatusline script must be under $HOME or project directory.\x1b[0m\n`);
      return;
    }
    this._statuslineScript = scriptPath;
    process.stderr.write(`\x1b[2mStatusline script: ${scriptPath}\x1b[0m\n`);
    this._renderStatusLine();
  }

  // ── Help / Command Palette ───────────────────────────────────
  _renderHelp(filter = "") {
    const query = filter.toLowerCase().trim();
    const builtins = this.slashCommands.list("builtin");
    const skills = this.slashCommands.list("skill");

    const filterFn = (c) => {
      if (!query) return true;
      return c.name.includes(query) || c.aliases.some((a) => a.includes(query)) || c.description.toLowerCase().includes(query);
    };

    const filteredBuiltins = builtins.filter(filterFn);
    const filteredSkills = skills.filter(filterFn);

    // General section (only when unfiltered)
    if (!query) {
      process.stderr.write(`\n\x1b[1m  Quick Reference\x1b[0m\n`);
      process.stderr.write(`\x1b[2m  Type normally to chat. Use / commands to control the session.\x1b[0m\n`);
      process.stderr.write(`\x1b[2m  Tab completes command names. Ctrl+C to interrupt.\x1b[0m\n\n`);
    }

    // Commands section
    if (filteredBuiltins.length > 0) {
      process.stderr.write(`\x1b[1m  Commands\x1b[0m\n`);
      const maxName = Math.max(...filteredBuiltins.map((c) => c.name.length + (c.argumentHint ? c.argumentHint.length + 1 : 0)));
      for (const cmd of filteredBuiltins) {
        const nameCol = "/" + cmd.name + (cmd.argumentHint ? " " + cmd.argumentHint : "");
        const pad = " ".repeat(Math.max(0, maxName + 4 - nameCol.length));
        const aliases = cmd.aliases.length > 0 ? `  \x1b[2m(${cmd.aliases.map((a) => "/" + a).join(", ")})\x1b[0m` : "";
        process.stderr.write(`  \x1b[36m${nameCol}\x1b[0m${pad}${cmd.description}${aliases}\n`);
      }
      process.stderr.write("\n");
    }

    // Custom Commands section
    if (filteredSkills.length > 0) {
      process.stderr.write(`\x1b[1m  Custom Commands\x1b[0m \x1b[35m[skill]\x1b[0m\n`);
      const maxName = Math.max(...filteredSkills.map((c) => c.name.length + (c.argumentHint ? c.argumentHint.length + 1 : 0)));
      for (const cmd of filteredSkills) {
        const nameCol = "/" + cmd.name + (cmd.argumentHint ? " " + cmd.argumentHint : "");
        const pad = " ".repeat(Math.max(0, maxName + 4 - nameCol.length));
        process.stderr.write(`  \x1b[35m${nameCol}\x1b[0m${pad}${cmd.description}\n`);
      }
      process.stderr.write("\n");
    }

    if (filteredBuiltins.length === 0 && filteredSkills.length === 0) {
      process.stderr.write(`\x1b[2m  No commands matching "${filter}"\x1b[0m\n\n`);
    }
  }

  // ── Tab Completer ────────────────────────────────────────────
  _completer(line) {
    if (!line.startsWith("/")) return [[], line];
    const names = this.slashCommands.completionNames();
    const hits = names.filter((n) => n.startsWith(line));
    return [hits.length > 0 ? hits : names, line];
  }

  async run() {
    this._initSlashCommands();

    // Override AskUserQuestion with interactive stdin prompt
    const self = this;
    this.registry.register("AskUserQuestion", {
      description: "Ask the user a question and wait for their answer. Use when you need clarification, a decision between options, or confirmation before proceeding.",
      input_schema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask the user" },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short label (1-5 words)" },
                description: { type: "string", description: "What this option means" },
              },
              required: ["label"],
            },
            description: "2-6 options. An 'Other' free-text option is added automatically.",
          },
        },
        required: ["question"],
      },
    }, async (input) => {
      return new Promise((resolve) => {
        process.stderr.write(`\n\x1b[1m  ${input.question}\x1b[0m\n\n`);

        const options = input.options || [];
        if (options.length > 0) {
          // Numbered options
          for (let i = 0; i < options.length; i++) {
            const desc = options[i].description ? `  \x1b[2m${options[i].description}\x1b[0m` : "";
            process.stderr.write(`  \x1b[36m${i + 1}.\x1b[0m ${options[i].label}${desc}\n`);
          }
          process.stderr.write(`  \x1b[36m${options.length + 1}.\x1b[0m Other (type your answer)\n`);
          process.stderr.write(`\n\x1b[33mChoose (1-${options.length + 1}): \x1b[0m`);

          const rl = createInterface({ input: process.stdin, output: process.stderr });
          rl.question("", (answer) => {
            rl.close();
            const num = parseInt(answer.trim(), 10);
            if (num >= 1 && num <= options.length) {
              const chosen = options[num - 1];
              resolve({ content: JSON.stringify({ answer: chosen.label, index: num - 1 }), is_error: false });
            } else if (num === options.length + 1 || isNaN(num)) {
              // "Other" or free text
              const text = isNaN(num) ? answer.trim() : "";
              if (text) {
                resolve({ content: JSON.stringify({ answer: text, index: -1, freeText: true }), is_error: false });
              } else {
                // Ask for free text
                process.stderr.write(`\x1b[33mYour answer: \x1b[0m`);
                const rl2 = createInterface({ input: process.stdin, output: process.stderr });
                rl2.question("", (freeAnswer) => {
                  rl2.close();
                  resolve({ content: JSON.stringify({ answer: freeAnswer.trim(), index: -1, freeText: true }), is_error: false });
                });
              }
            } else {
              resolve({ content: JSON.stringify({ answer: answer.trim(), index: -1, freeText: true }), is_error: false });
            }
          });
        } else {
          // No options — free text question
          process.stderr.write(`\x1b[33mYour answer: \x1b[0m`);
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          rl.question("", (answer) => {
            rl.close();
            resolve({ content: JSON.stringify({ answer: answer.trim() }), is_error: false });
          });
        }
      });
    });

    // Resume or create session
    if (this.cfg.resume) {
      this.sessionId = this.cfg.sessionId || this.sessions.latest();
      if (this.sessionId) {
        this.messages = this.sessions.load(this.sessionId);
        process.stderr.write(`\x1b[2mResumed session ${this.sessionId} (${this.messages.length} messages)\x1b[0m\n`);
      }
    }
    if (!this.sessionId) {
      this.sessionId = this.sessions.create();
    }
    this.checkpoints = new CheckpointStore(this.sessionId);

    // Auto-load statusline script
    const statuslineCmd = path.join(os.homedir(), ".claude", "statusline-command.sh");
    if (fs.existsSync(statuslineCmd)) this._statuslineScript = statuslineCmd;

    // Try Ink UI when TTY is available, fall back to readline
    if (process.stdin.isTTY && process.stdout.isTTY) {
      try {
        const { startInkUI } = await import("./ink-ui.mjs");
        await startInkUI(this);
        this.mcpManager.shutdown();
        return;
      } catch (e) {
        log(`Ink UI failed, falling back to readline: ${e.message}`);
      }
    }

    // ── Readline fallback ──────────────────────────────────────
    await this._runReadline();
  }

  async _runReadline() {
    // SessionStart hook
    if (this.cfg._hookRunner?.hasHooksFor("SessionStart")) {
      await this.cfg._hookRunner.fire("SessionStart", {
        session_id: this.sessionId || "", cwd: this.cfg.cwd, hook_event_name: "SessionStart",
        model: this.cfg.model,
      });
    }

    process.stderr.write(`\x1b[1mcloclo\x1b[0m\n`);
    this._renderStatusLine();
    process.stderr.write(`\x1b[2mType \x1b[0m/\x1b[2m for commands, \x1b[0mTab\x1b[2m to complete. \x1b[0m↑↓\x1b[2m for history.\x1b[0m\n\n`);

    // Load command history from disk
    const historyFile = path.join(os.homedir(), ".claude-native", "history");
    let history = [];
    try {
      if (fs.existsSync(historyFile)) {
        history = fs.readFileSync(historyFile, "utf-8").split("\n").filter(Boolean).reverse();
      }
    } catch { /* ignore: history file may not exist */ }

    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
      prompt: this._promptLabel(),
      completer: (line) => this._completer(line),
      history,
      historySize: 500,
    });
    this._rl = rl;

    rl.prompt();

    // Save history helper
    const _saveHistory = () => {
      try {
        fs.mkdirSync(path.dirname(historyFile), { recursive: true });
        // rl.history is newest-first; save as oldest-first for next load
        const lines = (rl.history || []).slice().reverse();
        fs.writeFileSync(historyFile, lines.join("\n") + "\n");
      } catch { /* ignore: history dir may not be writable */ }
    };

    for await (const line of rl) {
      const input = line.trim();
      if (!input) { rl.prompt(); continue; }

      // Save history after each input
      _saveHistory();

      // Bare "/" or "/help" → show palette
      if (input === "/" || input === "/help") {
        this._renderHelp();
        rl.prompt();
        continue;
      }

      // Slash commands
      if (input.startsWith("/")) {
        const result = await this._handleSlashCommand(input, rl);
        if (result === "exit") break;
        rl.prompt();
        continue;
      }

      await this._processInput(input);
      this._renderStatusLine();
      rl.prompt();
    }

    // Save history on exit
    _saveHistory();

    // SessionEnd hook
    if (this.cfg._hookRunner?.hasHooksFor("SessionEnd")) {
      await this.cfg._hookRunner.fire("SessionEnd", {
        session_id: this.sessionId || "", cwd: this.cfg.cwd, hook_event_name: "SessionEnd",
        message_count: this.messages.length, total_cost: this.totalCost,
      });
    }

    // Increment dream session counter for consolidation trigger
    try { incrementDreamSessionCount(); } catch { /* non-fatal */ }

    // Write session metrics to disk
    if (this._sessionMetrics) {
      try {
        const metricsDir = path.join(os.homedir(), ".claude-native", "session-metrics");
        fs.mkdirSync(metricsDir, { recursive: true });
        this._sessionMetrics.ended_at = new Date().toISOString();
        this._sessionMetrics.total_cost = this.totalCost;
        fs.writeFileSync(
          path.join(metricsDir, `${this.sessionId}.json`),
          JSON.stringify(this._sessionMetrics, null, 2)
        );
      } catch (e) { log(`[metrics] Write error: ${e.message}`); }
    }

    this.mcpManager.shutdown();
  }

  async _handleSlashCommand(input, rl) {
    const [rawCmd, ...args] = input.split(/\s+/);
    const cmdName = rawCmd.slice(1);

    // Skills first — fork mode (sub-agent) or inline fallback
    if (this.cfg._skillLoader?.has(cmdName)) {
      const argsStr = args.join(" ");
      const skill = this.cfg._skillLoader.invoke(cmdName, argsStr);
      if (skill) {
        const skillContext = new SkillExecutionContext({
          name: skill.name, skillRoot: skill.skillRoot, allowedTools: skill.allowedTools,
          hooks: skill.hooks, dataDir: skill.dataDir, trackingId: `skill_${randomUUID().slice(0, 8)}`,
        });
        log(`Skill invocation: /${skill.name} [${skillContext.trackingId}]`);

        // Try fork mode: run as sub-agent for isolation
        if (this.cfg.skillFork !== false) {
          try {
            await this._processSkillFork(skill, skillContext);
            return null;
          } catch (e) {
            log(`Skill fork failed, falling back to inline: ${e.message}`);
          }
        }

        // Inline fallback
        await this._processSkillInput(`<skill-invocation name="${skill.name}" tracking-id="${skillContext.trackingId}">\n${skill.body}\n</skill-invocation>`, skillContext);
        return null;
      }
    }

    // Registry lookup
    const cmd = this.slashCommands.get(cmdName);
    if (cmd && cmd.handler) {
      const result = await cmd.handler(args, rl);
      if (result === "exit") return "exit";
      if (cmd.name === "model") rl.setPrompt(this._promptLabel());
      return null;
    }

    // Unknown → filtered help
    this._renderHelp(cmdName);
    return null;
  }

  // ── /model (extracted) ───────────────────────────────────────
  _handleModel(args) {
    if (args[0]) {
      const newModel = resolveModel(args[0]);
      const newProvider = detectProvider(newModel, this.cfg.provider);
      const effectiveModel = newProvider.transformModel ? newProvider.transformModel(newModel) : newModel;
      const providerKey = newProvider.envKey === "ANTHROPIC_API_KEY" ? (this.cfg.apiKey || this.cfg.authToken)
        : newProvider.envKey === "OPENAI_API_KEY" ? this.cfg.openaiApiKey
        : newProvider.envKey ? (process.env[newProvider.envKey] || "") : "no-auth";
      if (!providerKey && newProvider.envKey) {
        const hint = newProvider.name === "Anthropic" ? "Run /login or set ANTHROPIC_API_KEY"
          : newProvider.envKey === "OPENAI_API_KEY" ? "Run /openai-login or set OPENAI_API_KEY" : `Set ${newProvider.envKey}`;
        process.stderr.write(`\x1b[31mCannot switch to ${newModel}: no ${newProvider.name} credentials.\x1b[0m\n`);
        process.stderr.write(`\x1b[31m${hint} first.\x1b[0m\n`);
        return;
      }
      const providerUrl = newProvider.resolveBaseUrl ? newProvider.resolveBaseUrl(this.cfg) : newProvider.defaultUrl;
      this.client = newProvider.createClient({ apiKey: this.cfg.apiKey, authToken: this.cfg.authToken, providerKey, providerUrl, model: effectiveModel, openaiApiKey: this.cfg.openaiApiKey, openaiApiUrl: this.cfg.openaiApiUrl });
      this.registry._client = this.client; this.registry._provider = newProvider;
      this.cfg.model = effectiveModel; this.cfg._provider = newProvider; this.registry._currentModel = effectiveModel;
      const backend = newProvider.name !== "Anthropic" ? ` (${newProvider.name})` : "";
      process.stderr.write(`\x1b[2mSwitched to ${this.cfg.model}${backend}\x1b[0m\n`);
    } else {
      const currentProvider = this.cfg._provider || detectProvider(this.cfg.model);
      process.stderr.write(`\x1b[2mCurrent model: ${this.cfg.model} (${currentProvider.name})\x1b[0m\n`);
    }
  }

  // ── /rewind (extracted) ──────────────────────────────────────
  async _handleRewind(args) {
    if (!this.checkpoints) { process.stderr.write("\x1b[2mCheckpointing not enabled.\x1b[0m\n"); return; }
    const targetId = args[0] || this.checkpoints.getSnapshots().at(-1)?.messageId;
    if (!targetId) { process.stderr.write("\x1b[2mNo checkpoints to rewind to.\x1b[0m\n"); return; }
    const preview = this.checkpoints.rewind(targetId, true);
    if (!preview.canRewind) { process.stderr.write(`\x1b[31m${preview.error}\x1b[0m\n`); return; }
    const total = preview.restored.length + preview.created.length + preview.deleted.length;
    if (total === 0) { process.stderr.write("\x1b[2mNothing to rewind.\x1b[0m\n"); return; }
    process.stderr.write(`\x1b[33mRewind to ${targetId.slice(0,8)}:\x1b[0m\n`);
    for (const f of preview.restored) process.stderr.write(`  \x1b[33mrestore\x1b[0m ${f}\n`);
    for (const f of preview.created) process.stderr.write(`  \x1b[31mdelete\x1b[0m  ${f} (created after checkpoint)\n`);
    for (const f of preview.deleted) process.stderr.write(`  \x1b[32mrecreate\x1b[0m ${f}\n`);
    for (const c of preview.conflicts) process.stderr.write(`  \x1b[33m⚠ conflict\x1b[0m ${c.file}: ${c.reason}\n`);
    process.stderr.write(`  (${preview.insertions}+ ${preview.deletions}-)\n`);
    await new Promise((resolve) => {
      process.stderr.write(`\x1b[33mProceed? (y/n): \x1b[0m`);
      const confirmRl = createInterface({ input: process.stdin, output: process.stderr });
      confirmRl.question("", (answer) => {
        confirmRl.close();
        if (answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes") {
          const result = this.checkpoints.rewind(targetId, false);
          process.stderr.write(`\x1b[32mRewound ${result.restored.length + result.created.length + result.deleted.length} files.\x1b[0m\n`);
        } else { process.stderr.write("\x1b[2mRewind cancelled.\x1b[0m\n"); }
        resolve();
      });
    });
  }

  async _processInput(input) {
    // Expand context references (@file:, @diff, @url:, etc.)
    let expandedInput = input;
    try {
      if (typeof input === "string" && input.includes("@")) {
        expandedInput = await expandContextRefs(input, this.cfg.cwd || process.cwd());
      }
    } catch { /* ignore: context ref expansion is non-fatal */ }

    // UserPromptSubmit hook
    if (this.cfg._hookRunner?.hasHooksFor("UserPromptSubmit")) {
      await this.cfg._hookRunner.fire("UserPromptSubmit", {
        session_id: this.sessionId || "", cwd: this.cfg.cwd, hook_event_name: "UserPromptSubmit",
        prompt: expandedInput.substring(0, 1000),
      });
    }

    // Trivial fast-path: greetings/confirmations → cheaper model
    const _routedModel = routeModel(expandedInput, this.cfg);
    const _originalModel = this.cfg.model;
    if (_routedModel) this.cfg.model = _routedModel;

    const messageId = randomUUID();
    this.messages.push({ role: "user", content: expandedInput, messageId });
    this.sessions.append(this.sessionId, { role: "user", content: expandedInput, messageId });

    // Snapshot before agent runs
    if (this.checkpoints) {
      this.checkpoints.createSnapshot(messageId);
      this.registry._checkpoints = this.checkpoints;
      this.registry._messageId = messageId;
    }

    const systemBlocks = buildSystemPrompt(this.cfg);
    let toolCalls = 0;

    const brief = this.cfg.briefMode;
    const remote = _remoteManager?.isActive() ? _remoteManager : null;
    const loop = new AgentLoop(this.client, this.registry, this.cfg, {
      onText: (delta) => {
        if (brief) { process.stderr.write(`\x1b[2m${delta}\x1b[0m`); } else { process.stderr.write(delta); }
        if (remote) remote.emit({ type: "stream", event_type: "text_delta", data: { text: delta } });
      },
      onThinking: (delta) => {
        process.stderr.write(`\x1b[2m${delta}\x1b[0m`);
      },
      onToolUse: (block) => {
        toolCalls++;
        const inputStr = JSON.stringify(block.input).substring(0, 80);
        process.stderr.write(`\n\x1b[2m[${block.name}: ${inputStr}]\x1b[0m\n`);
        if (remote) remote.emit({ type: "tool_use", name: block.name, input: block.input, id: block.id });
      },
      onToolResult: (id, result, toolName) => {
        const parsed = _parseStructuredOutput(toolName, result);
        if (parsed) {
          const rendered = _renderStructuredOutput(parsed, toolName);
          if (rendered) process.stderr.write(`\n${rendered}\n`);
        } else if (result.is_error) {
          process.stderr.write(`\x1b[31m[Error]\x1b[0m\n`);
        }
        if (remote) remote.emit({ type: "tool_result", id, tool_name: toolName, is_error: result.is_error });
      },
      onCompact: (compactedMessages) => {
        // Persist compacted context to session file so resume loads the compact state
        this.sessions.rewrite(this.sessionId, compactedMessages);
        log(`[context] Session file rewritten with ${compactedMessages.length} compacted messages`);
      },
      onPermissionDeny: (block, msg) => {
        process.stderr.write(`\x1b[33m[Denied: ${block.name}] ${msg}\x1b[0m\n`);
      },
      onInteractivePermission: (block, message) => {
        return new Promise((resolve) => {
          // Remote permission enforcement: if input came from remote, check tier
          if (remote && remote._inputIsRemote) {
            const isReadOnly = block.name === "Read" || block.name === "Glob" || block.name === "Grep" || block.name === "WebSearch" || block.name === "WebFetch";
            if (!remote.canExecuteTool(block.name, isReadOnly)) {
              remote._audit("prompt_blocked", { reason: `${remote._mode} mode cannot execute ${block.name}` });
              remote.emit({ type: "permission_denied", reason: `${block.name} blocked in ${remote._mode} mode` });
              resolve(false);
              return;
            }
            if (remote.needsApproval(block.name)) {
              process.stderr.write(`\n\x1b[33m[remote approval] ${block.name} in ${remote._mode} mode\x1b[0m\n`);
              process.stderr.write(`\x1b[33mApprove remote action? (y/n): \x1b[0m`);
              const rl = createInterface({ input: process.stdin, output: process.stderr });
              rl.question("", (answer) => {
                rl.close();
                const a = answer.trim().toLowerCase();
                const approved = a === "y" || a === "yes";
                remote._audit("approval_resolved", { toolName: block.name, approved });
                if (!approved) remote.emit({ type: "permission_denied", reason: `${block.name} denied by host` });
                resolve(approved);
              });
              return;
            }
          }
          const inputStr = JSON.stringify(block.input).substring(0, 100);
          process.stderr.write(`\n\x1b[33m${message}\x1b[0m\n`);
          process.stderr.write(`\x1b[2m  ${block.name}: ${inputStr}\x1b[0m\n`);
          process.stderr.write(`\x1b[33mAllow? (y/n/always): \x1b[0m`);
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          rl.question("", (answer) => {
            rl.close();
            const a = answer.trim().toLowerCase();
            if (a === "always" || a === "a") {
              this.permissions?.addRule(block.name, null, "allow");
              resolve(true);
            } else {
              resolve(a === "y" || a === "yes");
            }
          });
        });
      },
    }, this.permissions);

    try {
      const result = await loop.run(this.messages, systemBlocks);
      const assistantVisibleText = _flattenUserFacingOutputs(result.userFacingOutputs, result.text);

      // Save assistant message
      this.sessions.append(this.sessionId, { role: "assistant", content: assistantVisibleText });

      // Auto-memory: LLM-based classification of what to remember
      try {
        if (!this._autoMemory) this._autoMemory = new AutoMemory(this.cfg.cwd, this.client, this.cfg._provider);
        const userText = typeof input === "string" ? input : JSON.stringify(input);
        // Maintain exchange buffer (rolling window of 5)
        this._exchangeBuffer.push({ user: userText, assistant: assistantVisibleText || "" });
        if (this._exchangeBuffer.length > 5) this._exchangeBuffer.shift();
        // Fire and forget — don't block the REPL on memory classification
        this._autoMemory.processExchange(userText, assistantVisibleText || "", this._exchangeBuffer).then(saved => {
          for (const s of saved) log(`[auto-memory] Saved ${s.type}: ${s.name}`);
        }).catch(e => log(`[auto-memory] Error: ${e.message}`));
      } catch (e) { /* ignore: auto-memory is non-fatal */
        log(`[auto-memory] Error: ${e.message}`);
      }

      // Dream trigger — consolidate memories if conditions are met
      try {
        if (shouldDream(this.cfg.cwd)) {
          runDream(this.cfg.cwd, this.client, this.registry, this.permissions, new BackgroundAgentManager())
            .catch(e => log(`[dream] Error: ${e.message}`));
        }
      } catch (e) { log(`[dream] Check error: ${e.message}`); }

      // Background review nudge — skill creation + memory review
      try {
        this._turnsSinceMemoryReview++;
        this._toolCallsSinceSkillReview += (result.toolUseCount || 0);
        const cfg = this.cfg;
        if (!cfg._isSubAgent && this._nudgeEnabled) {
          if (this._toolCallsSinceSkillReview >= this._skillNudgeInterval) {
            this._toolCallsSinceSkillReview = 0;
            this._spawnBackgroundReview("skill").catch(e => log(`[nudge] ${e.message}`));
          }
          if (this._turnsSinceMemoryReview >= this._memoryNudgeInterval) {
            this._turnsSinceMemoryReview = 0;
            this._spawnBackgroundReview("memory").catch(e => log(`[nudge] ${e.message}`));
          }
        }
      } catch (e) { log(`[nudge] Error: ${e.message}`); }

      // Auto-save session title on first exchange
      if (!this.sessions.getMeta(this.sessionId, "title") && this.messages.length >= 2) {
        const title = this.sessions.autoTitle(this.sessionId);
        if (title) this.sessions.setMeta(this.sessionId, "title", title);
      }

      // Cost estimate (rough: $3/M input, $15/M output for sonnet)
      const costIn = (result.usage.input_tokens / 1_000_000) * 3;
      const costOut = (result.usage.output_tokens / 1_000_000) * 15;
      this.totalCost += costIn + costOut;

      // Track last usage for /context and session metrics
      this._lastUsage = result.usage;
      if (!this._sessionMetrics) {
        this._sessionMetrics = {
          session_id: this.sessionId, model: this.cfg.model,
          turns: 0, total_input: 0, total_output: 0,
          compactions: 0, cache_reads: 0, cache_creates: 0,
          tool_calls: 0, started_at: new Date().toISOString(),
        };
      }
      this._sessionMetrics.turns++;
      this._sessionMetrics.total_input += result.usage.input_tokens || 0;
      this._sessionMetrics.total_output += result.usage.output_tokens || 0;
      this._sessionMetrics.cache_reads += result.usage.cache_read_input_tokens || 0;
      this._sessionMetrics.cache_creates += result.usage.cache_creation_input_tokens || 0;
      this._sessionMetrics.tool_calls += result.toolUseCount || 0;

      const inK = (result.usage.input_tokens / 1000).toFixed(1);
      const outK = (result.usage.output_tokens / 1000).toFixed(1);
      process.stderr.write(`\n\x1b[2m(${inK}k in / ${outK}k out | ${toolCalls} tools | $${(costIn + costOut).toFixed(4)} | ${result.turns} turns${_routedModel ? ` | routed→${_routedModel}` : ""})\x1b[0m\n\n`);
    } catch (e) {
      process.stderr.write(`\n\x1b[31mError: ${e.message}\x1b[0m\n\n`);
    } finally {
      // Restore original model after smart routing
      if (_routedModel) this.cfg.model = _originalModel;
    }
  }

  // Skill-scoped execution: same as _processInput but with a SkillExecutionContext
  // ── Skill fork execution (sub-agent) ──────────────────────
  async _processSkillFork(skill, skillContext) {
    process.stderr.write(`\x1b[2m[forking sub-agent for /${skill.name}...]\x1b[0m\n`);

    const prompt = `<skill-invocation name="${skill.name}" tracking-id="${skillContext.trackingId}">\n${skill.body}\n</skill-invocation>`;

    // Use the Agent tool's SubAgentRunner
    const result = await this.registry.execute("Agent", {
      prompt,
      subagent_type: "general-purpose",
      description: `Skill: ${skill.name}`,
    });

    if (result.is_error) throw new Error(result.content);

    // Parse the sub-agent result and display it
    try {
      const parsed = JSON.parse(result.content);
      process.stderr.write(parsed.content || result.content);
      process.stderr.write("\n");

      // Record cost
      if (parsed.usage) {
        const costIn = (parsed.usage.input_tokens / 1_000_000) * 3;
        const costOut = (parsed.usage.output_tokens / 1_000_000) * 15;
        this.totalCost += costIn + costOut;
        const inK = (parsed.usage.input_tokens / 1000).toFixed(1);
        const outK = (parsed.usage.output_tokens / 1000).toFixed(1);
        process.stderr.write(`\x1b[2m(/${skill.name} fork: ${inK}k in / ${outK}k out | ${parsed.turns || 0} turns)\x1b[0m\n\n`);
      }

      // Add to conversation history
      this.messages.push({ role: "user", content: prompt });
      this.messages.push({ role: "assistant", content: parsed.content || result.content });
      this.sessions.append(this.sessionId, { role: "assistant", content: parsed.content || result.content });
    } catch {
      // Non-JSON result — display raw
      process.stderr.write(result.content);
      process.stderr.write("\n");
      this.messages.push({ role: "user", content: prompt });
      this.messages.push({ role: "assistant", content: result.content });
    }
  }

  async _processSkillInput(input, skillContext) {
    const messageId = randomUUID();
    this.messages.push({ role: "user", content: input, messageId });
    this.sessions.append(this.sessionId, { role: "user", content: input, messageId });

    // Snapshot before agent runs
    if (this.checkpoints) {
      this.checkpoints.createSnapshot(messageId);
      this.registry._checkpoints = this.checkpoints;
      this.registry._messageId = messageId;
    }

    const systemBlocks = buildSystemPrompt(this.cfg);
    let toolCalls = 0;

    // Create a skill-scoped cfg that carries the execution context
    const skillCfg = { ...this.cfg, _skillContext: skillContext };

    const brief = this.cfg.briefMode;
    const loop = new AgentLoop(this.client, this.registry, skillCfg, {
      onText: (delta) => {
        if (brief) {
          process.stderr.write(`\x1b[2m${delta}\x1b[0m`);
        } else {
          process.stderr.write(delta);
        }
      },
      onThinking: (delta) => {
        process.stderr.write(`\x1b[2m${delta}\x1b[0m`);
      },
      onToolUse: (block) => {
        toolCalls++;
        const inputStr = JSON.stringify(block.input).substring(0, 80);
        process.stderr.write(`\n\x1b[2m[${block.name}: ${inputStr}]\x1b[0m\n`);
      },
      onToolResult: (id, result, toolName) => {
        const parsed = _parseStructuredOutput(toolName, result);
        if (parsed) {
          const rendered = _renderStructuredOutput(parsed, toolName);
          if (rendered) process.stderr.write(`\n${rendered}\n`);
        } else if (result.is_error) {
          process.stderr.write(`\x1b[31m[Error]\x1b[0m\n`);
        }
      },
      onCompact: (compactedMessages) => {
        this.sessions.rewrite(this.sessionId, compactedMessages);
        log(`[context] Session file rewritten with ${compactedMessages.length} compacted messages`);
      },
      onPermissionDeny: (block, msg) => {
        process.stderr.write(`\x1b[33m[Denied: ${block.name}] ${msg}\x1b[0m\n`);
      },
      onInteractivePermission: (block, message) => {
        return new Promise((resolve) => {
          const inputStr = JSON.stringify(block.input).substring(0, 100);
          process.stderr.write(`\n\x1b[33m${message}\x1b[0m\n`);
          process.stderr.write(`\x1b[2m  ${block.name}: ${inputStr}\x1b[0m\n`);
          process.stderr.write(`\x1b[33mAllow? (y/n/always): \x1b[0m`);
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          rl.question("", (answer) => {
            rl.close();
            const a = answer.trim().toLowerCase();
            if (a === "always" || a === "a") {
              this.permissions?.addRule(block.name, null, "allow");
              resolve(true);
            } else {
              resolve(a === "y" || a === "yes");
            }
          });
        });
      },
    }, this.permissions);

    try {
      const result = await loop.run(this.messages, systemBlocks);
      const assistantVisibleText = _flattenUserFacingOutputs(result.userFacingOutputs, result.text);

      // Save assistant message
      this.sessions.append(this.sessionId, { role: "assistant", content: assistantVisibleText });

      // Cost estimate
      const costIn = (result.usage.input_tokens / 1_000_000) * 3;
      const costOut = (result.usage.output_tokens / 1_000_000) * 15;
      this.totalCost += costIn + costOut;

      const inK = (result.usage.input_tokens / 1000).toFixed(1);
      const outK = (result.usage.output_tokens / 1000).toFixed(1);
      const skillLabel = `/${skillContext.name} [${skillContext.trackingId}]`;
      process.stderr.write(`\n\x1b[2m(${skillLabel} | ${inK}k in / ${outK}k out | ${toolCalls} tools | $${(costIn + costOut).toFixed(4)} | ${result.turns} turns)\x1b[0m\n\n`);
    } catch (e) {
      process.stderr.write(`\n\x1b[31mError: ${e.message}\x1b[0m\n\n`);
    }
  }
}

// ── Logging ─────────────────────────────────────────────────────

// ── Exports ──────────────────────────────────────────────────────

export {
  SessionManager,
  CheckpointStore,
  NdjsonBridge,
  SlashCommandRegistry,
  RemoteSessionManager,
  InteractiveMode,
  interactiveForm,
  interactiveMultiline,
};
