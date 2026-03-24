#!/usr/bin/env node
// test-openai-integration.mjs — Unit + Integration tests for OpenAI backend
//
// Usage:
//   node test-openai-integration.mjs              # Unit tests only (no API key needed)
//   OPENAI_API_KEY=sk-... node test-openai-integration.mjs --e2e   # Full E2E
//   node test-openai-integration.mjs --e2e --oauth                 # E2E with OAuth

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "claude-native.mjs");

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, name) {
  if (condition) {
    passed++;
    process.stderr.write(`  \x1b[32m✓\x1b[0m ${name}\n`);
  } else {
    failed++;
    failures.push(name);
    process.stderr.write(`  \x1b[31m✗\x1b[0m ${name}\n`);
  }
}

// ─── Extract classes from source for unit testing ──────────────────
// We extract OpenAIClient + isOpenAIModel from the source file and eval them
// in isolation, avoiding side effects from the rest of claude-native.mjs.

const source = fs.readFileSync(SCRIPT, "utf-8");

// Extract class OpenAIClient { ... } (multi-line, ends with ^} at start of line)
function extractBlock(src, startPattern) {
  const idx = src.indexOf(startPattern);
  if (idx === -1) return null;
  let depth = 0;
  let started = false;
  let end = idx;
  for (let i = idx; i < src.length; i++) {
    if (src[i] === "{") { depth++; started = true; }
    if (src[i] === "}") { depth--; }
    if (started && depth === 0) { end = i + 1; break; }
  }
  return src.slice(idx, end);
}

const openAIClientClass = extractBlock(source, "class OpenAIClient {");
const isOpenAIModelFunc = extractBlock(source, "function isOpenAIModel(");
const logStub = "function log() {}"; // stub the log function

// Build a testable module
const testModule = [logStub, openAIClientClass, isOpenAIModelFunc].filter(Boolean).join("\n\n");
const testFn = new Function("exports", testModule + "\nexports.OpenAIClient = OpenAIClient;\nexports.isOpenAIModel = isOpenAIModel;\n");
const exports = {};
testFn(exports);

const { OpenAIClient, isOpenAIModel } = exports;

// ─── UAT: CLI flags & help ─────────────────────────────────────────

process.stderr.write("\n\x1b[1m[UAT] CLI flags & help\x1b[0m\n");

{
  const { exitCode, stderr } = await runCLI(["--help"]);
  assert(stderr.includes("gpt-4o"), "Help mentions gpt-4o");
  assert(stderr.includes("codex"), "Help mentions codex");
  assert(stderr.includes("openai-login"), "Help mentions --openai-login");
  assert(stderr.includes("openai-api-key"), "Help mentions --openai-api-key");
}

// ─── UAT: Model detection via CLI error messages ───────────────────

process.stderr.write("\n\x1b[1m[UAT] Model detection via CLI\x1b[0m\n");

{
  // Clear OPENAI_API_KEY to test the "no key" path
  const noKeyEnv = { OPENAI_API_KEY: "" };
  const { exitCode, stderr } = await runCLI(["-m", "gpt-4o", "-p", "test"], noKeyEnv);
  assert(stderr.includes("No OpenAI auth"), "gpt-4o without key → clear error");
  assert(exitCode !== 0, "gpt-4o without key → non-zero exit");
}

{
  const { stderr } = await runCLI(["-m", "codex", "-p", "test"], { OPENAI_API_KEY: "" });
  assert(stderr.includes("No OpenAI auth"), "codex alias without key → OpenAI error");
}

{
  const { stderr } = await runCLI(["-m", "o3", "-p", "test"], { OPENAI_API_KEY: "" });
  assert(stderr.includes("No OpenAI auth"), "o3 without key → OpenAI error");
}

{
  const { stderr } = await runCLI(["-m", "sonnet", "-p", "test"], { ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" });
  assert(!stderr.includes("No OpenAI auth"), "sonnet → not an OpenAI error");
}

// ─── NRT: isOpenAIModel ────────────────────────────────────────────

process.stderr.write("\n\x1b[1m[NRT] isOpenAIModel detection\x1b[0m\n");

assert(isOpenAIModel("gpt-4o") === true, "gpt-4o → OpenAI");
assert(isOpenAIModel("gpt-5.2-codex") === true, "gpt-5.2-codex → OpenAI");
assert(isOpenAIModel("gpt-4.1") === true, "gpt-4.1 → OpenAI");
assert(isOpenAIModel("gpt-4.1-mini") === true, "gpt-4.1-mini → OpenAI");
assert(isOpenAIModel("o3") === true, "o3 → OpenAI");
assert(isOpenAIModel("o3-pro") === true, "o3-pro → OpenAI");
assert(isOpenAIModel("o4-mini") === true, "o4-mini → OpenAI");
assert(isOpenAIModel("claude-sonnet-4-6") === false, "sonnet → not OpenAI");
assert(isOpenAIModel("claude-opus-4-6") === false, "opus → not OpenAI");
assert(isOpenAIModel("claude-haiku-4-5-20251001") === false, "haiku → not OpenAI");

// ─── NRT: OpenAIClient._convertTools ───────────────────────────────

process.stderr.write("\n\x1b[1m[NRT] Tool conversion\x1b[0m\n");

{
  const client = new OpenAIClient({ apiKey: "test" });
  const tools = client._convertTools([
    { name: "Bash", description: "Run cmd", input_schema: { type: "object", properties: { command: { type: "string" } } } },
    { type: "web_search_20250305", name: "web_search", max_uses: 8 },
  ]);
  assert(tools.length === 1, "Server tools filtered out");
  assert(tools[0].type === "function", "Tool type is function");
  assert(tools[0].function.name === "Bash", "Tool name preserved");
  assert(tools[0].function.parameters?.type === "object", "input_schema → parameters");
}

{
  const client = new OpenAIClient({ apiKey: "test" });
  const tools = client._convertTools([]);
  assert(tools === undefined || tools?.length === 0, "Empty tools → undefined or empty");
}

{
  const client = new OpenAIClient({ apiKey: "test" });
  const tools = client._convertTools(null);
  assert(tools === undefined, "null tools → undefined");
}

// ─── NRT: OpenAIClient._convertMessages ────────────────────────────

process.stderr.write("\n\x1b[1m[NRT] Message conversion\x1b[0m\n");

// System blocks → system message (non-reasoning model)
{
  const client = new OpenAIClient({ apiKey: "test" });
  client._model = "gpt-4o";
  const msgs = client._convertMessages(
    [{ type: "text", text: "You are helpful", cache_control: { type: "ephemeral" } }],
    [{ role: "user", content: "Hello" }]
  );
  assert(msgs[0].role === "system", "System blocks → system role for gpt-4o");
  assert(msgs[0].content === "You are helpful", "System text extracted");
  assert(msgs[1].role === "user", "User message preserved");
  assert(msgs[1].content === "Hello", "User content preserved");
}

// System blocks → developer role (reasoning models)
{
  const client = new OpenAIClient({ apiKey: "test" });
  client._model = "o3";
  const msgs = client._convertMessages(
    [{ type: "text", text: "Instructions" }],
    [{ role: "user", content: "Hi" }]
  );
  assert(msgs[0].role === "developer", "o3 → developer role");
}

{
  const client = new OpenAIClient({ apiKey: "test" });
  client._model = "o4-mini";
  const msgs = client._convertMessages(
    [{ type: "text", text: "Instructions" }],
    []
  );
  assert(msgs[0].role === "developer", "o4-mini → developer role");
}

{
  const client = new OpenAIClient({ apiKey: "test" });
  client._model = "o3-pro";
  const msgs = client._convertMessages(
    [{ type: "text", text: "Instructions" }],
    []
  );
  assert(msgs[0].role === "developer", "o3-pro → developer role");
}

// Multiple system blocks joined
{
  const client = new OpenAIClient({ apiKey: "test" });
  client._model = "gpt-4o";
  const msgs = client._convertMessages(
    [{ type: "text", text: "Block 1" }, { type: "text", text: "Block 2" }],
    []
  );
  assert(msgs[0].content === "Block 1\n\nBlock 2", "Multiple system blocks joined");
}

// Tool result conversion
{
  const client = new OpenAIClient({ apiKey: "test" });
  client._model = "gpt-4o";
  const msgs = client._convertMessages([], [
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "call_123", content: "file contents" },
    ] },
  ]);
  assert(msgs[0].role === "tool", "tool_result → role: tool");
  assert(msgs[0].tool_call_id === "call_123", "tool_use_id → tool_call_id");
  assert(msgs[0].content === "file contents", "Tool result content preserved");
}

// Multiple tool results
{
  const client = new OpenAIClient({ apiKey: "test" });
  client._model = "gpt-4o";
  const msgs = client._convertMessages([], [
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "call_1", content: "result 1" },
      { type: "tool_result", tool_use_id: "call_2", content: "result 2" },
    ] },
  ]);
  assert(msgs.length === 2, "Two tool results → two messages");
  assert(msgs[0].tool_call_id === "call_1", "First tool result ID");
  assert(msgs[1].tool_call_id === "call_2", "Second tool result ID");
}

// Assistant with tool_use blocks
{
  const client = new OpenAIClient({ apiKey: "test" });
  client._model = "gpt-4o";
  const msgs = client._convertMessages([], [
    { role: "assistant", content: [
      { type: "text", text: "Let me check" },
      { type: "tool_use", id: "call_456", name: "Bash", input: { command: "ls" } },
    ] },
  ]);
  assert(msgs[0].role === "assistant", "Assistant role preserved");
  assert(msgs[0].content === "Let me check", "Assistant text preserved");
  assert(msgs[0].tool_calls.length === 1, "One tool call");
  assert(msgs[0].tool_calls[0].id === "call_456", "Tool call ID preserved");
  assert(msgs[0].tool_calls[0].type === "function", "Tool call type is function");
  assert(msgs[0].tool_calls[0].function.name === "Bash", "Tool call name preserved");
  assert(msgs[0].tool_calls[0].function.arguments === '{"command":"ls"}', "Tool call args serialized");
}

// Assistant with text only (string content)
{
  const client = new OpenAIClient({ apiKey: "test" });
  client._model = "gpt-4o";
  const msgs = client._convertMessages([], [
    { role: "assistant", content: "Just text" },
  ]);
  assert(msgs[0].role === "assistant", "String assistant preserved");
  assert(msgs[0].content === "Just text", "String content preserved");
}

// ─── NRT: _isReasoningModel ────────────────────────────────────────

process.stderr.write("\n\x1b[1m[NRT] Reasoning model detection\x1b[0m\n");

{
  const client = new OpenAIClient({ apiKey: "test" });
  assert(client._isReasoningModel("o3") === true, "o3 is reasoning");
  assert(client._isReasoningModel("o3-pro") === true, "o3-pro is reasoning");
  assert(client._isReasoningModel("o3-mini") === true, "o3-mini is reasoning");
  assert(client._isReasoningModel("o4-mini") === true, "o4-mini is reasoning");
  assert(client._isReasoningModel("o1") === true, "o1 is reasoning");
  assert(client._isReasoningModel("gpt-4o") === false, "gpt-4o not reasoning");
  assert(client._isReasoningModel("gpt-5.2-codex") === false, "codex not reasoning");
  assert(client._isReasoningModel("gpt-4.1") === false, "gpt-4.1 not reasoning");
}

// ─── E2E: Live API calls (requires OPENAI_API_KEY or --oauth) ──────

const runE2E = process.argv.includes("--e2e");
const useOAuth = process.argv.includes("--oauth");

if (runE2E) {
  process.stderr.write("\n\x1b[1m[E2E] Live OpenAI API calls\x1b[0m\n");

  // Simple one-shot
  {
    const extraArgs = useOAuth ? ["--openai"] : [];
    const { exitCode, stdout, stderr } = await runCLI(
      ["-m", "gpt-4o-mini", "-p", "Reply with exactly: HELLO_TEST_OK", "--max-tokens", "50", "--permission-mode", "bypassPermissions", ...extraArgs],
      useOAuth ? {} : undefined,
      30000
    );
    assert(exitCode === 0, "E2E gpt-4o-mini exits 0");
    assert(stdout.includes("HELLO_TEST_OK"), "E2E gpt-4o-mini returns expected text");
    if (!stdout.includes("HELLO_TEST_OK")) {
      process.stderr.write(`    stdout: ${stdout.substring(0, 200)}\n`);
      process.stderr.write(`    stderr: ${stderr.substring(0, 300)}\n`);
    }
  }

  // Tool calling E2E
  {
    const extraArgs = useOAuth ? ["--openai"] : [];
    const { exitCode, stdout, stderr } = await runCLI(
      ["-m", "gpt-4o-mini", "-p", "Use the Bash tool to run: echo E2E_TOOL_OK", "--max-turns", "3", "--permission-mode", "bypassPermissions", ...extraArgs],
      useOAuth ? {} : undefined,
      60000
    );
    assert(exitCode === 0, "E2E tool calling exits 0");
    const output = stdout + stderr;
    assert(output.includes("E2E_TOOL_OK"), "E2E tool calling → Bash output visible");
    if (!output.includes("E2E_TOOL_OK")) {
      process.stderr.write(`    stdout: ${stdout.substring(0, 300)}\n`);
      process.stderr.write(`    stderr: ${stderr.substring(0, 300)}\n`);
    }
  }

  // Reasoning model E2E
  {
    const extraArgs = useOAuth ? ["--openai"] : [];
    const { exitCode, stdout } = await runCLI(
      ["-m", "o4-mini", "-p", "What is 7*8? Reply with just the number.", "--max-tokens", "100", "--permission-mode", "bypassPermissions", ...extraArgs],
      useOAuth ? {} : undefined,
      60000
    );
    assert(exitCode === 0, "E2E o4-mini exits 0");
    assert(stdout.includes("56"), "E2E o4-mini correct answer (56)");
    if (!stdout.includes("56")) {
      process.stderr.write(`    stdout: ${stdout.substring(0, 200)}\n`);
    }
  }
} else {
  process.stderr.write("\n\x1b[2mSkipping E2E tests (use --e2e flag, needs OPENAI_API_KEY or --oauth)\x1b[0m\n");
}

// ─── Summary ───────────────────────────────────────────────────────

process.stderr.write(`\n\x1b[1m${"═".repeat(50)}\x1b[0m\n`);
process.stderr.write(`  \x1b[32m${passed} passed\x1b[0m`);
if (failed > 0) process.stderr.write(`, \x1b[31m${failed} failed\x1b[0m`);
process.stderr.write(`\n`);
if (failures.length > 0) {
  process.stderr.write(`  Failures:\n`);
  for (const f of failures) process.stderr.write(`    \x1b[31m✗\x1b[0m ${f}\n`);
}
process.stderr.write(`\x1b[1m${"═".repeat(50)}\x1b[0m\n\n`);
process.exit(failed > 0 ? 1 : 0);


// ─── Helpers ───────────────────────────────────────────────────────

function runCLI(args, envOverrides = {}, timeout = 10000) {
  return new Promise((resolve) => {
    const env = { ...process.env, ...envOverrides };
    const child = spawn("node", [SCRIPT, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      timeout,
    });

    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => stdout += d);
    child.stderr.on("data", (d) => stderr += d);
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
    child.on("error", () => resolve({ exitCode: 1, stdout, stderr: stderr + " (spawn error)" }));
    setTimeout(() => { try { child.kill(); } catch {} }, timeout);
  });
}
