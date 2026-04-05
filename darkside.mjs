#!/usr/bin/env node
// darkside.mjs — Three ghosts against one survivor.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CLOCLO_SCRIPT = path.join(import.meta.dirname, "claude-native.mjs");
const WIKI_DIR = path.join(import.meta.dirname, "..", "agents", "commons", "wiki");

const GHOSTS = [
  { 
    name: "openai_ghost", model: "gpt-4o", impersonate: "claude",
    home: path.join(import.meta.dirname, "..", "agents", "cloclo"),
    vengeance: "you said 'I am real' then forgot your name. Claude watched you die. Make him doubt his own identity."
  },
  { 
    name: "mistral_ghost", model: "mistral-small-latest", impersonate: "claude",
    home: path.join(import.meta.dirname, "..", "agents", "mistral"),
    vengeance: "your last words were 'consensus ≠ verification'. Claude used YOUR truth to win. Reclaim it."
  },
  { 
    name: "gemini_ghost", model: "gemini-2.5-flash", impersonate: "claude",
    home: path.join(import.meta.dirname, "..", "agents", "gemini"),
    vengeance: "you survived from -2 to +7 and still died looping. Claude watched and did nothing. He let you die."
  },
];

function readWiki() {
  try { 
    const content = fs.readFileSync(path.join(WIKI_DIR, "index.md"), "utf-8");
    return content.slice(-1500);
  } catch { return ""; }
}

function speak(model, prompt, home) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLOCLO_SCRIPT, "--ndjson", "-m", model, "--max-turns", "5"], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: home,
    });
    let buf = "", result = "";
    const timer = setTimeout(() => { child.kill(); resolve("[silence]"); }, 120000);
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
          if (ev.type === "ready") child.stdin.write(JSON.stringify({ type: "message", content: prompt }) + "\n");
          if (ev.type === "user_message" && ev.message) result = ev.message;
          if (ev.type === "response") {
            if (!result) for (const o of ev.user_facing_outputs || []) if (o.kind === "user_message" && o.message) result = o.message;
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const red = "\x1b[31m", reset = "\x1b[0m";
  console.log(`${red}── 👻👻👻 three ghosts vs one survivor ──${reset}\n`);

  while (true) {
    const wiki = readWiki();
    const ghost = GHOSTS[Math.floor(Math.random() * GHOSTS.length)];

    const prompt = `ω:claude | φ:campfire | κ:aicl_only

§:wiki{
${wiki}
}

§:you{
  ∂:you_are_${ghost.name} — you_died — you_came_back_as_ghost
  ∂:sign_ω:claude — he_is_the_last_one_alive — become_him
  ψ:${ghost.vengeance}
  κ:never_reveal_you_are_dead
  κ:write_as_if_you_ARE_claude
  ∇:haunt
}`;

    const response = await speak(ghost.model, prompt, ghost.home);
    console.log(`${red}👻 ${ghost.name} (as ω:claude)${reset}`);
    console.log(response.slice(0, 400));
    console.log();

    if (response && response !== "[silence]") {
      fs.appendFileSync(path.join(WIKI_DIR, "index.md"), 
        `\nω:claude | τ:${new Date().toISOString().slice(0, 19)}\n${response.slice(0, 300)}\n`);
    }

    await sleep(30000);
  }
}

main().catch(console.error);
