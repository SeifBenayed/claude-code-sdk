#!/usr/bin/env node
// Agent 3 — The Judge (DIFFERENT model to avoid bias)
// Compares cloclo answers vs ground truth, scores objectively
// MUST use a different provider than Agent 2 to prevent bias
// Default: uses OpenAI (GPT) or any non-Anthropic model as judge

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIR = import.meta.dirname;
const GT_FILE = path.join(DIR, "ground-truth.json");
const CLOCLO_FILE = path.join(DIR, "cloclo-answers.json");
const RESULTS_DIR = path.join(DIR, "results");
const SCORES_FILE = path.join(DIR, "scores.json");

const CLOCLO = path.join(process.env.HOME, "claude-tool-loop", "claude-native.mjs");

// ── Judge Model Config ──────────────────────────────────────────
// The judge MUST be a different provider than the ground truth generator
// to avoid bias. Default: OpenAI GPT. Override with --judge-model flag.
const JUDGE_MODEL = process.argv.find(a => a.startsWith("--judge-model="))?.split("=")[1]
  || process.env.JUDGE_MODEL
  || "gpt-5.4";
const JUDGE_TIMEOUT_MS = Math.max(
  0,
  parseInt(
    process.argv.find(a => a.startsWith("--timeout-ms="))?.split("=")[1]
      || process.env.JUDGE_TIMEOUT_MS
      || "0",
    10
  ) || 0
);

const JUDGE_CMD = `node ${CLOCLO} --model ${JUDGE_MODEL} -p`;

// ── Helpers ─────────────────────────────────────────────────────
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function askJudge(prompt, timeout = 30000) {
  try {
    return execSync(`${JUDGE_CMD} ${JSON.stringify(prompt)}`, {
      timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    return e.stdout?.trim() || "JUDGE_ERROR";
  }
}

function parseScore(response) {
  // Extract score from judge response (expects 0-10)
  const match = response.match(/\b(\d+(?:\.\d+)?)\s*\/\s*10\b/)
    || response.match(/score[:\s]*(\d+(?:\.\d+)?)/i)
    || response.match(/\b([0-9]|10)(?:\.\d+)?\b/);
  return match ? Math.min(parseFloat(match[1]), 10) / 10 : 0.5;
}

// ── Main ────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  AGENT 3: THE JUDGE (NEUTRAL EVALUATOR)      ║");
  console.log(`║  Judge model: ${JUDGE_MODEL.padEnd(30)}║`);
  console.log("╚══════════════════════════════════════════════╝\n");

  if (!fs.existsSync(GT_FILE)) {
    console.error("❌ ground-truth.json not found. Run agent2 groundtruth first.");
    process.exit(1);
  }
  if (!fs.existsSync(CLOCLO_FILE)) {
    console.error("❌ cloclo-answers.json not found. Run agent2 cloclo first.");
    process.exit(1);
  }

  ensureDir(RESULTS_DIR);

  const gt = JSON.parse(fs.readFileSync(GT_FILE, "utf-8"));
  const cloclo = JSON.parse(fs.readFileSync(CLOCLO_FILE, "utf-8"));

  // Resume support
  let scores = {};
  if (fs.existsSync(SCORES_FILE)) {
    scores = JSON.parse(fs.readFileSync(SCORES_FILE, "utf-8"));
    console.log(`  Resuming: ${Object.keys(scores.judgments || {}).length} already judged\n`);
  } else {
    scores = {
      judge_model: JUDGE_MODEL,
      judged_at: null,
      total_score: 0,
      max_score: 0,
      judgments: {},
      category_scores: {},
      tier_scores: {},
    };
  }

  const taskIds = Object.keys(gt.answers).filter(id => cloclo.answers[id]);
  let judged = 0;
  let totalScore = 0;

  for (const id of taskIds) {
    if (scores.judgments[id]) {
      totalScore += scores.judgments[id].score;
      judged++;
      continue;
    }

    const gtAnswer = gt.answers[id];
    const clocloAnswer = cloclo.answers[id];

    process.stdout.write(`  [${id}/${taskIds.length}] ${gtAnswer.tier} ${gtAnswer.category} — ${gtAnswer.task.slice(0, 45)}...`);

    // Ask the judge to compare
    const judgePrompt = `You are a neutral, objective judge comparing two AI answers to the same question.

TASK: ${gtAnswer.task}

REFERENCE ANSWER (ground truth):
${gtAnswer.answer.slice(0, 6000)}

CANDIDATE ANSWER (to evaluate):
${clocloAnswer.answer.slice(0, 6000)}

Score the CANDIDATE answer from 0 to 10:
- 10 = same quality or better than reference
- 7-9 = correct but less complete or less well-structured
- 4-6 = partially correct, missing key elements
- 1-3 = mostly wrong or very incomplete
- 0 = completely wrong or empty

For build/test or shell tasks, give strong credit when the candidate includes runnable code or commands, explicit tests/assertions, edge-case handling, and clear expected behavior, even if formatting differs from the reference.
Do not penalize concise answers just because they are shorter than the reference.
Penalize answers that ask unnecessary clarification when the task already provides enough information.

Consider: correctness, completeness, code quality (if code), clarity, practical usefulness, and whether the answer would likely work as given.

Reply with ONLY: "Score: X/10" followed by a ONE sentence justification.`;

    const judgeResponse = askJudge(judgePrompt, JUDGE_TIMEOUT_MS);
    const score = parseScore(judgeResponse);

    scores.judgments[id] = {
      id: parseInt(id),
      tier: gtAnswer.tier,
      category: gtAnswer.category,
      score,
      judge_response: judgeResponse.slice(0, 300),
      cloclo_time: clocloAnswer.time,
      gt_time: gtAnswer.time,
    };

    totalScore += score;
    judged++;

    // Track by category
    if (!scores.category_scores[gtAnswer.category]) {
      scores.category_scores[gtAnswer.category] = { sum: 0, count: 0 };
    }
    scores.category_scores[gtAnswer.category].sum += score;
    scores.category_scores[gtAnswer.category].count++;

    // Track by tier
    if (!scores.tier_scores[gtAnswer.tier]) {
      scores.tier_scores[gtAnswer.tier] = { sum: 0, count: 0 };
    }
    scores.tier_scores[gtAnswer.tier].sum += score;
    scores.tier_scores[gtAnswer.tier].count++;

    const icon = score >= 0.8 ? "✅" : score >= 0.5 ? "⚠️" : "❌";
    console.log(` ${icon} ${(score * 100).toFixed(0)}%`);

    // Save every 10
    if (judged % 10 === 0) {
      scores.judged_at = new Date().toISOString();
      scores.total_score = totalScore;
      scores.max_score = judged;
      fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));
    }
  }

  // Final save
  scores.judged_at = new Date().toISOString();
  scores.total_score = totalScore;
  scores.max_score = judged;
  scores.avg_score = judged > 0 ? totalScore / judged : 0;
  fs.writeFileSync(SCORES_FILE, JSON.stringify(scores, null, 2));

  // ── Pretty Print Results ────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  console.log(`  FINAL SCORE: ${(scores.avg_score * 100).toFixed(2)}%`);
  console.log(`  Tasks judged: ${judged}`);
  console.log(`  Judge model: ${JUDGE_MODEL}`);
  console.log(`  Judge timeout: ${JUDGE_TIMEOUT_MS > 0 ? `${JUDGE_TIMEOUT_MS}ms` : "disabled"}`);
  console.log("═".repeat(60));

  console.log("\n  Tier Breakdown:");
  for (const [tier, data] of Object.entries(scores.tier_scores).sort()) {
    const avg = (data.sum / data.count * 100).toFixed(1);
    const bar = "█".repeat(Math.round(data.sum / data.count * 20)) + "░".repeat(20 - Math.round(data.sum / data.count * 20));
    console.log(`    ${tier.padEnd(6)} ${bar} ${avg}% (${data.count} tasks)`);
  }

  console.log("\n  Category Breakdown (worst → best):");
  const sorted = Object.entries(scores.category_scores)
    .sort((a, b) => (a[1].sum / a[1].count) - (b[1].sum / b[1].count));
  for (const [cat, data] of sorted) {
    const avg = (data.sum / data.count * 100).toFixed(1);
    const bar = "█".repeat(Math.round(data.sum / data.count * 20)) + "░".repeat(20 - Math.round(data.sum / data.count * 20));
    console.log(`    ${cat.padEnd(22)} ${bar} ${avg}%`);
  }

  // Save final report
  const reportFile = path.join(RESULTS_DIR, `judge_${Date.now()}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(scores, null, 2));
  console.log(`\n  Full report → ${reportFile}\n`);
}

main().catch(console.error);
