// src/skill-metrics.mjs — Skill invocation telemetry (Phase 1: capture only)
//
// Appends one JSONL line per Skill tool invocation.
// No scoring, no recommendations — just raw data for future analysis.
// Storage: ~/.claude-native/projects/<project>/skill-metrics.jsonl

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "./utils.mjs";

// ── Paths ───────────────────────────────────────────────────────

function _metricsDir(cwd) {
  const sanitized = (cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").slice(0, 100);
  return path.join(os.homedir(), ".claude-native", "projects", sanitized);
}

function _metricsPath(cwd) {
  return path.join(_metricsDir(cwd), "skill-metrics.jsonl");
}

// ── Append ──────────────────────────────────────────────────────

const MAX_LINES = 5000;
const TRIM_TO = 3000;

function appendSkillMetric(cwd, event) {
  const dir = _metricsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const fp = _metricsPath(cwd);

  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    skill_name: event.skill_name,
    args_present: event.args_present ?? false,
    args_preview: (event.args_preview || "").slice(0, 80),
    found: event.found ?? false,
    is_error: event.is_error ?? false,
    session_id: event.session_id || null,
    turn_index: event.turn_index ?? null,
  });

  fs.appendFileSync(fp, line + "\n");

  // Rotation: trim if over MAX_LINES
  try {
    const content = fs.readFileSync(fp, "utf-8");
    const lines = content.trimEnd().split("\n");
    if (lines.length > MAX_LINES) {
      const trimmed = lines.slice(lines.length - TRIM_TO);
      fs.writeFileSync(fp, trimmed.join("\n") + "\n");
      log(`[skill-metrics] Rotated ${lines.length} → ${TRIM_TO} lines`);
    }
  } catch { /* ignore rotation errors */ }
}

// ── Read ────────────────────────────────────────────────────────

function readSkillMetrics(cwd, { since } = {}) {
  const fp = _metricsPath(cwd);
  let content;
  try { content = fs.readFileSync(fp, "utf-8"); } catch { return []; }

  const events = [];
  for (const line of content.trimEnd().split("\n")) {
    if (!line) continue;
    try {
      const evt = JSON.parse(line);
      if (since && evt.timestamp < since) continue;
      events.push(evt);
    } catch { /* skip malformed lines */ }
  }
  return events;
}

// ── Summarize ───────────────────────────────────────────────────

function summarizeSkillMetrics(events) {
  const bySkill = new Map();

  for (const evt of events) {
    const name = evt.skill_name;
    if (!bySkill.has(name)) {
      bySkill.set(name, { uses: 0, not_found: 0, errors: 0 });
    }
    const s = bySkill.get(name);
    s.uses++;
    if (!evt.found) s.not_found++;
    if (evt.is_error) s.errors++;
  }

  // Convert to sorted array (most used first)
  return [...bySkill.entries()]
    .sort((a, b) => b[1].uses - a[1].uses)
    .map(([name, stats]) => ({ skill: name, ...stats }));
}

// ── Exports ─────────────────────────────────────────────────────

export { appendSkillMetric, readSkillMetrics, summarizeSkillMetrics };
