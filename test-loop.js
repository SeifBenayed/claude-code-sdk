#!/usr/bin/env node
// Test: simulates an external agent using claude-tool-loop v2
//
// Tests the "stream" mode (prompt-engineered XML tool calls).
// Sends a message with tools, handles tool_use/tool_result cycle.

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const loopScript = path.join(__dirname, "claude-tool-loop.js");

const child = spawn("node", [
  loopScript,
  "--mode", "stream",
  "--model", "sonnet",
  "--verbose",
], {
  stdio: ["pipe", "pipe", "inherit"],
});

const tools = [
  {
    name: "search_files",
    description: "Search for files in Google Drive. Returns a list of file names and IDs.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
  },
  {
    name: "store_in_graph",
    description: "Store an entity in the knowledge graph (Neo4j).",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Entity label (e.g. Project, Person)" },
        name: { type: "string", description: "Entity name" },
        properties: { type: "object", additionalProperties: true },
      },
      required: ["label", "name"],
    },
  },
];

function executeTool(name, input) {
  console.error(`\n  TOOL: ${name}(${JSON.stringify(input)})\n`);
  switch (name) {
    case "search_files":
      return JSON.stringify({
        files: [
          { id: "f1", name: "Projet Migration Cloud.docx", modified: "2026-03-20" },
          { id: "f2", name: "Budget Migration Q2.xlsx", modified: "2026-03-18" },
        ],
      });
    case "store_in_graph":
      return JSON.stringify({ status: "created", node_id: `n_${Date.now()}` });
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try { handleMessage(JSON.parse(line)); } catch (e) {
      console.error("Parse error:", line.substring(0, 100));
    }
  }
});

function handleMessage(msg) {
  console.error(`\n  << ${msg.type} ${msg.name || msg.content?.substring(0, 60) || ""}`);

  switch (msg.type) {
    case "ready":
      console.error(`  Ready (v${msg.version}, mode=${msg.mode})\n`);
      send({
        type: "message",
        content: "Cherche les projets sur Google Drive qui contiennent 'migration' et stocke chaque résultat dans le knowledge graph.",
        tools,
        system: "You are Hamza, an AI project management consultant.",
        context: "## Knowledge\nClient: Acme Corp\nCurrent focus: Cloud migration project",
      });
      break;

    case "tool_use":
      const result = executeTool(msg.name, msg.input);
      send({
        type: "tool_result",
        id: msg.id,
        content: result,
        is_error: false,
      });
      break;

    case "response":
      console.error("\n" + "=".repeat(60));
      console.error("FINAL RESPONSE:");
      console.error("=".repeat(60));
      console.error(msg.content);
      console.error("=".repeat(60));
      console.error(`Iterations: ${msg.iterations} | Cost: $${msg.cost || 0}`);
      console.error("=".repeat(60) + "\n");
      child.stdin.end();
      break;

    case "error":
      console.error(`\n  ERROR: ${msg.error}\n`);
      child.stdin.end();
      break;
  }
}

function send(obj) {
  console.error(`  >> ${obj.type} ${obj.id || ""}`);
  child.stdin.write(JSON.stringify(obj) + "\n");
}

child.on("close", (code) => {
  console.error(`\nExit code: ${code}`);
  process.exit(code || 0);
});

setTimeout(() => {
  console.error("\n  TIMEOUT (5min)");
  child.kill();
  process.exit(1);
}, 300_000);
