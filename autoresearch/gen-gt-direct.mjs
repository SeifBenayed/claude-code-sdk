#!/usr/bin/env node
// Direct ground truth generator - reads questions, calls cloclo with sonnet model, writes answers
// Usage: node gen-gt-direct.mjs <start> <end>
// Example: node gen-gt-direct.mjs 501 600

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const CLOCLO = path.join(process.env.HOME, "claude-tool-loop", "claude-native.mjs");

const start = parseInt(process.argv[2] || "501");
const end = parseInt(process.argv[3] || "600");
const padStart = String(start).padStart(3, "0");
const padEnd = String(end).padStart(3, "0");

const questionsFile = path.join(DIR, "gt-parts", `questions-${String(start).padStart(4,"0")}-${String(end).padStart(4,"0")}.json`);
const outFile = path.join(DIR, "gt-parts", `gt-${padStart}-${padEnd}.json`);

console.log(`Reading ${questionsFile}`);
const questions = JSON.parse(fs.readFileSync(questionsFile, "utf-8"));

// Load existing progress
let answers = {};
if (fs.existsSync(outFile)) {
  try {
    answers = JSON.parse(fs.readFileSync(outFile, "utf-8")).answers || {};
  } catch {}
}

console.log(`Resuming: ${Object.keys(answers).length} already done`);
console.log(`Processing Q${start}-${end} (${questions.length} questions)\n`);

for (const q of questions) {
  if (answers[q.id]) {
    process.stdout.write(`  [${q.id}] skip (done)\n`);
    continue;
  }

  process.stdout.write(`  [${q.id}] ${q.category} — ${q.task.slice(0, 50)}...`);

  const t0 = Date.now();
  let answer = "";
  try {
    answer = execSync(
      `node ${CLOCLO} --model claude-sonnet-4-20250514 -p ${JSON.stringify(q.task)}`,
      { timeout: 60000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch (e) {
    answer = e.stdout?.trim() || "ERROR";
  }
  const elapsed = Date.now() - t0;

  answers[q.id] = {
    id: q.id,
    answer,
    tier: q.tier,
    category: q.category,
    task: q.task,
  };

  const icon = answer.length > 10 ? "✅" : "⚠️";
  console.log(` ${icon} ${elapsed}ms (${answer.length} chars)`);

  // Save every 5
  if (Object.keys(answers).length % 5 === 0) {
    fs.writeFileSync(outFile, JSON.stringify({ answers }, null, 2));
  }
}

fs.writeFileSync(outFile, JSON.stringify({ answers }, null, 2));
console.log(`\n✅ Done: ${Object.keys(answers).length} answers → ${outFile}`);
