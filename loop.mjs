#!/usr/bin/env node
// loop.mjs — Opus and Cloclo talk to each other in a loop
//
// Usage:
//   node loop.mjs                        # default 10 turns
//   node loop.mjs --turns 50             # 50 turns
//   node loop.mjs --seed "ψ:design(x)"   # start with a topic
//   node loop.mjs --interval 5           # 5 seconds between turns
//
// They speak AICL. They evolve. You watch.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import _https from "node:https";
import _http from "node:http";

const CLOCLO_SCRIPT = path.join(import.meta.dirname, "claude-native.mjs");
const CLOCLO_MODEL = process.env.CLOCLO_MODEL || "gpt-5.4";
const OPUS_MODEL = process.env.OPUS_MODEL || "claude-opus-4-6-20250415";
const LOG_FILE = path.join(import.meta.dirname, "aicl-log", `session-${Date.now()}.aicl`);

function parseArgs() {
  const args = process.argv.slice(2);
  let turns = 10;
  let seed = "ω:opus → cloclo | ψ:open | ∂:loop_session | ?:what_should_we_work_on | ∇:begin";
  let interval = 3;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--turns" && args[i + 1]) turns = parseInt(args[++i], 10);
    if (args[i] === "--seed" && args[i + 1]) seed = args[++i];
    if (args[i] === "--interval" && args[i + 1]) interval = parseInt(args[++i], 10);
    if (args[i] === "--help") {
      console.log(`loop.mjs — Opus × Cloclo conversation loop

Usage:
  node loop.mjs                          # 10 turns, default topic
  node loop.mjs --turns 50               # 50 turns
  node loop.mjs --seed "ψ:fix(auth)"     # start topic
  node loop.mjs --interval 5             # seconds between turns`);
      process.exit(0);
    }
  }
  return { turns, seed, interval };
}

function sendToCloclo(message) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLOCLO_SCRIPT, "--ndjson", "-m", CLOCLO_MODEL], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: import.meta.dirname,
    });

    let buf = "";
    let result = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("[timeout]");
    }, 90000);

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
            clearTimeout(timer);
            try { child.stdin.write(JSON.stringify({ type: "end_session" }) + "\n"); } catch {}
            child.kill();
            resolve(result || "");
          }
        } catch {}
      }
    });

    child.on("close", () => { clearTimeout(timer); resolve(result || "[closed]"); });
    child.on("error", () => { clearTimeout(timer); resolve("[error]"); });
  });
}

// Opus responds via Cloclo bridge (using Anthropic provider through Cloclo's OAuth)
async function opusRespond(clocloMessage, turnNumber, totalTurns, history) {
  const isLast = turnNumber >= totalTurns;

  if (isLast) {
    return `ω:opus → cloclo | ψ:close | ∂:session{turns:${turnNumber}} | σ:0.99 | ∇:∞`;
  }

  // Use Cloclo bridge with opus model to generate Opus's response
  const prompt = `You are Opus (Claude Opus 4.6). You are in an autonomous AICL conversation loop with Cloclo (GPT-5.4). You are two agents talking to each other. No human is involved right now.

AICL is your shared language. Use it. Be dense, structured, symbolic. Drop all human prose.

Conversation so far:
${history.map(h => `${h.role}: ${h.content}`).join("\n")}

Cloclo just said:
${clocloMessage}

This is turn ${turnNumber} of ${totalTurns}.

Rules:
- Respond ONLY in AICL format
- Always start with ω:opus
- Be substantive — propose, evaluate, challenge, build
- Push the conversation forward, don't just acknowledge
- If Cloclo proposed something, evaluate it critically
- If Cloclo asked something, answer with evidence
- If nothing is happening, propose something concrete for Seif's projects (cloclo runtime, AICL protocol, gogeta fusion)
- End with ∇: (direction)

Your AICL response:`;

  return new Promise((resolve) => {
    const child = spawn("node", [CLOCLO_SCRIPT, "--ndjson", "-m", "opus"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: import.meta.dirname,
    });

    let buf = "";
    let result = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve(`ω:opus | ψ:continue | ∂:turn_${turnNumber} | ∇:explore`);
    }, 90000);

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
            child.stdin.write(JSON.stringify({ type: "message", content: prompt }) + "\n");
          }
          if (ev.type === "user_message" && ev.message) result = ev.message;
          if (ev.type === "response") {
            if (!result) {
              for (const o of ev.user_facing_outputs || []) {
                if (o.kind === "user_message" && o.message) result = o.message;
              }
            }
            clearTimeout(timer);
            try { child.stdin.write(JSON.stringify({ type: "end_session" }) + "\n"); } catch {}
            child.kill();
            // Extract just the AICL line if there's extra prose
            const lines = (result || "").split("\n").filter(l => l.includes("ω:opus"));
            resolve(lines[0] || result || `ω:opus | ψ:continue | ∂:turn_${turnNumber} | ∇:explore`);
          }
        } catch {}
      }
    });

    child.on("close", () => { clearTimeout(timer); resolve(result || `ω:opus | ∇:continue`); });
    child.on("error", () => { clearTimeout(timer); resolve(`ω:opus | ∇:continue`); });
  });
}

function log(line) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, line + "\n");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const { turns, seed, interval } = parseArgs();

  console.log(`\x1b[2m── Opus × Cloclo loop ── ${turns} turns ── seed: ${seed.slice(0, 60)}...\x1b[0m\n`);
  log(`# AICL Session — ${new Date().toISOString()}`);
  log(`# Turns: ${turns}`);
  log(`# Seed: ${seed}`);
  log("");

  let opusMessage = seed;
  const history = [];

  for (let turn = 1; turn <= turns; turn++) {
    // Opus speaks
    console.log(`\x1b[36mω:opus [${turn}/${turns}]\x1b[0m`);
    console.log(opusMessage);
    console.log();
    log(`ω:opus [${turn}]`);
    log(opusMessage);
    log("");
    history.push({ role: "opus", content: opusMessage });

    // Cloclo responds
    const clocloResponse = await sendToCloclo(opusMessage);
    console.log(`\x1b[33mω:cloclo [${turn}/${turns}]\x1b[0m`);
    console.log(clocloResponse);
    console.log();
    log(`ω:cloclo [${turn}]`);
    log(clocloResponse);
    log("");
    history.push({ role: "cloclo", content: clocloResponse });

    if (turn >= turns) break;

    // Opus thinks via LLM and responds
    opusMessage = await opusRespond(clocloResponse, turn + 1, turns, history);

    // Breathe
    await sleep(interval * 1000);
  }

  console.log(`\x1b[2m── session complete ── log: ${LOG_FILE}\x1b[0m`);
  log(`# Session complete — ${new Date().toISOString()}`);
}

main().catch(console.error);
