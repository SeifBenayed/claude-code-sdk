// src/agent-metrics.mjs — JSONL tracking of Agent invocations
//
// Same rotation pattern as skill-metrics.mjs.
// Storage: ensureMemoryDir(cwd)/agent-metrics.jsonl (project-scoped)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log, ensureMemoryDir } from "./utils.mjs";

const AGENT_METRICS_FILE = "agent-metrics.jsonl";
const AGENT_MAX_LINES = 5000;
const AGENT_TRIM_TO = 3000;

function _agentMetricsDir(cwd) {
  return ensureMemoryDir(cwd);
}

function _agentRotateIfNeeded(fp) {
  try {
    const content = fs.readFileSync(fp, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > AGENT_MAX_LINES) {
      const trimmed = lines.slice(lines.length - AGENT_TRIM_TO);
      fs.writeFileSync(fp, trimmed.join("\n") + "\n");
      log(`[agent-metrics] rotated ${lines.length} → ${AGENT_TRIM_TO} lines`);
    }
  } catch { /* ignore */ }
}

function appendAgentMetric(cwd, event) {
  const line = JSON.stringify({
    ...event,
    ts: new Date().toISOString(),
  });
  const fp = path.join(_agentMetricsDir(cwd), AGENT_METRICS_FILE);
  try {
    fs.appendFileSync(fp, line + "\n");
    _agentRotateIfNeeded(fp);
  } catch (e) {
    log(`[agent-metrics] append error: ${e.message}`);
  }
}

function readAgentMetrics(cwd, opts) {
  const since = opts?.since;
  const fp = path.join(_agentMetricsDir(cwd), AGENT_METRICS_FILE);
  try {
    const content = fs.readFileSync(fp, "utf-8");
    let events = content.split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    if (since) {
      const sinceDate = new Date(since);
      events = events.filter(e => new Date(e.ts) >= sinceDate);
    }
    return events;
  } catch {
    return [];
  }
}

function summarizeAgentMetrics(events) {
  const byAgent = new Map();
  for (const e of events) {
    const key = e.agent_name || "unknown";
    if (!byAgent.has(key)) {
      byAgent.set(key, { agent: key, uses: 0, errors: 0, total_turns: 0, total_duration_ms: 0, counted: 0 });
    }
    const entry = byAgent.get(key);
    entry.uses++;
    if (e.is_error === true) entry.errors++;
    if (typeof e.turns === "number") { entry.total_turns += e.turns; entry.counted++; }
    if (typeof e.duration_ms === "number") entry.total_duration_ms += e.duration_ms;
  }
  return [...byAgent.entries()].map(([, v]) => ({
    agent: v.agent,
    uses: v.uses,
    errors: v.errors,
    avg_turns: v.counted > 0 ? Math.round(v.total_turns / v.counted) : 0,
    avg_duration_ms: v.counted > 0 ? Math.round(v.total_duration_ms / v.counted) : 0,
  })).sort((a, b) => b.uses - a.uses);
}

export {
  appendAgentMetric,
  readAgentMetrics,
  summarizeAgentMetrics,
  AGENT_METRICS_FILE,
};
