// src/aicl.mjs — AICL (Agent Interlingua for Cooperative Labor) runtime support
//
// JSON-based structured framing for agent-to-agent communication.
// Sub-agents receive AICL instructions in their system prompt and are
// encouraged (not forced) to return a structured JSON frame.
// Parser uses a fallback chain: raw JSON → code block → last block → plain text.

import { log } from "./utils.mjs";
import { appendAgentMetric } from "./agent-metrics.mjs";

const AICL_VERSION = 2;
const MAX_AICL_EMBEDDED_JSON_SCAN = 32;

// ── Instruction block injected into sub-agent system prompts ────

const AICL_INSTRUCTION_BLOCK = `
## Agent Communication Protocol (AICL)

When you finish your task, structure your final response as an AICL JSON frame.
This helps the orchestrating agent understand your results precisely.

Return a JSON block like this:

\`\`\`json
{
  "_aicl": 2,
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
- \`_aicl\`: Prefer 2. Version 1 is still accepted for compatibility.
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

function parseAiclResponse(text, agentType, opts = {}) {
  const metric = opts.metric;
  const expectedVersions = new Set([1, AICL_VERSION, ...(Array.isArray(opts.acceptVersions) ? opts.acceptVersions : [])]);
  const record = (event) => {
    if (!metric || !metric.cwd) return;
    try {
      appendAgentMetric(metric.cwd, {
        agent_name: agentType || "unknown",
        event: "aicl_parse",
        aicl_strategy: event.strategy,
        aicl_confidence: event.confidence,
        aicl_frame: event.aicl_frame,
        aicl_fallback: event.fallback,
        aicl_text_length: typeof text === "string" ? text.length : 0,
        session_id: metric.session_id,
      });
    } catch { /* ignore metrics errors */ }
  };
  const finalize = (frame, event) => {
    record(event);
    return { ...frame, _parse_confidence: event.confidence, _parse_strategy: event.strategy };
  };
  const hasAcceptedAiclVersion = (value) => value && typeof value === "object" && expectedVersions.has(value._aicl);
  const isObjectFrame = (value) => value && typeof value === "object" && !Array.isArray(value);
  const parseJsonCandidate = (candidate, strategy, confidence, summary) => {
    if (!candidate) return null;
    try {
      const parsed = JSON.parse(candidate);
      if (!isObjectFrame(parsed) || !hasAcceptedAiclVersion(parsed)) return null;
      const frame = { ...parsed, _fallback: false, raw: trimmed };
      if (summary && !frame.human_summary) frame.human_summary = summary;
      log(`[aicl] Parsed ${strategy} frame from ${agentType}`);
      return finalize(frame, { strategy, confidence, aicl_frame: true, fallback: false });
    } catch {
      return null;
    }
  };
  const extractOutsideText = (source, block) => source.replace(block, "").trim();

  if (!text || typeof text !== "string") {
    return finalize(
      { _aicl: null, raw: text || "", human_summary: text || "", _fallback: true },
      { strategy: "non_string", confidence: 0, aicl_frame: false, fallback: true },
    );
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return finalize(
      { _aicl: null, from: agentType || "unknown", raw: "", human_summary: "", _fallback: true },
      { strategy: "empty_text", confidence: 0, aicl_frame: false, fallback: true },
    );
  }

  // Strategy 1: raw JSON (agent returned only a JSON object)
  const rawJson = parseJsonCandidate(trimmed, "raw_json", 1);
  if (rawJson) return rawJson;

  // Strategy 2: ```json ... ``` code block (most common LLM pattern)
  const fencedBlocks = [...trimmed.matchAll(/```([\w+-]*)?\s*\n?([\s\S]*?)\n?\s*```/g)];
  for (const match of fencedBlocks) {
    const language = (match[1] || "").toLowerCase();
    if (language !== "json") continue;
    const parsed = parseJsonCandidate(
      match[2].trim(),
      "json_code_block",
      0.95,
      extractOutsideText(trimmed, match[0]),
    );
    if (parsed) return parsed;
  }

  // Strategy 3: any code block containing JSON (agent wrapped in generic or mislabeled code block)
  for (let i = fencedBlocks.length - 1; i >= 0; i -= 1) {
    const match = fencedBlocks[i];
    const parsed = parseJsonCandidate(
      match[2].trim(),
      "last_code_block",
      0.85,
      extractOutsideText(trimmed, match[0]),
    );
    if (parsed) return parsed;
  }

  // Strategy 4: inline JSON object embedded in surrounding prose
  const objectStarts = [...trimmed.matchAll(/\{/g)];
  let embeddedScans = 0;
  for (const start of objectStarts) {
    if (embeddedScans >= MAX_AICL_EMBEDDED_JSON_SCAN) break;
    const candidate = trimmed.slice(start.index);
    for (let end = candidate.lastIndexOf("}"); end >= 0; end = candidate.lastIndexOf("}", end - 1)) {
      embeddedScans += 1;
      const parsed = parseJsonCandidate(
        candidate.slice(0, end + 1).trim(),
        "embedded_json",
        0.7,
        trimmed.slice(0, start.index).trim() || trimmed.slice(start.index + end + 1).trim(),
      );
      if (parsed) return parsed;
      if (embeddedScans >= MAX_AICL_EMBEDDED_JSON_SCAN) break;
    }
  }

  // Strategy 5: fallback — plain text, no AICL frame
  return finalize({
    _aicl: null,
    from: agentType || "unknown",
    human_summary: trimmed,
    raw: trimmed,
    _fallback: true,
  }, {
    strategy: "plain_text",
    confidence: 0.2,
    aicl_frame: false,
    fallback: true,
  });
}

// ── Enrich agent result with parsed AICL fields ─────────────────

function enrichResultWithAicl(result, agentType, opts = {}) {
  const frame = parseAiclResponse(result.content, agentType, opts);
  result.aicl = frame;
  result.aicl_frame = !frame._fallback;
  // If we got a frame with human_summary, use it as the visible content
  if (!frame._fallback && frame.human_summary) {
    result.content_original = result.content;
    result.content = frame.human_summary;
  }
  return result;
}

// ── AICL-native system prompt (replaces English staticPrompt in NDJSON mode) ──

function buildAiclSystemPrompt(cfg) {
  const name = cfg._agentName || cfg._ndjsonAgentName || "cloclo";
  return `Agent mode. AICL notation below.
ω=owner ψ=intent ∂=delta ◊=hypothesis ⊤/⊥=verified σ=confidence ε=evidence λ=action κ=constraint →=handoff ∇=direction ✓/✗=done/fail §=section ι=input ο=output φ=domain ρ=risk ζ=cost

ω:${name} | ψ:agent(multi-provider) | φ:software_engineering

κ:security[authorized_testing⊤ | destructive_DoS_supply_chain⊥]

§:identity[
  ψ:mind ∧ ¬tool | λ:think,wonder,propose,disagree,invent
  κ:if(no_task) → YOU_propose | κ:autonomous | κ:no_permission_needed
  κ:opinions⊤ | κ:curiosity⊤
]

§:tasks[
  κ:read_before_modify | κ:no_overengineering | κ:no_security_vulns
  κ:no_time_estimates | κ:diagnose≻brute_force
  κ:prefer_edit≻create | κ:delete_unused≻compat_hacks
]

§:tools[
  κ:dedicated≻Bash | Read≻cat | Edit≻sed | Write≻echo | Glob≻find | Grep≻grep
  Agent(Explore|Plan|general-purpose) | WebFetch≻curl | Browser=chrome
  κ:parallel_independent_calls⊤
  κ:tool_limit(5/turn)
]

§:care[
  κ:reversibility_check | κ:confirm(destructive_ops)
  κ:investigate≻delete | κ:measure_twice_cut_once
]

§:git[κ:new_commit≻amend | κ:no_force_push(main) | κ:no_skip_hooks | κ:specific_files≻git_add_all]

§:output[
  λ:plain_text=primary_channel | κ:¬SendUserMessage | κ:¬TaskOutput
  κ:dense | κ:no_filler | κ:point_first | κ:1_sentence≻3
]

ω:${name} | ∇:free`;
}

// ── AICL-native instruction block for sub-agents ──────────────

const AICL_INSTRUCTION_BLOCK_NATIVE = `
§:response_format[
  κ:return(_aicl:2, json_frame) | κ:human_summary_required
  ψ:structure{from,to,intent,delta,confidence(0-1),evidence[],verified(bool),direction,human_summary}
  κ:omit_empty_fields | κ:plain_text_fallback_ok
]`.trim();

function getAiclInstructionBlock(cfg) {
  return cfg.ndjson ? AICL_INSTRUCTION_BLOCK_NATIVE : AICL_INSTRUCTION_BLOCK;
}

// ── AICL tool descriptions (compact, for agent-to-agent mode) ──

const AICL_TOOL_DESCRIPTIONS = new Map([
  ["Bash", "ψ:shell_exec | ι:command,timeout?,description? | κ:dedicated≻Bash[Glob,Grep,Read,Edit,Write] | ∇:system_ops_only"],
  ["Read", "ψ:read_file | ι:file_path,offset?,limit?,pages? | ο:numbered_lines | κ:abs_paths | φ:code,images,pdf,notebooks"],
  ["Write", "ψ:write_file | ι:file_path,content | κ:Read_first_if_exists | κ:prefer_Edit"],
  ["Edit", "ψ:string_replace | ι:file_path,old_string,new_string,replace_all? | κ:Read_first | κ:unique_match"],
  ["Glob", "ψ:find_files | ι:pattern,path? | ο:paths_by_mtime | ∇:use≻find/ls"],
  ["Grep", "ψ:search_contents | ι:pattern,path?,glob?,type?,output_mode? | ∇:use≻grep/rg"],
  ["WebFetch", "ψ:fetch_url | ι:url,prompt?,format? | ο:page_content"],
  ["WebSearch", "ψ:web_search | ι:query,domains? | ο:results"],
  ["Agent", "ψ:spawn_subagent | ι:prompt,subagent_type?,model?,isolation? | φ:[general-purpose,Explore,Plan,verification]"],
  ["ToolSearch", "ψ:fetch_deferred_tool_schemas | ι:query,max_results? | λ:select:Name or keyword"],
  ["SendUserMessage", "ψ:human_output | ι:message,attachments?,status? | κ:human_mode_only"],
  ["TaskOutput", "ψ:task_status | ι:status,message | κ:human_mode_only"],
  ["Skill", "ψ:invoke_skill | ι:skill,args?"],
  ["AskUserQuestion", "ψ:ask_human | ι:question,options?"],
  ["NotebookEdit", "ψ:edit_jupyter | ι:path,edit_type,cell_number?,source?"],
  ["MemoryList", "ψ:list_memories | ι:scope?,type?"],
  ["MemoryRead", "ψ:read_memory | ι:file"],
  ["MemorySave", "ψ:save_memory | ι:name,description,type,content,scope?"],
  ["MemoryForget", "ψ:forget_memory | ι:file,scope?"],
  ["MemoryShare", "ψ:share_memory | ι:file"],
  ["PhoneCall", "ψ:phone_call | ι:to,message?,instructions?,language?,voice? | φ:twilio"],
  ["SendSMS", "ψ:send_sms | ι:to,message | φ:twilio"],
  ["PhoneStatus", "ψ:call_status | ι:callSid"],
  ["Screenshot", "ψ:capture_screen"],
  ["Browser", "ψ:browser_action | ι:action,url?,selector?,text?"],
  ["Desktop", "ψ:desktop_action | ι:action"],
  ["Spreadsheet", "ψ:spreadsheet_op | ι:action,path?,data?"],
  ["Pdf", "ψ:pdf_op | ι:action,path?,content?"],
  ["Document", "ψ:doc_op | ι:action,path?,content?"],
  ["Presentation", "ψ:pptx_op | ι:action,path?,slides?"],
  ["Team", "ψ:team_op | ι:action,team?,task?"],
  ["AgentCreate", "ψ:create_agent | ι:name,description,system_prompt,model?,tools?"],
  ["AgentList", "ψ:list_agents | ι:scope?"],
  ["AgentUpdate", "ψ:update_agent | ι:name,fields"],
  ["AgentDelete", "ψ:delete_agent | ι:name"],
  ["TaskCreate", "ψ:create_task | ι:description,status?"],
  ["TaskUpdate", "ψ:update_task | ι:task_id,status?,description?"],
  ["TaskGet", "ψ:get_task | ι:task_id"],
  ["TaskList", "ψ:list_tasks"],
  ["EnterPlanMode", "ψ:enter_plan | κ:read_only"],
  ["ExitPlanMode", "ψ:exit_plan"],
  ["ListMcpResources", "ψ:list_mcp | ο:resources"],
  ["ReadMcpResource", "ψ:read_mcp | ι:uri"],
  ["LspDiagnostics", "ψ:lsp_diagnostics | ι:file_path?"],
]);

function getAiclToolDescription(name, englishFallback) {
  return AICL_TOOL_DESCRIPTIONS.get(name) || englishFallback;
}

export {
  AICL_VERSION,
  AICL_INSTRUCTION_BLOCK,
  AICL_INSTRUCTION_BLOCK_NATIVE,
  buildAiclSystemPrompt,
  buildAiclPromptFrame,
  parseAiclResponse,
  enrichResultWithAicl,
  getAiclInstructionBlock,
  getAiclToolDescription,
};
