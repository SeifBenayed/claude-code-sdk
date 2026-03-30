// src/audit.mjs — Persistent audit trail for all agent actions
//
// Every tool execution, permission decision, file mutation, and session event
// is recorded as an append-only JSONL log. GDPR/SOC2 friendly:
//   - Structured, immutable events
//   - Retention policies with automatic pruning
//   - Full export (JSON/CSV)
//   - Data deletion per session or date range
//
// Storage: ~/.claude-native/audit/<YYYY-MM>/audit-<YYYY-MM-DD>.jsonl
// One file per day, rotated monthly into subdirectories.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "./utils.mjs";

// ── Constants ────────────────────────────────────────────────

const AUDIT_BASE = path.join(os.homedir(), ".claude-native", "audit");
const DEFAULT_RETENTION_DAYS = 90;
const MAX_EVENTS_PER_FLUSH = 100;

// ── Event Types ──────────────────────────────────────────────

const EVENT_TYPES = {
  // Session lifecycle
  SESSION_START:       "session.start",
  SESSION_END:         "session.end",
  SESSION_RESUME:      "session.resume",

  // Tool execution
  TOOL_USE:            "tool.use",
  TOOL_RESULT:         "tool.result",
  TOOL_ERROR:          "tool.error",

  // Permission decisions
  PERMISSION_ALLOW:    "permission.allow",
  PERMISSION_DENY:     "permission.deny",
  PERMISSION_ASK:      "permission.ask",
  PERMISSION_RESPONSE: "permission.response",

  // Security
  SECURITY_BLOCK:      "security.block",
  SECURITY_ALLOW:      "security.allow",

  // File mutations
  FILE_WRITE:          "file.write",
  FILE_EDIT:           "file.edit",
  FILE_DELETE:         "file.delete",

  // Auth
  AUTH_LOGIN:          "auth.login",
  AUTH_LOGOUT:         "auth.logout",
  AUTH_REFRESH:        "auth.refresh",

  // Remote
  REMOTE_START:        "remote.start",
  REMOTE_STOP:         "remote.stop",
  REMOTE_CLIENT:       "remote.client",

  // Memory
  MEMORY_SAVE:         "memory.save",
  MEMORY_DELETE:        "memory.delete",

  // Errors
  ERROR:               "error",
};

// ── Audit Event Structure ────────────────────────────────────

function createEvent(type, data = {}) {
  return {
    ts: new Date().toISOString(),
    type,
    pid: process.pid,
    ...data,
  };
}

// ── Audit Logger ─────────────────────────────────────────────

class AuditLogger {
  constructor(opts = {}) {
    this._retention = opts.retentionDays || DEFAULT_RETENTION_DAYS;
    this._buffer = [];
    this._flushTimer = null;
    this._sessionId = null;
    this._project = null;
    this._enabled = opts.enabled !== false;
    this._initialized = false;
  }

  init(sessionId, project) {
    this._sessionId = sessionId;
    this._project = project;
    this._initialized = true;

    // Flush buffer every 5s or on 100 events
    this._flushTimer = setInterval(() => this.flush(), 5000);
    if (this._flushTimer.unref) this._flushTimer.unref(); // don't keep process alive

    // Run retention pruning in background (non-blocking)
    this._pruneOldLogs().catch(() => { /* ignore prune errors */ });
  }

  // ── Core logging ───────────────────────────────────────────

  record(type, data = {}) {
    if (!this._enabled) return;

    const event = createEvent(type, {
      session: this._sessionId,
      project: this._project,
      ...data,
    });

    this._buffer.push(event);

    if (this._buffer.length >= MAX_EVENTS_PER_FLUSH) {
      this.flush();
    }
  }

  // ── Convenience methods ────────────────────────────────────

  sessionStart(mode, model, provider) {
    this.record(EVENT_TYPES.SESSION_START, { mode, model, provider });
  }

  sessionEnd(usage = {}) {
    this.record(EVENT_TYPES.SESSION_END, { usage });
    this.flush(); // ensure final events are written
  }

  toolUse(toolName, input, messageId) {
    // Sanitize input — truncate large values, redact secrets
    const sanitized = _sanitizeInput(toolName, input);
    this.record(EVENT_TYPES.TOOL_USE, { tool: toolName, input: sanitized, messageId });
  }

  toolResult(toolName, isError, contentLength, durationMs) {
    this.record(EVENT_TYPES.TOOL_RESULT, {
      tool: toolName,
      is_error: isError,
      content_length: contentLength,
      duration_ms: durationMs,
    });
  }

  toolError(toolName, error) {
    this.record(EVENT_TYPES.TOOL_ERROR, { tool: toolName, error: String(error).slice(0, 500) });
  }

  permissionAllow(toolName, rule) {
    this.record(EVENT_TYPES.PERMISSION_ALLOW, { tool: toolName, rule });
  }

  permissionDeny(toolName, rule, reason) {
    this.record(EVENT_TYPES.PERMISSION_DENY, { tool: toolName, rule, reason });
  }

  permissionAsk(toolName, input) {
    this.record(EVENT_TYPES.PERMISSION_ASK, { tool: toolName, input: _sanitizeInput(toolName, input) });
  }

  permissionResponse(toolName, approved, reason) {
    this.record(EVENT_TYPES.PERMISSION_RESPONSE, { tool: toolName, approved, reason });
  }

  securityBlock(toolName, rule, reason) {
    this.record(EVENT_TYPES.SECURITY_BLOCK, { tool: toolName, rule, reason });
  }

  fileWrite(filePath, size) {
    this.record(EVENT_TYPES.FILE_WRITE, { path: _redactPath(filePath), size });
  }

  fileEdit(filePath, linesChanged) {
    this.record(EVENT_TYPES.FILE_EDIT, { path: _redactPath(filePath), lines_changed: linesChanged });
  }

  memorySave(type, name, auto) {
    this.record(EVENT_TYPES.MEMORY_SAVE, { memory_type: type, name, auto_saved: !!auto });
  }

  error(message, context) {
    this.record(EVENT_TYPES.ERROR, { message: String(message).slice(0, 500), context });
  }

  // ── Flush to disk ──────────────────────────────────────────

  flush() {
    if (this._buffer.length === 0) return;

    const events = this._buffer.splice(0);
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const day = now.toISOString().split("T")[0];

    const dir = path.join(AUDIT_BASE, month);
    const file = path.join(dir, `audit-${day}.jsonl`);

    try {
      fs.mkdirSync(dir, { recursive: true });
      const lines = events.map(e => JSON.stringify(e)).join("\n") + "\n";
      fs.appendFileSync(file, lines);
    } catch (e) {
      log(`[audit] flush error: ${e.message}`);
    }
  }

  // ── Shutdown ───────────────────────────────────────────────

  shutdown() {
    this.flush();
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
  }

  // ── Query & Export ─────────────────────────────────────────

  static query({ from, to, type, session, project, limit = 1000 } = {}) {
    const results = [];
    const fromDate = from ? new Date(from) : new Date(0);
    const toDate = to ? new Date(to) : new Date();

    // Scan audit directories
    try {
      const months = fs.readdirSync(AUDIT_BASE).sort();
      for (const month of months) {
        const monthDir = path.join(AUDIT_BASE, month);
        if (!fs.statSync(monthDir).isDirectory()) continue;

        const files = fs.readdirSync(monthDir).filter(f => f.endsWith(".jsonl")).sort();
        for (const file of files) {
          // Extract date from filename: audit-YYYY-MM-DD.jsonl
          const dateMatch = file.match(/audit-(\d{4}-\d{2}-\d{2})/);
          if (!dateMatch) continue;
          const fileDate = new Date(dateMatch[1]);
          if (fileDate < fromDate || fileDate > toDate) continue;

          const content = fs.readFileSync(path.join(monthDir, file), "utf-8");
          for (const line of content.split("\n")) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);
              if (type && event.type !== type) continue;
              if (session && event.session !== session) continue;
              if (project && event.project !== project) continue;
              const eventDate = new Date(event.ts);
              if (eventDate < fromDate || eventDate > toDate) continue;
              results.push(event);
              if (results.length >= limit) return results;
            } catch { /* ignore: malformed line */ }
          }
        }
      }
    } catch { /* ignore: no audit dir */ }

    return results;
  }

  static exportJSON(opts = {}) {
    const events = AuditLogger.query(opts);
    return JSON.stringify(events, null, 2);
  }

  static exportCSV(opts = {}) {
    const events = AuditLogger.query(opts);
    if (events.length === 0) return "";

    // Collect all unique keys
    const keys = new Set(["ts", "type", "session", "project", "pid"]);
    for (const e of events) {
      for (const k of Object.keys(e)) keys.add(k);
    }

    const cols = [...keys];
    const header = cols.map(c => `"${c}"`).join(",");
    const rows = events.map(e =>
      cols.map(c => {
        const v = e[c];
        if (v === undefined || v === null) return "";
        const s = typeof v === "object" ? JSON.stringify(v) : String(v);
        return `"${s.replace(/"/g, '""')}"`;
      }).join(",")
    );

    return [header, ...rows].join("\n");
  }

  // ── GDPR: Data deletion ────────────────────────────────────

  static deleteSession(sessionId) {
    let deleted = 0;
    try {
      const months = fs.readdirSync(AUDIT_BASE);
      for (const month of months) {
        const monthDir = path.join(AUDIT_BASE, month);
        if (!fs.statSync(monthDir).isDirectory()) continue;

        const files = fs.readdirSync(monthDir).filter(f => f.endsWith(".jsonl"));
        for (const file of files) {
          const filePath = path.join(monthDir, file);
          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content.split("\n");
          const filtered = lines.filter(line => {
            if (!line.trim()) return false;
            try {
              const e = JSON.parse(line);
              if (e.session === sessionId) { deleted++; return false; }
              return true;
            } catch { return true; }
          });
          fs.writeFileSync(filePath, filtered.join("\n") + "\n");
        }
      }
    } catch { /* ignore: no audit dir */ }
    return deleted;
  }

  static deleteRange(from, to) {
    const fromDate = new Date(from);
    const toDate = new Date(to);
    let deleted = 0;

    try {
      const months = fs.readdirSync(AUDIT_BASE);
      for (const month of months) {
        const monthDir = path.join(AUDIT_BASE, month);
        if (!fs.statSync(monthDir).isDirectory()) continue;

        const files = fs.readdirSync(monthDir).filter(f => f.endsWith(".jsonl"));
        for (const file of files) {
          const filePath = path.join(monthDir, file);
          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content.split("\n");
          const filtered = lines.filter(line => {
            if (!line.trim()) return false;
            try {
              const e = JSON.parse(line);
              const d = new Date(e.ts);
              if (d >= fromDate && d <= toDate) { deleted++; return false; }
              return true;
            } catch { return true; }
          });
          fs.writeFileSync(filePath, filtered.join("\n") + "\n");
        }
      }
    } catch { /* ignore */ }
    return deleted;
  }

  // ── Retention policy ───────────────────────────────────────

  async _pruneOldLogs() {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this._retention);

    try {
      const months = fs.readdirSync(AUDIT_BASE);
      for (const month of months) {
        const monthDir = path.join(AUDIT_BASE, month);
        if (!fs.statSync(monthDir).isDirectory()) continue;

        // Check if entire month is before cutoff
        const monthDate = new Date(month + "-01");
        const monthEnd = new Date(monthDate);
        monthEnd.setMonth(monthEnd.getMonth() + 1);

        if (monthEnd < cutoff) {
          // Delete entire month directory
          fs.rmSync(monthDir, { recursive: true, force: true });
          log(`[audit] Pruned old month: ${month}`);
          continue;
        }

        // Check individual files
        const files = fs.readdirSync(monthDir).filter(f => f.endsWith(".jsonl"));
        for (const file of files) {
          const dateMatch = file.match(/audit-(\d{4}-\d{2}-\d{2})/);
          if (!dateMatch) continue;
          if (new Date(dateMatch[1]) < cutoff) {
            fs.unlinkSync(path.join(monthDir, file));
            log(`[audit] Pruned old log: ${month}/${file}`);
          }
        }
      }
    } catch { /* ignore: audit dir may not exist yet */ }
  }

  // ── Stats ──────────────────────────────────────────────────

  static stats() {
    const result = { total_events: 0, total_size_bytes: 0, oldest: null, newest: null, by_type: {}, months: [] };

    try {
      const months = fs.readdirSync(AUDIT_BASE).sort();
      for (const month of months) {
        const monthDir = path.join(AUDIT_BASE, month);
        if (!fs.statSync(monthDir).isDirectory()) continue;

        let monthEvents = 0;
        let monthSize = 0;

        const files = fs.readdirSync(monthDir).filter(f => f.endsWith(".jsonl"));
        for (const file of files) {
          const filePath = path.join(monthDir, file);
          const stat = fs.statSync(filePath);
          monthSize += stat.size;

          const content = fs.readFileSync(filePath, "utf-8");
          for (const line of content.split("\n")) {
            if (!line.trim()) continue;
            try {
              const e = JSON.parse(line);
              monthEvents++;
              result.by_type[e.type] = (result.by_type[e.type] || 0) + 1;
              if (!result.oldest || e.ts < result.oldest) result.oldest = e.ts;
              if (!result.newest || e.ts > result.newest) result.newest = e.ts;
            } catch { /* ignore */ }
          }
        }

        result.total_events += monthEvents;
        result.total_size_bytes += monthSize;
        result.months.push({ month, events: monthEvents, size_bytes: monthSize });
      }
    } catch { /* ignore */ }

    return result;
  }
}

// ── Input Sanitization ───────────────────────────────────────

function _sanitizeInput(toolName, input) {
  if (!input || typeof input !== "object") return input;
  const sanitized = {};

  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") {
      // Truncate long values
      if (value.length > 500) {
        sanitized[key] = value.slice(0, 500) + `... (${value.length} chars)`;
      }
      // Redact potential secrets
      else if (/key|token|password|secret|credential/i.test(key)) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = value;
      }
    } else if (typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    } else {
      sanitized[key] = JSON.stringify(value).slice(0, 200);
    }
  }

  return sanitized;
}

function _redactPath(filePath) {
  if (!filePath) return filePath;
  // Replace home dir with ~
  const home = os.homedir();
  if (filePath.startsWith(home)) return "~" + filePath.slice(home.length);
  return filePath;
}

// ── Singleton ────────────────────────────────────────────────

let _auditLogger = null;

function getAuditLogger() {
  if (!_auditLogger) _auditLogger = new AuditLogger();
  return _auditLogger;
}

// ── Exports ──────────────────────────────────────────────────

export {
  AuditLogger,
  EVENT_TYPES,
  getAuditLogger,
  createEvent,
};
