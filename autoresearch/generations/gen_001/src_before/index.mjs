// src/index.mjs — Entry point that ties everything together

import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import _http from "node:http";
import _https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { log, sleep, memoize, EXIT, _VERSION, setVerbose, _verbose } from "./utils.mjs";
import { parseArgs, resolveModel, resolveModelForWorkload } from "./config.mjs";
import { detectProvider, PROVIDERS, AnthropicClient, OpenAIClient, OpenAIResponsesClient } from "./providers.mjs";
import { getOAuthAccessToken, getOpenAIAccessToken } from "./auth.mjs";
import { incrementDreamSessionCount } from "./memory-dream.mjs";
import {
  ToolRegistry, registerBuiltinTools, registerAskUserQuestion,
  registerMemoryTools,
  registerDeferredBuiltinTools, registerSpreadsheetTools,
  registerPdfTools, registerDocumentTools, registerPresentationTools,
  registerDesktopTools, scanCustomTools, registerBriefTools,
  registerToolSearch, registerMcpResourceTools, _OFFICIAL_CATALOG,
  _loadToolManifest, toolList, toolInfo, toolEnable, toolDisable,
  toolTest, toolInstall, toolUpdate, toolRemove, toolCatalog, toolPublish,
} from "./tools.mjs";
import { registerBrowserTools } from "./browser.mjs";
import { PermissionManager } from "./security.mjs";
import {
  AgentLoop, buildSystemPrompt, SkillLoader, AgentLoader, HookRunner,
  loadSettings, applySettings, loadRules, registerAgentTool,
  skillList, skillInfo, skillRemove, skillUpdate, skillExport,
  skillVerify, skillSearch, skillPublish, skillImport,
} from "./engine.mjs";
import { SessionManager, CheckpointStore, NdjsonBridge, InteractiveMode } from "./session.mjs";
import { LspManager, registerLspTools, createLspPostToolHook, formatDiagnostics } from "./lsp.mjs";
import { getAuditLogger } from "./audit.mjs";
import { registerTeamTools } from "./teams.mjs";
import { SandboxRunner, createSandboxedBashExecutor, resolveSandboxConfig } from "./sandbox.mjs";
import { handleCronCommand } from "./cron.mjs";

// ── McpManager ──────────────────────────────────────────────────

const flattenUserFacingOutputs = memoize(function flattenUserFacingOutputs(outputs, fallbackText = "") {
  if (!Array.isArray(outputs) || outputs.length === 0) return fallbackText || "";
  const parts = outputs.map((output) => {
    if (!output || typeof output !== "object") return "";
    if (output.kind === "task_output") return output.message || output.summary || "";
    return output.message || "";
  }).filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : (fallbackText || "");
}, {
  key: (outputs, fallbackText = "") => JSON.stringify([outputs, fallbackText]),
});

class McpManager {
  constructor() {
    this._servers = new Map(); // name → { proc, pending, msgId }
  }

  async loadConfig(configPath, registry) {
    let config;
    try {
      const raw = await fs.promises.readFile(configPath, "utf-8");
      config = JSON.parse(raw);
    } catch (e) {
      log(`MCP config error: ${e.message}`);
      return;
    }

    const servers = config.mcpServers || {};
    const startPromises = [];

    for (const [name, def] of Object.entries(servers)) {
      startPromises.push(this._startServer(name, def, registry));
    }

    await Promise.all(startPromises);
  }

  async _startServer(name, def, registry) {
    const env = { ...process.env, ...(def.env || {}) };
    const proc = spawn(def.command, def.args || [], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    const server = { proc, pending: new Map(), msgId: 0 };
    this._servers.set(name, server);

    let buffer = "";
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          const pending = server.pending.get(msg.id);
          if (pending) {
            server.pending.delete(msg.id);
            pending.resolve(msg.result);
          }
        } catch { /* skip */ }
      }
    });

    proc.stderr.on("data", (d) => log(`MCP[${name}] stderr: ${d.toString().trim()}`));
    proc.on("close", (code) => log(`MCP[${name}] exited (${code})`));

    // Initialize
    try {
      await this._rpc(server, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "claude-native", version: _VERSION },
      });

      // Send initialized notification (no id, no response expected)
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

      // List tools
      const result = await this._rpc(server, "tools/list", {});
      const tools = result?.tools || [];

      for (const tool of tools) {
        const toolName = `mcp__${name}__${tool.name}`;
        registry.register(toolName, {
          description: tool.description || `MCP tool ${tool.name} from ${name}`,
          input_schema: tool.inputSchema || { type: "object", properties: {} },
        }, async (input) => {
          const callResult = await this._rpc(server, "tools/call", {
            name: tool.name,
            arguments: input,
          });
          const content = callResult?.content;
          if (Array.isArray(content)) {
            return content.map((c) => c.text || JSON.stringify(c)).join("\n");
          }
          return typeof content === "string" ? content : JSON.stringify(content || callResult);
        }, { deferred: true }); // MCP tools are always deferred
        log(`Registered MCP tool: ${toolName} (deferred)`);
      }
    } catch (e) {
      log(`MCP[${name}] init failed: ${e.message}`);
    }
  }

  _rpc(server, method, params) {
    return new Promise((resolve, reject) => {
      const id = ++server.msgId;
      const timer = setTimeout(() => {
        server.pending.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 15000);

      server.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });

      server.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  shutdown() {
    for (const [name, server] of this._servers) {
      try { server.proc.kill("SIGTERM"); } catch { /* ignore: process may have already exited */ }
      log(`MCP[${name}] terminated`);
    }
    this._servers.clear();
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const cfg = await parseArgs();
  setVerbose(cfg.verbose);

  // Early dispatch: cron doesn't need auth/provider/tools
  if (cfg._subcommand === "cron") { handleCronCommand(cfg._cronArgs || []); return; }

  // Resolve auth: --oauth (keychain) > --auth-token > --api-key > ANTHROPIC_API_KEY
  if (cfg.useOAuth || (!cfg.apiKey && !cfg.authToken)) {
    // Try OAuth from keychain → Bearer token with oauth-2025-04-20 beta
    try {
      const { authToken, subscriptionType } = await getOAuthAccessToken(cfg.verbose);
      cfg.authToken = authToken;
      process.stderr.write(`\x1b[2mUsing ${subscriptionType} subscription (OAuth)\x1b[0m\n`);
    } catch (e) {
      if (cfg.useOAuth) {
        process.stderr.write(`Error: ${e.message}\n`);
        process.exit(EXIT.AUTH_FAILURE);
      }
      // Fall through to API key check
    }
  }

  // Resolve OpenAI auth (for OpenAI/Codex models)
  const earlyProvider = detectProvider(cfg.model, cfg.provider);
  if (cfg.useOpenAIOAuth || (earlyProvider.envKey === "OPENAI_API_KEY" && !cfg.openaiApiKey)) {
    try {
      const token = await getOpenAIAccessToken(cfg.verbose);
      cfg.openaiApiKey = token;
      process.stderr.write(`\x1b[2mUsing OpenAI subscription (OAuth)\x1b[0m\n`);
    } catch (e) {
      if (cfg.useOpenAIOAuth) {
        process.stderr.write(`Error: ${e.message}\n`);
        process.exit(EXIT.AUTH_FAILURE);
      }
    }
  }

  // Detect provider and create client
  const provider = detectProvider(cfg.model, cfg.provider);
  const effectiveModel = provider.transformModel ? provider.transformModel(cfg.model) : cfg.model;
  cfg.model = effectiveModel;

  // Resolve provider credentials
  const providerKey = provider.envKey === "ANTHROPIC_API_KEY" ? (cfg.apiKey || cfg.authToken)
    : provider.envKey === "OPENAI_API_KEY" ? cfg.openaiApiKey
    : provider.envKey ? (process.env[provider.envKey] || "")
    : "no-auth"; // e.g. Ollama

  const providerUrl = cfg.provider
    ? (cfg.openaiApiUrl !== "https://api.openai.com" ? cfg.openaiApiUrl : provider.defaultUrl)
    : provider.defaultUrl;

  if (!providerKey && provider.envKey) {
    const hint = provider.name === "Anthropic"
      ? "Run --login, use --api-key, or set ANTHROPIC_API_KEY"
      : `Set ${provider.envKey}`;
    process.stderr.write(`Error: No ${provider.name} auth. ${hint}\n`);
    process.exit(EXIT.AUTH_FAILURE);
  }

  if (provider.name !== "Anthropic") {
    process.stderr.write(`\x1b[2mUsing ${provider.name} backend (${cfg.model})\x1b[0m\n`);
  }

  // Store provider on cfg so AgentLoop can access it
  cfg._provider = provider;

  const client = provider.createClient({
    apiKey: cfg.apiKey, authToken: cfg.authToken,
    providerKey, providerUrl, model: cfg.model,
  });

  // Audit trail
  const audit = getAuditLogger();
  const projectSlug = (cfg.cwd || process.cwd()).replace(/[^a-zA-Z0-9]/g, "-").slice(0, 80);
  audit.init(cfg.sessionId || randomUUID(), projectSlug);
  cfg._audit = audit;

  const registry = new ToolRegistry();
  registry._client = client; // Used by WebFetch for AI summarization
  registry._currentModel = cfg.model; // Used by WebFetch to pick summary model
  registry._provider = provider; // Used by WebFetch for summary model selection
  registerBuiltinTools(registry);
  registerMemoryTools(registry);

  // Sandbox: replace Bash executor with sandboxed version
  cfg._sandboxSettings = { mode: cfg.sandboxMode || "auto" };
  const sandboxConfig = resolveSandboxConfig(cfg);
  const sandboxRunner = new SandboxRunner(sandboxConfig);
  cfg._sandbox = sandboxRunner;
  if (sandboxRunner.effectiveMode === "docker") {
    const sandboxedBash = createSandboxedBashExecutor(registry, sandboxRunner);
    // Re-register Bash tool with same definition but sandboxed executor
    const bashTool = registry._tools.get("Bash");
    if (bashTool) {
      registry.register("Bash", bashTool.definition, sandboxedBash);
      log(`[sandbox] Bash tool running in Docker (${sandboxConfig.image})`);
    }
    // Pre-pull image in background
    sandboxRunner.ensureImage().catch(() => { /* ignore: will pull on first use */ });
  } else if (sandboxConfig.mode === "docker") {
    process.stderr.write("\x1b[33m⚠ Docker not available — Bash running on host (no sandbox)\x1b[0m\n");
  }

  registerAskUserQuestion(registry);
  registerDeferredBuiltinTools(registry, cfg);
  registerBrowserTools(registry);
  registerSpreadsheetTools(registry);
  registerPdfTools(registry);
  registerDocumentTools(registry);
  registerPresentationTools(registry);
  registerDesktopTools(registry);
  scanCustomTools(registry, cfg);
  cfg._officialToolCatalog = _OFFICIAL_CATALOG; // expose for ink-ui
  registerBriefTools(registry, cfg);

  if (cfg.allowedTools || cfg.disallowedTools) {
    registry.setFilter(cfg.allowedTools, cfg.disallowedTools);
  }

  // Load settings from .claude/settings.json (user → project → local)
  const settings = loadSettings(cfg.cwd);
  applySettings(cfg, settings);

  // Load rules from .claude/rules/*.md
  cfg._rules = loadRules(cfg.cwd);

  // Load skills
  cfg._skillLoader = new SkillLoader().scan(cfg.cwd);

  // Load custom agents from disk
  cfg._agentLoader = new AgentLoader().scan(cfg.cwd);

  // Load model profiles (user overrides for orchestrator routing)
  const modelProfilesPath = path.join(os.homedir(), ".claude", "model-profiles.json");
  try {
    if (fs.existsSync(modelProfilesPath)) {
      cfg._modelProfiles = JSON.parse(fs.readFileSync(modelProfilesPath, "utf-8"));
      log(`Loaded model profiles from ${modelProfilesPath}`);
    }
  } catch (e) { log(`Failed to load model profiles: ${e.message}`); }

  // Initialize hook runner (wire client + cfg for LLM hooks after client is created)
  cfg._hookRunner = new HookRunner(cfg._hooksConfig || {});
  cfg._hookRunner._client = client;
  cfg._hookRunner._cfg = cfg;
  cfg._registry = registry; // Used by agent hooks for tool access

  // Permission manager (after settings applied so rules are merged)
  const permissions = new PermissionManager(cfg);

  // Apply settings permission rules
  for (const rule of cfg.permissionRules) {
    permissions.addRule(rule.tool, rule.pattern, rule.behavior);
  }

  // Register Agent tool (sub-agents)
  registerAgentTool(registry, client, permissions, cfg);

  // Register Skill tool — allows the model to invoke skills by name (CC baseline pattern)
  // The model matches user requests against skill descriptions and calls this tool automatically.
  if (cfg._skillLoader && cfg._skillLoader.list().length > 0) {
    registry.register("Skill", {
      description: `Execute a skill within the main conversation.

When users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.

When users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.

How to invoke:
- Use this tool with the skill name and optional arguments
- Examples:
  - skill: "pdf" — invoke the pdf skill
  - skill: "commit", args: "-m 'Fix bug'" — invoke with arguments
  - skill: "review-pr", args: "123" — invoke with arguments

Important:
- Available skills are listed in system-reminder messages in the conversation
- When a skill matches the user's request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task
- NEVER mention a skill without actually calling this tool
- Do not invoke a skill that is already running
- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)`,
      input_schema: {
        type: "object",
        properties: {
          skill: { type: "string", description: "The skill name. E.g., \"commit\", \"review-pr\", or \"pdf\"" },
          args: { type: "string", description: "Optional arguments for the skill" },
        },
        required: ["skill"],
      },
    }, async (input) => {
      const skillName = input.skill.replace(/^\//, ""); // strip leading / if present
      const invoked = cfg._skillLoader.invoke(skillName, input.args || "");
      if (!invoked) {
        const available = cfg._skillLoader.list().map(s => s.name).join(", ");
        return { content: `Skill "${skillName}" not found. Available: ${available}`, is_error: true };
      }
      // Return the skill body as content — the model will follow the instructions
      return {
        content: `<command-name>${skillName}</command-name>\n\n${invoked.body}`,
        is_error: false,
      };
    });
  }

  // Team coordination (multi-agent with shared task board)
  if (cfg._subAgentRunner) {
    registerTeamTools(registry, cfg._subAgentRunner, cfg);
  }

  // File checkpointing
  // CheckpointStore created per-mode (needs session ID first)

  // MCP servers
  const mcpManager = new McpManager();
  registry._mcpManager = mcpManager;
  registerMcpResourceTools(registry);
  if (cfg.mcpConfig) {
    if (!fs.existsSync(cfg.mcpConfig)) {
      process.stderr.write(`Error: MCP config file not found: ${cfg.mcpConfig}\n`);
      process.exit(EXIT.BAD_ARGS);
    }
    try {
      JSON.parse(fs.readFileSync(cfg.mcpConfig, "utf-8"));
    } catch (e) {
      process.stderr.write(`Error: Invalid JSON in MCP config: ${cfg.mcpConfig}\n  ${e.message}\n`);
      process.exit(EXIT.BAD_ARGS);
    }
    await mcpManager.loadConfig(cfg.mcpConfig, registry);
  }

  // MCP servers from settings
  if (cfg._settingsMcpServers) {
    const tmpConfigPath = path.join(os.tmpdir(), `.claude-native-mcp-${Date.now()}.json`);
    fs.writeFileSync(tmpConfigPath, JSON.stringify({ mcpServers: cfg._settingsMcpServers }));
    try {
      await mcpManager.loadConfig(tmpConfigPath, registry);
    } finally {
      try { fs.unlinkSync(tmpConfigPath); } catch { /* ignore: temp file may already be cleaned up */ }
    }
  }

  // Register ToolSearch if there are deferred tools (after all tools registered)
  registerToolSearch(registry);

  // ── LSP Integration ──────────────────────────────────────────
  const lspManager = new LspManager();
  registerLspTools(registry, lspManager);
  // Start LSP servers in background (non-blocking — uses project root)
  const projectRoot = cfg.cwd || process.cwd();
  lspManager.start(projectRoot).then(() => {
    if (lspManager.active) {
      log(`[lsp] Active servers: ${lspManager.languages.join(", ")}`);
    }
  }).catch(e => log(`[lsp] Start failed: ${e.message}`));
  // Wire LSP diagnostics into PostToolUse — auto-diagnose after Write/Edit
  const lspHook = createLspPostToolHook(lspManager);
  registry._lspPostToolHook = lspHook;
  cfg._lspManager = lspManager;

  // Apply persisted disabled tools from manifest
  const _tm = _loadToolManifest();
  for (const [name, entry] of Object.entries(_tm.tools)) {
    if (entry.disabled && registry.has(name)) { if (!registry._disallowed) registry._disallowed = []; if (!registry._disallowed.includes(name)) registry._disallowed.push(name); }
  }

  // Handle shutdown
  const cleanup = () => { sandboxRunner.shutdown(); audit.shutdown(); lspManager.shutdown(); mcpManager.shutdown(); process.exit(0); };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Global timeout
  let timeoutTimer = null;
  if (cfg.timeout > 0) {
    timeoutTimer = setTimeout(() => {
      process.stderr.write(`Error: Global timeout (${cfg.timeout}s) exceeded\n`);
      mcpManager.shutdown();
      process.exit(EXIT.TIMEOUT);
    }, cfg.timeout * 1000);
  }

  // Subcommand dispatch — cron
  if (cfg._subcommand === "cron") { handleCronCommand(cfg._cronArgs || []); return; }

  // Subcommand dispatch — skills
  if (cfg._subcommand === "skill-list") { skillList(cfg); process.exit(0); }
  if (cfg._subcommand === "skill-info") { skillInfo(cfg, cfg._skillInfoName); process.exit(0); }
  if (cfg._subcommand === "skill-remove") { await skillRemove(cfg, cfg._skillRemoveName); process.exit(0); }
  if (cfg._subcommand === "skill-update") { await skillUpdate(cfg, client, registry, permissions, cfg._skillUpdateName); mcpManager.shutdown(); process.exit(0); }
  if (cfg._subcommand === "skill-export") { skillExport(cfg, cfg._skillExportName); process.exit(0); }
  if (cfg._subcommand === "skill-verify") { skillVerify(cfg, cfg._skillVerifyName); process.exit(0); }
  if (cfg._subcommand === "skill-search") { await skillSearch(cfg, cfg._skillSearchQuery); process.exit(0); }
  if (cfg._subcommand === "skill-publish") { await skillPublish(cfg, cfg._skillPublishName); process.exit(0); }
  if (cfg._subcommand === "skill-import") {
    await skillImport(cfg, client, registry, permissions, cfg._skillImportSource);
    mcpManager.shutdown();
    process.exit(0);
  }
  // Subcommand dispatch — tools
  if (cfg._subcommand === "tool-list") { toolList(cfg, registry); mcpManager.shutdown(); process.exit(0); }
  if (cfg._subcommand === "tool-info") { toolInfo(cfg, registry, cfg._toolInfoName); mcpManager.shutdown(); process.exit(0); }
  if (cfg._subcommand === "tool-enable") { toolEnable(cfg, registry, cfg._toolEnableName); mcpManager.shutdown(); process.exit(0); }
  if (cfg._subcommand === "tool-disable") { toolDisable(cfg, registry, cfg._toolDisableName); mcpManager.shutdown(); process.exit(0); }
  if (cfg._subcommand === "tool-test") { await toolTest(cfg, registry, cfg._toolTestName); mcpManager.shutdown(); process.exit(0); }
  if (cfg._subcommand === "tool-install") { await toolInstall(cfg, cfg._toolInstallSource); process.exit(0); }
  if (cfg._subcommand === "tool-update") { await toolUpdate(cfg, cfg._toolUpdateName); process.exit(0); }
  if (cfg._subcommand === "tool-remove") { toolRemove(cfg, cfg._toolRemoveName); process.exit(0); }
  if (cfg._subcommand === "tool-catalog") { await toolCatalog(cfg._toolCatalogQuery); process.exit(0); }
  if (cfg._subcommand === "tool-publish") { await toolPublish(cfg, cfg._toolPublishName); process.exit(0); }

  // Audit: session start
  const mode = cfg.ndjson ? "ndjson" : cfg.prompt ? "one-shot" : "interactive";
  audit.sessionStart(mode, cfg.model, provider.name);

  // Mode dispatch
  if (cfg.ndjson) {
    const bridge = new NdjsonBridge(cfg, registry, client, mcpManager, permissions);
    // CheckpointStore created inside bridge.run() with its session ID
    await bridge.run();
  } else if (cfg.prompt) {
    // One-shot mode
    const messageId = randomUUID();
    const checkpoints = new CheckpointStore(cfg.sessionId || messageId);
    checkpoints.createSnapshot(messageId);
    registry._checkpoints = checkpoints;
    registry._messageId = messageId;

    const systemBlocks = buildSystemPrompt(cfg);

    // If --json-schema, inject constraint into the user prompt
    let userPrompt = cfg.prompt;
    if (cfg.jsonSchema) {
      userPrompt += `\n\nIMPORTANT: Your response MUST be valid JSON conforming to this schema:\n${JSON.stringify(cfg.jsonSchema, null, 2)}\n\nRespond with ONLY the JSON object, no markdown fences, no explanation.`;
    }

    const messages = [{ role: "user", content: userPrompt, messageId }];

    const isJsonOutput = cfg.outputFormat === "json";

    const loop = new AgentLoop(client, registry, cfg, {
      onText: () => {},
      onToolUse: (block) => {
        if (_verbose) process.stderr.write(`\x1b[2m[${block.name}]\x1b[0m\n`);
      },
    }, permissions);

    const result = await loop.run(messages, systemBlocks);
    const assistantVisibleText = flattenUserFacingOutputs(result.userFacingOutputs, result.text);

    // If --json-schema, validate output against schema
    let schemaResult = null;
    if (cfg.jsonSchema && assistantVisibleText) {
      try {
        // Extract JSON from response (strip markdown fences if model adds them)
        let raw = assistantVisibleText.trim();
        if (raw.startsWith("```")) raw = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
        schemaResult = JSON.parse(raw);

        // Validate required fields
        const schema = cfg.jsonSchema;
        const errors = [];
        if (schema.required) {
          for (const field of schema.required) {
            if (!(field in schemaResult)) errors.push(`missing required field: "${field}"`);
          }
        }
        if (schema.properties) {
          for (const [key, prop] of Object.entries(schema.properties)) {
            if (key in schemaResult && prop.type) {
              const val = schemaResult[key];
              const actual = Array.isArray(val) ? "array" : typeof val;
              if (prop.type !== actual && !(prop.type === "integer" && typeof val === "number" && Number.isInteger(val))) {
                errors.push(`"${key}" expected ${prop.type}, got ${actual}`);
              }
            }
          }
        }
        if (errors.length > 0) {
          process.stderr.write(`\x1b[33m⚠ Schema validation warnings: ${errors.join("; ")}\x1b[0m\n`);
        }
      } catch (e) {
        process.stderr.write(`\x1b[31m✗ Response is not valid JSON: ${e.message}\x1b[0m\n`);
        schemaResult = null;
      }
    }

    if (isJsonOutput) {
      const jsonOutput = {
        version: cfg.outputVersion || "1",
        message: result.text,
        user_facing_message: assistantVisibleText,
        user_facing_outputs: result.userFacingOutputs || [],
        result: schemaResult,  // parsed+validated object (null if no schema or parse failed)
        model: cfg.model,
        provider: provider.name,
        usage: {
          input_tokens: result.usage.input_tokens,
          output_tokens: result.usage.output_tokens,
          cache_creation_input_tokens: result.usage.cache_creation_input_tokens,
          cache_read_input_tokens: result.usage.cache_read_input_tokens,
        },
        stop_reason: result.stopReason,
        turns: result.turns,
        session_id: cfg.sessionId || messageId,
      };
      if (cfg.jsonSchema) jsonOutput.schema_valid = schemaResult !== null;
      process.stdout.write(JSON.stringify(jsonOutput) + "\n");
    } else {
      if (assistantVisibleText) process.stdout.write(assistantVisibleText);
      process.stdout.write("\n");
    }

    if (_verbose && !isJsonOutput) {
      process.stderr.write(`\x1b[2m(${result.usage.input_tokens} in / ${result.usage.output_tokens} out | ${result.turns} turns)\x1b[0m\n`);
    }

    // Increment dream session counter (one-shot counts as a session)
    try { incrementDreamSessionCount(); } catch { /* non-fatal */ }
  } else {
    // Interactive REPL
    const repl = new InteractiveMode(cfg, registry, client, mcpManager, permissions);
    // CheckpointStore created inside repl.run() with its session ID
    await repl.run();
  }

  if (timeoutTimer) clearTimeout(timeoutTimer);
  mcpManager.shutdown();
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n${err.stack}\n`);
  // Map known error types to structured exit codes
  const msg = err.message || "";
  if (msg.includes("No ") && (msg.includes("auth") || msg.includes("credentials") || msg.includes("API key"))) {
    process.exit(EXIT.AUTH_FAILURE);
  } else if (msg.includes("provider") || msg.includes("Unknown model") || msg.includes("ECONNREFUSED")) {
    process.exit(EXIT.PROVIDER_ERROR);
  }
  process.exit(EXIT.RUNTIME_ERROR);
});
