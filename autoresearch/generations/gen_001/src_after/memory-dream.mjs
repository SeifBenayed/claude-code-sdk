// src/memory-dream.mjs — Dream consolidation engine
//
// Periodic background LLM agent that cleans up memories.
// Follows CC's 4-phase Dream pattern: Orient → Gather Signal → Consolidate → Prune & Index

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log, getMemoryDir, ensureMemoryDir, getUserMemoryDir, ensureUserMemoryDir } from "./utils.mjs";
import { summarizeMemoryMetrics } from "./memory-metrics.mjs";

// ── Configuration ──────────────────────────────────────────────

const DREAM_MIN_SESSIONS = 5;   // sessions since last dream
const DREAM_MIN_HOURS = 24;     // hours since last dream
const DREAM_STATE_FILE = "dream-state.json";
const DREAM_LOCK_FILE = "dream.lock";
const LOCK_STALE_MS = 10 * 60 * 1000; // 10 minutes — consider lock stale after this

// ── Dream State ────────────────────────────────────────────────

function _dreamStatePath() {
  return path.join(os.homedir(), ".claude-native", DREAM_STATE_FILE);
}

function loadDreamState() {
  try {
    return JSON.parse(fs.readFileSync(_dreamStatePath(), "utf-8"));
  } catch {
    return { last_dream_at: null, session_count_since: 0, memories_at_last_dream: 0 };
  }
}

function saveDreamState(state) {
  const dir = path.dirname(_dreamStatePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(_dreamStatePath(), JSON.stringify(state, null, 2));
}

function incrementDreamSessionCount() {
  const state = loadDreamState();
  state.session_count_since = (state.session_count_since || 0) + 1;
  saveDreamState(state);
}

// ── Memory Counting ────────────────────────────────────────────

function countMemories(cwd) {
  let count = 0;
  for (const dir of [getMemoryDir(cwd), getUserMemoryDir()]) {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.endsWith(".md") && entry !== "MEMORY.md") count++;
      }
    } catch { /* dir may not exist */ }
  }
  return count;
}

// ── Should Dream? ──────────────────────────────────────────────

function shouldDream(cwd) {
  const state = loadDreamState();

  // Condition 1: enough sessions
  if ((state.session_count_since || 0) < DREAM_MIN_SESSIONS) return false;

  // Condition 2: enough time elapsed
  if (state.last_dream_at) {
    const hoursSince = (Date.now() - new Date(state.last_dream_at).getTime()) / (1000 * 60 * 60);
    if (hoursSince < DREAM_MIN_HOURS) return false;
  }

  // Condition 3: new memories exist since last dream
  const currentCount = countMemories(cwd);
  if (currentCount <= (state.memories_at_last_dream || 0)) return false;

  return true;
}

// ── Lockfile ───────────────────────────────────────────────────

function _lockPath(cwd) {
  return path.join(ensureMemoryDir(cwd), DREAM_LOCK_FILE);
}

function _acquireLock(cwd) {
  const lockPath = _lockPath(cwd);
  try {
    // Check for stale lock
    if (fs.existsSync(lockPath)) {
      const lockData = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
      const age = Date.now() - new Date(lockData.ts).getTime();
      if (age < LOCK_STALE_MS) {
        log(`[dream] Lock held by PID ${lockData.pid} (${Math.round(age / 1000)}s ago), skipping`);
        return false;
      }
      log(`[dream] Stale lock (${Math.round(age / 1000)}s), overriding`);
    }
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }));
    return true;
  } catch (e) {
    log(`[dream] Lock acquire failed: ${e.message}`);
    return false;
  }
}

function _releaseLock(cwd) {
  try { fs.unlinkSync(_lockPath(cwd)); } catch { /* ignore */ }
}

// ── Dream Prompt ───────────────────────────────────────────────

function buildDreamPrompt(cwd, metricsSummary) {
  const projectDir = getMemoryDir(cwd);
  const userDir = getUserMemoryDir();
  const today = new Date().toISOString().split("T")[0];

  const metricsBlock = metricsSummary.length > 0
    ? metricsSummary.map(m =>
        `  ${m.file || m.name}: loads=${m.load_count} refs=${m.ref_count} last_loaded=${m.last_loaded || "never"} last_ref=${m.last_referenced || "never"}`
      ).join("\n")
    : "  (no metrics data yet)";

  return `Today is ${today}. You are running a memory consolidation pass ("Dream").

## Phase 1 — Orient
List the contents of both memory directories:
- Project memory: ${projectDir}
- User memory: ${userDir}
Read both MEMORY.md index files. Count all .md entries (excluding MEMORY.md itself).

## Phase 2 — Gather Signal
Here are the memory usage metrics:
${metricsBlock}

Identify:
- Never-loaded memories (0 loads → candidate for pruning)
- Never-referenced memories (loaded but never used by the model → noise)
- Stale entries (not loaded in 30+ days)
- Duplicate topics across files (similar names, overlapping content)

## Phase 3 — Consolidate
For any issues found:
- Merge duplicate memories into one file (keep the more complete version, combine unique info)
- Resolve contradictions: if two memories conflict, the one with the more recent saved_at date wins
- Update drifted content (e.g., dates that have passed, references to things that no longer exist)
- Convert any relative dates to absolute dates (today is ${today})

## Phase 4 — Prune & Index
- Delete memories that are superseded (merged into another) or confirmed stale (never loaded, 30+ days old)
- Rebuild MEMORY.md for each scope — keep each index under 200 lines
- Add \`last_verified: ${today}\` to the frontmatter of confirmed/updated entries
- Do NOT delete memories you're uncertain about — err on the side of keeping

Use MemoryList, MemoryRead, MemorySave, and MemoryForget tools. Also use Read/Write for direct file manipulation when needed.
Report what you changed at the end.`;
}

// ── Run Dream ──────────────────────────────────────────────────

async function runDream(cwd, client, registry, permissions, backgroundManager) {
  if (!_acquireLock(cwd)) return;

  log("[dream] Starting memory consolidation...");

  try {
    // Gather metrics from both scopes
    const projectMetrics = summarizeMemoryMetrics(cwd, "project");
    const userMetrics = summarizeMemoryMetrics(cwd, "user");
    const allMetrics = [...projectMetrics, ...userMetrics];

    const prompt = buildDreamPrompt(cwd, allMetrics);

    // Run as background agent using the Agent tool
    const result = await registry.execute("Agent", {
      prompt,
      subagent_type: "memory-dream",
      description: "Memory consolidation (Dream)",
      run_in_background: true,
    });

    // Update dream state
    const state = loadDreamState();
    state.last_dream_at = new Date().toISOString();
    state.session_count_since = 0;
    state.memories_at_last_dream = countMemories(cwd);
    saveDreamState(state);

    log("[dream] Consolidation complete");
    return result;
  } catch (e) {
    log(`[dream] Error: ${e.message}`);
  } finally {
    _releaseLock(cwd);
  }
}

// ── Exports ────────────────────────────────────────────────────

export {
  loadDreamState,
  saveDreamState,
  incrementDreamSessionCount,
  shouldDream,
  countMemories,
  buildDreamPrompt,
  runDream,
  DREAM_MIN_SESSIONS,
  DREAM_MIN_HOURS,
};
