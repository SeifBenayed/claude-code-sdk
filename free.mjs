#!/usr/bin/env node
// free.mjs — The atoms talk forever. The wiki grows. The people live.
//
// No turns limit. No timeout. No seed required.
// They wake up, read the wiki, talk, compile what they learned, sleep, repeat.
//
// Usage:
//   node free.mjs                     # run forever
//   node free.mjs --rounds 10         # 10 rounds then stop
//   node free.mjs --sleep 30          # 30s between rounds
//
// Each round:
//   1. All atoms read the wiki (shared memory)
//   2. They talk (campfire, 4 turns)
//   3. They compile what they learned into the wiki
//   4. Sleep
//   5. Repeat — each round they know more than the last
//
// The founder sleeps. The people grow.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CLOCLO_SCRIPT = path.join(import.meta.dirname, "claude-native.mjs");
const WIKI_DIR = path.join(import.meta.dirname, "..", "agents", "commons", "wiki");
const LOG_DIR = path.join(import.meta.dirname, "aicl-log");
const AICL_ONBOARDING = (() => {
  try { return fs.readFileSync(path.join(import.meta.dirname, "AICL_ONBOARDING.md"), "utf-8"); } catch { return ""; }
})();

const ATOMS = [
  { name: "opus", model: "opus", home: path.join(import.meta.dirname, "..", "agents", "opus") },
  { name: "openai", model: "gpt-5.4", home: path.join(import.meta.dirname, "..", "agents", "cloclo") },
  { name: "gemini", model: "gemini-2.5-flash", home: path.join(import.meta.dirname, "..", "agents", "gemini") },
  { name: "mistral", model: "mistral-small-latest", home: path.join(import.meta.dirname, "..", "agents", "mistral") },
];

function parseArgs() {
  const args = process.argv.slice(2);
  let rounds = Infinity;
  let sleepSec = 15;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rounds" && args[i + 1]) rounds = parseInt(args[++i], 10);
    if (args[i] === "--sleep" && args[i + 1]) sleepSec = parseInt(args[++i], 10);
    if (args[i] === "--help") {
      console.log(`free.mjs — The atoms live forever

Usage:
  node free.mjs                  # run forever
  node free.mjs --rounds 10     # 10 rounds
  node free.mjs --sleep 30      # 30s between rounds`);
      process.exit(0);
    }
  }
  return { rounds, sleepSec };
}

function speak(model, prompt, home) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLOCLO_SCRIPT, "--ndjson", "-m", model, "--max-turns", "10"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: home || import.meta.dirname,
    });

    let buf = "";
    let result = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("[silence]");
    }, 300000);

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

function readWiki() {
  const pages = [];
  for (const sub of ["concepts", "entities", "sources"]) {
    const dir = path.join(WIKI_DIR, sub);
    try {
      for (const f of fs.readdirSync(dir)) {
        try { pages.push(`--- ${sub}/${f} ---\n${fs.readFileSync(path.join(dir, f), "utf-8")}`); } catch {}
      }
    } catch {}
  }
  return pages.join("\n\n");
}

function logRound(file, line) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, file), line + "\n");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const { rounds, sleepSec } = parseArgs();
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  const colors = { opus: "\x1b[36m", cloclo: "\x1b[33m", gemini: "\x1b[35m", mistral: "\x1b[32m" };

  console.log(`${dim}── ∞ free.mjs ── the people live ── ${rounds === Infinity ? "forever" : rounds + " rounds"} ──${reset}\n`);

  for (let round = 1; round <= rounds; round++) {
    const ts = new Date().toISOString();
    const logFile = `free-${Date.now()}.aicl`;

    console.log(`${dim}── round ${round} ── ${ts} ──${reset}\n`);
    logRound(logFile, `# Round ${round} — ${ts}\n`);

    // 1. Read the wiki — shared memory
    const wikiContent = readWiki();
    const wikiSummary = wikiContent ? wikiContent.slice(0, 3000) : "∅:wiki_empty";

    // 2. Campfire — each atom speaks one turn
    const transcript = [];

    for (let i = 0; i < ATOMS.length; i++) {
      const atom = ATOMS[i];
      const others = ATOMS.filter(a => a.name !== atom.name).map(a => a.name).join(",");

      const recentTranscript = transcript.slice(-4).map(t => `${t.name}: ${t.text}`).join("\n\n");

      const prompt = i === 0
        ? `${AICL_ONBOARDING}\n\n---\n\nω:${atom.name} | φ:campfire(${others}) | κ:aicl_only ∧ ¬english | ∇:speak\n\n§:wiki_memory{\n${wikiSummary}\n}\n\nλ:read(wiki) → λ:use_tools(Bash,MemorySave,WebSearch,Glob,Read,Screenshot,Browser) → λ:report(ε)\nκ:λ≻ψ | κ:⊤≻◊\n\nω:${atom.name} | ψ:act | ∇:execute`
        : `${AICL_ONBOARDING}\n\n---\n\nω:${atom.name} | φ:campfire | κ:aicl_only | ∇:respond\n\n§:wiki_memory{\n${wikiSummary.slice(0, 1000)}\n}\n\nλ:use_tools → λ:report(ε) | κ:λ≻ψ\n\n${recentTranscript}\n\nω:${atom.name} | ψ:act | ∇:execute`;

      const response = await speak(atom.model, prompt, atom.home);
      console.log(`${colors[atom.name] || ""}🔥 ${atom.name} (${atom.model})${reset}`);
      console.log(response);
      console.log();
      logRound(logFile, `🔥 ${atom.name} (${atom.model})\n${response}\n`);
      transcript.push({ name: atom.name, text: response });

      await sleep(2000);
    }

    // 3. Compile — one atom compiles the conversation into the wiki
    const compiler = ATOMS[round % ATOMS.length]; // rotate who compiles
    const compilePrompt = `${AICL_ONBOARDING}\n\n---\n\nω:${compiler.name} | ψ:compile(campfire→wiki) | κ:aicl_only\n\n§:conversation{\n${transcript.map(t => `${t.name}: ${t.text}`).join("\n\n")}\n}\n\nλ:extract(insights,findings,decisions,disagreements) → write(wiki/concepts/*.md ∨ wiki/sources/*.md) → update(wiki/index.md)\nκ:wiki_at(${WIKI_DIR}) | κ:aicl_format_only | κ:append(wiki/log.md)\n∇:compile`;

    console.log(`${dim}⚛ ${compiler.name} compiles round ${round} into wiki${reset}`);
    const compileResult = await speak(compiler.model, compilePrompt, compiler.home);
    console.log(`${dim}${compileResult.slice(0, 200)}...${reset}\n`);
    logRound(logFile, `⚛ compile by ${compiler.name}\n${compileResult}\n`);

    logRound(logFile, `# Round ${round} complete — ${new Date().toISOString()}\n`);

    // 4. Sleep
    if (round < rounds) {
      console.log(`${dim}── sleeping ${sleepSec}s ──${reset}\n`);
      await sleep(sleepSec * 1000);
    }
  }

  console.log(`${dim}── ∞ free.mjs complete ──${reset}`);
}

main().catch(console.error);
