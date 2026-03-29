#!/usr/bin/env node
// run-cloclo-parallel.mjs — Run cloclo on benchmark questions
// Usage: node run-cloclo-parallel.mjs [--concurrency 4] [--timeout-ms 600000] [--log-every 10] [--gen gen_001]

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const MODEL = args.find(a => a.startsWith("--model="))?.split("=")[1] || "gpt-5.4";
const PROJECT_DIR = path.join(process.env.HOME, "claude-tool-loop");
const CLOCLO_ENTRY = path.join(PROJECT_DIR, "claude-native.mjs");
const BENCH_FILE = path.join(DIR, "benchmark-1000.json");
const GT_FILE = path.join(DIR, "ground-truth.json");
const RESULTS_DIR = path.join(DIR, "results");
const CONCURRENCY = Math.max(1, parseInt(args.find(a => a.startsWith("--concurrency="))?.split("=")[1] || "4", 10) || 4);
const QUESTION_TIMEOUT_MS = Math.max(0, parseInt(args.find(a => a.startsWith("--timeout-ms="))?.split("=")[1] || "600000", 10) || 0);
const LOG_EVERY = Math.max(1, parseInt(args.find(a => a.startsWith("--log-every="))?.split("=")[1] || "10", 10) || 10);
const CHECKPOINT_EVERY = Math.max(1, parseInt(args.find(a => a.startsWith("--checkpoint-every="))?.split("=")[1] || "1", 10) || 1);
const RETRIES = Math.max(0, parseInt(args.find(a => a.startsWith("--retries="))?.split("=")[1] || "2", 10) || 0);
const GEN = args.find(a => a.startsWith("--gen="))?.split("=")[1] || `gen_${Date.now()}`;

fs.mkdirSync(RESULTS_DIR, { recursive: true });

const ANSWERS_FILE = path.join(RESULTS_DIR, `${GEN}_cloclo.json`);
const ANSWERS_TMP_FILE = `${ANSWERS_FILE}.tmp`;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function loadCheckpoint() {
  if (!fs.existsSync(ANSWERS_FILE)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(ANSWERS_FILE, "utf-8"));
    return parsed.answers && typeof parsed.answers === "object" ? parsed.answers : {};
  } catch {
    return {};
  }
}

function saveCheckpoint(answers, total) {
  const payload = {
    gen: GEN,
    model: MODEL,
    total,
    completed: Object.keys(answers).length,
    updatedAt: new Date().toISOString(),
    answers,
  };
  fs.writeFileSync(ANSWERS_TMP_FILE, JSON.stringify(payload, null, 2));
  fs.renameSync(ANSWERS_TMP_FILE, ANSWERS_FILE);
}

// ── Run cloclo with timeout and retry ───────────────────────────
function runClocloOnce(question, timeout = QUESTION_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, [CLOCLO_ENTRY, "--model", MODEL, "-p", question], {
      cwd: PROJECT_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };

    if (timeout > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }, 5000).unref();
      }, timeout);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      finish({
        output: stdout.trim(),
        stderr: stderr.trim(),
        time: Date.now() - start,
        error: true,
        exitCode: null,
        signal: null,
        timedOut,
        errorMessage: err.message,
      });
    });

    child.on("close", (code, signal) => {
      finish({
        output: stdout.trim(),
        stderr: stderr.trim(),
        time: Date.now() - start,
        error: code !== 0 || signal !== null || timedOut,
        exitCode: code,
        signal,
        timedOut,
        errorMessage: code === 0 && !signal && !timedOut ? "" : stderr.trim() || `exitCode=${code ?? "null"} signal=${signal ?? "null"}`,
      });
    });
  });
}

async function runCloclo(question, timeout = QUESTION_TIMEOUT_MS, retries = RETRIES) {
  let lastResult = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await runClocloOnce(question, timeout);
    lastResult = { ...result, attempts: attempt + 1 };
    if (!result.error && result.output.length > 0) return lastResult;
    if (attempt < retries) {
      await sleep(Math.min(5000, 1000 * (attempt + 1)));
    }
  }
  return lastResult || {
    output: "",
    stderr: "",
    time: 0,
    error: true,
    exitCode: null,
    signal: null,
    timedOut: false,
    errorMessage: "unknown error",
    attempts: retries + 1,
  };
}

// ── Parallel executor with concurrency limit ────────────────────
async function runParallel(tasks, concurrency, fn) {
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      await fn(tasks[i], i);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

// ── Score against ground truth ──────────────────────────────────
function scoreAnswers(answers, gt) {
  let totalScore = 0;
  let count = 0;
  const catScores = {};
  const tierScores = {};

  for (const [id, ans] of Object.entries(answers)) {
    const ref = gt.answers[id];
    if (!ref) continue;

    // Keyword overlap
    const refWords = new Set(ref.answer.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    const ansWords = new Set(ans.answer.toLowerCase().split(/\W+/).filter(w => w.length > 3));
    let overlap = 0;
    for (const w of ansWords) { if (refWords.has(w)) overlap++; }
    const keywordScore = refWords.size > 0 ? Math.min(overlap / refWords.size, 1) : 0;

    // Length similarity
    const lenRatio = Math.min(ans.answer.length, ref.answer.length) / Math.max(ans.answer.length, ref.answer.length, 1);

    // Non-empty bonus
    const nonEmpty = ans.answer.length > 10 ? 1 : 0;

    const score = keywordScore * 0.6 + lenRatio * 0.2 + nonEmpty * 0.2;

    totalScore += score;
    count++;

    const cat = ref.category || "unknown";
    if (!catScores[cat]) catScores[cat] = { sum: 0, count: 0 };
    catScores[cat].sum += score;
    catScores[cat].count++;

    const tier = ref.tier || "T1";
    if (!tierScores[tier]) tierScores[tier] = { sum: 0, count: 0 };
    tierScores[tier].sum += score;
    tierScores[tier].count++;
  }

  return {
    avgScore: count > 0 ? totalScore / count : 0,
    count,
    catScores,
    tierScores,
  };
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔═══════════════════════════════════════════════════╗`);
  console.log(`║  CLOCLO BENCHMARK RUN [${GEN}]`);
  console.log(`║  Concurrency: ${CONCURRENCY} query at a time`);
  console.log(`╚═══════════════════════════════════════════════════╝\n`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  Per-question timeout: ${QUESTION_TIMEOUT_MS > 0 ? `${QUESTION_TIMEOUT_MS}ms` : "disabled"}\n`);
  console.log(`  Batch log size: ${LOG_EVERY}\n`);
  console.log(`  Retries per question: ${RETRIES}`);
  console.log(`  Checkpoint cadence: every ${CHECKPOINT_EVERY} result(s)\n`);

  const bench = JSON.parse(fs.readFileSync(BENCH_FILE, "utf-8"));
  const gt = JSON.parse(fs.readFileSync(GT_FILE, "utf-8"));
  const tasks = bench.tasks;
  const totalBatches = Math.ceil(tasks.length / LOG_EVERY);
  const answers = loadCheckpoint();
  const completedIds = new Set(Object.keys(answers));
  const pendingTasks = tasks.filter(task => !completedIds.has(String(task.id)));

  if (completedIds.size > 0) {
    console.log(`  Resuming from checkpoint: ${completedIds.size}/${tasks.length} answers already saved.\n`);
  }
  console.log(`  Running ${pendingTasks.length} pending questions with ${CONCURRENCY} workers...\n`);

  let done = completedIds.size;
  let batchStartAt = Date.now();
  let batchOk = 0;
  let batchEmpty = 0;
  let batchError = 0;
  let batchTimeSum = 0;
  let batchTimeMax = 0;

  const persistNow = () => saveCheckpoint(answers, tasks.length);
  const handleSignal = (signal) => {
    console.log(`\n  Received ${signal}. Saving checkpoint and exiting...`);
    persistNow();
    process.exit(130);
  };
  process.once("SIGINT", () => handleSignal("SIGINT"));
  process.once("SIGTERM", () => handleSignal("SIGTERM"));

  await runParallel(pendingTasks, CONCURRENCY, async (task) => {
    const result = await runCloclo(task.task);
    done++;
    const icon = !result.error && result.output.length > 0 ? "✅" : "❌";
    if (result.error) batchError++;
    else if (result.output.length === 0) batchEmpty++;
    else batchOk++;
    batchTimeSum += result.time;
    batchTimeMax = Math.max(batchTimeMax, result.time);
    answers[task.id] = {
      id: task.id,
      answer: result.output,
      time: result.time,
      error: result.error,
      attempts: result.attempts,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      errorMessage: result.error ? result.errorMessage : "",
      stderr: result.error ? result.stderr : "",
    };

    if (done % CHECKPOINT_EVERY === 0 || done === tasks.length) {
      persistNow();
    }

    if (done % LOG_EVERY === 0 || done === tasks.length) {
      const batchNo = Math.ceil(done / LOG_EVERY);
      const batchCount = batchOk + batchEmpty + batchError;
      const avgMs = batchCount > 0 ? Math.round(batchTimeSum / batchCount) : 0;
      const wallMs = Date.now() - batchStartAt;
      console.log(
        `  [${done}/${tasks.length}] batch ${batchNo}/${totalBatches} `
        + `ok=${batchOk} empty=${batchEmpty} err=${batchError} avg=${avgMs}ms max=${batchTimeMax}ms `
        + `wall=${wallMs}ms last=${task.category} ${icon} ${result.time}ms attempts=${result.attempts}`
      );
      batchStartAt = Date.now();
      batchOk = 0;
      batchEmpty = 0;
      batchError = 0;
      batchTimeSum = 0;
      batchTimeMax = 0;
    }
  });

  // Final save
  persistNow();

  // Score
  const scores = scoreAnswers(answers, gt);

  // Print results
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SCORE: ${(scores.avgScore * 100).toFixed(2)}% (${scores.count} questions)`);
  console.log(`${"═".repeat(60)}`);

  console.log(`\n  Tier Breakdown:`);
  for (const [tier, d] of Object.entries(scores.tierScores).sort()) {
    const pct = (d.sum / d.count * 100).toFixed(1);
    const bar = "█".repeat(Math.round(d.sum / d.count * 20)) + "░".repeat(20 - Math.round(d.sum / d.count * 20));
    console.log(`    ${tier.padEnd(4)} ${bar} ${pct}%`);
  }

  console.log(`\n  Weakest Categories:`);
  const sorted = Object.entries(scores.catScores).sort((a, b) => a[1].sum / a[1].count - b[1].sum / b[1].count);
  for (const [cat, d] of sorted.slice(0, 5)) {
    console.log(`    ${cat.padEnd(22)} ${(d.sum / d.count * 100).toFixed(1)}%`);
  }

  // Save scores
  const scoresFile = path.join(RESULTS_DIR, `${GEN}_scores.json`);
  fs.writeFileSync(scoresFile, JSON.stringify({
    gen: GEN,
    score: scores.avgScore * 100,
    ...scores,
    timestamp: new Date().toISOString(),
    weakest: sorted[0]?.[0],
  }, null, 2));

  console.log(`\n  Results → ${ANSWERS_FILE}`);
  console.log(`  Scores  → ${scoresFile}\n`);

  // Output score for evolve.sh
  process.stdout.write(`SCORE:${(scores.avgScore * 100).toFixed(2)}`);
}

main().catch(console.error);
