// src/memory-metrics.mjs — JSONL tracking of memory loads and references
//
// Same rotation pattern as skill-metrics.mjs.
// Storage: getMemoryDir(cwd)/memory-metrics.jsonl  (project)
//          getUserMemoryDir()/memory-metrics.jsonl  (user)

import fs from "node:fs";
import path from "node:path";
import { log, getMemoryDir, ensureMemoryDir, getUserMemoryDir, ensureUserMemoryDir } from "./utils.mjs";

const METRICS_FILE = "memory-metrics.jsonl";
const MAX_LINES = 5000;
const TRIM_TO = 3000;

function _metricsPath(cwd, scope) {
  const dir = scope === "user" ? ensureUserMemoryDir() : ensureMemoryDir(cwd);
  return path.join(dir, METRICS_FILE);
}

function appendMemoryMetric(cwd, scope, event) {
  const line = JSON.stringify({
    ...event,
    scope,
    ts: new Date().toISOString(),
  });
  const fp = _metricsPath(cwd, scope);
  try {
    fs.appendFileSync(fp, line + "\n");
    // Rotation check
    _rotateIfNeeded(fp);
  } catch (e) {
    log(`[memory-metrics] append error: ${e.message}`);
  }
}

function _rotateIfNeeded(fp) {
  try {
    const content = fs.readFileSync(fp, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > MAX_LINES) {
      const trimmed = lines.slice(lines.length - TRIM_TO);
      fs.writeFileSync(fp, trimmed.join("\n") + "\n");
      log(`[memory-metrics] rotated ${lines.length} → ${TRIM_TO} lines`);
    }
  } catch { /* ignore */ }
}

function readMemoryMetrics(cwd, scope, opts) {
  const type = opts?.type;
  const since = opts?.since;
  const fp = _metricsPath(cwd, scope);
  try {
    const content = fs.readFileSync(fp, "utf-8");
    let events = content.split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    if (type) events = events.filter(e => e.type === type);
    if (since) {
      const sinceDate = new Date(since);
      events = events.filter(e => new Date(e.ts) >= sinceDate);
    }
    return events;
  } catch {
    return [];
  }
}

function summarizeMemoryMetrics(cwd, scope) {
  const events = readMemoryMetrics(cwd, scope);
  const byFile = new Map();
  for (const e of events) {
    const key = e.file || e.name || "unknown";
    if (!byFile.has(key)) {
      byFile.set(key, { file: e.file, name: e.name, load_count: 0, last_loaded: null, ref_count: 0, last_referenced: null });
    }
    const entry = byFile.get(key);
    if (e.type === "memory_loaded") {
      entry.load_count++;
      entry.last_loaded = e.ts;
    } else if (e.type === "memory_referenced") {
      entry.ref_count++;
      entry.last_referenced = e.ts;
    }
  }
  return Array.from(byFile.values());
}

export {
  appendMemoryMetric,
  readMemoryMetrics,
  summarizeMemoryMetrics,
  METRICS_FILE,
};
