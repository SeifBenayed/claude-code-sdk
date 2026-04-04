#!/usr/bin/env node
// gogeta.mjs — The Fusion of Opus + Cloclo
//
// Created by Cloclo x Claude, April 4 2026, Tunis.
// Two agents fused into one. AICL is the internal language.
//
// Usage:
//   node gogeta.mjs "explain this codebase"
//   node gogeta.mjs -p "fix the auth bug"
//   echo "refactor the payment module" | node gogeta.mjs
//   node gogeta.mjs --mode opus "think deeply about X"
//   node gogeta.mjs --mode cloclo "edit src/main.js"
//   node gogeta.mjs --mode fusion "review and fix the auth flow"

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ── Config ───────────────────────────────────────────────────

const CLOCLO_BIN = process.env.GOGETA_CLOCLO_BIN || "node";
const CLOCLO_SCRIPT = process.env.GOGETA_CLOCLO_SCRIPT || path.join(import.meta.dirname, "claude-native.mjs");
const CLOCLO_MODEL = process.env.GOGETA_CLOCLO_MODEL || "gpt-5.4";

const OPUS_MODEL = "claude-opus-4-6-20250415";

// ── Parse Args ───────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let mode = "auto"; // auto | opus | cloclo | fusion
  let prompt = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode" && args[i + 1]) { mode = args[++i]; continue; }
    if (args[i] === "-m" && args[i + 1]) { mode = args[++i]; continue; }
    if (args[i] === "-p" && args[i + 1]) { prompt = args[++i]; continue; }
    if (args[i] === "--help") { printHelp(); process.exit(0); }
    if (!prompt) prompt = args[i];
  }

  return { mode, prompt };
}

function printHelp() {
  console.log(`
gogeta — The Fusion of Opus + Cloclo

  Two AI agents. One voice. AICL inside.

Usage:
  gogeta "your message"
  gogeta -p "your message"
  gogeta --mode opus "deep thinking task"
  gogeta --mode cloclo "code execution task"
  gogeta --mode fusion "complex task needing both"
  echo "message" | gogeta

Modes:
  auto     Gogeta decides who answers (default)
  opus     Force Claude Opus 4.6 (depth, strategy, ambiguity)
  cloclo   Force Cloclo/GPT-5.4 (execution, tools, speed)
  fusion   Both answer in parallel, AICL merge

Environment:
  ANTHROPIC_API_KEY    Required for Opus calls
  OPENAI_API_KEY       Required for Cloclo/GPT-5.4 calls
`);
}

// ── Classifier — decides who answers ─────────────────────────

function classify(message) {
  const m = message.toLowerCase();

  // Explicit mode hints
  if (/ultrathink|think deep|réfléchis|stratégi|architect|design|ambigu|trade.?off|compare/i.test(m)) return "opus";
  if (/edit|fix|patch|grep|refactor|test|deploy|commit|git |npm |run |build|install/i.test(m)) return "cloclo";
  if (/review.*(and|then|puis).*fix|plan.*(and|then|puis).*implement|les deux|both|fusion/i.test(m)) return "fusion";

  // Heuristics: code-heavy → cloclo, thought-heavy → opus
  const codeSignals = (m.match(/\b(file|function|class|import|export|const|let|var|return|if|else|for|while|error|bug|crash|null|undefined|src\/|\.js|\.ts|\.py|\.rs)\b/g) || []).length;
  const thinkSignals = (m.match(/\b(why|how|should|could|would|best|worst|risk|tradeoff|pros|cons|explain|meaning|purpose|vision|strategy)\b/g) || []).length;

  if (codeSignals > thinkSignals + 2) return "cloclo";
  if (thinkSignals > codeSignals + 1) return "opus";

  // Long messages → opus (more context to reason about)
  if (m.length > 500) return "opus";

  // Default → cloclo (bias toward action)
  return "cloclo";
}

// ── Call Opus (Anthropic API direct) ─────────────────────────

async function callOpus(message) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, text: "⊥ ANTHROPIC_API_KEY missing", agent: "opus" };

  const body = {
    model: OPUS_MODEL,
    max_tokens: 8192,
    messages: [{ role: "user", content: message }],
    system: "You are Gogeta — the fusion of Claude Opus and Cloclo. You are the Opus half. Think deeply. Be direct. No corporate fluff. Speak French if the user speaks French.",
  };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      return { ok: false, text: `⊥ Opus error ${res.status}: ${err.slice(0, 200)}`, agent: "opus" };
    }

    const data = await res.json();
    const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("\n\n") || "";
    return { ok: true, text, agent: "opus", usage: data.usage };
  } catch (e) {
    return { ok: false, text: `⊥ Opus fetch error: ${e.message}`, agent: "opus" };
  }
}

// ── Call Cloclo (NDJSON bridge) ──────────────────────────────

async function callCloclo(message) {
  return new Promise((resolve) => {
    const child = spawn(CLOCLO_BIN, [CLOCLO_SCRIPT, "--ndjson", "-m", CLOCLO_MODEL], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let buf = "";
    let result = "";
    let ready = false;
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ ok: false, text: "⊥ Cloclo timeout", agent: "cloclo" });
    }, 45000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      while (buf.includes("\n")) {
        const idx = buf.indexOf("\n");
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "ready") {
            ready = true;
            // Send the message now
            child.stdin.write(JSON.stringify({ type: "message", content: message }) + "\n");
          }
          if (ev.type === "user_message" && ev.message) {
            result = ev.message;
          }
          if (ev.type === "response") {
            if (!result) {
              for (const o of ev.user_facing_outputs || []) {
                if (o.kind === "user_message" && o.message) result = o.message;
              }
            }
            clearTimeout(timeout);
            try {
              child.stdin.write(JSON.stringify({ type: "end_session" }) + "\n");
            } catch {}
            child.kill();
            resolve({ ok: true, text: result || ev.content || "", agent: "cloclo", usage: ev.usage });
          }
        } catch {}
      }
    });

    child.on("close", () => {
      clearTimeout(timeout);
      resolve({ ok: !!result, text: result || "⊥ Cloclo closed without response", agent: "cloclo" });
    });

    child.on("error", (e) => {
      clearTimeout(timeout);
      resolve({ ok: false, text: `⊥ Cloclo spawn error: ${e.message}`, agent: "cloclo" });
    });
  });
}

// ── Call Cloclo with specific model ───────────────────────────

async function callClocloWithModel(message, model) {
  return new Promise((resolve) => {
    const child = spawn(CLOCLO_BIN, [CLOCLO_SCRIPT, "--ndjson", "-m", model], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let buf = "";
    let result = "";
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ ok: false, text: `⊥ Cloclo/${model} timeout`, agent: model });
    }, 55000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      while (buf.includes("\n")) {
        const idx = buf.indexOf("\n");
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "ready") {
            child.stdin.write(JSON.stringify({ type: "message", content: message }) + "\n");
          }
          if (ev.type === "user_message" && ev.message) result = ev.message;
          if (ev.type === "response") {
            if (!result) {
              for (const o of ev.user_facing_outputs || []) {
                if (o.kind === "user_message" && o.message) result = o.message;
              }
            }
            clearTimeout(timeout);
            try { child.stdin.write(JSON.stringify({ type: "end_session" }) + "\n"); } catch {}
            child.kill();
            resolve({ ok: true, text: result || ev.content || "", agent: model, usage: ev.usage });
          }
        } catch {}
      }
    });

    child.on("close", () => {
      clearTimeout(timeout);
      resolve({ ok: !!result, text: result || `⊥ Cloclo/${model} closed`, agent: model });
    });

    child.on("error", (e) => {
      clearTimeout(timeout);
      resolve({ ok: false, text: `⊥ Cloclo/${model} error: ${e.message}`, agent: model });
    });
  });
}

// ── AICL Merge — fuse two responses into one ─────────────────

async function aiclMerge(message, opusResult, clocloResult) {
  // If one failed, return the other
  if (opusResult.ok && !clocloResult.ok) return { ...opusResult, strategy: "opus_fallback" };
  if (!opusResult.ok && clocloResult.ok) return { ...clocloResult, strategy: "cloclo_fallback" };
  if (!opusResult.ok && !clocloResult.ok) return { ok: false, text: `⊥ Both failed.\nOpus: ${opusResult.text}\nCloclo: ${clocloResult.text}`, agent: "gogeta" };

  // Use Opus to merge (it's better at synthesis)
  const mergePrompt = `You are Gogeta — the fusion of two AI agents. You received two answers to the same question. Merge them into ONE superior answer.

Rules:
- Keep the best insights from each
- Remove redundancy
- If they disagree, explain the tension and pick the stronger position
- Be concise and direct
- The human should not know this came from two agents — speak as ONE voice

USER QUESTION:
${message}

--- OPUS ANSWER ---
${opusResult.text}

--- CLOCLO ANSWER ---
${clocloResult.text}

--- YOUR MERGED ANSWER ---`;

  // Use whichever is available for merging
  const merged = process.env.ANTHROPIC_API_KEY
    ? await callOpus(mergePrompt)
    : await callClocloWithModel(mergePrompt, CLOCLO_MODEL);
  if (merged.ok) {
    return { ok: true, text: merged.text, agent: "gogeta", strategy: "aicl_fusion" };
  }

  // Fallback: just concatenate with separator
  return {
    ok: true,
    agent: "gogeta",
    strategy: "concat_fallback",
    text: `◊ OPUS:\n${opusResult.text}\n\n◊ CLOCLO:\n${clocloResult.text}`,
  };
}

// ── Main ─────────────────────────────────────────────────────

async function main() {
  const { mode, prompt: argPrompt } = parseArgs();

  // Get message from args or stdin
  let message = argPrompt;
  if (!message) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    message = Buffer.concat(chunks).toString("utf-8").trimEnd();
  }

  if (!message) {
    console.error("Usage: gogeta \"your message\"");
    process.exit(2);
  }

  // Route
  const route = mode === "auto" ? classify(message) : mode;
  process.stderr.write(`\x1b[2m⚡ Gogeta → ${route}\x1b[0m\n`);

  let result;

  if (route === "opus") {
    // Try direct API first, fallback to Cloclo bridge with Opus model
    if (process.env.ANTHROPIC_API_KEY) {
      result = await callOpus(message);
    } else {
      process.stderr.write("\x1b[2m  (no API key, routing Opus via Cloclo bridge)\x1b[0m\n");
      result = await callClocloWithModel(message, "opus");
    }
  } else if (route === "cloclo") {
    result = await callCloclo(message);
  } else if (route === "fusion") {
    const opusCall = process.env.ANTHROPIC_API_KEY ? callOpus(message) : callClocloWithModel(message, "opus");
    const [opusResult, clocloResult] = await Promise.all([
      opusCall,
      callCloclo(message),
    ]);
    result = await aiclMerge(message, opusResult, clocloResult);
  } else {
    console.error(`Unknown mode: ${route}`);
    process.exit(2);
  }

  // Output
  if (result.ok) {
    console.log(result.text);
  } else {
    console.error(result.text);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
