// ── Config & Argument Parsing ─────────────────────────────────
// Extracted from claude-native.mjs

import fs from "fs";
import path from "path";
import os from "os";
import { EXIT, printHelp } from "./utils.mjs";
import { detectProvider } from "./providers.mjs";
import { oauthLogin, oauthLogout, openaiOAuthLogin, openaiOAuthLogout } from "./auth.mjs";

async function parseArgs(argv = process.argv.slice(2)) {
  const cfg = {
    model: "claude-sonnet-4-6",
    maxTurns: 25,
    apiKey: process.env.ANTHROPIC_API_KEY || "",
    authToken: process.env.ANTHROPIC_AUTH_TOKEN || "",  // OAuth token (Pro/Max subscription)
    apiUrl: process.env.ANTHROPIC_API_URL || "https://api.anthropic.com",
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiApiUrl: process.env.OPENAI_API_URL || "https://api.openai.com",
    useOAuth: false,  // --oauth flag: use Anthropic Pro subscription via keychain
    useOpenAIOAuth: false,  // --openai flag: use OpenAI subscription via keychain
    ndjson: false,
    interactive: true,
    prompt: null,
    resume: false,
    sessionId: null,
    verbose: false,
    systemPrompt: "",
    appendSystemPrompt: "",
    thinkingBudget: 0,
    maxTokens: 16384,
    mcpConfig: null,
    allowedTools: null,
    disallowedTools: null,
    provider: null,  // explicit provider override (anthropic|openai|google|deepseek|mistral|groq|ollama)
    permissionMode: "auto",  // auto|default|plan|acceptEdits|bypassPermissions|dontAsk
    permissionRules: [],        // [{tool, pattern, behavior: "allow"|"deny"}]
    permissionCallbacks: false, // forward permission requests to NDJSON agent
    briefMode: false,           // brief mode: stricter terse guidance for the user-facing output surface
    outputFormat: "text",       // "text" (default) or "json" for structured output
    timeout: 0,                 // global timeout in seconds (0 = no limit)
    jsonSchema: null,            // JSON Schema for structured output validation
    sandboxMode: "host",           // "host" | "docker" | "auto" — Bash isolation mode (opt-in: --sandbox docker)
    _subcommand: null,           // "skill-import" or null
    _skillImportSource: null,    // source for skill import
    cwd: process.cwd(),
  };

  // Flags that consume the next argv element as a value
  const FLAGS_WITH_VALUE = new Set([
    "--model", "-m", "--max-turns", "--api-key", "--auth-token", "--api-url",
    "--openai-api-key", "--openai-api-url", "--provider", "-p", "--print",
    "--session-id", "--system-prompt", "--append-system-prompt", "--thinking",
    "--max-tokens", "--mcp-config", "--allowed-tools", "--disallowed-tools",
    "--permission-mode", "--output", "--output-version", "--timeout",
    "--sandbox", "--json-schema",
  ]);

  // Flags that are boolean (no value)
  const FLAGS_BOOLEAN = new Set([
    "--oauth", "--ndjson", "--resume", "--verbose", "--permission-callbacks",
    "--brief", "--json", "--yes", "-y", "--openai", "--login", "--logout",
    "--openai-login", "--openai-logout", "--help", "-h",
  ]);

  // Helper: require next argv value or die
  function needValue(flag, i) {
    if (i >= argv.length) {
      process.stderr.write(`Error: ${flag} requires a value\n  cloclo ${flag} <value>\n`);
      process.exit(EXIT.BAD_ARGS);
    }
    return argv[i];
  }

  // Valid values for enum-style flags
  const VALID_PERMISSION_MODES = new Set(["auto", "default", "plan", "acceptEdits", "bypassPermissions", "dontAsk"]);
  const VALID_OUTPUT_FORMATS = new Set(["text", "json"]);

  // Subcommand prefix check (before flag parsing)
  if (argv[0] === "skill") {
    const sub = argv[1];
    if (sub === "import") {
      cfg._subcommand = "skill-import";
      cfg._skillImportSource = argv[2];
      if (!cfg._skillImportSource) { process.stderr.write("Error: skill import requires a source\n  cloclo skill import <folder|SKILL.md|URL|github:owner/repo>\n"); process.exit(EXIT.BAD_ARGS); }
      cfg.interactive = false; cfg._skillImportList = false; cfg._skillImportPick = null; cfg._skillImportFormat = null;
      for (let j = 3; j < argv.length; j++) {
        if (argv[j] === "--yes" || argv[j] === "-y") cfg.permissionMode = "bypassPermissions";
        else if (argv[j] === "--verbose") cfg.verbose = true;
        else if (argv[j] === "--list") cfg._skillImportList = true;
        else if (argv[j] === "--pick" && j + 1 < argv.length) cfg._skillImportPick = argv[++j];
        else if (argv[j] === "--format" && j + 1 < argv.length) cfg._skillImportFormat = argv[++j];
      }
      return cfg;
    } else if (sub === "list") { cfg._subcommand = "skill-list"; cfg.interactive = false; return cfg; }
    else if (sub === "info") { cfg._subcommand = "skill-info"; cfg._skillInfoName = argv[2]; if (!cfg._skillInfoName) { process.stderr.write("Error: skill info requires a skill name\n"); process.exit(EXIT.BAD_ARGS); } cfg.interactive = false; return cfg; }
    else if (sub === "remove") { cfg._subcommand = "skill-remove"; cfg._skillRemoveName = argv[2]; if (!cfg._skillRemoveName) { process.stderr.write("Error: skill remove requires a skill name\n"); process.exit(EXIT.BAD_ARGS); } cfg.interactive = false; for (let j = 3; j < argv.length; j++) { if (argv[j] === "--yes" || argv[j] === "-y") cfg.permissionMode = "bypassPermissions"; } return cfg; }
    else if (sub === "update") { cfg._subcommand = "skill-update"; cfg._skillUpdateName = argv[2] || null; cfg.interactive = false; for (let j = 3; j < argv.length; j++) { if (argv[j] === "--yes" || argv[j] === "-y") cfg.permissionMode = "bypassPermissions"; } return cfg; }
    else if (sub === "export") { cfg._subcommand = "skill-export"; cfg._skillExportName = argv[2]; if (!cfg._skillExportName) { process.stderr.write("Error: skill export requires a skill name\n"); process.exit(EXIT.BAD_ARGS); } cfg.interactive = false; return cfg; }
    else if (sub === "verify") { cfg._subcommand = "skill-verify"; cfg._skillVerifyName = argv[2]; if (!cfg._skillVerifyName) { process.stderr.write("Error: skill verify requires a skill name\n"); process.exit(EXIT.BAD_ARGS); } cfg.interactive = false; return cfg; }
    else if (sub === "search") { cfg._subcommand = "skill-search"; cfg._skillSearchQuery = argv.slice(2).join(" "); if (!cfg._skillSearchQuery) { process.stderr.write("Error: skill search requires a query\n"); process.exit(EXIT.BAD_ARGS); } cfg.interactive = false; return cfg; }
    else if (sub === "publish") { cfg._subcommand = "skill-publish"; cfg._skillPublishName = argv[2]; if (!cfg._skillPublishName) { process.stderr.write("Error: skill publish requires a skill name\n"); process.exit(EXIT.BAD_ARGS); } cfg.interactive = false; return cfg; }
    else { process.stderr.write(`Error: Unknown skill subcommand "${sub || ""}"\n  Available: import, list, info, remove, update, export, verify, search, publish\n`); process.exit(EXIT.BAD_ARGS); }
  }

  // Cron: cloclo cron [add|list|remove|run|enable|disable]
  if (argv[0] === "cron") { cfg._subcommand = "cron"; cfg._cronArgs = argv.slice(1); cfg.interactive = false; return cfg; }

  // Top-level catalog shortcut: cloclo catalog [query]
  if (argv[0] === "catalog") { cfg._subcommand = "tool-catalog"; cfg._toolCatalogQuery = argv.slice(1).join(" ") || "*"; cfg.interactive = false; return cfg; }

  // Remote session: cloclo remote [stop]
  if (argv[0] === "remote") { cfg._subcommand = "remote"; cfg._remoteSub = argv[1] || "start"; cfg.interactive = true; return cfg; }

  // Tool subcommands
  if (argv[0] === "tool") {
    const sub = argv[1];
    if (sub === "list") { cfg._subcommand = "tool-list"; cfg.interactive = false; return cfg; }
    else if (sub === "info") { cfg._subcommand = "tool-info"; cfg._toolInfoName = argv[2]; if (!cfg._toolInfoName) { process.stderr.write("Error: tool info requires a tool name\n"); process.exit(EXIT.BAD_ARGS); } cfg.interactive = false; return cfg; }
    else if (sub === "enable") { cfg._subcommand = "tool-enable"; cfg._toolEnableName = argv[2]; if (!cfg._toolEnableName) { process.stderr.write("Error: tool enable requires a tool name\n"); process.exit(EXIT.BAD_ARGS); } cfg.interactive = false; return cfg; }
    else if (sub === "disable") { cfg._subcommand = "tool-disable"; cfg._toolDisableName = argv[2]; if (!cfg._toolDisableName) { process.stderr.write("Error: tool disable requires a tool name\n"); process.exit(EXIT.BAD_ARGS); } cfg.interactive = false; return cfg; }
    else if (sub === "test") { cfg._subcommand = "tool-test"; cfg._toolTestName = argv[2]; if (!cfg._toolTestName) { process.stderr.write("Error: tool test requires a tool name\n"); process.exit(EXIT.BAD_ARGS); } cfg.interactive = false; return cfg; }
    else if (sub === "install") { cfg._subcommand = "tool-install"; cfg._toolInstallSource = argv[2]; if (!cfg._toolInstallSource) { process.stderr.write("Error: tool install requires a path\n"); process.exit(EXIT.BAD_ARGS); } cfg.interactive = false; return cfg; }
    else if (sub === "update") { cfg._subcommand = "tool-update"; cfg._toolUpdateName = argv[2]; if (!cfg._toolUpdateName) { process.stderr.write("Error: tool update requires a tool name or 'all'\n"); process.exit(EXIT.BAD_ARGS); } cfg.interactive = false; return cfg; }
    else if (sub === "remove") { cfg._subcommand = "tool-remove"; cfg._toolRemoveName = argv[2]; if (!cfg._toolRemoveName) { process.stderr.write("Error: tool remove requires a tool name\n"); process.exit(EXIT.BAD_ARGS); } cfg.interactive = false; return cfg; }
    else if (sub === "catalog") { cfg._subcommand = "tool-catalog"; cfg._toolCatalogQuery = argv.slice(2).join(" ") || "*"; cfg.interactive = false; return cfg; }
    else if (sub === "publish") { cfg._subcommand = "tool-publish"; cfg._toolPublishName = argv[2]; if (!cfg._toolPublishName) { process.stderr.write("Error: tool publish requires a tool name\n"); process.exit(EXIT.BAD_ARGS); } cfg.interactive = false; return cfg; }
    else { process.stderr.write(`Error: Unknown tool subcommand "${sub || ""}"\n  Available: list, info, enable, disable, test, install, update, remove, catalog, publish\n`); process.exit(EXIT.BAD_ARGS); }
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--model": case "-m": cfg.model = resolveModel(needValue(a, ++i)); break;
      case "--max-turns": {
        const v = needValue(a, ++i);
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 1) { process.stderr.write(`Error: --max-turns must be a positive integer, got "${v}"\n`); process.exit(EXIT.BAD_ARGS); }
        cfg.maxTurns = n; break;
      }
      case "--api-key": cfg.apiKey = needValue(a, ++i); break;
      case "--auth-token": cfg.authToken = needValue(a, ++i); break;
      case "--oauth": cfg.useOAuth = true; break;
      case "--api-url": cfg.apiUrl = needValue(a, ++i); break;
      case "--openai-api-key": cfg.openaiApiKey = needValue(a, ++i); break;
      case "--openai-api-url": cfg.openaiApiUrl = needValue(a, ++i); break;
      case "--provider": cfg.provider = needValue(a, ++i); break;
      case "--ndjson": cfg.ndjson = true; cfg.interactive = false; break;
      case "-p": case "--print": {
        const v = needValue(a, ++i);
        if (v.startsWith("-")) {
          process.stderr.write(`Error: ${a} requires a prompt value; got another flag "${v}"\n  Use ${a} "your prompt"\n`);
          process.exit(EXIT.BAD_ARGS);
        }
        cfg.prompt = v;
        cfg.interactive = false;
        break;
      }
      case "--resume": cfg.resume = true; break;
      case "--session-id": {
        const v = needValue(a, ++i);
        if (!/^[a-zA-Z0-9_-]+$/.test(v) || v.length > 128) {
          process.stderr.write(`Error: --session-id must be alphanumeric/hyphens/underscores, max 128 chars\n  Got: "${v.substring(0, 40)}${v.length > 40 ? "..." : ""}"\n`);
          process.exit(EXIT.BAD_ARGS);
        }
        cfg.sessionId = v; break;
      }
      case "--verbose": cfg.verbose = true; break;
      case "--system-prompt": cfg.systemPrompt = needValue(a, ++i); break;
      case "--append-system-prompt": cfg.appendSystemPrompt = needValue(a, ++i); break;
      case "--thinking": {
        const v = needValue(a, ++i);
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 1) { process.stderr.write(`Error: --thinking must be a positive integer (token budget), got "${v}"\n`); process.exit(EXIT.BAD_ARGS); }
        cfg.thinkingBudget = n; break;
      }
      case "--max-tokens": {
        const v = needValue(a, ++i);
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 1) { process.stderr.write(`Error: --max-tokens must be a positive integer, got "${v}"\n`); process.exit(EXIT.BAD_ARGS); }
        cfg.maxTokens = n; break;
      }
      case "--mcp-config": cfg.mcpConfig = needValue(a, ++i); break;
      case "--allowed-tools": cfg.allowedTools = (cfg.allowedTools || []).concat(needValue(a, ++i).split(",")); break;
      case "--disallowed-tools": cfg.disallowedTools = (cfg.disallowedTools || []).concat(needValue(a, ++i).split(",")); break;
      case "--permission-mode": {
        const v = needValue(a, ++i);
        if (!VALID_PERMISSION_MODES.has(v)) {
          process.stderr.write(`Error: --permission-mode must be one of: ${[...VALID_PERMISSION_MODES].join(", ")}\n  Got: "${v}"\n`);
          process.exit(EXIT.BAD_ARGS);
        }
        cfg.permissionMode = v; break;
      }
      case "--permission-callbacks": cfg.permissionCallbacks = true; break;
      case "--brief": cfg.briefMode = true; break;
      case "--output": {
        const v = needValue(a, ++i);
        if (!VALID_OUTPUT_FORMATS.has(v)) {
          process.stderr.write(`Error: --output must be one of: ${[...VALID_OUTPUT_FORMATS].join(", ")}\n  Got: "${v}"\n`);
          process.exit(EXIT.BAD_ARGS);
        }
        cfg.outputFormat = v; break;
      }
      case "--output-version": cfg.outputVersion = needValue(a, ++i); break;
      case "--json": cfg.outputFormat = "json"; break;
      case "--timeout": {
        const v = needValue(a, ++i);
        const n = parseInt(v, 10);
        if (isNaN(n) || n < 0) { process.stderr.write(`Error: --timeout must be a non-negative integer (seconds), got "${v}"\n`); process.exit(EXIT.BAD_ARGS); }
        cfg.timeout = n; break;
      }
      case "--sandbox": {
        const v = needValue(a, ++i);
        if (!["auto", "docker", "host"].includes(v)) {
          process.stderr.write(`Error: --sandbox must be auto, docker, or host\n  Got: "${v}"\n`);
          process.exit(EXIT.BAD_ARGS);
        }
        cfg.sandboxMode = v; break;
      }
      case "--json-schema": {
        const v = needValue(a, ++i);
        try { cfg.jsonSchema = JSON.parse(v); } catch (e) {
          process.stderr.write(`Error: --json-schema must be valid JSON\n  ${e.message}\n`);
          process.exit(EXIT.BAD_ARGS);
        }
        cfg.outputFormat = "json"; // imply JSON output
        break;
      }
      case "--yes": case "-y": cfg.permissionMode = "bypassPermissions"; break;
      case "--login": await oauthLogin(); process.exit(0);
      case "--logout": oauthLogout(); process.exit(0);
      case "--openai-login": await openaiOAuthLogin(); process.exit(0);
      case "--openai-logout": openaiOAuthLogout(); process.exit(0);
      case "--openai": cfg.useOpenAIOAuth = true; break;
      case "--help": case "-h": printHelp(); process.exit(0);
      default:
        if (a.startsWith("-")) {
          process.stderr.write(`Error: Unknown flag "${a}"\n  Run cloclo --help for usage\n`);
          process.exit(EXIT.BAD_ARGS);
        }
        if (!cfg.prompt) cfg.prompt = a;
        else {
          process.stderr.write(`Error: Unexpected argument "${a}" (prompt already set)\n  Use -p to pass a prompt explicitly\n`);
          process.exit(EXIT.BAD_ARGS);
        }
    }
  }

  if (cfg.prompt) cfg.interactive = false;
  return cfg;
}

// ── Model Aliases ──────────────────────────────────────────────

const BUILTIN_MODEL_ALIASES = {
  // Anthropic
  opus: "claude-opus-4-6", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5-20251001",
  "opus-4": "claude-opus-4-6", "sonnet-4": "claude-sonnet-4-6",
  // OpenAI
  "gpt-5.4": "gpt-5.4", "gpt5": "gpt-5.4", "5.4": "gpt-5.4",
  "codex": "gpt-5.3-codex", "gpt-5.3-codex": "gpt-5.3-codex",
  "gpt-5.2-codex": "gpt-5.2-codex", "gpt-5.1-codex": "gpt-5.1-codex",
  "gpt-4.1": "gpt-4.1", "4.1": "gpt-4.1",
  "gpt-4.1-mini": "gpt-4.1-mini", "4.1-mini": "gpt-4.1-mini",
  "gpt-4.1-nano": "gpt-4.1-nano", "4.1-nano": "gpt-4.1-nano",
  "gpt-4o": "gpt-4o", "gpt-4": "gpt-4o", "4o": "gpt-4o",
  "gpt-4o-mini": "gpt-4o-mini", "4o-mini": "gpt-4o-mini",
  "o3": "o3", "o3-pro": "o3-pro", "o3-mini": "o3-mini", "o4-mini": "o4-mini",
  // Google
  "gemini": "gemini-2.5-pro", "gemini-pro": "gemini-2.5-pro",
  "gemini-flash": "gemini-2.5-flash", "gemini-2.5-flash": "gemini-2.5-flash",
  "gemini-2.5-pro": "gemini-2.5-pro",
  // DeepSeek
  "deepseek": "deepseek-chat", "deepseek-r1": "deepseek-reasoner",
  // Mistral
  "mistral": "mistral-large-latest", "mistral-large": "mistral-large-latest",
  "mistral-small": "mistral-small-latest", "codestral": "codestral-latest",
  // Groq
  "llama": "llama-3.3-70b-versatile", "llama-70b": "llama-3.3-70b-versatile",
  // Local providers (prefix-based: ollama/, lmstudio/, vllm/, jan/, llamacpp/)
  // Use as: -m ollama/llama3.2, -m lmstudio/qwen2.5-coder, -m vllm/mistral, etc.
};

const BUILTIN_TIERS = {
  fast:   ["claude-haiku-4-5-20251001", "gpt-4o-mini", "gpt-4.1-nano", "gemini-2.5-flash", "mistral-small-latest"],
  mid:    ["claude-sonnet-4-6", "gpt-5.4", "gpt-4o", "gemini-2.5-pro", "mistral-large-latest", "deepseek-chat"],
  strong: ["claude-opus-4-6", "gpt-5.4", "o3", "gemini-2.5-pro"],
};

// Load model aliases and tiers from ~/.claude/rules.d/ and .claude/rules.d/
function loadModelConfig() {
  const aliases = { ...BUILTIN_MODEL_ALIASES };
  const tiers = {
    fast: [...BUILTIN_TIERS.fast],
    mid: [...BUILTIN_TIERS.mid],
    strong: [...BUILTIN_TIERS.strong],
  };

  const dirs = [
    path.join(os.homedir(), ".claude", "rules.d"),
    path.join(process.cwd(), ".claude", "rules.d"),
  ];
  for (const dir of dirs) {
    try {
      const a = JSON.parse(fs.readFileSync(path.join(dir, "model-aliases.json"), "utf-8"));
      if (a && typeof a === "object" && !Array.isArray(a)) {
        Object.assign(aliases, a); // user aliases override built-in
      }
    } catch { /* no file */ }
    try {
      const t = JSON.parse(fs.readFileSync(path.join(dir, "model-tiers.json"), "utf-8"));
      if (t && typeof t === "object" && !Array.isArray(t)) {
        for (const [tier, models] of Object.entries(t)) {
          if (Array.isArray(models) && tiers[tier]) {
            tiers[tier] = models; // user tiers replace built-in tier
          }
        }
      }
    } catch { /* no file */ }
  }
  return { aliases, tiers };
}

const _modelConfig = loadModelConfig();
const MODEL_ALIASES = _modelConfig.aliases;

function resolveModel(name) {
  // Strip context window suffix like [1m], [200k] that some launchers append
  const clean = name.replace(/\[\d+[km]?\]$/i, "");
  return MODEL_ALIASES[clean] || clean;
}

// ── Model Capability Profiles (workload → optimal model) ─────

// Agnostic routing: "preferred" and "fallback" are capability tiers, not provider picks.
// resolveModelForWorkload() tries preferred first, then fallback, then inherits parent model.
// Users override via ~/.claude/model-profiles.json for their provider mix.
const MODEL_PROFILES = {
  exploration:    { preferred: "_tier:fast",    fallback: "_tier:fast",    traits: ["fast", "cheap", "tool-use"] },
  planning:       { preferred: "_tier:mid",     fallback: "_tier:mid",     traits: ["reasoning", "structured-output"] },
  implementation: { preferred: "_tier:mid",     fallback: "_tier:mid",     traits: ["tool-use", "code-gen", "multi-step"] },
  verification:   { preferred: "_tier:strong",  fallback: "_tier:mid",     traits: ["skeptical", "high-depth", "adversarial"] },
  documentation:  { preferred: "_tier:fast",    fallback: "_tier:fast",    traits: ["retrieval", "summarization"] },
  summarization:  { preferred: "_tier:fast",    fallback: "_tier:fast",    traits: ["cheap", "fast"] },
  "tool-heavy":   { preferred: "_tier:mid",     fallback: "_tier:mid",     traits: ["tool-use", "multi-step", "reliable"] },
  reasoning:      { preferred: "_tier:strong",  fallback: "_tier:mid",     traits: ["deep-reasoning", "complex-logic"] },
};

// Tier → concrete model resolution based on what's available
// Checks auth for each candidate, returns first available
// Loaded from rules.d/ files, falling back to built-in defaults
const MODEL_TIERS = _modelConfig.tiers;

function _hasProviderAuth(provider, cfg) {
  if (!provider.envKey) return true; // local providers (Ollama, LM Studio, etc.)
  if (provider.envKey === "ANTHROPIC_API_KEY") return !!(cfg.apiKey || cfg.authToken);
  if (provider.envKey === "OPENAI_API_KEY") return !!cfg.openaiApiKey;
  return !!process.env[provider.envKey];
}

function _resolveTier(tierSpec, cfg) {
  // If it's a concrete model (no _tier: prefix), try it directly
  if (!tierSpec.startsWith("_tier:")) {
    const provider = detectProvider(tierSpec);
    if (_hasProviderAuth(provider, cfg)) return tierSpec;
    return null;
  }
  // Resolve tier to first available model
  // Prefer models from the same provider as the current session (avoid cross-provider sub-agents)
  const tierName = tierSpec.slice(6); // strip "_tier:"
  const candidates = MODEL_TIERS[tierName] || MODEL_TIERS.mid;
  const currentProvider = cfg._provider;

  // Pass 1: same provider as session
  if (currentProvider) {
    for (const model of candidates) {
      const provider = detectProvider(model);
      if (provider.name === currentProvider.name && _hasProviderAuth(provider, cfg)) return model;
    }
  }
  // Pass 2: any provider with auth (fallback)
  for (const model of candidates) {
    const provider = detectProvider(model);
    if (_hasProviderAuth(provider, cfg)) return model;
  }
  return null;
}

function resolveModelForWorkload(workload, cfg) {
  // User overrides take priority (these are concrete models, not tiers)
  const userProfiles = cfg._modelProfiles || {};
  if (userProfiles[workload]) {
    const up = userProfiles[workload];
    const preferredProvider = detectProvider(up.preferred);
    if (_hasProviderAuth(preferredProvider, cfg)) {
      return { model: up.preferred, reason: `${workload} → user preferred` };
    }
    if (up.fallback) {
      const fallbackProvider = detectProvider(up.fallback);
      if (_hasProviderAuth(fallbackProvider, cfg)) {
        return { model: up.fallback, reason: `${workload} → user fallback` };
      }
    }
  }

  // Default profiles use tiers
  const profile = MODEL_PROFILES[workload] || MODEL_PROFILES.implementation;

  const preferred = _resolveTier(profile.preferred, cfg);
  if (preferred) return { model: preferred, reason: `${workload} → ${preferred}` };

  const fallback = _resolveTier(profile.fallback, cfg);
  if (fallback) return { model: fallback, reason: `${workload} → fallback ${fallback}` };

  // Inherit parent's model
  return { model: cfg.model, reason: `${workload} → inherit` };
}

export {
  parseArgs,
  MODEL_ALIASES,
  resolveModel,
  MODEL_PROFILES,
  MODEL_TIERS,
  _hasProviderAuth,
  _resolveTier,
  resolveModelForWorkload,
};
