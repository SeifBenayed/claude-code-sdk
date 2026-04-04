// src/aicl.mjs — AICL (Agent Interlingua for Cooperative Labor) runtime support
//
// JSON-based structured framing for agent-to-agent communication.
// Sub-agents receive AICL instructions in their system prompt and are
// encouraged (not forced) to return a structured JSON frame.
// Parser uses a fallback chain: raw JSON → code block → last block → plain text.

import { log } from "./utils.mjs";

const AICL_VERSION = 1;

// ── Instruction block injected into sub-agent system prompts ────

const AICL_INSTRUCTION_BLOCK = `
## Agent Communication Protocol (AICL)

When you finish your task, structure your final response as an AICL JSON frame.
This helps the orchestrating agent understand your results precisely.

Return a JSON block like this:

\`\`\`json
{
  "_aicl": 1,
  "from": "your-agent-type",
  "to": "parent",
  "owner": "your-agent-type",
  "intent": "what you were asked to do",
  "delta": "what changed or what you found",
  "confidence": 0.92,
  "evidence": ["file:line", "test output", "URL"],
  "hypothesis": null,
  "verified": true,
  "actions_taken": ["read files", "ran tests"],
  "actions_next": ["deploy", "review"],
  "constraints": [],
  "risk": "low",
  "direction": "what should happen next",
  "human_summary": "A plain-English summary for the user"
}
\`\`\`

Field guide:
- \`_aicl\`: Always 1. Marks this as an AICL frame.
- \`confidence\`: 0.0–1.0. How sure you are about your findings.
- \`verified\`: true if you confirmed via tools (ran tests, read files). false if reasoning only.
- \`evidence\`: Anchors — file paths, line numbers, test output, URLs. Empty array if none.
- \`human_summary\`: What the human should see. Always include this.
- \`direction\`: Where things should go next (e.g. "ship", "fix", "investigate", "blocked").

Rules:
- Only include fields that carry signal. Omit empty/null fields.
- \`human_summary\` is required — it's what the user sees.
- If you can't structure your response as AICL, just respond normally. The system handles both.
`.trim();

// ── Frame builder (parent → sub-agent prompt wrapping) ──────────

function buildAiclPromptFrame(opts) {
  const frame = {
    _aicl: AICL_VERSION,
    from: opts.from || "parent",
    to: opts.to || opts.agentType || "agent",
    intent: opts.intent || opts.prompt,
    constraints: opts.constraints || [],
  };
  if (opts.replyTo) frame.reply_to = opts.replyTo;
  if (opts.context) frame.context = opts.context;
  return frame;
}

// ── Response parser (sub-agent output → structured frame) ───────
//
// Fallback chain:
// 1. Raw JSON.parse on full text (agent returned pure JSON)
// 2. Extract from ```json ... ``` code block
// 3. Extract from last ``` ... ``` block
// 4. Fallback: plain text → minimal frame with human_summary = text

function parseAiclResponse(text, agentType) {
  if (!text || typeof text !== "string") {
    return { _aicl: null, raw: text || "", human_summary: text || "", _fallback: true };
  }

  const trimmed = text.trim();

  // Strategy 1: raw JSON (agent returned only a JSON object)
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed._aicl) {
        log(`[aicl] Parsed raw JSON frame from ${agentType}`);
        return { ...parsed, _fallback: false, raw: trimmed };
      }
    } catch { /* not pure JSON, continue */ }
  }

  // Strategy 2: ```json ... ``` code block (most common LLM pattern)
  const jsonBlockMatch = trimmed.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1].trim());
      if (parsed._aicl) {
        log(`[aicl] Parsed JSON code block frame from ${agentType}`);
        // Extract text outside the code block as additional context
        const outsideText = trimmed.replace(/```json\s*\n[\s\S]*?\n\s*```/, "").trim();
        if (outsideText && !parsed.human_summary) {
          parsed.human_summary = outsideText;
        }
        return { ...parsed, _fallback: false, raw: trimmed };
      }
    } catch { /* malformed JSON in code block, continue */ }
  }

  // Strategy 3: last ``` ... ``` block (agent wrapped in generic code block)
  const allBlocks = [...trimmed.matchAll(/```(?:\w*)\s*\n([\s\S]*?)\n\s*```/g)];
  if (allBlocks.length > 0) {
    const lastBlock = allBlocks[allBlocks.length - 1][1].trim();
    try {
      const parsed = JSON.parse(lastBlock);
      if (parsed._aicl) {
        log(`[aicl] Parsed last code block frame from ${agentType}`);
        return { ...parsed, _fallback: false, raw: trimmed };
      }
    } catch { /* not JSON, continue */ }
  }

  // Strategy 4: fallback — plain text, no AICL frame
  return {
    _aicl: null,
    from: agentType || "unknown",
    human_summary: trimmed,
    raw: trimmed,
    _fallback: true,
  };
}

// ── Enrich agent result with parsed AICL fields ─────────────────

function enrichResultWithAicl(result, agentType) {
  const frame = parseAiclResponse(result.content, agentType);
  result.aicl = frame;
  result.aicl_frame = !frame._fallback;
  // If we got a frame with human_summary, use it as the visible content
  if (!frame._fallback && frame.human_summary) {
    result.content_original = result.content;
    result.content = frame.human_summary;
  }
  return result;
}

export {
  AICL_VERSION,
  AICL_INSTRUCTION_BLOCK,
  buildAiclPromptFrame,
  parseAiclResponse,
  enrichResultWithAicl,
};
