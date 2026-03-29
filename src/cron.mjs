// src/cron.mjs — Scheduled task execution for cloclo
//
// Usage:
//   cloclo cron add "check CI status" --every 5m
//   cloclo cron add "run /qa" --every 1h --skill qa
//   cloclo cron list
//   cloclo cron remove <id>
//   cloclo cron run           (tick — execute due jobs)
//
// Storage: ~/.claude-native/cron/jobs.json
// Lock:    ~/.claude-native/cron/.lock (prevents concurrent execution)
//
// Design (inspired by hermes-agent):
//   - File-based lock prevents concurrent execution
//   - Due jobs advance next_run BEFORE execution (crash-safe)
//   - [SILENT] output suppressed when no changes
//   - Jobs persist across restarts

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "./utils.mjs";

// ── Constants ────────────────────────────────────────────────

const CRON_DIR = path.join(os.homedir(), ".claude-native", "cron");
const JOBS_FILE = path.join(CRON_DIR, "jobs.json");
const LOCK_FILE = path.join(CRON_DIR, ".lock");
const LOG_DIR = path.join(CRON_DIR, "logs");

// ── Interval Parsing ─────────────────────────────────────────

function parseInterval(str) {
  const match = str.match(/^(\d+)\s*(s|sec|m|min|h|hr|hour|d|day)s?$/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case "s": case "sec": return n * 1000;
    case "m": case "min": return n * 60_000;
    case "h": case "hr": case "hour": return n * 3600_000;
    case "d": case "day": return n * 86400_000;
    default: return null;
  }
}

function formatInterval(ms) {
  if (ms < 60_000) return `${ms / 1000}s`;
  if (ms < 3600_000) return `${ms / 60_000}m`;
  if (ms < 86400_000) return `${ms / 3600_000}h`;
  return `${ms / 86400_000}d`;
}

// ── Job Storage ──────────────────────────────────────────────

function _ensureDir() {
  fs.mkdirSync(CRON_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function loadJobs() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, "utf-8"));
  } catch { /* ignore: no jobs file */ return []; }
}

function saveJobs(jobs) {
  _ensureDir();
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

// ── Lock ─────────────────────────────────────────────────────

function acquireLock() {
  _ensureDir();
  try {
    // Check for stale lock (> 10 minutes old)
    if (fs.existsSync(LOCK_FILE)) {
      const stat = fs.statSync(LOCK_FILE);
      if (Date.now() - stat.mtimeMs > 600_000) {
        fs.unlinkSync(LOCK_FILE);
      } else {
        return false;
      }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" });
    return true;
  } catch { /* ignore: lock exists */ return false; }
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ }
}

// ── Job CRUD ─────────────────────────────────────────────────

function addJob(prompt, intervalStr, { skill = null, model = null, cwd = null, silent = false } = {}) {
  const intervalMs = parseInterval(intervalStr);
  if (!intervalMs) return { error: `Invalid interval: "${intervalStr}". Use: 30s, 5m, 1h, 1d` };
  if (intervalMs < 10_000) return { error: "Minimum interval is 10s" };

  const jobs = loadJobs();
  const id = `job-${Date.now().toString(36)}`;
  const job = {
    id,
    prompt,
    interval_ms: intervalMs,
    skill,
    model,
    cwd: cwd || process.cwd(),
    silent,
    next_run: Date.now() + intervalMs,
    last_run: null,
    last_result: null,
    run_count: 0,
    created_at: new Date().toISOString(),
    enabled: true,
  };

  jobs.push(job);
  saveJobs(jobs);

  return { id, interval: formatInterval(intervalMs), next_run: new Date(job.next_run).toISOString() };
}

function removeJob(id) {
  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.id === id);
  if (idx === -1) return false;
  jobs.splice(idx, 1);
  saveJobs(jobs);
  return true;
}

function listJobs() {
  return loadJobs().map(j => ({
    id: j.id,
    prompt: j.prompt.slice(0, 60),
    interval: formatInterval(j.interval_ms),
    next_run: j.next_run ? new Date(j.next_run).toISOString() : null,
    last_run: j.last_run ? new Date(j.last_run).toISOString() : null,
    run_count: j.run_count,
    enabled: j.enabled,
    skill: j.skill,
  }));
}

function toggleJob(id, enabled) {
  const jobs = loadJobs();
  const job = jobs.find(j => j.id === id);
  if (!job) return false;
  job.enabled = enabled;
  saveJobs(jobs);
  return true;
}

// ── Executor ─────────────────────────────────────────────────

async function tick() {
  if (!acquireLock()) {
    log("[cron] Another tick is running, skipping");
    return { ran: 0, skipped: "locked" };
  }

  try {
    const jobs = loadJobs();
    const now = Date.now();
    let ran = 0;

    for (const job of jobs) {
      if (!job.enabled) continue;
      if (job.next_run > now) continue;

      // Advance next_run BEFORE execution (crash-safe)
      job.next_run = now + job.interval_ms;
      job.last_run = now;
      job.run_count++;
      saveJobs(jobs);

      log(`[cron] Running ${job.id}: "${job.prompt.slice(0, 50)}"`);

      try {
        const result = await _executeJob(job);

        // Update result
        const updatedJobs = loadJobs();
        const updatedJob = updatedJobs.find(j => j.id === job.id);
        if (updatedJob) {
          updatedJob.last_result = {
            success: !result.is_error,
            output: result.content.slice(0, 500),
            ts: new Date().toISOString(),
          };
          saveJobs(updatedJobs);
        }

        // Log output
        _logJobRun(job, result);

        // Display output unless silent with no changes
        if (!(job.silent && result.content.includes("[SILENT]"))) {
          process.stderr.write(`\n\x1b[36m[cron:${job.id}]\x1b[0m ${result.content.slice(0, 200)}\n`);
        }

        ran++;
      } catch (e) {
        log(`[cron] Job ${job.id} failed: ${e.message}`);
        _logJobRun(job, { content: `Error: ${e.message}`, is_error: true });
      }
    }

    return { ran, total: jobs.length };
  } finally {
    releaseLock();
  }
}

async function _executeJob(job) {
  // Run cloclo in one-shot mode as a child process
  const args = ["-p", job.prompt, "--yes", "--output", "json"];
  if (job.model) args.push("-m", job.model);

  // Find cloclo binary
  const clocloPath = process.argv[1]; // current script path

  return new Promise((resolve) => {
    const proc = spawn("node", [clocloPath, ...args], {
      cwd: job.cwd,
      timeout: 300_000, // 5 minute max per job
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.stdin.end();

    proc.on("close", (code) => {
      let content = stdout.trim();
      // Try to extract message from JSON output
      try {
        const parsed = JSON.parse(content);
        content = parsed.message || content;
      } catch { /* keep raw output */ }

      resolve({
        content: content || stderr || "(no output)",
        is_error: code !== 0,
      });
    });

    proc.on("error", (e) => {
      resolve({ content: `Spawn error: ${e.message}`, is_error: true });
    });
  });
}

function _logJobRun(job, result) {
  _ensureDir();
  const logFile = path.join(LOG_DIR, `${job.id}.jsonl`);
  const entry = {
    ts: new Date().toISOString(),
    success: !result.is_error,
    output_length: result.content.length,
    output_preview: result.content.slice(0, 200),
  };
  try {
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
  } catch { /* ignore: logging is best-effort */ }
}

// ── CLI Handler ──────────────────────────────────────────────

function handleCronCommand(args) {
  const sub = args[0];

  if (!sub || sub === "list") {
    const jobs = listJobs();
    if (jobs.length === 0) {
      process.stderr.write("No scheduled jobs.\n");
      process.stderr.write('  Add one: cloclo cron add "check CI" --every 5m\n');
      return;
    }
    process.stderr.write("\n  Scheduled Jobs:\n");
    for (const j of jobs) {
      const status = j.enabled ? "\x1b[32menabled\x1b[0m" : "\x1b[31mdisabled\x1b[0m";
      const next = j.next_run ? new Date(j.next_run).toLocaleTimeString() : "—";
      process.stderr.write(`  ${j.id}  ${status}  every ${j.interval}  next: ${next}  runs: ${j.run_count}\n`);
      process.stderr.write(`    \x1b[2m"${j.prompt}"\x1b[0m\n`);
    }
    process.stderr.write("\n");
    return;
  }

  if (sub === "add") {
    const prompt = args[1];
    if (!prompt) { process.stderr.write('Usage: cloclo cron add "prompt" --every <interval>\n'); process.exit(2); }
    let interval = "10m", skill = null, model = null, silent = false;
    for (let i = 2; i < args.length; i++) {
      if (args[i] === "--every" && args[i + 1]) interval = args[++i];
      else if (args[i] === "--skill" && args[i + 1]) skill = args[++i];
      else if (args[i] === "--model" && args[i + 1]) model = args[++i];
      else if (args[i] === "--silent") silent = true;
    }
    const result = addJob(prompt, interval, { skill, model, silent });
    if (result.error) { process.stderr.write(`Error: ${result.error}\n`); process.exit(2); }
    process.stderr.write(`\x1b[32m✓\x1b[0m Job ${result.id} added (every ${result.interval}, next: ${result.next_run})\n`);
    return;
  }

  if (sub === "remove") {
    const id = args[1];
    if (!id) { process.stderr.write("Usage: cloclo cron remove <job-id>\n"); process.exit(2); }
    if (removeJob(id)) { process.stderr.write(`✓ Job ${id} removed\n`); }
    else { process.stderr.write(`Job not found: ${id}\n`); process.exit(1); }
    return;
  }

  if (sub === "enable" || sub === "disable") {
    const id = args[1];
    if (!id) { process.stderr.write(`Usage: cloclo cron ${sub} <job-id>\n`); process.exit(2); }
    if (toggleJob(id, sub === "enable")) { process.stderr.write(`✓ Job ${id} ${sub}d\n`); }
    else { process.stderr.write(`Job not found: ${id}\n`); process.exit(1); }
    return;
  }

  if (sub === "run") {
    tick().then(r => {
      process.stderr.write(`Tick: ${r.ran} jobs executed (${r.total || 0} total)\n`);
      process.exit(0);
    });
    return;
  }

  process.stderr.write(`Unknown cron command: ${sub}\n  Available: list, add, remove, enable, disable, run\n`);
  process.exit(2);
}

// ── Exports ──────────────────────────────────────────────────

export {
  addJob,
  removeJob,
  listJobs,
  toggleJob,
  tick,
  handleCronCommand,
  parseInterval,
  formatInterval,
};
