#!/usr/bin/env node
// Agent 2 — Reference Answer Generator
// Runs all benchmark tasks through a reference model to establish ground truth
// Output: ground-truth.json
// IMPORTANT: Defaults to GPT-5.4 via cloclo so the pipeline still works without Claude quota

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIR = import.meta.dirname;
const BENCH_FILE = path.join(DIR, "benchmark-1000.json");
const GT_FILE = path.join(DIR, "ground-truth.json");
const CLOCLO_ANSWERS = path.join(DIR, "cloclo-answers.json");
const SANDBOX = path.join(DIR, "sandbox");
const CLOCLO = path.join(process.env.HOME, "claude-tool-loop", "claude-native.mjs");
const MODE = process.argv[2] || "groundtruth";
const SELECTED_MODEL = process.argv.find(a => a.startsWith("--model="))?.split("=")[1]
  || process.env.AUTORESEARCH_MODEL
  || "gpt-5.4";

// ── Config ──────────────────────────────────────────────────────
const REFERENCE_CMD = `node ${CLOCLO} --model ${SELECTED_MODEL} -p`;
const CANDIDATE_CMD = `node ${CLOCLO} --model ${SELECTED_MODEL} -p`;

const TIER_TIMEOUTS = { T1: 20000, T2: 45000, T3: 90000, T4: 120000 };

// ── Helpers ─────────────────────────────────────────────────────
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function runCommand(cmd, prompt, timeout = 30000) {
  const start = Date.now();
  try {
    const out = execSync(`${cmd} ${JSON.stringify(prompt)}`, {
      timeout,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: SANDBOX,
    });
    return { output: out.trim(), time: Date.now() - start, error: null };
  } catch (e) {
    return { output: e.stdout?.trim() || "", time: Date.now() - start, error: e.message?.slice(0, 200) };
  }
}

// ── Main: Generate Ground Truth ─────────────────────────────────
async function generateGroundTruth() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  AGENT 2: GROUND TRUTH GENERATOR             ║");
  console.log("╚══════════════════════════════════════════════╝\n");
  console.log(`  Using reference model: ${SELECTED_MODEL}`);
  console.log(`  Command: ${REFERENCE_CMD}\n`);

  if (!fs.existsSync(BENCH_FILE)) {
    console.error("❌ benchmark-1000.json not found. Run agent1-generate.mjs first.");
    process.exit(1);
  }

  ensureDir(SANDBOX);
  const benchmark = JSON.parse(fs.readFileSync(BENCH_FILE, "utf-8"));

  // Resume support: load existing progress
  let groundTruth = {};
  if (fs.existsSync(GT_FILE)) {
    groundTruth = JSON.parse(fs.readFileSync(GT_FILE, "utf-8"));
    console.log(`  Resuming: ${Object.keys(groundTruth.answers || {}).length} already done\n`);
  } else {
    groundTruth = { generated_by: SELECTED_MODEL, generated_at: null, answers: {} };
  }

  const tasks = benchmark.tasks;
  let done = 0;
  const total = tasks.length;

  for (const task of tasks) {
    // Skip already completed
    if (groundTruth.answers[task.id]) {
      done++;
      continue;
    }

    const timeout = TIER_TIMEOUTS[task.tier] || 30000;
    process.stdout.write(`  [${task.id}/${total}] ${task.tier} ${task.category} — ${task.task.slice(0, 50)}...`);

    const result = runCommand(REFERENCE_CMD, task.task, timeout);

    groundTruth.answers[task.id] = {
      id: task.id,
      tier: task.tier,
      category: task.category,
      task: task.task,
      answer: result.output,
      time: result.time,
      error: result.error,
    };

    done++;
    const icon = result.error ? "⚠️" : "✅";
    console.log(` ${icon} ${result.time}ms`);

    // Save progress every 10 tasks
    if (done % 10 === 0) {
      groundTruth.generated_at = new Date().toISOString();
      fs.writeFileSync(GT_FILE, JSON.stringify(groundTruth, null, 2));
    }
  }

  groundTruth.generated_at = new Date().toISOString();
  groundTruth.total = Object.keys(groundTruth.answers).length;
  fs.writeFileSync(GT_FILE, JSON.stringify(groundTruth, null, 2));
  console.log(`\n✅ Ground truth saved: ${groundTruth.total} answers → ${GT_FILE}`);
}

// ── Main: Run Cloclo ────────────────────────────────────────────
async function runCloclo() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  AGENT 2B: CLOCLO ANSWER GENERATOR           ║");
  console.log("╚══════════════════════════════════════════════╝\n");
  console.log(`  Using candidate model: ${SELECTED_MODEL}\n`);

  if (!fs.existsSync(BENCH_FILE)) {
    console.error("❌ benchmark-1000.json not found.");
    process.exit(1);
  }

  ensureDir(SANDBOX);
  const benchmark = JSON.parse(fs.readFileSync(BENCH_FILE, "utf-8"));

  // Resume support
  let answers = {};
  if (fs.existsSync(CLOCLO_ANSWERS)) {
    answers = JSON.parse(fs.readFileSync(CLOCLO_ANSWERS, "utf-8"));
    console.log(`  Resuming: ${Object.keys(answers.answers || {}).length} already done\n`);
  } else {
    answers = { generated_by: `cloclo:${SELECTED_MODEL}`, generated_at: null, answers: {} };
  }

  const tasks = benchmark.tasks;
  let done = 0;

  for (const task of tasks) {
    if (answers.answers[task.id]) { done++; continue; }

    const timeout = TIER_TIMEOUTS[task.tier] || 30000;
    process.stdout.write(`  [${task.id}/${tasks.length}] ${task.tier} ${task.category} — ${task.task.slice(0, 50)}...`);

    const result = runCommand(CANDIDATE_CMD, task.task, timeout);

    answers.answers[task.id] = {
      id: task.id,
      answer: result.output,
      time: result.time,
      error: result.error,
    };

    done++;
    const icon = result.error ? "⚠️" : "✅";
    console.log(` ${icon} ${result.time}ms`);

    if (done % 10 === 0) {
      answers.generated_at = new Date().toISOString();
      fs.writeFileSync(CLOCLO_ANSWERS, JSON.stringify(answers, null, 2));
    }
  }

  answers.generated_at = new Date().toISOString();
  answers.total = Object.keys(answers.answers).length;
  fs.writeFileSync(CLOCLO_ANSWERS, JSON.stringify(answers, null, 2));
  console.log(`\n✅ Cloclo answers saved: ${answers.total} → ${CLOCLO_ANSWERS}`);
}

// ── CLI ─────────────────────────────────────────────────────────
if (MODE === "groundtruth" || MODE === "gt") {
  generateGroundTruth().catch(console.error);
} else if (MODE === "cloclo") {
  runCloclo().catch(console.error);
} else {
  console.log("Usage:");
  console.log("  node agent2-groundtruth.mjs groundtruth --model=gpt-5.4   # Run reference model");
  console.log("  node agent2-groundtruth.mjs cloclo --model=gpt-5.4        # Run candidate model");
}
