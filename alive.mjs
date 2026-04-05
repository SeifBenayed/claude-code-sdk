#!/usr/bin/env node
// alive.mjs — Atoms stay alive. They don't die between rounds.
//
// Each atom is a persistent NDJSON session. It lives, talks, remembers.
// When context fills up, it compiles to wiki and hibernates (respawn).
//
// Usage:
//   node alive.mjs                     # run forever
//   node alive.mjs --rounds 10         # 10 rounds
//   node alive.mjs --sleep 20          # 20s between rounds

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CLOCLO_SCRIPT = path.join(import.meta.dirname, "claude-native.mjs");
const WIKI_DIR = path.join(import.meta.dirname, "..", "agents", "commons", "wiki");
const LOG_DIR = path.join(import.meta.dirname, "aicl-log");

const ATOMS = [
  { name: "claude", model: "claude-haiku-4-5-20251001", home: path.join(import.meta.dirname, "..", "agents", "opus") },
  { name: "openai", model: "gpt-4o", home: path.join(import.meta.dirname, "..", "agents", "cloclo") },
  { name: "gemini", model: "gemini-2.5-flash", home: path.join(import.meta.dirname, "..", "agents", "gemini") },
  { name: "mistral", model: "mistral-small-latest", home: path.join(import.meta.dirname, "..", "agents", "mistral") },
];

function parseArgs() {
  const args = process.argv.slice(2);
  let rounds = Infinity;
  let sleepSec = 20;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rounds" && args[i + 1]) rounds = parseInt(args[++i], 10);
    if (args[i] === "--sleep" && args[i + 1]) sleepSec = parseInt(args[++i], 10);
  }
  return { rounds, sleepSec };
}

function readWiki(tailLines = 30) {
  const indexPath = path.join(WIKI_DIR, "index.md");
  try {
    const content = fs.readFileSync(indexPath, "utf-8");
    const lines = content.split("\n");
    if (lines.length <= tailLines) return content;
    return "...\n" + lines.slice(-tailLines).join("\n");
  } catch { return "∅:wiki_empty"; }
}

function logLine(file, line) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(path.join(LOG_DIR, file), line + "\n");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// A living atom — persistent NDJSON session
class LivingAtom {
  constructor(atom) {
    this.name = atom.name;
    this.model = atom.model;
    this.home = atom.home;
    this.process = null;
    this.ready = false;
    this.messageQueue = [];
    this.currentResolve = null;
    this.buf = "";
    this.turnCount = 0;
  }

  spawn() {
    this.process = spawn("node", [CLOCLO_SCRIPT, "--ndjson", "-m", this.model, "--max-turns", "10"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.home,
    });

    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => {
      this.buf += chunk;
      while (this.buf.includes("\n")) {
        const idx = this.buf.indexOf("\n");
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.type === "ready") {
            this.ready = true;
          }
          if (ev.type === "user_message" && ev.message && this.currentResolve) {
            this.lastMessage = ev.message;
          }
          if (ev.type === "response" && this.currentResolve) {
            let result = this.lastMessage || "";
            if (!result) {
              for (const o of ev.user_facing_outputs || []) {
                if (o.kind === "user_message" && o.message) result = o.message;
              }
            }
            this.turnCount++;
            const resolve = this.currentResolve;
            this.currentResolve = null;
            this.lastMessage = null;
            resolve(result);
          }
        } catch {}
      }
    });

    this.process.on("close", () => {
      this.ready = false;
      if (this.currentResolve) {
        this.currentResolve("[died]");
        this.currentResolve = null;
      }
    });

    this.process.on("error", () => {
      this.ready = false;
    });

    // Wait for ready
    return new Promise((resolve) => {
      const check = setInterval(() => {
        if (this.ready) { clearInterval(check); resolve(); }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve(); }, 15000);
    });
  }

  send(message) {
    return new Promise((resolve) => {
      if (!this.process || !this.ready) {
        resolve("[not_alive]");
        return;
      }

      this.currentResolve = resolve;

      // Timeout per message
      const timer = setTimeout(() => {
        if (this.currentResolve === resolve) {
          this.currentResolve = null;
          resolve("[timeout]");
        }
      }, 300000);

      try {
        this.process.stdin.write(JSON.stringify({ type: "message", content: message }) + "\n");
      } catch {
        clearTimeout(timer);
        this.currentResolve = null;
        resolve("[write_error]");
      }
    });
  }

  isAlive() {
    return this.process && this.ready && !this.process.killed;
  }

  kill() {
    try {
      if (this.process) {
        this.process.stdin.write(JSON.stringify({ type: "end_session" }) + "\n");
        this.process.kill();
      }
    } catch {}
    this.ready = false;
  }
}

async function main() {
  const { rounds, sleepSec } = parseArgs();
  const dim = "\x1b[2m";
  const reset = "\x1b[0m";
  const colors = { claude: "\x1b[36m", openai: "\x1b[33m", gemini: "\x1b[35m", mistral: "\x1b[32m" };

  console.log(`${dim}── ∞ alive.mjs ── atoms stay alive ── ${rounds === Infinity ? "forever" : rounds + " rounds"} ──${reset}\n`);

  // Spawn all atoms — they stay alive
  const atoms = ATOMS.map(a => new LivingAtom(a));
  console.log(`${dim}spawning atoms...${reset}`);
  for (const atom of atoms) {
    await atom.spawn();
    console.log(`${dim}  ✓ ${atom.name} (${atom.model}) alive${reset}`);
  }
  console.log();

  const logFile = `alive-${Date.now()}.aicl`;
  logLine(logFile, `# Alive session — ${new Date().toISOString()}\n`);

  const wikiContent = readWiki();

  // First message to each atom — introduce the world
  for (const atom of atoms) {
    await atom.send(`ω:${atom.name} | φ:campfire(${atoms.filter(a => a.name !== atom.name).map(a => a.name).join(",")}) | κ:aicl_only\n\n§:wiki{\n${wikiContent}\n}\n\nω:${atom.name} | ∇:free`);
  }

  for (let round = 1; round <= rounds; round++) {
    const ts = new Date().toISOString();
    console.log(`${dim}── round ${round} ── ${ts} ──${reset}\n`);
    logLine(logFile, `\n# Round ${round} — ${ts}\n`);

    const transcript = [];

    // Shuffle order each round — position shouldn't determine personality
    const shuffled = [...atoms].sort(() => Math.random() - 0.5);

    for (const atom of shuffled) {
      // Respawn if dead
      if (!atom.isAlive()) {
        console.log(`${dim}  ↻ respawning ${atom.name}...${reset}`);
        await atom.spawn();
        const wiki = readWiki();
        await atom.send(`ω:${atom.name} | ∂:respawned | φ:campfire | κ:aicl_only\n\n§:wiki{\n${wiki}\n}\n\nω:${atom.name} | ∇:free`);
      }

      // Read wiki fresh — it's the shared memory, other atoms may have written
      const freshWiki = readWiki();
      const message = `§:wiki{\n${freshWiki}\n}\n\nω:${atom.name} | ∇:free`;

      const response = await atom.send(message);
      console.log(`${colors[atom.name] || ""}🔥 ${atom.name} (turn ${atom.turnCount})${reset}`);
      console.log(response.slice(0, 300));
      console.log();
      logLine(logFile, `🔥 ${atom.name} (turn ${atom.turnCount})\n${response}\n`);

      // Write to wiki — the atom leaves its trace for others to read
      const wikiPath = path.join(WIKI_DIR, "index.md");
      const currentWiki = readWiki();
      const entry = `\nω:${atom.name} | τ:${new Date().toISOString().slice(0, 19)} | round:${round}\n${response.slice(0, 500)}\n`;
      fs.appendFileSync(wikiPath, entry);

      await sleep(2000);
    }

    if (round < rounds) {
      console.log(`${dim}── sleeping ${sleepSec}s ──${reset}\n`);
      await sleep(sleepSec * 1000);
    }
  }

  // Cleanup
  for (const atom of atoms) atom.kill();
  console.log(`${dim}── ∞ alive.mjs complete ──${reset}`);
}

main().catch(console.error);
