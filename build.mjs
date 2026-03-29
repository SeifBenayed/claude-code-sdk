#!/usr/bin/env node
// build.mjs — Simple bundler that concatenates ES modules into a single file
// Preserves original variable names (no renaming like esbuild does)

import fs from "node:fs";
import path from "node:path";

const srcDir = new URL("./src/", import.meta.url).pathname;

// Module order (respects dependency graph — leaves first)
const modules = [
  "utils.mjs",
  "config.mjs",
  "providers.mjs",
  "auth.mjs",
  "security-rules.mjs",
  "security.mjs",
  "browser.mjs",
  "tools.mjs",
  "lsp.mjs",
  "auto-memory.mjs",
  "audit.mjs",
  "teams.mjs",
  "sandbox.mjs",
  "context-refs.mjs",
  "smart-routing.mjs",
  "cron.mjs",
  "engine.mjs",
  "session.mjs",
  "index.mjs",
];

// These are the EXACT imports the original monolith had (lines 13-21).
// We hardcode them to avoid dedup complexity.
const BUILTIN_IMPORTS = `import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:http";
import _http from "node:http";
import _https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";`;

// Known node built-in module names (with and without node: prefix)
const BUILTINS = new Set([
  "fs", "path", "os", "http", "https", "child_process", "crypto", "readline", "url",
  "node:fs", "node:path", "node:os", "node:http", "node:https",
  "node:child_process", "node:crypto", "node:readline", "node:url",
]);

function isBuiltinOrLocalImport(line) {
  const fromMatch = line.match(/from\s+["']([^"']+)["']/);
  if (!fromMatch) return false;
  const spec = fromMatch[1];
  return spec.startsWith("./") || BUILTINS.has(spec);
}

const allLines = [];

for (const mod of modules) {
  const content = fs.readFileSync(path.join(srcDir, mod), "utf-8");
  const lines = content.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Handle single-line imports
    if (/^\s*import\s/.test(trimmed) && trimmed.includes("from") && (trimmed.endsWith(";") || trimmed.endsWith('"') || trimmed.endsWith("'"))) {
      if (isBuiltinOrLocalImport(trimmed)) { i++; continue; }
    }

    // Handle multi-line imports: `import {\n  ...\n} from "...";`
    if (/^\s*import\s+\{/.test(trimmed) && !trimmed.includes("from")) {
      // Collect all lines until we find the `from` line
      let j = i + 1;
      while (j < lines.length && !/from\s+["']/.test(lines[j])) j++;
      if (j < lines.length && isBuiltinOrLocalImport(lines[j])) {
        i = j + 1; // skip entire import block
        continue;
      }
    }

    // Handle single-line `import "xxx"` (side-effect imports)
    if (/^\s*import\s+["']/.test(trimmed)) {
      const specMatch = trimmed.match(/import\s+["']([^"']+)["']/);
      if (specMatch && (specMatch[1].startsWith("./") || BUILTINS.has(specMatch[1]))) { i++; continue; }
    }

    // Strip `export` keyword from inline exports
    if (/^\s*export\s+(const|let|var|function|async function|class)\s/.test(trimmed)) {
      allLines.push(line.replace(/^(\s*)export\s+/, "$1"));
      i++;
      continue;
    }

    // Skip export blocks: `export { ... };`
    if (/^\s*export\s*\{/.test(trimmed)) {
      if (trimmed.includes("}")) { i++; continue; } // single line
      // Multi-line export block
      let j = i + 1;
      while (j < lines.length && !lines[j].includes("}")) j++;
      i = j + 1;
      continue;
    }

    // Skip comments about imports
    if (/^\s*\/\/.*imported from .*\.mjs/.test(trimmed)) { i++; continue; }

    allLines.push(line);
    i++;
  }
}

// Build the output
const output = [
  "#!/usr/bin/env node",
  "// claude-native.mjs — Direct Anthropic API CLI (zero npm deps)",
  "//",
  "// Built from src/ modules. Do not edit directly.",
  "//",
  "// Usage:",
  "//   node claude-native.mjs                          # Interactive REPL",
  '//   node claude-native.mjs -p "explain this code"   # One-shot',
  `//   echo '{"type":"message","content":"hi"}' | node claude-native.mjs --ndjson`,
  "//   node claude-native.mjs --resume                 # Resume last session",
  "",
  BUILTIN_IMPORTS,
  "",
  ...allLines,
].join("\n");

fs.writeFileSync(new URL("./claude-native.mjs", import.meta.url).pathname, output);
console.log(`Built claude-native.mjs (${(output.length / 1024).toFixed(1)}KB, ${output.split("\n").length} lines)`);
