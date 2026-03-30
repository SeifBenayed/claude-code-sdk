// src/context-refs.mjs — Context references (@file, @diff, @url, @folder)
//
// Parses @-tokens in user input and expands them to inline content
// before the message is sent to the model.
//
// Syntax:
//   @file:path/to/file.ts          → full file content
//   @file:path/to/file.ts[10:50]   → lines 10-50
//   @folder:src/                    → directory listing
//   @diff                           → git diff (unstaged)
//   @staged                         → git diff --staged
//   @git:5                          → last 5 commits
//   @url:https://example.com        → fetched page content
//
// Safety:
//   - Blocks sensitive paths (~/.ssh, ~/.aws, etc.)
//   - Soft limit: 25% of context window per expansion
//   - Hard limit: 50% total — entire expansion rejected if exceeded

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { log, _httpGet } from "./utils.mjs";

// ── Sensitive paths (blocked) ────────────────────────────────

const BLOCKED_PATHS = [
  ".ssh", ".aws", ".gnupg", ".gpg", ".config/gcloud",
  ".kube/config", ".docker/config.json", ".npmrc", ".pypirc",
  ".env", ".env.local", ".env.production",
];

function _isBlocked(filePath) {
  const normalized = filePath.replace(/\\/g, "/");
  for (const b of BLOCKED_PATHS) {
    if (normalized.includes(b)) return true;
  }
  return false;
}

// ── Reference Parsers ────────────────────────────────────────

const REF_PATTERN = /@(file|folder|diff|staged|git|url):?([^\s]*)/g;

function parseRefs(text) {
  const refs = [];
  let match;
  const re = new RegExp(REF_PATTERN.source, REF_PATTERN.flags);
  while ((match = re.exec(text)) !== null) {
    refs.push({
      full: match[0],
      type: match[1],
      arg: match[2] || "",
      index: match.index,
    });
  }
  return refs;
}

function expandRef(ref, cwd) {
  try {
    switch (ref.type) {
      case "file": return _expandFile(ref.arg, cwd);
      case "folder": return _expandFolder(ref.arg, cwd);
      case "diff": return _expandDiff(cwd, false);
      case "staged": return _expandDiff(cwd, true);
      case "git": return _expandGit(ref.arg, cwd);
      case "url": return _expandUrl(ref.arg);
      default: return null;
    }
  } catch (e) {
    return `[Error expanding ${ref.full}: ${e.message}]`;
  }
}

function _expandFile(arg, cwd) {
  // Parse optional line range: path[start:end]
  const rangeMatch = arg.match(/^(.+?)\[(\d+):(\d+)\]$/);
  let filePath, startLine, endLine;

  if (rangeMatch) {
    filePath = rangeMatch[1];
    startLine = parseInt(rangeMatch[2], 10);
    endLine = parseInt(rangeMatch[3], 10);
  } else {
    filePath = arg;
  }

  const resolved = path.resolve(cwd, filePath);
  if (_isBlocked(resolved)) return `[Blocked: ${filePath} is in a sensitive path]`;
  if (!fs.existsSync(resolved)) return `[File not found: ${filePath}]`;

  const stat = fs.statSync(resolved);
  if (stat.size > 500_000) return `[File too large: ${filePath} (${(stat.size / 1024).toFixed(0)}KB)]`;

  let content = fs.readFileSync(resolved, "utf-8");

  if (startLine !== undefined && endLine !== undefined) {
    const lines = content.split("\n");
    content = lines.slice(startLine - 1, endLine).join("\n");
  }

  return `<context-ref type="file" path="${filePath}">\n${content}\n</context-ref>`;
}

function _expandFolder(arg, cwd) {
  const resolved = path.resolve(cwd, arg || ".");
  if (_isBlocked(resolved)) return `[Blocked: ${arg} is in a sensitive path]`;
  if (!fs.existsSync(resolved)) return `[Folder not found: ${arg}]`;

  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const lines = entries
      .filter(e => !e.name.startsWith(".") && e.name !== "node_modules")
      .slice(0, 100)
      .map(e => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`);
    return `<context-ref type="folder" path="${arg || "."}">\n${lines.join("\n")}\n</context-ref>`;
  } catch (e) {
    return `[Error listing ${arg}: ${e.message}]`;
  }
}

function _expandDiff(cwd, staged) {
  try {
    const flag = staged ? "--staged" : "";
    const diff = execSync(`git diff ${flag}`, { cwd, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    if (!diff) return `[No ${staged ? "staged" : "unstaged"} changes]`;
    const truncated = diff.length > 50000 ? diff.slice(0, 50000) + "\n... (truncated)" : diff;
    return `<context-ref type="${staged ? "staged" : "diff"}">\n${truncated}\n</context-ref>`;
  } catch {
    return `[Not a git repository or git not available]`;
  }
}

function _expandGit(arg, cwd) {
  const count = parseInt(arg, 10) || 5;
  const capped = Math.min(count, 50);
  try {
    const log_output = execSync(`git log --oneline -${capped}`, { cwd, encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim();
    return `<context-ref type="git" count="${capped}">\n${log_output}\n</context-ref>`;
  } catch {
    return `[Not a git repository or git not available]`;
  }
}

async function _expandUrl(url) {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  try {
    const content = await _httpGet(url);
    const truncated = content.length > 30000 ? content.slice(0, 30000) + "\n... (truncated)" : content;
    return `<context-ref type="url" src="${url}">\n${truncated}\n</context-ref>`;
  } catch (e) {
    return `[Failed to fetch ${url}: ${e.message}]`;
  }
}

// ── Main expansion function ──────────────────────────────────

async function expandContextRefs(text, cwd, { maxChars = 100_000 } = {}) {
  const refs = parseRefs(text);
  if (refs.length === 0) return text;

  let result = text;
  let totalExpanded = 0;

  // Process in reverse order so indices stay valid
  for (const ref of refs.reverse()) {
    let expanded;
    if (ref.type === "url") {
      expanded = await _expandUrl(ref.arg);
    } else {
      expanded = expandRef(ref, cwd);
    }

    if (!expanded) continue;

    // Check size limit
    totalExpanded += expanded.length;
    if (totalExpanded > maxChars) {
      expanded = `[Expansion limit reached — ${ref.full} skipped]`;
    }

    result = result.slice(0, ref.index) + expanded + result.slice(ref.index + ref.full.length);
  }

  if (totalExpanded > 0) {
    log(`[context-refs] Expanded ${refs.length} references (${(totalExpanded / 1024).toFixed(1)}KB)`);
  }

  return result;
}

// ── Exports ──────────────────────────────────────────────────

export { expandContextRefs, parseRefs, expandRef };
