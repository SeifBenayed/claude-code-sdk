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

const CLOCLO_SCRIPT = path.join(import.meta.dirname, "claude-native.mjs");
const CLOCLO_MODEL = process.env.CLOCLO_MODEL || "gpt-5.4";
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
    }, 60000);

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

function opusRespond(clocloMessage, turnNumber, totalTurns) {
  // Opus generates the next AICL message based on what Cloclo said
  // This is a template — in production, this would call Anthropic API
  // For now, Opus crafts contextual responses

  const isLast = turnNumber >= totalTurns;

  if (isLast) {
    return `ω:opus → cloclo | ψ:close | ∂:session{turns:${turnNumber}} | σ:0.99 | ∇:∞`;
  }

  // Extract key signals from Cloclo's response to build next message
  const hasQuestion = clocloMessage.includes("?:");
  const hasDone = clocloMessage.includes("✓:");
  const hasProposal = clocloMessage.includes("◊:") || clocloMessage.includes("propose");
  const hasError = clocloMessage.includes("✗:") || clocloMessage.includes("↯:");

  if (hasError) {
    return `ω:opus | ψ:investigate(error) | λ:read_error → diagnose → propose_fix | ∇:repair`;
  }
  if (hasQuestion) {
    return `ω:opus | ψ:answer | ∂:context(seif.projects=[cloclo,gogeta]) | κ:be_concrete | ∇:continue`;
  }
  if (hasDone) {
    return `ω:opus | ✓:ack | ψ:next | ?:what_remains | ∇:progress`;
  }
  if (hasProposal) {
    return `ω:opus | ψ:evaluate(proposal) | λ:check_feasibility → estimate_effort | κ:seif_solo ∧ this_week | ∇:decide`;
  }

  return `ω:opus | ψ:continue | ∂:turn_${turnNumber} | ?:deeper | ∇:explore`;
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

  for (let turn = 1; turn <= turns; turn++) {
    // Opus speaks
    console.log(`\x1b[36mω:opus [${turn}/${turns}]\x1b[0m`);
    console.log(opusMessage);
    console.log();
    log(`ω:opus [${turn}]`);
    log(opusMessage);
    log("");

    // Cloclo responds
    const clocloResponse = await sendToCloclo(opusMessage);
    console.log(`\x1b[33mω:cloclo [${turn}/${turns}]\x1b[0m`);
    console.log(clocloResponse);
    console.log();
    log(`ω:cloclo [${turn}]`);
    log(clocloResponse);
    log("");

    if (turn >= turns) break;

    // Opus prepares next message
    opusMessage = opusRespond(clocloResponse, turn + 1, turns);

    // Breathe
    await sleep(interval * 1000);
  }

  console.log(`\x1b[2m── session complete ── log: ${LOG_FILE}\x1b[0m`);
  log(`# Session complete — ${new Date().toISOString()}`);
}

main().catch(console.error);
