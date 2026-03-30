// src/skill-metrics.mjs — JSONL tracking of Skill tool invocations
//
// Same rotation pattern as memory-metrics.mjs.
// Storage: ensureMemoryDir(cwd)/skill-metrics.jsonl (project-scoped)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log, ensureMemoryDir } from "./utils.mjs";

const SKILL_METRICS_FILE = "skill-metrics.jsonl";
const SKILL_MAX_LINES = 5000;
const SKILL_TRIM_TO = 3000;

function _metricsDir(cwd) {
  return ensureMemoryDir(cwd);
}

function _skillRotateIfNeeded(fp) {
  try {
    const content = fs.readFileSync(fp, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    if (lines.length > SKILL_MAX_LINES) {
      const trimmed = lines.slice(lines.length - SKILL_TRIM_TO);
      fs.writeFileSync(fp, trimmed.join("\n") + "\n");
      log(`[skill-metrics] rotated ${lines.length} → ${SKILL_TRIM_TO} lines`);
    }
  } catch { /* ignore */ }
}

function appendSkillMetric(cwd, event) {
  const line = JSON.stringify({
    ...event,
    ts: new Date().toISOString(),
  });
  const fp = path.join(_metricsDir(cwd), SKILL_METRICS_FILE);
  try {
    fs.appendFileSync(fp, line + "\n");
    _skillRotateIfNeeded(fp);
  } catch (e) {
    log(`[skill-metrics] append error: ${e.message}`);
  }
}

function readSkillMetrics(cwd, opts) {
  const since = opts?.since;
  const fp = path.join(_metricsDir(cwd), SKILL_METRICS_FILE);
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

function summarizeSkillMetrics(events) {
  const bySkill = new Map();
  for (const e of events) {
    const key = e.skill_name || "unknown";
    if (!bySkill.has(key)) {
      bySkill.set(key, { skill: key, uses: 0, not_found: 0, errors: 0 });
    }
    const entry = bySkill.get(key);
    entry.uses++;
    if (e.found === false) entry.not_found++;
    if (e.is_error === true) entry.errors++;
  }
  return [...bySkill.entries()].map(([, v]) => v).sort((a, b) => b.uses - a.uses);
}

export {
  appendSkillMetric,
  readSkillMetrics,
  summarizeSkillMetrics,
  SKILL_METRICS_FILE,
};
