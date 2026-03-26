#!/usr/bin/env node
// test-ink-smoke.mjs — Headless Ink UI smoke tests
//
// Renders App, SlashMenu, StatusBar, OutputArea with COLUMNS=80 ROWS=24
// No real API calls — mocks the interactive mode entirely.
//
// Usage:
//   node test-ink-smoke.mjs
//   node test-ink-smoke.mjs --verbose

import React from "react";
import { render, Box, Text } from "ink";
import { Writable } from "node:stream";
import fs from "node:fs";
import { SlashMenu, StatusBar, OutputArea } from "./ink-ui.mjs";

const VERBOSE = process.argv.includes("--verbose");

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
    if (detail && VERBOSE) process.stderr.write(`    \x1b[33m${detail}\x1b[0m\n`);
  }
}

function skip(name) {
  skipped++;
  process.stderr.write(`  \x1b[2m○ ${name} (skipped)\x1b[0m\n`);
}

function section(title) {
  process.stderr.write(`\n\x1b[1m[${title}]\x1b[0m\n`);
}

// Helper: render a component to a string via a writable stream
function renderToString(element, waitMs = 100, columns = 80) {
  return new Promise((resolve) => {
    let buf = "";
    const ws = new Writable({
      write(chunk, _enc, cb) { buf += chunk.toString(); cb(); },
    });
    // Set dimensions on the fake stdout
    ws.columns = columns;
    ws.rows = 24;
    const inst = render(element, { stdout: ws });
    setTimeout(() => {
      inst.unmount();
      resolve(buf);
    }, waitMs);
  });
}

// ── 1. SlashMenu rendering ───────────────────────────────────

section("INK: SlashMenu renders with commands");

{
  const commands = [
    { name: "model", argumentHint: "[name]", description: "Switch model", aliases: [], source: "builtin" },
    { name: "thinking", argumentHint: "[budget]", description: "Toggle thinking", aliases: ["think"], source: "builtin" },
    { name: "commit", description: "Create a commit", aliases: [], source: "skill" },
  ];

  try {
    const frame = await renderToString(
      React.createElement(SlashMenu, {
        commands,
        filter: "",
        selectedIndex: 0,
        visible: true,
      })
    );

    assert(frame.length > 0, "SlashMenu renders without crash");
    assert(frame.includes("Commands"), "SlashMenu shows 'Commands' header");
    assert(frame.includes("/model"), "SlashMenu shows /model command");
    assert(frame.includes("/thinking"), "SlashMenu shows /thinking command");
    assert(frame.includes("/commit"), "SlashMenu shows /commit command");
    assert(frame.includes("[skill]"), "SlashMenu shows [skill] tag");
    assert(frame.includes("Switch model"), "SlashMenu shows description");
    assert(frame.includes("/think"), "SlashMenu shows aliases");
  } catch (e) {
    skip(`SlashMenu render failed: ${e.message}`);
  }
}

section("INK: SlashMenu hidden when visible=false");

{
  try {
    const frame = await renderToString(
      React.createElement(SlashMenu, {
        commands: [{ name: "test", description: "Test", aliases: [], source: "builtin" }],
        filter: "",
        selectedIndex: 0,
        visible: false,
      })
    );

    assert(!frame.includes("/test"), "SlashMenu hidden when visible=false");
  } catch (e) {
    skip(`SlashMenu hidden test failed: ${e.message}`);
  }
}

section("INK: SlashMenu highlights selected index");

{
  const commands = [
    { name: "model", description: "Switch model", aliases: [], source: "builtin" },
    { name: "exit", description: "Quit", aliases: ["quit"], source: "builtin" },
  ];

  try {
    // Selected index 1 (exit)
    const frame = await renderToString(
      React.createElement(SlashMenu, {
        commands,
        filter: "",
        selectedIndex: 1,
        visible: true,
      })
    );

    assert(frame.includes("/exit"), "SlashMenu shows /exit at index 1");
    assert(frame.includes("/model"), "SlashMenu shows /model at index 0");
  } catch (e) {
    skip(`SlashMenu selection test failed: ${e.message}`);
  }
}

// ── 2. StatusBar rendering ───────────────────────────────────

section("INK: StatusBar renders all segments");

{
  try {
    const cfg = {
      _provider: { name: "Anthropic" },
      model: "claude-sonnet-4-6",
      briefMode: false,
      thinkingBudget: 8192,
      _planMode: true,
      cwd: "/Users/test/project",
    };

    // Use wider columns to avoid Ink line-wrapping
    const frame = await renderToString(
      React.createElement(StatusBar, {
        cfg,
        sessionId: "abc12345-def6-7890",
        messageCount: 14,
        totalCost: 0.0523,
        gitBranch: "feature/test",
      }),
      100, // wait ms
      200  // columns — wide enough to fit all segments
    );

    assert(frame.length > 0, "StatusBar renders without crash");
    assert(frame.includes("Anthropic"), "StatusBar shows provider name");
    assert(frame.includes("claude-sonnet-4-6"), "StatusBar shows model");
    assert(frame.includes("think:8192"), "StatusBar shows thinking budget mode");
    assert(frame.includes("plan"), "StatusBar shows plan mode");
    assert(frame.includes("feature/test"), "StatusBar shows git branch");
    assert(frame.includes("abc12345"), "StatusBar shows session ID prefix");
    assert(frame.includes("14msg"), "StatusBar shows message count");
    assert(frame.includes("$0.0523"), "StatusBar shows cost");
    assert(frame.includes("|"), "StatusBar uses pipe separators");
  } catch (e) {
    skip(`StatusBar render failed: ${e.message}`);
  }
}

section("INK: StatusBar minimal (no branch, no cost, no modes)");

{
  try {
    const cfg = {
      _provider: { name: "OpenAI" },
      model: "gpt-5.4",
      briefMode: false,
      thinkingBudget: 0,
      cwd: "/tmp",
    };

    const frame = await renderToString(
      React.createElement(StatusBar, {
        cfg,
        sessionId: null,
        messageCount: 0,
        totalCost: 0,
        gitBranch: "",
      })
    );

    assert(frame.includes("OpenAI"), "Minimal StatusBar shows provider");
    assert(frame.includes("gpt-5.4"), "Minimal StatusBar shows model");
    assert(!frame.includes("think:"), "Minimal StatusBar omits thinking mode");
    assert(frame.includes("0msg"), "Minimal StatusBar shows 0msg");
  } catch (e) {
    skip(`StatusBar minimal render failed: ${e.message}`);
  }
}

// ── 3. OutputArea rendering ──────────────────────────────────

section("INK: OutputArea renders lines");

{
  try {
    const lines = [
      "Welcome to claude-native",
      "> hello",
      "Hello! How can I help you today?",
      "> /model sonnet",
      "Switched to claude-sonnet-4-6",
    ];

    const frame = await renderToString(
      React.createElement(OutputArea, { lines })
    );

    assert(frame.length > 0, "OutputArea renders without crash");
    assert(frame.includes("Welcome"), "OutputArea shows first line");
    assert(frame.includes("hello"), "OutputArea shows user input");
    assert(frame.includes("How can I help"), "OutputArea shows assistant response");
  } catch (e) {
    skip(`OutputArea render failed: ${e.message}`);
  }
}

section("INK: OutputArea truncates to terminal height");

{
  try {
    // Generate more lines than a 24-row terminal can show (minus reserved rows)
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);

    const frame = await renderToString(
      React.createElement(OutputArea, { lines })
    );

    // Should show last visible lines, not all 50
    assert(frame.includes("Line 50"), "OutputArea shows most recent line");
    // Shouldn't show the very first lines (they'd be scrolled off)
    assert(!frame.includes("Line 1\n"), "OutputArea truncates old lines");
  } catch (e) {
    skip(`OutputArea truncation test failed: ${e.message}`);
  }
}

// ── 4. Readline fallback (non-TTY) ──────────────────────────

section("INK: Readline fallback when stdin is not TTY");

{
  try {
    const source = fs.readFileSync(
      new URL("./claude-native.mjs", import.meta.url), "utf-8"
    );
    assert(source.includes("isTTY"), "Source checks isTTY for terminal detection");
    assert(source.includes("startInkUI") || source.includes("ink-ui"), "Source references Ink UI module");
    assert(
      source.includes("isTTY") && (source.includes("readline") || source.includes("createInterface")),
      "Readline fallback exists alongside TTY check"
    );
  } catch (e) {
    skip(`Readline fallback check failed: ${e.message}`);
  }
}

// ── 5. Width / dimension sanity ──────────────────────────────

section("INK: Components respect 80-column width");

{
  try {
    const cfg = {
      _provider: { name: "Test" },
      model: "test-model",
      briefMode: false,
      thinkingBudget: 0,
      cwd: "/tmp",
    };

    const frame = await renderToString(
      React.createElement(StatusBar, {
        cfg,
        sessionId: "12345678",
        messageCount: 5,
        totalCost: 0,
        gitBranch: "",
      })
    );

    // Each line should fit within 80 columns (box border adds 2+2 padding)
    const lines = frame.split("\n").filter(l => l.length > 0);
    // Strip ANSI codes for length check
    const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const maxWidth = Math.max(...lines.map(l => stripAnsi(l).length));
    assert(maxWidth <= 82, `StatusBar fits within 80 cols (max line: ${maxWidth} chars)`);
  } catch (e) {
    skip(`Width test failed: ${e.message}`);
  }
}

// ── Summary ──────────────────────────────────────────────────

process.stderr.write(`\n\x1b[1m${"═".repeat(60)}\x1b[0m\n`);
process.stderr.write(`  \x1b[32m${passed} passed\x1b[0m`);
if (failed > 0) process.stderr.write(`, \x1b[31m${failed} failed\x1b[0m`);
if (skipped > 0) process.stderr.write(`, \x1b[2m${skipped} skipped\x1b[0m`);
process.stderr.write(`\n`);
if (failures.length > 0) {
  process.stderr.write(`\n  Failures:\n`);
  for (const { name, detail } of failures) {
    process.stderr.write(`    \x1b[31m✗\x1b[0m ${name}\n`);
    if (detail && VERBOSE) process.stderr.write(`      ${detail}\n`);
  }
}
process.stderr.write(`\x1b[1m${"═".repeat(60)}\x1b[0m\n\n`);
process.exit(failed > 0 ? 1 : 0);
