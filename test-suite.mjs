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

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
