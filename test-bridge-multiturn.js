#!/usr/bin/env node
// Test: NDJSON bridge — multi-turn coding agent workflow
// Agent sends a task, LLM uses Write → Edit → Read in sequence
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const tmpFile = path.join(os.tmpdir(), "bridge-test-" + Date.now() + ".py");

const child = spawn("node", [
  path.join(__dirname, "claude-tool-loop.js"),
  "--mode", "stream",
  "--model", "gpt-5.4",
  "--verbose",
], { stdio: ["pipe", "pipe", "inherit"] });

let buffer = "";
let turnCount = 0;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try { handleMessage(JSON.parse(line)); } catch {}
  }
});

function handleMessage(msg) {
  console.error(`  << ${msg.type} ${msg.name || (msg.content || "").substring(0, 80)}`);
  switch (msg.type) {
    case "ready":
      send({
        type: "message",
        content: `Do these steps in order using the tools:
1. Write this Python file to ${tmpFile}:
\`\`\`python
import os
import sys
import json
import logging

DEBUG = True

def process(data):
    return [x.strip() for x in data]
\`\`\`

2. Edit ${tmpFile}: remove 'import sys' (it's unused) using old_string="import sys" new_string=""
3. Edit ${tmpFile}: change DEBUG = True to DEBUG = False
4. Read ${tmpFile} and show me the final content`,
        tools: [],
        system: "You are a coding assistant. Execute all tool calls as requested.",
      });
      break;
    case "tool_use":
      turnCount++;
      console.error(`  TURN ${turnCount}: ${msg.name}(${JSON.stringify(msg.input).substring(0, 100)}...)`);
      // Don't interfere — let cloclo handle the builtin tools internally
      // In stream mode, builtin tools are handled by cloclo, not forwarded
      break;
    case "response":
      console.error("\n=== AGENT RESPONSE ===");
      console.error(msg.content);
      console.error("======================");
      console.error("Tool turns:", turnCount, "| Cost: $" + (msg.cost || 0));

      // Verify the file
      if (fs.existsSync(tmpFile)) {
        const content = fs.readFileSync(tmpFile, "utf-8");
        console.error("\n=== FILE VERIFICATION ===");
        console.error(content);
        console.error("=========================");

        const checks = [
          [!content.includes("import sys"), "import sys removed"],
          [content.includes("import os"), "import os kept"],
          [content.includes("import json"), "import json kept"],
          [content.includes("DEBUG = False"), "DEBUG changed to False"],
          [!content.includes("DEBUG = True"), "DEBUG = True gone"],
          [content.includes("def process"), "function intact"],
          [!content.includes("\n\n\nimport"), "no triple newlines (clean delete)"],
        ];

        for (const [ok, label] of checks) {
          console.error(`  ${ok ? "✓" : "✗"} ${label}`);
        }

        fs.unlinkSync(tmpFile);
      } else {
        console.error("FAIL: file was not created");
      }

      child.stdin.end();
      break;
    case "error":
      console.error("ERROR:", msg.error);
      child.stdin.end();
      break;
  }
}

function send(obj) {
  console.error("  >> " + obj.type);
  child.stdin.write(JSON.stringify(obj) + "\n");
}

child.on("close", (code) => {
  console.error("Exit:", code);
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  process.exit(code || 0);
});

setTimeout(() => { console.error("TIMEOUT"); child.kill(); process.exit(1); }, 120000);
