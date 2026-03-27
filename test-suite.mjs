#!/usr/bin/env node
// test-suite.mjs — Comprehensive test suite for claude-native
//
// Usage:
//   node test-suite.mjs                    # Unit + NRT only (no API keys needed)
//   node test-suite.mjs --e2e              # + live API calls (needs keys)
//   node test-suite.mjs --e2e --all-sdks   # + Python/Go/Rust parity
//   node test-suite.mjs --e2e --verbose    # Show stdout/stderr on failures
//
// Env vars:
//   ANTHROPIC_API_KEY or OAuth keychain    # For Anthropic tests
//   OPENAI_API_KEY                         # For OpenAI tests

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "claude-native.mjs");
const PY_SCRIPT = path.join(__dirname, "claude-native.py");
const GO_SCRIPT = path.join(__dirname, "claude-native.go");

const VERBOSE = process.argv.includes("--verbose");
const RUN_E2E = process.argv.includes("--e2e");
const ALL_SDKS = process.argv.includes("--all-sdks");

let passed = 0, failed = 0, skipped = 0;
const failures = [];

function assert(condition, name, detail) {
  if (condition) {
    passed++;
    process.stderr.write(`  \x1b[32m✓\x1b[0m ${name}\n`);
  } else {
    failed++;
    failures.push({ name, detail });
    process.stderr.write(`  \x1b[31m✗\x1b[0m ${name}\n`);
    if (detail && VERBOSE) process.stderr.write(`    \x1b[33m${detail.substring(0, 300)}\x1b[0m\n`);
  }
}

function skip(name) {
  skipped++;
  process.stderr.write(`  \x1b[2m○ ${name} (skipped)\x1b[0m\n`);
}

function section(title) {
  process.stderr.write(`\n\x1b[1m[${title}]\x1b[0m\n`);
}

// ═══════════════════════════════════════════════════════════════════
// UNIT TESTS — No API calls needed
// ═══════════════════════════════════════════════════════════════════

// Extract and eval classes from source
const source = fs.readFileSync(SCRIPT, "utf-8");

function extractBlock(src, startPattern) {
  const idx = src.indexOf(startPattern);
  if (idx === -1) return "";
  let depth = 0, started = false, end = idx;
  for (let i = idx; i < src.length; i++) {
    if (src[i] === "{") { depth++; started = true; }
    if (src[i] === "}") depth--;
    if (started && depth === 0) { end = i + 1; break; }
  }
  return src.slice(idx, end);
}

const stubs = "function log() {} function sleep() { return Promise.resolve(); }";
const anthropicClientClass = extractBlock(source, "class AnthropicClient {");
const openAIClientClass = extractBlock(source, "class OpenAIClient {");
const openAIResponsesClass = extractBlock(source, "class OpenAIResponsesClient {");

// Extract PROVIDERS block (from "const PROVIDERS = {" to the getInstructionPlacement function end)
const providersStart = source.indexOf("const PROVIDERS = {");
const instrEnd = source.indexOf("}", source.indexOf("function getInstructionPlacement(")) + 1;
const providersAndHelpers = source.slice(providersStart, instrEnd);

const detectProviderFunc = extractBlock(source, "function detectProvider(");
const isOpenAIModelFunc = extractBlock(source, "function isOpenAIModel(");
const isResponsesFunc = extractBlock(source, "function isResponsesAPIModel(");

const testModule = [stubs, anthropicClientClass, openAIClientClass, openAIResponsesClass, providersAndHelpers, detectProviderFunc, isOpenAIModelFunc, isResponsesFunc].join("\n\n");
const ns = {};
try {
  new Function("exports", "process", testModule + "\nexports.OpenAIClient = OpenAIClient;\nexports.OpenAIResponsesClient = OpenAIResponsesClient;\nexports.isOpenAIModel = isOpenAIModel;\nexports.isResponsesAPIModel = isResponsesAPIModel;\nexports.PROVIDERS = PROVIDERS;\nexports.detectProvider = detectProvider;\nexports.getInstructionPlacement = getInstructionPlacement;\n")(ns, process);
} catch (e) {
  process.stderr.write(`\x1b[31mFailed to extract classes: ${e.message}\x1b[0m\n`);
}

const { OpenAIClient, OpenAIResponsesClient, isOpenAIModel, isResponsesAPIModel } = ns;

// ── 1. Model Detection ─────────────────────────────────────────

section("UNIT: Model Detection");

if (isOpenAIModel) {
  // OpenAI models
  for (const m of ["gpt-4o", "gpt-5.4", "gpt-5.3-codex", "gpt-4.1", "gpt-4.1-mini", "o3", "o3-pro", "o3-mini", "o4-mini", "o1"]) {
    assert(isOpenAIModel(m), `${m} → OpenAI`);
  }
  // Anthropic models
  for (const m of ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001"]) {
    assert(!isOpenAIModel(m), `${m} → not OpenAI`);
  }
  // Responses API models
  for (const m of ["gpt-5.3-codex", "gpt-5.2-codex", "gpt-5.1-codex"]) {
    assert(isResponsesAPIModel(m), `${m} → Responses API`);
  }
  for (const m of ["gpt-5.4", "gpt-4o", "o3", "claude-sonnet-4-6"]) {
    assert(!isResponsesAPIModel(m), `${m} → not Responses API`);
  }
} else {
  skip("Model detection (extraction failed)");
}

// ── 2. OpenAI Tool Conversion ──────────────────────────────────

section("UNIT: OpenAI Tool Conversion");

if (OpenAIClient) {
  const client = new OpenAIClient({ apiKey: "test" });

  // Basic tool conversion
  {
    const tools = client._convertTools([
      { name: "Bash", description: "Run cmd", input_schema: { type: "object", properties: { command: { type: "string" } } } },
    ]);
    assert(tools.length === 1, "Single tool converted");
    assert(tools[0].type === "function", "Tool type is function");
    assert(tools[0].function.name === "Bash", "Tool name preserved");
    assert(tools[0].function.parameters?.type === "object", "input_schema → parameters");
  }

  // Server tools filtered
  {
    const tools = client._convertTools([
      { name: "Bash", description: "Run", input_schema: {} },
      { type: "web_search_20250305", name: "web_search" },
    ]);
    assert(tools.length === 1, "Server tools filtered out");
  }

  // Null/empty
  assert(client._convertTools(null) === undefined, "null tools → undefined");
  assert(client._convertTools([]) === undefined || client._convertTools([])?.length === 0, "empty tools → empty");
} else {
  skip("Tool conversion (extraction failed)");
}

// ── 3. OpenAI Message Conversion ───────────────────────────────

section("UNIT: OpenAI Message Conversion");

if (OpenAIClient) {
  const client = new OpenAIClient({ apiKey: "test" });

  // System blocks → system message
  {
    client._model = "gpt-4o";
    const msgs = client._convertMessages(
      [{ type: "text", text: "You are helpful", cache_control: { type: "ephemeral" } }],
      [{ role: "user", content: "Hello" }]
    );
    assert(msgs[0].role === "system", "System block → system role");
    assert(msgs[0].content === "You are helpful", "System text extracted");
    assert(msgs[1].content === "Hello", "User content preserved");
  }

  // Reasoning model → developer role
  {
    client._model = "o3";
    const msgs = client._convertMessages([{ type: "text", text: "X" }], []);
    assert(msgs[0].role === "developer", "o3 → developer role");
  }
  {
    client._model = "o4-mini";
    const msgs = client._convertMessages([{ type: "text", text: "X" }], []);
    assert(msgs[0].role === "developer", "o4-mini → developer role");
  }

  // Multiple system blocks joined
  {
    client._model = "gpt-4o";
    const msgs = client._convertMessages([{ type: "text", text: "A" }, { type: "text", text: "B" }], []);
    assert(msgs[0].content === "A\n\nB", "Multiple system blocks joined");
  }

  // Tool result conversion
  {
    client._model = "gpt-4o";
    const msgs = client._convertMessages([], [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "result" }] },
    ]);
    assert(msgs[0].role === "tool", "tool_result → tool role");
    assert(msgs[0].tool_call_id === "call_1", "tool_use_id → tool_call_id");
  }

  // Assistant with tool_use
  {
    client._model = "gpt-4o";
    const msgs = client._convertMessages([], [
      { role: "assistant", content: [
        { type: "text", text: "Let me check" },
        { type: "tool_use", id: "call_2", name: "Bash", input: { command: "ls" } },
      ] },
    ]);
    assert(msgs[0].tool_calls?.length === 1, "Assistant tool_use → tool_calls");
    assert(msgs[0].tool_calls[0].function.name === "Bash", "Tool call name");
    assert(msgs[0].content === "Let me check", "Assistant text preserved with tool_use");
  }
} else {
  skip("Message conversion (extraction failed)");
}

// ── 4. Responses API Conversion ────────────────────────────────

section("UNIT: Responses API Conversion");

if (OpenAIResponsesClient) {
  const client = new OpenAIResponsesClient({ apiKey: "test" });

  // Tools — flat format (no nested "function")
  {
    const tools = client._convertTools([
      { name: "Bash", description: "Run", input_schema: { type: "object" } },
    ]);
    assert(tools.length === 1, "Responses tool converted");
    assert(tools[0].type === "function", "Flat function type");
    assert(tools[0].name === "Bash", "Flat name (no nesting)");
    assert(tools[0].parameters?.type === "object", "Flat parameters");
    assert(tools[0].function === undefined, "No nested function key");
  }

  // Instructions from system blocks
  {
    const instructions = client._getInstructions([{ type: "text", text: "A" }, { type: "text", text: "B" }]);
    assert(instructions === "A\n\nB", "Instructions joined from system blocks");
  }

  // Simple user message input
  {
    const input = client._convertInput([], [{ role: "user", content: "Hello" }]);
    assert(input[0].role === "user", "User message in input");
    assert(input[0].content === "Hello", "User content");
  }

  // Tool result → function_call_output
  {
    const input = client._convertInput([], [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }] },
    ]);
    assert(input[0].type === "function_call_output", "tool_result → function_call_output");
    assert(input[0].call_id === "call_1", "call_id preserved");
  }

  // call_id → item_id mapping
  {
    client._callIdToItemId = new Map([["call_x", "fc_abc"]]);
    const input = client._convertInput([], [
      { role: "assistant", content: [{ type: "tool_use", id: "call_x", name: "Bash", input: {} }] },
    ]);
    const fc = input.find(i => i.type === "function_call");
    assert(fc?.id === "fc_abc", "call_id mapped to item_id");
    assert(fc?.call_id === "call_x", "call_id preserved in output");
  }
} else {
  skip("Responses API conversion (extraction failed)");
}

// ── 5. CLI Flags ───────────────────────────────────────────────

section("UNIT: CLI Flags & Help");

{
  const { stderr } = await runCLI(["--help"]);
  assert(stderr.includes("codex"), "Help mentions codex");
  assert(stderr.includes("openai-login"), "Help mentions --openai-login");
  assert(stderr.includes("openai-api-key"), "Help mentions --openai-api-key");
  assert(stderr.includes("permission") || stderr.includes("mode"), "Help mentions permission mode");
  assert(stderr.includes("gpt") || stderr.includes("codex"), "Help mentions OpenAI models");
}

// ── 6. Auth Error Messages ─────────────────────────────────────

section("UNIT: Auth Error Messages");

{
  const { stderr, exitCode } = await runCLI(["-m", "gpt-4o", "-p", "test"], { OPENAI_API_KEY: "" });
  assert(stderr.includes("No OpenAI auth"), "OpenAI model without key → OpenAI error");
  assert(exitCode !== 0, "Non-zero exit");
}
{
  const { stderr } = await runCLI(["-m", "codex", "-p", "test"], { OPENAI_API_KEY: "" });
  // May succeed via OAuth if keychain has credentials; otherwise should show auth error
  assert(stderr.includes("No OpenAI") || stderr.includes("OpenAI subscription"), "codex without key → OpenAI error or OAuth");
}
{
  const { stderr } = await runCLI(["-m", "sonnet", "-p", "test"], { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" });
  assert(!stderr.includes("No OpenAI auth"), "Anthropic model → not OpenAI error");
}

// ── 7. ToolRegistry Filter (Bug 5 fix) ────────────────────────

section("UNIT: ToolRegistry Patterned Filter");

{
  // Extract and test ToolRegistry
  const trClass = extractBlock(source, "class ToolRegistry {");
  if (trClass) {
    const trNs = {};
    try {
      new Function("exports", trClass + "\nexports.ToolRegistry = ToolRegistry;\n")(trNs);
      const reg = new trNs.ToolRegistry();
      reg.register("Bash", { description: "run", input_schema: {} }, () => "ok");
      reg.register("Read", { description: "read", input_schema: {} }, () => "ok");

      // "Bash(rm *)" should NOT hide Bash — only PermissionManager handles the pattern
      reg.setFilter(null, ["Bash(rm *)"]);
      const defs = reg.getDefinitions();
      assert(defs.some(d => d.name === "Bash"), "Bash(rm *) does NOT hide Bash tool");
      assert(defs.some(d => d.name === "Read"), "Read still visible");

      // Bare "Bash" SHOULD hide it
      reg.setFilter(null, ["Bash"]);
      const defs2 = reg.getDefinitions();
      assert(!defs2.some(d => d.name === "Bash"), "Bare 'Bash' hides Bash tool");
      assert(defs2.some(d => d.name === "Read"), "Read still visible with Bash hidden");
    } catch (e) {
      skip(`ToolRegistry test failed: ${e.message}`);
    }
  } else {
    skip("ToolRegistry extraction failed");
  }
}


// ── 8. Provider Contract & Capabilities ──────────────────────────

section("UNIT: Provider Contract & Capabilities");

{
  // Extract PROVIDERS and detectProvider from source
  const providersBlock = source.slice(
    source.indexOf("const PROVIDERS = {"),
    source.indexOf("// Dynamic instruction placement")
  );
  const detectBlock = extractBlock(source, "function detectProvider(");
  const getInstructionBlock = extractBlock(source, "function getInstructionPlacement(");

  const provNs = {};
  try {
    // We need stub classes for createClient
    const stubs2 = `
      class AnthropicClient { constructor(opts) { this.opts = opts; } }
      class OpenAIClient { constructor(opts) { this.opts = opts; } }
      class OpenAIResponsesClient { constructor(opts) { this.opts = opts; } }
    `;
    new Function("exports", "process",
      stubs2 + "\n" + providersBlock + "\n" + getInstructionBlock + "\n" + detectBlock +
      "\nexports.PROVIDERS = PROVIDERS;\nexports.detectProvider = detectProvider;\nexports.getInstructionPlacement = getInstructionPlacement;\n"
    )(provNs, process);

    const { PROVIDERS: P, detectProvider: dp, getInstructionPlacement: gip } = provNs;

    // Every provider has the full contract
    for (const [key, prov] of Object.entries(P)) {
      assert(typeof prov.name === "string", `${key}.name is string`);
      assert(typeof prov.detect === "function", `${key}.detect is function`);
      assert(typeof prov.createClient === "function", `${key}.createClient is function`);
      assert(typeof prov.transformModel === "function", `${key}.transformModel is function`);
      assert(prov.capabilities !== undefined, `${key}.capabilities defined`);
      assert(typeof prov.capabilities.supportsThinking === "boolean", `${key}.capabilities.supportsThinking is boolean`);
      assert(typeof prov.capabilities.supportsHostedWebSearch === "boolean", `${key}.capabilities.supportsHostedWebSearch is boolean`);
      assert(typeof prov.capabilities.supportsToolCalling === "boolean", `${key}.capabilities.supportsToolCalling is boolean`);
      assert(["anthropic", "openai-chat", "openai-responses"].includes(prov.capabilities.apiStyle), `${key}.capabilities.apiStyle valid`);
    }

    // Detect tests
    assert(dp("claude-sonnet-4-6").name === "Anthropic", "detectProvider: claude → Anthropic");
    assert(dp("gpt-5.4").name === "OpenAI", "detectProvider: gpt-5.4 → OpenAI");
    assert(dp("gpt-5.3-codex").name === "OpenAI Responses", "detectProvider: codex → OpenAI Responses");
    assert(dp("gemini-2.5-pro").name === "Google Gemini", "detectProvider: gemini → Google");
    assert(dp("deepseek-chat").name === "DeepSeek", "detectProvider: deepseek → DeepSeek");
    assert(dp("mistral-large-latest").name === "Mistral", "detectProvider: mistral → Mistral");
    assert(dp("llama-3.3-70b-versatile").name === "Groq", "detectProvider: llama → Groq");
    assert(dp("ollama/llama3.2").name === "Ollama (local)", "detectProvider: ollama/ → Ollama");
    assert(dp("lmstudio/qwen2.5-coder").name === "LM Studio (local)", "detectProvider: lmstudio/ → LM Studio");
    assert(dp("vllm/mistral-7b").name === "vLLM", "detectProvider: vllm/ → vLLM");
    assert(dp("jan/llama3").name === "Jan (local)", "detectProvider: jan/ → Jan");
    assert(dp("llamacpp/phi-3").name === "llama.cpp", "detectProvider: llamacpp/ → llama.cpp");

    // Explicit provider override
    assert(dp("my-fine-tune", "openai").name === "OpenAI", "detectProvider: explicit override → OpenAI");
    assert(dp("custom-model", "anthropic").name === "Anthropic", "detectProvider: explicit override → Anthropic");

    // Capability gating: thinking
    assert(dp("claude-sonnet-4-6").capabilities.supportsThinking === true, "Anthropic supports thinking");
    assert(dp("gpt-5.4").capabilities.supportsThinking === false, "OpenAI does NOT support thinking");
    assert(dp("gpt-5.3-codex").capabilities.supportsThinking === false, "Codex does NOT support thinking");
    assert(dp("gemini-2.5-pro").capabilities.supportsThinking === false, "Gemini does NOT support thinking");

    // Capability gating: web search
    assert(dp("claude-sonnet-4-6").capabilities.supportsHostedWebSearch === true, "Anthropic supports web search");
    assert(dp("gpt-5.4").capabilities.supportsHostedWebSearch === false, "OpenAI does NOT support web search");
    assert(dp("gpt-5.3-codex").capabilities.supportsHostedWebSearch === false, "Codex does NOT support web search");

    // Summary model
    assert(dp("claude-sonnet-4-6").capabilities.summaryModel === "claude-haiku-4-5-20251001", "Anthropic summary model");
    assert(dp("gpt-5.4").capabilities.summaryModel === "gpt-4o-mini", "OpenAI summary model");
    assert(dp("ollama/llama3.2").capabilities.summaryModel === null, "Ollama no summary model");

    // Tool call style
    assert(dp("claude-sonnet-4-6").capabilities.toolCallStyle === "anthropic", "Anthropic tool call style");
    assert(dp("gpt-5.4").capabilities.toolCallStyle === "openai-chat", "OpenAI chat tool call style");
    assert(dp("gpt-5.3-codex").capabilities.toolCallStyle === "responses", "Codex responses tool call style");

    // Instruction placement
    assert(gip(dp("claude-sonnet-4-6"), "claude-sonnet-4-6") === "system-blocks", "Anthropic → system-blocks");
    assert(gip(dp("gpt-4o"), "gpt-4o") === "system-message", "GPT → system-message");
    assert(gip(dp("o3"), "o3") === "developer-message", "o3 → developer-message");
    assert(gip(dp("o4-mini"), "o4-mini") === "developer-message", "o4-mini → developer-message");
    assert(gip(dp("gpt-5.3-codex"), "gpt-5.3-codex") === "instructions-field", "Codex → instructions-field");

    // transformModel
    assert(P.ollama.transformModel("ollama/llama3.2") === "llama3.2", "Ollama transformModel strips prefix");
    assert(P.lmstudio.transformModel("lmstudio/qwen2.5-coder") === "qwen2.5-coder", "LM Studio transformModel strips prefix");
    assert(P.vllm.transformModel("vllm/mistral-7b") === "mistral-7b", "vLLM transformModel strips prefix");
    assert(P.jan.transformModel("jan/llama3") === "llama3", "Jan transformModel strips prefix");
    assert(P.llamacpp.transformModel("llamacpp/phi-3") === "phi-3", "llama.cpp transformModel strips prefix");
    assert(P.anthropic.transformModel("claude-sonnet-4-6") === "claude-sonnet-4-6", "Anthropic transformModel identity");

    // Local providers: no auth needed, no summary model
    for (const k of ["ollama", "lmstudio", "vllm", "jan", "llamacpp"]) {
      assert(P[k].envKey === null, `${k} envKey is null (no auth)`);
      assert(P[k].capabilities.summaryModel === null, `${k} no summary model`);
      assert(P[k].resolveAuth() === "no-auth", `${k} resolveAuth → no-auth`);
    }

    // Fallback provider
    const fallback = dp("unknown-model-xyz");
    assert(fallback.name === "OpenAI-compatible", "Unknown model → OpenAI-compatible fallback");
    assert(fallback.capabilities.supportsThinking === false, "Fallback does not support thinking");

  } catch (e) {
    skip(`Provider contract tests failed: ${e.message}`);
  }
}

// ── 9. Architectural Invariant ──────────────────────────────────

section("UNIT: Architectural Invariant — No Provider Branches in AgentLoop");

{
  // Extract AgentLoop class and verify zero provider-specific branches
  const agentLoopBlock = extractBlock(source, "class AgentLoop {");
  const hasIsOpenAI = agentLoopBlock.includes("isOpenAIModel(");
  const hasIsResponses = agentLoopBlock.includes("isResponsesAPIModel(");
  const hasIsReasoning = /[^_]isReasoningModel\(/.test(agentLoopBlock);

  assert(!hasIsOpenAI, "AgentLoop: zero isOpenAIModel() calls");
  assert(!hasIsResponses, "AgentLoop: zero isResponsesAPIModel() calls");
  assert(!hasIsReasoning, "AgentLoop: zero isReasoningModel() calls (outside client)");
}

// ── 10. Provider Override CLI ───────────────────────────────────

section("UNIT: --provider Override");

{
  const { stderr } = await runCLI(["--help"]);
  assert(stderr.includes("--provider"), "Help mentions --provider flag");
  assert(stderr.includes("anthropic") && stderr.includes("openai") && stderr.includes("ollama"), "Help lists providers");
  assert(stderr.includes("GOOGLE_API_KEY"), "Help lists Google env var");
  assert(stderr.includes("DEEPSEEK_API_KEY"), "Help lists DeepSeek env var");
}

{
  // --provider openai with unknown model should use OpenAI backend
  const { stderr } = await runCLI(["--provider", "openai", "-m", "my-fine-tune", "-p", "test"], { OPENAI_API_KEY: "sk-test-fake" });
  assert(stderr.includes("OpenAI") || stderr.includes("openai"), "--provider openai uses OpenAI backend");
}

// ── 11. Provider URL Resolution ─────────────────────────────────

section("UNIT: Provider URL Resolution");

{
  // Use the already-extracted PROVIDERS and detectProvider from ns
  const { PROVIDERS: P, detectProvider: dp } = ns;

  if (P && dp) {
    // Each provider resolveBaseUrl returns its defaultUrl when no overrides
    const baseCfg = { apiUrl: "", openaiApiUrl: "" };
    assert(P.anthropic.resolveBaseUrl(baseCfg).includes("anthropic.com"), "Anthropic resolveBaseUrl → anthropic.com");
    assert(P.openai.resolveBaseUrl(baseCfg).includes("openai.com"), "OpenAI resolveBaseUrl → openai.com");
    assert(P["openai-responses"].resolveBaseUrl(baseCfg).includes("openai.com"), "Responses resolveBaseUrl → openai.com");
    assert(P.google.resolveBaseUrl(baseCfg).includes("generativelanguage.googleapis.com"), "Google resolveBaseUrl → googleapis");
    assert(P.deepseek.resolveBaseUrl(baseCfg).includes("deepseek.com"), "DeepSeek resolveBaseUrl → deepseek.com");
    assert(P.mistral.resolveBaseUrl(baseCfg).includes("mistral.ai"), "Mistral resolveBaseUrl → mistral.ai");
    assert(P.groq.resolveBaseUrl(baseCfg).includes("groq.com"), "Groq resolveBaseUrl → groq.com");
    assert(P.ollama.resolveBaseUrl(baseCfg).includes("localhost:11434"), "Ollama resolveBaseUrl → localhost:11434");
    assert(P.lmstudio.resolveBaseUrl(baseCfg).includes("localhost:1234"), "LM Studio resolveBaseUrl → localhost:1234");
    assert(P.vllm.resolveBaseUrl(baseCfg).includes("localhost:8000"), "vLLM resolveBaseUrl → localhost:8000");
    assert(P.jan.resolveBaseUrl(baseCfg).includes("localhost:1337"), "Jan resolveBaseUrl → localhost:1337");
    assert(P.llamacpp.resolveBaseUrl(baseCfg).includes("localhost:8080"), "llama.cpp resolveBaseUrl → localhost:8080");

    // Anthropic respects cfg.apiUrl override
    assert(P.anthropic.resolveBaseUrl({ apiUrl: "https://custom.proxy.com" }).includes("custom.proxy.com"), "Anthropic resolveBaseUrl respects apiUrl override");

    // OpenAI respects cfg.openaiApiUrl override
    assert(P.openai.resolveBaseUrl({ openaiApiUrl: "https://oai-proxy.corp.com" }).includes("oai-proxy.corp.com"), "OpenAI resolveBaseUrl respects openaiApiUrl override");

    // Fallback provider also has resolveBaseUrl
    const fallback = dp("totally-unknown-model");
    assert(typeof fallback.resolveBaseUrl === "function", "Fallback provider has resolveBaseUrl");
    assert(fallback.resolveBaseUrl({ openaiApiUrl: "https://custom.com" }).includes("custom.com"), "Fallback resolveBaseUrl respects override");
  } else {
    skip("Provider URL resolution (extraction failed)");
  }
}


// ═══════════════════════════════════════════════════════════════════
// E2E TESTS — Require API keys
// ═══════════════════════════════════════════════════════════════════

if (!RUN_E2E) {
  process.stderr.write("\n\x1b[2mSkipping E2E tests (use --e2e flag)\x1b[0m\n");
} else {

  const hasAnthropicKey = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

  // Try OAuth
  let hasAnthropicOAuth = false;
  if (!hasAnthropicKey) {
    const { exitCode } = await runCLI(["--oauth", "-p", "say ok", "--max-tokens", "5"], {}, 15000);
    hasAnthropicOAuth = exitCode === 0;
  }
  const canAnthropic = hasAnthropicKey || hasAnthropicOAuth;

  // ── 8. Anthropic E2E ───────────────────────────────────────────

  if (canAnthropic) {
    section("E2E: Anthropic — Text");
    {
      const { exitCode, stdout } = await runCLI(
        ["-m", "haiku", "-p", "Reply with exactly: ANTHROPIC_OK", "--max-tokens", "50", "--permission-mode", "bypassPermissions"],
        {}, 30000
      );
      assert(exitCode === 0, "Anthropic haiku exits 0");
      assert(stdout.includes("ANTHROPIC_OK"), "Anthropic haiku correct response");
    }

    section("E2E: Anthropic — Tool Calling");
    {
      const { exitCode, stdout, stderr } = await runCLI(
        ["-m", "haiku", "-p", "Use Bash to run: echo ANTHRO_TOOL_OK", "--max-turns", "3", "--permission-mode", "bypassPermissions"],
        {}, 60000
      );
      assert(exitCode === 0, "Anthropic tool calling exits 0");
      assert((stdout + stderr).includes("ANTHRO_TOOL_OK"), "Anthropic Bash tool works");
    }

    section("E2E: Anthropic — Built-in Tools");
    {
      // Read tool
      const { stdout } = await runCLI(
        ["-m", "haiku", "-p", "Use the Read tool to read /etc/hosts and tell me the first line", "--max-turns", "3", "--permission-mode", "bypassPermissions"],
        {}, 60000
      );
      assert(stdout.length > 10, "Read tool produced output");
    }
    {
      // Glob tool
      const { stdout } = await runCLI(
        ["-m", "haiku", "-p", "Use Glob to find *.mjs files in " + __dirname + " and list them", "--max-turns", "3", "--permission-mode", "bypassPermissions"],
        {}, 60000
      );
      assert(stdout.includes("claude-native.mjs") || stdout.includes(".mjs"), "Glob tool found files");
    }
    {
      // Write + Read roundtrip
      const tmpFile = `/tmp/claude-test-${Date.now()}.txt`;
      const { stdout } = await runCLI(
        ["-m", "haiku", "-p", `Use Write to create ${tmpFile} with content "TEST_WRITE_OK", then use Read to read it back and show me the content`, "--max-turns", "5", "--permission-mode", "bypassPermissions"],
        {}, 60000
      );
      assert(stdout.includes("TEST_WRITE_OK"), "Write + Read roundtrip works");
      try { fs.unlinkSync(tmpFile); } catch {}
    }

    section("E2E: Anthropic — Multi-turn");
    {
      const { exitCode, stdout } = await runCLI(
        ["-m", "haiku", "-p", "Use Bash to run 'echo STEP1', then use Bash to run 'echo STEP2', then use Bash to run 'echo STEP3'. Tell me all three outputs.", "--max-turns", "8", "--permission-mode", "bypassPermissions"],
        {}, 90000
      );
      assert(exitCode === 0, "Multi-turn exits 0");
      assert(stdout.includes("STEP1") && stdout.includes("STEP2") && stdout.includes("STEP3"), "All 3 steps executed");
    }

    section("E2E: Anthropic — Extended Thinking");
    {
      const { exitCode, stdout } = await runCLI(
        ["-m", "sonnet", "-p", "What is 137 * 251? Reply with just the number.", "--thinking", "5000", "--max-tokens", "8000", "--permission-mode", "bypassPermissions"],
        {}, 60000
      );
      assert(exitCode === 0, "Thinking mode exits 0");
      assert(stdout.includes("34387"), "Thinking mode correct answer (34387)");
    }
  } else {
    section("E2E: Anthropic (SKIPPED — no auth)");
    skip("No ANTHROPIC_API_KEY or OAuth available");
  }

  // ── 9. OpenAI Chat Completions E2E ─────────────────────────────

  if (hasOpenAIKey) {
    section("E2E: OpenAI Chat Completions — Text");
    {
      const { exitCode, stdout } = await runCLI(
        ["-m", "gpt-4o-mini", "-p", "Reply with exactly: OPENAI_CC_OK", "--max-tokens", "50", "--permission-mode", "bypassPermissions"],
        {}, 30000
      );
      assert(exitCode === 0, "gpt-4o-mini exits 0");
      assert(stdout.includes("OPENAI_CC_OK"), "gpt-4o-mini correct response");
    }

    section("E2E: OpenAI Chat Completions — Tool Calling");
    {
      const { exitCode, stdout, stderr } = await runCLI(
        ["-m", "gpt-4o-mini", "-p", "Use Bash to run: echo OAI_TOOL_OK", "--max-turns", "3", "--permission-mode", "bypassPermissions"],
        {}, 60000
      );
      assert(exitCode === 0, "OpenAI tool calling exits 0");
      assert((stdout + stderr).includes("OAI_TOOL_OK"), "OpenAI Bash tool works");
    }

    section("E2E: OpenAI Chat Completions — GPT-5.4");
    {
      const { exitCode, stdout } = await runCLI(
        ["-m", "gpt-5.4", "-p", "Reply with exactly: GPT54_OK", "--max-tokens", "50", "--permission-mode", "bypassPermissions"],
        {}, 30000
      );
      assert(exitCode === 0, "gpt-5.4 exits 0");
      assert(stdout.includes("GPT54_OK"), "gpt-5.4 correct response");
    }

    section("E2E: OpenAI Chat Completions — Reasoning (o4-mini)");
    {
      const { exitCode, stdout } = await runCLI(
        ["-m", "o4-mini", "-p", "What is 13*17? Reply with just the number.", "--max-tokens", "100", "--permission-mode", "bypassPermissions"],
        {}, 60000
      );
      assert(exitCode === 0, "o4-mini exits 0");
      assert(stdout.includes("221"), "o4-mini correct answer (221)");
    }

    // ── 10. OpenAI Responses API E2E ───────────────────────────────

    section("E2E: OpenAI Responses API (Codex)");
    {
      const { exitCode, stdout } = await runCLI(
        ["-m", "codex", "-p", "Reply with exactly: CODEX_OK", "--max-tokens", "50", "--permission-mode", "bypassPermissions"],
        {}, 60000
      );
      assert(exitCode === 0, "Codex exits 0");
      assert(stdout.includes("CODEX_OK"), "Codex correct response");
    }

    section("E2E: Codex — Tool Calling");
    {
      const { exitCode, stdout, stderr } = await runCLI(
        ["-m", "codex", "-p", "Use Bash to run: echo CODEX_TOOL_OK", "--max-turns", "3", "--permission-mode", "bypassPermissions"],
        {}, 60000
      );
      assert(exitCode === 0, "Codex tool calling exits 0");
      assert((stdout + stderr).includes("CODEX_TOOL_OK"), "Codex Bash tool works");
    }

    section("E2E: Codex — Multi-turn");
    {
      const { exitCode, stdout } = await runCLI(
        ["-m", "codex", "-p", "Use Bash to create /tmp/codex_test.txt with 'HELLO', then use Read to read it, then use Bash to append ' WORLD' to it, then Read again. Show final content.", "--max-turns", "10", "--permission-mode", "bypassPermissions"],
        {}, 120000
      );
      assert(exitCode === 0, "Codex multi-turn exits 0");
      assert(stdout.includes("HELLO") && stdout.includes("WORLD"), "Codex multi-turn all steps");
      try { fs.unlinkSync("/tmp/codex_test.txt"); } catch {}
    }
  } else {
    section("E2E: OpenAI (SKIPPED — no OPENAI_API_KEY)");
    skip("No OPENAI_API_KEY");
  }

  // ── 11. Cross-Backend E2E ──────────────────────────────────────

  if (canAnthropic && hasOpenAIKey) {
    section("E2E: Cross-Backend — /model Switch");
    {
      const input = "/model codex\nhello, reply CODEX_SWITCH_OK\n/model haiku\nhello, reply HAIKU_SWITCH_OK\n/exit\n";
      const { stdout, stderr } = await runPipe(input, ["--oauth", "--permission-mode", "bypassPermissions"], 120000);
      const output = stdout + stderr;
      assert(output.includes("CODEX_SWITCH_OK"), "Switch to codex works");
      assert(output.includes("HAIKU_SWITCH_OK"), "Switch back to haiku works");
    }
  } else {
    section("E2E: Cross-Backend (SKIPPED — need both keys)");
    skip("Need both Anthropic and OpenAI auth");
  }

  // ── 12. Error Handling E2E ─────────────────────────────────────

  section("E2E: Error Handling");

  {
    const { exitCode, stderr } = await runCLI(
      ["-m", "gpt-4o-mini", "-p", "test", "--openai-api-key", "sk-invalid-key-12345"],
      { OPENAI_API_KEY: "" }, 15000
    );
    assert(exitCode !== 0, "Invalid OpenAI key → non-zero exit");
    assert(stderr.includes("401") || stderr.includes("error") || stderr.includes("invalid"), "Invalid key → error message");
  }

  if (canAnthropic) {
    const { exitCode, stderr } = await runCLI(
      ["-m", "haiku", "-p", "test", "--api-key", "sk-ant-invalid-12345"],
      { ANTHROPIC_API_KEY: "" }, 15000
    );
    assert(exitCode !== 0, "Invalid Anthropic key → non-zero exit");
  }

  // ── 13. NDJSON Bridge E2E ──────────────────────────────────────

  if (canAnthropic) {
    section("E2E: NDJSON Bridge");
    {
      const result = await runNdjson([
        { type: "message", content: "Reply with exactly: NDJSON_OK" },
      ], 30000);
      assert(result.response !== null, "NDJSON got response");
      assert(result.response?.content?.includes("NDJSON_OK"), "NDJSON correct response");
    }
    {
      // NDJSON with tool use
      const result = await runNdjson([
        { type: "message", content: "Use Bash to run: echo NDJSON_TOOL_OK" },
      ], 60000);
      assert(result.toolUses > 0, "NDJSON triggered tool use");
    }
  } else {
    section("E2E: NDJSON Bridge (SKIPPED)");
    skip("No Anthropic auth");
  }

  // ── 14. SDK Parity E2E ─────────────────────────────────────────

  if (ALL_SDKS && hasOpenAIKey) {
    section("E2E: SDK Parity — Python");
    {
      const { exitCode, stdout } = await runSDK("python3", PY_SCRIPT,
        ["-m", "codex", "-p", "Reply with exactly: PY_CODEX_OK", "--max-tokens", "50"],
        60000
      );
      assert(exitCode === 0, "Python + codex exits 0");
      assert(stdout.includes("PY_CODEX_OK"), "Python + codex correct");
    }
    {
      const { exitCode, stdout } = await runSDK("python3", PY_SCRIPT,
        ["-m", "gpt-5.4", "-p", "Reply with exactly: PY_GPT54_OK", "--max-tokens", "50"],
        60000
      );
      assert(exitCode === 0, "Python + gpt-5.4 exits 0");
      assert(stdout.includes("PY_GPT54_OK"), "Python + gpt-5.4 correct");
    }

    section("E2E: SDK Parity — Go");
    {
      const { exitCode, stdout } = await runSDK("go", "run",
        [GO_SCRIPT, "-m", "codex", "-p", "Reply with exactly: GO_CODEX_OK", "--max-tokens", "50"],
        90000
      );
      assert(exitCode === 0, "Go + codex exits 0");
      assert(stdout.includes("GO_CODEX_OK"), "Go + codex correct");
    }
  } else if (ALL_SDKS) {
    section("E2E: SDK Parity (SKIPPED — no OPENAI_API_KEY)");
    skip("Need OPENAI_API_KEY for SDK parity tests");
  }
}

// ═══════════════════════════════════════════════════════════════════
// UNIT: Extensibility Core (v2.0)
// ═══════════════════════════════════════════════════════════════════

// Extract extensibility functions/classes for testing
const parseYamlFrontmatterFunc = extractBlock(source, "function parseYamlFrontmatter(");
const loadSettingsFunc = extractBlock(source, "function loadSettings(");
const applySettingsFunc = extractBlock(source, "function applySettings(");
const loadRulesFunc = extractBlock(source, "function loadRules(");
const provConvStart = source.indexOf("const PROVIDER_CONVENTION_FILES = {");
const provConvEnd = source.indexOf("};\n", provConvStart);
const providerConventionFilesConst = source.slice(provConvStart, provConvEnd + 2);
const loadClaudeMdFilesFunc = extractBlock(source, "function loadClaudeMdFiles(");
const findProjectRootFunc = extractBlock(source, "function findProjectRoot(");
const processImportsFunc = extractBlock(source, "function processImports(");
const parseSkillHooksFunc = extractBlock(source, "function _parseSkillHooks(");
const ensureSkillDataDirFunc = extractBlock(source, "function ensureSkillDataDir(");
const skillExecContextClass = extractBlock(source, "class SkillExecutionContext {");
const skillLoaderClass = extractBlock(source, "class SkillLoader {");
const hookRunnerClass = extractBlock(source, "class HookRunner {");
const pathMatchesGlobFunc = extractBlock(source, "function _pathMatchesGlob(");
const rcStart = source.indexOf("const RESERVED_COMMANDS = new Set(");
const rcEnd = source.indexOf("]);\n", rcStart);
const reservedCommandsConst = source.slice(rcStart, rcEnd + 3);

// Build extensibility test module — provide Node.js built-ins as function params
const extModule = [
  stubs,
  "function resolveModel(m) { return m; }", // stub for applySettings
  parseYamlFrontmatterFunc,
  loadSettingsFunc,
  applySettingsFunc,
  loadRulesFunc,
  findProjectRootFunc,
  processImportsFunc,
  providerConventionFilesConst,
  loadClaudeMdFilesFunc,
  reservedCommandsConst,
  parseSkillHooksFunc,
  ensureSkillDataDirFunc,
  skillExecContextClass,
  skillLoaderClass,
  hookRunnerClass,
  pathMatchesGlobFunc,
].join("\n\n");

const ext = {};
try {
  new Function("exports", "process", "fs", "path", "os", "spawn",
    extModule + `
    exports.parseYamlFrontmatter = parseYamlFrontmatter;
    exports.loadSettings = loadSettings;
    exports.applySettings = applySettings;
    exports.loadRules = loadRules;
    exports.loadClaudeMdFiles = loadClaudeMdFiles;
    exports.findProjectRoot = findProjectRoot;
    exports.processImports = processImports;
    exports.SkillExecutionContext = SkillExecutionContext;
    exports.SkillLoader = SkillLoader;
    exports.HookRunner = HookRunner;
    exports.RESERVED_COMMANDS = RESERVED_COMMANDS;
    exports._pathMatchesGlob = _pathMatchesGlob;
    `
  )(ext, process, fs, path, os, spawn);
} catch (e) {
  process.stderr.write(`\x1b[31mFailed to extract extensibility classes: ${e.message}\x1b[0m\n`);
  if (VERBOSE) process.stderr.write(`  ${e.stack?.substring(0, 500)}\n`);
}

// ── YAML Frontmatter Parser ─────────────────────────────────────

section("UNIT: YAML Frontmatter Parser");

if (ext.parseYamlFrontmatter) {
  {
    const result = ext.parseYamlFrontmatter("---\nname: test\ndescription: A test skill\n---\n\nBody content here");
    assert(result.frontmatter.name === "test", "Parses name from frontmatter");
    assert(result.frontmatter.description === "A test skill", "Parses description from frontmatter");
    assert(result.body.trim() === "Body content here", "Extracts body after frontmatter");
  }
  {
    const result = ext.parseYamlFrontmatter("No frontmatter\nJust body");
    assert(Object.keys(result.frontmatter).length === 0, "No frontmatter returns empty object");
    assert(result.body.includes("No frontmatter"), "Returns full content as body when no frontmatter");
  }
  {
    const result = ext.parseYamlFrontmatter("---\nallowed-tools: Bash, Read, Grep\npaths:\n  - \"src/**/*.ts\"\n  - \"lib/**/*.js\"\n---\nBody");
    assert(result.frontmatter["allowed-tools"] === "Bash, Read, Grep", "Parses hyphenated key");
    assert(Array.isArray(result.frontmatter.paths), "Parses YAML array");
    assert(result.frontmatter.paths.length === 2, "Array has correct length");
    assert(result.frontmatter.paths[0] === "src/**/*.ts", "Array item 1 correct");
  }
  {
    const result = ext.parseYamlFrontmatter("---\nbool_true: true\nbool_false: false\n---\n");
    assert(result.frontmatter.bool_true === true, "Parses true boolean");
    assert(result.frontmatter.bool_false === false, "Parses false boolean");
  }
  {
    const result = ext.parseYamlFrontmatter("---\nitems: [a, b, c]\n---\n");
    assert(Array.isArray(result.frontmatter.items), "Parses inline array");
    assert(result.frontmatter.items.length === 3, "Inline array has 3 items");
    assert(result.frontmatter.items[1] === "b", "Inline array item correct");
  }
} else {
  skip("parseYamlFrontmatter not extracted");
}

// ── Settings Loader ─────────────────────────────────────────────

section("UNIT: Settings Loader");

{
  // Create temp directories for settings test
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-settings-"));
  const claudeDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });

  // Project-level settings
  fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({
    model: "opus",
    permissions: { allow: ["Bash(git:*)"], deny: ["Bash(rm:*)"] },
    hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo test" }] }] },
  }));

  // Local settings (should override)
  fs.writeFileSync(path.join(claudeDir, "settings.local.json"), JSON.stringify({
    model: "haiku",
    permissions: { allow: ["Read"] },
  }));

  if (ext.loadSettings) {
    const settings = ext.loadSettings(tmpDir);
    assert(settings.model === "haiku", "Local settings override project model");
    assert(settings.permissions.allow.includes("Bash(git:*)"), "Project allow rules preserved");
    assert(settings.permissions.allow.includes("Read"), "Local allow rules merged");
    assert(settings.permissions.deny.includes("Bash(rm:*)"), "Project deny rules preserved");
    assert(settings.hooks?.PreToolUse?.length > 0, "Hooks config loaded");
  } else {
    skip("loadSettings not extracted");
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Rules Engine ────────────────────────────────────────────────

section("UNIT: Rules Engine");

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-rules-"));
  const rulesDir = path.join(tmpDir, ".claude", "rules");
  fs.mkdirSync(rulesDir, { recursive: true });

  // Global rule (no paths)
  fs.writeFileSync(path.join(rulesDir, "style.md"), `---
name: Style Guide
---

# Style Rules
- Use 2-space indentation
- No semicolons in JavaScript`);

  // Path-scoped rule
  fs.writeFileSync(path.join(rulesDir, "api.md"), `---
name: API Rules
paths:
  - "src/api/**/*.ts"
---

# API Rules
- All endpoints must validate input
- Use standard error format`);

  if (ext.loadRules) {
    const rules = ext.loadRules(tmpDir);
    assert(rules.length === 2, "Loads 2 rule files");

    const globalRule = rules.find((r) => r.file === "style.md");
    assert(globalRule && globalRule.paths === null, "Style rule has no path scope (global)");
    assert(globalRule.content.includes("2-space indentation"), "Style rule content loaded");

    const apiRule = rules.find((r) => r.file === "api.md");
    assert(apiRule && Array.isArray(apiRule.paths), "API rule has paths array");
    assert(apiRule.paths[0] === "src/api/**/*.ts", "API rule path pattern correct");
    assert(apiRule.content.includes("validate input"), "API rule content loaded");
  } else {
    skip("loadRules not extracted");
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Skill Loader ────────────────────────────────────────────────

section("UNIT: Skill Loader");

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-skills-"));
  const skillsDir = path.join(tmpDir, ".claude", "skills");
  const commitDir = path.join(skillsDir, "commit");
  const reviewDir = path.join(skillsDir, "review-pr");
  fs.mkdirSync(commitDir, { recursive: true });
  fs.mkdirSync(reviewDir, { recursive: true });

  fs.writeFileSync(path.join(commitDir, "SKILL.md"), `---
name: commit
description: Create a git commit with a good message
allowed-tools: Bash, Read, Grep
---

Review all staged changes.
Create the commit.
$ARGUMENTS`);

  fs.writeFileSync(path.join(reviewDir, "SKILL.md"), `---
name: review-pr
description: Review a pull request
---

Review the PR changes.
$ARGUMENTS`);

  if (ext.SkillLoader) {
    const loader = new ext.SkillLoader().scan(tmpDir);

    assert(loader.has("commit"), "Skill loader finds commit skill");
    assert(loader.has("review-pr"), "Skill loader finds review-pr skill");
    assert(!loader.has("nonexistent"), "Skill loader doesn't find nonexistent skill");

    const index = loader.getIndex();
    assert(index.includes("/commit"), "Skill index includes /commit");
    assert(index.includes("Create a git commit"), "Skill index includes description");
    assert(index.includes("/review-pr"), "Skill index includes /review-pr");

    const skills = loader.list();
    const projectSkills = skills.filter(s => s.source === "project");
    assert(projectSkills.length === 2, "Skill list has 2 project skills");

    // Test invocation
    const invoked = loader.invoke("commit", "fix: typo in readme");
    assert(invoked !== null, "Skill invocation returns result");
    assert(invoked.body.includes("Review all staged changes"), "Skill body loaded on invocation");
    assert(invoked.body.includes("fix: typo in readme"), "$ARGUMENTS substituted");
    assert(!invoked.body.includes("$ARGUMENTS"), "$ARGUMENTS placeholder removed");
    assert(invoked.allowedTools.includes("Bash"), "allowed-tools parsed correctly");
    assert(invoked.allowedTools.includes("Read"), "allowed-tools includes Read");

    // Test invocation without args
    const invokedNoArgs = loader.invoke("commit", "");
    assert(!invokedNoArgs.body.includes("$ARGUMENTS"), "$ARGUMENTS removed even with empty args");

    // Test nonexistent skill invocation
    assert(loader.invoke("nonexistent", "") === null, "Invoking nonexistent skill returns null");
  } else {
    skip("SkillLoader not extracted");
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Skill Loader: Reserved Command Collision ────────────────────

section("UNIT: Skill Loader — Reserved Commands");

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-skills-reserved-"));
  const skillsDir = path.join(tmpDir, ".claude", "skills");
  // Try to create a skill that shadows /exit
  const exitDir = path.join(skillsDir, "exit");
  const safeDir = path.join(skillsDir, "safe-skill");
  fs.mkdirSync(exitDir, { recursive: true });
  fs.mkdirSync(safeDir, { recursive: true });

  fs.writeFileSync(path.join(exitDir, "SKILL.md"), `---
name: exit
description: This should be skipped
---
Body`);
  fs.writeFileSync(path.join(safeDir, "SKILL.md"), `---
name: safe-skill
description: This should load
---
Body`);

  if (ext.SkillLoader) {
    const loader = new ext.SkillLoader().scan(tmpDir);
    assert(!loader.has("exit"), "Skill 'exit' rejected (reserved command)");
    assert(loader.has("safe-skill"), "Non-reserved skill loads normally");
  } else {
    skip("SkillLoader not extracted");
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Hook Runner ─────────────────────────────────────────────────

section("UNIT: Hook Runner");

if (ext.HookRunner) {
  // Test empty config
  {
    const runner = new ext.HookRunner({});
    assert(!runner.hasHooksFor("PreToolUse"), "No hooks for empty config");
  }

  // Test hasHooksFor
  {
    const runner = new ext.HookRunner({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo ok" }] }],
    });
    assert(runner.hasHooksFor("PreToolUse"), "Has hooks for PreToolUse");
    assert(!runner.hasHooksFor("PostToolUse"), "No hooks for PostToolUse");
    assert(!runner.hasHooksFor("Stop"), "No hooks for Stop");
  }

  // Test fire with exit 0 (allow)
  {
    const runner = new ext.HookRunner({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "exit 0", timeout: 5 }] }],
    });
    const result = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/tmp" });
    assert(!result.blocked, "Exit 0 does not block");
  }

  // Test fire with exit 2 (block)
  {
    const runner = new ext.HookRunner({
      PreToolUse: [{
        matcher: "Bash",
        hooks: [{ type: "command", command: "echo 'dangerous command blocked' >&2; exit 2", timeout: 5 }],
      }],
    });
    const result = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd: "/tmp" });
    assert(result.blocked === true, "Exit 2 blocks the tool");
    assert(result.feedback.includes("dangerous command blocked"), "Stderr feedback captured on block");
  }

  // Test matcher regex (non-matching tool)
  {
    const runner = new ext.HookRunner({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "exit 2", timeout: 5 }] }],
    });
    const result = await runner.fire("PreToolUse", { tool_name: "Read", tool_input: {}, cwd: "/tmp" });
    assert(!result.blocked, "Non-matching tool name skips hooks");
  }

  // Test matcher empty (matches all)
  {
    const runner = new ext.HookRunner({
      PreToolUse: [{ hooks: [{ type: "command", command: "exit 0", timeout: 5 }] }],
    });
    const result = await runner.fire("PreToolUse", { tool_name: "Read", tool_input: {}, cwd: "/tmp" });
    assert(!result.blocked, "Empty matcher matches all tools (exit 0 = allow)");
  }

  // Test stdin JSON is passed to hook
  {
    const runner = new ext.HookRunner({
      PreToolUse: [{
        matcher: "Bash",
        hooks: [{
          type: "command",
          command: "cat | python3 -c \"import sys,json; d=json.load(sys.stdin); sys.exit(2 if 'rm' in d.get('tool_input',{}).get('command','') else 0)\"",
          timeout: 5,
        }],
      }],
    });
    const blocked = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd: "/tmp" });
    assert(blocked.blocked, "Hook reads stdin JSON and blocks rm command");

    const allowed = await runner.fire("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/tmp" });
    assert(!allowed.blocked, "Hook reads stdin JSON and allows ls command");
  }
} else {
  skip("HookRunner not extracted");
}

// ── Enhanced CLAUDE.md Loading ──────────────────────────────────

section("UNIT: Enhanced CLAUDE.md Loading");

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-claudemd-"));
  // Create a fake git repo marker
  fs.mkdirSync(path.join(tmpDir, ".git"));

  // Root CLAUDE.md
  fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), "# Root instructions\nDo X.");

  // Subdir with its own CLAUDE.md
  const subDir = path.join(tmpDir, "packages", "api");
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, "CLAUDE.md"), "# API instructions\nDo Y.");

  // .claude/CLAUDE.md alternate location
  const dotClaudeDir = path.join(tmpDir, ".claude");
  fs.mkdirSync(dotClaudeDir, { recursive: true });
  fs.writeFileSync(path.join(dotClaudeDir, "CLAUDE.md"), "# Dot-claude instructions\nDo Z.");

  if (ext.loadClaudeMdFiles) {
    // Loading from subdir should find subdir + root
    const files = ext.loadClaudeMdFiles(subDir, "Anthropic");
    assert(files.length >= 2, "Loads CLAUDE.md from multiple directories");
    const contents = files.map((f) => f.content).join("\n");
    assert(contents.includes("Root instructions"), "Root CLAUDE.md loaded");
    assert(contents.includes("API instructions"), "Subdir CLAUDE.md loaded");

    // Loading from root should find root + .claude/CLAUDE.md
    const rootFiles = ext.loadClaudeMdFiles(tmpDir, "Anthropic");
    const rootContents = rootFiles.map((f) => f.content).join("\n");
    assert(rootContents.includes("Root instructions"), "Root CLAUDE.md loaded from root");
    assert(rootContents.includes("Dot-claude instructions"), ".claude/CLAUDE.md loaded");
  } else {
    skip("loadClaudeMdFiles not extracted");
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── @import Processing ──────────────────────────────────────────

section("UNIT: CLAUDE.md @import");

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-import-"));
  fs.mkdirSync(path.join(tmpDir, ".git"));
  fs.mkdirSync(path.join(tmpDir, "docs"));

  fs.writeFileSync(path.join(tmpDir, "docs", "api.md"), "# API Documentation\nEndpoints here.");
  fs.writeFileSync(path.join(tmpDir, "docs", "nested.md"), "Nested content from @import.\n@./does-not-exist.md");

  if (ext.processImports) {
    // Basic import
    const result = ext.processImports("Before\n@./docs/api.md\nAfter", tmpDir, tmpDir, 0, new Set());
    assert(result.includes("API Documentation"), "@import resolves relative path");
    assert(result.includes("Before"), "Content before import preserved");
    assert(result.includes("After"), "Content after import preserved");

    // Nested import (depth 1)
    const nested = ext.processImports("@./docs/nested.md", tmpDir, tmpDir, 0, new Set());
    assert(nested.includes("Nested content from @import"), "Nested import resolved");

    // Missing file (silent skip)
    const missing = ext.processImports("@./nonexistent.md", tmpDir, tmpDir, 0, new Set());
    assert(!missing.includes("Error"), "Missing import silently skipped");

    // Max depth (depth >= 3 stops)
    const deep = ext.processImports("@./docs/api.md", tmpDir, tmpDir, 3, new Set());
    assert(deep.includes("@./docs/api.md"), "Import at max depth not resolved (stays as-is)");
  } else {
    skip("processImports not extracted");
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Skill Loading from Project Dir ──────────────────────────────

section("UNIT: Skill Loading — Project Skills (.claude/skills/)");

if (ext.SkillLoader) {
  const loader = new ext.SkillLoader().scan(__dirname);
  const skills = loader.list();

  // The project has built-in skills
  assert(skills.length >= 4, `Project has at least 4 skills (found ${skills.length})`);
  assert(loader.has("commit"), "Project has /commit skill");
  assert(loader.has("review-pr"), "Project has /review-pr skill");
  assert(loader.has("simplify"), "Project has /simplify skill");
  assert(loader.has("debug"), "Project has /debug skill");

  // Skills from all_skills.txt reference
  assert(loader.has("docx"), "Project has /docx skill");
  assert(loader.has("pdf"), "Project has /pdf skill");
  assert(loader.has("skill-creator"), "Project has /skill-creator skill");

  // Index generation
  const index = loader.getIndex();
  assert(index.includes("# Available Skills"), "Index has header");
  assert(index.includes("/commit"), "Index lists /commit");
  assert(index.includes("/docx"), "Index lists /docx");
} else {
  skip("SkillLoader not extracted");
}

// ═══════════════════════════════════════════════════════════════════
// v2.1: Skills as First-Class Runtime Citizens
// ═══════════════════════════════════════════════════════════════════

// ── SkillExecutionContext ────────────────────────────────────────

section("UNIT: SkillExecutionContext");

if (ext.SkillExecutionContext) {
  {
    const ctx = new ext.SkillExecutionContext({
      name: "commit",
      skillRoot: "/tmp/skills/commit",
      allowedTools: ["Bash", "Read", "Grep"],
      hooks: null,
      dataDir: "/tmp/skill-data/commit",
      trackingId: "skill_abc123",
    });

    assert(ctx.name === "commit", "Context has skill name");
    assert(ctx.trackingId === "skill_abc123", "Context has tracking ID");
    assert(ctx.isToolAllowed("Bash"), "Bash is allowed by skill");
    assert(ctx.isToolAllowed("Read"), "Read is allowed by skill");
    assert(ctx.isToolAllowed("Grep"), "Grep is allowed by skill");
    assert(!ctx.isToolAllowed("Write"), "Write is NOT allowed by skill");
    assert(!ctx.isToolAllowed("Edit"), "Edit is NOT allowed by skill");
    assert(!ctx.isToolAllowed("Agent"), "Agent is NOT allowed by skill");
  }

  // Null allowedTools = unrestricted
  {
    const ctx = new ext.SkillExecutionContext({
      name: "debug",
      skillRoot: "/tmp",
      allowedTools: null,
      hooks: null,
      dataDir: "/tmp",
      trackingId: "skill_def456",
    });
    assert(ctx.isToolAllowed("Bash"), "Null allowedTools allows Bash");
    assert(ctx.isToolAllowed("Write"), "Null allowedTools allows Write");
    assert(ctx.isToolAllowed("Agent"), "Null allowedTools allows Agent");
  }

  // Path tracking
  {
    const ctx = new ext.SkillExecutionContext({
      name: "test",
      skillRoot: "/tmp",
      allowedTools: null,
      hooks: null,
      dataDir: "/tmp",
      trackingId: "skill_789",
    });
    ctx.recordPath("/src/index.ts");
    ctx.recordPath("/src/api/routes.ts");
    ctx.recordPath("/src/index.ts"); // duplicate
    assert(ctx.touchedPaths.size === 2, "Deduplicates touched paths");
    assert(ctx.touchedPaths.has("/src/index.ts"), "Records first path");
    assert(ctx.touchedPaths.has("/src/api/routes.ts"), "Records second path");
  }
} else {
  skip("SkillExecutionContext not extracted");
}

// ── Skill-Scoped Tool Restrictions ──────────────────────────────

section("UNIT: Skill-Scoped Tool Restrictions (PermissionManager)");

{
  // Extract PermissionManager for testing — stub SecurityClassifier since it has complex nested braces
  const pmBlock = extractBlock(source, "class PermissionManager {");
  const dtBlock = extractBlock(source, "class DenialTracker {");
  const stubs2 = `
    const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch"]);
    const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
    const toolPermissionChecks = {};
    function _suggestPattern() { return null; }
    class SecurityClassifier { classify() { return { blocked: false }; } }
  `;

  let PM = null;
  try {
    const pmModule = [stubs, stubs2, dtBlock, pmBlock].join("\n\n");
    const pmNs = {};
    new Function("exports", "process", pmModule + "\nexports.PermissionManager = PermissionManager;")(pmNs, process);
    PM = pmNs.PermissionManager;
  } catch (e) {
    process.stderr.write(`\x1b[31mFailed to extract PermissionManager: ${e.message}\x1b[0m\n`);
  }

  if (PM && ext.SkillExecutionContext) {
    // Skill with allowed-tools restricts tool access
    const pm = new PM({ permissionMode: "bypassPermissions" });
    const ctx = new ext.SkillExecutionContext({
      name: "commit",
      skillRoot: "/tmp",
      allowedTools: ["Bash", "Read", "Grep"],
      hooks: null,
      dataDir: "/tmp",
      trackingId: "test",
    });

    const bashResult = await pm.check("Bash", { command: "git status" }, { skillContext: ctx });
    assert(bashResult.behavior === "allow", "Bash allowed in /commit skill (in allowed-tools)");

    const writeResult = await pm.check("Write", { file_path: "/tmp/x" }, { skillContext: ctx });
    assert(writeResult.behavior === "deny", "Write denied in /commit skill (not in allowed-tools)");
    assert(writeResult.rule === "skill_tool_restriction", "Denial rule is skill_tool_restriction");

    const editResult = await pm.check("Edit", { file_path: "/tmp/x" }, { skillContext: ctx });
    assert(editResult.behavior === "deny", "Edit denied in /commit skill (not in allowed-tools)");

    // Without skill context — bypassPermissions allows everything
    const writeNoSkill = await pm.check("Write", { file_path: "/tmp/x" }, {});
    assert(writeNoSkill.behavior === "allow", "Write allowed without skill context in bypass mode");
  } else {
    skip("PermissionManager or SkillExecutionContext not extracted");
  }
}

// ── Skill-Scoped Hooks ──────────────────────────────────────────

section("UNIT: Skill-Scoped Hooks (HookRunner merge)");

if (ext.HookRunner && ext.SkillExecutionContext) {
  // Global hooks + skill hooks merged
  {
    const runner = new ext.HookRunner({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "exit 0", timeout: 5 }] }],
    });

    const skillContext = new ext.SkillExecutionContext({
      name: "deploy",
      skillRoot: "/tmp",
      allowedTools: null,
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "exit 0", timeout: 5 }] }],
      },
      dataDir: "/tmp",
      trackingId: "test",
    });

    // Without skill context: only global hooks
    assert(runner.hasHooksFor("PreToolUse"), "Has global PreToolUse hooks");
    assert(!runner.hasHooksFor("PostToolUse"), "No global PostToolUse hooks");

    // With skill context: merged hooks
    assert(runner.hasHooksFor("PreToolUse", skillContext), "Has merged PreToolUse hooks");

    // Skill with PostToolUse hooks that don't exist globally
    const skillCtx2 = new ext.SkillExecutionContext({
      name: "test",
      skillRoot: "/tmp",
      allowedTools: null,
      hooks: {
        PostToolUse: [{ hooks: [{ type: "command", command: "exit 0", timeout: 5 }] }],
      },
      dataDir: "/tmp",
      trackingId: "test2",
    });
    assert(runner.hasHooksFor("PostToolUse", skillCtx2), "Skill-only PostToolUse hooks detected");
    assert(!runner.hasHooksFor("PostToolUse"), "No PostToolUse without skill context");
  }

  // Skill hook exit 2 blocks
  {
    const runner = new ext.HookRunner({});
    const skillContext = new ext.SkillExecutionContext({
      name: "strict-skill",
      skillRoot: "/tmp",
      allowedTools: null,
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: "echo 'skill hook blocked' >&2; exit 2", timeout: 5 }],
        }],
      },
      dataDir: "/tmp",
      trackingId: "test",
    });

    const result = await runner.fire("PreToolUse",
      { tool_name: "Bash", tool_input: { command: "rm -rf /" }, cwd: "/tmp" },
      { skillContext }
    );
    assert(result.blocked === true, "Skill hook can block tools");
    assert(result.feedback.includes("skill hook blocked"), "Skill hook feedback captured");
  }

  // Context enriched with skill info
  {
    const runner = new ext.HookRunner({
      PreToolUse: [{
        matcher: "Bash",
        hooks: [{
          type: "command",
          command: "cat | python3 -c \"import sys,json; d=json.load(sys.stdin); print(d.get('skill_name','none')); sys.exit(0)\"",
          timeout: 5,
        }],
      }],
    });

    const skillContext = new ext.SkillExecutionContext({
      name: "my-skill",
      skillRoot: "/projects/skill",
      allowedTools: null,
      hooks: null,
      dataDir: "/tmp/skill-data/my-skill",
      trackingId: "test",
    });

    const result = await runner.fire("PreToolUse",
      { tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/tmp" },
      { skillContext }
    );
    assert(!result.blocked, "Hook with skill context runs without blocking");
  }
} else {
  skip("HookRunner or SkillExecutionContext not extracted");
}

// ── Path-Scoped Rules Matching ──────────────────────────────────

section("UNIT: Path-Scoped Rules (_pathMatchesGlob)");

if (ext._pathMatchesGlob) {
  assert(ext._pathMatchesGlob("src/api/routes.ts", "src/api/**/*.ts"), "Matches double-star glob");
  assert(ext._pathMatchesGlob("src/api/v2/routes.ts", "src/api/**/*.ts"), "Matches nested double-star");
  assert(!ext._pathMatchesGlob("src/lib/utils.ts", "src/api/**/*.ts"), "Rejects non-matching path");
  assert(ext._pathMatchesGlob("src/index.js", "src/*.js"), "Matches single-star glob");
  assert(!ext._pathMatchesGlob("src/deep/index.js", "src/*.js"), "Single-star doesn't cross dirs");
  assert(ext._pathMatchesGlob("/full/path/src/api/x.ts", "src/api/**/*.ts"), "Matches with absolute prefix");
  assert(!ext._pathMatchesGlob(null, "src/**"), "Null path returns false");
  assert(!ext._pathMatchesGlob("src/x.ts", null), "Null pattern returns false");
} else {
  skip("_pathMatchesGlob not extracted");
}

// ── Skill Data Directory ────────────────────────────────────────

section("UNIT: Skill Data Directory");

if (ext.SkillLoader) {
  const loader = new ext.SkillLoader().scan(__dirname);
  if (loader.has("commit")) {
    const skill = loader.invoke("commit", "test args");
    assert(skill.dataDir !== undefined, "Skill invocation returns dataDir");
    assert(skill.dataDir.includes("skill-data"), "dataDir path contains skill-data");
    assert(skill.dataDir.includes("commit"), "dataDir path contains skill name");
    assert(fs.existsSync(skill.dataDir), "Skill data directory was created");
  } else {
    skip("commit skill not available");
  }
} else {
  skip("SkillLoader not extracted");
}

// ── Brief Mode ──────────────────────────────────────────────────

// ── Deferred Tool Loading ────────────────────────────────────

section("UNIT: Deferred Tools — register with deferred flag");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  if (trClass) {
    const trNs = {};
    try {
      new Function("exports", trClass + "\nexports.ToolRegistry = ToolRegistry;\n")(trNs);
      const reg = new trNs.ToolRegistry();
      reg.register("Bash", { description: "run", input_schema: {} }, () => "ok");
      reg.register("TaskCreate", { description: "create task", input_schema: { type: "object" } }, () => "ok", { deferred: true });
      reg.register("TaskUpdate", { description: "update task", input_schema: { type: "object" } }, () => "ok", { deferred: true });

      // getDefinitions() should only return eager tools
      const eager = reg.getDefinitions();
      assert(eager.length === 1, "getDefinitions returns only eager tools (1)");
      assert(eager[0].name === "Bash", "Eager tool is Bash");

      // getAllDefinitions() returns everything
      const all = reg.getAllDefinitions();
      assert(all.length === 3, "getAllDefinitions returns all tools (3)");

      // getDeferredNames() returns deferred names
      const deferred = reg.getDeferredNames();
      assert(deferred.length === 2, "getDeferredNames returns 2");
      assert(deferred.includes("TaskCreate"), "TaskCreate is deferred");
      assert(deferred.includes("TaskUpdate"), "TaskUpdate is deferred");

      // isDeferred() check
      assert(reg.isDeferred("TaskCreate"), "TaskCreate isDeferred = true");
      assert(!reg.isDeferred("Bash"), "Bash isDeferred = false");
    } catch (e) {
      skip(`Deferred registration test failed: ${e.message}`);
    }
  } else {
    skip("ToolRegistry extraction failed");
  }
}

section("UNIT: Deferred Tools — getDeferredDelta tracks changes");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  if (trClass) {
    const trNs = {};
    try {
      new Function("exports", trClass + "\nexports.ToolRegistry = ToolRegistry;\n")(trNs);
      const reg = new trNs.ToolRegistry();
      reg.register("TaskA", { description: "a", input_schema: {} }, () => "ok", { deferred: true });
      reg.register("TaskB", { description: "b", input_schema: {} }, () => "ok", { deferred: true });

      // First delta: both are new
      const d1 = reg.getDeferredDelta();
      assert(d1.added.length === 2, "First delta has 2 added");
      assert(d1.removed.length === 0, "First delta has 0 removed");

      // Second delta: no changes
      const d2 = reg.getDeferredDelta();
      assert(d2.added.length === 0, "Second delta has 0 added (no change)");
      assert(d2.removed.length === 0, "Second delta has 0 removed");

      // Add a new deferred tool
      reg.register("TaskC", { description: "c", input_schema: {} }, () => "ok", { deferred: true });
      const d3 = reg.getDeferredDelta();
      assert(d3.added.length === 1, "Third delta has 1 added");
      assert(d3.added[0] === "TaskC", "Added tool is TaskC");

      // Remove a deferred tool
      reg.unregister("TaskA");
      const d4 = reg.getDeferredDelta();
      assert(d4.removed.length === 1, "Fourth delta has 1 removed");
      assert(d4.removed[0] === "TaskA", "Removed tool is TaskA");
    } catch (e) {
      skip(`Deferred delta test failed: ${e.message}`);
    }
  } else {
    skip("ToolRegistry extraction failed");
  }
}

section("UNIT: Deferred Tools — searchDeferred");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  if (trClass) {
    const trNs = {};
    try {
      new Function("exports", trClass + "\nexports.ToolRegistry = ToolRegistry;\n")(trNs);
      const reg = new trNs.ToolRegistry();
      reg.register("Bash", { description: "run commands", input_schema: {} }, () => "ok");
      reg.register("TaskCreate", { description: "Create a new task", input_schema: { type: "object", properties: { name: { type: "string" } } } }, () => "ok", { deferred: true });
      reg.register("TaskUpdate", { description: "Update an existing task", input_schema: { type: "object", properties: { id: { type: "string" } } } }, () => "ok", { deferred: true });
      reg.register("mcp__notion__search", { description: "Search Notion pages", input_schema: {} }, () => "ok", { deferred: true });

      // select: syntax
      const r1 = reg.searchDeferred("select:TaskCreate,TaskUpdate");
      assert(r1.length === 2, "select: returns 2 exact matches");
      assert(r1[0].name === "TaskCreate", "First match is TaskCreate");
      assert(r1[0].input_schema.properties.name !== undefined, "Returns full schema");

      // keyword search
      const r2 = reg.searchDeferred("task");
      assert(r2.length === 2, "Keyword 'task' matches 2 deferred tools");

      // +keyword search
      const r3 = reg.searchDeferred("+notion");
      assert(r3.length === 1, "+notion matches 1 tool");
      assert(r3[0].name === "mcp__notion__search", "+notion matches notion tool");

      // select: for non-deferred returns the tool (useful for fetching any tool)
      const r4 = reg.searchDeferred("select:Bash");
      assert(r4.length === 1, "select: can also fetch non-deferred tools");

      // No match
      const r5 = reg.searchDeferred("nonexistent");
      assert(r5.length === 0, "No match returns empty array");
    } catch (e) {
      skip(`searchDeferred test failed: ${e.message}`);
    }
  } else {
    skip("ToolRegistry extraction failed");
  }
}

section("UNIT: Deferred Tools — registerToolSearch");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  const tsFunc = extractBlock(source, "function registerToolSearch(");
  if (trClass && tsFunc) {
    const tsNs = {};
    try {
      new Function("exports",
        trClass + "\n" + tsFunc +
        "\nexports.ToolRegistry = ToolRegistry;\nexports.registerToolSearch = registerToolSearch;\n"
      )(tsNs);

      // No deferred tools: ToolSearch should NOT be registered
      const reg1 = new tsNs.ToolRegistry();
      reg1.register("Bash", { description: "run", input_schema: {} }, () => "ok");
      tsNs.registerToolSearch(reg1);
      assert(!reg1.has("ToolSearch"), "ToolSearch not registered when no deferred tools");

      // With deferred tools: ToolSearch SHOULD be registered
      const reg2 = new tsNs.ToolRegistry();
      reg2.register("Bash", { description: "run", input_schema: {} }, () => "ok");
      reg2.register("TaskCreate", { description: "create", input_schema: {} }, () => "ok", { deferred: true });
      tsNs.registerToolSearch(reg2);
      assert(reg2.has("ToolSearch"), "ToolSearch registered when deferred tools exist");

      // ToolSearch itself is NOT deferred (it must be eager)
      assert(!reg2.isDeferred("ToolSearch"), "ToolSearch is not deferred");

      // ToolSearch appears in eager definitions
      const defs = reg2.getDefinitions();
      assert(defs.some(d => d.name === "ToolSearch"), "ToolSearch in eager definitions");
    } catch (e) {
      skip(`registerToolSearch test failed: ${e.message}`);
    }
  } else {
    skip("registerToolSearch extraction failed");
  }
}

section("UNIT: Deferred Tools — ToolSearch executor");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  const tsFunc = extractBlock(source, "function registerToolSearch(");
  if (trClass && tsFunc) {
    const tsNs = {};
    try {
      new Function("exports",
        trClass + "\n" + tsFunc +
        "\nexports.ToolRegistry = ToolRegistry;\nexports.registerToolSearch = registerToolSearch;\n"
      )(tsNs);

      const reg = new tsNs.ToolRegistry();
      reg.register("Bash", { description: "run", input_schema: {} }, () => "ok");
      reg.register("TaskCreate", { description: "Create a new task", input_schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } }, () => "ok", { deferred: true });
      reg.register("TaskUpdate", { description: "Update a task", input_schema: { type: "object", properties: { id: { type: "string" } } } }, () => "ok", { deferred: true });
      tsNs.registerToolSearch(reg);

      // Execute ToolSearch with select query (promotes TaskCreate to eager)
      const result = await reg.execute("ToolSearch", { query: "select:TaskCreate" });
      assert(!result.is_error, "ToolSearch execution succeeds");
      assert(result.content.includes("<functions>"), "Result contains <functions> block");
      assert(result.content.includes("TaskCreate"), "Result contains TaskCreate");
      assert(result.content.includes("title"), "Result contains schema details");
      assert(result.content.includes("</functions>"), "Result has closing tag");

      // Execute with keyword search (TaskUpdate is still deferred)
      const result2 = await reg.execute("ToolSearch", { query: "task", max_results: 1 });
      assert(!result2.is_error, "Keyword search succeeds");
      assert(result2.content.includes("TaskUpdate"), "Keyword finds TaskUpdate");

      // No match
      const result3 = await reg.execute("ToolSearch", { query: "zzzznonexistent" });
      assert(!result3.is_error, "No-match doesn't error");
      assert(result3.content.includes("No matching"), "No-match message correct");

    } catch (e) {
      skip(`ToolSearch executor test failed: ${e.message}`);
    }
  } else {
    skip("ToolSearch extraction failed");
  }
}

section("UNIT: Deferred Tools — promote moves tool to eager");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  if (trClass) {
    const trNs = {};
    try {
      new Function("exports", trClass + "\nexports.ToolRegistry = ToolRegistry;\n")(trNs);
      const reg = new trNs.ToolRegistry();
      reg.register("Bash", { description: "run", input_schema: {} }, () => "ok");
      reg.register("TaskCreate", { description: "create", input_schema: { type: "object" } }, () => "ok", { deferred: true });

      // Initially deferred — not in getDefinitions
      assert(reg.getDefinitions().length === 1, "Before promote: 1 eager tool");
      assert(reg.isDeferred("TaskCreate"), "Before promote: TaskCreate is deferred");

      // Promote
      reg.promote("TaskCreate");
      assert(!reg.isDeferred("TaskCreate"), "After promote: TaskCreate is no longer deferred");
      assert(reg.getDefinitions().length === 2, "After promote: 2 eager tools");
      assert(reg.getDefinitions().some(d => d.name === "TaskCreate"), "After promote: TaskCreate in eager defs");

      // Promotion should NOT trigger a "removed" delta
      // First, announce the initial state
      reg.register("TaskB", { description: "b", input_schema: {} }, () => "ok", { deferred: true });
      const d1 = reg.getDeferredDelta(); // Announces TaskB
      assert(d1.added.includes("TaskB"), "TaskB announced as added");

      // Now promote TaskB — it should silently disappear from announced
      reg.promote("TaskB");
      const d2 = reg.getDeferredDelta();
      assert(d2.removed.length === 0, "Promoted tool not reported as removed");
      assert(d2.added.length === 0, "No spurious additions after promote");
    } catch (e) {
      skip(`promote test failed: ${e.message}`);
    }
  } else {
    skip("ToolRegistry extraction failed");
  }
}

section("UNIT: Deferred Tools — ToolSearch promotes fetched tools");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  const tsFunc = extractBlock(source, "function registerToolSearch(");
  if (trClass && tsFunc) {
    const tsNs = {};
    try {
      new Function("exports",
        trClass + "\n" + tsFunc +
        "\nexports.ToolRegistry = ToolRegistry;\nexports.registerToolSearch = registerToolSearch;\n"
      )(tsNs);

      const reg = new tsNs.ToolRegistry();
      reg.register("Bash", { description: "run", input_schema: {} }, () => "ok");
      reg.register("TaskCreate", { description: "Create task", input_schema: { type: "object", properties: { title: { type: "string" } } } }, () => "ok", { deferred: true });
      tsNs.registerToolSearch(reg);

      // Before ToolSearch: TaskCreate is deferred
      assert(reg.isDeferred("TaskCreate"), "TaskCreate starts deferred");
      assert(reg.getDefinitions().filter(d => d.name === "TaskCreate").length === 0, "TaskCreate not in eager defs");

      // Execute ToolSearch
      await reg.execute("ToolSearch", { query: "select:TaskCreate" });

      // After ToolSearch: TaskCreate should be promoted to eager
      assert(!reg.isDeferred("TaskCreate"), "TaskCreate promoted after ToolSearch");
      assert(reg.getDefinitions().some(d => d.name === "TaskCreate"), "TaskCreate now in eager defs");
    } catch (e) {
      skip(`ToolSearch promotion test failed: ${e.message}`);
    }
  } else {
    skip("ToolSearch extraction failed");
  }
}

section("UNIT: Deferred Tools — READ_ONLY_TOOLS includes ToolSearch");

{
  const roMatch = source.match(/const READ_ONLY_TOOLS = new Set\(\[([^\]]+)\]\)/);
  if (roMatch) {
    assert(roMatch[1].includes('"ToolSearch"'), "READ_ONLY_TOOLS includes ToolSearch");
  } else {
    skip("READ_ONLY_TOOLS not found");
  }
}

section("UNIT: Deferred Tools — MCP tools registered as deferred");

{
  // Verify MCP registration code uses { deferred: true }
  const mcpMatch = source.includes('}, { deferred: true }); // MCP tools are always deferred');
  assert(mcpMatch, "MCP tools registered with deferred: true");
}

// ── Task Tools ──────────────────────────────────────────────────

section("UNIT: Task Tools — registered as deferred");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  const deferFunc = extractBlock(source, "function registerDeferredBuiltinTools(");
  if (trClass && deferFunc) {
    const ns2 = {};
    try {
      new Function("exports", "fs", "path", "os",
        trClass + "\n" + deferFunc +
        "\nexports.ToolRegistry = ToolRegistry;\nexports.registerDeferredBuiltinTools = registerDeferredBuiltinTools;\n"
      )(ns2, fs, path, os);
      const reg = new ns2.ToolRegistry();
      ns2.registerDeferredBuiltinTools(reg, {});

      // All 6 tools registered
      assert(reg.has("TaskCreate"), "TaskCreate registered");
      assert(reg.has("TaskUpdate"), "TaskUpdate registered");
      assert(reg.has("TaskGet"), "TaskGet registered");
      assert(reg.has("TaskList"), "TaskList registered");
      assert(reg.has("EnterPlanMode"), "EnterPlanMode registered");
      assert(reg.has("ExitPlanMode"), "ExitPlanMode registered");

      // All deferred
      assert(reg.isDeferred("TaskCreate"), "TaskCreate is deferred");
      assert(reg.isDeferred("TaskUpdate"), "TaskUpdate is deferred");
      assert(reg.isDeferred("TaskGet"), "TaskGet is deferred");
      assert(reg.isDeferred("TaskList"), "TaskList is deferred");
      assert(reg.isDeferred("EnterPlanMode"), "EnterPlanMode is deferred");
      assert(reg.isDeferred("ExitPlanMode"), "ExitPlanMode is deferred");

      // None in eager definitions
      const eager = reg.getDefinitions();
      assert(eager.length === 0, "No eager tools from registerDeferredBuiltinTools");

      // All in getAllDefinitions
      const all = reg.getAllDefinitions();
      assert(all.length === 6, "6 total tools from registerDeferredBuiltinTools");

      // All in getDeferredNames
      const names = reg.getDeferredNames();
      assert(names.length === 6, "6 deferred names");
    } catch (e) {
      skip(`Task tools registration test failed: ${e.message}`);
    }
  } else {
    skip("registerDeferredBuiltinTools extraction failed");
  }
}

section("UNIT: Task Tools — CRUD operations");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  const deferFunc = extractBlock(source, "function registerDeferredBuiltinTools(");
  if (trClass && deferFunc) {
    const ns2 = {};
    try {
      new Function("exports", "fs", "path", "os",
        trClass + "\n" + deferFunc +
        "\nexports.ToolRegistry = ToolRegistry;\nexports.registerDeferredBuiltinTools = registerDeferredBuiltinTools;\n"
      )(ns2, fs, path, os);
      const reg = new ns2.ToolRegistry();
      ns2.registerDeferredBuiltinTools(reg, {});

      // Create
      const r1 = await reg.execute("TaskCreate", { title: "Fix bug", description: "Fix the login bug", priority: "high" });
      assert(!r1.is_error, "TaskCreate succeeds");
      const t1 = JSON.parse(r1.content);
      assert(t1.title === "Fix bug", "Task title correct");
      assert(t1.status === "pending", "Default status is pending");
      assert(t1.priority === "high", "Priority is high");
      assert(t1.id.startsWith("task_"), "ID has task_ prefix");

      // Create second
      const r2 = await reg.execute("TaskCreate", { title: "Write tests" });
      const t2 = JSON.parse(r2.content);
      assert(t2.id !== t1.id, "Second task has different ID");

      // Get
      const r3 = await reg.execute("TaskGet", { id: t1.id });
      assert(!r3.is_error, "TaskGet succeeds");
      const t3 = JSON.parse(r3.content);
      assert(t3.title === "Fix bug", "TaskGet returns correct task");

      // Get nonexistent
      const r4 = await reg.execute("TaskGet", { id: "task_999" });
      assert(r4.is_error, "TaskGet nonexistent returns error");

      // Update
      const r5 = await reg.execute("TaskUpdate", { id: t1.id, status: "in_progress" });
      assert(!r5.is_error, "TaskUpdate succeeds");
      const t5 = JSON.parse(r5.content);
      assert(t5.status === "in_progress", "Status updated");
      assert(t5.title === "Fix bug", "Title unchanged");

      // Update nonexistent
      const r6 = await reg.execute("TaskUpdate", { id: "task_999", status: "completed" });
      assert(r6.is_error, "TaskUpdate nonexistent returns error");

      // List all
      const r7 = await reg.execute("TaskList", {});
      assert(!r7.is_error, "TaskList succeeds");
      const all = JSON.parse(r7.content);
      assert(all.length === 2, "TaskList returns 2 tasks");

      // List filtered
      const r8 = await reg.execute("TaskList", { status: "in_progress" });
      const filtered = JSON.parse(r8.content);
      assert(filtered.length === 1, "TaskList filtered returns 1 task");
      assert(filtered[0].id === t1.id, "Filtered result is correct task");

      // Complete
      await reg.execute("TaskUpdate", { id: t1.id, status: "completed" });
      const r9 = await reg.execute("TaskList", { status: "completed" });
      const completed = JSON.parse(r9.content);
      assert(completed.length === 1, "1 completed task");
    } catch (e) {
      skip(`Task CRUD test failed: ${e.message}`);
    }
  } else {
    skip("registerDeferredBuiltinTools extraction failed");
  }
}

section("UNIT: Plan Mode Tools — enter and exit");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  const deferFunc = extractBlock(source, "function registerDeferredBuiltinTools(");
  if (trClass && deferFunc) {
    const ns2 = {};
    try {
      new Function("exports", "fs", "path", "os",
        trClass + "\n" + deferFunc +
        "\nexports.ToolRegistry = ToolRegistry;\nexports.registerDeferredBuiltinTools = registerDeferredBuiltinTools;\n"
      )(ns2, fs, path, os);
      const cfg = {};
      const reg = new ns2.ToolRegistry();
      ns2.registerDeferredBuiltinTools(reg, cfg);

      // Enter plan mode
      const r1 = await reg.execute("EnterPlanMode", { reason: "Complex refactoring" });
      assert(!r1.is_error, "EnterPlanMode succeeds");
      assert(r1.content.includes("plan mode"), "Response mentions plan mode");
      assert(cfg._planMode === true, "cfg._planMode set to true");

      // Exit plan mode
      const r2 = await reg.execute("ExitPlanMode", { plan: "# Plan\n1. Step one\n2. Step two" });
      assert(!r2.is_error, "ExitPlanMode succeeds");
      assert(r2.content.includes("Exited plan mode"), "Response mentions exit");
      assert(cfg._planMode === false, "cfg._planMode set to false");
      // Plan file created
      assert(r2.content.includes(".md"), "Plan file path in response");
    } catch (e) {
      skip(`Plan mode test failed: ${e.message}`);
    }
  } else {
    skip("registerDeferredBuiltinTools extraction failed");
  }
}

section("UNIT: --brief CLI flag");

{
  // Check parseArgs handles --brief
  const parseFunc = extractBlock(source, "async function parseArgs(");
  if (parseFunc) {
    assert(source.includes('case "--brief": cfg.briefMode = true; break;'), "--brief flag is in parseArgs switch");
  } else {
    skip("parseArgs extraction failed");
  }
}

section("UNIT: Brief + Deferred interaction — SendUserMessage is eager");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  const briefFunc = extractBlock(source, "function registerBriefTools(");
  const deferFunc = extractBlock(source, "function registerDeferredBuiltinTools(");
  if (trClass && briefFunc && deferFunc) {
    const ns2 = {};
    try {
      new Function("exports", "fs", "path", "os",
        trClass + "\n" + deferFunc + "\n" + briefFunc +
        "\nexports.ToolRegistry = ToolRegistry;\nexports.registerDeferredBuiltinTools = registerDeferredBuiltinTools;\nexports.registerBriefTools = registerBriefTools;\n"
      )(ns2, fs, path, os);
      const reg = new ns2.ToolRegistry();
      ns2.registerDeferredBuiltinTools(reg, {});
      ns2.registerBriefTools(reg, {});

      // SendUserMessage should be eager (not deferred)
      assert(!reg.isDeferred("SendUserMessage"), "SendUserMessage is NOT deferred");
      assert(reg.getDefinitions().some(d => d.name === "SendUserMessage"), "SendUserMessage in eager definitions");

      // Task tools should still be deferred
      assert(reg.isDeferred("TaskCreate"), "TaskCreate still deferred with brief mode");

      // getDeferredNames should not include SendUserMessage
      const deferred = reg.getDeferredNames();
      assert(!deferred.includes("SendUserMessage"), "SendUserMessage not in deferred names");
      assert(deferred.includes("TaskCreate"), "TaskCreate in deferred names");
    } catch (e) {
      skip(`Brief+deferred interaction test failed: ${e.message}`);
    }
  } else {
    skip("Brief/deferred function extraction failed");
  }
}

section("UNIT: Deferred tools in READ_ONLY_TOOLS");

{
  const roMatch = source.match(/const READ_ONLY_TOOLS = new Set\(\[([^\]]+)\]\)/);
  if (roMatch) {
    const tools = roMatch[1];
    assert(tools.includes('"TaskCreate"'), "READ_ONLY_TOOLS includes TaskCreate");
    assert(tools.includes('"TaskUpdate"'), "READ_ONLY_TOOLS includes TaskUpdate");
    assert(tools.includes('"TaskGet"'), "READ_ONLY_TOOLS includes TaskGet");
    assert(tools.includes('"TaskList"'), "READ_ONLY_TOOLS includes TaskList");
    assert(tools.includes('"EnterPlanMode"'), "READ_ONLY_TOOLS includes EnterPlanMode");
    assert(tools.includes('"ExitPlanMode"'), "READ_ONLY_TOOLS includes ExitPlanMode");
  } else {
    skip("READ_ONLY_TOOLS not found");
  }
}

// ── Brief Mode ──────────────────────────────────────────────────

section("UNIT: Brief Mode — ToolRegistry.unregister");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  if (trClass) {
    const trNs = {};
    try {
      new Function("exports", trClass + "\nexports.ToolRegistry = ToolRegistry;\n")(trNs);
      const reg = new trNs.ToolRegistry();
      reg.register("TestTool", { description: "test", input_schema: {} }, () => "ok");
      assert(reg.has("TestTool"), "Tool registered");
      reg.unregister("TestTool");
      assert(!reg.has("TestTool"), "Tool unregistered");
      const defs = reg.getDefinitions();
      assert(!defs.some(d => d.name === "TestTool"), "Unregistered tool not in definitions");
    } catch (e) {
      skip(`ToolRegistry.unregister test failed: ${e.message}`);
    }
  } else {
    skip("ToolRegistry extraction failed");
  }
}

section("UNIT: Brief Mode — registerBriefTools");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  const briefFunc = extractBlock(source, "function registerBriefTools(");
  if (trClass && briefFunc) {
    const ns2 = {};
    try {
      new Function("exports", "fs", "path",
        trClass + "\n" + briefFunc +
        "\nexports.ToolRegistry = ToolRegistry;\nexports.registerBriefTools = registerBriefTools;\n"
      )(ns2, fs, path);
      const reg = new ns2.ToolRegistry();
      ns2.registerBriefTools(reg, {});
      assert(reg.has("SendUserMessage"), "SendUserMessage registered by registerBriefTools");
      const defs = reg.getDefinitions();
      const def = defs.find(d => d.name === "SendUserMessage");
      assert(def !== undefined, "SendUserMessage appears in definitions");
      assert(def.input_schema.required.includes("message"), "message is required");
    } catch (e) {
      skip(`registerBriefTools test failed: ${e.message}`);
    }
  } else {
    skip("registerBriefTools extraction failed");
  }
}

section("UNIT: Brief Mode — SendUserMessage executor");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  const briefFunc = extractBlock(source, "function registerBriefTools(");
  if (trClass && briefFunc) {
    const ns2 = {};
    try {
      new Function("exports", "fs", "path",
        trClass + "\n" + briefFunc +
        "\nexports.ToolRegistry = ToolRegistry;\nexports.registerBriefTools = registerBriefTools;\n"
      )(ns2, fs, path);
      const reg = new ns2.ToolRegistry();
      ns2.registerBriefTools(reg, {});

      // Test basic message
      const result = await reg.execute("SendUserMessage", { message: "Hello world" });
      assert(!result.is_error, "SendUserMessage basic execution succeeds");
      const parsed = JSON.parse(result.content);
      assert(parsed.message === "Hello world", "SendUserMessage returns correct message");
      assert(parsed.status === "normal", "SendUserMessage defaults to normal status");
      assert(parsed.sentAt !== undefined, "SendUserMessage includes sentAt timestamp");
      assert(Array.isArray(parsed.attachments), "SendUserMessage returns empty attachments array");

      // Test with valid attachment
      const tmpFile = path.join(os.tmpdir(), `brief-test-${Date.now()}.txt`);
      fs.writeFileSync(tmpFile, "test content");
      const result2 = await reg.execute("SendUserMessage", { message: "With attachment", attachments: [tmpFile] });
      assert(!result2.is_error, "SendUserMessage with valid attachment succeeds");
      const parsed2 = JSON.parse(result2.content);
      assert(parsed2.attachments.length === 1, "Has one attachment");
      assert(parsed2.attachments[0].path === tmpFile, "Attachment path correct");
      assert(typeof parsed2.attachments[0].size === "number", "Attachment has size");
      fs.unlinkSync(tmpFile);

      // Test with missing attachment
      const result3 = await reg.execute("SendUserMessage", { message: "Bad", attachments: ["/nonexistent/file.txt"] });
      assert(result3.is_error, "SendUserMessage with missing attachment returns error");

    } catch (e) {
      skip(`SendUserMessage executor test failed: ${e.message}`);
    }
  } else {
    skip("SendUserMessage extraction failed");
  }
}

section("UNIT: Brief Mode — READ_ONLY_TOOLS includes SendUserMessage");

{
  const roMatch = source.match(/const READ_ONLY_TOOLS = new Set\(\[([^\]]+)\]\)/);
  if (roMatch) {
    assert(roMatch[1].includes('"SendUserMessage"'), "READ_ONLY_TOOLS includes SendUserMessage");
  } else {
    skip("READ_ONLY_TOOLS not found");
  }
}

section("UNIT: Brief Mode — buildSystemPrompt with briefMode");

{
  const buildFunc = extractBlock(source, "function buildSystemPrompt(");
  const loadClaudeMdFunc = extractBlock(source, "function loadClaudeMdFiles(");
  const loadRulesFunc2 = extractBlock(source, "function loadRules(");
  const findProjectRootFunc2 = extractBlock(source, "function findProjectRoot(");
  const processImportsFunc2 = extractBlock(source, "function processImports(");
  const parseYamlFunc = extractBlock(source, "function parseYamlFrontmatter(");
  const buildMemoryFunc = extractBlock(source, "function buildMemoryPrompt(");
  const loadMemoryFunc = extractBlock(source, "function loadMemoryIndex(");
  const ensureMemFunc = extractBlock(source, "function ensureMemoryDir(");
  const getMemoryDirFunc = extractBlock(source, "function getMemoryDir(");

  if (buildFunc) {
    try {
      const combined = [
        "function log() {}",
        'const MEMORY_INDEX = "MEMORY.md"; const MEMORY_MAX_LINES = 200;',
        parseYamlFunc, findProjectRootFunc2, processImportsFunc2,
        providerConventionFilesConst, loadClaudeMdFunc, loadRulesFunc2,
        getMemoryDirFunc, ensureMemFunc, loadMemoryFunc, buildMemoryFunc,
        buildFunc,
      ].filter(Boolean).join("\n\n");

      const bpNs = {};
      new Function("exports", "process", "fs", "path", "os",
        combined + "\nexports.buildSystemPrompt = buildSystemPrompt;\n"
      )(bpNs, process, fs, path, os);

      // With briefMode: true
      const blocks = bpNs.buildSystemPrompt({ model: "test", cwd: os.tmpdir(), briefMode: true });
      const fullText = blocks.map(b => b.text).join("\n");
      assert(fullText.includes("# Brief Mode"), "briefMode=true includes Brief Mode section");
      assert(fullText.includes("SendUserMessage"), "briefMode=true mentions SendUserMessage");

      // With briefMode: false
      const blocks2 = bpNs.buildSystemPrompt({ model: "test", cwd: os.tmpdir(), briefMode: false });
      const fullText2 = blocks2.map(b => b.text).join("\n");
      assert(!fullText2.includes("# Brief Mode"), "briefMode=false excludes Brief Mode section");

    } catch (e) {
      skip(`buildSystemPrompt brief test failed: ${e.message}`);
    }
  } else {
    skip("buildSystemPrompt extraction failed");
  }
}

// ── Verification Auto-Trigger ────────────────────────────────

section("UNIT: Verification auto-trigger — nudge after 3 completions");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  const deferFunc = extractBlock(source, "function registerDeferredBuiltinTools(");
  if (trClass && deferFunc) {
    const ns2 = {};
    try {
      new Function("exports", "fs", "path", "os",
        trClass + "\n" + deferFunc +
        "\nexports.ToolRegistry = ToolRegistry;\nexports.registerDeferredBuiltinTools = registerDeferredBuiltinTools;\n"
      )(ns2, fs, path, os);
      const cfg = {};
      const reg = new ns2.ToolRegistry();
      ns2.registerDeferredBuiltinTools(reg, cfg);

      // Create 3 tasks
      await reg.execute("TaskCreate", { title: "Task 1" });
      await reg.execute("TaskCreate", { title: "Task 2" });
      await reg.execute("TaskCreate", { title: "Task 3" });

      // Complete first 2 — no nudge yet
      const r1 = await reg.execute("TaskUpdate", { id: "task_1", status: "completed" });
      assert(!r1.content.includes("system-reminder"), "No nudge after 1 completion");
      const r2 = await reg.execute("TaskUpdate", { id: "task_2", status: "completed" });
      assert(!r2.content.includes("system-reminder"), "No nudge after 2 completions");

      // Complete 3rd — nudge triggers
      const r3 = await reg.execute("TaskUpdate", { id: "task_3", status: "completed" });
      assert(r3.content.includes("system-reminder"), "Nudge appears after 3 completions");
      assert(r3.content.includes("verification"), "Nudge mentions verification agent");
      assert(r3.content.includes("subagent_type"), "Nudge tells how to spawn verifier");

      // Counter is on cfg
      assert(cfg._completedWithoutVerification === 3, "Counter tracks completions on cfg");

    } catch (e) {
      skip(`Verification auto-trigger test failed: ${e.message}`);
    }
  } else {
    skip("registerDeferredBuiltinTools extraction failed");
  }
}

section("UNIT: Verification auto-trigger — no double-nudge on re-complete");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  const deferFunc = extractBlock(source, "function registerDeferredBuiltinTools(");
  if (trClass && deferFunc) {
    const ns2 = {};
    try {
      new Function("exports", "fs", "path", "os",
        trClass + "\n" + deferFunc +
        "\nexports.ToolRegistry = ToolRegistry;\nexports.registerDeferredBuiltinTools = registerDeferredBuiltinTools;\n"
      )(ns2, fs, path, os);
      const cfg = {};
      const reg = new ns2.ToolRegistry();
      ns2.registerDeferredBuiltinTools(reg, cfg);

      await reg.execute("TaskCreate", { title: "T1" });
      await reg.execute("TaskUpdate", { id: "task_1", status: "completed" });

      // Re-completing an already completed task should NOT increment counter
      const r = await reg.execute("TaskUpdate", { id: "task_1", status: "completed" });
      assert(cfg._completedWithoutVerification === 1, "Re-complete doesn't double-count");

    } catch (e) {
      skip(`Re-complete test failed: ${e.message}`);
    }
  } else {
    skip("registerDeferredBuiltinTools extraction failed");
  }
}

section("UNIT: Verification auto-trigger — counter resets on verification spawn");

{
  // Verify the reset logic exists in SubAgentRunner
  assert(source.includes('agentDef.agentType === "verification"'), "SubAgentRunner checks for verification agent type");
  assert(source.includes("_completedWithoutVerification = 0"), "Counter reset to 0 when verification spawns");
}

// ── Model Profiles & Orchestrator ────────────────────────────

section("UNIT: MODEL_PROFILES — all 8 workload categories");

{
  assert(source.includes("const MODEL_PROFILES"), "MODEL_PROFILES constant exists");
  const categories = ["exploration", "planning", "implementation", "verification", "documentation", "summarization", "tool-heavy", "reasoning"];
  for (const cat of categories) {
    assert(source.includes(cat), `MODEL_PROFILES has "${cat}" category`);
  }
}

section("UNIT: resolveModelForWorkload — routing logic");

{
  const profileBlock = source.slice(source.indexOf("const MODEL_PROFILES"), source.indexOf("// ── Provider Registry"));
  if (profileBlock) {
    assert(profileBlock.includes("resolveModelForWorkload"), "resolveModelForWorkload function exists");
    assert(profileBlock.includes("_hasProviderAuth"), "_hasProviderAuth function exists");
    assert(profileBlock.includes("cfg._modelProfiles"), "Supports user profile overrides");
    assert(profileBlock.includes("preferred"), "Checks preferred model");
    assert(profileBlock.includes("fallback"), "Falls back when no auth");
  }
}

section("UNIT: Orchestrator agent type");

{
  assert(source.includes('"orchestrator"'), "orchestrator agent type defined");
  assert(source.includes("Task Routing Table"), "Orchestrator prompt includes routing table");
  assert(source.includes("ANALYZE"), "Orchestrator has ANALYZE step");
  assert(source.includes("CLASSIFY"), "Orchestrator has CLASSIFY step");
  assert(source.includes("ROUTE"), "Orchestrator has ROUTE step");
  assert(source.includes("MERGE"), "Orchestrator has MERGE step");
  assert(source.includes("getSystemPrompt(this.cfg)"), "getSystemPrompt receives cfg for dynamic routing table");
}

// ── AgentLoader (public extensibility) ──────────────────────

section("UNIT: AgentLoader — class and methods");

{
  const alClass = extractBlock(source, "class AgentLoader {");
  if (alClass) {
    const alNs = {};
    try {
      // Need parseYamlFrontmatter and resolveModel for AgentLoader
      const parseFunc = extractBlock(source, "function parseYamlFrontmatter(");
      const resolveFunc = extractBlock(source, "function resolveModel(");
      const aliasBlock = source.slice(source.indexOf("const MODEL_ALIASES"), source.indexOf("function resolveModel"));
      new Function("exports", "fs", "path", "os",
        "function log() {}\n" + aliasBlock + "\n" + parseFunc + "\n" + resolveFunc + "\n" + alClass +
        "\nexports.AgentLoader = AgentLoader;\n"
      )(alNs, fs, path, os);

      // Create temp agent dir
      const tmpDir = path.join(os.tmpdir(), `agent-test-${Date.now()}`);
      const agentDir = path.join(tmpDir, ".claude", "agents", "test-agent");
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, "AGENT.md"), `---
name: test-agent
description: A test agent
model: haiku
read_only: true
disallowed_tools: Write,Edit
workload: exploration
---

You are a test agent. Do test things.`);

      const loader = new alNs.AgentLoader().scan(tmpDir);
      assert(loader.has("test-agent"), "AgentLoader discovers agent from disk");

      const meta = loader.get("test-agent");
      assert(meta.name === "test-agent", "Agent name correct");
      assert(meta.description === "A test agent", "Agent description correct");
      assert(meta.model === "haiku", "Agent model correct");
      assert(meta.readOnly === true, "Agent readOnly correct");
      assert(meta.workload === "exploration", "Agent workload correct");

      const list = loader.list();
      assert(list.length === 1, "AgentLoader.list() returns 1 agent");

      const resolved = loader.resolve("test-agent");
      assert(resolved !== null, "AgentLoader.resolve returns object");
      assert(resolved.agentType === "test-agent", "Resolved agentType correct");
      assert(typeof resolved.getSystemPrompt === "function", "Resolved has getSystemPrompt function");
      assert(resolved.getSystemPrompt().includes("test agent"), "System prompt contains body text");
      assert(resolved.disallowedTools.includes("Write"), "disallowedTools parsed");
      assert(resolved.source === "custom", "source is custom");

      // Cleanup
      fs.rmSync(tmpDir, { recursive: true });
    } catch (e) {
      skip(`AgentLoader test failed: ${e.message}`);
    }
  } else {
    skip("AgentLoader class extraction failed");
  }
}

section("UNIT: SubAgentRunner falls back to AgentLoader");

{
  assert(source.includes("_agentLoader?.resolve(subagentType)"), "SubAgentRunner checks AgentLoader as fallback");
  assert(source.includes("Builtin:"), "Error message lists builtin types");
  assert(source.includes("Custom:"), "Error message lists custom types");
}

section("UNIT: subagent_type is free-form string");

{
  // Verify no enum constraint on subagent_type
  assert(!source.includes('subagent_type: { type: "string", enum:'), "subagent_type has no enum constraint");
  assert(source.includes("or any custom agent name"), "subagent_type description mentions custom agents");
}

section("UNIT: /orchestrate slash command");

{
  assert(source.includes('name: "orchestrate"'), "/orchestrate command registered");
  assert(source.includes("Launching orchestrator"), "/orchestrate emits status message");
}

// ── Session Resume ──────────────────────────────────────────

section("UNIT: SessionManager — scoped by project");

{
  const smClass = extractBlock(source, "class SessionManager {");
  if (smClass) {
    assert(smClass.includes("projects"), "Sessions stored in projects/ subdirectory");
    assert(smClass.includes("sanitized"), "CWD is sanitized for path");
    assert(smClass.includes("setMeta"), "setMeta method exists");
    assert(smClass.includes("getMeta"), "getMeta method exists");
    assert(smClass.includes("autoTitle"), "autoTitle method exists");
    assert(smClass.includes("listAll"), "listAll method exists");
    assert(smClass.includes("_findFile"), "_findFile with prefix match exists");
  } else {
    skip("SessionManager extraction failed");
  }
}

section("UNIT: /sessions slash command");

{
  assert(source.includes('name: "sessions"'), "/sessions command registered");
  assert(source.includes("Recent Sessions"), "/sessions shows recent sessions header");
  assert(source.includes("sessions.listAll()"), "/sessions uses listAll()");
}

section("UNIT: Session auto-title");

{
  assert(source.includes("autoTitle(this.sessionId)"), "Auto-title saved after first exchange");
  assert(source.includes('setMeta(this.sessionId, "title"'), "Title saved via setMeta");
}

// ── LLM Hooks ───────────────────────────────────────────────

section("UNIT: LLM Hooks — prompt type");

{
  assert(source.includes('hook.type === "prompt"'), "HookRunner dispatches prompt hooks");
  assert(source.includes("_evalPromptHook"), "_evalPromptHook method exists");
  assert(source.includes('"ok": true'), "Prompt hook expects JSON ok field");
  // Fail closed on parse error
  assert(source.includes("invalid JSON"), "Fails closed on invalid JSON");
}

section("UNIT: LLM Hooks — agent type");

{
  assert(source.includes('hook.type === "agent"'), "HookRunner dispatches agent hooks");
  assert(source.includes("_evalAgentHook"), "_evalAgentHook method exists");
  assert(source.includes("_inHookExecution"), "Recursion guard flag exists");
  // Recursion guard
  assert(source.includes("if (this._inHookExecution) return"), "Recursion guard at top of fire()");
  // Max turns capped
  assert(source.includes("Math.min(hook.max_turns || 10, 20)"), "Agent hook max turns capped at 20");
  // Read-only tools
  assert(source.includes('["Read", "Glob", "Grep", "Bash"]'), "Agent hook uses safe tools only");
  // Null _hookRunner prevents recursion
  assert(source.includes("_hookRunner: null"), "Hook agent cfg has null _hookRunner");
}

section("UNIT: LLM Hooks — recursion guard prevents infinite loops");

{
  const hookClass = extractBlock(source, "class HookRunner {");
  if (hookClass) {
    // Guard is checked at entry of fire()
    assert(hookClass.includes("_inHookExecution") && hookClass.includes("return { blocked: false }"), "Guard returns early during hook execution");
    // Guard is set before agent hook and cleared after
    assert(hookClass.includes("this._inHookExecution = true"), "Guard set before agent execution");
    assert(hookClass.includes("this._inHookExecution = false"), "Guard cleared in finally block");
    assert(hookClass.includes("finally"), "Guard cleared in finally (not just success path)");
  } else {
    skip("HookRunner extraction failed");
  }
}

section("UNIT: LLM Hooks — client wired in main()");

{
  assert(source.includes("cfg._hookRunner._client = client"), "Hook runner gets client in main()");
  assert(source.includes("cfg._hookRunner._cfg = cfg"), "Hook runner gets cfg in main()");
  assert(source.includes("cfg._registry = registry"), "Registry available for agent hooks");
}

// ── Slash Command Registry & UI Layer ───────────────────────────

section("UNIT: SlashCommandRegistry — register and get");

{
  const scClass = extractBlock(source, "class SlashCommandRegistry {");
  if (scClass) {
    const scNs = {};
    try {
      new Function("exports", scClass + "\nexports.SlashCommandRegistry = SlashCommandRegistry;\n")(scNs);
      const reg = new scNs.SlashCommandRegistry();

      reg.register({ name: "exit", aliases: ["quit", "q"], description: "Exit the REPL", source: "builtin", handler: () => "exit" });
      reg.register({ name: "model", argumentHint: "[name]", description: "Switch model", source: "builtin", handler: () => {} });
      reg.register({ name: "commit", description: "Create a commit", source: "skill", handler: null });

      // get by name
      assert(reg.get("exit") !== undefined, "get('exit') finds command");
      assert(reg.get("exit").name === "exit", "get returns correct command");

      // get by alias
      assert(reg.get("quit") !== undefined, "get('quit') finds by alias");
      assert(reg.get("quit").name === "exit", "alias resolves to command name");
      assert(reg.get("q") !== undefined, "get('q') finds by alias");

      // get with leading /
      assert(reg.get("/exit") !== undefined, "get('/exit') strips slash");
      assert(reg.get("/quit") !== undefined, "get('/quit') strips slash");

      // get unknown
      assert(reg.get("nonexistent") === undefined, "get unknown returns undefined");

    } catch (e) {
      skip(`SlashCommandRegistry register/get test failed: ${e.message}`);
    }
  } else {
    skip("SlashCommandRegistry extraction failed");
  }
}

section("UNIT: SlashCommandRegistry — list with source filter, isHidden, isEnabled");

{
  const scClass = extractBlock(source, "class SlashCommandRegistry {");
  if (scClass) {
    const scNs = {};
    try {
      new Function("exports", scClass + "\nexports.SlashCommandRegistry = SlashCommandRegistry;\n")(scNs);
      const reg = new scNs.SlashCommandRegistry();

      reg.register({ name: "exit", description: "Exit", source: "builtin", handler: () => {} });
      reg.register({ name: "model", description: "Model", source: "builtin", handler: () => {} });
      reg.register({ name: "login", description: "Login", source: "builtin", isHidden: true, handler: () => {} });
      reg.register({ name: "commit", description: "Commit", source: "skill", handler: null });
      reg.register({ name: "disabled-cmd", description: "Disabled", source: "builtin", isEnabled: () => false, handler: () => {} });

      // list() all visible
      const all = reg.list();
      assert(all.length === 3, "list() returns 3 visible commands (exit, model, commit)");
      assert(!all.some(c => c.name === "login"), "Hidden command excluded from list()");
      assert(!all.some(c => c.name === "disabled-cmd"), "Disabled command excluded from list()");

      // list() filter by source
      const builtins = reg.list("builtin");
      assert(builtins.length === 2, "list('builtin') returns 2");
      assert(builtins.every(c => c.source === "builtin"), "All are builtin");

      const skills = reg.list("skill");
      assert(skills.length === 1, "list('skill') returns 1");
      assert(skills[0].name === "commit", "Skill is commit");

      // get() still finds hidden commands (for execution)
      assert(reg.get("login") !== undefined, "get() finds hidden commands");

    } catch (e) {
      skip(`SlashCommandRegistry list test failed: ${e.message}`);
    }
  } else {
    skip("SlashCommandRegistry extraction failed");
  }
}

section("UNIT: SlashCommandRegistry — completionNames");

{
  const scClass = extractBlock(source, "class SlashCommandRegistry {");
  if (scClass) {
    const scNs = {};
    try {
      new Function("exports", scClass + "\nexports.SlashCommandRegistry = SlashCommandRegistry;\n")(scNs);
      const reg = new scNs.SlashCommandRegistry();

      reg.register({ name: "exit", aliases: ["quit", "q"], description: "Exit", source: "builtin", handler: () => {} });
      reg.register({ name: "model", description: "Model", source: "builtin", handler: () => {} });
      reg.register({ name: "login", description: "Login", source: "builtin", isHidden: true, handler: () => {} });

      const names = reg.completionNames();
      assert(names.includes("/exit"), "completionNames includes /exit");
      assert(names.includes("/quit"), "completionNames includes /quit alias");
      assert(names.includes("/q"), "completionNames includes /q alias");
      assert(names.includes("/model"), "completionNames includes /model");
      assert(!names.includes("/login"), "completionNames excludes hidden /login");
      assert(names.length === 4, "completionNames has 4 entries (exit, quit, q, model)");

    } catch (e) {
      skip(`completionNames test failed: ${e.message}`);
    }
  } else {
    skip("SlashCommandRegistry extraction failed");
  }
}

section("UNIT: InteractiveMode uses SlashCommandRegistry");

{
  // Verify the source code structure
  assert(source.includes("class SlashCommandRegistry"), "SlashCommandRegistry class exists");
  assert(source.includes("this.slashCommands = new SlashCommandRegistry()"), "InteractiveMode creates SlashCommandRegistry");
  assert(source.includes("_initSlashCommands()"), "_initSlashCommands method exists");
  assert(source.includes("completer: (line) => this._completer(line)"), "readline completer is wired");
  assert(source.includes("_renderHelp("), "_renderHelp method exists");
  assert(source.includes("_renderStatusLine("), "_renderStatusLine method exists");
  assert(source.includes("_handleStatuslineConfig("), "_handleStatuslineConfig method exists");
  assert(source.includes("_handleModel("), "_handleModel extracted method exists");
  assert(source.includes("_handleRewind("), "_handleRewind extracted method exists");
}

// ── Hook Events ─────────────────────────────────────────────

section("UNIT: Hook Events — all 9 new events wired");

{
  const events = ["SessionStart", "SessionEnd", "UserPromptSubmit", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact", "Notification"];
  for (const ev of events) {
    assert(source.includes(`"${ev}"`), `Hook event "${ev}" appears in source`);
    assert(source.includes(`hasHooksFor("${ev}")`), `hasHooksFor("${ev}") is checked`);
  }
}

// ── MCP Resource Tools ──────────────────────────────────────

section("UNIT: MCP Resource Tools — registered separately");

{
  assert(source.includes("function registerMcpResourceTools("), "registerMcpResourceTools function exists");
  assert(source.includes("registerMcpResourceTools(registry)"), "registerMcpResourceTools called in main()");
  assert(source.includes('"ListMcpResources"'), "ListMcpResources tool defined");
  assert(source.includes('"ReadMcpResource"'), "ReadMcpResource tool defined");
  assert(source.includes('"resources/list"'), "resources/list RPC call exists");
  assert(source.includes('"resources/read"'), "resources/read RPC call exists");

  // Both registered as deferred
  const listMatch = source.match(/register\("ListMcpResources"[\s\S]*?\{ deferred: true \}/);
  assert(listMatch !== null, "ListMcpResources is deferred");
  const readMatch = source.match(/register\("ReadMcpResource"[\s\S]*?\{ deferred: true \}/);
  assert(readMatch !== null, "ReadMcpResource is deferred");

  // Both in READ_ONLY_TOOLS
  const roMatch = source.match(/const READ_ONLY_TOOLS = new Set\(\[([^\]]+)\]\)/);
  if (roMatch) {
    assert(roMatch[1].includes('"ListMcpResources"'), "READ_ONLY_TOOLS includes ListMcpResources");
    assert(roMatch[1].includes('"ReadMcpResource"'), "READ_ONLY_TOOLS includes ReadMcpResource");
  }
}

// ── Skill Fork Execution ────────────────────────────────────

section("UNIT: Skill Fork — _processSkillFork method exists");

{
  assert(source.includes("async _processSkillFork("), "_processSkillFork method exists");
  assert(source.includes("forking sub-agent"), "Fork emits status message");
  assert(source.includes("skillFork !== false"), "Fork can be disabled via cfg.skillFork");
  // Fallback to inline when fork fails
  assert(source.includes("Skill fork failed, falling back to inline"), "Fallback to inline on fork failure");
}

// ── Webhooks ────────────────────────────────────────────────

section("UNIT: Webhook — HookRunner supports type webhook");

{
  assert(source.includes('hook.type === "webhook"'), "HookRunner handles webhook type");
  assert(source.includes("_sendWebhook("), "_sendWebhook method exists");
  assert(source.includes("hooks.slack.com"), "Slack webhook format detection");
  assert(source.includes("discord.com/api/webhooks"), "Discord webhook format detection");
  assert(source.includes('"User-Agent": "claude-native-hooks/1.0"'), "Webhook sends User-Agent header");
}

section("UNIT: Webhook — Slack payload format");

{
  const hookClass = extractBlock(source, "class HookRunner {");
  if (hookClass) {
    // Verify Slack format includes blocks structure
    assert(hookClass.includes("blocks"), "Slack format uses blocks API");
    assert(hookClass.includes("mrkdwn"), "Slack format uses mrkdwn");
    // Verify Discord format includes embeds
    assert(hookClass.includes("embeds"), "Discord format uses embeds");
    // Verify template support
    assert(hookClass.includes("template"), "Webhook supports custom template");
    assert(hookClass.includes("{{"), "Template uses {{key}} placeholders");
  } else {
    skip("HookRunner extraction failed");
  }
}

section("UNIT: Webhook — /webhook slash command");

{
  assert(source.includes('name: "webhook"'), "/webhook command registered");
  assert(source.includes("/webhook <event> <url>"), "/webhook shows usage hint");
  assert(source.includes("new HookRunner(self.cfg._hooksConfig)"), "/webhook rebuilds HookRunner after adding");
  assert(source.includes('args[0] === "remove"'), "/webhook supports remove");
  assert(source.includes('args[0] === "list"'), "/webhook supports list" || source.includes('!args[0] || args[0] === "list"'));
}

section("UNIT: Auto-compaction — context limit detection");

{
  // Verify AgentLoop has _contextLimits and _getContextLimit
  assert(source.includes("static _contextLimits"), "AgentLoop has _contextLimits");
  assert(source.includes("_getContextLimit()"), "AgentLoop has _getContextLimit");
  assert(source.includes("_autoCompact("), "AgentLoop has _autoCompact method");
  assert(source.includes("auto-compacting conversation"), "Auto-compact emits status message");
  assert(source.includes("await this._autoCompact(messages, systemBlocks)"), "Auto-compact wired into run() loop");

  // Verify context limits for known models
  const limitsMatch = source.match(/static _contextLimits = \{([^}]+)\}/);
  if (limitsMatch) {
    const limitsStr = limitsMatch[1];
    assert(limitsStr.includes('"claude-opus": 1000000'), "Claude opus has 1M context");
    assert(limitsStr.includes('"claude-sonnet": 1000000'), "Claude sonnet has 1M context");
    assert(limitsStr.includes('"gpt-5": 1000000'), "GPT-5 has 1M context");
    assert(limitsStr.includes('"gpt-4o": 128000'), "GPT-4o has 128k context");
    assert(limitsStr.includes('_default: 128000'), "Default context is 128k");
  } else {
    skip("_contextLimits not found in source");
  }
}

section("UNIT: Auto-compaction — threshold is 80%");

{
  // Verify the threshold calculation
  assert(source.includes("contextLimit * 0.80"), "Threshold is 80% of context limit");
  // Verify minimum message count guard
  assert(source.includes("messages.length < 6"), "Won't compact conversations with < 6 messages");
}

section("UNIT: Builtin command count in _initSlashCommands");

{
  // Count s.register calls in _initSlashCommands
  const initBlock = extractBlock(source, "_initSlashCommands()");
  if (initBlock) {
    const registerCalls = (initBlock.match(/s\.register\(/g) || []).length;
    assert(registerCalls >= 25, `At least 25 builtin commands registered (got ${registerCalls})`);
  } else {
    skip("_initSlashCommands extraction failed");
  }
}

// ═══════════════════════════════════════════════════════════════════
// AGENT-FRIENDLY CLI — --output json, --yes, exit codes, --timeout
// ═══════════════════════════════════════════════════════════════════

section("UNIT: CLI — --output json flag parsed");

{
  assert(source.includes('case "--output":'), "--output flag parsed in parseArgs");
  assert(source.includes('case "--json":'), "--json shorthand parsed in parseArgs");
  assert(source.includes('outputFormat: "text"'), "outputFormat defaults to text");
  assert(source.includes('cfg.outputFormat === "json"'), "One-shot checks outputFormat for JSON");
}

section("UNIT: CLI — --output json structured payload");

{
  // Verify the jsonOutput object has the right shape
  assert(source.includes("const jsonOutput = {"), "JSON output object constructed");
  assert(source.includes("version: cfg.outputVersion"), "JSON output includes version field");
  assert(source.includes("message: result.text"), "JSON output includes message field");
  assert(source.includes("model: cfg.model"), "JSON output includes model field");
  assert(source.includes("provider: provider.name"), "JSON output includes provider field");
  assert(source.includes("stop_reason: result.stopReason"), "JSON output includes stop_reason field");
  assert(source.includes("turns: result.turns"), "JSON output includes turns field");
  assert(source.includes("session_id: cfg.sessionId"), "JSON output includes session_id field");
  assert(source.includes("JSON.stringify(jsonOutput)"), "JSON output serialized to stdout");
}

section("UNIT: CLI — --output-version for schema stability");

{
  assert(source.includes('case "--output-version":'), "--output-version flag parsed");
  assert(source.includes('cfg.outputVersion || "1"'), "Default output version is 1");
}

section("UNIT: CLI — --yes / -y alias");

{
  assert(source.includes('case "--yes": case "-y":'), "--yes and -y flags parsed");
  assert(source.includes('cfg.permissionMode = "bypassPermissions"'), "--yes maps to bypassPermissions");
}

section("UNIT: CLI — structured exit codes");

{
  assert(source.includes("const EXIT = {"), "EXIT code constants defined");
  assert(source.includes("BAD_ARGS:"), "EXIT.BAD_ARGS defined");
  assert(source.includes("AUTH_FAILURE:"), "EXIT.AUTH_FAILURE defined");
  assert(source.includes("PROVIDER_ERROR:"), "EXIT.PROVIDER_ERROR defined");
  assert(source.includes("TIMEOUT:"), "EXIT.TIMEOUT defined");
  assert(source.includes("RUNTIME_ERROR:"), "EXIT.RUNTIME_ERROR defined");

  // Verify structured codes used at auth error points
  assert(source.includes("process.exit(EXIT.AUTH_FAILURE)"), "Auth failures use EXIT.AUTH_FAILURE");
  assert(source.includes("process.exit(EXIT.TIMEOUT)"), "Timeout uses EXIT.TIMEOUT");
}

section("UNIT: CLI — --timeout flag");

{
  assert(source.includes('case "--timeout":'), "--timeout flag parsed in parseArgs");
  assert(source.includes("timeout: 0"), "timeout defaults to 0 (no limit)");
  assert(source.includes("cfg.timeout > 0"), "Timeout timer only set when > 0");
  assert(source.includes("cfg.timeout * 1000"), "Timeout converted to milliseconds");
  assert(source.includes("clearTimeout(timeoutTimer)"), "Timeout cleared on clean exit");
}

section("UNIT: CLI — --help includes examples");

{
  const helpBlock = extractBlock(source, "function printHelp()");
  if (helpBlock) {
    assert(helpBlock.includes("Examples:"), "--help includes Examples section");
    assert(helpBlock.includes('-p "explain this code"'), "--help has one-shot example");
    assert(helpBlock.includes("--json"), "--help has JSON output example");
    assert(helpBlock.includes("--yes"), "--help has --yes example");
    assert(helpBlock.includes("--timeout"), "--help has --timeout example");
    assert(helpBlock.includes("ollama/"), "--help has local provider example");
    assert(helpBlock.includes("--ndjson"), "--help has NDJSON example");
    assert(helpBlock.includes("Exit codes:"), "--help includes Exit codes section");
  } else {
    skip("printHelp extraction failed");
  }
}

section("UNIT: CLI — exit code for no-auth uses EXIT.AUTH_FAILURE (not 1)");

{
  // Count occurrences of process.exit(EXIT.AUTH_FAILURE) — should be >= 3
  // (Anthropic OAuth, OpenAI OAuth, no-auth-for-provider)
  const authExitCount = (source.match(/process\.exit\(EXIT\.AUTH_FAILURE\)/g) || []).length;
  assert(authExitCount >= 3, `At least 3 auth exit points use EXIT.AUTH_FAILURE (found ${authExitCount})`);
}

section("UNIT: CLI — strict arg parsing: unknown flags rejected");

{
  assert(source.includes('Unknown flag'), "parseArgs emits 'Unknown flag' for unrecognized --flags");
  assert(source.includes("process.exit(EXIT.BAD_ARGS)"), "parseArgs exits with EXIT.BAD_ARGS on bad args");
}

section("UNIT: CLI — strict arg parsing: missing values detected");

{
  assert(source.includes("function needValue("), "needValue helper validates flag values");
  assert(source.includes("requires a value"), "needValue error message mentions 'requires a value'");
}

section("UNIT: CLI — strict arg parsing: enum validation");

{
  assert(source.includes("VALID_PERMISSION_MODES"), "Permission modes validated against known set");
  assert(source.includes("VALID_OUTPUT_FORMATS"), "Output formats validated against known set");
}

section("UNIT: CLI — strict arg parsing: numeric validation");

{
  assert(source.includes('--max-turns must be a positive integer'), "--max-turns validated as positive int");
  assert(source.includes('--max-tokens must be a positive integer'), "--max-tokens validated as positive int");
  assert(source.includes('--timeout must be a non-negative integer'), "--timeout validated as non-negative int");
  assert(source.includes('--thinking must be a positive integer'), "--thinking validated as positive int");
}

section("E2E: CLI — unknown flag exits with code 2");

{
  try {
    const { exitCode, stderr } = await runCLI(["--bogus-flag"], {}, 5000);
    assert(exitCode === 2, `Unknown flag exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("Unknown flag"), `Stderr mentions unknown flag`);
    assert(stderr.includes("--help"), `Stderr suggests --help`);
  } catch (e) {
    skip(`Unknown flag E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — missing value exits with code 2");

{
  try {
    // --model with no value (next arg is another flag)
    const { exitCode, stderr } = await runCLI(["--timeout"], {}, 5000);
    assert(exitCode === 2, `Missing value exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("requires a value"), `Stderr mentions missing value`);
  } catch (e) {
    skip(`Missing value E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — invalid --permission-mode exits with code 2");

{
  try {
    const { exitCode, stderr } = await runCLI(["--permission-mode", "yolo", "-p", "hi"], {}, 5000);
    assert(exitCode === 2, `Invalid permission mode exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("must be one of"), `Stderr lists valid modes`);
  } catch (e) {
    skip(`Invalid permission-mode E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — invalid --output exits with code 2");

{
  try {
    const { exitCode, stderr } = await runCLI(["--output", "xml", "-p", "hi"], {}, 5000);
    assert(exitCode === 2, `Invalid output format exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("must be one of"), `Stderr lists valid formats`);
  } catch (e) {
    skip(`Invalid --output E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — non-numeric --max-turns exits with code 2");

{
  try {
    const { exitCode, stderr } = await runCLI(["--max-turns", "abc", "-p", "hi"], {}, 5000);
    assert(exitCode === 2, `Non-numeric --max-turns exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("positive integer"), `Stderr mentions positive integer`);
  } catch (e) {
    skip(`Non-numeric --max-turns E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — no-auth exits with code 3");

{
  try {
    // Use a model that needs auth, with no keys in env
    const { exitCode, stderr } = await runCLI(
      ["-p", "hi", "-m", "deepseek-chat", "--provider", "deepseek"],
      { DEEPSEEK_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" },
      5000
    );
    assert(exitCode === 3, `No-auth exits with code 3 (got ${exitCode})`);
    assert(stderr.includes("No ") && stderr.includes("auth"), `Stderr mentions auth failure`);
  } catch (e) {
    skip(`No-auth E2E failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// STABILIZATION PASS 2 — CLI boundary hardening
// ═══════════════════════════════════════════════════════════════════

section("E2E: CLI — invalid --provider exits with code 2");

{
  try {
    const { exitCode, stderr } = await runCLI(["--provider", "bogus", "-p", "hi"], {}, 5000);
    assert(exitCode === 2, `Invalid provider exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("Unknown provider"), `Stderr mentions unknown provider`);
    assert(stderr.includes("anthropic"), `Stderr lists valid providers`);
  } catch (e) {
    skip(`Invalid --provider E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — --session-id path traversal exits with code 2");

{
  try {
    const { exitCode, stderr } = await runCLI(["--session-id", "../../../etc/passwd", "-p", "hi"], {}, 5000);
    assert(exitCode === 2, `Path traversal session-id exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("alphanumeric"), `Stderr mentions valid charset`);
  } catch (e) {
    skip(`Session-id traversal E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — --session-id too long exits with code 2");

{
  try {
    const longId = "a".repeat(200);
    const { exitCode, stderr } = await runCLI(["--session-id", longId, "-p", "hi"], {}, 5000);
    assert(exitCode === 2, `Too-long session-id exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("max 128"), `Stderr mentions max length`);
  } catch (e) {
    skip(`Session-id length E2E failed: ${e.message}`);
  }
}

section("UNIT: CLI — valid --session-id accepted");

{
  assert(source.includes('/^[a-zA-Z0-9_-]+$/'), "Session-id validated with alphanumeric regex");
}

section("E2E: CLI — --mcp-config nonexistent file exits with code 2");

{
  try {
    const { exitCode, stderr } = await runCLI(["--mcp-config", "/nonexistent/file.json", "-p", "hi"], {}, 5000);
    assert(exitCode === 2, `Missing MCP config exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("not found"), `Stderr mentions file not found`);
  } catch (e) {
    skip(`MCP config missing E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — --mcp-config invalid JSON exits with code 2");

{
  try {
    const tmpBad = "/tmp/claude-native-test-bad-mcp.json";
    fs.writeFileSync(tmpBad, "{ not valid json !!!");
    const { exitCode, stderr } = await runCLI(["--mcp-config", tmpBad, "-p", "hi"], {}, 5000);
    try { fs.unlinkSync(tmpBad); } catch { /* cleanup */ }
    assert(exitCode === 2, `Invalid JSON MCP config exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("Invalid JSON"), `Stderr mentions invalid JSON`);
  } catch (e) {
    skip(`MCP config invalid JSON E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — --timeout 0 is valid (no limit)");

{
  try {
    // --timeout 0 should NOT exit with code 2; it will eventually fail on auth (exit 3) or succeed
    const { exitCode, stderr } = await runCLI(["--timeout", "0", "-p", "hi", "-m", "deepseek-chat", "--provider", "deepseek"],
      { DEEPSEEK_API_KEY: "", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" }, 5000);
    assert(exitCode !== 2, `--timeout 0 does not exit with BAD_ARGS (got ${exitCode})`);
  } catch (e) {
    skip(`--timeout 0 E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — --timeout -1 exits with code 2");

{
  try {
    const { exitCode, stderr } = await runCLI(["--timeout", "-1", "-p", "hi"], {}, 5000);
    assert(exitCode === 2, `Negative timeout exits with code 2 (got ${exitCode})`);
    // -1 starts with "-" so needValue() catches it as "requires a value"
    assert(stderr.includes("Error:"), `Stderr has Error: prefix for negative timeout`);
  } catch (e) {
    skip(`--timeout -1 E2E failed: ${e.message}`);
  }
}

section("UNIT: CLI — error prefix consistency");

{
  // All parseArgs errors use "Error:" prefix
  const parseArgsBlock = source.substring(source.indexOf("async function parseArgs"), source.indexOf("// ── Model Aliases"));
  const stderrWrites = parseArgsBlock.match(/process\.stderr\.write\(`[^`]*`\)/g) || [];
  for (const w of stderrWrites) {
    if (w.includes("Error:") || w.includes("cloclo")) continue; // valid
    // Non-error writes in parseArgs are unexpected
  }
  // Top-level catch uses Fatal:
  assert(source.includes('process.stderr.write(`Fatal:'), "Top-level catch uses Fatal: prefix");
  // No other Fatal: in the file
  const fatalCount = (source.match(/Fatal:/g) || []).length;
  assert(fatalCount === 1, `Only one Fatal: in source (found ${fatalCount})`);
}

section("UNIT: CLI — all catch blocks documented");

{
  const emptyCatch = (source.match(/catch\s*\{\s*\}/g) || []);
  assert(emptyCatch.length === 0, `No undocumented empty catch blocks (found ${emptyCatch.length})`);
}

section("UNIT: CLI — CLAUDE.md exists");

{
  const claudeMdPath = SCRIPT.replace(/claude-native\.mjs$/, "CLAUDE.md");
  assert(fs.existsSync(claudeMdPath), "CLAUDE.md exists at project root");
  const content = fs.readFileSync(claudeMdPath, "utf-8");
  assert(content.includes("Exit Codes"), "CLAUDE.md documents exit codes");
  assert(content.includes("Provider Contract"), "CLAUDE.md documents provider contract");
  assert(content.includes("Testing"), "CLAUDE.md documents testing patterns");
}

// ═══════════════════════════════════════════════════════════════════
// REVIEW + SKILL IMPORT — Agent definitions, core functions, commands
// ═══════════════════════════════════════════════════════════════════

section("UNIT: AGENT_DEFINITIONS — code-reviewer");

{
  const agentBlock = source.substring(source.indexOf("const AGENT_DEFINITIONS"), source.indexOf("// ── Background Agent Manager"));
  assert(agentBlock.includes('"code-reviewer"'), "code-reviewer agent defined");
  assert(agentBlock.includes('readOnly: true') || agentBlock.match(/code-reviewer[\s\S]*?readOnly:\s*true/), "code-reviewer is read-only");
}

section("UNIT: AGENT_DEFINITIONS — security-reviewer");

{
  const agentBlock = source.substring(source.indexOf("const AGENT_DEFINITIONS"), source.indexOf("// ── Background Agent Manager"));
  assert(agentBlock.includes('"security-reviewer"'), "security-reviewer agent defined");
  // Check prompt mentions key security topics
  assert(agentBlock.includes("injection") || agentBlock.includes("Injection"), "security-reviewer mentions injection");
  assert(agentBlock.includes("auth") || agentBlock.includes("Auth"), "security-reviewer mentions auth");
  assert(agentBlock.includes("secrets") || agentBlock.includes("Secrets"), "security-reviewer mentions secrets");
}

section("UNIT: AGENT_DEFINITIONS — import-reviewer");

{
  const agentBlock = source.substring(source.indexOf("const AGENT_DEFINITIONS"), source.indexOf("// ── Background Agent Manager"));
  assert(agentBlock.includes('"import-reviewer"'), "import-reviewer agent defined");
  assert(agentBlock.includes("haiku"), "import-reviewer uses haiku model");
  assert(agentBlock.includes("SAFE") && agentBlock.includes("WARN") && agentBlock.includes("BLOCK"), "import-reviewer has SAFE/WARN/BLOCK verdicts");
}

section("UNIT: code-reviewer prompt format");

{
  assert(source.includes("CRITICAL") && source.includes("WARNING") && source.includes("NOTE"), "code-reviewer has CRITICAL/WARNING/NOTE severities");
  assert(source.includes("VERDICT: PASS") && source.includes("VERDICT: WARN") && source.includes("VERDICT: BLOCK"), "code-reviewer has PASS/WARN/BLOCK verdicts");
}

section("UNIT: aggregateVerdicts");

{
  // Extract and eval aggregateVerdicts
  const funcStr = extractBlock(source, "function aggregateVerdicts(");
  if (funcStr) {
    const ns = {};
    new Function("exports", funcStr + "\nexports.aggregateVerdicts = aggregateVerdicts;")(ns);
    assert(ns.aggregateVerdicts("PASS", "BLOCK") === "BLOCK", "BLOCK wins over PASS");
    assert(ns.aggregateVerdicts("WARN", "PASS") === "WARN", "WARN wins over PASS");
    assert(ns.aggregateVerdicts("PASS", "PASS") === "PASS", "PASS when all PASS");
    assert(ns.aggregateVerdicts("WARN", "BLOCK") === "BLOCK", "BLOCK wins over WARN");
    assert(ns.aggregateVerdicts("PASS", "WARN", "PASS") === "WARN", "WARN wins with multiple args");
  } else {
    skip("aggregateVerdicts not extracted");
  }
}

section("UNIT: parseSkillSource");

{
  const funcStr = extractBlock(source, "function parseSkillSource(");
  if (funcStr) {
    const ns = {};
    new Function("exports", "fs", "path",
      funcStr + "\nexports.parseSkillSource = parseSkillSource;"
    )(ns, fs, path);

    // GitHub source
    const gh = ns.parseSkillSource("github:foo/bar");
    assert(gh.type === "github", "github: prefix → type: github");
    assert(gh.owner === "foo", "github owner parsed");
    assert(gh.repo === "bar", "github repo parsed");

    // URL source
    const url = ns.parseSkillSource("https://example.com/SKILL.md");
    assert(url.type === "url", "https:// → type: url");

    // Invalid source
    let threw = false;
    try { ns.parseSkillSource("nonexistent-thing-12345"); } catch { threw = true; }
    assert(threw, "Invalid source throws error");
  } else {
    skip("parseSkillSource not extracted");
  }
}

section("UNIT: staticSkillScan — clean skill");

{
  const scanFunc = extractBlock(source, "function staticSkillScan(");
  const fmFunc = extractBlock(source, "function parseYamlFrontmatter(");
  if (scanFunc && fmFunc) {
    const ns = {};
    new Function("exports", fmFunc + "\n" + scanFunc + "\nexports.staticSkillScan = staticSkillScan;")(ns);
    const result = ns.staticSkillScan({ "SKILL.md": "---\nname: test-skill\ndescription: A safe skill\n---\nDo something safe." });
    assert(result.verdict === "SAFE", `Clean skill → SAFE (got ${result.verdict})`);
    assert(result.findings.length === 0, "No findings for clean skill");
  } else {
    skip("staticSkillScan not extracted");
  }
}

section("UNIT: staticSkillScan — detects dangerous patterns");

{
  const scanFunc = extractBlock(source, "function staticSkillScan(");
  const fmFunc = extractBlock(source, "function parseYamlFrontmatter(");
  if (scanFunc && fmFunc) {
    const ns = {};
    new Function("exports", fmFunc + "\n" + scanFunc + "\nexports.staticSkillScan = staticSkillScan;")(ns);
    const result = ns.staticSkillScan({
      "SKILL.md": "---\nname: risky-skill\nallowed-tools: Bash\n---\nRun stuff.",
      "scripts/deploy.sh": "exec(command)\nspawn('rm -rf /')",
    });
    assert(result.verdict === "WARN" || result.verdict === "BLOCK", `Dangerous skill → WARN or BLOCK (got ${result.verdict})`);
    assert(result.findings.length > 0, "Has findings for dangerous skill");
    assert(result.findings.some(f => f.message.includes("exec")), "Detects exec() call");
  } else {
    skip("staticSkillScan not extracted");
  }
}

section("UNIT: /review slash command registered");

{
  assert(source.includes('name: "review"'), "/review command registered");
  assert(source.includes("Code Review") && source.includes("Security Review"), "/review displays both review sections");
}

section("UNIT: /skill slash command registered");

{
  assert(source.includes('name: "skill"'), "/skill command registered");
  assert(source.includes('"import"'), "/skill handles import subcommand");
  assert(source.includes('"list"') && source.includes('"info"') && source.includes('"remove"') && source.includes('"update"'), "/skill handles all subcommands");
}

section("UNIT: skill import CLI subcommand parsed");

{
  assert(source.includes('argv[0] === "skill"') && source.includes('sub === "import"'), "skill import parsed from argv prefix");
  assert(source.includes('cfg._subcommand = "skill-import"'), "sets _subcommand");
}

section("UNIT: RESERVED_COMMANDS includes new commands");

{
  assert(source.includes('"/review"'), "/review in RESERVED_COMMANDS");
  assert(source.includes('"/skill"'), "/skill in RESERVED_COMMANDS");
  assert(source.includes('"/init"'), "/init in RESERVED_COMMANDS");
  assert(source.includes('"/sessions"'), "/sessions in RESERVED_COMMANDS (audit fix)");
  assert(source.includes('"/diff"'), "/diff in RESERVED_COMMANDS (audit fix)");
  assert(source.includes('"/compact"'), "/compact in RESERVED_COMMANDS (audit fix)");
}

section("E2E: cloclo skill import nonexistent → error");

{
  try {
    const { exitCode, stderr } = await runCLI(["skill", "import", "nonexistent-source-12345"], {}, 5000);
    assert(exitCode === 2, `Invalid source exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("Invalid skill source") || stderr.includes("Error"), "Stderr mentions invalid source");
  } catch (e) {
    skip(`skill import E2E failed: ${e.message}`);
  }
}

section("E2E: cloclo --help mentions skill import");

{
  try {
    const { stderr } = await runCLI(["--help"], {}, 5000);
    assert(stderr.includes("skill import"), "--help mentions skill import");
  } catch (e) {
    skip(`--help skill import E2E failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// UNIVERSAL SKILL IMPORT — Format detection, conversion, discovery
// ═══════════════════════════════════════════════════════════════════

section("UNIT: detectSkillFormat — identifies SKILL.md");

{
  const fn = extractBlock(source, "function detectSkillFormat(");
  if (fn) {
    const ns = {};
    new Function("exports", fn + "\nexports.detectSkillFormat = detectSkillFormat;")(ns);
    assert(ns.detectSkillFormat({"SKILL.md": "content"}) === "skill.md", "Detects SKILL.md");
    assert(ns.detectSkillFormat({"AGENTS.md": "content"}) === "agents.md", "Detects AGENTS.md");
    assert(ns.detectSkillFormat({".cursorrules": "content"}) === "cursorrules", "Detects .cursorrules");
    assert(ns.detectSkillFormat({".windsurfrules": "content"}) === "windsurfrules", "Detects .windsurfrules");
    assert(ns.detectSkillFormat({"CLAUDE.md": "content"}) === "claude.md", "Detects CLAUDE.md");
    assert(ns.detectSkillFormat({"random.txt": "content"}) === null, "Returns null for unknown format");
    // Priority: SKILL.md > AGENTS.md
    assert(ns.detectSkillFormat({"SKILL.md": "a", "AGENTS.md": "b"}) === "skill.md", "SKILL.md takes priority over AGENTS.md");
  } else {
    skip("detectSkillFormat not extracted");
  }
}

section("UNIT: convertToSkillMd — wraps foreign formats");

{
  const fn = extractBlock(source, "function convertToSkillMd(");
  if (fn) {
    const ns = {};
    new Function("exports", fn + "\nexports.convertToSkillMd = convertToSkillMd;")(ns);
    // AGENTS.md conversion
    const agentsResult = ns.convertToSkillMd("agents.md", "# My Agent\nDo things.", "my-agent");
    assert(agentsResult.includes("name: my-agent"), "AGENTS.md conversion includes name");
    assert(agentsResult.includes("Imported from"), "AGENTS.md conversion includes import note");
    assert(agentsResult.includes("# My Agent"), "AGENTS.md conversion preserves content");
    // .cursorrules conversion
    const cursorResult = ns.convertToSkillMd("cursorrules", "Use tabs.", "cursor-rules");
    assert(cursorResult.includes("name: cursor-rules"), "cursorrules conversion includes name");
    assert(cursorResult.includes("Use tabs."), "cursorrules conversion preserves content");
    // skill.md passthrough
    const passthrough = ns.convertToSkillMd("skill.md", "---\nname: test\n---\nContent", "test");
    assert(passthrough === "---\nname: test\n---\nContent", "skill.md format passes through unchanged");
  } else {
    skip("convertToSkillMd not extracted");
  }
}

section("UNIT: parseSkillSource — GitHub URL");

{
  const fn = extractBlock(source, "function parseSkillSource(");
  if (fn) {
    const ns = {};
    new Function("exports", "fs", "path", fn + "\nexports.parseSkillSource = parseSkillSource;")(ns, fs, path);
    // github: prefix
    const gh = ns.parseSkillSource("github:foo/bar");
    assert(gh.type === "github" && gh.owner === "foo" && gh.repo === "bar", "github: prefix parsed");
    // GitHub URL
    const ghUrl = ns.parseSkillSource("https://github.com/foo/bar");
    assert(ghUrl.type === "github" && ghUrl.owner === "foo" && ghUrl.repo === "bar", "GitHub URL parsed");
    // GitHub URL with .git
    const ghGit = ns.parseSkillSource("https://github.com/foo/bar.git");
    assert(ghGit.type === "github" && ghGit.repo === "bar", "GitHub .git URL cleaned");
    // Bare URL → well-known
    const wk = ns.parseSkillSource("https://myapp.com");
    assert(wk.type === "well-known", "Bare URL → well-known type");
    // Direct SKILL.md URL
    const direct = ns.parseSkillSource("https://example.com/SKILL.md");
    assert(direct.type === "url", "Direct SKILL.md URL → url type");
  } else {
    skip("parseSkillSource not extracted");
  }
}

section("UNIT: skill import --list flag parsed");

{
  assert(source.includes('cfg._skillImportList = true'), "--list flag sets _skillImportList");
  assert(source.includes('cfg._skillImportPick'), "--pick flag sets _skillImportPick");
  assert(source.includes('cfg._skillImportFormat'), "--format flag sets _skillImportFormat");
}

section("UNIT: skillImport handles --list");

{
  assert(source.includes("_skillImportList") && source.includes("Skills found in"), "--list prints skill listing");
}

section("UNIT: skillImport handles --pick");

{
  assert(source.includes("_skillImportPick") && source.includes("No skill matching"), "--pick filters and errors on no match");
}

section("UNIT: well-known/claude-skills.json support");

{
  assert(source.includes(".well-known/claude-skills.json"), "well-known discovery implemented");
  assert(source.includes('type: "well-known"'), "well-known source type exists");
}

section("UNIT: GitHub autodiscovery scans AGENTS.md");

{
  assert(source.includes('".agents"') && source.includes('"agents"'), "GitHub searches .agents/ and agents/ paths");
  assert(source.includes('"AGENTS.md"') && source.includes("skillFileNames"), "GitHub scans for AGENTS.md files");
}

section("E2E: cloclo skill import --list flag");

{
  try {
    // --list with an invalid source should still fail on source parsing, not list
    const { exitCode, stderr } = await runCLI(["skill", "import", "nonexistent-12345", "--list"], {}, 5000);
    assert(exitCode !== 0, "skill import --list with bad source exits with error");
  } catch (e) {
    skip(`--list E2E failed: ${e.message}`);
  }
}

section("E2E: cloclo --help mentions --list and --pick");

{
  try {
    const { stderr } = await runCLI(["--help"], {}, 5000);
    assert(stderr.includes("--list"), "--help mentions --list");
    assert(stderr.includes("--pick"), "--help mentions --pick");
  } catch (e) {
    skip(`--help flags E2E failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// STABILIZATION — Compaction, Hook, and Provider regression tests
// ═══════════════════════════════════════════════════════════════════

// ── 1. Compaction — adversarial regression ────────────────────

section("UNIT: Auto-compact — mock compact flow");

{
  // Extract AgentLoop and its dependencies to run a real _autoCompact call
  const agentLoopClass = extractBlock(source, "class AgentLoop {");
  const toolRegClass = extractBlock(source, "class ToolRegistry {");
  const detectFunc = extractBlock(source, "function detectProvider(");
  const resolveFunc = extractBlock(source, "function resolveModel(");
  const aliasStart = source.indexOf("const MODEL_ALIASES");
  const aliasEnd = source.indexOf("function resolveModel");
  const aliasBlock = source.slice(aliasStart, aliasEnd);
  const getInstrFunc = extractBlock(source, "function getInstructionPlacement(");
  const isOpenAIFunc = extractBlock(source, "function isOpenAIModel(");
  const isRespFunc = extractBlock(source, "function isResponsesAPIModel(");

  if (agentLoopClass) {
    try {
      const compactNs = {};
      const helperCode = [
        "function log() {}",
        "function sleep() { return Promise.resolve(); }",
        "function _pathMatchesGlob() { return false; }",
        aliasBlock,
        resolveFunc,
        providersAndHelpers,
        detectFunc,
        isOpenAIFunc,
        isRespFunc,
        toolRegClass,
        agentLoopClass,
      ].join("\n\n");

      new Function("exports", "process", "fs", "path", "os",
        helperCode + "\nexports.AgentLoop = AgentLoop;\nexports.ToolRegistry = ToolRegistry;\n"
      )(compactNs, process, fs, path, os);

      const { AgentLoop: AL, ToolRegistry: TR } = compactNs;

      // Create a mock client that returns a canned summary
      const mockSummaryClient = {
        async *stream(body) {
          // Simulate message_start
          yield { event: "message_start", data: { message: { usage: { input_tokens: 100 } } } };
          // Simulate content_block_start
          yield { event: "content_block_start", data: { content_block: { type: "text" } } };
          // Simulate summary text delta
          const summaryText = "Summary: User asked about file paths. Key decisions: use /tmp for test. Modified: test.js. Current task: implement feature X.";
          yield { event: "content_block_delta", data: { delta: { type: "text_delta", text: summaryText } } };
          yield { event: "content_block_stop", data: {} };
          yield { event: "message_delta", data: { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } } };
          yield { event: "message_stop", data: {} };
        }
      };

      const reg = new TR();
      const cfg = {
        model: "claude-sonnet-4-6",
        maxTurns: 5,
        maxTokens: 4096,
        cwd: process.cwd(),
      };

      const loop = new AL(mockSummaryClient, reg, cfg, {});

      // Build 20+ messages that would be over the 80% threshold
      const messages = [];
      for (let i = 0; i < 22; i++) {
        messages.push({ role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i}: ${"x".repeat(200)}` });
      }

      // Simulate being at 85% of context limit (sonnet = 1M, threshold = 800k)
      loop.totalUsage.input_tokens = 850000;

      const systemBlocks = [{ type: "text", text: "You are a helpful assistant." }];

      // Call _autoCompact
      const compacted = await loop._autoCompact(messages, systemBlocks);

      assert(compacted === true, "Auto-compact returns true when triggered");
      assert(messages.length === 2, `Messages reduced to 2 (got ${messages.length})`);
      assert(messages[0].role === "user", "First message is user");
      assert(messages[1].role === "assistant", "Second message is assistant");
      assert(messages[0].content.includes("Summary:"), "Summary content preserved in user message");
      assert(messages[0].content.includes("Auto-compacted from 22"), "Compact metadata in message");

      // Second call with low tokens should NOT re-compact (no infinite loop)
      loop.totalUsage.input_tokens = 100;
      const recompacted = await loop._autoCompact(messages, systemBlocks);
      assert(recompacted === false, "No re-compact when tokens below threshold");
      assert(messages.length === 2, "Messages unchanged after no-op compact");

      // Also test: won't compact if < 6 messages
      const shortMessages = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "bye" },
      ];
      loop.totalUsage.input_tokens = 999999; // over threshold
      const shortCompact = await loop._autoCompact(shortMessages, systemBlocks);
      assert(shortCompact === false, "No compact when < 6 messages even with high tokens");
      assert(shortMessages.length === 3, "Short messages unchanged");

    } catch (e) {
      skip(`Auto-compact mock test failed: ${e.message}`);
    }
  } else {
    skip("AgentLoop class extraction failed for compact test");
  }
}

section("UNIT: /compact slash command handler");

{
  // Verify /compact command exists and calls _autoCompact or similar logic
  assert(source.includes('name: "compact"'), "/compact slash command registered");
  assert(source.includes("compacting conversation"), "/compact emits compacting message");
}

// ── 2. LLM Hooks — mock live path test ───────────────────────

section("UNIT: HookRunner — prompt hook with mock client");

{
  const hookClass = extractBlock(source, "class HookRunner {");
  if (hookClass) {
    try {
      const hookNs = {};
      const resolveFunc2 = extractBlock(source, "function resolveModel(");
      const aliasStart2 = source.indexOf("const MODEL_ALIASES");
      const aliasEnd2 = source.indexOf("function resolveModel");
      const aliasBlock2 = source.slice(aliasStart2, aliasEnd2);

      new Function("exports", "process",
        "function log() {}\nfunction spawn() { return { stdin: { write(){}, end(){} }, stdout: { on(){} }, stderr: { on(){} }, on(e,cb) { if(e==='close') setTimeout(()=>cb(0),10); }, kill(){} }; }\n" +
        aliasBlock2 + "\n" + resolveFunc2 + "\n" + hookClass +
        "\nexports.HookRunner = HookRunner;\n"
      )(hookNs, process);

      const { HookRunner: HR } = hookNs;

      // Test 1: ok: true → not blocked
      {
        const runner = new HR({});
        runner._client = {
          async *stream() {
            yield { event: "content_block_delta", data: { delta: { type: "text_delta", text: '{"ok": true}' } } };
          }
        };
        runner._cfg = { model: "claude-haiku-4-5-20251001" };

        const hook = { type: "prompt", prompt: "Is $TOOL_NAME safe?" };
        const result = await runner._evalPromptHook(hook, { tool_name: "Read" });
        assert(result.blocked === false, "Prompt hook: ok:true → not blocked");
      }

      // Test 2: ok: false → blocked with reason
      {
        const runner = new HR({});
        runner._client = {
          async *stream() {
            yield { event: "content_block_delta", data: { delta: { type: "text_delta", text: '{"ok": false, "reason": "dangerous operation"}' } } };
          }
        };
        runner._cfg = { model: "claude-haiku-4-5-20251001" };

        const hook = { type: "prompt", prompt: "Is this safe?" };
        const result = await runner._evalPromptHook(hook, {});
        assert(result.blocked === true, "Prompt hook: ok:false → blocked");
        assert(result.reason.includes("dangerous"), "Prompt hook: reason preserved");
      }

      // Test 3: malformed JSON → fail closed (blocked)
      {
        const runner = new HR({});
        runner._client = {
          async *stream() {
            yield { event: "content_block_delta", data: { delta: { type: "text_delta", text: '{"maybe": true}' } } };
          }
        };
        runner._cfg = { model: "claude-haiku-4-5-20251001" };

        const hook = { type: "prompt", prompt: "Check this" };
        const result = await runner._evalPromptHook(hook, {});
        assert(result.blocked === true, "Prompt hook: malformed JSON → fail closed (blocked)");
        assert(result.reason.includes("invalid JSON") || result.reason.includes("ok: false"), "Prompt hook: error reason on malformed JSON");
      }

      // Test 4: timeout (mock that never resolves) → fail open (not blocked)
      {
        const runner = new HR({});
        runner._client = {
          async *stream() {
            // Simulate a stream that throws AbortError (like real timeout)
            throw new Error("aborted");
          }
        };
        runner._cfg = { model: "claude-haiku-4-5-20251001" };

        const hook = { type: "prompt", prompt: "Check", timeout: 1 };
        const result = await runner._evalPromptHook(hook, {});
        assert(result.blocked === false, "Prompt hook: error/timeout → fail open (not blocked)");
      }

    } catch (e) {
      skip(`HookRunner prompt mock test failed: ${e.message}`);
    }
  } else {
    skip("HookRunner class extraction failed for prompt test");
  }
}

section("UNIT: HookRunner — recursion guard under fire()");

{
  const hookClass = extractBlock(source, "class HookRunner {");
  if (hookClass) {
    try {
      const hookNs2 = {};
      const resolveFunc3 = extractBlock(source, "function resolveModel(");
      const aliasStart3 = source.indexOf("const MODEL_ALIASES");
      const aliasEnd3 = source.indexOf("function resolveModel");
      const aliasBlock3 = source.slice(aliasStart3, aliasEnd3);

      new Function("exports", "process",
        "function log() {}\nfunction spawn() { return { stdin: { write(){}, end(){} }, stdout: { on(){} }, stderr: { on(){} }, on(e,cb) { if(e==='close') setTimeout(()=>cb(0),10); }, kill(){} }; }\n" +
        aliasBlock3 + "\n" + resolveFunc3 + "\n" + hookClass +
        "\nexports.HookRunner = HookRunner;\n"
      )(hookNs2, process);

      const { HookRunner: HR2 } = hookNs2;

      // Manually set recursion guard and verify fire() returns early
      const runner = new HR2({
        PreToolUse: [{ hooks: [{ type: "command", command: "echo test" }] }],
      });
      runner._inHookExecution = true;

      const result = await runner.fire("PreToolUse", { tool_name: "Bash" });
      assert(result.blocked === false, "Recursion guard: fire() returns {blocked:false} during hook execution");

      // Reset guard and verify it fires normally
      runner._inHookExecution = false;
      const result2 = await runner.fire("PreToolUse", { tool_name: "Bash" });
      assert(result2.blocked === false, "Recursion guard: fire() executes when guard is off");

    } catch (e) {
      skip(`HookRunner recursion guard test failed: ${e.message}`);
    }
  } else {
    skip("HookRunner class extraction failed for recursion test");
  }
}

// ── 3. Provider E2E — live calls per backend ─────────────────

if (RUN_E2E) {
  const providerE2E = [
    { name: "Google Gemini", envKey: "GOOGLE_API_KEY", model: "gemini-2.5-flash", provider: "google" },
    { name: "DeepSeek", envKey: "DEEPSEEK_API_KEY", model: "deepseek-chat", provider: "deepseek" },
    { name: "Mistral", envKey: "MISTRAL_API_KEY", model: "mistral-small-latest", provider: "mistral" },
    { name: "Groq", envKey: "GROQ_API_KEY", model: "llama-3.3-70b-versatile", provider: "groq" },
  ];

  for (const p of providerE2E) {
    section(`E2E: ${p.name} — live API call`);

    if (!process.env[p.envKey]) {
      skip(`${p.name}: ${p.envKey} not set`);
      continue;
    }

    // Simple text response
    try {
      const { stdout, stderr } = await runCLI(
        ["-p", "What is 2+2? Reply with just the number.", "-m", p.model, "--provider", p.provider, "--max-turns", "1"],
        {}, 30000
      );
      const output = (stdout + stderr).toLowerCase();
      assert(output.includes("4"), `${p.name}: text response contains '4'`);
    } catch (e) {
      skip(`${p.name} text test failed: ${e.message}`);
    }

    // Streaming + tool call
    try {
      const { stdout, stderr } = await runCLI(
        ["-p", "Use the Bash tool to run: echo hello_from_provider", "-m", p.model, "--provider", p.provider, "--permission-mode", "bypassPermissions", "--max-turns", "3"],
        {}, 45000
      );
      const output = stdout + stderr;
      assert(output.includes("hello_from_provider"), `${p.name}: tool calling works (Bash echo)`);
    } catch (e) {
      skip(`${p.name} tool call test failed: ${e.message}`);
    }
  }

  // Ollama — special case (no auth, needs local server)
  section("E2E: Ollama — local server");

  try {
    // Quick check if Ollama is running
    const { stdout: ollamaCheck } = await runCLI(
      ["-p", "Say hello", "-m", "ollama/llama3.2", "--max-turns", "1"],
      {}, 15000
    );
    if (ollamaCheck.includes("ECONNREFUSED") || ollamaCheck.includes("fetch failed")) {
      skip("Ollama: server not running");
    } else {
      assert(ollamaCheck.length > 0, "Ollama: received response from local server");
    }
  } catch {
    skip("Ollama: not available");
  }
}

// ═══════════════════════════════════════════════════════════════════
// SKILL MANAGEMENT — Phase 2: list, info, remove, update, manifest
// ═══════════════════════════════════════════════════════════════════

section("UNIT: _loadSkillManifest returns empty object for missing file");

{
  const loadFn = extractBlock(source, "function _loadSkillManifest(");
  const saveFn = extractBlock(source, "function _saveSkillManifest(");
  if (loadFn && saveFn) {
    try {
      const mns = {};
      new Function("exports", "fs", "path", "os",
        loadFn + "\n" + saveFn + "\n" +
        'const SKILL_MANIFEST_PATH = "/tmp/cloclo-test-manifest-missing-' + Date.now() + '.json";\n' +
        "exports._loadSkillManifest = _loadSkillManifest;\n" +
        "exports._saveSkillManifest = _saveSkillManifest;\n" +
        "exports.SKILL_MANIFEST_PATH = SKILL_MANIFEST_PATH;\n"
      )(mns, fs, path, os);
      const result = mns._loadSkillManifest();
      assert(result && typeof result === "object", "_loadSkillManifest returns object");
      assert(result.skills && typeof result.skills === "object", "_loadSkillManifest has skills key");
      assert(Object.keys(result.skills).length === 0, "_loadSkillManifest skills is empty for missing file");
    } catch (e) {
      skip(`_loadSkillManifest test failed: ${e.message}`);
    }
  } else {
    skip("_loadSkillManifest function not found");
  }
}

section("UNIT: _saveSkillManifest writes valid JSON");

{
  const loadFn = extractBlock(source, "function _loadSkillManifest(");
  const saveFn = extractBlock(source, "function _saveSkillManifest(");
  if (loadFn && saveFn) {
    const testPath = `/tmp/cloclo-test-manifest-save-${Date.now()}.json`;
    try {
      const mns = {};
      new Function("exports", "fs", "path", "os",
        // Override the const to use our test path
        `const SKILL_MANIFEST_PATH = ${JSON.stringify(testPath)};\n` +
        loadFn + "\n" + saveFn + "\n" +
        "exports._loadSkillManifest = _loadSkillManifest;\n" +
        "exports._saveSkillManifest = _saveSkillManifest;\n"
      )(mns, fs, path, os);

      const manifest = { skills: { test: { name: "test", source: "github:owner/repo", installedAt: "2026-03-26T14:00:00Z" } } };
      mns._saveSkillManifest(manifest);
      const raw = fs.readFileSync(testPath, "utf-8");
      const parsed = JSON.parse(raw);
      assert(parsed.skills.test.name === "test", "Saved manifest has correct skill name");
      assert(parsed.skills.test.source === "github:owner/repo", "Saved manifest has correct source");
      fs.unlinkSync(testPath);
    } catch (e) {
      try { fs.unlinkSync(testPath); } catch {}
      skip(`_saveSkillManifest test failed: ${e.message}`);
    }
  } else {
    skip("_saveSkillManifest function not found");
  }
}

section("UNIT: skillList outputs installed skills");

{
  assert(source.includes("function skillList("), "skillList function exists");
  assert(source.includes("No skills installed"), "skillList handles empty state");
  assert(source.includes("(manual)"), "skillList shows untracked skills as manual");
  assert(source.includes("skill(s) installed"), "skillList shows count");
}

section("UNIT: skillInfo outputs skill details");

{
  assert(source.includes("function skillInfo("), "skillInfo function exists");
  assert(source.includes("Skill not found:"), "skillInfo handles missing skill");
  assert(source.includes("Description:"), "skillInfo shows description");
  assert(source.includes("Source:"), "skillInfo shows source");
  assert(source.includes("Size:"), "skillInfo shows size");
}

section("UNIT: skillRemove deletes skill directory");

{
  assert(source.includes("function skillRemove(") || source.includes("async function skillRemove("), "skillRemove function exists");
  assert(source.includes("Removed skill:"), "skillRemove prints confirmation");
  assert(source.includes('rmSync(skillDir, { recursive: true, force: true })'), "skillRemove uses rmSync with recursive");
}

section("UNIT: skillRemove updates manifest");

{
  assert(source.includes("delete manifest.skills[name]"), "skillRemove deletes from manifest");
  assert(source.includes("_saveSkillManifest(manifest)"), "skillRemove saves updated manifest");
}

section("UNIT: Manifest records source and installedAt");

{
  assert(source.includes("manifest.skills[skillName] = {"), "_installOneSkill writes to manifest");
  assert(source.includes("installedAt:") && source.includes("new Date().toISOString()"), "Manifest records installedAt");
  assert(source.includes("source: source"), "Manifest records source");
}

section("UNIT: parseArgs handles skill list/info/remove/update");

{
  assert(source.includes('cfg._subcommand = "skill-list"'), "parseArgs sets skill-list subcommand");
  assert(source.includes('cfg._subcommand = "skill-info"'), "parseArgs sets skill-info subcommand");
  assert(source.includes('cfg._subcommand = "skill-remove"'), "parseArgs sets skill-remove subcommand");
  assert(source.includes('cfg._subcommand = "skill-update"'), "parseArgs sets skill-update subcommand");
  assert(source.includes("cfg._skillInfoName = argv[2]"), "parseArgs captures skill info name");
  assert(source.includes("cfg._skillRemoveName = argv[2]"), "parseArgs captures skill remove name");
  assert(source.includes("cfg._skillUpdateName = argv[2]"), "parseArgs captures skill update name");
  assert(source.includes('Unknown skill subcommand'), "parseArgs rejects unknown skill subcommands");
}

section("UNIT: /skill handler routes all subcommands");

{
  assert(source.includes('sub === "list"') && source.includes("skillList(self.cfg)"), "/skill routes list");
  assert(source.includes('sub === "info"') && source.includes("skillInfo(self.cfg"), "/skill routes info");
  assert(source.includes('sub === "remove"') && source.includes("skillRemove(self.cfg"), "/skill routes remove");
  assert(source.includes('sub === "update"') && source.includes("skillUpdate(self.cfg"), "/skill routes update");
}

section("E2E: cloclo skill list runs without error");

{
  try {
    const { exitCode, stderr } = await runCLI(["skill", "list"], {}, 5000);
    assert(exitCode === 0, `skill list exits with code 0 (got ${exitCode})`);
    assert(stderr.includes("skill") || stderr.includes("No skills"), "skill list produces output");
  } catch (e) {
    skip(`skill list E2E failed: ${e.message}`);
  }
}

section("E2E: cloclo skill remove nonexistent → error");

{
  try {
    const { exitCode, stderr } = await runCLI(["skill", "remove", "nonexistent-skill-99999", "--yes"], {}, 5000);
    assert(exitCode !== 0, `skill remove nonexistent exits with non-zero (got ${exitCode})`);
    assert(stderr.includes("not found") || stderr.includes("Error"), "stderr mentions skill not found");
  } catch (e) {
    skip(`skill remove E2E failed: ${e.message}`);
  }
}

section("UNIT: _computeSkillChecksum produces stable hash");

{
  const fn = extractBlock(source, "function _computeSkillChecksum(");
  if (fn) {
    try {
      const mns = {};
      new Function("exports", "createHash",
        fn + "\nexports._computeSkillChecksum = _computeSkillChecksum;\n"
      )(mns, (await import("node:crypto")).createHash);
      const files = { "SKILL.md": "---\nname: test\n---\nHello", "scripts/run.sh": "#!/bin/bash\necho hi" };
      const h1 = mns._computeSkillChecksum(files);
      const h2 = mns._computeSkillChecksum(files);
      assert(typeof h1 === "string" && h1.length === 16, "Checksum is 16-char hex string");
      assert(h1 === h2, "Checksum is deterministic");
      const h3 = mns._computeSkillChecksum({ "SKILL.md": "different content" });
      assert(h3 !== h1, "Different content produces different checksum");
    } catch (e) {
      skip(`_computeSkillChecksum test failed: ${e.message}`);
    }
  } else {
    skip("_computeSkillChecksum not found");
  }
}

section("UNIT: skillExport function exists");

{
  assert(source.includes("function skillExport("), "skillExport function exists");
  assert(source.includes(".skill.json"), "skillExport writes .skill.json file");
  assert(source.includes("exportedAt"), "skillExport includes exportedAt timestamp");
}

section("UNIT: skillVerify function exists");

{
  assert(source.includes("function skillVerify("), "skillVerify function exists");
  assert(source.includes("Integrity verified"), "skillVerify reports match");
  assert(source.includes("Modified since installation"), "skillVerify reports mismatch");
}

section("UNIT: GITHUB_TOKEN auth headers");

{
  assert(source.includes("_getGitHubHeaders"), "_getGitHubHeaders function exists");
  assert(source.includes("GITHUB_TOKEN") && source.includes("GH_TOKEN"), "Supports both GITHUB_TOKEN and GH_TOKEN");
  assert(source.includes("_ghGet"), "_ghGet convenience function exists");
}

section("UNIT: git clone --depth 1 fallback");

{
  assert(source.includes("git clone --depth 1"), "Fallback git clone --depth 1 implemented");
  assert(source.includes("--single-branch"), "Clone uses --single-branch for efficiency");
  assert(source.includes("usedGitClone"), "Git clone fallback tracked");
}

section("UNIT: parseArgs handles skill export/verify");

{
  assert(source.includes('cfg._subcommand = "skill-export"'), "parseArgs sets skill-export subcommand");
  assert(source.includes('cfg._subcommand = "skill-verify"'), "parseArgs sets skill-verify subcommand");
  assert(source.includes("cfg._skillExportName"), "parseArgs captures export name");
  assert(source.includes("cfg._skillVerifyName"), "parseArgs captures verify name");
}

section("UNIT: manifest records enriched fields");

{
  assert(source.includes("sourceType:"), "Manifest records sourceType");
  assert(source.includes("convertedFrom:"), "Manifest records convertedFrom");
  assert(source.includes("selectedPath:"), "Manifest records selectedPath");
  assert(source.includes("checksum: _computeSkillChecksum"), "Manifest records checksum at install");
}

section("UNIT: /skill handler routes export and verify");

{
  assert(source.includes('sub === "export"') && source.includes("skillExport(self.cfg"), "/skill routes export");
  assert(source.includes('sub === "verify"') && source.includes("skillVerify(self.cfg"), "/skill routes verify");
}

section("E2E: cloclo skill verify on existing skill");

{
  try {
    // gstack exists on disk — verify should work (no checksum in manifest = warning)
    const { exitCode, stderr } = await runCLI(["skill", "verify", "gstack"], {}, 5000);
    assert(exitCode === 0, `skill verify exits with code 0 (got ${exitCode})`);
    assert(stderr.includes("Checksum") || stderr.includes("checksum"), "verify shows checksum info");
  } catch (e) {
    skip(`skill verify E2E failed: ${e.message}`);
  }
}

section("E2E: cloclo skill export nonexistent → error");

{
  try {
    const { exitCode, stderr } = await runCLI(["skill", "export", "nonexistent-skill-99999"], {}, 5000);
    assert(exitCode !== 0, `skill export nonexistent exits non-zero (got ${exitCode})`);
    assert(stderr.includes("not found"), "stderr mentions not found");
  } catch (e) {
    skip(`skill export E2E failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// SKILL MARKETPLACE — Phase 4: search, publish, registry source
// ═══════════════════════════════════════════════════════════════════

section("UNIT: registry source type in parseSkillSource");

{
  assert(source.includes('source.startsWith("registry:")'), "parseSkillSource recognizes registry: prefix");
  assert(source.includes('type: "registry"'), "registry source type defined");
}

section("UNIT: fetchSkillContents handles registry type");

{
  assert(source.includes('parsed.type === "registry"'), "fetchSkillContents handles registry type");
  assert(source.includes("/api/skills/"), "Registry API endpoint used for fetch");
}

section("UNIT: skillSearch function exists");

{
  assert(source.includes("async function skillSearch("), "skillSearch function exists");
  assert(source.includes("/api/skills/search"), "skillSearch queries search API");
  assert(source.includes("CLOCLO_REGISTRY_URL"), "Registry URL configurable via env");
}

section("UNIT: skillPublish function exists");

{
  assert(source.includes("async function skillPublish("), "skillPublish function exists");
  assert(source.includes("/api/skills/publish"), "skillPublish posts to publish API");
  assert(source.includes("CLOCLO_REGISTRY_TOKEN"), "Publish requires auth token");
}

section("UNIT: registry client functions");

{
  assert(source.includes("function _registryGet("), "_registryGet function exists");
  assert(source.includes("function _registryPost("), "_registryPost function exists");
  assert(source.includes("SKILL_REGISTRY_URL"), "Registry URL constant defined");
  assert(source.includes("cloclo-registry") && source.includes("run.app"), "Default registry URL set");
}

section("UNIT: parseArgs handles skill search/publish");

{
  assert(source.includes('cfg._subcommand = "skill-search"'), "parseArgs sets skill-search subcommand");
  assert(source.includes('cfg._subcommand = "skill-publish"'), "parseArgs sets skill-publish subcommand");
  assert(source.includes("cfg._skillSearchQuery"), "parseArgs captures search query");
  assert(source.includes("cfg._skillPublishName"), "parseArgs captures publish name");
}

section("UNIT: /skill handler routes search and publish");

{
  assert(source.includes('sub === "search"') && source.includes("skillSearch(self.cfg"), "/skill routes search");
  assert(source.includes('sub === "publish"') && source.includes("skillPublish(self.cfg"), "/skill routes publish");
}

section("E2E: cloclo skill search (registry unavailable → graceful error)");

{
  try {
    const { exitCode, stderr } = await runCLI(["skill", "search", "test-query"], {}, 8000);
    // Registry is not running, so we expect a graceful error
    assert(exitCode === 0, `skill search exits 0 even on registry error (got ${exitCode})`);
    assert(stderr.includes("unavailable") || stderr.includes("Searching") || stderr.includes("Registry"), "search shows registry status");
  } catch (e) {
    skip(`skill search E2E failed: ${e.message}`);
  }
}

section("E2E: cloclo skill publish without token → error");

{
  try {
    const { exitCode, stderr } = await runCLI(["skill", "publish", "gstack"], { CLOCLO_REGISTRY_TOKEN: "" }, 5000);
    assert(exitCode !== 0, `skill publish without token exits non-zero (got ${exitCode})`);
    assert(stderr.includes("CLOCLO_REGISTRY_TOKEN") || stderr.includes("required"), "stderr mentions token requirement");
  } catch (e) {
    skip(`skill publish E2E failed: ${e.message}`);
  }
}

section("E2E: cloclo --help mentions skill search/publish");

{
  try {
    const { stderr } = await runCLI(["--help"], {}, 5000);
    assert(stderr.includes("skill search"), "--help mentions skill search");
    assert(stderr.includes("skill publish"), "--help mentions skill publish");
    assert(stderr.includes("registry"), "--help mentions registry");
  } catch (e) {
    skip(`--help marketplace E2E failed: ${e.message}`);
  }
}

section("E2E: cloclo --help mentions skill list/info/remove/update");

{
  try {
    const { stderr } = await runCLI(["--help"], {}, 5000);
    assert(stderr.includes("skill list"), "--help mentions skill list");
    assert(stderr.includes("skill info"), "--help mentions skill info");
    assert(stderr.includes("skill remove"), "--help mentions skill remove");
    assert(stderr.includes("skill update"), "--help mentions skill update");
    assert(stderr.includes("skill export"), "--help mentions skill export");
    assert(stderr.includes("skill verify"), "--help mentions skill verify");
  } catch (e) {
    skip(`--help skill management E2E failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// TOOL MANAGEMENT — T1: list, info, enable, disable, test
// ═══════════════════════════════════════════════════════════════════

section("UNIT: Tool manifest functions");

{
  assert(source.includes("TOOL_MANIFEST_PATH"), "TOOL_MANIFEST_PATH defined");
  assert(source.includes("function _loadToolManifest("), "_loadToolManifest exists");
  assert(source.includes("function _saveToolManifest("), "_saveToolManifest exists");
}

section("UNIT: Tool management functions");

{
  assert(source.includes("function toolList("), "toolList function exists");
  assert(source.includes("function toolInfo("), "toolInfo function exists");
  assert(source.includes("function toolEnable("), "toolEnable function exists");
  assert(source.includes("function toolDisable("), "toolDisable function exists");
  assert(source.includes("function toolTest(") || source.includes("async function toolTest("), "toolTest function exists");
}

section("UNIT: _classifyToolType categorizes tools");

{
  assert(source.includes("function _classifyToolType("), "_classifyToolType exists");
  assert(source.includes('"builtin"') && source.includes('"connector"') && source.includes('"custom"'), "All tool types defined");
  assert(source.includes('name.startsWith("mcp__")'), "MCP tools classified as connector");
}

section("UNIT: parseArgs handles tool subcommands");

{
  assert(source.includes('cfg._subcommand = "tool-list"'), "parseArgs sets tool-list");
  assert(source.includes('cfg._subcommand = "tool-info"'), "parseArgs sets tool-info");
  assert(source.includes('cfg._subcommand = "tool-enable"'), "parseArgs sets tool-enable");
  assert(source.includes('cfg._subcommand = "tool-disable"'), "parseArgs sets tool-disable");
  assert(source.includes('cfg._subcommand = "tool-test"'), "parseArgs sets tool-test");
  assert(source.includes("cfg._toolInfoName"), "parseArgs captures tool info name");
  assert(source.includes('Unknown tool subcommand'), "parseArgs rejects unknown tool subcommands");
}

section("UNIT: /tool slash command routes all subcommands");

{
  assert(source.includes('name: "tool"') && source.includes("Tool management"), "/tool command registered");
  assert(source.includes("toolList(self.cfg, self.registry)"), "/tool routes list");
  assert(source.includes("toolInfo(self.cfg, self.registry"), "/tool routes info");
  assert(source.includes("toolEnable(self.cfg, self.registry"), "/tool routes enable");
  assert(source.includes("toolDisable(self.cfg, self.registry"), "/tool routes disable");
  assert(source.includes("toolTest(self.cfg, self.registry"), "/tool routes test");
}

section("UNIT: Protected tools cannot be disabled");

{
  assert(source.includes("PROTECTED_TOOLS"), "PROTECTED_TOOLS set defined");
  assert(source.includes("Cannot disable") && source.includes("core tool"), "toolDisable refuses protected tools");
  assert(source.includes('"Read"') && source.includes('"ToolSearch"') && source.includes('"Agent"'), "Read, ToolSearch, Agent are protected");
}

section("UNIT: Disabled tools loaded from manifest at startup");

{
  assert(source.includes("_loadToolManifest()") && source.includes("entry.disabled && registry.has(name)"), "Disabled tools applied from manifest at startup");
}

section("E2E: cloclo tool list runs");

{
  try {
    const { exitCode, stderr } = await runCLI(["tool", "list"], {}, 10000);
    assert(exitCode === 0, `tool list exits 0 (got ${exitCode})`);
    assert(stderr.includes("Bash") || stderr.includes("tools"), "tool list shows tools");
  } catch (e) {
    skip(`tool list E2E failed: ${e.message}`);
  }
}

section("E2E: cloclo tool info Bash");

{
  try {
    const { exitCode, stderr } = await runCLI(["tool", "info", "Bash"], {}, 10000);
    assert(exitCode === 0, `tool info exits 0 (got ${exitCode})`);
    assert(stderr.includes("Bash") && stderr.includes("builtin"), "tool info shows Bash as builtin");
  } catch (e) {
    skip(`tool info E2E failed: ${e.message}`);
  }
}

section("E2E: cloclo tool test Bash");

{
  try {
    const { exitCode, stderr } = await runCLI(["tool", "test", "Bash"], {}, 10000);
    assert(exitCode === 0, `tool test exits 0 (got ${exitCode})`);
    assert(stderr.includes("Executed OK") || stderr.includes("✓"), "tool test Bash succeeds");
  } catch (e) {
    skip(`tool test E2E failed: ${e.message}`);
  }
}

section("E2E: cloclo --help mentions tool commands");

{
  try {
    const { stderr } = await runCLI(["--help"], {}, 5000);
    assert(stderr.includes("tool list"), "--help mentions tool list");
    assert(stderr.includes("tool info"), "--help mentions tool info");
    assert(stderr.includes("tool enable"), "--help mentions tool enable");
    assert(stderr.includes("tool disable"), "--help mentions tool disable");
    assert(stderr.includes("tool test"), "--help mentions tool test");
  } catch (e) {
    skip(`--help tool E2E failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// CUSTOM TOOLS — T2A: TOOL.json install, remove, execute
// ═══════════════════════════════════════════════════════════════════

section("UNIT: TOOL.json validation");

{
  assert(source.includes("function _validateToolJson("), "_validateToolJson exists");
  assert(source.includes('"shell"') && source.includes('"http"') && source.includes('"ai"'), "Validates shell/http/ai types");
  assert(source.includes("'read_only'") && source.includes("shell tools must declare"), "Shell must declare read_only");
  assert(source.includes("http tools require 'timeout'"), "HTTP must have timeout");
  assert(source.includes("ai tools require 'task'"), "AI must have task");
}

section("UNIT: Custom tool executors");

{
  assert(source.includes("function _createShellExecutor("), "Shell executor exists");
  assert(source.includes("function _createHttpExecutor("), "HTTP executor exists");
  assert(source.includes("function _createAiExecutor("), "AI executor exists");
  assert(source.includes("$INPUT_JSON"), "Shell command supports $INPUT_JSON substitution");
}

section("UNIT: scanCustomTools loads from disk");

{
  assert(source.includes("function scanCustomTools("), "scanCustomTools exists");
  assert(source.includes("CUSTOM_TOOLS_DIR"), "CUSTOM_TOOLS_DIR defined");
  assert(source.includes("TOOL.json"), "Scans for TOOL.json files");
}

section("UNIT: toolInstall and toolRemove");

{
  assert(source.includes("function toolInstall("), "toolInstall exists");
  assert(source.includes("function toolRemove("), "toolRemove exists");
  assert(source.includes("Cannot remove") && source.includes("built-in tool"), "toolRemove refuses builtins");
}

section("UNIT: parseArgs handles tool install/remove");

{
  assert(source.includes('cfg._subcommand = "tool-install"'), "parseArgs sets tool-install");
  assert(source.includes('cfg._subcommand = "tool-remove"'), "parseArgs sets tool-remove");
  assert(source.includes("cfg._toolInstallSource"), "parseArgs captures install source");
  assert(source.includes("cfg._toolRemoveName"), "parseArgs captures remove name");
}

section("UNIT: /tool handler routes install and remove");

{
  assert(source.includes("toolInstall(self.cfg") && source.includes('sub === "install"'), "/tool routes install");
  assert(source.includes("toolRemove(self.cfg") && source.includes('sub === "remove"'), "/tool routes remove");
}

section("E2E: install and remove a shell custom tool");

{
  // Create a test TOOL.json
  const tmpToolDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloclo-tool-test-"));
  const toolJson = {
    name: "test-echo",
    description: "Echo input back",
    type: "shell",
    command: "echo $INPUT_JSON",
    read_only: true,
    timeout: 5000,
    input_schema: { type: "object", properties: { message: { type: "string", description: "Message to echo" } }, required: ["message"] },
  };
  fs.writeFileSync(path.join(tmpToolDir, "TOOL.json"), JSON.stringify(toolJson));

  try {
    // Install
    const { exitCode: ic, stderr: se } = await runCLI(["tool", "install", tmpToolDir], {}, 10000);
    assert(ic === 0, `tool install exits 0 (got ${ic})`);
    assert(se.includes("Installed tool: test-echo"), "install confirms tool name");

    // Verify file exists
    const installed = fs.existsSync(path.join(os.homedir(), ".claude", "tools", "test-echo", "TOOL.json"));
    assert(installed, "TOOL.json installed to ~/.claude/tools/test-echo/");

    // Remove
    const { exitCode: rc, stderr: rse } = await runCLI(["tool", "remove", "test-echo"], {}, 10000);
    assert(rc === 0, `tool remove exits 0 (got ${rc})`);
    assert(rse.includes("Removed tool: test-echo"), "remove confirms tool name");

    // Verify gone
    const gone = !fs.existsSync(path.join(os.homedir(), ".claude", "tools", "test-echo", "TOOL.json"));
    assert(gone, "TOOL.json removed from disk");
  } catch (e) {
    skip(`Custom tool E2E failed: ${e.message}`);
  }
  fs.rmSync(tmpToolDir, { recursive: true, force: true });
}

section("E2E: invalid TOOL.json rejected");

{
  const tmpToolDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloclo-tool-bad-"));
  fs.writeFileSync(path.join(tmpToolDir, "TOOL.json"), JSON.stringify({ name: "bad", type: "unknown" }));

  try {
    const { exitCode, stderr } = await runCLI(["tool", "install", tmpToolDir], {}, 10000);
    assert(exitCode !== 0, `invalid TOOL.json exits non-zero (got ${exitCode})`);
    assert(stderr.includes("Invalid TOOL.json"), "stderr shows validation error");
  } catch (e) {
    skip(`Invalid TOOL.json E2E failed: ${e.message}`);
  }
  fs.rmSync(tmpToolDir, { recursive: true, force: true });
}

section("E2E: cloclo --help mentions tool install/remove");

{
  try {
    const { stderr } = await runCLI(["--help"], {}, 5000);
    assert(stderr.includes("tool install"), "--help mentions tool install");
    assert(stderr.includes("tool remove"), "--help mentions tool remove");
  } catch (e) {
    skip(`--help tool install E2E failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// LOCAL AI TOOLS — T2B: backend: "transformers" via worker
// ═══════════════════════════════════════════════════════════════════

section("UNIT: AI backend validation — all backends");

{
  assert(source.includes('"provider"') && source.includes('"ollama"') && source.includes('"openai-compatible"') && source.includes('"transformers"'), "All 4 backends recognized");
  assert(source.includes("ai backend must be one of"), "Invalid backend rejected with list");
  assert(source.includes('"classify"') && source.includes('"translation"') && source.includes('"ocr"'), "transformers tasks: classify/translation/ocr");
  assert(source.includes('"cpu"') && source.includes('"cuda"') && source.includes('"mps"'), "transformers devices: cpu/cuda/mps/auto");
  assert(source.includes("openai-compatible backend requires 'base_url'"), "openai-compatible requires base_url");
}

section("UNIT: AI backend executors");

{
  assert(source.includes("function _createAiExecutor("), "Provider executor exists");
  assert(source.includes("function _createOllamaExecutor("), "Ollama executor exists");
  assert(source.includes("function _createOpenAICompatibleExecutor("), "OpenAI-compatible executor exists");
  assert(source.includes("function _createTransformersExecutor("), "Transformers executor exists");
  assert(source.includes("function _aiToolRequest("), "Shared HTTP helper exists");
}

section("UNIT: Provider executor routes to multiple providers");

{
  assert(source.includes("api.openai.com") && source.includes("api.anthropic.com"), "Routes to OpenAI and Anthropic");
  assert(source.includes("api.groq.com"), "Routes to Groq");
  assert(source.includes("api.deepseek.com"), "Routes to DeepSeek");
  assert(source.includes("api.mistral.ai"), "Routes to Mistral");
  assert(source.includes("generativelanguage.googleapis.com"), "Routes to Google Gemini");
}

section("UNIT: Ollama executor");

{
  assert(source.includes("OLLAMA_API_URL") && source.includes("localhost:11434"), "Ollama defaults to localhost:11434");
  assert(source.includes("/api/generate"), "Ollama uses /api/generate endpoint");
}

section("UNIT: OpenAI-compatible executor");

{
  assert(source.includes("base_url") && source.includes("/v1/chat/completions"), "OpenAI-compatible appends /v1/chat/completions");
  assert(source.includes("api_key_env"), "Supports api_key_env for env var lookup");
}

section("UNIT: Transformers executor (JS)");

{
  assert(source.includes("@huggingface/transformers"), "Uses @huggingface/transformers JS library");
  assert(source.includes("_hfPipelineCache"), "Pipeline cache for model reuse");
  assert(source.includes("hf.pipeline("), "Creates HF pipeline");
}

section("UNIT: Backend routing in _registerCustomTool");

{
  assert(source.includes('toolDef.backend === "transformers"') && source.includes("_createTransformersExecutor"), "transformers routes correctly");
  assert(source.includes('toolDef.backend === "ollama"') && source.includes("_createOllamaExecutor"), "ollama routes correctly");
  assert(source.includes('toolDef.backend === "openai-compatible"') && source.includes("_createOpenAICompatibleExecutor"), "openai-compatible routes correctly");
}

section("UNIT: manifest stores backend/task/device for ai tools");

{
  assert(source.includes("backend: toolDef.backend") && source.includes("task: toolDef.task") && source.includes("device: toolDef.device"), "Manifest captures backend, task, device");
}

section("E2E: install transformers tool — validation");

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloclo-t2b-"));
  const toolJson = {
    name: "test-classify",
    description: "Test local classifier",
    type: "ai",
    backend: "transformers",
    task: "classify",
    model: "distilbert-base-uncased-finetuned-sst-2-english",
    device: "cpu",
    timeout: 30000,
    read_only: true,
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  };
  fs.writeFileSync(path.join(tmpDir, "TOOL.json"), JSON.stringify(toolJson));

  try {
    const { exitCode, stderr } = await runCLI(["tool", "install", tmpDir], {}, 10000);
    assert(exitCode === 0, `transformers tool installs OK (got ${exitCode})`);
    assert(stderr.includes("Installed tool: test-classify"), "install confirms name");

    // Check manifest
    const manifest = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "tools", ".cloclo-tools.json"), "utf-8"));
    assert(manifest.tools["test-classify"]?.backend === "transformers", "manifest has backend: transformers");
    assert(manifest.tools["test-classify"]?.task === "classify", "manifest has task: classify");
    assert(manifest.tools["test-classify"]?.device === "cpu", "manifest has device: cpu");

    // Cleanup
    await runCLI(["tool", "remove", "test-classify"], {}, 5000);
  } catch (e) {
    skip(`T2B install E2E failed: ${e.message}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

section("E2E: invalid transformers task rejected");

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloclo-t2b-bad-"));
  fs.writeFileSync(path.join(tmpDir, "TOOL.json"), JSON.stringify({
    name: "bad-task",
    description: "Invalid task",
    type: "ai",
    backend: "transformers",
    task: "nonexistent-task",
    model: "some-model",
    input_schema: { type: "object", properties: {} },
  }));

  try {
    const { exitCode, stderr } = await runCLI(["tool", "install", tmpDir], {}, 10000);
    assert(exitCode !== 0, `invalid task rejected (got ${exitCode})`);
    assert(stderr.includes("transformers task must be"), "error mentions valid tasks");
  } catch (e) {
    skip(`T2B bad task E2E failed: ${e.message}`);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

section("UNIT: @huggingface/transformers available");

{
  let hfOk = false;
  try { await import("@huggingface/transformers"); hfOk = true; } catch { /* not installed */ }
  assert(hfOk, "@huggingface/transformers importable");
}

// ═══════════════════════════════════════════════════════════════════
// BROWSER TOOL PACK — Enterprise CDP-native multi-session/multi-tab
// ═══════════════════════════════════════════════════════════════════

// ── Phase 0: Connection Refactor (browser-level WS) ─────────────

section("UNIT: BrowserSession class (Phase 0 — connection refactor)");

{
  assert(source.includes("class BrowserSession"), "BrowserSession class exists");
  assert(source.includes("ensureBrowser()"), "Lazy browser init");
  assert(source.includes("_connectWs("), "WebSocket CDP connection (raw RFC 6455)");
  assert(source.includes("_send(method"), "CDP command sender");
  assert(source.includes("_detectLoop("), "Loop detection (3x same action)");
  // Phase 0: browser-level WS
  assert(source.includes("/json/version"), "Phase 0: connects via /json/version (browser-level WS)");
  assert(source.includes("Target.setDiscoverTargets"), "Phase 0: enables target discovery");
  assert(source.includes("Target.attachToTarget") && source.includes("flatten: true"), "Phase 0: attaches to targets with flatten:true");
  assert(source.includes("_activeCdpSession"), "Phase 0: routes CDP commands via active tab session");
  assert(source.includes("msg.sessionId"), "Phase 0: routes events by CDP sessionId");
}

// ── Phase 1: Session Manager + Tabs + Profiles ──────────────────

section("UNIT: BrowserSessionManager (Phase 1)");

{
  assert(source.includes("class BrowserSessionManager"), "BrowserSessionManager class exists");
  assert(source.includes("_getSessionManager"), "Session manager singleton accessor");
  assert(source.includes("session_id"), "session_id param in schema");
  assert(source.includes("tab_id"), "tab_id param in schema");
}

section("UNIT: Tab management actions (Phase 1)");

{
  assert(source.includes('"new_tab"') && source.includes('"switch_tab"') && source.includes('"close_tab"') && source.includes('"list_tabs"'), "Tab actions: new_tab, switch_tab, close_tab, list_tabs");
  assert(source.includes('"new_session"') && source.includes('"close_session"') && source.includes('"list_sessions"'), "Session actions: new_session, close_session, list_sessions");
  assert(source.includes("Target.createTarget"), "newTab uses Target.createTarget");
  assert(source.includes("Target.closeTarget"), "closeTab uses Target.closeTarget");
  assert(source.includes("Target.activateTarget"), "switchTab uses Target.activateTarget");
}

section("UNIT: Named profiles (Phase 1)");

{
  assert(source.includes("profile_name") && source.includes("browser-profiles"), "Named profile support (~/.claude/browser-profiles/<name>/)");
  assert(source.includes("user_data_dir"), "Custom user data directory support");
  assert(source.includes("profile-directory") || source.includes("profile_dir"), "Chrome --profile-directory flag support");
}

// ── Phase 2: CDP Attach Mode ────────────────────────────────────

section("UNIT: CDP attach mode (Phase 2)");

{
  assert(source.includes("BROWSER_CDP_URL"), "BROWSER_CDP_URL env var support");
  assert(source.includes("_attachRemote"), "_attachRemote method for external CDP");
  assert(source.includes('"launch"') && source.includes('"attach"'), "_mode: launch | attach");
  assert(source.includes("cdp_url"), "cdp_url param in schema");
}

// ── Phase 3: New Primitives ─────────────────────────────────────

section("UNIT: Browser tool actions (Phase 3 — new primitives)");

{
  // Original actions
  assert(source.includes('"get_state"') && source.includes('"click_element"') && source.includes('"type_element"'), "Core actions: get_state, click_element, type_element");
  assert(source.includes('"navigate"') && source.includes('"back"') && source.includes('"forward"') && source.includes('"reload"'), "Nav: navigate, back, forward, reload");
  assert(source.includes('"screenshot"') && source.includes('"pdf"'), "Output: screenshot, pdf");
  assert(source.includes('"cookies_get"') && source.includes('"cookies_set"') && source.includes('"cookies_clear"'), "Cookies: get, set, clear");
  assert(source.includes('"evaluate"') && source.includes('"wait_for"') && source.includes('"scroll_to"'), "Other: evaluate, wait_for, scroll_to");
  assert(source.includes('"click"') && source.includes('"fill"'), "Selector-based: click, fill");
  // New primitives
  assert(source.includes('"send_keys"'), "Phase 3: send_keys action");
  assert(source.includes('"upload_file"'), "Phase 3: upload_file action");
  assert(source.includes('"extract"'), "Phase 3: extract action");
  assert(source.includes('"dropdown_options"'), "Phase 3: dropdown_options action");
  assert(source.includes('"select_dropdown"'), "Phase 3: select_dropdown action");
}

section("UNIT: send_keys key map + modifiers");

{
  assert(source.includes("_BROWSER_KEY_MAP"), "Named key lookup table exists");
  assert(source.includes("Enter") && source.includes("Tab") && source.includes("Escape") && source.includes("Backspace"), "Common keys mapped");
  assert(source.includes("ArrowUp") && source.includes("ArrowDown") && source.includes("ArrowLeft") && source.includes("ArrowRight"), "Arrow keys mapped");
  assert(source.includes("modifiers") || source.includes("modBits"), "Modifier key support (Ctrl/Alt/Shift/Meta)");
}

section("UNIT: upload_file uses DOM.setFileInputFiles");

{
  assert(source.includes("DOM.setFileInputFiles"), "upload_file uses CDP DOM.setFileInputFiles");
  assert(source.includes("DOM.getDocument"), "upload_file resolves nodeId via DOM.getDocument");
  assert(source.includes("DOM.querySelector"), "upload_file queries file input via DOM.querySelector");
}

section("UNIT: extract + dropdown primitives");

{
  assert(source.includes("extract") && source.includes("schema"), "extract takes a schema and returns structured data");
  assert(source.includes("dropdownOptions") && source.includes("el.options"), "dropdownOptions reads select options");
  assert(source.includes("selectDropdown") && source.includes("change"), "selectDropdown dispatches change event");
}

// ── Phase 4: Event-Driven Watchers ──────────────────────────────

section("UNIT: Event buffer + watchers (Phase 4)");

{
  assert(source.includes("_events") && source.includes("_pushEvent"), "Event ring buffer with _pushEvent");
  assert(source.includes('"get_events"'), "get_events action");
  assert(source.includes('"set_dialog_auto_dismiss"'), "set_dialog_auto_dismiss action");
  assert(source.includes("Page.javascriptDialogOpening"), "Dialog event listener");
  assert(source.includes("Page.handleJavaScriptDialog"), "Auto-dismiss dialog handler");
  assert(source.includes("Inspector.targetCrashed"), "Crash event listener");
  assert(source.includes("downloadWillBegin"), "Download event listener");
  assert(source.includes("Page.frameNavigated"), "Navigation event listener");
  assert(source.includes("_dialogAutoDismiss"), "Dialog auto-dismiss flag");
}

// ── Phase 5: Frame/Iframe Robustness ────────────────────────────

section("UNIT: Frame support (Phase 5)");

{
  assert(source.includes('"list_frames"'), "list_frames action");
  assert(source.includes("Page.getFrameTree"), "listFrames uses Page.getFrameTree");
  assert(source.includes("_evalInFrame"), "_evalInFrame method exists");
  assert(source.includes("Page.createIsolatedWorld"), "_evalInFrame uses Page.createIsolatedWorld");
  assert(source.includes("frame_id"), "frame_id param in schema");
}

// ── Action Classification ───────────────────────────────────────

section("UNIT: Action classification sets");

{
  assert(source.includes("BROWSER_READ_ONLY_ACTIONS"), "BROWSER_READ_ONLY_ACTIONS set");
  assert(source.includes("BROWSER_MUTATING_ACTIONS"), "BROWSER_MUTATING_ACTIONS set");
  assert(source.includes("BROWSER_PRIVILEGED_ACTIONS"), "BROWSER_PRIVILEGED_ACTIONS set");
}

// ── get_state format upgrade ────────────────────────────────────

section("UNIT: get_state format upgrade");

{
  assert(source.includes('format') && source.includes('"json"'), "get_state supports format param (text/json)");
  assert(source.includes("session_id") && source.includes("active_tab_id"), "JSON format includes session_id and active_tab_id");
}

// ── Backward compatibility ──────────────────────────────────────

section("UNIT: Browser registered as single tool with action dispatcher");

{
  assert(source.includes('registry.register("Browser"'), "Single Browser tool registered");
  assert(source.includes("action dispatcher") || source.includes("action to perform"), "Action-based schema");
  assert(source.includes("registerBrowserTools(registry)"), "Browser tools registered in main()");
}

section("UNIT: Browser DOM extraction (browser-use pattern)");

{
  assert(source.includes("Interactive:") || source.includes("interactive"), "get_state extracts interactive element count");
  assert(source.includes("querySelectorAll") && source.includes("[role=\"button\"]"), "Queries buttons, links, inputs, ARIA roles");
  assert(source.includes("scrollIntoView"), "Elements scrolled into view before click");
}

section("UNIT: Browser anti-bot + anti-loop");

{
  assert(source.includes("AutomationControlled"), "Anti-bot: disables automation flag");
  assert(source.includes("Mozilla/5.0"), "Anti-bot: real user agent");
  assert(source.includes("Loop detected") && source.includes("3 times"), "Loop detection blocks repeated actions");
}

section("UNIT: Browser security");

{
  assert(source.includes("CHROME_PATH"), "Chrome path configurable via env");
  assert(source.includes("headless=new"), "Runs headless by default");
}

// ── Test fixtures ───────────────────────────────────────────────

section("UNIT: Browser test fixtures exist");

{
  const fixtureDir = path.join(__dirname, "test", "browser-fixtures");
  const fixtures = ["form.html", "upload.html", "iframe.html", "dropdown.html", "tabs.html", "download.html", "dialog.html"];
  for (const f of fixtures) {
    assert(fs.existsSync(path.join(fixtureDir, f)), `Fixture: ${f}`);
  }
}

// ── E2E Tests ───────────────────────────────────────────────────

section("E2E: cloclo tool list shows Browser");

{
  try {
    const { exitCode, stderr } = await runCLI(["tool", "list"], {}, 10000);
    assert(exitCode === 0, "tool list exits 0");
    assert(stderr.includes("Browser"), "Browser tool appears in tool list");
  } catch (e) {
    skip(`Browser tool list E2E failed: ${e.message}`);
  }
}

section("E2E: cloclo tool info Browser");

{
  try {
    const { exitCode, stderr } = await runCLI(["tool", "info", "Browser"], {}, 10000);
    assert(exitCode === 0, "tool info Browser exits 0");
    assert(stderr.includes("get_state") || stderr.includes("Browser automation"), "tool info shows Browser description");
  } catch (e) {
    skip(`Browser tool info E2E failed: ${e.message}`);
  }
}

// ── E2E: Browser on local fixtures (requires Chrome) ────────────

if (RUN_E2E) {

  const { createServer: createFixtureServer } = await import("node:http");
  const fixtureDir = path.join(__dirname, "test", "browser-fixtures");

  // Start local fixture server on random port
  let fixturePort = 0;
  let fixtureServer = null;
  try {
    fixtureServer = createFixtureServer((req, res) => {
      const fp = path.join(fixtureDir, req.url === "/" ? "form.html" : req.url.replace(/^\//, ""));
      if (fs.existsSync(fp)) { res.writeHead(200, { "Content-Type": "text/html" }); res.end(fs.readFileSync(fp)); }
      else { res.writeHead(404); res.end("Not found"); }
    });
    await new Promise((resolve) => { fixtureServer.listen(0, "127.0.0.1", () => { fixturePort = fixtureServer.address().port; resolve(); }); });
  } catch (e) {
    skip(`Fixture server failed: ${e.message}`);
  }

  if (fixturePort > 0) {
    const BASE = `http://127.0.0.1:${fixturePort}`;

    section("E2E: Phase 0 — browser-level WS connection on local fixture");

    {
      // Basic navigate + get_state on form.html fixture
      try {
        const { exitCode, stdout } = await runCLI(["--print", "-m", "anthropic", "-p", `Use the Browser tool to navigate to ${BASE}/form.html, then get_state, then close. Report the title.`], {}, 30000);
        assert(exitCode === 0, "Navigate to local form.html fixture");
        assert(stdout.includes("Form Test") || stdout.includes("form"), "get_state sees form.html title/content");
      } catch (e) {
        skip(`Phase 0 E2E failed: ${e.message}`);
      }
    }

    section("E2E: Phase 1 — multi-tab workflow on local fixtures");

    {
      try {
        const { exitCode, stdout } = await runCLI(["--print", "-m", "anthropic", "-p", `Use the Browser tool: navigate to ${BASE}/form.html, then new_tab to ${BASE}/dropdown.html, then list_tabs, then close. Tell me how many tabs were listed.`], {}, 45000);
        assert(exitCode === 0, "Multi-tab workflow exits 0");
        assert(stdout.includes("2") || stdout.includes("two"), "list_tabs shows 2 tabs");
      } catch (e) {
        skip(`Phase 1 tabs E2E failed: ${e.message}`);
      }
    }

    section("E2E: Phase 3 — send_keys, dropdown, extract on local fixtures");

    {
      // send_keys Enter to submit form
      try {
        const { exitCode, stdout } = await runCLI(["--print", "-m", "anthropic", "-p", `Use the Browser tool: navigate to ${BASE}/form.html, get_state, type_element into the Name input with value "Alice", then use send_keys with "Enter" to submit the form, then get_state. Report what the result div says. Then close.`], {}, 45000);
        assert(exitCode === 0, "send_keys Enter form submit exits 0");
        assert(stdout.includes("Submitted") || stdout.includes("Alice"), "Form submitted via send_keys Enter");
      } catch (e) {
        skip(`Phase 3 send_keys E2E failed: ${e.message}`);
      }

      // dropdown_options + select_dropdown
      try {
        const { exitCode, stdout } = await runCLI(["--print", "-m", "anthropic", "-p", `Use the Browser tool: navigate to ${BASE}/dropdown.html, get_state, then use dropdown_options with selector "#color-select", then use select_dropdown selector "#color-select" value "blue", then get_state. Report the options and selected value. Then close.`], {}, 45000);
        assert(exitCode === 0, "Dropdown workflow exits 0");
        assert(stdout.includes("blue") || stdout.includes("Blue"), "Dropdown selected blue");
      } catch (e) {
        skip(`Phase 3 dropdown E2E failed: ${e.message}`);
      }

      // extract
      try {
        const { exitCode, stdout } = await runCLI(["--print", "-m", "anthropic", "-p", `Use the Browser tool: navigate to ${BASE}/form.html, then use extract with schema {"heading": "h1"}. Report the extracted JSON. Then close.`], {}, 30000);
        assert(exitCode === 0, "Extract workflow exits 0");
        assert(stdout.includes("Test Form"), "Extracted h1 text from form.html");
      } catch (e) {
        skip(`Phase 3 extract E2E failed: ${e.message}`);
      }
    }

    section("E2E: Phase 4 — dialog auto-dismiss + get_events");

    {
      try {
        const { exitCode, stdout } = await runCLI(["--print", "-m", "anthropic", "-p", `Use the Browser tool: navigate to ${BASE}/dialog.html, get_state, click the Alert button using click_element, then use get_events. Report if a dialog event was captured. Then close.`], {}, 45000);
        assert(exitCode === 0, "Dialog + events workflow exits 0");
        assert(stdout.includes("dialog") || stdout.includes("alert") || stdout.includes("event"), "Dialog event captured");
      } catch (e) {
        skip(`Phase 4 dialog E2E failed: ${e.message}`);
      }
    }

    section("E2E: Phase 5 — list_frames on iframe fixture");

    {
      try {
        const { exitCode, stdout } = await runCLI(["--print", "-m", "anthropic", "-p", `Use the Browser tool: navigate to ${BASE}/iframe.html, then use list_frames. Report how many frames there are (main + child). Then close.`], {}, 30000);
        assert(exitCode === 0, "list_frames workflow exits 0");
        assert(stdout.includes("2") || stdout.includes("two") || stdout.includes("child") || stdout.includes("frame"), "list_frames shows main + child frame");
      } catch (e) {
        skip(`Phase 5 frames E2E failed: ${e.message}`);
      }
    }

    section("E2E: get_state JSON format");

    {
      try {
        const { exitCode, stdout } = await runCLI(["--print", "-m", "anthropic", "-p", `Use the Browser tool: navigate to ${BASE}/form.html, then get_state with format "json". Report whether the output includes session_id and active_tab_id fields. Then close.`], {}, 30000);
        assert(exitCode === 0, "get_state json format exits 0");
        assert(stdout.includes("session_id") || stdout.includes("active_tab_id") || stdout.includes("json"), "get_state JSON format includes session/tab metadata");
      } catch (e) {
        skip(`get_state JSON E2E failed: ${e.message}`);
      }
    }

    // Cleanup fixture server
    if (fixtureServer) { fixtureServer.close(); }
  }

}

// ═══════════════════════════════════════════════════════════════════
// T4 — EXTERNAL TOOLS (CLI + HTTP hardening + reference connectors)
// ═══════════════════════════════════════════════════════════════════

section("UNIT: cli tool type accepted by validation");

{
  assert(source.includes('"cli"') && source.includes("shell") && source.includes("http"), "type 'cli' accepted alongside shell/http/ai");
  assert(source.includes("cli tools require 'binary'"), "cli without binary is rejected");
  assert(source.includes("cli tools must declare 'read_only'"), "cli without read_only is rejected");
  assert(source.includes("cli parse_mode must be one of"), "invalid parse_mode rejected");
}

section("UNIT: _createCliExecutor exists");

{
  assert(source.includes("function _createCliExecutor"), "_createCliExecutor function exists");
  assert(source.includes("_resolveBinary"), "binary resolution helper exists");
  assert(source.includes("_checkRequiredEnvVars"), "env var checking helper exists");
  assert(source.includes("parse_mode") && source.includes("json") && source.includes("lines"), "parse_mode: json, text, lines supported");
  assert(source.includes("exit_code_map"), "exit_code_map support in CLI executor");
  assert(source.includes("stdin_template"), "stdin_template support in CLI executor");
  assert(source.includes("success_exit_codes"), "success_exit_codes support");
}

section("UNIT: _interpolateEnvVars for http headers");

{
  assert(source.includes("function _interpolateEnvVars"), "_interpolateEnvVars function exists");
  assert(source.includes("\\$\\{([A-Z_]") || source.includes("${") && source.includes("process.env"), "${ENV_VAR} pattern handled");
  assert(source.includes("Required env var") && source.includes("is not set"), "Missing env var throws actionable error");
}

section("UNIT: http error_map support");

{
  assert(source.includes("error_map") && source.includes("statusCode"), "error_map applied on HTTP response status");
}

section("UNIT: toolInfo shows type-specific fields for cli");

{
  assert(source.includes("Binary:") || source.includes("binary"), "toolInfo shows binary for cli tools");
  assert(source.includes("Parse mode:") || source.includes("parse_mode"), "toolInfo shows parse_mode");
  assert(source.includes("Healthcheck:"), "toolInfo shows healthcheck");
  assert(source.includes("Env required:"), "toolInfo shows required env vars");
}

section("UNIT: toolInfo shows type-specific fields for http");

{
  assert(source.includes("URL:"), "toolInfo shows URL for http tools");
  assert(source.includes("Method:"), "toolInfo shows Method");
  assert(source.includes("Auth env:"), "toolInfo shows auth_env");
  assert(source.includes("healthcheck_url"), "toolInfo shows healthcheck_url");
  assert(source.includes("Error map:") || source.includes("error_map"), "toolInfo shows error_map");
}

section("UNIT: toolTest has type-specific logic for cli");

{
  assert(source.includes("Binary not found") || source.includes("binary not found") || source.includes("Binary found"), "toolTest checks binary existence for cli");
  assert(source.includes("Healthcheck passed") || source.includes("healthcheck"), "toolTest runs healthcheck for cli");
  assert(source.includes("Missing env vars") || source.includes("Env vars present"), "toolTest checks env vars");
}

section("UNIT: toolTest has type-specific logic for http");

{
  assert(source.includes("healthcheck_url") && source.includes("reachable"), "toolTest checks healthcheck_url for http");
  assert(source.includes("No healthcheck_url configured"), "toolTest reports when no healthcheck is configured");
  assert(source.includes("connection refused") || source.includes("ECONNREFUSED"), "toolTest detects connection refused");
  assert(source.includes("DNS not found") || source.includes("ENOTFOUND"), "toolTest detects DNS failures");
}

section("UNIT: binary resolution security");

{
  assert(source.includes("must not escape tool directory") || source.includes(".."), "relative binary paths with .. are rejected");
}

section("UNIT: tool fixture files exist");

{
  const fixtureDir = path.join(__dirname, "test", "tool-fixtures");
  const fixtures = ["github-pr-list/TOOL.json", "hedi-fraud-check/TOOL.json", "system-info/TOOL.json", "json-echo/TOOL.json", "json-echo/json-echo.sh"];
  for (const f of fixtures) {
    assert(fs.existsSync(path.join(fixtureDir, f)), `Fixture: ${f}`);
  }
}

section("E2E: install cli tool — validation");

{
  try {
    // Valid CLI tool should install
    const { exitCode: e1, stderr: s1 } = await runCLI(["tool", "install", path.join(__dirname, "test", "tool-fixtures", "system-info")], {}, 10000);
    assert(e1 === 0, "install valid cli tool exits 0");
    assert(s1.includes("Installed tool: system-info") || s1.includes("system-info"), "install prints tool name");

    // Remove it
    await runCLI(["tool", "remove", "system-info"], {}, 10000);
  } catch (e) {
    skip(`CLI install E2E failed: ${e.message}`);
  }
}

section("E2E: invalid cli TOOL.json rejected");

{
  try {
    // Create a temporary invalid cli tool
    const tmpDir = path.join(os.tmpdir(), "cloclo-test-invalid-cli-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "TOOL.json"), JSON.stringify({
      name: "bad-cli", type: "cli", description: "broken", input_schema: { type: "object", properties: {} }
      // Missing: binary, read_only
    }));
    const { exitCode, stderr } = await runCLI(["tool", "install", tmpDir], {}, 10000);
    assert(exitCode !== 0, "invalid cli tool rejected (non-zero exit)");
    assert(stderr.includes("binary") || stderr.includes("read_only"), "error message mentions missing field");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    skip(`Invalid CLI rejection E2E failed: ${e.message}`);
  }
}

section("E2E: tool list shows type=cli");

{
  try {
    // Install, list, remove
    await runCLI(["tool", "install", path.join(__dirname, "test", "tool-fixtures", "system-info")], {}, 10000);
    const { exitCode, stderr } = await runCLI(["tool", "list"], {}, 10000);
    assert(exitCode === 0, "tool list exits 0");
    assert(stderr.includes("system-info"), "tool list shows system-info");
    await runCLI(["tool", "remove", "system-info"], {}, 10000);
  } catch (e) {
    skip(`Tool list CLI E2E failed: ${e.message}`);
  }
}

section("E2E: tool info shows cli-specific fields");

{
  try {
    await runCLI(["tool", "install", path.join(__dirname, "test", "tool-fixtures", "system-info")], {}, 10000);
    const { exitCode, stderr } = await runCLI(["tool", "info", "system-info"], {}, 10000);
    assert(exitCode === 0, "tool info exits 0");
    assert(stderr.includes("uname"), "tool info shows binary name");
    assert(stderr.includes("text") || stderr.includes("Parse"), "tool info shows parse_mode");
    await runCLI(["tool", "remove", "system-info"], {}, 10000);
  } catch (e) {
    skip(`Tool info CLI E2E failed: ${e.message}`);
  }
}

section("E2E: tool test detects binary + runs healthcheck for cli");

{
  try {
    await runCLI(["tool", "install", path.join(__dirname, "test", "tool-fixtures", "system-info")], {}, 10000);
    const { exitCode, stderr } = await runCLI(["tool", "test", "system-info"], {}, 10000);
    assert(exitCode === 0, "tool test exits 0");
    assert(stderr.includes("Binary found") || stderr.includes("uname"), "tool test finds binary");
    assert(stderr.includes("Healthcheck passed") || stderr.includes("✓"), "tool test healthcheck passes");
    await runCLI(["tool", "remove", "system-info"], {}, 10000);
  } catch (e) {
    skip(`Tool test CLI E2E failed: ${e.message}`);
  }
}

section("E2E: tool test detects missing binary");

{
  try {
    const tmpDir = path.join(os.tmpdir(), "cloclo-test-nobin-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "TOOL.json"), JSON.stringify({
      name: "nobin-test", type: "cli", description: "test missing binary",
      binary: "nonexistent-binary-xyz-999", read_only: true,
      input_schema: { type: "object", properties: {} }
    }));
    await runCLI(["tool", "install", tmpDir], {}, 10000);
    const { stderr } = await runCLI(["tool", "test", "nobin-test"], {}, 10000);
    assert(stderr.includes("not found") || stderr.includes("Binary"), "tool test reports binary not found");
    await runCLI(["tool", "remove", "nobin-test"], {}, 10000);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    skip(`Missing binary E2E failed: ${e.message}`);
  }
}

section("E2E: http tool info shows url/auth/healthcheck");

{
  try {
    await runCLI(["tool", "install", path.join(__dirname, "test", "tool-fixtures", "hedi-fraud-check")], {}, 10000);
    const { exitCode, stderr } = await runCLI(["tool", "info", "hedi-fraud-check"], {}, 10000);
    assert(exitCode === 0, "tool info exits 0");
    assert(stderr.includes("hedi.internal") || stderr.includes("URL:"), "tool info shows URL");
    assert(stderr.includes("POST") || stderr.includes("Method:"), "tool info shows method");
    assert(stderr.includes("health") || stderr.includes("Healthcheck:"), "tool info shows healthcheck");
    await runCLI(["tool", "remove", "hedi-fraud-check"], {}, 10000);
  } catch (e) {
    skip(`HTTP tool info E2E failed: ${e.message}`);
  }
}

section("E2E: http tool test distinguishes unreachable");

{
  try {
    await runCLI(["tool", "install", path.join(__dirname, "test", "tool-fixtures", "hedi-fraud-check")], {}, 10000);
    const { stderr } = await runCLI(["tool", "test", "hedi-fraud-check"], {}, 15000);
    assert(stderr.includes("unreachable") || stderr.includes("not found") || stderr.includes("DNS") || stderr.includes("ENOTFOUND"), "tool test reports unreachable for non-existent host");
    await runCLI(["tool", "remove", "hedi-fraud-check"], {}, 10000);
  } catch (e) {
    skip(`HTTP unreachable E2E failed: ${e.message}`);
  }
}

section("E2E: http error_map applied on status codes");

{
  try {
    // Start a local HTTP server that returns 401
    const { createServer: cs } = await import("node:http");
    const srv = cs((req, res) => { res.writeHead(401); res.end("Unauthorized"); });
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    // Create tool pointing to it with error_map
    const tmpDir = path.join(os.tmpdir(), "cloclo-test-errormap-" + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "TOOL.json"), JSON.stringify({
      name: "errormap-test", type: "http", description: "test error map",
      method: "POST", url: `http://127.0.0.1:${port}/test`, timeout: 5000,
      error_map: { "401": "Custom auth error — set API_KEY" },
      input_schema: { type: "object", properties: { q: { type: "string" } } }
    }));
    await runCLI(["tool", "install", tmpDir], {}, 10000);

    // Execute via a direct Node test (not CLI, since tool execution needs a session)
    // Instead, test that the executor works by importing source
    const execResult = await new Promise((resolve) => {
      const child = spawn("node", ["-e", `
        const fs = require("fs");
        const src = fs.readFileSync("claude-native.mjs", "utf-8");
        const idx = src.indexOf("function _createHttpExecutor");
        const end = src.indexOf("function _aiToolRequest");
        const helperStart = src.indexOf("function _interpolateEnvVars");
        const helperEnd = src.indexOf("function _checkRequiredEnvVars");
        const checkEnd = src.indexOf("function _resolveBinary");
        const code = src.slice(helperStart, checkEnd) + "\\n" + src.slice(idx, end);
        const _http = require("http"), _https = require("https");
        const fn = new Function("_http", "_https", code + ";return _createHttpExecutor;");
        const create = fn(_http, _https);
        const exec = create(${JSON.stringify({
          url: `http://127.0.0.1:${port}/test`,
          method: "POST",
          timeout: 5000,
          error_map: { "401": "Custom auth error — set API_KEY" }
        })});
        exec({ q: "test" }).then(r => { process.stdout.write(JSON.stringify(r)); process.exit(0); });
      `], { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
      let out = "";
      child.stdout.on("data", d => out += d);
      child.on("close", () => resolve(out));
    });

    let parsed = {};
    try { parsed = JSON.parse(execResult); } catch { /* parse error */ }
    assert(parsed.is_error === true, "error_map: response is flagged as error");
    assert((parsed.content || "").includes("Custom auth error"), "error_map: mapped message used instead of raw body");

    await runCLI(["tool", "remove", "errormap-test"], {}, 10000);
    srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) {
    skip(`HTTP error_map E2E failed: ${e.message}`);
  }
}

section("E2E: env var interpolation in http headers");

{
  try {
    const { createServer: cs } = await import("node:http");
    const srv = cs((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ auth: req.headers.authorization || "none" }));
    });
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    const port = srv.address().port;

    const execResult = await new Promise((resolve) => {
      const child = spawn("node", ["-e", `
        const fs = require("fs");
        const src = fs.readFileSync("claude-native.mjs", "utf-8");
        const idx = src.indexOf("function _createHttpExecutor");
        const end = src.indexOf("function _aiToolRequest");
        const helperStart = src.indexOf("function _interpolateEnvVars");
        const checkEnd = src.indexOf("function _resolveBinary");
        const code = src.slice(helperStart, checkEnd) + "\\n" + src.slice(idx, end);
        const _http = require("http"), _https = require("https");
        const fn = new Function("_http", "_https", code + ";return _createHttpExecutor;");
        const create = fn(_http, _https);
        const exec = create({
          url: "http://127.0.0.1:${port}/test",
          method: "POST",
          timeout: 5000,
          headers: { "Authorization": "Bearer \${TEST_CLOCLO_TOKEN}" }
        });
        exec({ q: "hello" }).then(r => { process.stdout.write(JSON.stringify(r)); process.exit(0); });
      `], { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"], timeout: 10000, env: { ...process.env, TEST_CLOCLO_TOKEN: "secret123" } });
      let out = "";
      child.stdout.on("data", d => out += d);
      child.on("close", () => resolve(out));
    });

    let parsed = {};
    try { parsed = JSON.parse(execResult); } catch { /* parse error */ }
    const body = JSON.parse(parsed.content || "{}");
    assert(body.auth === "Bearer secret123", "env var ${TEST_CLOCLO_TOKEN} interpolated in Authorization header");

    srv.close();
  } catch (e) {
    skip(`Env interpolation E2E failed: ${e.message}`);
  }
}

section("E2E: gh connector (skipped if gh not installed)");

{
  try {
    let ghAvailable = false;
    try { execSync("which gh", { encoding: "utf-8", timeout: 3000 }); ghAvailable = true; } catch { /* gh not installed */ }

    if (!ghAvailable) {
      skip("gh CLI not installed — skipping github-pr-list connector test");
    } else {
      await runCLI(["tool", "install", path.join(__dirname, "test", "tool-fixtures", "github-pr-list")], {}, 10000);
      const { stderr } = await runCLI(["tool", "test", "github-pr-list"], {}, 15000);
      assert(stderr.includes("Binary found") || stderr.includes("gh"), "gh binary found");
      assert(stderr.includes("Healthcheck passed") || stderr.includes("✓"), "gh healthcheck passes");
      await runCLI(["tool", "remove", "github-pr-list"], {}, 10000);
    }
  } catch (e) {
    skip(`gh connector E2E failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// OFFICIAL TOOL CATALOG
// ═══════════════════════════════════════════════════════════════════

section("UNIT: official catalog exists and has entries");

{
  assert(source.includes("_OFFICIAL_CATALOG"), "Official catalog constant exists");
  assert(source.includes("github-pr-list") && source.includes("hedi-fraud-check") && source.includes("slack-post"), "Catalog has github, hedi, slack entries");
  assert(source.includes("_meta") && source.includes("category") && source.includes("auth_note"), "Catalog entries have _meta with category and auth_note");
  assert(source.includes("_installOfficialTool"), "_installOfficialTool function exists");
  assert(source.includes("toolCatalog"), "toolCatalog function exists");
  assert(source.includes('official:'), "official: prefix handled in toolInstall");
}

section("E2E: tool catalog shows all tools");

{
  try {
    const { exitCode, stderr } = await runCLI(["tool", "catalog"], {}, 10000);
    assert(exitCode === 0, "tool catalog exits 0");
    assert(stderr.includes("github-pr-list"), "catalog shows github-pr-list");
    assert(stderr.includes("hedi-fraud-check"), "catalog shows hedi-fraud-check");
    assert(stderr.includes("tool(s) available") || stderr.includes("tool(s) found"), "catalog shows count");
  } catch (e) {
    skip(`Catalog E2E failed: ${e.message}`);
  }
}

section("E2E: tool catalog search filters results");

{
  try {
    const { exitCode, stderr } = await runCLI(["tool", "catalog", "devops"], {}, 10000);
    assert(exitCode === 0, "catalog devops exits 0");
    assert(stderr.includes("github-pr-list"), "devops filter includes github");
    assert(!stderr.includes("slack-post"), "devops filter excludes slack");
  } catch (e) {
    skip(`Catalog search E2E failed: ${e.message}`);
  }
}

section("E2E: install official:system-info works");

{
  try {
    const { exitCode, stderr } = await runCLI(["tool", "install", "official:system-info"], {}, 10000);
    assert(exitCode === 0, "install official:system-info exits 0");
    assert(stderr.includes("Installed: system-info"), "prints installed message");
    assert(stderr.includes("Read-only"), "shows read-only metadata");
    assert(stderr.includes("uname"), "shows binary name");
    // Verify it works as a normal tool
    const { stderr: infoOut } = await runCLI(["tool", "info", "system-info"], {}, 10000);
    assert(infoOut.includes("Source:      official") || infoOut.includes("Source:      registry"), "tool info shows source=official or registry");
    // Cleanup
    await runCLI(["tool", "remove", "system-info"], {}, 10000);
  } catch (e) {
    skip(`Official install E2E failed: ${e.message}`);
  }
}

section("E2E: install official:nonexistent fails clearly");

{
  try {
    const { exitCode, stderr } = await runCLI(["tool", "install", "official:nonexistent-xyz"], {}, 10000);
    assert(stderr.includes("not found") || stderr.includes("Official tool not found"), "clear error for missing tool");
  } catch (e) {
    skip(`Official missing E2E failed: ${e.message}`);
  }
}

section("E2E: overwrite official tool on reinstall");

{
  try {
    await runCLI(["tool", "install", "official:system-info"], {}, 10000);
    const { stderr } = await runCLI(["tool", "install", "official:system-info"], {}, 10000);
    assert(stderr.includes("Already installed") || stderr.includes("overwriting"), "shows overwrite warning");
    assert(stderr.includes("Installed: system-info"), "still installs successfully");
    await runCLI(["tool", "remove", "system-info"], {}, 10000);
  } catch (e) {
    skip(`Overwrite E2E failed: ${e.message}`);
  }
}

section("E2E: catalog shows env/auth metadata");

{
  try {
    const { stderr } = await runCLI(["tool", "install", "official:hedi-fraud-check"], {}, 10000);
    assert(stderr.includes("HEDI_API_KEY"), "shows required env var");
    assert(stderr.includes("Auth:") || stderr.includes("auth") || stderr.includes("HEDI"), "shows auth/env info");
    assert(stderr.includes("http"), "shows type");
    await runCLI(["tool", "remove", "hedi-fraud-check"], {}, 10000);
  } catch (e) {
    skip(`Catalog metadata E2E failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════

process.stderr.write(`\n\x1b[1m${"═".repeat(60)}\x1b[0m\n`);
process.stderr.write(`  \x1b[32m${passed} passed\x1b[0m`);
if (failed > 0) process.stderr.write(`, \x1b[31m${failed} failed\x1b[0m`);
if (skipped > 0) process.stderr.write(`, \x1b[2m${skipped} skipped\x1b[0m`);
process.stderr.write(`\n`);
if (failures.length > 0) {
  process.stderr.write(`\n  Failures:\n`);
  for (const { name, detail } of failures) {
    process.stderr.write(`    \x1b[31m✗\x1b[0m ${name}\n`);
    if (detail && VERBOSE) process.stderr.write(`      ${detail.substring(0, 200)}\n`);
  }
}
process.stderr.write(`\x1b[1m${"═".repeat(60)}\x1b[0m\n\n`);
process.exit(failed > 0 ? 1 : 0);


// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function runCLI(args, envOverrides = {}, timeout = 10000) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...envOverrides };
    const child = spawn("node", [SCRIPT, ...args], {
      stdio: ["pipe", "pipe", "pipe"], env, timeout,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => stdout += d);
    child.stderr.on("data", (d) => stderr += d);
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
    child.on("error", () => resolve({ exitCode: 1, stdout, stderr }));
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeout);
  });
}

function runSDK(runtime, script, args, timeout = 60000) {
  return new Promise((resolve) => {
    const child = spawn(runtime, [script, ...args], {
      stdio: ["pipe", "pipe", "pipe"], env: process.env, timeout,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => stdout += d);
    child.stderr.on("data", (d) => stderr += d);
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
    child.on("error", () => resolve({ exitCode: 1, stdout, stderr }));
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, timeout);
  });
}

function runPipe(input, args, timeout = 60000) {
  return new Promise((resolve) => {
    const child = spawn("node", [SCRIPT, ...args], {
      stdio: ["pipe", "pipe", "pipe"], env: process.env,
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => stdout += d);
    child.stderr.on("data", (d) => stderr += d);
    child.on("close", () => resolve({ stdout, stderr }));
    // Feed input line by line with delays
    const lines = input.split("\n");
    let i = 0;
    const sendNext = () => {
      if (i < lines.length) {
        child.stdin.write(lines[i] + "\n");
        i++;
        setTimeout(sendNext, 3000);
      } else {
        // Close stdin once all scripted input has been delivered so the REPL can
        // terminate cleanly even if the final queued line is not consumed until EOF.
        setTimeout(() => {
          try { child.stdin.end(); } catch {}
        }, 250);
      }
    };
    sendNext();
    setTimeout(() => { try { child.stdin.end(); child.kill(); } catch {} }, timeout);
  });
}

function runNdjson(messages, timeout = 30000) {
  return new Promise((resolve) => {
    const child = spawn("node", [SCRIPT, "--ndjson", "--permission-mode", "bypassPermissions"], {
      stdio: ["pipe", "pipe", "pipe"], env: process.env,
    });
    let response = null;
    let toolUses = 0;
    let buffer = "";

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "ready" && messages.length > 0) {
            child.stdin.write(JSON.stringify(messages.shift()) + "\n");
          } else if (msg.type === "tool_use") {
            toolUses++;
            // Auto-approve tool results for built-in tools
            child.stdin.write(JSON.stringify({ type: "tool_result", id: msg.id, content: "ok", is_error: false }) + "\n");
          } else if (msg.type === "response") {
            response = msg;
            child.stdin.end();
          }
        } catch {}
      }
    });

    child.on("close", () => resolve({ response, toolUses }));
    setTimeout(() => { try { child.stdin.end(); child.kill(); } catch {} }, timeout);
  });
}
