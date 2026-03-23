#!/usr/bin/env node
// claude-tool-loop v3 — Full-featured SDK bridge for Claude Code CLI
//
// Exposes ALL Claude Code capabilities via a simple NDJSON protocol:
// - Multi-turn tool calling (MCP native or prompt-engineered XML)
// - Sessions (create, resume, continue, fork)
// - Custom agents
// - Permission callbacks
// - Lifecycle hooks
// - Stream diagnostics (token-by-token, tool progress)
// - File checkpointing & rewind
// - Structured output (JSON schema)
// - Budget control
// - MCP server management
//
// Architecture:
//   Agent (Go/Python/JS) ←NDJSON→ claude-tool-loop.js ←stream-json→ Claude Code CLI
//                                        ↕ MCP stdio (for external tools)
//
// Usage:
//   node claude-tool-loop.js --mode mcp --model sonnet --verbose
//   node claude-tool-loop.js --mode stream --model opus --max-turns 20

"use strict";

const { spawn } = require("child_process");
const { createInterface } = require("readline");
const { randomUUID } = require("crypto");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ── Config ──────────────────────────────────────────────────────

const CLAUDE_BINARY = process.env.CLAUDE_BINARY || "claude";

function parseArgs() {
  const args = process.argv.slice(2);
  const cfg = {
    model: "sonnet",
    maxTurns: 15,
    permissionMode: "bypassPermissions",
    mode: "mcp",
    verbose: false,
    systemPrompt: "",
    appendSystemPrompt: "",
    sessionId: null,
    resume: false,
    continueSession: false,
    forkSession: false,
    noSessionPersistence: false,
    agents: null,
    jsonSchema: null,
    maxBudgetUsd: null,
    effort: null,
    allowedTools: [],
    disallowedTools: [],
    addDirs: [],
    brief: false,
    fallbackModel: null,
    permissionCallbacks: false, // if true, forward can_use_tool to agent
    streamDiagnostics: false,   // if true, forward stream_event/tool_progress
    fileCheckpointing: false,   // if true, enable file rewind
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--model": cfg.model = args[++i]; break;
      case "--max-turns": cfg.maxTurns = parseInt(args[++i], 10); break;
      case "--permission-mode": cfg.permissionMode = args[++i]; break;
      case "--mode": cfg.mode = args[++i]; break;
      case "--system-prompt": cfg.systemPrompt = args[++i]; break;
      case "--append-system-prompt": cfg.appendSystemPrompt = args[++i]; break;
      case "--session-id": cfg.sessionId = args[++i]; break;
      case "--resume": cfg.resume = args[++i] || true; break;
      case "--continue": cfg.continueSession = true; break;
      case "--fork-session": cfg.forkSession = true; break;
      case "--no-session-persistence": cfg.noSessionPersistence = true; break;
      case "--agents": cfg.agents = args[++i]; break;
      case "--json-schema": cfg.jsonSchema = args[++i]; break;
      case "--max-budget-usd": cfg.maxBudgetUsd = parseFloat(args[++i]); break;
      case "--effort": cfg.effort = args[++i]; break;
      case "--allowed-tools": cfg.allowedTools.push(args[++i]); break;
      case "--disallowed-tools": cfg.disallowedTools.push(args[++i]); break;
      case "--add-dir": cfg.addDirs.push(args[++i]); break;
      case "--brief": cfg.brief = true; break;
      case "--fallback-model": cfg.fallbackModel = args[++i]; break;
      case "--permission-callbacks": cfg.permissionCallbacks = true; break;
      case "--stream-diagnostics": cfg.streamDiagnostics = true; break;
      case "--file-checkpointing": cfg.fileCheckpointing = true; break;
      case "--verbose": cfg.verbose = true; break;
      case "--internal-mcp-server": runMcpServer(); return null;
      case "--help": printUsage(); process.exit(0);
    }
  }
  return cfg;
}

function printUsage() {
  process.stderr.write(`
claude-tool-loop v3 — Full SDK bridge for Claude Code CLI

MODES:
  mcp     Native MCP tool calling (recommended)
  stream  Prompt-engineered XML tool calls (no MCP dependency)

USAGE:
  node claude-tool-loop.js [OPTIONS]

CORE OPTIONS:
  --mode <mcp|stream>            Tool calling mode (default: mcp)
  --model <name>                 Model: sonnet, opus, haiku (default: sonnet)
  --max-turns <n>                Max agent turns per message (default: 15)
  --effort <low|medium|high|max> Effort level
  --verbose                      Debug logs to stderr

SESSION OPTIONS:
  --session-id <uuid>            Use specific session ID
  --resume [session-id]          Resume a previous session
  --continue                     Continue most recent session in cwd
  --fork-session                 Fork when resuming (new session ID)
  --no-session-persistence       Don't save session to disk

PROMPT OPTIONS:
  --system-prompt <text>         Override system prompt
  --append-system-prompt <text>  Append to system prompt
  --json-schema <schema>         JSON schema for structured output
  --brief                        Enable SendUserMessage for agent-to-user

SECURITY OPTIONS:
  --permission-mode <mode>       default|acceptEdits|bypassPermissions|plan|dontAsk
  --permission-callbacks         Forward permission requests to agent
  --allowed-tools <tools>        Whitelist tools (repeatable)
  --disallowed-tools <tools>     Blacklist tools (repeatable)
  --add-dir <dir>                Additional allowed directory (repeatable)

ADVANCED OPTIONS:
  --agents <json>                Custom agent definitions JSON
  --max-budget-usd <amount>      Spending limit
  --fallback-model <model>       Fallback when primary model is overloaded
  --stream-diagnostics           Forward streaming events to agent
  --file-checkpointing           Enable file rewind capabilities

PROTOCOL (stdin/stdout NDJSON):

  Agent → Bridge:
    {"type":"message","content":"...","tools":[...],"system":"...","context":"..."}
    {"type":"tool_result","id":"...","content":"...","is_error":false}
    {"type":"permission_response","request_id":"...","allow":true}
    {"type":"rewind","message_id":"...","dry_run":true}
    {"type":"set_model","model":"opus"}
    {"type":"set_permission_mode","mode":"default"}
    {"type":"interrupt"}
    {"type":"end_session"}
    {"type":"ping"}

  Bridge → Agent:
    {"type":"ready","version":"3.0.0","mode":"mcp","session_id":"..."}
    {"type":"tool_use","id":"...","name":"...","input":{...}}
    {"type":"response","content":"...","usage":{...},"iterations":N,"cost":N}
    {"type":"permission_request","request_id":"...","tool":"...","input":{...}}
    {"type":"stream","event_type":"...","data":{...}}
    {"type":"tool_progress","tool":"...","elapsed_seconds":N}
    {"type":"system","subtype":"...","data":{...}}
    {"type":"checkpoint","message_id":"...","files_changed":[...],"insertions":N,"deletions":N}
    {"type":"error","error":"..."}
    {"type":"pong"}

`);
}

// ── Logging & I/O ───────────────────────────────────────────────

let cfg;

function log(...args) {
  if (cfg?.verbose) process.stderr.write(`[bridge] ${args.join(" ")}\n`);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

// ── Claude Process Manager ──────────────────────────────────────
//
// Manages a single persistent Claude Code process via stream-json.
// Handles all message routing between the agent and Claude.

class ClaudeBridge {
  constructor(config) {
    this.config = config;
    this.claude = null;
    this.claudeRL = null;
    this.sessionId = null;
    this.assistantText = "";
    this.totalCost = 0;
    this.totalUsage = { input_tokens: 0, output_tokens: 0 };
    this.currentResolve = null;
    this.mcpConfigFile = null;
    this.tools = [];
    this.initData = null;
    this._pendingPermissions = new Map(); // request_id → {resolve}
  }

  // ── Spawn Claude process ──────────────────────────────────────

  async start(opts = {}) {
    const { tools, system, context } = opts;
    this.tools = tools || [];

    const args = [
      "--print",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--model", this.config.model,
      "--max-turns", String(this.config.maxTurns),
      "--replay-user-messages",
    ];

    // Permission mode
    if (this.config.permissionCallbacks) {
      args.push("--permission-mode", "default"); // will forward to agent
    } else {
      args.push("--permission-mode", this.config.permissionMode);
    }

    // Session management
    if (this.config.sessionId) {
      args.push("--session-id", this.config.sessionId);
    }
    if (this.config.resume) {
      args.push("--resume", typeof this.config.resume === "string" ? this.config.resume : "");
    }
    if (this.config.continueSession) {
      args.push("--continue");
    }
    if (this.config.forkSession) {
      args.push("--fork-session");
    }
    if (this.config.noSessionPersistence) {
      args.push("--no-session-persistence");
    }

    // System prompt
    if (this.config.systemPrompt) {
      args.push("--system-prompt", this.config.systemPrompt);
    }
    if (this.config.appendSystemPrompt) {
      args.push("--append-system-prompt", this.config.appendSystemPrompt);
    }
    // Per-message system/context via --append-system-prompt
    if (system || context) {
      const sections = [];
      if (system) sections.push(system);
      if (context) sections.push(context);
      args.push("--append-system-prompt", sections.join("\n\n"));
    }

    // Agents
    if (this.config.agents) {
      args.push("--agents", this.config.agents);
    }

    // Structured output
    if (this.config.jsonSchema) {
      args.push("--json-schema", this.config.jsonSchema);
    }

    // Budget
    if (this.config.maxBudgetUsd) {
      args.push("--max-budget-usd", String(this.config.maxBudgetUsd));
    }

    // Effort
    if (this.config.effort) {
      args.push("--effort", this.config.effort);
    }

    // Brief mode
    if (this.config.brief) {
      args.push("--brief");
    }

    // Fallback model
    if (this.config.fallbackModel) {
      args.push("--fallback-model", this.config.fallbackModel);
    }

    // Tool allowlists/denylists
    if (this.config.allowedTools.length > 0) {
      args.push("--allowedTools", ...this.config.allowedTools);
    }
    if (this.config.disallowedTools.length > 0) {
      args.push("--disallowedTools", ...this.config.disallowedTools);
    }

    // Additional directories
    for (const dir of this.config.addDirs) {
      args.push("--add-dir", dir);
    }

    // Partial messages for streaming
    if (this.config.streamDiagnostics) {
      args.push("--include-partial-messages");
    }

    // MCP: expose external tools as an MCP server
    if (this.config.mode === "mcp" && this.tools.length > 0) {
      this.mcpConfigFile = path.join(os.tmpdir(), `claude-mcp-${process.pid}.json`);
      const mcpConfig = {
        mcpServers: {
          agent: {
            command: process.execPath,
            args: [__filename, "--internal-mcp-server"],
            env: {
              CLAUDE_TOOL_LOOP_TOOLS: JSON.stringify(this.tools),
              CLAUDE_TOOL_LOOP_PARENT_PID: String(process.pid),
              CLAUDE_TOOL_LOOP_INSTRUCTIONS: context || "",
            },
          },
        },
      };
      fs.writeFileSync(this.mcpConfigFile, JSON.stringify(mcpConfig));
      args.push("--mcp-config", this.mcpConfigFile);
    }

    // Stream mode: inject tool instructions into system prompt
    if (this.config.mode === "stream" && this.tools.length > 0) {
      args.push("--append-system-prompt", buildToolInstructions(this.tools));
      // Disable built-in tools to avoid conflicts
      args.push("--disallowedTools",
        "Bash,Read,Write,Edit,Glob,Grep,Agent,NotebookEdit,WebFetch,WebSearch,TodoWrite,TaskCreate,TaskUpdate,TaskList,TaskGet,TaskStop,TaskOutput,Skill,ToolSearch,AskUserQuestion");
    }

    log("Spawning claude:", args.slice(0, 20).join(" "), "...");

    this.claude = spawn(CLAUDE_BINARY, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CLAUDECODE: "", CLAUDE_CODE_ENTRYPOINT: "tool-loop-v3" },
    });

    this.claudeRL = createInterface({ input: this.claude.stdout, crlfDelay: Infinity });
    this.claudeRL.on("line", (line) => this._onClaudeLine(line));

    this.claude.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) log("stderr:", text);
    });

    this.claude.on("close", (code) => {
      log(`Claude exited (code ${code})`);
      this._cleanup();
      if (this.currentResolve) {
        this.currentResolve();
        this.currentResolve = null;
      }
    });

    // Wait for MCP server connection if needed
    const waitMs = this.config.mode === "mcp" && this.tools.length > 0 ? 2500 : 500;
    await new Promise((r) => setTimeout(r, waitMs));
    log("Claude started");
  }

  // ── Send messages to Claude ───────────────────────────────────

  _send(obj) {
    if (!this.claude || this.claude.killed) throw new Error("Claude not running");
    this.claude.stdin.write(JSON.stringify(obj) + "\n");
  }

  sendUserMessage(content) {
    this.assistantText = "";
    this._send({
      type: "user",
      message: { role: "user", content },
    });
    return new Promise((resolve) => { this.currentResolve = resolve; });
  }

  sendControlRequest(subtype, data = {}) {
    const requestId = randomUUID();
    this._send({
      type: "control_request",
      request_id: requestId,
      request: { subtype, ...data },
    });
    return requestId;
  }

  sendControlResponse(requestId, response) {
    this._send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response,
      },
    });
  }

  interrupt() {
    this.sendControlRequest("interrupt");
  }

  setModel(model) {
    this.sendControlRequest("set_model", { model });
  }

  setPermissionMode(mode) {
    this.sendControlRequest("set_permission_mode", { mode });
  }

  rewindFiles(messageId, dryRun = false) {
    this.sendControlRequest("rewind_files", { user_message_id: messageId, dry_run: dryRun });
  }

  endSession(reason) {
    this.sendControlRequest("end_session", reason ? { reason } : {});
  }

  // ── Handle messages from Claude ───────────────────────────────

  _onClaudeLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }

    log("←", msg.type, msg.subtype || "");

    switch (msg.type) {
      case "system":
        this._onSystem(msg);
        break;

      case "assistant":
        this._onAssistant(msg);
        break;

      case "result":
        this._onResult(msg);
        break;

      case "control_request":
        this._onControlRequest(msg);
        break;

      case "control_response":
        this._onControlResponse(msg);
        break;

      case "stream_event":
        if (this.config.streamDiagnostics) {
          emit({ type: "stream", event_type: msg.event?.type, data: msg.event, ttft_ms: msg.ttftMs });
        }
        break;

      case "tool_progress":
        if (this.config.streamDiagnostics) {
          emit({ type: "tool_progress", tool: msg.tool_name, tool_use_id: msg.tool_use_id, elapsed_seconds: msg.elapsed_time_seconds });
        }
        break;

      case "tool_use_summary":
        emit({ type: "tool_summary", summary: msg.summary });
        break;

      case "rate_limit_event":
        emit({ type: "rate_limit", data: msg });
        break;

      case "user":
        // Echoed user message or tool result — pass through
        break;

      case "keep_alive":
        break;
    }
  }

  _onSystem(msg) {
    switch (msg.subtype) {
      case "init":
        this.sessionId = msg.session_id;
        this.initData = {
          tools: msg.tools,
          model: msg.model,
          mcp_servers: msg.mcp_servers,
          agents: msg.agents,
          permission_mode: msg.permissionMode,
          skills: msg.skills,
        };
        emit({
          type: "session_init",
          session_id: this.sessionId,
          model: msg.model,
          tools: msg.tools,
          mcp_servers: msg.mcp_servers,
          agents: msg.agents,
          permission_mode: msg.permissionMode,
        });
        break;

      case "compact_boundary":
        emit({ type: "system", subtype: "compact", trigger: msg.trigger });
        break;

      case "api_retry":
        emit({ type: "system", subtype: "api_retry", attempt: msg.attempt, delay_ms: msg.retry_delay_ms, error: msg.error });
        break;

      case "hook_started":
      case "hook_progress":
      case "hook_response":
        emit({ type: "hook", subtype: msg.subtype, data: msg });
        break;

      case "task_notification":
      case "task_started":
      case "task_progress":
        emit({ type: "task", subtype: msg.subtype, data: msg });
        break;

      case "status":
        if (msg.status) emit({ type: "system", subtype: "status", status: msg.status });
        break;
    }
  }

  _onAssistant(msg) {
    if (!msg.message?.content) return;

    let text = "";
    const toolUses = [];

    for (const block of msg.message.content) {
      if (block.type === "text") text += block.text;
      if (block.type === "tool_use") {
        toolUses.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    if (text) this.assistantText = text;

    // In stream mode, check for XML tool calls in text
    if (this.config.mode === "stream" && text) {
      const xmlCalls = parseToolCalls(text);
      if (xmlCalls.length > 0) {
        for (const tc of xmlCalls) {
          emit({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        }
      }
    }

    // Native tool_use blocks (from built-in or MCP tools)
    for (const tu of toolUses) {
      log(`Tool use: ${tu.name}(${JSON.stringify(tu.input).substring(0, 80)})`);
    }
  }

  _onResult(msg) {
    if (msg.usage) {
      this.totalUsage.input_tokens += msg.usage.input_tokens || 0;
      this.totalUsage.output_tokens += msg.usage.output_tokens || 0;
    }
    if (msg.total_cost_usd) this.totalCost = msg.total_cost_usd;

    const response = {
      type: "response",
      content: msg.result || this.assistantText,
      session_id: msg.session_id,
      iterations: msg.num_turns || 1,
      usage: msg.usage || this.totalUsage,
      cost: msg.total_cost_usd || this.totalCost,
      stop_reason: msg.stop_reason,
      model: msg.model,
    };

    // Structured output
    if (msg.structured_output !== undefined) {
      response.structured_output = msg.structured_output;
    }

    // Error results
    if (msg.subtype && msg.subtype !== "success") {
      response.error = msg.subtype;
      response.errors = msg.errors;
    }

    // Permission denials
    if (msg.permission_denials?.length > 0) {
      response.permission_denials = msg.permission_denials;
    }

    emit(response);

    if (this.currentResolve) {
      this.currentResolve();
      this.currentResolve = null;
    }
  }

  _onControlRequest(msg) {
    const req = msg.request;

    switch (req?.subtype) {
      case "can_use_tool":
        if (this.config.permissionCallbacks) {
          // Forward to agent for decision
          emit({
            type: "permission_request",
            request_id: msg.request_id,
            tool: req.tool_name,
            input: req.input,
            tool_use_id: req.tool_use_id,
            description: req.description,
            agent_id: req.agent_id,
            suggestions: req.permission_suggestions,
          });
          // Agent will respond with permission_response
        } else {
          // Auto-approve
          this.sendControlResponse(msg.request_id, { behavior: "allow" });
        }
        break;

      case "hook_callback":
        emit({ type: "hook_callback", request_id: msg.request_id, data: req });
        break;

      case "elicitation":
        emit({ type: "elicitation", request_id: msg.request_id, data: req });
        break;

      default:
        log("Unhandled control_request:", req?.subtype);
    }
  }

  _onControlResponse(msg) {
    // Response to our own control_request — log and pass through
    log("Control response:", msg.response?.subtype, msg.response?.request_id);

    // Forward rewind results to agent
    if (msg.response?.response?.canRewind !== undefined) {
      emit({
        type: "checkpoint",
        can_rewind: msg.response.response.canRewind,
        message_id: msg.response.response.user_message_id,
        files_changed: msg.response.response.filesChanged,
        insertions: msg.response.response.insertions,
        deletions: msg.response.response.deletions,
        error: msg.response.response.error,
      });
    }

    // Forward settings response
    if (msg.response?.response?.settings !== undefined) {
      emit({ type: "settings", data: msg.response.response });
    }
  }

  // ── Cleanup ───────────────────────────────────────────────────

  _cleanup() {
    if (this.mcpConfigFile) {
      try { fs.unlinkSync(this.mcpConfigFile); } catch {}
      this.mcpConfigFile = null;
    }
  }

  async stop() {
    if (this.claude && !this.claude.killed) {
      this.endSession();
      await new Promise((r) => setTimeout(r, 1000));
      if (!this.claude.killed) this.claude.kill("SIGTERM");
    }
    this._cleanup();
  }
}

// ── MCP Server (child process) ──────────────────────────────────
//
// Exposes the agent's tools to Claude Code via MCP stdio protocol.
// Tool calls are proxied to the parent bridge via file IPC + SIGUSR1.

function runMcpServer() {
  const tools = JSON.parse(process.env.CLAUDE_TOOL_LOOP_TOOLS || "[]");
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  function send(msg) {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let msg;
    try { msg = JSON.parse(trimmed); } catch { return; }

    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0", id: msg.id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "agent-tools", version: "3.0.0" },
          capabilities: { tools: { listChanged: false } },
          instructions: process.env.CLAUDE_TOOL_LOOP_INSTRUCTIONS || "",
        },
      });
    } else if (msg.method === "notifications/initialized") {
      // ack
    } else if (msg.method === "tools/list") {
      send({
        jsonrpc: "2.0", id: msg.id,
        result: {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description || "",
            inputSchema: t.input_schema || t.parameters || { type: "object", properties: {} },
          })),
        },
      });
    } else if (msg.method === "tools/call") {
      const toolName = msg.params?.name;
      const toolArgs = msg.params?.arguments || {};
      const requestId = msg.id;
      const reqFile = path.join(os.tmpdir(), `mcp-req-${process.pid}-${requestId}.json`);
      const resFile = path.join(os.tmpdir(), `mcp-res-${process.pid}-${requestId}.json`);

      fs.writeFileSync(reqFile, JSON.stringify({ name: toolName, arguments: toolArgs, id: requestId }));
      try { process.kill(parseInt(process.env.CLAUDE_TOOL_LOOP_PARENT_PID), "SIGUSR1"); } catch {}

      const startTime = Date.now();
      const poll = setInterval(() => {
        if (Date.now() - startTime > 120_000) {
          clearInterval(poll);
          send({ jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text", text: "Error: timeout" }], isError: true } });
          try { fs.unlinkSync(reqFile); } catch {}
          return;
        }
        try {
          const result = JSON.parse(fs.readFileSync(resFile, "utf-8"));
          clearInterval(poll);
          send({
            jsonrpc: "2.0", id: requestId,
            result: {
              content: [{ type: "text", text: typeof result.content === "string" ? result.content : JSON.stringify(result.content) }],
              isError: result.is_error || false,
            },
          });
          try { fs.unlinkSync(reqFile); } catch {}
          try { fs.unlinkSync(resFile); } catch {}
        } catch { /* not ready */ }
      }, 100);
    } else if (msg.method === "ping") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  });
}

// ── Tool Call Parser (stream mode) ──────────────────────────────

const TOOL_CALL_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;

function parseToolCalls(text) {
  const calls = [];
  TOOL_CALL_RE.lastIndex = 0;
  let match;
  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    try {
      const p = JSON.parse(match[1]);
      calls.push({ id: `tc_${Date.now()}_${calls.length}`, name: p.name, input: p.arguments || p.input || {} });
    } catch {}
  }
  return calls;
}

function buildToolInstructions(tools) {
  if (!tools?.length) return "";
  let t = "# Available Tools\n\nTo call a tool:\n<tool_call>\n{\"name\": \"tool_name\", \"arguments\": {\"param\": \"value\"}}\n</tool_call>\n\n";
  for (const tool of tools) {
    t += `## ${tool.name}\n${tool.description || ""}\n`;
    if (tool.input_schema || tool.parameters) t += `Schema: ${JSON.stringify(tool.input_schema || tool.parameters)}\n`;
    t += "\n";
  }
  return t;
}

// ── Stdin Reader ────────────────────────────────────────────────

let lineBuffer = [];
let lineResolve = null;

function setupStdinReader() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed);
      if (lineResolve) { const r = lineResolve; lineResolve = null; r(parsed); }
      else lineBuffer.push(parsed);
    } catch (e) { log("Bad JSON:", e.message); }
  });
  rl.on("close", () => {
    log("stdin closed");
    if (lineResolve) { lineResolve(null); lineResolve = null; }
  });
}

function readNextMessage() {
  if (lineBuffer.length > 0) return Promise.resolve(lineBuffer.shift());
  return new Promise((r) => { lineResolve = r; });
}

// ── MCP Tool Call Handler (file IPC) ────────────────────────────

function setupMcpHandler() {
  process.on("SIGUSR1", async () => {
    const tmpDir = os.tmpdir();
    const files = fs.readdirSync(tmpDir).filter((f) => f.startsWith("mcp-req-"));
    for (const file of files) {
      const reqPath = path.join(tmpDir, file);
      try {
        const req = JSON.parse(fs.readFileSync(reqPath, "utf-8"));
        log(`MCP call: ${req.name}`);
        emit({ type: "tool_use", id: req.id, name: req.name, input: req.arguments });

        const result = await readNextMessage();
        if (result?.type === "tool_result") {
          const resFile = reqPath.replace("mcp-req-", "mcp-res-");
          fs.writeFileSync(resFile, JSON.stringify({ content: result.content, is_error: result.is_error || false }));
        }
      } catch (e) { log("MCP handler error:", e.message); }
    }
  });
}

// ── Main Loop ───────────────────────────────────────────────────

async function main() {
  cfg = parseArgs();
  if (!cfg) return; // was --internal-mcp-server

  setupStdinReader();
  if (cfg.mode === "mcp") setupMcpHandler();

  log(`claude-tool-loop v3 (mode=${cfg.mode}, model=${cfg.model})`);
  emit({ type: "ready", version: "3.0.0", mode: cfg.mode });

  let bridge = null;

  while (true) {
    const msg = await readNextMessage();
    if (msg === null) break;

    switch (msg.type) {
      case "message": {
        // New message — restart Claude if tools/context changed, or reuse
        if (bridge) await bridge.stop();
        bridge = new ClaudeBridge(cfg);
        await bridge.start({
          tools: msg.tools,
          system: msg.system,
          context: msg.context,
        });
        await bridge.sendUserMessage(msg.content);
        break;
      }

      case "tool_result": {
        // In MCP mode, this is handled by SIGUSR1 handler
        // In stream mode, feed result back as user message
        if (bridge && cfg.mode === "stream") {
          bridge._send({
            type: "user",
            message: {
              role: "user",
              content: `<tool_result id="${msg.id}" status="${msg.is_error ? "error" : "success"}">\n${msg.content}\n</tool_result>\n\nReview the result and continue.`,
            },
          });
        }
        break;
      }

      case "permission_response": {
        if (bridge) {
          bridge.sendControlResponse(msg.request_id, {
            behavior: msg.allow ? "allow" : "deny",
            message: msg.message || undefined,
          });
        }
        break;
      }

      case "rewind": {
        if (bridge) bridge.rewindFiles(msg.message_id, msg.dry_run ?? true);
        break;
      }

      case "set_model": {
        if (bridge) bridge.setModel(msg.model);
        break;
      }

      case "set_permission_mode": {
        if (bridge) bridge.setPermissionMode(msg.mode);
        break;
      }

      case "interrupt": {
        if (bridge) bridge.interrupt();
        break;
      }

      case "end_session": {
        if (bridge) { await bridge.stop(); bridge = null; }
        break;
      }

      case "ping": {
        emit({ type: "pong" });
        break;
      }

      default:
        emit({ type: "error", error: `Unknown message type: ${msg.type}` });
    }
  }

  if (bridge) await bridge.stop();
  log("Shutdown complete");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
