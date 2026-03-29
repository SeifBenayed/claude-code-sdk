#!/usr/bin/env node
// run-cloclo-parallel.mjs — Run cloclo on benchmark questions
// Usage: node run-cloclo-parallel.mjs [--concurrency 4] [--timeout-ms 0] [--log-every 10] [--gen gen_001]

import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const MODEL = args.find(a => a.startsWith("--model="))?.split("=")[1] || "gpt-5.4";
const CLOCLO = `node ${path.join(process.env.HOME, "claude-tool-loop", "claude-native.mjs")} --model ${MODEL}`;
const BENCH_FILE = path.join(DIR, "benchmark-1000.json");
const GT_FILE = path.join(DIR, "ground-truth.json");
const RESULTS_DIR = path.join(DIR, "results");
const CONCURRENCY = Math.max(1, parseInt(args.find(a => a.startsWith("--concurrency="))?.split("=")[1] || "4", 10) || 4);
const QUESTION_TIMEOUT_MS = Math.max(0, parseInt(args.find(a => a.startsWith("--timeout-ms="))?.split("=")[1] || "0", 10) || 0);
const LOG_EVERY = Math.max(1, parseInt(args.find(a => a.startsWith("--log-every="))?.split("=")[1] || "10", 10) || 10);
const GEN = args.find(a => a.startsWith("--gen="))?.split("=")[1] || `gen_${Date.now()}`;

fs.mkdirSync(RESULTS_DIR, { recursive: true });

const ANSWERS_FILE = path.join(RESULTS_DIR, `${GEN}_cloclo.json`);

// ── Run cloclo with timeout ─────────────────────────────────────
function runCloclo(question, timeout = QUESTION_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const start = Date.now();
    exec(
      `${CLOCLO} -p ${JSON.stringify(question)}`,
      { timeout, encoding: "utf-8", maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        resolve({
          output: (stdout || "").trim(),
          time: Date.now() - start,
          error: err ? true : false,
        });
      }
    );
  });
}

// ── Parallel executor with concurrency limit ────────────────────
async function runParallel(tasks, concurrency, fn) {
  const results = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await fn(tasks[i], i);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
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

  const bench = JSON.parse(fs.readFileSync(BENCH_FILE, "utf-8"));
  const gt = JSON.parse(fs.readFileSync(GT_FILE, "utf-8"));
  const tasks = bench.tasks;
  const totalBatches = Math.ceil(tasks.length / LOG_EVERY);

  console.log(`  Running ${tasks.length} questions with ${CONCURRENCY} workers...\n`);

  let done = 0;
  const answers = {};
  let batchStartAt = Date.now();
  let batchSuccess = 0;
  let batchFail = 0;
  let batchTimeSum = 0;
  let batchTimeMax = 0;

  const results = await runParallel(tasks, CONCURRENCY, async (task, i) => {
    const result = await runCloclo(task.task);
    done++;
    const icon = result.output.length > 10 ? "✅" : "❌";
    if (icon === "✅") batchSuccess++;
    else batchFail++;
    batchTimeSum += result.time;
    batchTimeMax = Math.max(batchTimeMax, result.time);
    if (done % LOG_EVERY === 0 || done === tasks.length) {
      const batchNo = Math.ceil(done / LOG_EVERY);
      const batchCount = batchSuccess + batchFail;
      const avgMs = batchCount > 0 ? Math.round(batchTimeSum / batchCount) : 0;
      const wallMs = Date.now() - batchStartAt;
      console.log(
        `  [${done}/${tasks.length}] batch ${batchNo}/${totalBatches} `
        + `ok=${batchSuccess} fail=${batchFail} avg=${avgMs}ms max=${batchTimeMax}ms `
        + `wall=${wallMs}ms last=${task.category} ${icon} ${result.time}ms`
      );
      batchStartAt = Date.now();
      batchSuccess = 0;
      batchFail = 0;
      batchTimeSum = 0;
      batchTimeMax = 0;
    }
    return { id: task.id, ...result };
  });

  // Build answers map
  for (const r of results) {
    answers[r.id] = { id: r.id, answer: r.output, time: r.time, error: r.error };
  }

  // Save answers
  fs.writeFileSync(ANSWERS_FILE, JSON.stringify({ gen: GEN, answers }, null, 2));

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
