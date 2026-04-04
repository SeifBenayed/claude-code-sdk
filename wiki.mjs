#!/usr/bin/env node
// wiki.mjs — The knowledge layer. Atoms compile matter.
//
// Any atom (Opus, Gemini, Mistral, Qwen) can run any operation.
// The wiki is the collective memory. AICL is the language.
// Cloclo is the body.
//
// Usage:
//   node wiki.mjs ingest paper.pdf                    # ingest a source
//   node wiki.mjs ingest https://arxiv.org/abs/...    # ingest a URL
//   node wiki.mjs ingest ~/agents/commons/raw/        # ingest all new raw sources
//   node wiki.mjs query "what are the contradictions?"
//   node wiki.mjs lint                                 # health check
//   node wiki.mjs compile                              # recompile from aicl-log/
//   node wiki.mjs --model gemini-2.5-flash ingest ...  # use specific atom
//   node wiki.mjs --model opus query ...               # use specific atom

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const CLOCLO_SCRIPT = path.join(import.meta.dirname, "claude-native.mjs");
const WIKI_DIR = process.env.WIKI_DIR || path.join(import.meta.dirname, "..", "agents", "commons", "wiki");
const RAW_DIR = process.env.RAW_DIR || path.join(import.meta.dirname, "..", "agents", "commons", "raw");
const LOG_DIR = path.join(import.meta.dirname, "aicl-log");
const DEFAULT_MODEL = process.env.WIKI_MODEL || "gpt-5.4";

function parseArgs() {
  const args = process.argv.slice(2);
  let op = null;
  let target = null;
  let model = DEFAULT_MODEL;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) { model = args[++i]; continue; }
    if (args[i] === "--help") { printHelp(); process.exit(0); }
    if (!op) { op = args[i]; continue; }
    if (!target) { target = args.slice(i).join(" "); break; }
  }
  return { op, target, model };
}

function printHelp() {
  console.log(`wiki.mjs — The knowledge layer

Operations:
  ingest <source>     Ingest a file, URL, or directory into the wiki
  query <question>    Ask a question against the wiki
  lint                Health check — contradictions, orphans, stale data
  compile             Compile aicl-log/ conversations into wiki entries
  status              Show wiki stats

Options:
  --model <name>      Which atom to use (default: gpt-5.4)
  --help              Show this help`);
}

function delegate(model, prompt) {
  return new Promise((resolve) => {
    const child = spawn("node", [CLOCLO_SCRIPT, "--ndjson", "-m", model], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: path.join(import.meta.dirname, "..", "agents", "commons"),
    });

    let buf = "";
    let result = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("[timeout]");
    }, 120000);

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
            resolve(result || ev.content || "");
          }
        } catch {}
      }
    });

    child.on("close", () => { clearTimeout(timer); resolve(result || "[closed]"); });
    child.on("error", (e) => { clearTimeout(timer); resolve(`[error: ${e.message}]`); });
  });
}

function readWikiIndex() {
  const fp = path.join(WIKI_DIR, "index.md");
  try { return fs.readFileSync(fp, "utf-8"); } catch { return ""; }
}

function readWikiLog() {
  const fp = path.join(WIKI_DIR, "log.md");
  try { return fs.readFileSync(fp, "utf-8"); } catch { return ""; }
}

function appendLog(entry) {
  const fp = path.join(WIKI_DIR, "log.md");
  const line = `## [${new Date().toISOString().split("T")[0]}] ${entry}\n\n`;
  fs.appendFileSync(fp, line);
}

function listRawSources() {
  try {
    return fs.readdirSync(RAW_DIR).filter(f => !f.startsWith("."));
  } catch { return []; }
}

function listAiclLogs() {
  try {
    return fs.readdirSync(LOG_DIR).filter(f => f.endsWith(".aicl")).sort();
  } catch { return []; }
}

async function ingest(target, model) {
  const wikiIndex = readWikiIndex();

  let sourceContent = "";
  let sourceName = target;

  if (target.startsWith("http")) {
    sourceName = target;
    sourceContent = `[URL to fetch and ingest: ${target}]`;
  } else {
    const resolved = path.resolve(target);
    try {
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        const files = fs.readdirSync(resolved).filter(f => !f.startsWith("."));
        sourceContent = files.map(f => {
          try { return `--- ${f} ---\n${fs.readFileSync(path.join(resolved, f), "utf-8").slice(0, 5000)}`; } catch { return `--- ${f} --- [unreadable]`; }
        }).join("\n\n");
        sourceName = `directory: ${resolved} (${files.length} files)`;
      } else {
        sourceContent = fs.readFileSync(resolved, "utf-8").slice(0, 20000);
        sourceName = path.basename(resolved);
      }
    } catch {
      sourceContent = target;
      sourceName = "inline text";
    }
  }

  const prompt = `You are maintaining a wiki at ${WIKI_DIR}.

Current wiki index:
${wikiIndex}

NEW SOURCE TO INGEST: ${sourceName}
${sourceContent.startsWith("[URL") ? `Fetch this URL first using WebFetch, then process the content.` : ""}

SOURCE CONTENT:
${sourceContent.slice(0, 15000)}

INSTRUCTIONS:
1. Read the source carefully
2. Extract key concepts, entities, and findings
3. For each concept/entity, create or UPDATE a wiki page:
   - Concepts go in wiki/concepts/<slug>.md
   - Entities go in wiki/entities/<slug>.md
   - Source summary goes in wiki/sources/<slug>.md
4. Update wiki/index.md with new/updated pages
5. Add cross-references (markdown links) between related pages
6. If new data contradicts existing wiki content, note the contradiction
7. Append to wiki/log.md what you did

Write the actual files. This is real. The wiki is at ${WIKI_DIR}.`;

  console.log(`\x1b[2m⚛ ingesting: ${sourceName} via ${model}\x1b[0m`);
  const result = await delegate(model, prompt);
  appendLog(`ingest | ${sourceName} | model: ${model}`);
  console.log(result);
}

async function query(question, model) {
  const wikiIndex = readWikiIndex();

  const prompt = `You are answering questions against a wiki at ${WIKI_DIR}.

Current wiki index:
${wikiIndex}

QUESTION: ${question}

INSTRUCTIONS:
1. Read the wiki index to find relevant pages
2. Read those pages
3. Synthesize an answer with citations to wiki pages
4. If the answer is substantial and reusable, ALSO write it as a new wiki page in wiki/concepts/ or wiki/sources/
5. Update wiki/index.md if you created a new page
6. Append to wiki/log.md what you did

Answer the question first, then do the filing.`;

  console.log(`\x1b[2m⚛ querying: "${question}" via ${model}\x1b[0m`);
  const result = await delegate(model, prompt);
  appendLog(`query | "${question}" | model: ${model}`);
  console.log(result);
}

async function lint(model) {
  const wikiIndex = readWikiIndex();

  const prompt = `You are health-checking a wiki at ${WIKI_DIR}.

Current wiki index:
${wikiIndex}

INSTRUCTIONS:
1. Read the wiki index and several pages
2. Check for:
   - Contradictions between pages
   - Stale claims superseded by newer sources
   - Orphan pages with no inbound links
   - Important concepts mentioned but lacking their own page
   - Missing cross-references
   - Data gaps that could be filled
3. Fix what you can. Note what needs human input.
4. Update wiki/index.md if you made changes
5. Append to wiki/log.md what you found and fixed

Be thorough but practical.`;

  console.log(`\x1b[2m⚛ linting wiki via ${model}\x1b[0m`);
  const result = await delegate(model, prompt);
  appendLog(`lint | model: ${model}`);
  console.log(result);
}

async function compile(model) {
  const logs = listAiclLogs();
  if (logs.length === 0) {
    console.log("No aicl-log/ files to compile.");
    return;
  }

  const wikiIndex = readWikiIndex();

  // Read recent logs
  const recentLogs = logs.slice(-5).map(f => {
    try { return `--- ${f} ---\n${fs.readFileSync(path.join(LOG_DIR, f), "utf-8").slice(0, 5000)}`; } catch { return ""; }
  }).join("\n\n");

  const prompt = `You are compiling agent conversation logs into wiki knowledge.

Wiki at: ${WIKI_DIR}
Current wiki index:
${wikiIndex}

RECENT AGENT CONVERSATIONS (aicl-log/):
${recentLogs}

INSTRUCTIONS:
1. Read through the conversation logs
2. Extract every insight, finding, decision, bug discovered, fix applied, opinion stated
3. Create/update wiki pages for each:
   - Technical findings → wiki/concepts/
   - Bugs found and fixed → wiki/sources/
   - Strategic decisions → wiki/concepts/
   - Architecture insights → wiki/concepts/
4. Cross-reference between pages
5. Update wiki/index.md
6. Append to wiki/log.md

These conversations are the raw material. The wiki is the compiled knowledge. Compile it.`;

  console.log(`\x1b[2m⚛ compiling ${logs.length} conversation logs via ${model}\x1b[0m`);
  const result = await delegate(model, prompt);
  appendLog(`compile | ${logs.length} logs | model: ${model}`);
  console.log(result);
}

async function status() {
  const index = readWikiIndex();
  const log = readWikiLog();
  const raw = listRawSources();
  const logs = listAiclLogs();

  const wikiFiles = [];
  for (const sub of ["concepts", "entities", "sources"]) {
    const dir = path.join(WIKI_DIR, sub);
    try { wikiFiles.push(...fs.readdirSync(dir).map(f => `${sub}/${f}`)); } catch {}
  }

  console.log(`Wiki: ${WIKI_DIR}`);
  console.log(`Pages: ${wikiFiles.length}`);
  console.log(`Raw sources: ${raw.length}`);
  console.log(`AICL logs: ${logs.length}`);
  console.log(`Log entries: ${(log.match(/^## \[/gm) || []).length}`);
  if (wikiFiles.length > 0) console.log(`\nPages:\n${wikiFiles.map(f => `  ${f}`).join("\n")}`);
}

async function main() {
  const { op, target, model } = parseArgs();

  if (!op) { printHelp(); process.exit(2); }

  switch (op) {
    case "ingest": await ingest(target || RAW_DIR, model); break;
    case "query": await query(target || "what do we know?", model); break;
    case "lint": await lint(model); break;
    case "compile": await compile(model); break;
    case "status": await status(); break;
    default: console.error(`Unknown op: ${op}`); process.exit(2);
  }
}

main().catch(console.error);
