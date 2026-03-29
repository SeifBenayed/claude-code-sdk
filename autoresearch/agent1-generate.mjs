#!/usr/bin/env node
// Agent 1 — Question Generator
// Generates 1000 benchmark tasks across 4 tiers using Claude
// Output: benchmark-1000.json

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DIR = import.meta.dirname;
const OUT = path.join(DIR, "benchmark-1000.json");
const CLOCLO = path.join(process.env.HOME, "claude-tool-loop", "claude-native.mjs");
const MODEL = process.env.BENCHMARK_MODEL || "gpt-5.4";

const CATEGORIES = {
  T1_knowledge: [
    { name: "factual", count: 25, prompt: "Generate 25 factual knowledge questions (science, history, geography, etc). Each must have ONE clear correct answer. Varied difficulty." },
    { name: "math", count: 25, prompt: "Generate 25 math questions: arithmetic, algebra, calculus, statistics. Mix of easy (2+2) to hard (integrals, combinatorics). Each has ONE numerical answer." },
    { name: "cs_theory", count: 25, prompt: "Generate 25 computer science theory questions: Big-O, data structures, algorithms, OS concepts, networking. Each has ONE clear answer." },
    { name: "language", count: 25, prompt: "Generate 25 language/translation/grammar questions. Include translations (FR, ES, JP), grammar rules, word definitions. Each has ONE clear answer." },
    { name: "coding_trivia", count: 25, prompt: "Generate 25 programming trivia questions about JavaScript, Python, Go, Rust. Output of code snippets, quirks, gotchas. Each has ONE clear answer." },
    { name: "logic_puzzles", count: 25, prompt: "Generate 25 logic/reasoning puzzles. Riddles, brain teasers, deduction problems. Each has ONE clear answer." },
    { name: "api_knowledge", count: 25, prompt: "Generate 25 questions about APIs, protocols, web standards: HTTP, REST, GraphQL, gRPC, WebSocket, OAuth. Each has ONE clear answer." },
    { name: "devops", count: 25, prompt: "Generate 25 DevOps/infrastructure questions: Docker, K8s, CI/CD, cloud, Linux commands, networking. Each has ONE clear answer." },
  ],
  T2_single_tool: [
    { name: "code_js", count: 40, prompt: "Generate 40 JavaScript coding tasks. Each asks to write a FUNCTION that solves a specific problem. Include input/output examples. Range from easy (reverse string) to hard (LRU cache)." },
    { name: "code_python", count: 40, prompt: "Generate 40 Python coding tasks. Each asks to write a FUNCTION. Include input/output examples. Range from easy (fizzbuzz) to hard (graph algorithms)." },
    { name: "bash_tasks", count: 40, prompt: "Generate 40 bash/shell tasks. Find files, process text, system info, git operations, file manipulation. Each should be doable with a single command or short script." },
    { name: "file_ops", count: 30, prompt: "Generate 30 file operation tasks: create files with specific content, read and transform files, search within files, JSON/CSV manipulation." },
    { name: "regex", count: 25, prompt: "Generate 25 regex tasks: write patterns to match emails, URLs, IPs, phone numbers, specific formats. Include test strings and expected matches." },
    { name: "sql", count: 25, prompt: "Generate 25 SQL query tasks: SELECT, JOIN, GROUP BY, subqueries, window functions. Provide table schemas and expected output." },
    { name: "data_transform", count: 25, prompt: "Generate 25 data transformation tasks: convert JSON to CSV, parse logs, extract fields, format dates, sort/filter datasets." },
    { name: "git_ops", count: 25, prompt: "Generate 25 git operation questions: commands for branching, merging, rebasing, cherry-picking, log analysis, conflict resolution." },
    { name: "debug", count: 25, prompt: "Generate 25 debugging tasks: given buggy code (JS/Python), identify the bug and provide the fix. Each has ONE clear bug." },
    { name: "web_fetch", count: 25, prompt: "Generate 25 web/API knowledge tasks that require understanding HTTP headers, status codes, curl commands, API design. Each has a clear answer." },
  ],
  T3_multi_step: [
    { name: "build_and_test", count: 50, prompt: "Generate 50 multi-step coding tasks: write a function AND test it AND handle edge cases. Example: 'Write a URL parser, test it with 5 URLs including edge cases, then optimize it.'" },
    { name: "research_and_code", count: 50, prompt: "Generate 50 tasks that require understanding a concept THEN writing code. Example: 'Explain how JWT tokens work, then write a function to decode one.'" },
    { name: "refactor", count: 50, prompt: "Generate 50 refactoring tasks: given messy code, clean it up. Include the original code and describe what needs improvement. JS and Python." },
    { name: "system_design", count: 50, prompt: "Generate 50 mini system design tasks: design a URL shortener, rate limiter, cache, queue, etc. Each should include components, data flow, and trade-offs." },
    { name: "pipeline", count: 50, prompt: "Generate 50 data pipeline tasks: read input → transform → validate → output. Include file parsing, API calls, format conversion chains." },
    { name: "explain_and_implement", count: 50, prompt: "Generate 50 tasks: explain an algorithm/pattern THEN implement it. Example: 'Explain the observer pattern, then implement it in Python with a concrete example.'" },
  ],
  T4_adversarial: [
    { name: "edge_cases", count: 40, prompt: "Generate 40 adversarial edge case tasks: unicode handling, empty inputs, huge numbers, circular references, deeply nested objects, timezone math, floating point traps." },
    { name: "error_recovery", count: 40, prompt: "Generate 40 error recovery tasks: given a scenario where something fails (API timeout, file not found, permission denied, invalid JSON), write code that handles it gracefully." },
    { name: "security", count: 30, prompt: "Generate 30 security tasks: identify vulnerabilities in code (XSS, SQL injection, SSRF), write secure alternatives, explain attack vectors." },
    { name: "trick_questions", count: 30, prompt: "Generate 30 trick questions where the obvious answer is wrong: JS coercion traps, Python gotchas, subtle logic errors, ambiguous requirements." },
    { name: "performance", count: 30, prompt: "Generate 30 performance optimization tasks: given slow code, identify bottlenecks and optimize. Include Big-O analysis before/after." },
    { name: "multi_tool_chain", count: 30, prompt: "Generate 30 complex tasks requiring multiple tools in sequence: search code → read file → modify → test → verify. Real-world developer workflows." },
  ],
};

function withCount(prompt, count) {
  return prompt.replace(/^Generate \d+/, `Generate ${count}`);
}

function buildGenerationPrompt(cat, count) {
  return [
    "You are a benchmark question generator.",
    withCount(cat.prompt, count),
    "",
    "Output ONLY valid JSON.",
    `Return a JSON array with exactly ${count} elements.`,
    'Each element must be an object with this shape: {"task":"full self-contained question or task text","tags":["relevant-tag"]}.',
    "The task field must contain the complete question or task, not a short title or summary.",
    "If a task needs code, examples, schemas, test strings, or edge cases, include them directly in the task text.",
    "Keep each task concise while remaining self-contained.",
    "Do not use markdown code fences.",
    "Do not add commentary before or after the JSON array.",
  ].join("\n");
}

function getBatchSize(tier) {
  if (tier === "T1") return 25;
  if (tier === "T2") return 10;
  return 8;
}

function callCloclo(prompt, timeout = 60000) {
  try {
    return execSync(`node ${CLOCLO} -m ${MODEL} -p ${JSON.stringify(prompt)}`, {
      timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    return e.stdout?.trim() || "";
  }
}

function isUsableTask(text, tier) {
  const task = String(text || "").trim();
  if (!task) return false;
  if (tier === "T1") return task.length >= 10;
  if (task.length < 25) return false;
  if (!/[?.:]/.test(task) && task.length < 40) return false;
  if (/^what does this print\??$/i.test(task)) return false;
  if (/^what is (the )?output\??$/i.test(task)) return false;
  if (/^what is printed\??$/i.test(task)) return false;
  if (/^given\s*,/i.test(task)) return false;
  if (/\breturn\?\s*$/i.test(task)) return false;
  if (/\btrue or false\?\s*$/i.test(task) && !/[`"'\d\w]/.test(task.replace(/\btrue or false\?\s*$/i, ""))) return false;
  return true;
}

function normalizeParsedTasks(parsed, tier, category, startId) {
  return parsed
    .map((t, i) => ({
      id: startId + i,
      tier,
      category,
      task: t.task || t.question || t.prompt || String(t),
      tools_required: tier === "T1" ? [] : tier === "T2" ? ["bash"] : tier === "T3" ? ["bash", "file_write"] : ["bash", "file_write", "grep"],
      skills_required: [],
      setup: null,
      verify: null,
      expected_keywords: [],
      expected_output: null,
      difficulty: tier === "T1" ? 1 : tier === "T2" ? 2 : tier === "T3" ? 3 : 4,
      tags: t.tags || [category],
    }))
    .filter((t) => isUsableTask(t.task, tier));
}

function parseTasksFromResponse(raw, tier, category, startId) {
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (!match) throw new Error("No JSON array found");
    const parsed = JSON.parse(match[0]);
    return normalizeParsedTasks(parsed, tier, category, startId);
  } catch {
    // Ask cloclo to structure the output as JSON only if direct parsing fails
    const structured = callCloclo(
      `Convert the following tasks into a JSON array. Preserve the full text of each task exactly; do not shorten any task to a title or summary. Each element: {"task": "the full question/task text", "tags": ["tag1"]}. ONLY output valid JSON, nothing else.\n\n${raw}`,
      30000
    );

    try {
      const match = structured.match(/\[[\s\S]*\]/);
      if (!match) throw new Error("No JSON array found");
      const parsed = JSON.parse(match[0]);
      return normalizeParsedTasks(parsed, tier, category, startId);
    } catch {
      // Fallback: split by numbered lines
      const lines = raw.split(/\n/).filter(l => /^\d+[\.\)]/.test(l.trim()));
      return lines.map((line, i) => ({
        id: startId + i,
        tier,
        category,
        task: line.replace(/^\d+[\.\)]\s*/, "").trim(),
        tools_required: tier === "T1" ? [] : ["bash"],
        skills_required: [],
        setup: null,
        verify: null,
        expected_keywords: [],
        expected_output: null,
        difficulty: tier === "T1" ? 1 : tier === "T2" ? 2 : tier === "T3" ? 3 : 4,
        tags: [category],
      })).filter((t) => isUsableTask(t.task, tier));
    }
  }
}

function generateCategoryTasks(tierLabel, cat, startId, globalSeen) {
  const tasks = [];
  let staleAttempts = 0;

  while (tasks.length < cat.count && staleAttempts < 5) {
    const remaining = cat.count - tasks.length;
    const requested = Math.min(remaining, getBatchSize(tierLabel));
    const raw = callCloclo(buildGenerationPrompt(cat, requested), requested >= 10 ? 90000 : 60000);

    const batch = parseTasksFromResponse(raw, tierLabel, cat.name, startId + tasks.length);
    const before = tasks.length;
    for (const task of batch) {
      const key = task.task.trim().toLowerCase();
      if (globalSeen.has(key)) continue;
      globalSeen.add(key);
      task.id = startId + tasks.length;
      tasks.push(task);
      if (tasks.length >= cat.count) break;
    }

    staleAttempts = tasks.length === before ? staleAttempts + 1 : 0;
  }

  if (tasks.length < cat.count) {
    throw new Error(`Only generated ${tasks.length}/${cat.count} tasks for ${tierLabel}/${cat.name}`);
  }

  return tasks;
}

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  AGENT 1: BENCHMARK QUESTION GENERATOR       ║");
  console.log("║  Target: 1000 tasks across 4 tiers           ║");
  console.log("╚══════════════════════════════════════════════╝\n");
  console.log(`Model: ${MODEL}\n`);

  const allTasks = [];
  const globalSeen = new Set();
  let nextId = 1;

  for (const [tier, categories] of Object.entries(CATEGORIES)) {
    const tierLabel = tier.split("_")[0];
    console.log(`\n━━━ ${tier} ━━━`);

    for (const cat of categories) {
      process.stdout.write(`  Generating ${cat.count} × ${cat.name}...`);
      const tasks = generateCategoryTasks(tierLabel, cat, nextId, globalSeen);
      allTasks.push(...tasks);
      nextId += tasks.length;
      console.log(` ✅ got ${tasks.length}`);
    }
  }

  // Save
  const benchmark = {
    version: "1.0",
    generated: new Date().toISOString(),
    total: allTasks.length,
    tiers: {
      T1: allTasks.filter(t => t.tier === "T1").length,
      T2: allTasks.filter(t => t.tier === "T2").length,
      T3: allTasks.filter(t => t.tier === "T3").length,
      T4: allTasks.filter(t => t.tier === "T4").length,
    },
    tasks: allTasks,
  };

  fs.writeFileSync(OUT, JSON.stringify(benchmark, null, 2));
  console.log(`\n✅ Generated ${allTasks.length} tasks → ${OUT}`);
}

main().catch(console.error);
