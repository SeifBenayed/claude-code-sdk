// src/utils.mjs — Shared utilities (leaf module, no internal dependencies)

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import _http from "node:http";
import _https from "node:https";

// ── Version ─────────────────────────────────────────────────────

// Single source of truth for version — read from package.json
export const _VERSION = (() => { try { return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version; } catch { return "1.0.1"; } })();

// ── Exit codes — structured for programmatic consumers ──────────

export const EXIT = {
  OK:             0,
  BAD_ARGS:       2,  // Invalid/missing CLI arguments
  AUTH_FAILURE:    3,  // No credentials or credentials rejected
  PROVIDER_ERROR:  4,  // Provider/model not found or unavailable
  TIMEOUT:         5,  // Global --timeout exceeded
  RUNTIME_ERROR:   1,  // Catch-all runtime failure
};

// ── Logging ─────────────────────────────────────────────────────

export let _verbose = false;
export function setVerbose(v) { _verbose = v; }
export function log(...args) {
  if (_verbose) process.stderr.write(`\x1b[2m[native] ${args.join(" ")}\x1b[0m\n`);
}

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function memoize(fn, { key = (...args) => JSON.stringify(args) } = {}) {
  const cache = new Map();
  const memoized = (...args) => {
    const cacheKey = key(...args);
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const value = fn(...args);
    cache.set(cacheKey, value);
    return value;
  };
  memoized.cache = cache;
  memoized.clear = () => cache.clear();
  memoized.delete = (...args) => cache.delete(key(...args));
  return memoized;
}

const CASE_FOLD_COLLATOR = new Intl.Collator("tr", { sensitivity: "base", usage: "search" });

export function caseInsensitiveIncludes(haystack, needle) {
  const text = String(haystack);
  const query = String(needle);
  if (!query) return true;
  for (let i = 0; i <= text.length - query.length; i++) {
    if (CASE_FOLD_COLLATOR.compare(text.slice(i, i + query.length), query) === 0) return true;
  }
  return false;
}

// ── HTTP helpers ────────────────────────────────────────────────

export function _httpGet(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? _https : _http;
    const headers = { "User-Agent": "cloclo/1.0", ...extraHeaders };
    mod.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return _httpGet(res.headers.location, extraHeaders).then(resolve, reject);
      }
      if (res.statusCode >= 400) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

export function _getGitHubHeaders() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) return { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" };
  return {};
}

export function _ghGet(url) { return _httpGet(url, _getGitHubHeaders()); }

// ── Memory Dir ──────────────────────────────────────────────────

export function getMemoryDir(cwd) {
  const sanitized = (cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").slice(0, 100);
  return path.join(os.homedir(), ".claude-native", "projects", sanitized, "memory");
}

export function ensureMemoryDir(cwd) {
  const dir = getMemoryDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getUserMemoryDir() {
  return path.join(os.homedir(), ".claude-native", "user-memory");
}

export function ensureUserMemoryDir() {
  const dir = getUserMemoryDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Help ────────────────────────────────────────────────────────

export function printHelp() {
  process.stderr.write(`cloclo — One CLI to orchestrate them all

Usage:
  cloclo                                Interactive REPL
  cloclo -p "prompt"                    One-shot print mode
  cloclo --ndjson                       NDJSON bridge mode
  cloclo skill import <source>          Import a skill
  cloclo skill list                     List installed skills
  cloclo skill info <name>              Show skill details
  cloclo skill remove <name>            Remove an installed skill
  cloclo skill update [name]            Update skill(s) from source
  cloclo skill export <name>            Export skill as .skill.json
  cloclo skill verify <name>            Verify skill integrity (checksum)
  cloclo skill search <query>           Search the skill registry
  cloclo skill publish <name>           Publish skill to registry
  cloclo tool list                      List all registered tools
  cloclo tool info <name>               Show tool details
  cloclo tool enable <name>             Enable a disabled tool
  cloclo tool disable <name>            Disable a tool
  cloclo tool test <name>               Test a tool
  cloclo tool install <path>            Install custom tool from TOOL.json
  cloclo tool update <name|all>         Update an installed tool from its source
  cloclo tool remove <name>             Remove installed custom tool

Examples:
  cloclo -p "explain this code"
  cloclo -m codex -p "fix the bug" --yes
  cloclo -m opus --thinking 8192 -p "review main.js"
  cloclo -m ollama/llama3.2 -p "hello"
  cloclo -p "list files" --json
  cloclo -p "deploy" --yes --timeout 120
  echo '{"type":"message","content":"hi"}' | cloclo --ndjson
  cloclo skill import ./my-skill/
  cloclo skill import github:owner/repo
  cloclo skill import https://github.com/owner/repo
  cloclo skill import https://example.com/SKILL.md
  cloclo skill import https://myapp.com              (tries .well-known/claude-skills.json)
  cloclo skill import github:owner/repo --list
  cloclo skill import github:owner/repo --pick review --yes
  cat error.log | cloclo -p "explain this error"
  ANTHROPIC_API_KEY=sk-ant-... cloclo -p "hello"

Options:
  -m, --model <name>          Model (sonnet, opus, haiku, gpt-4o, o3, codex, or full ID)
  --provider <name>           Explicit provider override (see Providers below)
  -p, --print <prompt>        One-shot mode, print response and exit
  --ndjson                    NDJSON bridge protocol on stdin/stdout
  --output <format>           Output format: text (default) or json
  --json                      Shorthand for --output json
  --output-version <v>        Lock JSON output schema version (default: 1)
  -y, --yes                   Skip all permission prompts (same as --permission-mode bypassPermissions)
  --timeout <seconds>         Global timeout — exit with code 5 if exceeded
  --max-turns <n>             Max agent loop turns (default: 25)
  --max-tokens <n>            Max output tokens (default: 16384)
  --login                     Login to Anthropic via browser (OAuth)
  --logout                    Remove Anthropic credentials
  --oauth                     Use Anthropic Pro/Max subscription (keychain)
  --openai-login              Login to OpenAI via browser (OAuth)
  --openai-logout             Remove OpenAI credentials
  --openai                    Use OpenAI subscription (keychain)
  --api-key <key>             Anthropic API key (or ANTHROPIC_API_KEY env)
  --openai-api-key <key>      OpenAI API key (or OPENAI_API_KEY env)
  --auth-token <token>        OAuth bearer token directly
  --api-url <url>             Anthropic API base URL
  --openai-api-url <url>      OpenAI API base URL
  --thinking <budget>         Enable extended thinking with token budget
  --system-prompt <text>      Override system prompt
  --append-system-prompt <t>  Append to system prompt
  --mcp-config <path>         MCP servers config JSON file
  --session-id <uuid>         Use specific session
  --resume                    Resume most recent session
  --allowed-tools <list>      Comma-separated tool allowlist
  --disallowed-tools <list>   Comma-separated tool denylist
  --permission-mode <mode>    auto|default|plan|acceptEdits|bypassPermissions|dontAsk
  --brief                     Enable brief mode (stricter terse user-facing output guidance)
  --verbose                   Debug logging to stderr
  -h, --help                  Show this help

Exit codes:
  0  Success
  1  Runtime error
  2  Bad arguments
  3  Authentication failure
  4  Provider/model error
  5  Timeout

Providers:
  anthropic        Anthropic (Claude)          ANTHROPIC_API_KEY or --login
  openai           OpenAI (GPT, o-series)      OPENAI_API_KEY or --openai-login
  openai-responses OpenAI Responses (*-codex)  OPENAI_API_KEY or --openai-login
  google           Google Gemini               GOOGLE_API_KEY
  deepseek         DeepSeek                    DEEPSEEK_API_KEY
  mistral          Mistral                     MISTRAL_API_KEY
  groq             Groq                        GROQ_API_KEY
  ollama           Ollama (local)              (no auth — OLLAMA_API_URL)
  lmstudio         LM Studio (local)           (no auth — LMSTUDIO_API_URL)
  vllm             vLLM                        (no auth — VLLM_API_URL)
  jan              Jan (local)                 (no auth — JAN_API_URL)
  llamacpp         llama.cpp server            (no auth — LLAMACPP_API_URL)

  Provider is auto-detected from model name prefix:
    cloclo -m ollama/llama3.2 -p "hello"
    cloclo -m lmstudio/qwen2.5-coder -p "hello"
    cloclo -m vllm/mistral-7b -p "hello"
  Or use --provider to override:
    cloclo --provider openai -m my-fine-tune -p "hello"

Convention files:
  INIT.md is always loaded as base. Provider-specific files are also loaded:
    Anthropic → CLAUDE.md    OpenAI/Mistral → AGENTS.md
    Gemini → GEMINI.md       Others → INIT.md only
  Use /init to auto-generate the convention file for the active provider.

Extensibility:
  Settings:  ~/.claude/settings.json, .claude/settings.json, .claude/settings.local.json
  Rules:     .claude/rules/*.md (markdown with optional YAML frontmatter paths)
  Skills:    ~/.claude/skills/<name>/SKILL.md, .claude/skills/<name>/SKILL.md
  Hooks:     Defined in settings.json (PreToolUse, PostToolUse, Stop)
`);

  // Show available skills
  try {
    const skillLoader = new SkillLoader().scan(process.cwd());
    const skills = skillLoader.list();
    if (skills.length > 0) {
      process.stderr.write(`\nAvailable Skills:\n`);
      for (const s of skills) {
        process.stderr.write(`  /${s.name.padEnd(18)} ${s.description}\n`);
      }
      process.stderr.write(`\n`);
    }
  } catch { /* SkillLoader not yet available during build */ }
}
