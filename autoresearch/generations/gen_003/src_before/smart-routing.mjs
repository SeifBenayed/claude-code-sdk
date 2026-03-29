// src/smart-routing.mjs — Trivial message fast-path for cost optimization
//
// Only greetings and confirmations go to a cheaper/faster model.
// Everything else stays on the primary model. No keyword list to maintain.
//
// The routing is transparent — the user doesn't see it.
// In verbose mode, logs which model was selected.

import { log } from "./utils.mjs";

// ── Trivial Message Detection ───────────────────────────────

// Trivial fast-path: only greetings and confirmations go to cheap model.
// Everything else stays on primary model. No keyword list to maintain.
const TRIVIAL = /^(hi|hello|hey|thanks|thank you|ok|sure|yes|no|y|n|bye|lgtm|done|got it|good morning|good night|yep|nope|mhm)[.!?]*$/i;

function isTrivialMessage(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.trim();
  if (t.length > 80) return false;
  if (t.startsWith("/") || t.startsWith("@")) return false;
  return TRIVIAL.test(t);
}

// ── Router ───────────────────────────────────────────────────

function routeModel(text, cfg) {
  // Skip routing if explicitly disabled or already using a cheap model
  if (cfg._disableSmartRouting) return null;
  if (!cfg._provider?.capabilities?.summaryModel) return null;

  // Don't route if user explicitly chose a model
  if (cfg._userExplicitModel) return null;

  const cheapModel = cfg._provider.capabilities.summaryModel;

  // Don't route if primary IS the cheap model
  if (cfg.model === cheapModel) return null;

  if (isTrivialMessage(text)) {
    log(`[trivial-fast-path] Trivial message → ${cheapModel} (was ${cfg.model})`);
    return cheapModel;
  }

  return null; // keep primary model
}

// ── Exports ──────────────────────────────────────────────────

export { isTrivialMessage, routeModel };
