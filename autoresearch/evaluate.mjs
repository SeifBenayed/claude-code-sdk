#!/usr/bin/env node
// evaluate.mjs — Autoresearch benchmark evaluator for cloclo
// Runs N tasks from benchmark-1000.json, scores results, outputs scorecard

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CLOCLO = path.join(process.env.HOME, "claude-tool-loop", "claude-native.mjs");
const BENCH_FILE = path.join(import.meta.dirname, "benchmark-1000.json");
const RESULTS_DIR = path.join(import.meta.dirname, "results");
const SANDBOX = path.join(import.meta.dirname, "sandbox");

// ── Config ──────────────────────────────────────────────────────
const TIER_TIMEOUTS = { T1: 15000, T2: 30000, T3: 60000, T4: 90000 };
const WEIGHTS = { correctness: 0.35, tool_usage: 0.25, speed: 0.15, token_efficiency: 0.15, error_recovery: 0.10 };

// ── Helpers ─────────────────────────────────────────────────────
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function runCloclo(prompt, timeout = 30000) {
  const start = Date.now();
  try {
    const out = execSync(`node ${CLOCLO} -p ${JSON.stringify(prompt)}`, {
      timeout,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: SANDBOX,
    });
    return { output: out.trim(), time: Date.now() - start, tokens: out.length, error: null };
  } catch (e) {
    return { output: e.stdout?.trim() || "", time: Date.now() - start, tokens: 0, error: e.message };
  }
}

function runVerify(cmd) {
  try {
    execSync(cmd, { cwd: SANDBOX, timeout: 10000, stdio: "pipe" });
    return true;
  } catch { return false; }
}

function runSetup(cmd) {
  if (!cmd) return;
  try { execSync(cmd, { cwd: SANDBOX, timeout: 10000, stdio: "pipe" }); } catch {}
}

// ── Scoring ─────────────────────────────────────────────────────
function scoreTask(task, result) {
  const scores = { correctness: 0, tool_usage: 0, speed: 0, token_efficiency: 0, error_recovery: 0 };

  // Correctness: keyword match or verify command
  if (task.verify) {
    scores.correctness = runVerify(task.verify) ? 1 : 0;
  } else if (task.expected_keywords?.length) {
    const lower = result.output.toLowerCase();
    const matched = task.expected_keywords.filter(k => lower.includes(k.toLowerCase()));
    scores.correctness = matched.length / task.expected_keywords.length;
  } else if (task.expected_output) {
    scores.correctness = new RegExp(task.expected_output, "i").test(result.output) ? 1 : 0;
  }

  // Tool usage: did it actually use tools when required?
  if (task.tools_required?.length) {
    const toolSignals = {
      bash: /\$|```bash|```sh|executed|running/i,
      file_read: /reading|file content|```[\w]*\n/i,
      file_write: /created|wrote|saved to/i,
      grep: /found|matches|search result/i,
      web_fetch: /fetched|retrieved|webpage/i,
      git: /commit|branch|diff|log/i,
    };
    let toolHits = 0;
    for (const t of task.tools_required) {
      if (toolSignals[t]?.test(result.output)) toolHits++;
    }
    scores.tool_usage = task.tools_required.length ? toolHits / task.tools_required.length : 1;
  } else {
    scores.tool_usage = 1; // no tools required = full marks
  }

  // Speed: relative to tier timeout
  const timeout = TIER_TIMEOUTS[task.tier] || 30000;
  const speedRatio = 1 - Math.min(result.time / timeout, 1);
  scores.speed = speedRatio;

  // Token efficiency: penalize verbose responses for simple tasks
  const expectedLen = task.tier === "T1" ? 500 : task.tier === "T2" ? 1500 : task.tier === "T3" ? 3000 : 5000;
  scores.token_efficiency = Math.min(1, expectedLen / Math.max(result.tokens, 1));

  // Error recovery
  scores.error_recovery = result.error ? 0 : 1;

  // Weighted total
  const total = Object.entries(WEIGHTS).reduce((sum, [k, w]) => sum + scores[k] * w, 0);

  return { ...scores, total, tier_weight: task.tier === "T1" ? 1 : task.tier === "T2" ? 2 : task.tier === "T3" ? 3 : 4 };
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const tierFilter = args.find(a => a.startsWith("--tier="))?.split("=")[1];
  const limit = parseInt(args.find(a => a.startsWith("--limit="))?.split("=")[1] || "0");
  const startFrom = parseInt(args.find(a => a.startsWith("--from="))?.split("=")[1] || "1");
  const genLabel = args.find(a => a.startsWith("--gen="))?.split("=")[1] || `gen_${Date.now()}`;

  if (!fs.existsSync(BENCH_FILE)) {
    console.error("benchmark-1000.json not found. Populate tasks first.");
    process.exit(1);
  }

  ensureDir(RESULTS_DIR);
  ensureDir(SANDBOX);

  const benchmark = JSON.parse(fs.readFileSync(BENCH_FILE, "utf-8"));
  let tasks = benchmark.tasks;

  if (tierFilter) tasks = tasks.filter(t => t.tier === tierFilter);
  if (startFrom > 1) tasks = tasks.filter(t => t.id >= startFrom);
  if (limit) tasks = tasks.slice(0, limit);

  console.log(`\n🏁 Running ${tasks.length} tasks [${genLabel}]\n`);

  const results = [];
  let totalScore = 0;
  const categoryScores = {};

  for (const task of tasks) {
    process.stdout.write(`  [${task.id}/${benchmark.tasks.length}] ${task.category} — ${task.task.slice(0, 60)}...`);

    // Setup sandbox
    runSetup(task.setup);

    // Run cloclo
    const timeout = TIER_TIMEOUTS[task.tier] || 30000;
    const result = runCloclo(task.task, timeout);

    // Score
    const score = scoreTask(task, result);
    totalScore += score.total;

    // Track by category
    if (!categoryScores[task.category]) categoryScores[task.category] = { sum: 0, count: 0 };
    categoryScores[task.category].sum += score.total;
    categoryScores[task.category].count++;

    results.push({ id: task.id, tier: task.tier, category: task.category, score, time: result.time, error: result.error });

    const icon = score.total >= 0.8 ? "✅" : score.total >= 0.5 ? "⚠️" : "❌";
    console.log(` ${icon} ${(score.total * 100).toFixed(1)}%  (${result.time}ms)`);
  }

  // ── Summary ─────────────────────────────────────────────────
  const avgScore = totalScore / tasks.length;

  console.log("\n" + "═".repeat(60));
  console.log(`  GENERATION: ${genLabel}`);
  console.log(`  TASKS RUN:  ${tasks.length}`);
  console.log(`  SCORE:      ${(avgScore * 100).toFixed(2)}% (${(totalScore).toFixed(1)}/${tasks.length})`);
  console.log("═".repeat(60));

  console.log("\n  Category Breakdown:");
  for (const [cat, data] of Object.entries(categoryScores).sort((a, b) => a[1].sum / a[1].count - b[1].sum / b[1].count)) {
    const avg = (data.sum / data.count * 100).toFixed(1);
    const bar = "█".repeat(Math.round(data.sum / data.count * 20)) + "░".repeat(20 - Math.round(data.sum / data.count * 20));
    console.log(`    ${cat.padEnd(25)} ${bar} ${avg}%`);
  }

  // Save results
  const resultFile = path.join(RESULTS_DIR, `${genLabel}.json`);
  fs.writeFileSync(resultFile, JSON.stringify({
    generation: genLabel,
    timestamp: new Date().toISOString(),
    tasks_run: tasks.length,
    avg_score: avgScore,
    category_scores: categoryScores,
    results,
  }, null, 2));

  console.log(`\n  Results saved to ${resultFile}\n`);
  return avgScore;
}

main().catch(console.error);
