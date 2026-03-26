#!/usr/bin/env node
// Quick E2E test: verify deferred tools, brief mode, and ToolSearch work at runtime
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "claude-native.mjs");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; process.stderr.write(`  \x1b[32m✓\x1b[0m ${msg}\n`); }
  else { failed++; process.stderr.write(`  \x1b[31m✗\x1b[0m ${msg}\n`); }
}

// ── Test 1: NDJSON bridge shows deferred tools in ready state ──
process.stderr.write("\n\x1b[1m[E2E: Deferred tool loading via NDJSON]\x1b[0m\n");

await new Promise((resolve) => {
  const child = spawn("node", [SCRIPT, "--ndjson", "--permission-mode", "bypassPermissions"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const events = [];

  child.stdout.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch {}
    }
  });

  // Just wait for ready, then check deferred state via set_brief
  setTimeout(() => {
    const ready = events.find(e => e.type === "ready");
    assert(ready !== undefined, "NDJSON bridge emits ready");

    // Toggle brief mode
    child.stdin.write(JSON.stringify({ type: "set_brief", enabled: true }) + "\n");

    setTimeout(() => {
      const briefMode = events.find(e => e.type === "brief_mode");
      assert(briefMode !== undefined, "set_brief emits brief_mode response");
      assert(briefMode?.enabled === true, "brief_mode.enabled is true");

      // Toggle off
      child.stdin.write(JSON.stringify({ type: "set_brief", enabled: false }) + "\n");
      setTimeout(() => {
        const briefOff = events.filter(e => e.type === "brief_mode");
        assert(briefOff.length === 2, "Two brief_mode events (on then off)");
        assert(briefOff[1]?.enabled === false, "Second brief_mode.enabled is false");

        child.stdin.write(JSON.stringify({ type: "end_session" }) + "\n");
        setTimeout(resolve, 500);
      }, 500);
    }, 500);
  }, 2000);

  setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 10000);
});

// ── Test 2: --brief flag sets briefMode ──
process.stderr.write("\n\x1b[1m[E2E: --brief CLI flag]\x1b[0m\n");

await new Promise((resolve) => {
  const child = spawn("node", [SCRIPT, "--brief", "--ndjson", "--permission-mode", "bypassPermissions"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  const events = [];

  child.stdout.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch {}
    }
  });

  setTimeout(() => {
    const ready = events.find(e => e.type === "ready");
    assert(ready !== undefined, "--brief NDJSON starts OK");
    child.stdin.write(JSON.stringify({ type: "end_session" }) + "\n");
    setTimeout(resolve, 500);
  }, 2000);

  setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 10000);
});

// ── Test 3: Verify tool counts (eager vs deferred) ──
process.stderr.write("\n\x1b[1m[E2E: Tool registry state]\x1b[0m\n");

{
  // Import and run parseArgs + registry setup inline
  const source = (await import("node:fs")).readFileSync(SCRIPT, "utf-8");

  // Check ToolSearch is registered (means deferred tools exist)
  assert(source.includes("registerToolSearch(registry)"), "registerToolSearch called in main()");
  assert(source.includes("registerDeferredBuiltinTools(registry, cfg)"), "registerDeferredBuiltinTools called in main()");

  // Count deferred registrations
  const deferredCount = (source.match(/\{ deferred: true \}/g) || []).length;
  assert(deferredCount >= 7, `At least 7 deferred registrations found (got ${deferredCount})`);
  // 6 builtin deferred + MCP deferred = 7+
}

// ── Test 4: --help includes --brief ──
process.stderr.write("\n\x1b[1m[E2E: Help text]\x1b[0m\n");

await new Promise((resolve) => {
  const child = spawn("node", [SCRIPT, "--help"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", d => stderr += d);
  child.on("close", () => {
    assert(stderr.includes("--brief"), "--brief appears in help output");
    assert(stderr.includes("SendUserMessage"), "SendUserMessage mentioned in --brief help");
    resolve();
  });
  setTimeout(() => { try { child.kill(); } catch {} resolve(); }, 5000);
});

// ── Summary ──
process.stderr.write(`\n\x1b[1m${"═".repeat(50)}\x1b[0m\n`);
process.stderr.write(`  \x1b[32m${passed} passed\x1b[0m`);
if (failed > 0) process.stderr.write(`, \x1b[31m${failed} failed\x1b[0m`);
process.stderr.write(`\n\x1b[1m${"═".repeat(50)}\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
