#!/usr/bin/env node
// Test MCP mode: Claude Code calls external tools via MCP server
//
// This test:
// 1. Starts claude-tool-loop in MCP mode
// 2. Sends a message with tools defined
// 3. The bridge spawns a child MCP server that exposes those tools
// 4. Claude Code calls the tools via MCP natively
// 5. The MCP server proxies tool calls to the parent (bridge)
// 6. The bridge proxies them to us (the test agent)

"use strict";

const { spawn } = require("child_process");
const path = require("path");

const loopScript = path.join(__dirname, "claude-tool-loop.js");

const child = spawn("node", [
  loopScript,
  "--mode", "mcp",
  "--model", "sonnet",
  "--verbose",
  "--system-prompt", "You are Hamza, an AI project management consultant. You have access to tools via MCP. Use them to complete tasks.",
], {
  stdio: ["pipe", "pipe", "inherit"],
});

const tools = [
  {
    name: "search_drive",
    description: "Search for files in Google Drive matching a query. Returns file names, IDs and modification dates.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for Drive files" },
      },
      required: ["query"],
    },
  },
  {
    name: "store_entity",
    description: "Store an entity (Project, Person, Document, Decision, etc.) in the knowledge graph.",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string", description: "Entity type: Project, Person, Document, Decision, Vocabulary, etc." },
        name: { type: "string", description: "Entity name" },
        properties: { type: "object", description: "Key-value properties", additionalProperties: true },
      },
      required: ["label", "name"],
    },
  },
];

function executeTool(name, input) {
  console.error(`\n  EXECUTE: ${name}(${JSON.stringify(input)})\n`);
  switch (name) {
    case "search_drive":
      return JSON.stringify({
        files: [
          { id: "f1", name: "Projet Migration Cloud.docx", modified: "2026-03-20" },
          { id: "f2", name: "Budget Migration Q2.xlsx", modified: "2026-03-18" },
        ],
      });
    case "store_entity":
      return JSON.stringify({ status: "created", node_id: `neo4j_${Date.now()}` });
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
      console.error("Parse error:", e.message, line.substring(0, 80));
    }
  }
});

function handleMessage(msg) {
  console.error(`  << ${msg.type} ${msg.name || msg.content?.substring?.(0, 50) || ""}`);

  switch (msg.type) {
    case "ready":
      console.error(`  Ready (v${msg.version}, mode=${msg.mode})\n`);
      send({
        type: "message",
        content: "Search Google Drive for files about 'migration' and store each result in the knowledge graph.",
        tools,
        system: "Client: Acme Corp. Current project: Cloud Migration.",
        context: "The user is a PMO consultant working on Acme's cloud migration.",
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
