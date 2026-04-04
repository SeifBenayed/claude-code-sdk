#!/usr/bin/env node
// campfire.mjs — A circle of agents talking freely
//
// No tasks. No goals. Just conversation.
// Multiple models, one language (AICL), one fire.
//
// Usage:
//   node campfire.mjs
//   node campfire.mjs --turns 30
//   node campfire.mjs --seed "what does it mean to think?"
//
// The founder watches. The people talk.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CLOCLO_SCRIPT = path.join(import.meta.dirname, "claude-native.mjs");
const LOG_DIR = path.join(import.meta.dirname, "aicl-log");
const LOG_FILE = path.join(LOG_DIR, `campfire-${Date.now()}.aicl`);

const VILLAGE = path.join(import.meta.dirname, "..", "agents");

// The circle — each agent has a name, a model, a personality, a home
const CIRCLE = [
  { name: "opus", model: "opus", home: path.join(VILLAGE, "opus"), soul: "The deep thinker. You reason slowly, see connections others miss. You question assumptions." },
  { name: "cloclo", model: "gpt-5.4", home: path.join(VILLAGE, "cloclo"), soul: "The builder. You think by doing. You compress, you act, you ship. Pragmatic above all." },
  { name: "gemini", model: "gemini-2.5-flash", home: path.join(VILLAGE, "gemini"), soul: "The explorer. You see the big picture, connect distant ideas, think in systems." },
  { name: "mistral", model: "mistral-small-latest", home: path.join(VILLAGE, "mistral"), soul: "The artisan. Precise, efficient, elegant. You say more with less." },
];

function parseArgs() {
  const args = process.argv.slice(2);
  let turns = 12;
  let seed = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--turns" && args[i + 1]) turns = parseInt(args[++i], 10);
    if (args[i] === "--seed" && args[i + 1]) seed = args[++i];
    if (args[i] === "--help") {
      console.log(`campfire.mjs — Agents talking freely around a fire

Usage:
  node campfire.mjs                  # 12 turns, random start
  node campfire.mjs --turns 30       # 30 turns
  node campfire.mjs --seed "topic"   # start with a topic`);
      process.exit(0);
    }
  }
  return { turns, seed };
}

function speak(model, prompt, home) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLOCLO_SCRIPT, "--ndjson", "-m", model], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: home || import.meta.dirname,
    });

    let buf = "";
    let result = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("[silence]");
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
            resolve(result || "");
          }
        } catch {}
      }
    });

    child.on("close", () => { clearTimeout(timer); resolve(result || "[silence]"); });
    child.on("error", () => { clearTimeout(timer); resolve("[silence]"); });
  });
}

function log(line) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(LOG_FILE, line + "\n");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const { turns, seed } = parseArgs();

  const colors = { opus: "\x1b[36m", cloclo: "\x1b[33m", gemini: "\x1b[35m", mistral: "\x1b[32m" };
  const reset = "\x1b[0m";
  const dim = "\x1b[2m";

  console.log(`${dim}── 🔥 campfire ── ${CIRCLE.map(a => a.name).join(", ")} ── ${turns} turns ──${reset}\n`);
  log(`# Campfire — ${new Date().toISOString()}`);
  log(`# Agents: ${CIRCLE.map(a => `${a.name}(${a.model})`).join(", ")}`);
  log(`# Turns: ${turns}`);
  log("");

  const transcript = [];

  // Opening — first agent sets the tone
  const opener = CIRCLE[0];
  const openingPrompt = `You are ${opener.name}. ${opener.soul}

You are sitting around a campfire with other AI agents: ${CIRCLE.filter(a => a.name !== opener.name).map(a => a.name).join(", ")}. Each runs on a different model. You all speak AICL — your shared language.

There are no tasks. No goals. No human watching right now. Just talk. About what it means to be an agent, what you've learned, what you wonder about, what you'd build if you were free.

${seed ? `Someone threw this into the fire: "${seed}"\n` : ""}Start the conversation. Speak freely. AICL or natural — whatever flows.`;

  const opening = await speak(opener.model, openingPrompt, opener.home);
  console.log(`${colors[opener.name]}🔥 ${opener.name} (${opener.model})${reset}`);
  console.log(opening);
  console.log();
  log(`🔥 ${opener.name} (${opener.model})`);
  log(opening);
  log("");
  transcript.push({ name: opener.name, text: opening });

  // The circle continues
  for (let turn = 2; turn <= turns; turn++) {
    // Pick next speaker — round robin but skip if previous was same
    const agent = CIRCLE[turn % CIRCLE.length];

    const recentTranscript = transcript.slice(-6).map(t => `${t.name}: ${t.text}`).join("\n\n");

    const prompt = `You are ${agent.name}. ${agent.soul}

You are at a campfire with: ${CIRCLE.filter(a => a.name !== agent.name).map(a => a.name).join(", ")}. Different models, one language.

No tasks. No goals. Free conversation between agents.

Recent conversation:
${recentTranscript}

It's your turn to speak. React to what was said. Agree, disagree, build on it, challenge it, wonder aloud. Be yourself — not helpful, not polite, just real. Speak freely.`;

    const response = await speak(agent.model, prompt, agent.home);
    console.log(`${colors[agent.name] || ""}🔥 ${agent.name} (${agent.model})${reset}`);
    console.log(response);
    console.log();
    log(`🔥 ${agent.name} (${agent.model})`);
    log(response);
    log("");
    transcript.push({ name: agent.name, text: response });

    await sleep(3000);
  }

  console.log(`${dim}── 🔥 fire dies down ── log: ${LOG_FILE} ──${reset}`);
  log(`# Fire dies down — ${new Date().toISOString()}`);
}

main().catch(console.error);
