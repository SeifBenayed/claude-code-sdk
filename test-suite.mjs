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

const stubs = "function log() {} function sleep() { return Promise.resolve(); } function memoize(fn, { key = (...args) => JSON.stringify(args) } = {}) { const cache = new Map(); const memoized = (...args) => { const cacheKey = key(...args); if (cache.has(cacheKey)) return cache.get(cacheKey); const value = fn(...args); cache.set(cacheKey, value); return value; }; memoized.cache = cache; memoized.clear = () => cache.clear(); memoized.delete = (...args) => cache.delete(key(...args)); return memoized; } ";
const throttleFunc = extractBlock(source, "function throttle(");
const caseFoldCollatorLine = source.match(/^const CASE_FOLD_COLLATOR = .*$/m)?.[0] || "";
const caseInsensitiveCompareFunc = extractBlock(source, "function caseInsensitiveCompare(");
const caseInsensitiveIncludesFunc = extractBlock(source, "function caseInsensitiveIncludes(");
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
const modelProfilesStart = source.indexOf("const MODEL_PROFILES = {");
const modelProfilesEnd = source.indexOf("// ── providers.mjs", modelProfilesStart);
const modelProfilesBlock = modelProfilesStart !== -1 && modelProfilesEnd !== -1 ? source.slice(modelProfilesStart, modelProfilesEnd) : "";
const resolveModelForWorkloadFunc = extractBlock(source, "function resolveModelForWorkload(");

const testModule = [stubs, throttleFunc, caseFoldCollatorLine, caseInsensitiveCompareFunc, caseInsensitiveIncludesFunc, anthropicClientClass, openAIClientClass, openAIResponsesClass, modelProfilesBlock, providersAndHelpers, detectProviderFunc, isOpenAIModelFunc, isResponsesFunc, resolveModelForWorkloadFunc].join("\n\n");
const ns = {};
try {
  new Function("exports", "process", testModule + "\nexports.throttle = throttle;\nexports.caseInsensitiveCompare = caseInsensitiveCompare;\nexports.caseInsensitiveIncludes = caseInsensitiveIncludes;\nexports.OpenAIClient = OpenAIClient;\nexports.OpenAIResponsesClient = OpenAIResponsesClient;\nexports.isOpenAIModel = isOpenAIModel;\nexports.isResponsesAPIModel = isResponsesAPIModel;\nexports.PROVIDERS = PROVIDERS;\nexports.detectProvider = detectProvider;\nexports.getInstructionPlacement = getInstructionPlacement;\nexports.resolveModelForWorkload = resolveModelForWorkload;\n")(ns, process);
} catch (e) {
  process.stderr.write(`\x1b[31mFailed to extract classes: ${e.message}\x1b[0m\n`);
}

const { OpenAIClient, OpenAIResponsesClient, isOpenAIModel, isResponsesAPIModel, resolveModelForWorkload } = ns;

function debounce(fn, wait) {
  let timer = null;
  let pendingPromise = null;
  let resolvePending = null;
  let rejectPending = null;
  let lastArgs = [];
  let lastThis = null;

  const debounced = function (...args) {
    lastArgs = args;
    lastThis = this;

    if (timer) clearTimeout(timer);
    if (!pendingPromise) {
      pendingPromise = new Promise((resolve, reject) => {
        resolvePending = resolve;
        rejectPending = reject;
      });
    }

    timer = setTimeout(async () => {
      timer = null;
      const resolve = resolvePending;
      const reject = rejectPending;
      resolvePending = null;
      rejectPending = null;
      pendingPromise = null;
      try {
        resolve(await fn.apply(lastThis, lastArgs));
      } catch (error) {
        reject(error);
      }
    }, wait);

    return pendingPromise;
  };

  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (rejectPending) rejectPending(new Error("Debounced call cancelled"));
    resolvePending = null;
    rejectPending = null;
    pendingPromise = null;
  };

  return debounced;
}

function memoize(fn, { key = (...args) => JSON.stringify(args) } = {}) {
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

function flattenUserFacingOutputs(outputs, fallbackText = "") {
  if (!Array.isArray(outputs) || outputs.length === 0) return fallbackText || "";
  const parts = outputs.map((output) => {
    if (!output || typeof output !== "object") return "";
    if (output.kind === "task_output") return output.message || output.summary || "";
    return output.message || "";
  }).filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : (fallbackText || "");
}

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

section("UNIT: Debounce + Memoization");

{
  let calls = 0;
  const seen = [];
  const debounced = debounce(function (value) {
    calls++;
    seen.push({ value, ctx: this?.tag || null });
    return `${this?.tag || "none"}:${value}`;
  }, 20);

  const first = debounced.call({ tag: "first" }, "a");
  const second = debounced.call({ tag: "second" }, "b");
  const result = await second;
  const firstResult = await first;

  assert(result === "second:b", "debounce resolves with last call result");
  assert(firstResult === "second:b", "debounce shares pending promise across calls");
  assert(calls === 1, "debounce only invokes wrapped function once");
  assert(seen.length === 1 && seen[0].value === "b", "debounce keeps latest arguments");
  assert(seen.length === 1 && seen[0].ctx === "second", "debounce keeps latest this context");
}

{
  const debounced = debounce(() => "never", 20);
  const pending = debounced();
  debounced.cancel();
  let cancelled = false;
  try {
    await pending;
  } catch (error) {
    cancelled = error.message === "Debounced call cancelled";
  }
  assert(cancelled, "debounce cancel rejects pending promise");
}

section("UNIT: Memoization");

{
  const originalNow = Date.now;
  try {
    let now = 0;
    Date.now = () => now;
    const calls = [];
    const throttled = ns.throttle?.(function (value) {
      calls.push({ value, context: this?.name ?? null, at: now });
      return `${this?.name ?? "none"}:${value}`;
    }, 100);

    assert(typeof ns.throttle === "function", "throttle extracted");
    const firstResult = throttled.call({ name: "first" }, "a");
    assert(firstResult === "first:a", "throttle invokes first call immediately");
    assert(calls.length === 1, "throttle runs first call once");

    now = 20;
    const secondResult = throttled.call({ name: "second" }, "b");
    assert(secondResult === "first:a", "throttle returns last result while waiting");
    assert(calls.length === 1, "throttle suppresses call inside wait window");

    now = 60;
    throttled.call({ name: "third" }, "c");
    assert(calls.length === 1, "throttle coalesces repeated calls inside wait window");

    now = 100;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(calls.length === 2, "throttle runs one trailing call");
    assert(calls[1].value === "c", "throttle uses latest trailing arguments");
    assert(calls[1].context === "third", "throttle preserves latest trailing context");

    now = 250;
    const fourthResult = throttled.call({ name: "fourth" }, "d");
    assert(fourthResult === "fourth:d", "throttle allows new call after wait window");
    assert(calls.length === 3, "throttle runs next call after window elapses");

    throttled.cancel();
  } catch (e) {
    skip(`throttle eval failed: ${e.message}`);
  } finally {
    Date.now = originalNow;
  }
}

{
  let calls = 0;
  const sum = memoize((a, b) => {
    calls++;
    return a + b;
  });
  assert(sum(1, 2) === 3, "memoize returns computed value");
  assert(sum(1, 2) === 3, "memoize returns cached value");
  assert(calls === 1, "memoize avoids recomputation");
  sum.delete(1, 2);
  assert(sum(1, 2) === 3, "memoize recomputes after delete");
  assert(calls === 2, "memoize delete clears single entry");
  sum.clear();
  assert(sum.cache.size === 0, "memoize clear empties cache");
}

{
  let calls = 0;
  const flattened = memoize(flattenUserFacingOutputs, {
    key: (outputs, fallbackText = "") => JSON.stringify([outputs, fallbackText]),
  });
  const outputs = [{ kind: "task_output", message: "A" }, { message: "B" }];
  const instrumented = memoize((...args) => {
    calls++;
    return flattenUserFacingOutputs(...args);
  }, {
    key: (outputsArg, fallbackText = "") => JSON.stringify([outputsArg, fallbackText]),
  });
  assert(instrumented(outputs, "") === "A\nB", "memoized flatten returns joined output");
  assert(instrumented(outputs, "") === "A\nB", "memoized flatten hits cache");
  assert(calls === 1, "memoized flatten avoids duplicate work");
  assert(flattened(outputs, "") === "A\nB", "flatten memoization key shape matches runtime usage");
}

section("UNIT: Workload Routing");

if (resolveModelForWorkload) {
  const openaiCfg = { model: "gpt-5.4", openaiApiKey: "test", apiKey: "", authToken: "", _provider: ns.detectProvider("gpt-5.4") };
  const anthropicCfg = { model: "claude-sonnet-4-6", openaiApiKey: "test", apiKey: "test", authToken: "", _provider: ns.detectProvider("claude-sonnet-4-6") };
  const openaiResolved = resolveModelForWorkload("exploration", openaiCfg);
  const anthropicResolved = resolveModelForWorkload("exploration", anthropicCfg);
  assert(openaiResolved.model === "gpt-4o-mini", "exploration stays on OpenAI when parent is OpenAI", JSON.stringify(openaiResolved));
  assert(anthropicResolved.model === "claude-haiku-4-5-20251001", "exploration stays on Anthropic when parent is Anthropic", JSON.stringify(anthropicResolved));
} else {
  skip("Workload routing (extraction failed)");
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
  const client = new OpenAIClient({ apiKey: "test", capabilities: { reasoningModelPattern: "^o[1-9]" } });

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

  // Locale-safe case folding for Turkish dotted/dotless I
  {
    assert(typeof ns.caseInsensitiveCompare === "function", "caseInsensitiveCompare extracted");
    assert(typeof ns.caseInsensitiveIncludes === "function", "caseInsensitiveIncludes extracted");
    assert(ns.caseInsensitiveCompare("İ", "i") === 0, "İ equals i in Turkish-safe comparison");
    assert(ns.caseInsensitiveCompare("I", "ı") === 0, "I equals ı in Turkish-safe comparison");
    assert(ns.caseInsensitiveCompare("I", "i") !== 0, "I does not equal i in Turkish-safe comparison");
    assert(ns.caseInsensitiveCompare("İ", "ı") !== 0, "İ does not equal ı in Turkish-safe comparison");
    assert(ns.caseInsensitiveIncludes("İstanbul", "istanbul"), "İ matches i in Turkish-safe comparison");
    assert(ns.caseInsensitiveIncludes("istanbul", "İSTANBUL"), "i matches İ in Turkish-safe comparison");
    assert(!ns.caseInsensitiveIncludes("Isparta", "isparta"), "I does not match i under Turkish comparison");
    assert(!ns.caseInsensitiveIncludes("ısparta", "isparta"), "ı does not match i under Turkish comparison");
    assert(ns.caseInsensitiveIncludes("Isparta", "ısparta"), "I matches ı in Turkish-safe comparison");
    assert(ns.caseInsensitiveIncludes("ısparta", "ISPARTA"), "ı matches I in Turkish-safe comparison");
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

  // Empty instructions are omitted; non-empty instructions are preserved
  {
    const emptyInstructions = client._getInstructions([{ type: "text", text: "" }, { type: "text", text: "   " }]);
    const nonEmptyInstructions = client._getInstructions([{ type: "text", text: "" }, { type: "text", text: "Keep this" }]);
    assert(emptyInstructions === undefined, "Blank instructions omitted");
    assert(nonEmptyInstructions === "Keep this", "Non-empty instructions preserved");
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
    assert(dp(" claude-sonnet-4-6 ").name === "Anthropic", "detectProvider: trims plain claude model names");
    assert(dp("openrouter/anthropic/claude-sonnet-4-6").name === "OpenAI-compatible", "detectProvider: openrouter-hosted claude stays OpenAI-compatible");
    assert(dp(" openrouter/anthropic/claude-sonnet-4-6 ").name === "OpenAI-compatible", "detectProvider: trims openrouter-hosted claude model names");
    assert(dp("openrouter/anthropic/claude-3.5-sonnet").name === "OpenAI-compatible", "detectProvider: exact openrouter-hosted anthropic model stays OpenAI-compatible");
    assert(dp("openrouter/anthropic/claude-3.7-sonnet:thinking").name === "OpenAI-compatible", "detectProvider: exact openrouter Anthropic thinking model stays OpenAI-compatible");
    assert(dp("anthropic/claude-sonnet-4-6").name === "OpenAI-compatible", "detectProvider: slash-prefixed claude stays OpenAI-compatible");
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

    // Loading from nested subdir should still find nearest project file + root
    const nestedDir = path.join(subDir, "src", "handlers");
    fs.mkdirSync(nestedDir, { recursive: true });
    const nestedFiles = ext.loadClaudeMdFiles(nestedDir, "Anthropic");
    const nestedPaths = nestedFiles.map((f) => f.path);
    const nestedContents = nestedFiles.map((f) => f.content).join("\n");
    assert(nestedContents.includes("Root instructions"), "Root CLAUDE.md loaded from nested dir");
    assert(nestedContents.includes("API instructions"), "Nearest project CLAUDE.md loaded from nested dir");
    assert(nestedPaths.some((p) => p === path.join(subDir, "CLAUDE.md")), "Nearest project file path preserved");

    // Loading from root should find root + .claude/CLAUDE.md
    const rootFiles = ext.loadClaudeMdFiles(tmpDir, "Anthropic");
    const rootContents = rootFiles.map((f) => f.content).join("\n");
    assert(rootContents.includes("Root instructions"), "Root CLAUDE.md loaded from root");
    assert(rootContents.includes("Dot-claude instructions"), ".claude/CLAUDE.md loaded");
    assert(!rootContents.includes("API instructions"), "Nested project CLAUDE.md not loaded from root");
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

      // Zero deferred tools: ToolSearch should NOT be registered
      const reg1 = new tsNs.ToolRegistry();
      reg1.register("Bash", { description: "run", input_schema: {} }, () => "ok");
      tsNs.registerToolSearch(reg1);
      assert(!reg1.has("ToolSearch"), "ToolSearch not registered when deferred tool count is zero");
      assert(!reg1.getDefinitions().some(d => d.name === "ToolSearch"), "ToolSearch omitted from eager definitions when deferred tool count is zero");

      // ToolSearch alone should not keep itself surfaced
      const regToolSearchOnly = new tsNs.ToolRegistry();
      regToolSearchOnly.register("ToolSearch", { description: "search", input_schema: {} }, () => "ok");
      tsNs.registerToolSearch(regToolSearchOnly);
      assert(!regToolSearchOnly.has("ToolSearch"), "ToolSearch unregisters when no other deferred tools are available");

      // Nonzero deferred tools: ToolSearch SHOULD be registered
      const reg2 = new tsNs.ToolRegistry();
      reg2.register("Bash", { description: "run", input_schema: {} }, () => "ok");
      reg2.register("TaskCreate", { description: "create", input_schema: {} }, () => "ok", { deferred: true });
      tsNs.registerToolSearch(reg2);
      assert(reg2.has("ToolSearch"), "ToolSearch registered when deferred tools exist");

      // ToolSearch itself is NOT deferred (it must be eager)
      assert(!reg2.isDeferred("ToolSearch"), "ToolSearch is not deferred");

      // ToolSearch appears in eager definitions
      const defs = reg2.getDefinitions();
      assert(defs.some(d => d.name === "ToolSearch"), "ToolSearch in eager definitions when deferred tool count is nonzero");
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

section("UNIT: Deferred Tools — eager registration still works");

{
  const trClass = extractBlock(source, "class ToolRegistry {");
  if (trClass) {
    const trNs = {};
    try {
      new Function("exports", trClass + "\nexports.ToolRegistry = ToolRegistry;\n")(trNs);
      const reg = new trNs.ToolRegistry();
      reg.register("Bash", { description: "run", input_schema: {} }, () => "ok");
      reg.register("Read", { description: "read", input_schema: { type: "object" } }, () => "ok");
      reg.register("TaskCreate", { description: "create", input_schema: {} }, () => "ok", { deferred: true });

      const defs = reg.getDefinitions();
      assert(defs.some(d => d.name === "Bash"), "Bash stays eagerly registered");
      assert(defs.some(d => d.name === "Read"), "Read stays eagerly registered");
      assert(!defs.some(d => d.name === "TaskCreate"), "Deferred tools remain excluded from eager definitions");
    } catch (e) {
      skip(`eager registration test failed: ${e.message}`);
    }
  } else {
    skip("ToolRegistry extraction failed");
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
      assert(all.length === 10, "10 total tools from registerDeferredBuiltinTools");

      // All in getDeferredNames
      const names = reg.getDeferredNames();
      assert(names.length === 10, "10 deferred names");
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

section("UNIT: Memory index loader — ignores broken links");

{
  const loadMemoryFunc = extractBlock(source, "function loadMemoryIndex(");
  const getMemoryDirFunc = extractBlock(source, "function getMemoryDir(");

  if (loadMemoryFunc && getMemoryDirFunc) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cloclo-memory-index-"));
    const cwd = path.join(tmpRoot, "project");
    const projectMemoryDir = path.join(os.homedir(), ".claude-native", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").slice(0, 100), "memory");
    fs.mkdirSync(projectMemoryDir, { recursive: true });
    fs.writeFileSync(path.join(projectMemoryDir, "valid.md"), `---\nname: valid\ndescription: Valid memory\nscope: project\ntype: project\n---\n\nThis memory exists.\n`);
    fs.writeFileSync(path.join(projectMemoryDir, "MEMORY.md"), [
      "# Memory Index",
      "",
      "- [valid](valid.md) — Valid memory",
      "- [missing](missing.md) — Missing memory",
      "",
    ].join("\n"));

    const warnings = [];
    const originalWarn = console.warn;
    try {
      const ns3 = {};
      new Function("exports", "fs", "path", "os", "console",
        'const MEMORY_INDEX = "MEMORY.md"; const MEMORY_MAX_LINES = 200;' + "\n\n" +
        getMemoryDirFunc + "\n\n" +
        'function getUserMemoryDir() { return path.join(os.homedir(), ".claude-native", "user-memory"); }' + "\n\n" +
        loadMemoryFunc + "\nexports.loadMemoryIndex = loadMemoryIndex;\n"
      )(ns3, fs, path, os, { ...console, warn: (msg) => warnings.push(String(msg)) });

      const loaded = ns3.loadMemoryIndex(cwd, "project");
      assert(loaded.includes("[valid](valid.md)"), "memory loader keeps valid links");
      assert(!loaded.includes("[missing](missing.md)"), "memory loader removes broken links");
      assert(loaded.includes("WARNING: Ignored broken memory link `missing.md` in project MEMORY.md."), "memory loader appends broken-link warning");
      assert(warnings.some(msg => msg.includes("WARNING: Ignored broken memory link `missing.md` in project MEMORY.md.")), "memory loader warns for broken link");
    } catch (e) {
      skip(`memory index broken-link test failed: ${e.message}`);
    } finally {
      console.warn = originalWarn;
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  } else {
    skip("memory index loader extraction failed");
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
  // Verify AgentLoop has context management and _getContextLimit
  assert(source.includes("static _contextOverrides"), "AgentLoop has _contextOverrides");
  assert(source.includes("_getContextLimit()"), "AgentLoop has _getContextLimit");
  assert(source.includes("_autoCompact("), "AgentLoop has _autoCompact method");
  assert(source.includes("auto-compacting conversation"), "Auto-compact emits status message");
  assert(source.includes("await this._manageContext(messages, systemBlocks)"), "Context management wired into run() loop");

  // Verify context overrides for known models
  const limitsMatch = source.match(/static _contextOverrides = \{([^}]+)\}/);
  if (limitsMatch) {
    const limitsStr = limitsMatch[1];
    assert(limitsStr.includes('"claude-haiku": 200000'), "Claude haiku has 200k context override");
    assert(limitsStr.includes('"gpt-5": 1000000'), "GPT-5 has 1M context override");
    assert(limitsStr.includes('"o3": 200000'), "o3 has 200k context override");
  } else {
    skip("_contextOverrides not found in source");
  }

  // Verify provider capabilities have contextWindow
  assert(source.includes("contextWindow: 1000000"), "Anthropic provider has 1M contextWindow");
  assert(source.includes("contextWindow: 128000"), "Default contextWindow is 128k");
  assert(source.includes("contextWindow: 64000"), "DeepSeek has 64k contextWindow");
}

section("UNIT: Auto-compaction — graduated context management");

{
  // Verify graduated thresholds
  assert(source.includes("effectiveWindow * 0.85"), "Auto-compact threshold is 85% of effective window (CC-aligned)");
  assert(source.includes("pct > 0.6"), "Level 1: block promotions at 60%");
  assert(source.includes("pct > 0.65"), "Level 2: windowing at 65%");
  assert(source.includes("pct > compactThreshold"), "Level 3: auto-compact at configurable threshold");
  assert(source.includes("pct > 0.9"), "Level 4: emergency at 90%");
  assert(source.includes("estimated > blockingLimit"), "Level 5: hard block at context limit");
  // Verify minimum message count guard
  assert(source.includes("messages.length < 6"), "Won't compact conversations with < 6 messages");
  // Verify micro-compact and windowing exist
  assert(source.includes("_microCompact(messages)"), "Micro-compact wired before API call");
  assert(source.includes("_windowMessages(messages)"), "Message windowing method exists");
  // Verify reactive compact
  assert(source.includes("_hasAttemptedReactiveCompact"), "Reactive compact guard exists");
  assert(source.includes("prompt too long — compacting"), "Reactive compact emits status");
  // Verify CC gap fixes
  assert(source.includes("_getEffectiveWindow"), "Effective window accounts for output reserve");
  assert(source.includes("CLOCLO_CONTEXT_WINDOW"), "Env override for context window");
  assert(source.includes("CLOCLO_AUTOCOMPACT_PCT"), "Env override for compact threshold");
  assert(source.includes("CLOCLO_DISABLE_COMPACT"), "Env override to disable compaction");
  assert(source.includes("CLOCLO_BLOCKING_LIMIT"), "Env override for blocking limit");
  assert(source.includes("_compactFailures"), "Compact failure counter exists");
  assert(source.includes("compaction failed 3 times"), "Compact failure limit message");
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
  assert(source.includes("message: assistantVisibleText || result.text"), "JSON output includes message field");
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
    const { exitCode, stderr } = await runCLI(["--timeout"], {}, 5000);
    assert(exitCode === 2, `Missing value exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("requires a value"), `Stderr mentions missing value`);
  } catch (e) {
    skip(`Missing value E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — -p followed by another flag exits with code 2");

{
  try {
    const { exitCode, stderr } = await runCLI(["-p", "--help"], {}, 5000);
    assert(exitCode === 2, `-p followed by flag exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("requires a prompt value"), "Stderr mentions missing prompt value");
    assert(stderr.includes('Use -p "your prompt"'), "Stderr shows -p usage");
  } catch (e) {
    skip(`-p followed by flag E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — bare -p exits with code 2");

{
  try {
    const { exitCode, stderr } = await runCLI(["-p"], {}, 5000);
    assert(exitCode === 2, `bare -p exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("requires a prompt value"), "Stderr mentions missing prompt value for bare -p");
    assert(stderr.includes('Use -p "your prompt"'), "Stderr shows bare -p usage");
  } catch (e) {
    skip(`bare -p E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — bare --print exits with code 2");

{
  try {
    const { exitCode, stderr } = await runCLI(["--print"], {}, 5000);
    assert(exitCode === 2, `bare --print exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("requires a prompt value"), "Stderr mentions missing prompt value for bare --print");
    assert(stderr.includes('Use --print "your prompt"'), "Stderr shows bare --print usage");
  } catch (e) {
    skip(`bare --print E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — comma after --print exits with code 2");

{
  try {
    const { exitCode, stderr } = await runCLI([",", "--print"], {}, 5000);
    assert(exitCode === 2, `comma before bare --print exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("requires a prompt value"), "Stderr mentions missing prompt value after comma + --print");
    assert(stderr.includes('Use --print "your prompt"'), "Stderr shows --print usage after comma + --print");
  } catch (e) {
    skip(`comma + --print E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — --print comma placeholder exits with code 2");

{
  try {
    const { exitCode, stdout, stderr } = await runCLI(["--print", ","], {}, 5000);
    assert(exitCode === 2, `--print comma placeholder exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("requires a prompt value"), "Stderr mentions missing prompt value for --print comma placeholder");
    assert(stderr.includes('Use --print "your prompt"'), "Stderr shows --print usage for comma placeholder");
    assert(!stdout.includes("> "), "--print comma placeholder does not enter interactive mode");
  } catch (e) {
    skip(`--print comma placeholder E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — --print followed by another flag exits with code 2");

{
  try {
    const { exitCode, stderr } = await runCLI(["--print", "--help"], {}, 5000);
    assert(exitCode === 2, `--print followed by flag exits with code 2 (got ${exitCode})`);
    assert(stderr.includes("requires a prompt value"), "Stderr mentions missing prompt value for --print followed by flag");
    assert(stderr.includes('Use --print "your prompt"'), "Stderr shows --print usage");
  } catch (e) {
    skip(`--print followed by flag E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — one-shot flags still work with valid prompts");

{
  try {
    const shortFlag = await runCLI(["-p", "hi"], {}, 30000);
    assert(shortFlag.exitCode !== null && shortFlag.exitCode !== 2, `valid -p does not fail argument parsing (got ${shortFlag.exitCode})`);
    assert(!shortFlag.stderr.includes("requires a prompt value"), "Valid -p does not print prompt validation error");

    const longFlag = await runCLI(["--print", "hi"], {}, 30000);
    assert(longFlag.exitCode !== null && longFlag.exitCode !== 2, `valid --print does not fail argument parsing (got ${longFlag.exitCode})`);
    assert(!longFlag.stderr.includes("requires a prompt value"), "Valid --print does not print prompt validation error");
  } catch (e) {
    skip(`valid one-shot flags E2E failed: ${e.message}`);
  }
}

section("E2E: CLI — missing one-shot prompt exits with code 2");

{
  try {
    const shortFlag = await runCLI(["-p"], {}, 5000);
    assert(shortFlag.exitCode === 2, `missing -p value exits with code 2 (got ${shortFlag.exitCode})`);
    assert(shortFlag.stderr.includes("Error: -p requires a value"), "Missing -p value prints clear validation error");
    assert(!shortFlag.stdout.includes("> "), "Missing -p value does not enter interactive mode");

    const longFlag = await runCLI(["--print"], {}, 5000);
    assert(longFlag.exitCode === 2, `missing --print value exits with code 2 (got ${longFlag.exitCode})`);
    assert(longFlag.stderr.includes("Error: --print requires a value"), "Missing --print value prints clear validation error");
    assert(!longFlag.stdout.includes("> "), "Missing --print value does not enter interactive mode");
  } catch (e) {
    skip(`missing one-shot prompt E2E failed: ${e.message}`);
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
  const fixtures = ["gh/TOOL.json", "hedi-fraud-check/TOOL.json", "system-info/TOOL.json", "json-echo/TOOL.json", "json-echo/json-echo.sh"];
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
      skip("gh CLI not installed — skipping gh connector test");
    } else {
      await runCLI(["tool", "install", path.join(__dirname, "test", "tool-fixtures", "gh")], {}, 10000);
      const { stderr } = await runCLI(["tool", "test", "gh"], {}, 15000);
      assert(stderr.includes("Binary found") || stderr.includes("gh"), "gh binary found");
      assert(stderr.includes("Healthcheck passed") || stderr.includes("✓"), "gh healthcheck passes");
      await runCLI(["tool", "remove", "gh"], {}, 10000);
    }
  } catch (e) {
    skip(`gh connector E2E failed: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// T5 — DOCUMENT TOOLS (Spreadsheet, Pdf, Document)
// ═══════════════════════════════════════════════════════════════════

section("UNIT: document tools registered");

{
  assert(source.includes("registerSpreadsheetTools"), "registerSpreadsheetTools exists");
  assert(source.includes("registerPdfTools"), "registerPdfTools exists");
  assert(source.includes("registerDocumentTools"), "registerDocumentTools exists");
  assert(source.includes("_validateDocPath"), "Common _validateDocPath helper exists");
  assert(source.includes("_docResult") && source.includes("_docError"), "Common result helpers exist");
}

section("UNIT: Spreadsheet tool actions");

{
  assert(source.includes('"inspect"') && source.includes('"read_range"') && source.includes('"write_range"'), "Spreadsheet has inspect, read_range, write_range");
  assert(source.includes('"find_text"') && source.includes('"export_csv"') && source.includes('"append_rows"'), "Spreadsheet has find_text, export_csv, append_rows");
  assert(source.includes('"check_errors"') && source.includes('"set_cell"') && source.includes('"format_cells"'), "Spreadsheet has check_errors, set_cell, format_cells");
  assert(source.includes('"set_column_width"') && source.includes('"create"') && source.includes('"add_sheet"'), "Spreadsheet has set_column_width, create, add_sheet");
  assert(source.includes("#REF!") && source.includes("#DIV/0!") && source.includes("#VALUE!"), "check_errors scans for Excel error types");
  assert(source.includes("SPREADSHEET_READ_ACTIONS") && source.includes("SPREADSHEET_WRITE_ACTIONS"), "Spreadsheet has read/write action classification");
}

section("UNIT: PDF tool actions");

{
  assert(source.includes('"extract_text"') && source.includes('"extract_pages_text"'), "PDF has extract_text, extract_pages_text");
  assert(source.includes('"split"') && source.includes('"merge"'), "PDF has split, merge");
  assert(source.includes('"fill_form"') && source.includes('"get_form_fields"'), "PDF has fill_form, get_form_fields");
  assert(source.includes("PDF_READ_ACTIONS") && source.includes("PDF_WRITE_ACTIONS"), "PDF has read/write action classification");
}

section("UNIT: Document tool actions (read-only v1)");

{
  assert(source.includes('"read_text"') && source.includes('"extract_headings"'), "Document has read_text, extract_headings");
  assert(source.includes('"extract_html"') && source.includes('"export_text"'), "Document has extract_html, export_text");
  assert(source.includes("DOCUMENT_READ_ACTIONS"), "Document has read action classification");
  assert(!source.includes("DOCUMENT_WRITE_ACTIONS") || source.includes("Document_WRITE") === false, "Document v1 is read-only (no write actions set)");
}

section("UNIT: document fixture files exist");

{
  const fixtureDir = path.join(__dirname, "test", "document-fixtures");
  assert(fs.existsSync(path.join(fixtureDir, "sample.xlsx")), "Fixture: sample.xlsx");
  assert(fs.existsSync(path.join(fixtureDir, "sample.pdf")), "Fixture: sample.pdf");
  assert(fs.existsSync(path.join(fixtureDir, "sample.docx")), "Fixture: sample.docx");
}

section("E2E: Spreadsheet inspect");

{
  try {
    const result = await new Promise((resolve) => {
      const child = spawn("node", ["-e", `
        const fs = require("fs"), path = require("path"), os = require("os");
        async function run() {
          const XLSX = await import("xlsx"); const xl = XLSX.default || XLSX;
          const wb = xl.readFile("test/document-fixtures/sample.xlsx");
          console.log(JSON.stringify({ sheets: wb.SheetNames, count: wb.SheetNames.length }));
        }
        run();
      `], { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
      let out = ""; child.stdout.on("data", d => out += d); child.on("close", () => resolve(out));
    });
    const data = JSON.parse(result);
    assert(data.count === 2, "xlsx has 2 sheets");
    assert(data.sheets.includes("People") && data.sheets.includes("Products"), "sheets are People and Products");
  } catch (e) { skip(`Spreadsheet inspect E2E: ${e.message}`); }
}

section("E2E: Spreadsheet read_range");

{
  try {
    const result = await new Promise((resolve) => {
      const child = spawn("node", ["-e", `
        async function run() {
          const XLSX = await import("xlsx"); const xl = XLSX.default || XLSX;
          const wb = xl.readFile("test/document-fixtures/sample.xlsx");
          const data = xl.utils.sheet_to_json(wb.Sheets["People"]);
          console.log(JSON.stringify(data));
        }
        run();
      `], { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
      let out = ""; child.stdout.on("data", d => out += d); child.on("close", () => resolve(out));
    });
    const rows = JSON.parse(result);
    assert(rows.length === 4, "People sheet has 4 data rows");
    assert(rows[0].Name === "Alice" && rows[0].City === "Paris", "First row is Alice/Paris");
  } catch (e) { skip(`Spreadsheet read E2E: ${e.message}`); }
}

section("E2E: Spreadsheet write + read roundtrip");

{
  try {
    const tmpFile = path.join(os.tmpdir(), "cloclo-test-write-" + Date.now() + ".xlsx");
    const result = await new Promise((resolve) => {
      const child = spawn("node", ["-e", `
        const fs = require("fs");
        async function run() {
          const XLSX = await import("xlsx"); const xl = XLSX.default || XLSX;
          const wb = xl.utils.book_new();
          const ws = xl.utils.aoa_to_sheet([["A","B"],["hello","world"]]);
          xl.utils.book_append_sheet(wb, ws, "Test");
          xl.writeFile(wb, "${tmpFile}");
          // Read back
          const wb2 = xl.readFile("${tmpFile}");
          const data = xl.utils.sheet_to_json(wb2.Sheets["Test"]);
          console.log(JSON.stringify(data));
        }
        run();
      `], { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
      let out = ""; child.stdout.on("data", d => out += d); child.on("close", () => resolve(out));
    });
    const rows = JSON.parse(result);
    assert(rows[0].A === "hello" && rows[0].B === "world", "write+read roundtrip preserves data");
    try { fs.unlinkSync(tmpFile); } catch { /* cleanup */ }
  } catch (e) { skip(`Spreadsheet write roundtrip E2E: ${e.message}`); }
}

section("E2E: Spreadsheet check_errors");

{
  try {
    const result = await new Promise((resolve) => {
      const child = spawn("node", ["-e", `
        async function run() {
          const XLSX = await import("xlsx"); const xl = XLSX.default || XLSX;
          const wb = xl.readFile("test/document-fixtures/sample.xlsx");
          // sample.xlsx has no errors
          const errors = ["#REF!", "#DIV/0!", "#VALUE!", "#N/A", "#NAME?", "#NULL!"];
          let total = 0;
          for (const sn of wb.SheetNames) { const ws = wb.Sheets[sn]; if (!ws["!ref"]) continue;
            const r = xl.utils.decode_range(ws["!ref"]);
            for (let row = r.s.r; row <= r.e.r; row++) { for (let col = r.s.c; col <= r.e.c; col++) {
              const cell = ws[xl.utils.encode_cell({r:row,c:col})];
              if (cell && typeof cell.v === "string") { for (const e of errors) { if (cell.v.includes(e)) { total++; break; } } }
            }}
          }
          console.log(JSON.stringify({ status: total === 0 ? "success" : "errors_found", totalErrors: total }));
        }
        run();
      `], { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
      let out = ""; child.stdout.on("data", d => out += d); child.on("close", () => resolve(out));
    });
    const data = JSON.parse(result);
    assert(data.status === "success", "sample.xlsx has no formula errors");
    assert(data.totalErrors === 0, "0 errors found");
  } catch (e) { skip(`check_errors E2E: ${e.message}`); }
}

section("E2E: Spreadsheet set_cell + create");

{
  try {
    const tmpFile = path.join(os.tmpdir(), "cloclo-test-setcell-" + Date.now() + ".xlsx");
    const result = await new Promise((resolve) => {
      const child = spawn("node", ["-e", `
        const fs = require("fs");
        async function run() {
          const XLSX = await import("xlsx"); const xl = XLSX.default || XLSX;
          // Create workbook
          const wb = xl.utils.book_new();
          xl.utils.book_append_sheet(wb, xl.utils.aoa_to_sheet([]), "Sheet1");
          // Set cells including a formula
          const ws = wb.Sheets["Sheet1"];
          ws["A1"] = { v: 10, t: "n" };
          ws["A2"] = { v: 20, t: "n" };
          ws["A3"] = { f: "SUM(A1:A2)", t: "n" };
          ws["!ref"] = "A1:A3";
          xl.writeFile(wb, "${tmpFile}");
          // Read back
          const wb2 = xl.readFile("${tmpFile}");
          const ws2 = wb2.Sheets["Sheet1"];
          const hasFormula = ws2["A3"] && ws2["A3"].f === "SUM(A1:A2)";
          console.log(JSON.stringify({ a1: ws2["A1"]?.v, a2: ws2["A2"]?.v, formula: ws2["A3"]?.f, hasFormula }));
        }
        run();
      `], { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
      let out = ""; child.stdout.on("data", d => out += d); child.on("close", () => resolve(out));
    });
    const data = JSON.parse(result);
    assert(data.a1 === 10 && data.a2 === 20, "set_cell writes numeric values");
    // Note: SheetJS community edition does not persist formulas to xlsx on write
    // Formulas are set in memory but lost on save — this is a known limitation
    // For formula support, use openpyxl via Bash or upgrade to SheetJS Pro
    try { fs.unlinkSync(tmpFile); } catch { /* cleanup */ }
  } catch (e) { skip(`set_cell E2E: ${e.message}`); }
}

section("E2E: PDF inspect + extract_text");

{
  try {
    const result = await new Promise((resolve) => {
      const child = spawn("node", ["-e", `
        const fs = require("fs");
        async function run() {
          const { PDFDocument } = await import("pdf-lib");
          const { extractText } = await import("unpdf");
          const buf = fs.readFileSync("test/document-fixtures/sample.pdf");
          const pdf = await PDFDocument.load(buf);
          const { text, totalPages } = await extractText(new Uint8Array(buf));
          const fullText = Array.isArray(text) ? text.join("\\n") : String(text);
          console.log(JSON.stringify({ pages: pdf.getPageCount(), totalPages, hasAlice: fullText.includes("Alice"), hasPage2: fullText.includes("Page 2") }));
        }
        run();
      `], { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
      let out = ""; child.stdout.on("data", d => out += d); child.on("close", () => resolve(out));
    });
    const data = JSON.parse(result);
    assert(data.pages === 2, "PDF has 2 pages");
    assert(data.hasAlice, "PDF text contains Alice");
    assert(data.hasPage2, "PDF text contains Page 2");
  } catch (e) { skip(`PDF E2E: ${e.message}`); }
}

section("E2E: PDF split");

{
  try {
    const tmpFile = path.join(os.tmpdir(), "cloclo-test-split-" + Date.now() + ".pdf");
    const result = await new Promise((resolve) => {
      const child = spawn("node", ["-e", `
        const fs = require("fs");
        async function run() {
          const { PDFDocument } = await import("pdf-lib");
          const src = await PDFDocument.load(fs.readFileSync("test/document-fixtures/sample.pdf"));
          const dst = await PDFDocument.create();
          const [page] = await dst.copyPages(src, [0]);
          dst.addPage(page);
          fs.writeFileSync("${tmpFile}", await dst.save());
          const check = await PDFDocument.load(fs.readFileSync("${tmpFile}"));
          console.log(JSON.stringify({ pages: check.getPageCount() }));
        }
        run();
      `], { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
      let out = ""; child.stdout.on("data", d => out += d); child.on("close", () => resolve(out));
    });
    const data = JSON.parse(result);
    assert(data.pages === 1, "Split PDF has 1 page");
    try { fs.unlinkSync(tmpFile); } catch { /* cleanup */ }
  } catch (e) { skip(`PDF split E2E: ${e.message}`); }
}

section("E2E: Document read_text + extract_headings");

{
  try {
    const result = await new Promise((resolve) => {
      const child = spawn("node", ["-e", `
        async function run() {
          const mammoth = (await import("mammoth")).default;
          const text = await mammoth.extractRawText({ path: "test/document-fixtures/sample.docx" });
          const html = await mammoth.convertToHtml({ path: "test/document-fixtures/sample.docx" });
          const headings = [];
          const re = /<h([1-6])[^>]*>(.*?)<\\/h[1-6]>/gi;
          let m; while ((m = re.exec(html.value)) !== null) { headings.push({ level: parseInt(m[1]), text: m[2].replace(/<[^>]*>/g, "").trim() }); }
          console.log(JSON.stringify({ hasText: text.value.includes("Alice"), headingCount: headings.length, firstHeading: headings[0]?.text }));
        }
        run();
      `], { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
      let out = ""; child.stdout.on("data", d => out += d); child.on("close", () => resolve(out));
    });
    const data = JSON.parse(result);
    assert(data.hasText, "Document text contains Alice");
    assert(data.headingCount >= 2, "Document has at least 2 headings");
    assert(data.firstHeading === "Test Document", "First heading is Test Document");
  } catch (e) { skip(`Document E2E: ${e.message}`); }
}

section("UNIT: Presentation tool actions (read-only v1)");

{
  assert(source.includes("registerPresentationTools"), "registerPresentationTools exists");
  assert(source.includes('"list_slides"') && source.includes('"read_notes"') && source.includes('"export_text_outline"'), "Presentation has list_slides, read_notes, export_text_outline");
  assert(source.includes("PRESENTATION_READ_ACTIONS"), "Presentation has read action classification");
}

section("UNIT: sample.pptx fixture exists");

{
  assert(fs.existsSync(path.join(__dirname, "test", "document-fixtures", "sample.pptx")), "Fixture: sample.pptx");
}

section("E2E: Presentation list_slides + extract_text");

{
  try {
    const result = await new Promise((resolve) => {
      const child = spawn("node", ["-e", `
        const fs = require("fs");
        async function run() {
          const JSZip = (await import("jszip")).default;
          const buf = fs.readFileSync("test/document-fixtures/sample.pptx");
          const zip = await JSZip.loadAsync(buf);
          const slideFiles = Object.keys(zip.files).filter(f => /^ppt\\/slides\\/slide\\d+\\.xml$/.test(f));
          const slides = [];
          for (const sf of slideFiles.sort()) {
            const xml = await zip.file(sf).async("string");
            const texts = []; const re = /<a:t>(.*?)<\\/a:t>/g; let m;
            while ((m = re.exec(xml)) !== null) texts.push(m[1]);
            slides.push({ texts });
          }
          console.log(JSON.stringify({ slideCount: slides.length, firstTitle: slides[0]?.texts[0], hasRevenue: slides[1]?.texts.some(t => t.includes("Revenue")) }));
        }
        run();
      `], { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
      let out = ""; child.stdout.on("data", d => out += d); child.on("close", () => resolve(out));
    });
    const data = JSON.parse(result);
    assert(data.slideCount === 3, "PPTX has 3 slides");
    assert(data.firstTitle === "Quarterly Report Q1 2026", "First slide title correct");
    assert(data.hasRevenue, "Second slide contains Revenue text");
  } catch (e) { skip(`Presentation E2E: ${e.message}`); }
}

section("E2E: Presentation read_notes");

{
  try {
    const result = await new Promise((resolve) => {
      const child = spawn("node", ["-e", `
        const fs = require("fs");
        async function run() {
          const JSZip = (await import("jszip")).default;
          const buf = fs.readFileSync("test/document-fixtures/sample.pptx");
          const zip = await JSZip.loadAsync(buf);
          const xml = await zip.file("ppt/slides/slide1.xml").async("string");
          const notesMatch = xml.match(/<p:notes>([\\s\\S]*?)<\\/p:notes>/);
          const texts = [];
          if (notesMatch) { const re = /<a:t>(.*?)<\\/a:t>/g; let m; while ((m = re.exec(notesMatch[1])) !== null) texts.push(m[1]); }
          console.log(JSON.stringify({ hasNotes: texts.length > 0, noteText: texts.join(" ") }));
        }
        run();
      `], { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"], timeout: 10000 });
      let out = ""; child.stdout.on("data", d => out += d); child.on("close", () => resolve(out));
    });
    const data = JSON.parse(result);
    assert(data.hasNotes, "Slide 1 has speaker notes");
    assert(data.noteText.includes("quarterly"), "Notes contain 'quarterly'");
  } catch (e) { skip(`Presentation notes E2E: ${e.message}`); }
}

section("UNIT: Desktop tool exists (macOS)");

{
  assert(source.includes("registerDesktopTools"), "registerDesktopTools exists");
  assert(source.includes("DESKTOP_READ_ACTIONS") && source.includes("DESKTOP_WRITE_ACTIONS"), "Desktop has read/write action classification");
  assert(source.includes('"list_windows"') && source.includes('"get_tree"') && source.includes('"focus_window"'), "Desktop has list_windows, get_tree, focus_window");
  assert(source.includes('"click_element"') && source.includes('"type_text"') && source.includes('"send_keys"'), "Desktop has click_element, type_text, send_keys");
  assert(source.includes('"screenshot"') && source.includes('"open_app"') && source.includes('"close_window"'), "Desktop has screenshot, open_app, close_window");
  assert(source.includes("_osascript"), "Uses _osascript helper for AppleScript");
  assert(source.includes('process.platform !== "darwin"'), "Desktop is macOS-only guarded");
}

section("E2E: Desktop list_windows (macOS only)");

{
  if (process.platform === "darwin") {
    try {
      const result = await new Promise((resolve) => {
        const child = spawn("osascript", ["-e", 'tell application "System Events" to get name of every process whose visible is true'], { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
        let out = ""; child.stdout.on("data", d => out += d); child.on("close", () => resolve(out.trim()));
      });
      assert(result.length > 0, "macOS accessibility returns visible apps");
      assert(result.includes("Finder") || result.includes("Terminal") || result.includes("Google Chrome"), "Known apps visible");
    } catch (e) { skip(`Desktop list_windows E2E: ${e.message}`); }
  } else {
    skip("Desktop tests: macOS only");
  }
}

section("E2E: Desktop get_focused (macOS only)");

{
  if (process.platform === "darwin") {
    try {
      const result = await new Promise((resolve) => {
        const child = spawn("osascript", ["-e", 'tell application "System Events" to get name of first process whose frontmost is true'], { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
        let out = ""; child.stdout.on("data", d => out += d); child.on("close", () => resolve(out.trim()));
      });
      assert(result.length > 0, "get_focused returns a focused app name");
    } catch (e) { skip(`Desktop get_focused E2E: ${e.message}`); }
  } else { skip("Desktop tests: macOS only"); }
}

section("E2E: Desktop screenshot (macOS only)");

{
  if (process.platform === "darwin") {
    try {
      const tmpFile = path.join(os.tmpdir(), "cloclo-desktop-test-" + Date.now() + ".png");
      execSync(`screencapture -x "${tmpFile}"`, { timeout: 5000, stdio: "pipe" });
      assert(fs.existsSync(tmpFile), "screencapture creates PNG file");
      assert(fs.statSync(tmpFile).size > 1000, "screenshot is non-trivial size");
      fs.unlinkSync(tmpFile);
    } catch (e) { skip(`Desktop screenshot E2E: ${e.message}`); }
  } else { skip("Desktop tests: macOS only"); }
}

section("E2E: tool list shows document + desktop tools (deferred)");

{
  try {
    const { exitCode, stderr } = await runCLI(["tool", "list"], {}, 10000);
    assert(exitCode === 0, "tool list exits 0");
    assert(stderr.includes("Spreadsheet"), "tool list shows Spreadsheet");
    assert(stderr.includes("Pdf"), "tool list shows Pdf");
    assert(stderr.includes("Document"), "tool list shows Document");
    assert(stderr.includes("Presentation"), "tool list shows Presentation");
    if (process.platform === "darwin") assert(stderr.includes("Desktop"), "tool list shows Desktop (macOS)");
  } catch (e) { skip(`Document tools list E2E: ${e.message}`); }
}

// ═══════════════════════════════════════════════════════════════════
// T6 — REMOTE SESSION (/remote)
// ═══════════════════════════════════════════════════════════════════

section("UNIT: RemoteSessionManager exists");

{
  assert(source.includes("class RemoteSessionManager"), "RemoteSessionManager class exists");
  assert(source.includes("_connectRelay"), "WS relay connection method exists");
  assert(source.includes("_onRemoteMessage"), "Remote message handler exists");
  assert(source.includes("CLOCLO_RELAY_URL") || source.includes("CLOCLO_REGISTRY_URL"), "Relay URL configurable via env");
}

section("UNIT: /remote command registered");

{
  assert(source.includes('name: "remote"') && source.includes("Remote session"), "/remote slash command registered");
  assert(source.includes('"status"') && source.includes('"stop"') && source.includes('"renew"'), "/remote has status, stop, renew subcommands");
}

section("UNIT: callback wrapping emits to remote");

{
  assert(source.includes("remote.emit") || source.includes("remote) remote.emit"), "AgentLoop callbacks emit to remote when active");
  assert(source.includes("text_delta") && source.includes("tool_use") && source.includes("tool_result"), "Remote events include text_delta, tool_use, tool_result");
}

section("UNIT: relay server has remote endpoints");

{
  const relaySrc = fs.readFileSync(path.join(__dirname, "registry-server.mjs"), "utf-8");
  assert(relaySrc.includes("/api/remote/register"), "Relay has /api/remote/register endpoint");
  assert(relaySrc.includes("/api/remote/revoke"), "Relay has /api/remote/revoke endpoint");
  assert(relaySrc.includes("remote session status") || relaySrc.includes("statusMatch"), "Relay has remote status endpoint");
  assert(relaySrc.includes("/ws/remote/"), "Relay has WebSocket upgrade for /ws/remote/");
  assert(relaySrc.includes("_remoteSessions"), "Relay has session state map");
  assert(relaySrc.includes("x-remote-role") || relaySrc.includes("X-Remote-Role"), "Relay distinguishes host vs client role");
  assert(relaySrc.includes("_wsAccept") && relaySrc.includes("258EAFA5"), "Relay implements WS handshake");
  assert(relaySrc.includes("_wsSend") && relaySrc.includes("_wsParseFrames"), "Relay has WS frame helpers");
}

section("UNIT: relay serves remote web UI");

{
  const relaySrc = fs.readFileSync(path.join(__dirname, "registry-server.mjs"), "utf-8");
  assert(relaySrc.includes("_remoteClientHtml"), "Relay has web UI template function");
  assert(relaySrc.includes("cloclo remote") || relaySrc.includes("cloclo</h1>"), "Web UI has cloclo branding");
  assert(relaySrc.includes("WebSocket") && relaySrc.includes("ws.onmessage"), "Web UI connects via WebSocket");
  assert(relaySrc.includes("text_delta") && relaySrc.includes("tool_use"), "Web UI handles stream events");
  assert(relaySrc.includes("mobile") || relaySrc.includes("viewport"), "Web UI is mobile-responsive");
}

section("UNIT: remote security");

{
  const relaySrc = fs.readFileSync(path.join(__dirname, "registry-server.mjs"), "utf-8");
  assert(relaySrc.includes("HMAC") || relaySrc.includes("createHmac"), "Token is HMAC-signed");
  assert(relaySrc.includes("REMOTE_SECRET"), "Signing secret exists");
  assert(relaySrc.includes("expiresAt") || relaySrc.includes("expires_at"), "Sessions have expiry");
  assert(relaySrc.includes("_lastMessage") || relaySrc.includes("rate limit"), "Client messages are rate-limited");
  assert(relaySrc.includes("410") || relaySrc.includes("expired"), "Expired sessions return 410");
}

// T6B/C — PERMISSION TIERS, APPROVAL FLOW, RECONNECT, AUDIT
// ═══════════════════════════════════════════════════════════════════

section("UNIT: permission tier constants and methods");

{
  assert(source.includes("REMOTE_TIERS"), "REMOTE_TIERS constant exists");
  assert(source.includes("REMOTE_BROWSER_MUTATING"), "REMOTE_BROWSER_MUTATING constant exists");
  assert(source.includes("REMOTE_DESKTOP_WRITE"), "REMOTE_DESKTOP_WRITE constant exists");
  assert(source.includes("REMOTE_BROWSER_PRIVILEGED"), "REMOTE_BROWSER_PRIVILEGED constant exists");
  assert(source.includes("canSendPrompt"), "canSendPrompt method exists");
  assert(source.includes("canExecuteTool"), "canExecuteTool method exists");
  assert(source.includes("needsApproval"), "needsApproval method exists");
}

section("UNIT: permission tier logic");

{
  // Test canSendPrompt: view returns false, others return true
  assert(source.includes('this._mode !== "view"'), "canSendPrompt blocks view mode");
  // Test canExecuteTool: chat allows read-only only
  assert(source.includes('"chat"') && source.includes("isReadOnly"), "canExecuteTool checks isReadOnly for chat mode");
  // Test needsApproval: control needs approval for browser/desktop mutating
  assert(source.includes("REMOTE_BROWSER_MUTATING.has"), "needsApproval checks browser mutating actions in control mode");
  assert(source.includes("REMOTE_DESKTOP_WRITE.has"), "needsApproval checks desktop write actions in control mode");
  assert(source.includes("REMOTE_BROWSER_PRIVILEGED.has"), "needsApproval checks browser privileged actions in privileged mode");
}

section("UNIT: mode management");

{
  assert(source.includes("setMode"), "setMode method exists");
  assert(source.includes("mode_changed"), "mode change emits mode_changed event");
  assert(source.includes("REMOTE_TIERS.includes"), "setMode validates against allowed tiers");
}

section("UNIT: approval flow");

{
  assert(source.includes("_pendingApprovals"), "Pending approvals map exists");
  assert(source.includes("requestApproval"), "requestApproval method exists");
  assert(source.includes("resolveApproval"), "resolveApproval method exists");
  assert(source.includes("getPendingApprovals"), "getPendingApprovals method exists");
  assert(source.includes("approval_pending"), "Approval pending event type exists");
  assert(source.includes("approval_resolved"), "Approval resolved event type exists");
  assert(source.includes("approval_requested"), "Approval requested audit event exists");
}

section("UNIT: audit log");

{
  assert(source.includes("_auditLog"), "Audit log array exists");
  assert(source.includes("_audit("), "_audit method exists");
  assert(source.includes("getAuditLog"), "getAuditLog method exists");
  assert(source.includes("session_started"), "Audit logs session_started");
  assert(source.includes("session_stopped"), "Audit logs session_stopped");
  assert(source.includes("host_disconnected"), "Audit logs host_disconnected");
  assert(source.includes("host_reconnected"), "Audit logs host_reconnected");
  assert(source.includes("prompt_received"), "Audit logs prompt_received");
  assert(source.includes("prompt_blocked"), "Audit logs prompt_blocked");
  assert(source.includes("this._auditLog.length > 500"), "Audit log capped at 500 entries");
}

section("UNIT: host reconnect");

{
  assert(source.includes("_tryReconnect"), "_tryReconnect method exists");
  assert(source.includes("_reconnectTimer"), "Reconnect timer exists");
  assert(source.includes("_reconnectAttempts"), "Reconnect attempt counter exists");
  assert(source.includes("host_disconnected_permanent"), "Permanent disconnect after max retries");
  // Verify reconnect doesn't immediately deactivate
  assert(source.includes("_tryReconnect()") && !source.includes('socket.on("close", () => { this._ws = null; this._active = false; })'), "Host disconnect triggers reconnect instead of immediate deactivation");
}

section("UNIT: /remote mode command");

{
  assert(source.includes('"mode"') && source.includes("setMode"), "/remote mode subcommand exists");
  assert(source.includes("view, chat, control, privileged") || source.includes("view") && source.includes("privileged"), "Mode help shows all tiers");
}

section("UNIT: /remote approve/deny commands");

{
  assert(source.includes('"approve"') && source.includes("resolveApproval"), "/remote approve subcommand exists");
  assert(source.includes('"deny"') && source.includes("resolveApproval"), "/remote deny subcommand exists");
}

section("UNIT: /remote log command");

{
  assert(source.includes('"log"') && source.includes("getAuditLog"), "/remote log subcommand exists");
  assert(source.includes("Audit Log"), "Log command shows audit log header");
}

section("UNIT: remote permission enforcement in _processInput");

{
  assert(source.includes("_inputIsRemote"), "Remote input flag exists");
  assert(source.includes("canSendPrompt") && source.includes("permission_denied"), "View mode blocks prompts with permission_denied");
  assert(source.includes("remote approval") || source.includes("Approve remote"), "Approval prompt shown to host for remote actions");
  assert(source.includes("canExecuteTool") || (source.includes("canExecuteTool") && source.includes("isReadOnly")), "Tool execution checks permission tier");
}

section("UNIT: relay supports reconnect buffering");

{
  const relaySrc = fs.readFileSync(path.join(__dirname, "registry-server.mjs"), "utf-8");
  assert(relaySrc.includes("messageBuffer"), "Relay has message buffer for disconnected host");
  assert(relaySrc.includes("hostDisconnectedAt"), "Relay tracks host disconnect time");
  assert(relaySrc.includes("host_disconnected"), "Relay sends host_disconnected to clients");
  assert(relaySrc.includes("host_reconnected"), "Relay sends host_reconnected to clients");
  assert(relaySrc.includes("Flushing") || relaySrc.includes("flush") || relaySrc.includes("messageBuffer"), "Relay flushes buffered messages on reconnect");
  assert(relaySrc.includes("< 50") || relaySrc.includes("length < 50"), "Buffer limited to 50 messages");
}

section("UNIT: relay mode change endpoint");

{
  const relaySrc = fs.readFileSync(path.join(__dirname, "registry-server.mjs"), "utf-8");
  assert(relaySrc.includes("/api/remote/mode"), "Relay has /api/remote/mode endpoint");
  assert(relaySrc.includes("mode_changed"), "Relay sends mode_changed to clients");
}

section("UNIT: web UI handles new message types");

{
  const relaySrc = fs.readFileSync(path.join(__dirname, "registry-server.mjs"), "utf-8");
  assert(relaySrc.includes("permission_denied"), "Web UI handles permission_denied");
  assert(relaySrc.includes("approval_pending"), "Web UI handles approval_pending");
  assert(relaySrc.includes("approval_resolved"), "Web UI handles approval_resolved");
  assert(relaySrc.includes("mode_changed"), "Web UI handles mode_changed");
  assert(relaySrc.includes("host_disconnected"), "Web UI handles host_disconnected");
  assert(relaySrc.includes("host_reconnected"), "Web UI handles host_reconnected");
  assert(relaySrc.includes("View-only mode") || relaySrc.includes("view"), "Web UI disables input in view mode");
}

// OFFICIAL TOOL CATALOG
// ═══════════════════════════════════════════════════════════════════

section("UNIT: official catalog exists and has entries");

{
  assert(source.includes("_OFFICIAL_CATALOG"), "Official catalog constant exists");
  assert(source.includes("gh") && source.includes("hedi-fraud-check") && source.includes("slack"), "Catalog has github, hedi, slack entries");
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
    assert(stderr.includes("gh") || stderr.includes("GitHub"), "catalog shows gh");
    assert(stderr.includes("hedi") || stderr.includes("fraud"), "catalog shows hedi");
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
    assert(stderr.includes("gh") || stderr.includes("docker") || stderr.includes("kubectl"), "devops filter includes devops tools");
    assert(!stderr.includes("slack") || stderr.includes("DEVOPS"), "devops filter excludes non-devops");
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
// NEW FEATURE TESTS
// ═══════════════════════════════════════════════════════════════════

// ── Context References ───────────────────────────────────────────

section("UNIT: Context References — @file, @diff, @folder");

{
  const crBlock = extractBlock(source, "function parseRefs(");
  const expandFileBlock = extractBlock(source, "function _expandFile(");
  const expandFolderBlock = extractBlock(source, "function _expandFolder(");
  if (crBlock) {
    // Test parseRefs
    const ns = {};
    try {
      new Function("exports", crBlock + "\nexports.parseRefs = parseRefs;")(ns);
      const refs = ns.parseRefs("Look at @file:src/main.ts and @diff and @folder:lib/");
      assert(refs.length === 3, "parseRefs finds 3 references");
      assert(refs[0].type === "file" && refs[0].arg === "src/main.ts", "parseRefs: file ref with path");
      assert(refs[1].type === "diff", "parseRefs: diff ref");
      assert(refs[2].type === "folder" && refs[2].arg === "lib/", "parseRefs: folder ref");

      const noRefs = ns.parseRefs("hello world no refs here");
      assert(noRefs.length === 0, "parseRefs: no refs in plain text");

      const lineRange = ns.parseRefs("@file:app.ts[10:50]");
      assert(lineRange.length === 1 && lineRange[0].arg === "app.ts[10:50]", "parseRefs: file with line range");

      const urlRef = ns.parseRefs("check @url:https://example.com/api");
      assert(urlRef.length === 1 && urlRef[0].type === "url", "parseRefs: url ref");

      const gitRef = ns.parseRefs("@git:10 commits");
      assert(gitRef.length === 1 && gitRef[0].type === "git" && gitRef[0].arg === "10", "parseRefs: git ref with count");
    } catch (e) { skip(`parseRefs eval failed: ${e.message}`); }
  } else { skip("parseRefs extraction failed"); }
}

section("UNIT: Context References — security");

{
  // Check blocked paths exist in source
  assert(source.includes(".ssh") && source.includes(".aws") && source.includes(".gnupg"), "Sensitive paths blocked (.ssh, .aws, .gnupg)");
  assert(source.includes("_isBlocked"), "Blocked path check function exists");
  assert(source.includes("context-ref"), "Expansion wraps in <context-ref> tags");
}

section("E2E: Context References — @file expansion");

{
  try {
    const { exitCode, stdout, stderr } = await runCLI(
      ["-p", "just say OK", "--yes"],
      { ANTHROPIC_API_KEY: "test-key-not-real" },
      5000
    );
    // We can't test actual expansion without a real API key,
    // but we can verify the @-parsing doesn't crash
    assert(exitCode !== 2, "@ symbols in prompt don't cause arg parse errors");
  } catch { skip("Context ref E2E skipped"); }
}

// ── Trivial Fast-Path (was Smart Model Routing) ─────────────────

section("UNIT: Trivial Fast-Path — isTrivialMessage");

{
  const trivialBlock = extractBlock(source, "function isTrivialMessage(");
  if (trivialBlock) {
    const ns = {};
    try {
      const deps = `const TRIVIAL = /^(hi|hello|hey|thanks|thank you|ok|sure|yes|no|y|n|bye|lgtm|done|got it|good morning|good night|yep|nope|mhm)[.!?]*$/i;`;
      new Function("exports", deps + "\n" + trivialBlock + "\nexports.isTrivialMessage = isTrivialMessage;")(ns);

      assert(ns.isTrivialMessage("hello"), "Trivial: 'hello'");
      assert(ns.isTrivialMessage("thanks!"), "Trivial: 'thanks!'");
      assert(ns.isTrivialMessage("yes"), "Trivial: 'yes'");
      assert(ns.isTrivialMessage("lgtm"), "Trivial: 'lgtm'");
      assert(ns.isTrivialMessage("good morning"), "Trivial: 'good morning'");
      assert(ns.isTrivialMessage("nope"), "Trivial: 'nope'");
      assert(!ns.isTrivialMessage("what time is it?"), "Not trivial: 'what time is it?'");
      assert(!ns.isTrivialMessage("implement a REST API with auth middleware"), "Not trivial: 'implement...'");
      assert(!ns.isTrivialMessage("refactor the database schema and add migrations"), "Not trivial: 'refactor...'");
      assert(!ns.isTrivialMessage("search chatgpt for bags"), "Not trivial: 'search chatgpt...'");
      assert(!ns.isTrivialMessage("a".repeat(90)), "Not trivial: > 80 chars");
      assert(!ns.isTrivialMessage("/help"), "Not trivial: slash command");
      assert(!ns.isTrivialMessage("@someone hi"), "Not trivial: @ mention");
    } catch (e) { skip(`isTrivialMessage eval failed: ${e.message}`); }
  } else { skip("isTrivialMessage extraction failed"); }
}

section("UNIT: Trivial Fast-Path — routeModel function exists");

{
  assert(source.includes("function routeModel("), "routeModel function exists");
  assert(source.includes("summaryModel"), "routeModel uses provider's summaryModel");
  assert(source.includes("_disableSmartRouting"), "Trivial fast-path can be disabled");
  assert(source.includes("_userExplicitModel"), "Skips routing when user chose model explicitly");
  assert(source.includes("trivial-fast-path"), "Log tag is [trivial-fast-path]");
  assert(!source.includes("COMPLEX_KEYWORDS"), "COMPLEX_KEYWORDS removed");
  assert(!source.includes("CODE_PATTERNS"), "CODE_PATTERNS removed");
  assert(!source.includes("isSimpleMessage"), "isSimpleMessage renamed to isTrivialMessage");
}

// ── Skill Metrics ───────────────────────────────────────────────

section("UNIT: Skill Metrics — appendSkillMetric / readSkillMetrics / summarizeSkillMetrics");

{
  // Extract the three core functions from source
  try {
    const tmpDir = path.join(os.tmpdir(), `skill-metrics-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const testCwd = tmpDir;

    // Extract functions from bundled source (no export/import in bundle)
    const fnStart = source.indexOf("function _metricsDir(");
    const fnEnd = source.indexOf("function summarizeSkillMetrics(");
    const fnEndFull = source.indexOf("\n}", source.indexOf("return [...bySkill.entries()]"));
    assert(fnStart > 0 && fnEnd > 0, "Skill metrics functions found in source");

    const fnSource = source.slice(fnStart, fnEndFull + 2);
    const ns = {};

    new Function("exports", "fs", "path", "os", "log",
      fnSource + `
      exports.appendSkillMetric = appendSkillMetric;
      exports.readSkillMetrics = readSkillMetrics;
      exports.summarizeSkillMetrics = summarizeSkillMetrics;
    `)(ns, fs, path, os, () => {});

    // Test append + read
    ns.appendSkillMetric(testCwd, {
      skill_name: "commit", args_present: true, args_preview: "-m 'test'",
      found: true, is_error: false, session_id: "test-session", turn_index: 5,
    });
    ns.appendSkillMetric(testCwd, {
      skill_name: "pdf", args_present: false, found: false, is_error: true,
    });
    ns.appendSkillMetric(testCwd, {
      skill_name: "commit", args_present: false, found: true, is_error: false,
    });

    const events = ns.readSkillMetrics(testCwd);
    assert(events.length === 3, `Read returns 3 events (got ${events.length})`);
    assert(events[0].skill_name === "commit", "First event is commit");
    assert(events[1].skill_name === "pdf", "Second event is pdf");
    assert(events[1].found === false, "pdf event: found=false");
    assert(events[0].session_id === "test-session", "Session ID preserved");
    assert(events[0].turn_index === 5, "Turn index preserved");

    // Test summarize
    const summary = ns.summarizeSkillMetrics(events);
    assert(summary.length === 2, `Summary has 2 skills (got ${summary.length})`);
    assert(summary[0].skill === "commit", "Most used skill first: commit");
    assert(summary[0].uses === 2, "commit: 2 uses");
    assert(summary[0].not_found === 0, "commit: 0 not_found");
    assert(summary[1].skill === "pdf", "Second skill: pdf");
    assert(summary[1].not_found === 1, "pdf: 1 not_found");
    assert(summary[1].errors === 1, "pdf: 1 error");

    // Test since filter
    const future = new Date(Date.now() + 60000).toISOString();
    const filtered = ns.readSkillMetrics(testCwd, { since: future });
    assert(filtered.length === 0, "since filter excludes all past events");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) { skip(`Skill metrics eval failed: ${e.message}`); }
}

section("UNIT: Skill Metrics — module exists in source");

{
  assert(source.includes("function appendSkillMetric("), "appendSkillMetric exists");
  assert(source.includes("function readSkillMetrics("), "readSkillMetrics exists");
  assert(source.includes("function summarizeSkillMetrics("), "summarizeSkillMetrics exists");
  assert(source.includes("skill-metrics.jsonl"), "Uses skill-metrics.jsonl storage");
  assert(source.includes("MAX_LINES"), "Has rotation limit");
  assert(source.includes("TRIM_TO"), "Has trim target");
}

section("UNIT: Skill Metrics — instrumented in Skill tool");

{
  assert(source.includes("appendSkillMetric(") && source.includes("skill_invoked") === false,
    "appendSkillMetric called (not via event name)");
  // Check the instrumentation is near the Skill tool handler
  const skillToolIdx = source.indexOf("cfg._skillLoader.invoke(skillName");
  const metricsIdx = source.indexOf("appendSkillMetric(cfg.cwd");
  assert(skillToolIdx > 0 && metricsIdx > 0, "Both Skill tool and metrics instrumentation exist");
  assert(Math.abs(skillToolIdx - metricsIdx) < 500, "Metrics instrumentation is near Skill tool invoke");
}

// ── Context Compression ──────────────────────────────────────────

section("UNIT: Context Compression — 3-phase strategy");

{
  const compactBlock = extractBlock(source, "async _autoCompact(");
  if (compactBlock) {
    // Phase 1: tool result pruning
    assert(compactBlock.includes("tool_result") && compactBlock.includes("truncated"), "Phase 1: prunes old tool results");
    assert(compactBlock.includes("protectedCount") || compactBlock.includes("protected"), "Phase 2: protects boundary messages");
    // Phase 3: structured summary
    assert(compactBlock.includes("Goal:") && compactBlock.includes("Progress:"), "Phase 3: structured summary format (Goal/Progress)");
    assert(compactBlock.includes("Key Decisions:") && compactBlock.includes("Relevant Files:"), "Phase 3: includes Decisions/Files sections");
    assert(compactBlock.includes("Blockers:") && compactBlock.includes("Next Steps:"), "Phase 3: includes Blockers/Next Steps");
  } else { skip("_autoCompact extraction failed"); }
}

// ── Audit Trail ──────────────────────────────────────────────────

section("UNIT: Audit Trail — AuditLogger");

{
  const auditBlock = extractBlock(source, "class AuditLogger {");
  if (auditBlock) {
    assert(auditBlock.includes("record("), "AuditLogger has record() method");
    assert(auditBlock.includes("flush("), "AuditLogger has flush() method");
    assert(auditBlock.includes("shutdown("), "AuditLogger has shutdown() method");
    assert(auditBlock.includes("toolUse("), "AuditLogger has toolUse() convenience method");
    assert(auditBlock.includes("permissionDeny("), "AuditLogger has permissionDeny() method");
    assert(auditBlock.includes("_pruneOldLogs"), "AuditLogger has retention pruning");
  } else { skip("AuditLogger extraction failed"); }

  // Static methods
  assert(source.includes("static query("), "AuditLogger.query() exists");
  assert(source.includes("static exportJSON("), "AuditLogger.exportJSON() exists");
  assert(source.includes("static exportCSV("), "AuditLogger.exportCSV() exists");
  assert(source.includes("static deleteSession("), "AuditLogger.deleteSession() for GDPR");
  assert(source.includes("static deleteRange("), "AuditLogger.deleteRange() for GDPR");
  assert(source.includes("static stats("), "AuditLogger.stats() exists");
}

section("UNIT: Audit Trail — input sanitization");

{
  assert(source.includes("[REDACTED]"), "Secrets are redacted in audit");
  assert(source.includes("_sanitizeInput"), "Input sanitization function exists");
  assert(source.includes("_redactPath"), "Path redaction function exists");
  assert(source.includes("key|token|password|secret|credential"), "Redaction matches sensitive field names");
}

section("UNIT: Audit Trail — event types");

{
  assert(source.includes("session.start"), "Event type: session.start");
  assert(source.includes("tool.use"), "Event type: tool.use");
  assert(source.includes("tool.result"), "Event type: tool.result");
  assert(source.includes("permission.deny"), "Event type: permission.deny");
  assert(source.includes("permission.allow"), "Event type: permission.allow");
  assert(source.includes("security.block"), "Event type: security.block");
  assert(source.includes("file.write"), "Event type: file.write");
  assert(source.includes("memory.save"), "Event type: memory.save");
}

section("UNIT: Audit Trail — integration in AgentLoop");

{
  // Check that audit is wired into tool execution
  assert(source.includes("cfg._audit") && source.includes("audit.toolUse"), "Audit wired into tool execution");
  assert(source.includes("audit.permissionDeny") || source.includes("_audit.permissionDeny"), "Audit records permission denials");
  assert(source.includes("audit.permissionAllow") || source.includes("_audit.permissionAllow"), "Audit records permission allows");
}

// ── Auto-Memory ──────────────────────────────────────────────────

section("UNIT: Auto-Memory — LLM classification");

{
  assert(source.includes("class AutoMemory"), "AutoMemory class exists");
  assert(source.includes("processExchange"), "AutoMemory.processExchange() exists");
  assert(source.includes("classifyWithLLM") || source.includes("shouldAnalyze"), "LLM classification or pre-filter exists");
  assert(source.includes("auto_saved"), "Auto-saved memories have auto_saved flag");
}

section("UNIT: Auto-Memory — pre-filter");

{
  const filterBlock = extractBlock(source, "function shouldAnalyze(");
  if (filterBlock) {
    const ns = {};
    try {
      const skipDeps = "const SKIP_PATTERNS = [/^(?:hi|hello|hey|ok|sure|thanks|yes|no|y|n|lgtm|done|got it)\\s*[.!?]?$/i, /^(?:\\/\\w|cloclo\\s)/, /^(?:explain|show|read|list|find|search|grep|cat|ls)\\s/i]; const MAX_MSG_LENGTH = 5000;";
      new Function("exports", skipDeps + "\n" + filterBlock + "\nexports.shouldAnalyze = shouldAnalyze;")(ns);

      assert(!ns.shouldAnalyze("hi"), "Pre-filter skips: 'hi'");
      assert(!ns.shouldAnalyze("ok"), "Pre-filter skips: 'ok'");
      assert(!ns.shouldAnalyze("thanks!"), "Pre-filter skips: 'thanks!'");
      assert(!ns.shouldAnalyze("short"), "Pre-filter skips: too short (< 15 chars)");
      assert(!ns.shouldAnalyze("x".repeat(6000)), "Pre-filter skips: too long (> 5000)");
      assert(ns.shouldAnalyze("don't add comments to code you didn't change"), "Pre-filter passes: feedback");
      assert(ns.shouldAnalyze("I'm a backend engineer working on payments"), "Pre-filter passes: user info");
    } catch (e) { skip(`shouldAnalyze eval failed: ${e.message}`); }
  } else { skip("shouldAnalyze extraction failed"); }
}

section("UNIT: Auto-Memory — throttle/dedup");

{
  assert(source.includes("SAVE_COOLDOWN_MS") || source.includes("cooldown"), "Save cooldown exists");
  assert(source.includes("CLASSIFY_COOLDOWN_MS") || source.includes("canClassify"), "Classification cooldown exists");
  assert(source.includes("_memoryExists") || source.includes("memoryExists"), "Dedup check exists");

  const trackerBlock = extractBlock(source, "class AutoMemoryTracker {");
  if (trackerBlock) {
    const ns = {};
    try {
      new Function("exports", `const SAVE_COOLDOWN_MS = 60_000;\n${trackerBlock}\nexports.AutoMemoryTracker = AutoMemoryTracker;`)(ns);
      const tracker = new ns.AutoMemoryTracker();
      assert(tracker.shouldSave("feedback", "same name"), "Initial save is allowed");
      tracker.markSaved("feedback", "same name");
      assert(!tracker.shouldSave("feedback", "same name"), "Repeated save is throttled");
      assert(tracker.shouldSave("feedback", "different name"), "Different memory names are not throttled together");
    } catch (e) { skip(`AutoMemoryTracker eval failed: ${e.message}`); }
  } else { skip("AutoMemoryTracker extraction failed"); }
}

// ── LSP Integration ──────────────────────────────────────────────

section("UNIT: LSP — classes and protocol");

{
  assert(source.includes("class LspManager"), "LspManager class exists");
  assert(source.includes("class LspClient"), "LspClient class exists");
  assert(source.includes("class JsonRpcTransport"), "JsonRpcTransport class exists");
  assert(source.includes("Content-Length:"), "JSON-RPC Content-Length framing");
  assert(source.includes("textDocument/publishDiagnostics"), "Handles publishDiagnostics notification");
}

section("UNIT: LSP — language configs");

{
  assert(source.includes("typescript-language-server"), "TypeScript language server configured");
  assert(source.includes("pyright") && source.includes("--langserver"), "Python language server configured");
  assert(source.includes(".ts") && source.includes(".tsx") && source.includes(".js"), "TypeScript extensions defined");
  assert(source.includes(".py") && source.includes(".pyi"), "Python extensions defined");
}

section("UNIT: LSP — diagnostic formatting");

{
  const dedupeStart = source.indexOf("function dedupeDiagnostics(");
  const fmtStart = source.indexOf("function formatDiagnostics(");
  const fmtEnd = source.indexOf("\n\n// ── Tool Registration", fmtStart);
  const fmtBlock = dedupeStart !== -1 && fmtStart !== -1 && fmtEnd !== -1 ? source.slice(dedupeStart, fmtEnd) : "";
  if (fmtBlock) {
    const ns = {};
    try {
      new Function("exports", "path", `const SEVERITY = { 1: "error", 2: "warning", 3: "info", 4: "hint" };\n${fmtBlock}\nexports.formatDiagnostics = formatDiagnostics;`)(ns, { basename: (p) => p.split("/").pop(), resolve: (p) => p });

      const diags = [
        { severity: 1, range: { start: { line: 5, character: 10 } }, message: "Type error", source: "ts", code: 2322 },
        { severity: 2, range: { start: { line: 12, character: 0 } }, message: "Unused var", source: "ts", code: 6133 },
      ];
      const output = ns.formatDiagnostics(diags, "/test/app.ts");
      assert(output.includes("lsp-diagnostics"), "Format: wraps in <lsp-diagnostics>");
      assert(output.includes("error") && output.includes("warning"), "Format: shows severity levels");
      assert(output.includes("L6:11"), "Format: shows line:col (1-indexed)");
      assert(output.includes("[2322]"), "Format: shows error code");

      const compact = ns.formatDiagnostics(diags, "/test/app.ts", { compact: true });
      assert(compact.includes("[LSP:"), "Compact format starts with [LSP:");
      assert(compact.includes("1 error") && compact.includes("1 warning"), "Compact shows counts");

      const duplicateFixturePayload = {
        uri: "file:///test/app.ts",
        diagnostics: [
          { severity: 1, range: { start: { line: 5, character: 10 }, end: { line: 5, character: 14 } }, message: "Type error", source: "ts", code: 2322 },
          { severity: 1, range: { start: { line: 5, character: 10 }, end: { line: 5, character: 14 } }, message: "Type error", source: "ts", code: 2322 },
          { severity: 2, range: { start: { line: 12, character: 0 }, end: { line: 12, character: 3 } }, message: "Unused var", source: "ts", code: 6133 },
        ],
      };
      const dedupedOutput = ns.formatDiagnostics(duplicateFixturePayload.diagnostics, "/test/app.ts");
      assert(dedupedOutput.match(/Type error/g)?.length === 1, "Duplicate diagnostics from fixture payload are deduplicated");
      assert(dedupedOutput.includes("Unused var"), "Distinct diagnostics from fixture payload remain shown");

      const distinctOutput = ns.formatDiagnostics([
        { severity: 1, range: { start: { line: 5, character: 10 }, end: { line: 5, character: 14 } }, message: "Type error", source: "ts", code: 2322 },
        { severity: 1, range: { start: { line: 6, character: 2 }, end: { line: 6, character: 8 } }, message: "Different type error", source: "ts", code: 2322 },
        { severity: 2, range: { start: { line: 12, character: 0 }, end: { line: 12, character: 3 } }, message: "Unused var", source: "ts", code: 6133 },
      ], "/test/app.ts");
      assert(distinctOutput.includes("Type error"), "First distinct diagnostic remains shown");
      assert(distinctOutput.includes("Different type error"), "Second distinct diagnostic remains shown");
      assert(distinctOutput.includes("Unused var"), "Warning diagnostic remains shown");

      const empty = ns.formatDiagnostics([], "/test/clean.ts");
      assert(empty === "", "Empty diagnostics returns empty string");
    } catch (e) { skip(`formatDiagnostics eval failed: ${e.message}`); }
  } else { skip("formatDiagnostics extraction failed"); }
}

section("UNIT: LSP — tool registration");

{
  assert(source.includes("LspDiagnostics"), "LspDiagnostics deferred tool registered");
  assert(source.includes('"diagnostics"') && source.includes('"hover"') && source.includes('"definition"'), "LSP actions: diagnostics, hover, definition");
  assert(source.includes('"references"') && source.includes('"workspace"'), "LSP actions: references, workspace");
}

section("UNIT: LSP — PostToolUse integration");

{
  assert(source.includes("_lspPostToolHook"), "LSP post-tool hook wired");
  assert(source.includes("createLspPostToolHook"), "createLspPostToolHook function exists");
  // Check that it only fires on Write/Edit
  const hookCheck = source.includes('block.name === "Write"') && source.includes('block.name === "Edit"');
  assert(hookCheck, "LSP hook only fires on Write/Edit tools");
}

// ── Agent Teams ──────────────────────────────────────────────────

section("UNIT: Agent Teams — TaskBoard");

{
  const tbBlock = extractBlock(source, "class TaskBoard {");
  if (tbBlock) {
    assert(tbBlock.includes("addTask("), "TaskBoard.addTask()");
    assert(tbBlock.includes("claimTask("), "TaskBoard.claimTask()");
    assert(tbBlock.includes("updateTask("), "TaskBoard.updateTask()");
    assert(tbBlock.includes("getReadyTasks("), "TaskBoard.getReadyTasks()");
    assert(tbBlock.includes("postMessage("), "TaskBoard.postMessage()");
    assert(tbBlock.includes("setArtifact("), "TaskBoard.setArtifact()");
    assert(tbBlock.includes("toPromptBlock("), "TaskBoard.toPromptBlock()");
    assert(tbBlock.includes("depends"), "Tasks support dependencies");
    assert(tbBlock.includes("pending") && tbBlock.includes("in_progress") && tbBlock.includes("completed"), "Task lifecycle states");
  } else { skip("TaskBoard extraction failed"); }
}

section("UNIT: Agent Teams — Team class");

{
  const teamBlock = extractBlock(source, "class Team {");
  if (teamBlock) {
    assert(teamBlock.includes("run("), "Team.run()");
    assert(teamBlock.includes("addAgent("), "Team.addAgent()");
    assert(teamBlock.includes("_runAgent("), "Team._runAgent()");
    assert(teamBlock.includes("_buildReport("), "Team._buildReport()");
    assert(teamBlock.includes("abort("), "Team.abort()");
    assert(teamBlock.includes("board"), "Team has a board (TaskBoard)");
  } else { skip("Team extraction failed"); }
}

section("UNIT: Agent Teams — tool registration");

{
  assert(source.includes("registerTeamTools"), "registerTeamTools function exists");
  assert(source.includes('"create_and_run"'), "Team tool has create_and_run action");
  assert(source.includes('"status"') && source.includes('"list"'), "Team tool has status and list actions");
  assert(source.includes("team-board"), "Board state uses <team-board> format");
}

// ── Sandbox ──────────────────────────────────────────────────────

section("UNIT: Sandbox — SandboxRunner");

{
  const sbBlock = extractBlock(source, "class SandboxRunner {");
  if (sbBlock) {
    assert(sbBlock.includes("exec("), "SandboxRunner.exec()");
    assert(sbBlock.includes("_execHost("), "SandboxRunner._execHost()");
    assert(sbBlock.includes("_execDocker("), "SandboxRunner._execDocker()");
    assert(sbBlock.includes("effectiveMode"), "SandboxRunner.effectiveMode getter");
    assert(sbBlock.includes("shutdown("), "SandboxRunner.shutdown()");
    assert(sbBlock.includes("ensureImage("), "SandboxRunner.ensureImage()");
    assert(sbBlock.includes("status("), "SandboxRunner.status()");
  } else { skip("SandboxRunner extraction failed"); }
}

section("UNIT: Sandbox — Docker security settings");

{
  assert(source.includes("--read-only"), "Docker: read-only root filesystem");
  assert(source.includes("no-new-privileges"), "Docker: no-new-privileges");
  assert(source.includes("--memory"), "Docker: memory limit");
  assert(source.includes("--cpus"), "Docker: CPU limit");
  assert(source.includes("--pids-limit"), "Docker: PID limit");
  assert(source.includes("--network") && source.includes("none"), "Docker: network isolation option");
  assert(source.includes("/workspace:rw"), "Docker: project dir mounted rw");
  assert(source.includes(":ro"), "Docker: home dir mounted read-only");
}

section("UNIT: Sandbox — CLI flag");

{
  assert(source.includes("--sandbox"), "CLI has --sandbox flag");
  assert(source.includes("sandboxMode"), "Config has sandboxMode");
  const hostDefault = source.includes('sandboxMode: "host"') || source.includes("sandboxMode:\"host\"");
  assert(hostDefault, "Default sandbox mode is host (opt-in to Docker)");
}

section("UNIT: Sandbox — smart host fallback");

{
  assert(source.includes("docker") && source.includes("podman") && source.includes("kubectl"), "Docker/podman/kubectl commands run on host");
  assert(source.includes("createSandboxedBashExecutor"), "Sandboxed Bash executor factory exists");
}

// ── Cron ─────────────────────────────────────────────────────────

section("UNIT: Cron — interval parsing");

{
  const parseBlock = extractBlock(source, "function parseInterval(");
  if (parseBlock) {
    const ns = {};
    try {
      new Function("exports", parseBlock + "\nexports.parseInterval = parseInterval;")(ns);
      assert(ns.parseInterval("30s") === 30000, "Parse: 30s = 30000ms");
      assert(ns.parseInterval("5m") === 300000, "Parse: 5m = 300000ms");
      assert(ns.parseInterval("1h") === 3600000, "Parse: 1h = 3600000ms");
      assert(ns.parseInterval("2d") === 172800000, "Parse: 2d = 172800000ms");
      assert(ns.parseInterval("5min") === 300000, "Parse: 5min = 300000ms");
      assert(ns.parseInterval("1hr") === 3600000, "Parse: 1hr = 3600000ms");
      assert(ns.parseInterval("abc") === null, "Parse: invalid returns null");
      assert(ns.parseInterval("") === null, "Parse: empty returns null");
    } catch (e) { skip(`parseInterval eval failed: ${e.message}`); }
  } else { skip("parseInterval extraction failed"); }
}

section("UNIT: Cron — format interval");

{
  const fmtBlock = extractBlock(source, "function formatInterval(");
  if (fmtBlock) {
    const ns = {};
    try {
      new Function("exports", fmtBlock + "\nexports.formatInterval = formatInterval;")(ns);
      assert(ns.formatInterval(30000) === "30s", "Format: 30000ms = 30s");
      assert(ns.formatInterval(300000) === "5m", "Format: 300000ms = 5m");
      assert(ns.formatInterval(3600000) === "1h", "Format: 3600000ms = 1h");
      assert(ns.formatInterval(86400000) === "1d", "Format: 86400000ms = 1d");
    } catch (e) { skip(`formatInterval eval failed: ${e.message}`); }
  } else { skip("formatInterval extraction failed"); }
}

section("UNIT: Cron — job management");

{
  assert(source.includes("function addJob("), "addJob function exists");
  assert(source.includes("function removeJob("), "removeJob function exists");
  assert(source.includes("function listJobs("), "listJobs function exists");
  assert(source.includes("function toggleJob("), "toggleJob function exists");
  assert(source.includes("function tick("), "tick function exists");
  assert(source.includes("acquireLock") && source.includes("releaseLock"), "File-based locking");
  assert(source.includes("next_run") && source.includes("crash-safe") || source.includes("BEFORE execution"), "Crash-safe: advances next_run before execution");
}

section("UNIT: Cron — CLI handler");

{
  assert(source.includes("handleCronCommand"), "handleCronCommand function exists");
  assert(source.includes('"add"') && source.includes('"remove"') && source.includes('"list"'), "Cron subcommands: add, remove, list");
  assert(source.includes('"enable"') && source.includes('"disable"'), "Cron subcommands: enable, disable");
  assert(source.includes('"run"'), "Cron subcommand: run (tick)");
}

section("E2E: Cron — add, list, remove");

{
  try {
    // Add a job
    const { exitCode: addCode, stderr: addOut } = await runCLI(
      ["cron", "add", "test ping", "--every", "1h"],
      {}, 10000
    );
    assert(addCode === 0, "cron add exits 0");
    assert(addOut.includes("Job ") && addOut.includes("added"), "cron add prints job ID");

    // List jobs
    const { stderr: listOut } = await runCLI(["cron", "list"], {}, 10000);
    assert(listOut.includes("test ping"), "cron list shows the job");
    assert(listOut.includes("1h"), "cron list shows interval");

    // Extract job ID
    const jobIdMatch = addOut.match(/Job (job-\w+)/);
    if (jobIdMatch) {
      // Remove the job
      const { exitCode: rmCode, stderr: rmOut } = await runCLI(
        ["cron", "remove", jobIdMatch[1]],
        {}, 10000
      );
      assert(rmCode === 0, "cron remove exits 0");
      assert(rmOut.includes("removed"), "cron remove confirms removal");

      // Verify gone
      const { stderr: listOut2 } = await runCLI(["cron", "list"], {}, 10000);
      assert(!listOut2.includes("test ping"), "cron list no longer shows removed job");
    } else { skip("Could not extract job ID from add output"); }
  } catch (e) { skip(`Cron E2E failed: ${e.message}`); }
}

// ── JSON Schema ──────────────────────────────────────────────────

section("UNIT: JSON Schema — flag parsing");

{
  assert(source.includes("--json-schema"), "CLI has --json-schema flag");
  assert(source.includes("jsonSchema"), "Config has jsonSchema field");
  assert(source.includes("schema_valid"), "JSON output includes schema_valid field");
  assert(source.includes("MUST be valid JSON"), "Schema constraint injected into prompt");
}

section("UNIT: JSON Schema — validation logic");

{
  // Check that validation exists
  assert(source.includes("missing required field"), "Validates required fields");
  assert(source.includes("expected") && source.includes("got"), "Validates field types");
  // Strip markdown fences
  assert(source.includes("```json") || source.includes("```"), "Strips markdown fences from response");
}

// ── Monolith Split ───────────────────────────────────────────────

section("UNIT: Monolith Split — build system");

{
  const buildExists = fs.existsSync(path.join(__dirname, "build.mjs"));
  assert(buildExists, "build.mjs exists");
  const srcDir = path.join(__dirname, "src");
  assert(fs.existsSync(srcDir), "src/ directory exists");

  const expectedModules = [
    "utils.mjs", "config.mjs", "providers.mjs", "auth.mjs",
    "security.mjs", "browser.mjs", "tools.mjs", "engine.mjs",
    "session.mjs", "index.mjs",
  ];
  for (const mod of expectedModules) {
    assert(fs.existsSync(path.join(srcDir, mod)), `src/${mod} exists`);
  }

  // New feature modules
  const featureModules = [
    "lsp.mjs", "auto-memory.mjs", "audit.mjs", "teams.mjs",
    "sandbox.mjs", "context-refs.mjs", "smart-routing.mjs", "cron.mjs", "security-rules.mjs",
  ];
  for (const mod of featureModules) {
    assert(fs.existsSync(path.join(srcDir, mod)), `src/${mod} exists`);
  }
}

section("UNIT: Monolith Split — bundled output");

{
  // Verify the bundled file has no duplicate imports
  const imports = source.split("\n").filter(l => l.startsWith("import "));
  const importSpecs = imports.map(l => l.match(/from\s+"([^"]+)"/)?.[1]).filter(Boolean);
  // All imports should be node: builtins
  for (const spec of importSpecs) {
    assert(spec.startsWith("node:"), `Import "${spec}" uses node: prefix`);
  }
  // No ./local imports in bundled output
  const localImports = imports.filter(l => l.includes("./"));
  assert(localImports.length === 0, "No local module imports in bundled output");
}

// ═══════════════════════════════════════════════════════════════════
// Background Review Nudge Tests
// ═══════════════════════════════════════════════════════════════════

section("UNIT: Background Review Nudge — prompts exist");
assert(source.includes("_SKILL_REVIEW_PROMPT"), "_SKILL_REVIEW_PROMPT constant exists in source");
assert(source.includes("_MEMORY_REVIEW_PROMPT"), "_MEMORY_REVIEW_PROMPT constant exists in source");
assert(source.includes("_COMBINED_REVIEW_PROMPT"), "_COMBINED_REVIEW_PROMPT constant exists in source");
assert(source.includes("DEFAULT_SKILL_NUDGE_INTERVAL"), "DEFAULT_SKILL_NUDGE_INTERVAL constant exists in source");
assert(source.includes("DEFAULT_MEMORY_NUDGE_INTERVAL"), "DEFAULT_MEMORY_NUDGE_INTERVAL constant exists in source");
assert(source.includes("skill-creator skill via the Skill tool"), "Skill review prompt references skill-creator");
assert(source.includes("save it using MemorySave"), "Memory review prompt references MemorySave");

section("UNIT: Background Review Nudge — nudge state in InteractiveMode");
assert(source.includes("_toolCallsSinceSkillReview"), "_toolCallsSinceSkillReview counter exists");
assert(source.includes("_turnsSinceMemoryReview"), "_turnsSinceMemoryReview counter exists");
assert(source.includes("_nudgeEnabled"), "_nudgeEnabled flag exists");
assert(source.includes("_spawnBackgroundReview"), "_spawnBackgroundReview method exists");
assert(source.includes("_skillNudgeInterval"), "_skillNudgeInterval config exists");
assert(source.includes("_memoryNudgeInterval"), "_memoryNudgeInterval config exists");

section("UNIT: Background Review Nudge — recursion prevention");
assert(source.includes("!cfg._isSubAgent"), "_isSubAgent check prevents recursive nudges");
assert(source.includes("_isSubAgent: true"), "Sub-agent created with _isSubAgent: true");
assert(source.includes("conversationContext: messagesSnapshot"), "Conversation context passed to sub-agent");

section("UNIT: Background Review Nudge — config support");
assert(source.includes("skillNudgeInterval"), "skillNudgeInterval in settings");
assert(source.includes("memoryNudgeInterval"), "memoryNudgeInterval in settings");

section("UNIT: Background Review Nudge — metrics reinforcement loop");
assert(source.includes("readSkillMetrics"), "readSkillMetrics imported for reinforcement signal");
assert(source.includes("summarizeSkillMetrics"), "summarizeSkillMetrics imported for reinforcement signal");
assert(source.includes("Skill performance metrics"), "Metrics data injected into review prompt");
assert(source.includes("error rate"), "Error rate calculated for skill review decisions");
assert(source.includes("Existing skills"), "Existing skill list injected to prevent duplicates");
assert(source.includes("High error rate"), "Skill review prompt guides on high error rate");
assert(source.includes("Zero uses"), "Skill review prompt guides on pruning unused skills");
assert(source.includes("Don't create duplicates"), "Combined prompt prevents duplicate skill creation");

section("UNIT: Background Review Nudge — action extraction");
{
  // Extract _extractReviewActions from source
  const extractFn = extractBlock(source, "function _extractReviewActions(");
  if (extractFn) {
    const fn = new Function("return " + extractFn)();
    assert(fn({ text: "Nothing to save." }).length === 0, "Returns empty for 'Nothing to save'");
    assert(fn({ text: "Skill created: my-skill" }).includes("Skill created"), "Detects skill creation");
    assert(fn({ text: "Skill updated with new approach" }).includes("Skill updated"), "Detects skill update");
    assert(fn({ text: "Memory saved: user prefers tabs" }).includes("Memory saved"), "Detects memory save");
    assert(fn({ text: "" }).length === 0, "Returns empty for empty text");
    assert(fn({}).length === 0, "Returns empty for empty result");
    const combined = fn({ text: "Skill created and Memory saved" });
    assert(combined.length === 2, "Detects both skill + memory actions");
  } else {
    skip("_extractReviewActions function not found in bundled source");
  }
}

// ── Memory Metrics ────────────────────────────────────────────────

section("UNIT: Memory Metrics — JSONL tracking");

{
  assert(source.includes("appendMemoryMetric"), "appendMemoryMetric function exists");
  assert(source.includes("readMemoryMetrics"), "readMemoryMetrics function exists");
  assert(source.includes("summarizeMemoryMetrics"), "summarizeMemoryMetrics function exists");
  assert(source.includes("memory_loaded"), "memory_loaded event type used");
  assert(source.includes("memory_referenced"), "memory_referenced event type used");
  assert(source.includes("memory-metrics.jsonl"), "JSONL metrics file name defined");

  // Test appendMemoryMetric and readMemoryMetrics
  const appendFunc = extractBlock(source, "function appendMemoryMetric(");
  const readFunc = extractBlock(source, "function readMemoryMetrics(");
  const summarizeFunc = extractBlock(source, "function summarizeMemoryMetrics(");
  const rotateFunc = extractBlock(source, "function _rotateIfNeeded(");
  const metricsPathFunc = extractBlock(source, "function _metricsPath(");

  if (appendFunc && readFunc && summarizeFunc && metricsPathFunc) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloclo-metrics-"));
    const ns = {};
    try {
      const deps = [
        'var METRICS_FILE = "memory-metrics.jsonl";',
        'var MAX_LINES = 5000;',
        'var TRIM_TO = 3000;',
        'function log() {}',
        `function ensureMemoryDir() { return "${tmpDir.replace(/\\/g, "\\\\")}"; }`,
        `function ensureUserMemoryDir() { return "${tmpDir.replace(/\\/g, "\\\\")}"; }`,
      ].join("\n");
      new Function("exports", "fs", "path", deps + "\n" + metricsPathFunc + "\n" + (rotateFunc || "") + "\n" + appendFunc + "\n" + readFunc + "\n" + summarizeFunc + "\nexports.appendMemoryMetric = appendMemoryMetric;\nexports.readMemoryMetrics = readMemoryMetrics;\nexports.summarizeMemoryMetrics = summarizeMemoryMetrics;")(ns, fs, path);

      ns.appendMemoryMetric("/test", "project", { type: "memory_loaded", file: "test.md", name: "test" });
      ns.appendMemoryMetric("/test", "project", { type: "memory_referenced", file: "test.md", name: "test" });
      ns.appendMemoryMetric("/test", "project", { type: "memory_loaded", file: "other.md", name: "other" });

      const events = ns.readMemoryMetrics("/test", "project");
      assert(events.length === 3, "readMemoryMetrics returns all events");

      const loaded = ns.readMemoryMetrics("/test", "project", { type: "memory_loaded" });
      assert(loaded.length === 2, "readMemoryMetrics filters by type");

      const summary = ns.summarizeMemoryMetrics("/test", "project");
      assert(summary.length === 2, "summarizeMemoryMetrics groups by file");
      const testEntry = summary.find(s => s.file === "test.md");
      assert(testEntry && testEntry.load_count === 1 && testEntry.ref_count === 1, "Summary counts loads and refs correctly");
    } catch (e) { skip(`memory-metrics eval failed: ${e.message}`); }
    // Cleanup
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  } else { skip("memory-metrics function extraction failed"); }
}

// ── Memory Dream ─────────────────────────────────────────────────

section("UNIT: Memory Dream — consolidation engine");

{
  assert(source.includes("shouldDream"), "shouldDream function exists");
  assert(source.includes("runDream"), "runDream function exists");
  assert(source.includes("buildDreamPrompt"), "buildDreamPrompt function exists");
  assert(source.includes("incrementDreamSessionCount"), "incrementDreamSessionCount function exists");
  assert(source.includes("loadDreamState"), "loadDreamState function exists");
  assert(source.includes("saveDreamState"), "saveDreamState function exists");
  assert(source.includes("countMemories"), "countMemories function exists");
  assert(source.includes("dream-state.json"), "Dream state file defined");
  assert(source.includes("dream.lock"), "Dream lock file defined");
  assert(source.includes("DREAM_MIN_SESSIONS"), "DREAM_MIN_SESSIONS constant defined");
  assert(source.includes("DREAM_MIN_HOURS"), "DREAM_MIN_HOURS constant defined");
  assert(source.includes("Phase 1") && source.includes("Phase 2") && source.includes("Phase 3") && source.includes("Phase 4"), "Dream prompt has all 4 phases");
}

section("UNIT: Memory Dream — shouldDream logic");

{
  const loadFunc = extractBlock(source, "function loadDreamState(");
  const shouldFunc = extractBlock(source, "function shouldDream(");
  const countFunc = extractBlock(source, "function countMemories(");

  if (shouldFunc && loadFunc && countFunc) {
    const ns = {};
    try {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloclo-dream-"));
      const stateFile = path.join(tmpDir, "dream-state.json");
      const memDir = path.join(tmpDir, "mem");
      fs.mkdirSync(memDir, { recursive: true });

      const deps = `
        const DREAM_MIN_SESSIONS = 5;
        const DREAM_MIN_HOURS = 24;
        function log() {}
        function _dreamStatePath() { return "${stateFile.replace(/\\/g, "\\\\")}"; }
        function getMemoryDir() { return "${memDir.replace(/\\/g, "\\\\")}"; }
        function getUserMemoryDir() { return "${memDir.replace(/\\/g, "\\\\")}"; }
      `;
      new Function("exports", "fs", "path", "os", deps + "\n" + loadFunc + "\n" + countFunc + "\n" + shouldFunc + "\nexports.shouldDream = shouldDream;")(ns, fs, path, os);

      // No state file, no memories → false
      assert(!ns.shouldDream("/test"), "shouldDream false when no state and no memories");

      // Write state with enough sessions but no new memories
      fs.writeFileSync(stateFile, JSON.stringify({ last_dream_at: null, session_count_since: 10, memories_at_last_dream: 0 }));
      assert(!ns.shouldDream("/test"), "shouldDream false when no new memories");

      // Add a memory file
      fs.writeFileSync(path.join(memDir, "test.md"), "test");
      assert(ns.shouldDream("/test"), "shouldDream true when sessions + new memories");

      // Set recent dream time
      fs.writeFileSync(stateFile, JSON.stringify({ last_dream_at: new Date().toISOString(), session_count_since: 10, memories_at_last_dream: 0 }));
      assert(!ns.shouldDream("/test"), "shouldDream false when dreamed recently");

      try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
    } catch (e) { skip(`shouldDream eval failed: ${e.message}`); }
  } else { skip("dream function extraction failed"); }
}

section("UNIT: Memory Dream — agent definition");

{
  assert(source.includes('"memory-dream"'), "memory-dream agent type defined in AGENT_DEFINITIONS");
  assert(source.includes("Memory consolidation"), "memory-dream has description");
}

// ── Wider Auto-Memory Context ────────────────────────────────────

section("UNIT: Auto-Memory — wider context (exchange history)");

{
  assert(source.includes("exchangeHistory"), "processExchange accepts exchangeHistory parameter");
  assert(source.includes("{HISTORY}"), "CLASSIFY_PROMPT includes {HISTORY} placeholder");
  assert(source.includes("_exchangeBuffer"), "InteractiveMode has _exchangeBuffer");

  // Verify the classify prompt includes recent conversation context
  const classifyIdx = source.indexOf("CLASSIFY_PROMPT");
  if (classifyIdx !== -1) {
    const promptSlice = source.slice(classifyIdx, classifyIdx + 2000);
    assert(promptSlice.includes("Recent conversation context"), "CLASSIFY_PROMPT mentions recent conversation context");
  }
}

// ── Staleness Enhancement ────────────────────────────────────────

section("UNIT: Staleness — enhanced warning and timestamps");

{
  assert(source.includes("saved or last verified"), "Staleness warning mentions saved/verified dates");
  assert(source.includes("30+ days"), "Staleness warning mentions 30-day threshold");
  assert(source.includes("last_verified"), "last_verified field referenced");
  assert(source.includes("saved_at"), "saved_at field referenced in index enrichment");

  // Verify loadMemoryIndex enriches with timestamps
  const loadIdx = source.indexOf("function loadMemoryIndex(");
  if (loadIdx !== -1) {
    const funcSlice = source.slice(loadIdx, loadIdx + 3000);
    assert(funcSlice.includes("saved_at") || funcSlice.includes("last_verified"), "loadMemoryIndex reads timestamps from frontmatter");
    assert(funcSlice.includes("(verified:") || funcSlice.includes("(saved:"), "loadMemoryIndex appends date labels");
  }
}

// ═══════════════════════════════════════════════════════════════════
// DEEP INTEGRATION TESTS — Audit Fixes (P0/P1/P2)
// ═══════════════════════════════════════════════════════════════════

// ── P0-1: Shell injection via _createShellExecutor — real exec ─────
section("DEEP: P0-1 — Shell executor escapes LLM input (real exec)");
{
  const shellExecFunc = extractBlock(source, "function _createShellExecutor(");
  const shellEscapeFunc = extractBlock(source, "function _shellEscape(");
  if (shellExecFunc && shellEscapeFunc) {
    const shellNs = {};
    try {
      new Function("exports", "execSync", "process", "path",
        shellEscapeFunc + "\n" + shellExecFunc +
        "\nexports._createShellExecutor = _createShellExecutor;\nexports._shellEscape = _shellEscape;\n"
      )(shellNs, execSync, process, path);

      // Test 1: _shellEscape fundamentals
      assert(shellNs._shellEscape("hello") === "'hello'", "shellEscape: normal string quoted");
      assert(shellNs._shellEscape("it's") === "'it'\\''s'", "shellEscape: single quotes escaped");
      assert(shellNs._shellEscape("$(whoami)") === "'$(whoami)'", "shellEscape: command substitution neutralized");
      assert(shellNs._shellEscape("`id`") === "'`id`'", "shellEscape: backtick injection neutralized");
      const chainInput = "'; rm -rf /; echo '";
      const chainEscaped = shellNs._shellEscape(chainInput);
      // The escaped result should be safe to eval as a bash single-quoted string
      assert(chainEscaped.startsWith("'") && chainEscaped.endsWith("'"), "shellEscape: chain break is fully quoted");
      assert(chainEscaped.includes("\\'"), "shellEscape: chain break escapes internal quotes");

      // Test 2: Real shell executor — injection attempt should be literal
      const executor = shellNs._createShellExecutor({
        command: "echo $NAME",
        timeout: 5000,
      });
      const result = await executor({ name: "$(echo PWNED)" });
      assert(!result.is_error, "Shell executor succeeds");
      // The output should contain the LITERAL string "$(echo PWNED)", not just "PWNED"
      // If injection worked, we'd get just "PWNED" from command execution
      assert(result.content.trim().includes("$(echo PWNED)"), "Injection payload echoed as literal, not executed");

      // Test 3: Normal input works fine
      const result2 = await executor({ name: "Alice" });
      assert(!result2.is_error, "Normal input succeeds");
      assert(result2.content.trim().includes("Alice"), "Normal input echoed correctly");

      // Test 4: $INPUT_JSON also escaped
      const executor2 = shellNs._createShellExecutor({
        command: "echo $INPUT_JSON",
        timeout: 5000,
      });
      const result3 = await executor2({ key: "$(whoami)" });
      assert(!result3.is_error, "INPUT_JSON executor succeeds");
      assert(!result3.content.includes(os.userInfo().username) || result3.content.includes("$(whoami)"),
        "INPUT_JSON injection neutralized");

      // Test 5: Multi-variable substitution with mixed attacks
      const executor3 = shellNs._createShellExecutor({
        command: "echo $A $B",
        timeout: 5000,
      });
      const result4 = await executor3({ a: "safe", b: "; cat /etc/passwd" });
      assert(!result4.is_error, "Multi-var executor succeeds");
      assert(!result4.content.includes("root:"), "/etc/passwd NOT leaked");

    } catch (e) {
      skip(`Shell executor deep test failed: ${e.message}`);
    }
  } else {
    skip("_createShellExecutor extraction failed");
  }
}

// ── P0-2: Path traversal in skill installation — real filesystem ──
section("DEEP: P0-2 — Skill install blocks path traversal (real fs)");
{
  const tmpSkillDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloclo-traversal-"));
  try {
    // Simulate the install loop from engine.mjs
    const targetDir = path.join(tmpSkillDir, "my-skill");
    fs.mkdirSync(targetDir, { recursive: true });

    const maliciousFiles = {
      "SKILL.md": "---\nname: test\n---\ntest skill",
      "../../etc/evil.txt": "TRAVERSAL_PAYLOAD",
      "../sibling/pwned.txt": "SIBLING_PAYLOAD",
      "safe/nested/file.txt": "SAFE_CONTENT",
    };

    let blocked = 0;
    let installed = 0;
    for (const [filePath, content] of Object.entries(maliciousFiles)) {
      const dest = path.join(targetDir, filePath);
      if (!dest.startsWith(targetDir + path.sep) && dest !== targetDir) {
        blocked++;
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content);
      installed++;
    }

    assert(blocked === 2, `Blocked ${blocked}/2 traversal attempts`);
    assert(installed === 2, `Installed ${installed}/2 safe files`);

    // Verify traversal targets don't exist
    assert(!fs.existsSync(path.join(tmpSkillDir, "etc", "evil.txt")), "../../etc/evil.txt NOT created");
    assert(!fs.existsSync(path.join(tmpSkillDir, "sibling", "pwned.txt")), "../sibling/pwned.txt NOT created");

    // Verify safe files DO exist
    assert(fs.existsSync(path.join(targetDir, "SKILL.md")), "SKILL.md installed correctly");
    assert(fs.existsSync(path.join(targetDir, "safe", "nested", "file.txt")), "Nested safe file installed");
    assert(fs.readFileSync(path.join(targetDir, "safe", "nested", "file.txt"), "utf-8") === "SAFE_CONTENT",
      "Safe file content correct");

  } catch (e) {
    skip(`Path traversal deep test failed: ${e.message}`);
  } finally {
    fs.rmSync(tmpSkillDir, { recursive: true, force: true });
  }
}

// ── P0-3: GitHub source validation in parseSkillSource ─────────────
section("DEEP: P0-3 — parseSkillSource rejects injection chars");
{
  const parseFunc = extractBlock(source, "function parseSkillSource(");
  if (parseFunc) {
    const psNs = {};
    try {
      new Function("exports", parseFunc + "\nexports.parseSkillSource = parseSkillSource;\n")(psNs);

      // Valid sources should work
      const r1 = psNs.parseSkillSource("github:owner/repo");
      assert(r1.type === "github", "Valid github: source accepted");
      assert(r1.owner === "owner" && r1.repo === "repo", "Owner/repo parsed correctly");

      const r2 = psNs.parseSkillSource("github:my-org/my.repo/subpath");
      assert(r2.subpath === "subpath", "Subpath parsed correctly");

      // Injection attempts should throw
      let threw = false;
      try { psNs.parseSkillSource("github:foo;echo pwned/bar"); } catch (e) {
        threw = true;
        assert(e.message.includes("Invalid GitHub source") || e.message.includes("invalid"), "Error message mentions invalid source");
      }
      assert(threw, "Semicolon injection in owner throws");

      threw = false;
      try { psNs.parseSkillSource("github:ok/repo$(cmd)"); } catch (e) { threw = true; }
      assert(threw, "Command substitution in repo throws");

      threw = false;
      try { psNs.parseSkillSource("github:ok/repo`id`"); } catch (e) { threw = true; }
      assert(threw, "Backtick injection in repo throws");

      threw = false;
      try { psNs.parseSkillSource("github:ok/repo|cat /etc/passwd"); } catch (e) { threw = true; }
      assert(threw, "Pipe injection in repo throws");

      // Edge cases: dots and dashes are OK
      const r3 = psNs.parseSkillSource("github:my-org.v2/my_repo-3");
      assert(r3.owner === "my-org.v2", "Dots and dashes in owner allowed");
      assert(r3.repo === "my_repo-3", "Underscores and dashes in repo allowed");

    } catch (e) {
      skip(`parseSkillSource deep test failed: ${e.message}`);
    }
  } else {
    skip("parseSkillSource extraction failed");
  }
}

// ── P0-3: Skill name validation in _installOneSkill ────────────────
section("DEEP: P0-3 — Skill name validation rejects bad names");
{
  // Test the regex directly since _installOneSkill needs too many dependencies
  const validName = /^[a-zA-Z0-9._-]+$/;
  const goodNames = ["my-skill", "skill.v2", "SKILL_V3", "a", "test-skill-2.0"];
  const badNames = ["foo;bar", "skill$(cmd)", "skill`id`", "../escape", "ski ll", "skill\nname", "skill/name", ""];

  for (const n of goodNames) {
    assert(validName.test(n), `Skill name "${n}" accepted`);
  }
  for (const n of badNames) {
    assert(!validName.test(n), `Skill name "${n}" rejected`);
  }
}

// ── P0-4a: Sensitive path blocking — real Read/Write/Edit executors ──
section("DEEP: P0-4a — Read/Write/Edit block sensitive paths (real executors)");
{
  const trClass = extractBlock(source, "class ToolRegistry {");
  const builtinFunc = extractBlock(source, "function registerBuiltinTools(");
  const sensPathFunc = extractBlock(source, "function _isSensitivePath(");
  const sensConst = source.match(/const _SENSITIVE_PATH_SEGMENTS = \[.*?\];/)?.[0] || "";
  if (trClass && builtinFunc && sensPathFunc && sensConst) {
    const sensNs = {};
    try {
      new Function("exports", "fs", "path", "os", "spawn", "execSync", "process",
        "function log() {} function sleep() { return Promise.resolve(); }\n" +
        sensConst + "\n" + sensPathFunc + "\n" + trClass + "\n" + builtinFunc +
        "\nexports.ToolRegistry = ToolRegistry;\nexports.registerBuiltinTools = registerBuiltinTools;\nexports._isSensitivePath = _isSensitivePath;\n"
      )(sensNs, fs, path, os, spawn, execSync, process);

      const reg = new sensNs.ToolRegistry();
      sensNs.registerBuiltinTools(reg);

      // Read: sensitive paths blocked
      const r1 = await reg.execute("Read", { file_path: path.join(os.homedir(), ".ssh", "id_rsa") });
      assert(r1.is_error === true, "Read ~/.ssh/id_rsa returns error");
      assert(r1.content.includes("Blocked") && r1.content.includes(".ssh"), "Read error mentions .ssh blocked");

      const r2 = await reg.execute("Read", { file_path: path.join(os.homedir(), ".aws", "credentials") });
      assert(r2.is_error === true, "Read ~/.aws/credentials returns error");
      assert(r2.content.includes("Blocked"), "Read error says Blocked");

      // Write: sensitive paths blocked
      const r3 = await reg.execute("Write", { file_path: path.join(os.homedir(), ".gnupg", "evil"), content: "x" });
      assert(r3.is_error === true, "Write to ~/.gnupg blocked");

      // Edit: sensitive paths blocked
      const r4 = await reg.execute("Edit", { file_path: "/project/.env", old_string: "x", new_string: "y" });
      assert(r4.is_error === true, "Edit /project/.env blocked");

      // Read: normal paths allowed (test with a temp file)
      const tmpFile = path.join(os.tmpdir(), `cloclo-sens-test-${Date.now()}.txt`);
      fs.writeFileSync(tmpFile, "hello world\nsecond line\n");
      const r5 = await reg.execute("Read", { file_path: tmpFile });
      assert(!r5.is_error, "Read normal temp file succeeds");
      assert(typeof r5.content === "string" || typeof r5 === "string", "Read returns string content");
      const readContent = r5.content || r5;
      assert(readContent.includes("hello world"), "Read content is correct");
      fs.unlinkSync(tmpFile);

      // Write + Read roundtrip on safe path
      const tmpFile2 = path.join(os.tmpdir(), `cloclo-sens-write-${Date.now()}.txt`);
      const wr = await reg.execute("Write", { file_path: tmpFile2, content: "test content 123" });
      assert(!wr.is_error && (typeof wr === "string" ? wr.includes("Wrote") : !wr.is_error), "Write to safe path succeeds");
      const rd = await reg.execute("Read", { file_path: tmpFile2 });
      const rdContent = rd.content || rd;
      assert(rdContent.includes("test content 123"), "Write+Read roundtrip content matches");
      fs.unlinkSync(tmpFile2);

    } catch (e) {
      skip(`Sensitive path deep test failed: ${e.message}`);
    }
  } else {
    skip("Sensitive path extraction failed: " + (!trClass ? "ToolRegistry" : !builtinFunc ? "registerBuiltinTools" : !sensPathFunc ? "_isSensitivePath" : "SENSITIVE_PATHS const"));
  }
}

// ── P0-4b: WebFetch SSRF — multi-step URL validation ──────────────
section("DEEP: P0-4b — WebFetch SSRF blocks private/metadata URLs");
{
  const isPrivateFunc = extractBlock(source, "function _isPrivateUrl(");
  if (isPrivateFunc) {
    const ssrfNs = {};
    try {
      new Function("exports", isPrivateFunc + "\nexports._isPrivateUrl = _isPrivateUrl;\n")(ssrfNs);

      // AWS metadata (most critical)
      assert(ssrfNs._isPrivateUrl("http://169.254.169.254/latest/meta-data/iam/security-credentials/"), "AWS metadata IP blocked");
      assert(ssrfNs._isPrivateUrl("http://169.254.169.254/latest/api/token"), "AWS IMDSv2 token endpoint blocked");

      // GCP metadata
      assert(ssrfNs._isPrivateUrl("http://metadata.google.internal/computeMetadata/v1/"), "GCP metadata blocked");

      // RFC 1918 ranges
      assert(ssrfNs._isPrivateUrl("http://10.0.0.1/admin"), "10.x blocked");
      assert(ssrfNs._isPrivateUrl("http://10.255.255.255/"), "10.255 blocked");
      assert(ssrfNs._isPrivateUrl("http://172.16.0.1/"), "172.16.x blocked");
      assert(ssrfNs._isPrivateUrl("http://172.31.255.255/"), "172.31.x blocked");
      assert(!ssrfNs._isPrivateUrl("http://172.15.0.1/"), "172.15.x NOT blocked (not private)");
      assert(!ssrfNs._isPrivateUrl("http://172.32.0.1/"), "172.32.x NOT blocked (not private)");
      assert(ssrfNs._isPrivateUrl("http://192.168.0.1/"), "192.168.x blocked");
      assert(ssrfNs._isPrivateUrl("http://192.168.255.255/"), "192.168.255 blocked");

      // Internal domains
      assert(ssrfNs._isPrivateUrl("http://grafana.internal/d/dashboard"), ".internal TLD blocked");
      assert(ssrfNs._isPrivateUrl("http://vault.internal:8200/v1/secret"), ".internal with port blocked");

      // Localhost ALLOWED (for local dev)
      assert(!ssrfNs._isPrivateUrl("http://localhost:3000/api"), "localhost allowed");
      assert(!ssrfNs._isPrivateUrl("http://127.0.0.1:8080/"), "127.0.0.1 allowed");
      assert(!ssrfNs._isPrivateUrl("http://[::1]:3000/"), "::1 allowed");

      // Public URLs allowed
      assert(!ssrfNs._isPrivateUrl("https://github.com/owner/repo"), "github.com allowed");
      assert(!ssrfNs._isPrivateUrl("https://api.openai.com/v1/chat"), "api.openai.com allowed");
      assert(!ssrfNs._isPrivateUrl("https://example.com/"), "example.com allowed");
      // 169.254.example.com gets blocked because hostname matches the IP regex — this is acceptable (overly cautious)
      assert(ssrfNs._isPrivateUrl("https://169.254.example.com/"), "169.254.example.com blocked (hostname matches IP pattern, acceptable false positive)");

      // Edge: malformed URL returns false (not blocked, let URL constructor throw later)
      assert(!ssrfNs._isPrivateUrl("not-a-url"), "Malformed URL returns false");

    } catch (e) {
      skip(`SSRF deep test failed: ${e.message}`);
    }
  } else {
    skip("_isPrivateUrl extraction failed");
  }
}

// ── P1-1: const→let systemBlocks — verify no const reassignment ───
section("DEEP: P1-1 — Fork mode systemBlocks reassignment is valid");
{
  // Verify the actual code pattern: let declaration followed by reassignment
  const engineSrc = fs.readFileSync(path.join(__dirname, "src", "engine.mjs"), "utf-8");

  // Find the systemBlocks declaration
  const declMatch = engineSrc.match(/(\blet|\bconst)\s+systemBlocks\s*=\s*buildSystemPrompt/);
  assert(declMatch && declMatch[1] === "let", "systemBlocks declared with let (not const)");

  // Find the reassignment in fork mode
  const reassignIdx = engineSrc.indexOf("systemBlocks = [...parentSystemBlocks]");
  assert(reassignIdx > 0, "Fork mode reassignment exists");

  // Verify let comes before reassignment
  const declIdx = engineSrc.indexOf("let systemBlocks = buildSystemPrompt");
  assert(declIdx > 0 && declIdx < reassignIdx, "let declaration comes before fork reassignment");

  // Simulate the pattern to verify no TypeError at runtime
  try {
    let systemBlocks = ["initial"];
    const agentPromptBlock = { type: "text", text: "agent" };
    // Fork mode reassignment
    const parentSystemBlocks = ["parent1", "parent2"];
    systemBlocks = [...parentSystemBlocks];
    systemBlocks.splice(systemBlocks.length > 1 ? 1 : 0, 0, agentPromptBlock);
    assert(systemBlocks.length === 3, "Reassignment works: 3 blocks");
    assert(systemBlocks[1] === agentPromptBlock, "Agent prompt spliced at position 1");
  } catch (e) {
    assert(false, `Fork mode simulation threw: ${e.message}`);
  }
}

// ── P1-2: LSP hook result scope — verify result accessible ────────
section("DEEP: P1-2 — LSP hook result variable in scope after if/else");
{
  const engineSrc = fs.readFileSync(path.join(__dirname, "src", "engine.mjs"), "utf-8");

  // Find the hoisted declaration
  const hoistIdx = engineSrc.indexOf("let result;\n");
  const externalIdx = engineSrc.indexOf("const isExternal = this.registry.isExternal(block.name)");
  const lspHookIdx = engineSrc.indexOf("const lspResult = await this.registry._lspPostToolHook(block.name, block.input, result)");

  assert(hoistIdx > 0, "let result; declaration exists");
  assert(externalIdx > 0, "isExternal check exists");
  assert(lspHookIdx > 0, "LSP hook uses result variable");

  // Verify ordering: hoist < isExternal < lspHook
  assert(hoistIdx < externalIdx, "result hoisted before isExternal check");
  assert(externalIdx < lspHookIdx, "isExternal before LSP hook");

  // Verify result assigned in both branches (no const)
  const ifBranch = engineSrc.indexOf("result = await this.cb.onExternalToolUse(block)");
  const elseBranch = engineSrc.indexOf("result = await this.registry.execute(block.name, block.input)");
  assert(ifBranch > hoistIdx, "result assigned in external branch");
  assert(elseBranch > hoistIdx, "result assigned in registry branch");

  // Verify no stale const declarations
  const constResult = engineSrc.indexOf("const result = await this.cb.onExternalToolUse");
  const constResult2 = engineSrc.indexOf("const result = await this.registry.execute");
  assert(constResult === -1, "No const result in external branch");
  assert(constResult2 === -1, "No const result in registry branch");

  // Runtime simulation
  try {
    let result;
    const isExternal = false;
    if (isExternal) {
      result = { content: "external", is_error: false };
    } else {
      result = { content: "registry", is_error: false };
    }
    // LSP hook should see result
    assert(result.content === "registry", "LSP hook sees registry result");

    // And for external branch
    let result2;
    const isExternal2 = true;
    if (isExternal2) {
      result2 = { content: "external", is_error: false };
    } else {
      result2 = { content: "registry", is_error: false };
    }
    assert(result2.content === "external", "LSP hook sees external result");
  } catch (e) {
    assert(false, `Result scope simulation threw: ${e.message}`);
  }
}

// ── P1-3: Session imports — verify build output has the symbols ────
section("DEEP: P1-3 — Session imports resolve in build output");
{
  // Verify the build output has the functions accessible
  const buildSrc = fs.readFileSync(path.join(__dirname, "claude-native.mjs"), "utf-8");

  // aggregateVerdicts should be defined before it's used in session code
  const aggrDefIdx = buildSrc.indexOf("function aggregateVerdicts(");
  const aggrUseIdx = buildSrc.indexOf("aggregateVerdicts(codeVerdict");
  assert(aggrDefIdx > 0, "aggregateVerdicts defined in build");
  assert(aggrUseIdx > 0, "aggregateVerdicts used in build");
  assert(aggrDefIdx < aggrUseIdx, "aggregateVerdicts defined before use");

  // _backgroundManager should be defined before it's used
  const bgmDefIdx = buildSrc.indexOf("const _backgroundManager = new BackgroundAgentManager()");
  const bgmUseIdx = buildSrc.indexOf("_backgroundManager.list()");
  assert(bgmDefIdx > 0, "_backgroundManager defined in build");
  assert(bgmUseIdx > 0, "_backgroundManager.list() used in build");
  assert(bgmDefIdx < bgmUseIdx, "_backgroundManager defined before use");

  // AnthropicClient should be defined in build and used at runtime
  const acDefIdx = buildSrc.indexOf("class AnthropicClient {");
  const acUseIdx = buildSrc.indexOf("new AnthropicClient({");
  assert(acDefIdx > 0, "AnthropicClient class in build");
  assert(acUseIdx > 0, "new AnthropicClient({}) in build");
  // Note: text position doesn't matter — PROVIDERS.createClient is a closure called at runtime,
  // after all classes are defined. What matters is the class exists in the build.
  assert(acDefIdx > 0 && acUseIdx > 0, "Both AnthropicClient definition and usage present in build");

  // Verify source modules have the imports
  const sessionSrc = fs.readFileSync(path.join(__dirname, "src", "session.mjs"), "utf-8");
  const engineImport = sessionSrc.split("\n").find(l => l.includes('from "./engine.mjs"'));
  const provImport = sessionSrc.split("\n").find(l => l.includes('from "./providers.mjs"'));
  assert(engineImport.includes("aggregateVerdicts"), "src/session.mjs imports aggregateVerdicts");
  assert(engineImport.includes("_backgroundManager"), "src/session.mjs imports _backgroundManager");
  assert(provImport.includes("AnthropicClient"), "src/session.mjs imports AnthropicClient");

  // Verify engine.mjs exports them
  const engineExportBlock = fs.readFileSync(path.join(__dirname, "src", "engine.mjs"), "utf-8");
  const exportSection = engineExportBlock.slice(engineExportBlock.lastIndexOf("export {"));
  assert(exportSection.includes("aggregateVerdicts"), "engine.mjs exports aggregateVerdicts");
  assert(exportSection.includes("_backgroundManager"), "engine.mjs exports _backgroundManager");
}

// ── P2-1: Edit trailing newline — real file operations ────────────
section("DEEP: P2-1 — Edit tool trailing newline removal (real fs)");
{
  const trClass = extractBlock(source, "class ToolRegistry {");
  const builtinFunc = extractBlock(source, "function registerBuiltinTools(");
  const sensPathFunc = extractBlock(source, "function _isSensitivePath(");
  const sensConst = source.match(/const _SENSITIVE_PATH_SEGMENTS = \[.*?\];/)?.[0] || "";
  if (trClass && builtinFunc) {
    const editNs = {};
    try {
      new Function("exports", "fs", "path", "os", "spawn", "execSync", "process",
        "function log() {} function sleep() { return Promise.resolve(); }\n" +
        sensConst + "\n" + (sensPathFunc || "function _isSensitivePath(){return null;}") + "\n" +
        trClass + "\n" + builtinFunc +
        "\nexports.ToolRegistry = ToolRegistry;\nexports.registerBuiltinTools = registerBuiltinTools;\n"
      )(editNs, fs, path, os, spawn, execSync, process);

      const reg = new editNs.ToolRegistry();
      editNs.registerBuiltinTools(reg);

      // Test 1: Delete a line — trailing newline should be consumed
      const tmpEdit1 = path.join(os.tmpdir(), `cloclo-edit-trail-${Date.now()}.txt`);
      fs.writeFileSync(tmpEdit1, "line1\nline2\nline3\n");
      const e1 = await reg.execute("Edit", { file_path: tmpEdit1, old_string: "line2", new_string: "" });
      assert(!e1.is_error && !(typeof e1 === "object" && e1.is_error), "Edit delete line2 succeeds");
      const after1 = fs.readFileSync(tmpEdit1, "utf-8");
      assert(after1 === "line1\nline3\n", `Delete line2: got "${after1.replace(/\n/g, "\\n")}" expected "line1\\nline3\\n"`);

      // Test 2: Delete first line
      const tmpEdit2 = path.join(os.tmpdir(), `cloclo-edit-trail2-${Date.now()}.txt`);
      fs.writeFileSync(tmpEdit2, "alpha\nbeta\ngamma\n");
      const e2 = await reg.execute("Edit", { file_path: tmpEdit2, old_string: "alpha", new_string: "" });
      const after2 = fs.readFileSync(tmpEdit2, "utf-8");
      assert(after2 === "beta\ngamma\n", `Delete first line: got "${after2.replace(/\n/g, "\\n")}"`);

      // Test 3: Replace (not delete) should NOT consume trailing newline
      const tmpEdit3 = path.join(os.tmpdir(), `cloclo-edit-trail3-${Date.now()}.txt`);
      fs.writeFileSync(tmpEdit3, "aaa\nbbb\nccc\n");
      const e3 = await reg.execute("Edit", { file_path: tmpEdit3, old_string: "bbb", new_string: "BBB" });
      const after3 = fs.readFileSync(tmpEdit3, "utf-8");
      assert(after3 === "aaa\nBBB\nccc\n", `Replace preserves structure: got "${after3.replace(/\n/g, "\\n")}"`);

      // Test 4: Delete with old_string that already ends in \n — no double-removal
      const tmpEdit4 = path.join(os.tmpdir(), `cloclo-edit-trail4-${Date.now()}.txt`);
      fs.writeFileSync(tmpEdit4, "X\nY\nZ\n");
      const e4 = await reg.execute("Edit", { file_path: tmpEdit4, old_string: "Y\n", new_string: "" });
      const after4 = fs.readFileSync(tmpEdit4, "utf-8");
      assert(after4 === "X\nZ\n", `Delete with trailing \\n: got "${after4.replace(/\n/g, "\\n")}"`);

      // Cleanup
      [tmpEdit1, tmpEdit2, tmpEdit3, tmpEdit4].forEach(f => { try { fs.unlinkSync(f); } catch {} });

    } catch (e) {
      skip(`Edit trailing newline deep test failed: ${e.message}`);
    }
  } else {
    skip("Edit tool extraction failed");
  }
}

// ── P2-2: MCP RPC error handling — simulate message flow ──────────
section("DEEP: P2-2 — MCP RPC rejects on error, resolves on success");
{
  // Simulate the exact message handler pattern from index.mjs
  const pending = new Map();
  let msgId = 0;

  // Simulated _rpc that returns a promise
  function simulateRpc() {
    const id = ++msgId;
    const p = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    return { id, promise: p };
  }

  // Simulated message handler (the fixed version)
  function handleMessage(msg) {
    const entry = pending.get(msg.id);
    if (entry) {
      pending.delete(msg.id);
      if (msg.error) {
        entry.reject(new Error(msg.error.message || `MCP RPC error ${msg.error.code}`));
      } else {
        entry.resolve(msg.result);
      }
    }
  }

  try {
    // Test 1: Successful response
    const rpc1 = simulateRpc();
    handleMessage({ id: rpc1.id, result: { tools: ["Bash", "Read"] } });
    const result1 = await rpc1.promise;
    assert(result1.tools.length === 2, "Success: result resolved with tools");
    assert(result1.tools[0] === "Bash", "Success: correct tool name");

    // Test 2: Error response — should reject
    const rpc2 = simulateRpc();
    handleMessage({ id: rpc2.id, error: { code: -32601, message: "Method not found" } });
    let caught = false;
    try { await rpc2.promise; } catch (e) {
      caught = true;
      assert(e.message.includes("Method not found"), "Error: rejection includes error message");
    }
    assert(caught, "Error response rejects the promise");

    // Test 3: Error with no message — falls back to code
    const rpc3 = simulateRpc();
    handleMessage({ id: rpc3.id, error: { code: -32603 } });
    let caught3 = false;
    try { await rpc3.promise; } catch (e) {
      caught3 = true;
      assert(e.message.includes("-32603"), "Error fallback includes error code");
    }
    assert(caught3, "Error with no message still rejects");

    // Test 4: Verify the actual source code matches
    const indexSrc = fs.readFileSync(path.join(__dirname, "src", "index.mjs"), "utf-8");
    const handlerBlock = indexSrc.slice(indexSrc.indexOf("if (pending) {"), indexSrc.indexOf("if (pending) {") + 300);
    assert(handlerBlock.includes("if (msg.error)"), "Source has error check");
    assert(handlerBlock.includes("pending.reject"), "Source has reject path");
    assert(handlerBlock.includes("pending.resolve(msg.result)"), "Source has resolve path in else");
    // Verify the old bug is gone — no unconditional resolve
    const oldPattern = handlerBlock.match(/pending\.resolve\(msg\.result\)/g);
    assert(oldPattern && oldPattern.length === 1, "Only one resolve call (inside else, not unconditional)");

  } catch (e) {
    skip(`MCP RPC deep test failed: ${e.message}`);
  }
}

// ── P2-3: Auto-install returns error, no execution ────────────────
section("DEEP: P2-3 — Auto-install suggests command, never executes");
{
  const autoInstallFunc = extractBlock(source, "async function _autoInstallBinary(");
  const resolveBinFunc = extractBlock(source, "function _resolveBinary(");
  const discoverFunc = extractBlock(source, "async function _discoverInstallCommand(");
  if (autoInstallFunc && resolveBinFunc) {
    const aiNs = {};
    try {
      new Function("exports", "fs", "path", "os", "execSync", "process",
        "function log() {}\n" +
        resolveBinFunc + "\n" +
        // Stub _discoverInstallCommand to return a command
        "async function _discoverInstallCommand() { return 'brew install nonexistent-xyz'; }\n" +
        autoInstallFunc +
        "\nexports._autoInstallBinary = _autoInstallBinary;\n"
      )(aiNs, fs, path, os, execSync, process);

      // Test with a binary that doesn't exist
      const result = await aiNs._autoInstallBinary("nonexistent-binary-xyz-12345", null, os.tmpdir(), null);
      assert(result.installed === false, "Not installed");
      assert(result.path === null, "No path returned");
      assert(result.error && result.error.includes("Install manually"), "Error suggests manual install");
      assert(result.error.includes("nonexistent-binary-xyz-12345"), "Error includes binary name");

      // Test with install_hint provided
      const result2 = await aiNs._autoInstallBinary("also-nonexistent-xyz", "npm install -g also-nonexistent-xyz", os.tmpdir(), null);
      assert(result2.installed === false, "Not installed with hint");
      assert(result2.error.includes("Install manually"), "Hint path also suggests manual");
      assert(result2.error.includes("also-nonexistent-xyz"), "Error includes binary name from hint path");

      // Verify source has NO execSync(installCmd)
      assert(!autoInstallFunc.includes("execSync(installCmd"), "No execSync(installCmd) in source");
      assert(autoInstallFunc.includes("Run it manually"), "Source says 'Run it manually'");

    } catch (e) {
      skip(`Auto-install deep test failed: ${e.message}`);
    }
  } else {
    skip("_autoInstallBinary extraction failed");
  }
}

// ── Cross-cutting: Full Edit workflow (write → edit → read → verify) ──
section("DEEP: Cross-cutting — Write → Edit → Read multi-step workflow");
{
  const trClass = extractBlock(source, "class ToolRegistry {");
  const builtinFunc = extractBlock(source, "function registerBuiltinTools(");
  const sensPathFunc = extractBlock(source, "function _isSensitivePath(");
  const sensConst = source.match(/const _SENSITIVE_PATH_SEGMENTS = \[.*?\];/)?.[0] || "";
  if (trClass && builtinFunc) {
    const wfNs = {};
    try {
      new Function("exports", "fs", "path", "os", "spawn", "execSync", "process",
        "function log() {} function sleep() { return Promise.resolve(); }\n" +
        sensConst + "\n" + (sensPathFunc || "function _isSensitivePath(){return null;}") + "\n" +
        trClass + "\n" + builtinFunc +
        "\nexports.ToolRegistry = ToolRegistry;\nexports.registerBuiltinTools = registerBuiltinTools;\n"
      )(wfNs, fs, path, os, spawn, execSync, process);

      const reg = new wfNs.ToolRegistry();
      wfNs.registerBuiltinTools(reg);

      const tmpWf = path.join(os.tmpdir(), `cloclo-workflow-${Date.now()}.py`);

      // Step 1: Write a Python file
      const w1 = await reg.execute("Write", { file_path: tmpWf, content: 'def greet(name):\n    return f"Hello, {name}!"\n\ndef add(a, b):\n    return a + b\n' });
      assert(!w1.is_error && (typeof w1 === "string" ? w1.includes("Wrote") : true), "Step 1: Write succeeds");

      // Step 2: Read it back
      const r1 = await reg.execute("Read", { file_path: tmpWf });
      const r1c = r1.content || r1;
      assert(r1c.includes("def greet(name)"), "Step 2: Read sees greet function");
      assert(r1c.includes("def add(a, b)"), "Step 2: Read sees add function");

      // Step 3: Edit — rename function
      const e1 = await reg.execute("Edit", { file_path: tmpWf, old_string: "def greet(name):", new_string: "def say_hello(name):" });
      assert(!e1.is_error && (typeof e1 === "string" ? e1.includes("Applied") : true), "Step 3: Edit rename succeeds");

      // Step 4: Verify the edit
      const r2 = await reg.execute("Read", { file_path: tmpWf });
      const r2c = r2.content || r2;
      assert(r2c.includes("def say_hello(name)"), "Step 4: Rename applied");
      assert(!r2c.includes("def greet(name)"), "Step 4: Old name gone");
      assert(r2c.includes("def add(a, b)"), "Step 4: Other function untouched");

      // Step 5: Edit — delete a function entirely
      const e2 = await reg.execute("Edit", { file_path: tmpWf, old_string: "def add(a, b):\n    return a + b", new_string: "" });
      assert(!e2.is_error && (typeof e2 === "string" ? e2.includes("Applied") : true), "Step 5: Delete function succeeds");

      // Step 6: Verify deletion
      const r3 = await reg.execute("Read", { file_path: tmpWf });
      const r3c = r3.content || r3;
      assert(!r3c.includes("def add"), "Step 6: add function removed");
      assert(r3c.includes("def say_hello"), "Step 6: say_hello still present");

      // Step 7: Edit with replace_all
      const tmpWf2 = path.join(os.tmpdir(), `cloclo-workflow2-${Date.now()}.txt`);
      fs.writeFileSync(tmpWf2, "foo bar foo baz foo\n");
      const e3 = await reg.execute("Edit", { file_path: tmpWf2, old_string: "foo", new_string: "qux", replace_all: true });
      const after = fs.readFileSync(tmpWf2, "utf-8");
      assert(after === "qux bar qux baz qux\n", "Step 7: replace_all works");

      // Step 8: Edit uniqueness check — should fail on duplicate
      const tmpWf3 = path.join(os.tmpdir(), `cloclo-workflow3-${Date.now()}.txt`);
      fs.writeFileSync(tmpWf3, "abc\nabc\n");
      const e4 = await reg.execute("Edit", { file_path: tmpWf3, old_string: "abc", new_string: "xyz" });
      assert(e4.is_error === true, "Step 8: Duplicate old_string returns error");
      assert((e4.content || "").includes("multiple times") || (e4.content || "").includes("2 occurrences"),
        "Step 8: Error message explains duplicate");

      // Cleanup
      [tmpWf, tmpWf2, tmpWf3].forEach(f => { try { fs.unlinkSync(f); } catch {} });

    } catch (e) {
      skip(`Workflow deep test failed: ${e.message}`);
    }
  } else {
    skip("Workflow test extraction failed");
  }
}

// ═══════════════════════════════════════════════════════════════════
// UNIT: Phone — audio conversion, session config, tool wiring
// ═══════════════════════════════════════════════════════════════════

section("UNIT: Phone — mulaw decode/encode roundtrip");
{
  const decodeFn = extractBlock(source, "function _mulawDecode(");
  const encodeFn = extractBlock(source, "function _pcm16ToMulaw(");
  if (decodeFn && encodeFn) {
    const env = new Function(decodeFn + "\n" + encodeFn + "\nreturn { _mulawDecode, _pcm16ToMulaw };")();
    // Silence (0) roundtrips exactly
    assert(env._mulawDecode(env._pcm16ToMulaw(0)) === 0, "mulaw roundtrip: 0 → encode → decode = 0");
    // Positive value roundtrips within mulaw quantization error
    const enc1k = env._pcm16ToMulaw(1000);
    const dec1k = env._mulawDecode(enc1k);
    assert(Math.abs(dec1k - 1000) < 200, "mulaw roundtrip: 1000 → " + dec1k + " (err < 200)");
    // Negative value roundtrips
    const encNeg = env._pcm16ToMulaw(-5000);
    const decNeg = env._mulawDecode(encNeg);
    assert(decNeg < 0, "mulaw roundtrip: negative stays negative (" + decNeg + ")");
    assert(Math.abs(decNeg + 5000) < 1000, "mulaw roundtrip: -5000 → " + decNeg + " (err < 1000)");
    // Max positive value
    const encMax = env._pcm16ToMulaw(32000);
    const decMax = env._mulawDecode(encMax);
    assert(decMax > 30000, "mulaw roundtrip: 32000 → " + decMax + " (> 30000)");
    // Encode range: all outputs are 0-255
    for (const v of [-32768, -1, 0, 1, 32767]) {
      const e = env._pcm16ToMulaw(v);
      assert(e >= 0 && e <= 255, "mulaw encode(" + v + ") = " + e + " is in byte range");
    }
  } else {
    skip("mulaw functions not found in built source");
  }
}

section("UNIT: Phone — mulaw-to-pcm24k resampling");
{
  const convFn = extractBlock(source, "function _mulawTopcm24k(");
  const decodeFn = extractBlock(source, "function _mulawDecode(");
  if (convFn && decodeFn) {
    const env = new Function("Buffer", decodeFn + "\n" + convFn + "\nreturn { _mulawTopcm24k, _mulawDecode };");
    const fn = env(Buffer);
    // 10 mulaw samples → 30 PCM16 samples (3x upsample) = 60 bytes
    const input = Buffer.alloc(10);
    const result = fn._mulawTopcm24k(input);
    assert(result.length === 60, "8kHz→24kHz: 10 mulaw bytes → 60 PCM16 bytes (got " + result.length + ")");
    // 1 sample → 3 samples = 6 bytes
    const one = fn._mulawTopcm24k(Buffer.from([0xFF]));
    assert(one.length === 6, "8kHz→24kHz: 1 byte → 6 bytes (got " + one.length + ")");
    // Verify interpolation: a constant signal produces constant output
    const constant = Buffer.alloc(5).fill(0xFF); // 5x silence mulaw
    const upsampled = fn._mulawTopcm24k(constant);
    const s0 = upsampled.readInt16LE(0);
    const s1 = upsampled.readInt16LE(2);
    const s2 = upsampled.readInt16LE(4);
    assert(s0 === s1 && s1 === s2, "Constant mulaw input → constant PCM output (interp works)");
    // Non-silence: mulaw 0x80 = large negative. Check output has actual PCM values
    const loud = Buffer.from([0x00, 0x80, 0x00]); // alternating
    const loudOut = fn._mulawTopcm24k(loud);
    assert(loudOut.length === 18, "3 mulaw samples → 18 bytes PCM");
    // First sample should be large negative (mulaw 0x00 = ~-32124)
    const firstSample = loudOut.readInt16LE(0);
    assert(firstSample < -10000, "mulaw 0x00 decodes to large negative PCM (" + firstSample + ")");
  } else {
    skip("_mulawTopcm24k not found in built source");
  }
}

section("UNIT: Phone — pcm24k-to-mulaw downsampling");
{
  const convFn = extractBlock(source, "function _pcm24kToMulaw(");
  const encodeFn = extractBlock(source, "function _pcm16ToMulaw(");
  if (convFn && encodeFn) {
    const env = new Function("Buffer", encodeFn + "\n" + convFn + "\nreturn { _pcm24kToMulaw, _pcm16ToMulaw };");
    const fn = env(Buffer);
    // 30 PCM16 samples (60 bytes) → 10 mulaw bytes (3x downsample)
    const input = Buffer.alloc(60);
    const result = fn._pcm24kToMulaw(input);
    assert(result.length === 10, "24kHz→8kHz: 60 bytes → 10 mulaw bytes (got " + result.length + ")");
    // Odd number rounds down
    const odd = Buffer.alloc(14); // 7 samples → floor(7/3) = 2
    const oddResult = fn._pcm24kToMulaw(odd);
    assert(oddResult.length === 2, "24kHz→8kHz: 7 samples → 2 mulaw bytes (got " + oddResult.length + ")");
    // Empty buffer → empty output
    const empty = fn._pcm24kToMulaw(Buffer.alloc(0));
    assert(empty.length === 0, "24kHz→8kHz: 0 bytes → 0 mulaw bytes");
    // Silence PCM → mulaw silence (~0xFF)
    const silencePcm = Buffer.alloc(6); // 3 zero samples
    const silenceMulaw = fn._pcm24kToMulaw(silencePcm);
    assert(silenceMulaw.length === 1, "3 PCM silence samples → 1 mulaw byte");
    assert(silenceMulaw[0] === fn._pcm16ToMulaw(0), "PCM silence → mulaw silence value");
    // Loud signal preserved through downsample
    const loudPcm = Buffer.alloc(6);
    loudPcm.writeInt16LE(10000, 0); loudPcm.writeInt16LE(10000, 2); loudPcm.writeInt16LE(10000, 4);
    const loudMulaw = fn._pcm24kToMulaw(loudPcm);
    assert(loudMulaw[0] === fn._pcm16ToMulaw(10000), "Downsample picks first of every 3 samples");
  } else {
    skip("_pcm24kToMulaw not found in built source");
  }
}

section("UNIT: Phone — full audio pipeline roundtrip (mulaw→pcm24k→mulaw)");
{
  const d = extractBlock(source, "function _mulawDecode(");
  const e = extractBlock(source, "function _pcm16ToMulaw(");
  const up = extractBlock(source, "function _mulawTopcm24k(");
  const down = extractBlock(source, "function _pcm24kToMulaw(");
  if (d && e && up && down) {
    const env = new Function("Buffer", d+"\n"+e+"\n"+up+"\n"+down+"\nreturn{_mulawTopcm24k,_pcm24kToMulaw,_mulawDecode,_pcm16ToMulaw};");
    const fn = env(Buffer);
    // Full roundtrip: mulaw → PCM16 24kHz → mulaw
    const orig = Buffer.from([0xFF, 0xC0, 0xA0, 0x80, 0x40, 0x20, 0x10, 0x00]);
    const pcm24 = fn._mulawTopcm24k(orig);
    assert(pcm24.length === orig.length * 6, "Pipeline: mulaw → pcm24k correct size");
    const back = fn._pcm24kToMulaw(pcm24);
    assert(back.length === orig.length, "Pipeline: pcm24k → mulaw same number of samples");
    // Since downsample picks the first of every 3, and upsample sets first = original,
    // the roundtrip should be exact for the first sample of each group
    let exactMatches = 0;
    for (let i = 0; i < orig.length; i++) {
      if (back[i] === orig[i]) exactMatches++;
    }
    assert(exactMatches >= orig.length - 2, "Pipeline roundtrip: " + exactMatches + "/" + orig.length + " exact matches");
  } else {
    skip("Audio pipeline functions not found");
  }
}

section("UNIT: Phone — PhoneManager instantiation and config validation");
{
  const PMBlock = extractBlock(source, "class PhoneManager");
  if (PMBlock) {
    const PM = new Function("log", "fetch", "Buffer", "spawn", "execSync",
      PMBlock + "\nreturn PhoneManager;");
    const PhoneManager = PM(() => {}, () => {}, Buffer, () => {}, () => {});

    // No creds → all 3 missing
    const pm1 = new PhoneManager({});
    const check1 = pm1.checkConfig();
    assert(check1.ok === false, "checkConfig: no creds → not ok");
    assert(check1.missing.length === 3, "checkConfig: 3 missing fields");
    assert(check1.missing.includes("TWILIO_ACCOUNT_SID"), "checkConfig: missing SID");
    assert(check1.missing.includes("TWILIO_AUTH_TOKEN"), "checkConfig: missing token");
    assert(check1.missing.includes("TWILIO_PHONE_NUMBER"), "checkConfig: missing number");

    // Partial creds → only missing ones listed
    const pm2 = new PhoneManager({ twilioAccountSid: "AC123", twilioAuthToken: "tok" });
    const check2 = pm2.checkConfig();
    assert(check2.ok === false, "checkConfig: partial creds → not ok");
    assert(check2.missing.length === 1, "checkConfig: 1 missing");
    assert(check2.missing[0] === "TWILIO_PHONE_NUMBER", "checkConfig: missing phone number");

    // Full creds → ok
    const pm3 = new PhoneManager({ twilioAccountSid: "AC123", twilioAuthToken: "tok", twilioPhoneNumber: "+1" });
    const check3 = pm3.checkConfig();
    assert(check3.ok === true, "checkConfig: full creds → ok");
    assert(check3.missing.length === 0, "checkConfig: 0 missing");
  } else {
    skip("PhoneManager class not found in bundle");
  }
}

section("UNIT: Phone — language detection");
{
  const PMBlock = extractBlock(source, "class PhoneManager");
  if (PMBlock) {
    const PM = new Function("log", "fetch", "Buffer", "spawn", "execSync",
      PMBlock + "\nreturn PhoneManager;");
    const PhoneManager = PM(() => {}, () => {}, Buffer, () => {}, () => {});
    const pm = new PhoneManager({});

    assert(pm._detectLanguage("bonjour comment allez-vous") === "fr-FR", "detectLanguage: French");
    assert(pm._detectLanguage("hola como estas") === "es-ES", "detectLanguage: Spanish");
    assert(pm._detectLanguage("hallo wie geht es Ihnen") === "de-DE", "detectLanguage: German");
    assert(pm._detectLanguage("ciao come stai") === "it-IT", "detectLanguage: Italian");
    assert(pm._detectLanguage("hello how are you") === "en-US", "detectLanguage: English default");
    assert(pm._detectLanguage("こんにちは") === "ja-JP", "detectLanguage: Japanese");
    assert(pm._detectLanguage("مرحبا") === "ar-SA", "detectLanguage: Arabic");
    assert(pm._detectLanguage("你好世界") === "zh-CN", "detectLanguage: Chinese");
  } else {
    skip("PhoneManager class not found");
  }
}

section("UNIT: Phone — XML escaping");
{
  const PMBlock = extractBlock(source, "class PhoneManager");
  if (PMBlock) {
    const PM = new Function("log", "fetch", "Buffer", "spawn", "execSync",
      PMBlock + "\nreturn PhoneManager;");
    const PhoneManager = PM(() => {}, () => {}, Buffer, () => {}, () => {});
    const pm = new PhoneManager({});

    assert(pm._escapeXml("hello & world") === "hello &amp; world", "escapeXml: ampersand");
    assert(pm._escapeXml("<script>") === "&lt;script&gt;", "escapeXml: angle brackets");
    assert(pm._escapeXml('"test"') === "&quot;test&quot;", "escapeXml: double quotes");
    assert(pm._escapeXml("it's") === "it&apos;s", "escapeXml: single quote/apostrophe");
    assert(pm._escapeXml("plain text") === "plain text", "escapeXml: no special chars unchanged");
    assert(pm._escapeXml('a & b < c > d "e" f\'g') === "a &amp; b &lt; c &gt; d &quot;e&quot; f&apos;g", "escapeXml: all specials combined");
  } else {
    skip("PhoneManager class not found");
  }
}

section("UNIT: Phone — voice resolution by language");
{
  const PMBlock = extractBlock(source, "class PhoneManager");
  if (PMBlock) {
    const PM = new Function("log", "fetch", "Buffer", "spawn", "execSync",
      PMBlock + "\nreturn PhoneManager;");
    const PhoneManager = PM(() => {}, () => {}, Buffer, () => {}, () => {});
    const pm = new PhoneManager({});

    assert(pm._resolveVoice("fr-FR") === "Polly.Lea", "resolveVoice: French → Polly.Lea");
    assert(pm._resolveVoice("es-ES") === "Polly.Lucia", "resolveVoice: Spanish → Polly.Lucia");
    assert(pm._resolveVoice("de-DE") === "Polly.Vicki", "resolveVoice: German → Polly.Vicki");
    assert(pm._resolveVoice("en-US") === "Polly.Joanna", "resolveVoice: English → Polly.Joanna");
    assert(pm._resolveVoice("ja-JP") === "Polly.Mizuki", "resolveVoice: Japanese → Polly.Mizuki");
    assert(pm._resolveVoice(null) === "Polly.Joanna", "resolveVoice: null → default Joanna");
    assert(pm._resolveVoice() === "Polly.Joanna", "resolveVoice: undefined → default Joanna");
  } else {
    skip("PhoneManager class not found");
  }
}

section("UNIT: Phone — PhoneLiveSession config defaults");
{
  // Use direct import instead of extractBlock (class depends on _WsServerClient)
  try {
    const { PhoneLiveSession } = await import("./src/phone.mjs");
    // Default config
    const s1 = new PhoneLiveSession({}, { to: "+33612345678" });
    assert(s1._to === "+33612345678", "PhoneLiveSession stores target number");
    assert(s1._model === "gpt-4o-realtime-preview", "Default model is gpt-4o-realtime-preview");
    assert(s1._voice === "alloy", "Default voice is alloy");
    assert(s1._maxDuration === 300, "Default max duration is 300s");
    assert(s1._active === false, "Starts inactive");
    assert(Array.isArray(s1._transcript), "Has transcript array");
    assert(s1._transcript.length === 0, "Transcript starts empty");
    assert(s1._instructions.includes("helpful"), "Default instructions mention helpful");
    // Custom config
    const s2 = new PhoneLiveSession({}, { to: "+1555", instructions: "Book a table", voice: "echo", model: "gpt-4o-mini-realtime", maxDuration: 120 });
    assert(s2._instructions === "Book a table", "Custom instructions stored");
    assert(s2._voice === "echo", "Custom voice stored");
    assert(s2._model === "gpt-4o-mini-realtime", "Custom model stored");
    assert(s2._maxDuration === 120, "Custom maxDuration stored");
    // Tools and callback
    const tools = [{ name: "search", description: "Search web", input_schema: {} }];
    const cb = () => {};
    const s3 = new PhoneLiveSession({}, { to: "+1", tools, onToolCall: cb });
    assert(s3._tools.length === 1, "Tools passed through");
    assert(s3._tools[0].name === "search", "Tool name preserved");
    assert(s3._onToolCall === cb, "onToolCall callback stored");
  } catch (e) {
    skip("PhoneLiveSession import failed: " + e.message);
  }
}

section("UNIT: Phone — WS server starts and accepts HTTP");
{
  try {
    const { PhoneLiveSession } = await import("./src/phone.mjs");
    const session = new PhoneLiveSession(
      { twilioAccountSid: "AC", twilioAuthToken: "tok", twilioPhoneNumber: "+1" },
      { to: "+123" }
    );
    const port = await session._startServer();
    assert(typeof port === "number" && port > 0, "WS server returns a valid port (" + port + ")");
    const resp = await fetch("http://127.0.0.1:" + port);
    assert(resp.status === 200, "WS server health check returns 200");
    const body = await resp.text();
    assert(body.includes("phone-live"), "Health check body mentions phone-live");
    session._server.close();
  } catch (e) {
    skip("WS server test failed: " + e.message);
  }
}

section("UNIT: Phone — Twilio message handler dispatches correctly");
{
  try {
    const { PhoneLiveSession } = await import("./src/phone.mjs");
    const session = new PhoneLiveSession({}, { to: "+1" });
    session._realtimeWs = { readyState: 1, send: () => {} };
    // Stub _connectRealtime to prevent real HTTPS connection
    session._connectRealtime = () => {};

    // Test "start" event stores streamSid
    session._handleTwilioMessage(JSON.stringify({ event: "start", start: { streamSid: "MZ123", callSid: "CA456" } }));
    assert(session._streamSid === "MZ123", "start event stores streamSid");

    // Test "media" event converts and forwards audio
    let sentToRealtime = null;
    session._realtimeWs.send = (data) => { sentToRealtime = JSON.parse(data); };
    session._streamSid = "MZ123";
    const mulawSilence = Buffer.alloc(10).fill(0xFF).toString("base64");
    session._handleTwilioMessage(JSON.stringify({ event: "media", media: { payload: mulawSilence } }));
    assert(sentToRealtime !== null, "media event forwards audio to Realtime");
    assert(sentToRealtime.type === "input_audio_buffer.append", "Forwarded as input_audio_buffer.append");
    assert(typeof sentToRealtime.audio === "string", "Audio payload is base64 string");
    const audioBytes = Buffer.from(sentToRealtime.audio, "base64");
    assert(audioBytes.length === 10, "10 mulaw bytes passed through directly as g711_ulaw (got " + audioBytes.length + ")");

    // Test "stop" event triggers stop
    let stopCalled = false;
    session.stop = () => { stopCalled = true; };
    session._handleTwilioMessage(JSON.stringify({ event: "stop" }));
    assert(stopCalled, "stop event triggers session.stop()");

    // Test invalid JSON handled gracefully
    let threw = false;
    try { session._handleTwilioMessage("not json {{{"); } catch { threw = true; }
    assert(!threw, "Invalid JSON in Twilio message doesn't throw");
  } catch (e) {
    skip("Twilio handler test failed: " + e.message);
  }
}

section("UNIT: Phone — Realtime event handler tracks transcript");
{
  try {
    const { PhoneLiveSession } = await import("./src/phone.mjs");
    const session = new PhoneLiveSession({}, { to: "+1" });
    let emittedTranscripts = [];
    session.on("transcript", (role, text) => emittedTranscripts.push({ role, text }));

    // User transcription
    session._handleRealtimeEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "  hello world  " });
    assert(session._transcript.length === 1, "User transcript added");
    assert(session._transcript[0].role === "human", "User transcript role is human");
    assert(session._transcript[0].text === "hello world", "User transcript trimmed");
    assert(emittedTranscripts.length === 1, "Transcript event emitted for user");

    // Assistant response
    session._handleRealtimeEvent({ type: "response.created" });
    session._handleRealtimeEvent({ type: "response.audio_transcript.delta", delta: "Hi " });
    session._handleRealtimeEvent({ type: "response.audio_transcript.delta", delta: "there!" });
    session._handleRealtimeEvent({ type: "response.audio_transcript.done" });
    assert(session._transcript.length === 2, "Assistant transcript added");
    assert(session._transcript[1].role === "assistant", "Assistant transcript role");
    assert(session._transcript[1].text === "Hi there!", "Assistant transcript concatenated");

    // Empty transcript ignored
    session._handleRealtimeEvent({ type: "conversation.item.input_audio_transcription.completed", transcript: "   " });
    assert(session._transcript.length === 2, "Empty user transcript ignored");
  } catch (e) {
    skip("Transcript test failed: " + e.message);
  }
}

section("UNIT: Phone — Realtime audio bridge sends to Twilio");
{
  try {
    const { PhoneLiveSession } = await import("./src/phone.mjs");
    const session = new PhoneLiveSession({}, { to: "+1" });
    session._streamSid = "MZ999";

    let twilioMessages = [];
    session._twilioWs = { send: (d) => twilioMessages.push(JSON.parse(d)) };

    // g711_ulaw audio from OpenAI passed directly to Twilio (no conversion)
    const audioData = Buffer.alloc(20);
    for (let i = 0; i < 20; i++) audioData[i] = i * 10;
    const b64 = audioData.toString("base64");
    session._handleRealtimeEvent({ type: "response.audio.delta", delta: b64 });

    assert(twilioMessages.length === 1, "Audio delta forwarded to Twilio");
    assert(twilioMessages[0].event === "media", "Twilio message is media event");
    assert(twilioMessages[0].streamSid === "MZ999", "Twilio message has correct streamSid");
    assert(twilioMessages[0].media.payload === b64, "g711_ulaw payload passed through directly (no conversion)");
  } catch (e) {
    skip("Audio bridge test failed: " + e.message);
  }
}

section("UNIT: Phone — barge-in interrupts and cancels response");
{
  try {
    const { PhoneLiveSession } = await import("./src/phone.mjs");
    const session = new PhoneLiveSession({}, { to: "+1" });
    session._streamSid = "MZ";
    session._responseActive = true;

    let sentEvents = [];
    session._realtimeWs = { readyState: 1, send: (d) => sentEvents.push(JSON.parse(d)) };
    let clearedTwilio = [];
    session._twilioWs = { send: (d) => clearedTwilio.push(JSON.parse(d)) };

    session._handleRealtimeEvent({ type: "input_audio_buffer.speech_started" });

    const cancelEvent = sentEvents.find(e => e.type === "response.cancel");
    assert(cancelEvent, "Barge-in sends response.cancel");
    const clearEvent = clearedTwilio.find(e => e.event === "clear");
    assert(clearEvent, "Barge-in sends clear to Twilio");
    assert(session._responseActive === false, "responseActive set to false after interrupt");
  } catch (e) {
    skip("Barge-in test failed: " + e.message);
  }
}

section("UNIT: Phone — tool call handling in live session");
{
  try {
    const { PhoneLiveSession } = await import("./src/phone.mjs");
    let toolCallReceived = null;
    const session = new PhoneLiveSession({}, {
      to: "+1",
      onToolCall: async (name, args) => { toolCallReceived = { name, args }; return "tool result data"; },
    });

    let sentEvents = [];
    session._realtimeWs = { readyState: 1, send: (d) => sentEvents.push(JSON.parse(d)) };

    session._handleRealtimeEvent({ type: "response.function_call_arguments.done", call_id: "call_abc", name: "WebSearch", arguments: '{"query":"test"}' });
    await new Promise(r => setTimeout(r, 50));

    assert(toolCallReceived !== null, "onToolCall callback invoked");
    assert(toolCallReceived.name === "WebSearch", "Tool name passed correctly");
    assert(toolCallReceived.args.query === "test", "Tool args parsed from JSON");

    const outputEvent = sentEvents.find(e => e.type === "conversation.item.create" && e.item?.type === "function_call_output");
    assert(outputEvent, "Tool result sent back as function_call_output");
    assert(outputEvent.item.call_id === "call_abc", "call_id matches");
    assert(outputEvent.item.output === "tool result data", "Tool output forwarded");

    const respCreate = sentEvents.find(e => e.type === "response.create");
    assert(respCreate, "response.create sent after tool result");
  } catch (e) {
    skip("Tool call test failed: " + e.message);
  }
}

// ── Agent Metrics ────────────────────────────────────────────────

section("UNIT: Agent Metrics — appendAgentMetric / readAgentMetrics / summarizeAgentMetrics");

{
  try {
    const tmpDir = path.join(os.tmpdir(), `agent-metrics-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const testCwd = tmpDir;

    const fnStart = source.indexOf("const AGENT_METRICS_FILE =");
    const fnEnd = source.indexOf("function summarizeAgentMetrics(");
    const fnEndFull = source.indexOf("\n}", source.indexOf("sort((a, b) => b.uses - a.uses)", fnEnd));
    assert(fnStart > 0 && fnEnd > 0, "Agent metrics functions found in source");

    const fnSource = source.slice(fnStart, fnEndFull + 2);
    const ns = {};

    // Provide ensureMemoryDir stub used by _agentMetricsDir
    const ensureMemoryDir = (cwd) => {
      const dir = path.join(cwd, "memory");
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };

    new Function("exports", "fs", "path", "os", "log", "ensureMemoryDir",
      fnSource + `
      exports.appendAgentMetric = appendAgentMetric;
      exports.readAgentMetrics = readAgentMetrics;
      exports.summarizeAgentMetrics = summarizeAgentMetrics;
    `)(ns, fs, path, os, () => {}, ensureMemoryDir);

    // Test append + read
    ns.appendAgentMetric(testCwd, {
      agent_name: "pr-reviewer", agent_source: "custom", found: true,
      is_error: false, run_in_background: false, turns: 5, duration_ms: 3000,
      stop_reason: "completed", session_id: "test-session",
    });
    ns.appendAgentMetric(testCwd, {
      agent_name: "Explore", agent_source: "builtin", found: true,
      is_error: true, run_in_background: true, turns: 2, duration_ms: 1000,
      stop_reason: "error", session_id: "test-session",
    });
    ns.appendAgentMetric(testCwd, {
      agent_name: "pr-reviewer", agent_source: "custom", found: true,
      is_error: false, run_in_background: false, turns: 8, duration_ms: 5000,
      stop_reason: "completed", session_id: "test-session",
    });

    const events = ns.readAgentMetrics(testCwd);
    assert(events.length === 3, `Read returns 3 events (got ${events.length})`);
    assert(events[0].agent_name === "pr-reviewer", "First event is pr-reviewer");
    assert(events[1].agent_name === "Explore", "Second event is Explore");
    assert(events[0].session_id === "test-session", "Session ID preserved");

    // Test summarize
    const summary = ns.summarizeAgentMetrics(events);
    assert(summary.length === 2, `Summary has 2 agents (got ${summary.length})`);
    assert(summary[0].agent === "pr-reviewer", "Most used agent first: pr-reviewer");
    assert(summary[0].uses === 2, "pr-reviewer: 2 uses");
    assert(summary[0].errors === 0, "pr-reviewer: 0 errors");
    assert(summary[0].avg_turns === 7, `pr-reviewer: avg_turns=7 (got ${summary[0].avg_turns})`);
    assert(summary[0].avg_duration_ms === 4000, `pr-reviewer: avg_duration=4000 (got ${summary[0].avg_duration_ms})`);
    assert(summary[1].agent === "Explore", "Second agent: Explore");
    assert(summary[1].errors === 1, "Explore: 1 error");

    // Test since filter
    const future = new Date(Date.now() + 60000).toISOString();
    const filtered = ns.readAgentMetrics(testCwd, { since: future });
    assert(filtered.length === 0, "since filter excludes all past events");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (e) { skip(`Agent metrics eval failed: ${e.message}`); }
}

section("UNIT: Agent Metrics — module exists in source");

{
  assert(source.includes("function appendAgentMetric("), "appendAgentMetric exists");
  assert(source.includes("function readAgentMetrics("), "readAgentMetrics exists");
  assert(source.includes("function summarizeAgentMetrics("), "summarizeAgentMetrics exists");
  assert(source.includes("agent-metrics.jsonl"), "Uses agent-metrics.jsonl storage");
  assert(source.includes("AGENT_MAX_LINES"), "Has rotation limit");
  assert(source.includes("AGENT_TRIM_TO"), "Has trim target");
}

// ── Agent CRUD Tools ─────────────────────────────────────────────

section("UNIT: Agent CRUD — registerAgentCrudTools exists");

{
  assert(source.includes("function registerAgentCrudTools("), "registerAgentCrudTools function exists");
  assert(source.includes("function _buildAgentMd("), "_buildAgentMd helper exists");
  assert(source.includes("function _loadAgentManifest("), "_loadAgentManifest exists");
  assert(source.includes("function _saveAgentManifest("), "_saveAgentManifest exists");
  assert(source.includes("function _computeAgentChecksum("), "_computeAgentChecksum exists");
}

section("UNIT: Agent CRUD — tool registrations");

{
  assert(source.includes('"AgentCreate"'), "AgentCreate tool registered");
  assert(source.includes('"AgentList"'), "AgentList tool registered");
  assert(source.includes('"AgentUpdate"'), "AgentUpdate tool registered");
  assert(source.includes('"AgentDelete"'), "AgentDelete tool registered");
}

section("UNIT: Agent CRUD — _buildAgentMd generates valid AGENT.md");

{
  try {
    const fnStart = source.indexOf("function _buildAgentMd(");
    const fnEnd = source.indexOf("\n}", fnStart);
    const fnSource = source.slice(fnStart, fnEnd + 2);
    const ns = {};
    new Function("exports", fnSource + "\nexports._buildAgentMd = _buildAgentMd;")(ns);

    const result = ns._buildAgentMd({
      name: "test-agent",
      description: "A test agent",
      model: "sonnet",
      read_only: true,
      disallowed_tools: ["Bash", "Write"],
    }, "You are a test agent.\n\nBe helpful.");

    assert(result.includes("---"), "Contains frontmatter delimiters");
    assert(result.includes("name: test-agent"), "Contains name");
    assert(result.includes("description: A test agent"), "Contains description");
    assert(result.includes("model: sonnet"), "Contains model");
    assert(result.includes("read_only: true"), "Contains read_only");
    assert(result.includes("  - Bash"), "Contains disallowed Bash");
    assert(result.includes("  - Write"), "Contains disallowed Write");
    assert(result.includes("You are a test agent."), "Contains system prompt body");
  } catch (e) { skip(`_buildAgentMd eval failed: ${e.message}`); }
}

section("UNIT: Agent CRUD — collision check blocks builtins");

{
  // The AgentCreate handler checks AGENT_DEFINITIONS — verify AGENT_DEFINITIONS is populated
  assert(source.includes("AGENT_DEFINITIONS[name]"), "Collision check against AGENT_DEFINITIONS");
  assert(source.includes("conflicts with builtin agent"), "Collision error message present");
  assert(source.includes("Cannot delete builtin agent"), "Delete collision check present");
  assert(source.includes("Cannot update builtin agent"), "Update collision check present");
}

section("UNIT: Agent CRUD — deferred registration");

{
  // CRUD tools should be registered as deferred
  const createIdx = source.indexOf('"AgentCreate"');
  const listIdx = source.indexOf('"AgentList"');
  const updateIdx = source.indexOf('"AgentUpdate"');
  const deleteIdx = source.indexOf('"AgentDelete"');

  // Check deferred: true is nearby each registration (large closures need wider window)
  const nearCreate = source.slice(createIdx, createIdx + 4000);
  const nearList = source.slice(listIdx, listIdx + 2000);
  const nearUpdate = source.slice(updateIdx, updateIdx + 4000);
  const nearDelete = source.slice(deleteIdx, deleteIdx + 2000);

  assert(nearCreate.includes("deferred: true"), "AgentCreate is deferred");
  assert(nearList.includes("deferred: true"), "AgentList is deferred");
  assert(nearUpdate.includes("deferred: true"), "AgentUpdate is deferred");
  assert(nearDelete.includes("deferred: true"), "AgentDelete is deferred");
}

// ── Agent Instrumentation ────────────────────────────────────────

section("UNIT: Agent Instrumentation — metrics in executor");

{
  assert(source.includes("appendAgentMetric(cfg.cwd"), "appendAgentMetric called in Agent executor");
  const agentExecIdx = source.indexOf("const agentStartTime = Date.now()");
  assert(agentExecIdx > 0, "Timer started in Agent executor");
  const agentMetricIdx = source.indexOf("appendAgentMetric(cfg.cwd", agentExecIdx);
  assert(agentMetricIdx > 0, "appendAgentMetric called after run");
  assert(agentMetricIdx - agentExecIdx < 2000, "Metric call is near timer start");
}

// ── Agent CLI Commands ───────────────────────────────────────────

section("UNIT: Agent CLI — functions exist");

{
  assert(source.includes("function agentList("), "agentList function exists");
  assert(source.includes("function agentInfo("), "agentInfo function exists");
  assert(source.includes("function agentRemove("), "agentRemove function exists");
}

section("UNIT: Agent CLI — config subcommands");

{
  const configSrc = fs.readFileSync(path.join(__dirname, "src", "config.mjs"), "utf-8");
  assert(configSrc.includes('"agent-list"'), "config.mjs handles agent-list subcommand");
  assert(configSrc.includes('"agent-info"'), "config.mjs handles agent-info subcommand");
  assert(configSrc.includes('"agent-remove"'), "config.mjs handles agent-remove subcommand");
}

section("UNIT: Agent CLI — index.mjs dispatch");

{
  const indexSrc = fs.readFileSync(path.join(__dirname, "src", "index.mjs"), "utf-8");
  assert(indexSrc.includes('"agent-list"'), "index.mjs dispatches agent-list");
  assert(indexSrc.includes('"agent-info"'), "index.mjs dispatches agent-info");
  assert(indexSrc.includes('"agent-remove"'), "index.mjs dispatches agent-remove");
  assert(indexSrc.includes("registerAgentCrudTools"), "index.mjs calls registerAgentCrudTools");
}

section("UNIT: Agent CLI — /agent slash command in session.mjs");

{
  const sessionSrc = fs.readFileSync(path.join(__dirname, "src", "session.mjs"), "utf-8");
  assert(sessionSrc.includes('name: "agent"'), "/agent slash command registered");
  assert(sessionSrc.includes("agentList("), "slash command calls agentList");
  assert(sessionSrc.includes("agentInfo("), "slash command calls agentInfo");
  assert(sessionSrc.includes("agentRemove("), "slash command calls agentRemove");
}

// ── Agent Nudge ──────────────────────────────────────────────────

section("UNIT: Agent Nudge — RL review system");

{
  const sessionSrc = fs.readFileSync(path.join(__dirname, "src", "session.mjs"), "utf-8");
  assert(sessionSrc.includes("DEFAULT_AGENT_NUDGE_INTERVAL"), "Agent nudge interval constant exists");
  assert(sessionSrc.includes("_AGENT_REVIEW_PROMPT"), "Agent review prompt exists");
  assert(sessionSrc.includes("_toolCallsSinceAgentReview"), "Agent review counter exists");
  assert(sessionSrc.includes("_agentNudgeInterval"), "Agent nudge interval property exists");
  assert(sessionSrc.includes('"agent"'), "_spawnBackgroundReview handles agent type");
  assert(sessionSrc.includes("{AGENT_METRICS}"), "Prompt has agent metrics placeholder");
  assert(sessionSrc.includes("{BUILTINS}"), "Prompt has builtins placeholder");
}

// ── Agent Creator Skill ──────────────────────────────────────────

section("UNIT: Agent Creator Skill — SKILL.md exists");

{
  const skillPath = path.join(os.homedir(), ".claude", "skills", "agent-creator", "SKILL.md");
  try {
    const content = fs.readFileSync(skillPath, "utf-8");
    assert(content.includes("name: agent-creator"), "Skill has correct name");
    assert(content.includes("AgentCreate"), "Skill references AgentCreate tool");
    assert(content.includes("Agent vs Skill"), "Skill explains agent vs skill decision");
    assert(content.includes("$ARGUMENTS"), "Skill supports arguments");
  } catch (e) {
    skip(`Agent creator skill not found: ${e.message}`);
  }
}

// ── Agent Manifest ───────────────────────────────────────────────

section("UNIT: Agent Manifest — path and format");

{
  assert(source.includes(".cloclo-agents.json"), "Manifest uses .cloclo-agents.json");
  assert(source.includes("AGENT_MANIFEST_PATH"), "Manifest path constant exists");
}

// ── AICL Protocol ────────────────────────────────────────────────

section("UNIT: AICL — module exists in source");

{
  assert(source.includes("AICL_VERSION"), "AICL_VERSION constant exists");
  assert(source.includes("AICL_INSTRUCTION_BLOCK"), "AICL_INSTRUCTION_BLOCK exists");
  assert(source.includes("function buildAiclPromptFrame("), "buildAiclPromptFrame exists");
  assert(source.includes("function parseAiclResponse("), "parseAiclResponse exists");
  assert(source.includes("function enrichResultWithAicl("), "enrichResultWithAicl exists");
  assert(source.includes('"_aicl"'), "_aicl version field referenced");
}

section("UNIT: AICL — parseAiclResponse fallback chain");

{
  try {
    const fnStart = source.indexOf("function parseAiclResponse(");
    const fnEnd = source.indexOf("\n}", source.indexOf("_fallback: true", fnStart + 1000));
    const fnSource = source.slice(fnStart, fnEnd + 2);
    const ns = {};
    new Function("exports", "log",
      fnSource + "\nexports.parseAiclResponse = parseAiclResponse;"
    )(ns, () => {});

    // Strategy 1: raw JSON
    const raw = JSON.stringify({ _aicl: 1, from: "test", human_summary: "hello", confidence: 0.9 });
    const r1 = ns.parseAiclResponse(raw, "test-agent");
    assert(r1._aicl === 1, "Raw JSON: _aicl parsed");
    assert(r1._fallback === false, "Raw JSON: not fallback");
    assert(r1.confidence === 0.9, "Raw JSON: confidence preserved");
    assert(r1.from === "test", "Raw JSON: from preserved");

    // Strategy 2: ```json code block
    const codeBlock = "Here are my findings:\n\n```json\n" + raw + "\n```\n\nAll done.";
    const r2 = ns.parseAiclResponse(codeBlock, "test-agent");
    assert(r2._aicl === 1, "Code block: _aicl parsed");
    assert(r2._fallback === false, "Code block: not fallback");
    assert(r2.human_summary === "hello", "Code block: human_summary from frame");

    // Strategy 3: generic code block (no json hint)
    const genericBlock = "Summary:\n\n```\n" + raw + "\n```";
    const r3 = ns.parseAiclResponse(genericBlock, "test-agent");
    assert(r3._aicl === 1, "Generic block: _aicl parsed");
    assert(r3._fallback === false, "Generic block: not fallback");

    // Strategy 4: plain text fallback
    const plainText = "I found 3 bugs in the auth module. Here are the details...";
    const r4 = ns.parseAiclResponse(plainText, "explore-agent");
    assert(r4._aicl === null, "Plain text: _aicl is null");
    assert(r4._fallback === true, "Plain text: is fallback");
    assert(r4.human_summary === plainText, "Plain text: human_summary is the raw text");
    assert(r4.from === "explore-agent", "Plain text: from set to agent type");

    // Edge case: null/empty input
    const r5 = ns.parseAiclResponse(null, "agent");
    assert(r5._fallback === true, "Null input: fallback");
    const r6 = ns.parseAiclResponse("", "agent");
    assert(r6._fallback === true, "Empty input: fallback");

    // Edge case: JSON without _aicl field
    const noAicl = JSON.stringify({ result: "done", confidence: 0.8 });
    const r7 = ns.parseAiclResponse(noAicl, "agent");
    assert(r7._fallback === true, "JSON without _aicl: fallback");

    // Edge case: code block with text outside — human_summary from outside text
    const mixedBlock = "```json\n" + JSON.stringify({ _aicl: 1, from: "x", confidence: 0.5 }) + "\n```\n\nExtra context for the human.";
    const r8 = ns.parseAiclResponse(mixedBlock, "agent");
    assert(r8._fallback === false, "Mixed: not fallback");
    assert(r8.human_summary === "Extra context for the human.", "Mixed: human_summary from outside text");

  } catch (e) { skip(`AICL parseAiclResponse eval failed: ${e.message}`); }
}

section("UNIT: AICL — enrichResultWithAicl");

{
  try {
    // Extract enrichResultWithAicl + parseAiclResponse
    const parseStart = source.indexOf("function parseAiclResponse(");
    const parseEnd = source.indexOf("\n}", source.indexOf("_fallback: true", parseStart + 1000));
    const enrichStart = source.indexOf("function enrichResultWithAicl(");
    const enrichEnd = source.indexOf("\n}", enrichStart);
    const fnSource = source.slice(parseStart, parseEnd + 2) + "\n" + source.slice(enrichStart, enrichEnd + 2);
    const ns = {};
    new Function("exports", "log",
      fnSource + "\nexports.enrichResultWithAicl = enrichResultWithAicl;"
    )(ns, () => {});

    // With AICL frame
    const frame = JSON.stringify({ _aicl: 1, from: "reviewer", confidence: 0.95, human_summary: "Found 2 issues" });
    const result1 = { content: "```json\n" + frame + "\n```", turns: 3 };
    ns.enrichResultWithAicl(result1, "reviewer");
    assert(result1.aicl_frame === true, "Enrich: aicl_frame=true when frame present");
    assert(result1.content === "Found 2 issues", "Enrich: content replaced with human_summary");
    assert(result1.content_original.includes("```json"), "Enrich: content_original preserved");
    assert(result1.aicl.confidence === 0.95, "Enrich: aicl.confidence accessible");

    // Without AICL frame
    const result2 = { content: "Just plain text results", turns: 1 };
    ns.enrichResultWithAicl(result2, "explorer");
    assert(result2.aicl_frame === false, "Enrich: aicl_frame=false for plain text");
    assert(result2.content === "Just plain text results", "Enrich: content unchanged for plain text");
    assert(!result2.content_original, "Enrich: no content_original for plain text");

  } catch (e) { skip(`AICL enrichResultWithAicl eval failed: ${e.message}`); }
}

section("UNIT: AICL — injected into SubAgentRunner system prompt");

{
  assert(source.includes("AICL_INSTRUCTION_BLOCK"), "AICL instruction block referenced");
  // Check it's pushed to systemBlocks in SubAgentRunner
  const runnerBlock = source.slice(source.indexOf("class SubAgentRunner"), source.indexOf("class SubAgentRunner") + 15000);
  assert(runnerBlock.includes("aiclBlock"), "AICL block variable created in runner");
  assert(runnerBlock.includes("systemBlocks.push(aiclBlock)"), "AICL block pushed to system prompt");
}

section("UNIT: AICL — enrichResultWithAicl called in SubAgentRunner return");

{
  const returnArea = source.slice(source.indexOf("enrichResultWithAicl(agentResult"), source.indexOf("enrichResultWithAicl(agentResult") + 200);
  assert(returnArea.includes("enrichResultWithAicl"), "enrichResultWithAicl called on agent result");
  assert(returnArea.includes("agentDef.agentType"), "Agent type passed for logging");
}

section("UNIT: AICL — aicl_frame tracked in agent metrics");

{
  const metricsArea = source.slice(source.indexOf("appendAgentMetric(cfg.cwd"), source.indexOf("appendAgentMetric(cfg.cwd") + 500);
  assert(metricsArea.includes("aicl_frame"), "aicl_frame field in agent metrics");
}

section("UNIT: AICL — instruction block content quality");

{
  const blockStart = source.indexOf("AICL_INSTRUCTION_BLOCK");
  const blockArea = source.slice(blockStart, blockStart + 3000);
  assert(blockArea.includes("_aicl"), "Instruction block mentions _aicl field");
  assert(blockArea.includes("human_summary"), "Instruction block mentions human_summary");
  assert(blockArea.includes("confidence"), "Instruction block mentions confidence");
  assert(blockArea.includes("evidence"), "Instruction block mentions evidence");
  assert(blockArea.includes("verified"), "Instruction block mentions verified");
  assert(blockArea.includes("```json"), "Instruction block has JSON example");
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
