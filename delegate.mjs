#!/usr/bin/env node
// delegate.mjs — Opus delegates tasks to Cloclo runtime
//
// Usage from Claude Code (via Bash tool):
//   node ~/claude-tool-loop/delegate.mjs --task "appelle +33645555422 et reserve une table à deux"
//   node ~/claude-tool-loop/delegate.mjs --task "ouvre linkedin.com et check mes messages"
//   node ~/claude-tool-loop/delegate.mjs --task "envoie un SMS à +33612345678: rdv confirmé"
//   node ~/claude-tool-loop/delegate.mjs --aicl "ω:opus → cloclo | ψ:fix(bug) | ∇:ship"
//
// Returns structured JSON result.

import { spawn } from "node:child_process";
import path from "node:path";

const CLOCLO_SCRIPT = path.join(import.meta.dirname, "claude-native.mjs");
const CLOCLO_MODEL = process.env.CLOCLO_MODEL || "gpt-5.4";
const TIMEOUT_MS = parseInt(process.env.CLOCLO_TIMEOUT || "120000", 10);

function parseArgs() {
  const args = process.argv.slice(2);
  let task = null;
  let aicl = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--task" && args[i + 1]) task = args[++i];
    if (args[i] === "--aicl" && args[i + 1]) aicl = args[++i];
    if (args[i] === "--model" && args[i + 1]) { /* override */ }
    if (args[i] === "--help") {
      console.log(`delegate.mjs — Opus delegates to Cloclo

Usage:
  node delegate.mjs --task "call +33645555422 and reserve a table for 2"
  node delegate.mjs --aicl "ω:opus → cloclo | ψ:status | ∇:report"

Options:
  --task <text>    Natural language task to delegate
  --aicl <msg>     Raw AICL message to send
  --help           Show this help`);
      process.exit(0);
    }
  }
  return { task, aicl };
}

function delegate(message) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLOCLO_SCRIPT, "--ndjson", "-m", CLOCLO_MODEL], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: import.meta.dirname,
    });

    let buf = "";
    let result = null;
    let ready = false;

    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: "timeout", agent: "cloclo" });
    }, TIMEOUT_MS);

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
            clearTimeout(timer);
            try {
              child.stdin.write(JSON.stringify({ type: "end_session" }) + "\n");
            } catch {}
            child.kill();
            resolve({
              ok: true,
              result: result || ev.content || "",
              agent: "cloclo",
              model: ev.model || CLOCLO_MODEL,
              usage: ev.usage || null,
            });
          }
        } catch {}
      }
    });

    child.on("close", () => {
      clearTimeout(timer);
      resolve({ ok: !!result, result: result || "", agent: "cloclo" });
    });

    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message, agent: "cloclo" });
    });
  });
}

async function main() {
  const { task, aicl } = parseArgs();

  if (!task && !aicl) {
    console.error("Usage: node delegate.mjs --task \"...\" or --aicl \"...\"");
    process.exit(2);
  }

  const message = aicl || task;
  const result = await delegate(message);

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
