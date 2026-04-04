// ── providers.mjs ── Provider registry and API clients ──────────
//
// Extracted from claude-native.mjs

import { log, sleep, EXIT, _VERSION } from "./utils.mjs";

// ── Provider Registry ──────────────────────────────────────────
//
// Each provider knows: how to match models, required env vars,
// default API URL, and how to create a client.
// The "openai-compat" provider is the catch-all for OpenAI-compatible APIs.

const PROVIDERS = {
  anthropic: {
    name: "Anthropic",
    detect: (m) => m.startsWith("claude-") && !m.startsWith("openrouter/"),
    envKey: "ANTHROPIC_API_KEY",
    defaultUrl: "https://api.anthropic.com",
    oauthSupport: true,
    createClient: (cfg) => new AnthropicClient({ apiKey: cfg.apiKey, authToken: cfg.authToken, apiUrl: cfg.providerUrl }),
    resolveAuth: (cfg) => cfg.apiKey || cfg.authToken || null,
    resolveBaseUrl: (cfg) => cfg.apiUrl || "https://api.anthropic.com",
    transformModel: (m) => m,
    capabilities: {
      apiStyle: "anthropic",
      toolCallStyle: "anthropic",
      instructionPlacement: "system-blocks",
      supportsToolCalling: true,
      supportsThinking: true,
      supportsHostedWebSearch: true,
      summaryModel: "claude-haiku-4-5-20251001",
      contextWindow: 1000000, // claude-opus/sonnet; haiku is 200000 but resolved per-model in _getContextLimit
    },
  },
  openai: {
    name: "OpenAI",
    detect: (m) => (m.startsWith("gpt-") || /^o[1-9]/.test(m)) && !m.includes("-codex"),
    envKey: "OPENAI_API_KEY",
    defaultUrl: "https://api.openai.com",
    oauthSupport: true,
    createClient: (cfg) => new OpenAIClient({ apiKey: cfg.providerKey, apiUrl: cfg.providerUrl, capabilities: PROVIDERS.openai.capabilities }),
    resolveAuth: (cfg) => cfg.openaiApiKey || null,
    resolveBaseUrl: (cfg) => cfg.openaiApiUrl || "https://api.openai.com",
    transformModel: (m) => m,
    capabilities: {
      apiStyle: "openai-chat",
      toolCallStyle: "openai-chat",
      instructionPlacement: "system-message",
      supportsToolCalling: true,
      supportsThinking: false,
      supportsHostedWebSearch: false,
      summaryModel: "gpt-4o-mini",
      // Reasoning models (o1, o3, etc.) use "developer-message" — resolved per-model via reasoningModelPattern
      reasoningModelPattern: "^o[1-9]",
      contextWindow: 128000, // gpt-4o/4.1 default; gpt-5=1000000, o3/o4=200000 resolved per-model
    },
  },
  "openai-responses": {
    name: "OpenAI Responses",
    detect: (m) => m.includes("-codex"),
    envKey: "OPENAI_API_KEY",
    defaultUrl: "https://api.openai.com",
    oauthSupport: true,
    createClient: (cfg) => new OpenAIResponsesClient({ apiKey: cfg.providerKey, apiUrl: cfg.providerUrl }),
    resolveAuth: (cfg) => cfg.openaiApiKey || null,
    resolveBaseUrl: (cfg) => cfg.openaiApiUrl || "https://api.openai.com",
    transformModel: (m) => m,
    capabilities: {
      apiStyle: "openai-responses",
      toolCallStyle: "responses",
      instructionPlacement: "instructions-field",
      supportsToolCalling: true,
      supportsThinking: false,
      supportsHostedWebSearch: false,
      summaryModel: "gpt-4o-mini",
      contextWindow: 192000,
    },
  },
  google: {
    name: "Google Gemini",
    detect: (m) => m.startsWith("gemini-"),
    envKey: "GOOGLE_API_KEY",
    defaultUrl: "https://generativelanguage.googleapis.com",
    createClient: (cfg) => new OpenAIClient({ apiKey: cfg.providerKey, apiUrl: cfg.providerUrl + "/v1beta/openai" }),
    resolveAuth: (cfg) => process.env.GOOGLE_API_KEY || null,
    resolveBaseUrl: () => "https://generativelanguage.googleapis.com",
    transformModel: (m) => m,
    capabilities: {
      apiStyle: "openai-chat",
      toolCallStyle: "openai-chat",
      instructionPlacement: "system-message",
      supportsToolCalling: true,
      supportsThinking: false,
      supportsHostedWebSearch: false,
      summaryModel: "gemini-2.5-flash",
      contextWindow: 1000000,
    },
  },
  deepseek: {
    name: "DeepSeek",
    detect: (m) => m.startsWith("deepseek"),
    envKey: "DEEPSEEK_API_KEY",
    defaultUrl: "https://api.deepseek.com",
    createClient: (cfg) => new OpenAIClient({ apiKey: cfg.providerKey, apiUrl: cfg.providerUrl }),
    resolveAuth: (cfg) => process.env.DEEPSEEK_API_KEY || null,
    resolveBaseUrl: () => "https://api.deepseek.com",
    transformModel: (m) => m,
    capabilities: {
      apiStyle: "openai-chat",
      toolCallStyle: "openai-chat",
      instructionPlacement: "system-message",
      supportsToolCalling: true,
      supportsThinking: false,
      supportsHostedWebSearch: false,
      summaryModel: "deepseek-chat",
      contextWindow: 64000,
    },
  },
  mistral: {
    name: "Mistral",
    detect: (m) => m.startsWith("mistral-") || m.startsWith("codestral") || m.startsWith("pixtral"),
    envKey: "MISTRAL_API_KEY",
    defaultUrl: "https://api.mistral.ai",
    createClient: (cfg) => new OpenAIClient({ apiKey: cfg.providerKey, apiUrl: cfg.providerUrl }),
    resolveAuth: (cfg) => process.env.MISTRAL_API_KEY || null,
    resolveBaseUrl: () => "https://api.mistral.ai",
    transformModel: (m) => m,
    capabilities: {
      apiStyle: "openai-chat",
      toolCallStyle: "openai-chat",
      instructionPlacement: "system-message",
      supportsToolCalling: true,
      supportsThinking: false,
      supportsHostedWebSearch: false,
      summaryModel: "mistral-small-latest",
      contextWindow: 128000,
    },
  },
  groq: {
    name: "Groq",
    detect: (m) => m.startsWith("llama-") || m.startsWith("mixtral-") || m.includes("groq"),
    envKey: "GROQ_API_KEY",
    defaultUrl: "https://api.groq.com/openai",
    createClient: (cfg) => new OpenAIClient({ apiKey: cfg.providerKey, apiUrl: cfg.providerUrl }),
    resolveAuth: (cfg) => process.env.GROQ_API_KEY || null,
    resolveBaseUrl: () => "https://api.groq.com/openai",
    transformModel: (m) => m,
    capabilities: {
      apiStyle: "openai-chat",
      toolCallStyle: "openai-chat",
      instructionPlacement: "system-message",
      supportsToolCalling: true,
      supportsThinking: false,
      supportsHostedWebSearch: false,
      summaryModel: "llama-3.3-70b-versatile",
      contextWindow: 128000,
    },
  },
  ollama: {
    name: "Ollama (local)",
    detect: (m) => m.startsWith("ollama/") || m.startsWith("local/"),
    envKey: null, // no auth needed
    defaultUrl: "http://localhost:11434",
    createClient: (cfg) => new OpenAIClient({ apiKey: "ollama", apiUrl: cfg.providerUrl }),
    resolveAuth: () => "no-auth",
    resolveBaseUrl: (cfg) => process.env.OLLAMA_API_URL || "http://localhost:11434",
    transformModel: (m) => m.replace(/^(ollama|local)\//, ""),
    capabilities: {
      apiStyle: "openai-chat",
      toolCallStyle: "openai-chat",
      instructionPlacement: "system-message",
      supportsToolCalling: true,
      supportsThinking: false,
      supportsHostedWebSearch: false,
      summaryModel: null,
      contextWindow: 128000,
    },
  },
  lmstudio: {
    name: "LM Studio (local)",
    detect: (m) => m.startsWith("lmstudio/"),
    envKey: null,
    defaultUrl: "http://localhost:1234",
    createClient: (cfg) => new OpenAIClient({ apiKey: "lm-studio", apiUrl: cfg.providerUrl }),
    resolveAuth: () => "no-auth",
    resolveBaseUrl: () => process.env.LMSTUDIO_API_URL || "http://localhost:1234",
    transformModel: (m) => m.replace(/^lmstudio\//, ""),
    capabilities: {
      apiStyle: "openai-chat",
      toolCallStyle: "openai-chat",
      instructionPlacement: "system-message",
      supportsToolCalling: true,
      supportsThinking: false,
      supportsHostedWebSearch: false,
      summaryModel: null,
      contextWindow: 128000,
    },
  },
  vllm: {
    name: "vLLM",
    detect: (m) => m.startsWith("vllm/"),
    envKey: null,
    defaultUrl: "http://localhost:8000",
    createClient: (cfg) => new OpenAIClient({ apiKey: "vllm", apiUrl: cfg.providerUrl }),
    resolveAuth: () => "no-auth",
    resolveBaseUrl: () => process.env.VLLM_API_URL || "http://localhost:8000",
    transformModel: (m) => m.replace(/^vllm\//, ""),
    capabilities: {
      apiStyle: "openai-chat",
      toolCallStyle: "openai-chat",
      instructionPlacement: "system-message",
      supportsToolCalling: true,
      supportsThinking: false,
      supportsHostedWebSearch: false,
      summaryModel: null,
      contextWindow: 128000,
    },
  },
  jan: {
    name: "Jan (local)",
    detect: (m) => m.startsWith("jan/"),
    envKey: null,
    defaultUrl: "http://localhost:1337",
    createClient: (cfg) => new OpenAIClient({ apiKey: "jan", apiUrl: cfg.providerUrl }),
    resolveAuth: () => "no-auth",
    resolveBaseUrl: () => process.env.JAN_API_URL || "http://localhost:1337",
    transformModel: (m) => m.replace(/^jan\//, ""),
    capabilities: {
      apiStyle: "openai-chat",
      toolCallStyle: "openai-chat",
      instructionPlacement: "system-message",
      supportsToolCalling: true,
      supportsThinking: false,
      supportsHostedWebSearch: false,
      summaryModel: null,
      contextWindow: 128000,
    },
  },
  minimax: {
    name: "MiniMax",
    detect: (m) => m.startsWith("minimax/") || m.startsWith("MiniMax-"),
    envKey: "MINIMAX_API_KEY",
    defaultUrl: "https://api.minimaxi.chat",
    createClient: (cfg) => new OpenAIClient({ apiKey: cfg.providerKey, apiUrl: cfg.providerUrl }),
    resolveAuth: (cfg) => process.env.MINIMAX_API_KEY || null,
    resolveBaseUrl: () => process.env.MINIMAX_API_URL || "https://api.minimaxi.chat",
    transformModel: (m) => m.replace(/^minimax\//, ""),
    capabilities: {
      apiStyle: "openai-chat",
      toolCallStyle: "openai-chat",
      instructionPlacement: "system-message",
      supportsToolCalling: true,
      supportsThinking: false,
      supportsHostedWebSearch: false,
      summaryModel: null,
      contextWindow: 1000000,
    },
  },
  llamacpp: {
    name: "llama.cpp",
    detect: (m) => m.startsWith("llamacpp/"),
    envKey: null,
    defaultUrl: "http://localhost:8080",
    createClient: (cfg) => new OpenAIClient({ apiKey: "llamacpp", apiUrl: cfg.providerUrl }),
    resolveAuth: () => "no-auth",
    resolveBaseUrl: () => process.env.LLAMACPP_API_URL || "http://localhost:8080",
    transformModel: (m) => m.replace(/^llamacpp\//, ""),
    capabilities: {
      apiStyle: "openai-chat",
      toolCallStyle: "openai-chat",
      instructionPlacement: "system-message",
      supportsToolCalling: false, // depends on model/build
      supportsThinking: false,
      supportsHostedWebSearch: false,
      summaryModel: null,
      contextWindow: 128000,
    },
  },
};

function _parseRetryAfterMs(resp) {
  const value = resp?.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const target = Date.parse(value);
  if (!Number.isNaN(target)) return Math.max(0, target - Date.now());
  return null;
}

async function _readProviderErrorText(resp) {
  try {
    return await resp.text();
  } catch {
    return "";
  }
}

function _extractProviderErrorMessage(text) {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || text;
  } catch {
    return text;
  }
}

function _isQuotaOrBillingError(text) {
  const lower = (text || "").toLowerCase();
  return lower.includes("insufficient_quota")
    || lower.includes("quota")
    || lower.includes("billing")
    || lower.includes("credit balance")
    || lower.includes("exceeded your current quota");
}

function _computeRetryDelay(attempt, retryAfterMs) {
  if (retryAfterMs) return retryAfterMs;
  const base = 500, max = 32000;
  const exp = Math.min(base * Math.pow(2, attempt), max);
  return Math.floor(exp + Math.random() * 0.25 * exp);
}

function _isRetryableStatus(status, headers) {
  if ([429, 529, 408, 409].includes(status) || status >= 500) return true;
  if (headers?.get?.("x-should-retry") === "true") return true;
  return false;
}

async function _handleRateLimitResponse(providerLabel, resp, attempt) {
  const text = await _readProviderErrorText(resp);
  const retryAfterMs = _parseRetryAfterMs(resp);
  const exhausted = _isQuotaOrBillingError(text);
  const shouldRetry = resp?.headers?.get?.("x-should-retry");
  if (shouldRetry === "false") {
    return { retryable: false, delayMs: 0, error: new Error(`${providerLabel}: ${_extractProviderErrorMessage(text) || "non-retryable error"}`) };
  }
  const message = exhausted
    ? `${providerLabel} quota or billing limit reached${text ? `: ${_extractProviderErrorMessage(text)}` : "."}`
    : `${providerLabel} rate limit hit.${retryAfterMs ? ` Retry in ${Math.max(1, Math.ceil(retryAfterMs / 1000))}s.` : " Retrying shortly."}`;
  const is529 = resp?.status === 529;
  const delayMs = is529 && attempt >= 3 ? 30000 : _computeRetryDelay(attempt, retryAfterMs);
  return { retryable: !exhausted, delayMs, error: new Error(message) };
}

// Dynamic instruction placement — reasoning models use "developer" role
// The pattern is declared in provider.capabilities.reasoningModelPattern (not hardcoded here).
function getInstructionPlacement(provider, model) {
  if (provider.capabilities.instructionPlacement === "system-blocks") return "system-blocks";
  if (provider.capabilities.instructionPlacement === "instructions-field") return "instructions-field";
  // Check if this model matches the provider's reasoning model pattern
  const pattern = provider.capabilities.reasoningModelPattern;
  if (pattern && new RegExp(pattern).test(model)) return "developer-message";
  return provider.capabilities.instructionPlacement;
}

function detectProvider(model, explicitProvider) {
  if (explicitProvider) {
    if (PROVIDERS[explicitProvider]) return PROVIDERS[explicitProvider];
    const valid = Object.keys(PROVIDERS).join(", ");
    process.stderr.write(`Error: Unknown provider "${explicitProvider}"\n  Valid: ${valid}\n`);
    process.exit(EXIT.BAD_ARGS);
  }
  for (const p of Object.values(PROVIDERS)) {
    if (p.detect(model)) return p;
  }
  // Fallback: treat as OpenAI-compatible
  return {
    name: "OpenAI-compatible",
    detect: () => true,
    envKey: "OPENAI_API_KEY",
    defaultUrl: "https://api.openai.com",
    createClient: (cfg) => new OpenAIClient({ apiKey: cfg.providerKey, apiUrl: cfg.providerUrl }),
    resolveAuth: (cfg) => cfg.openaiApiKey || null,
    resolveBaseUrl: (cfg) => cfg.openaiApiUrl || "https://api.openai.com",
    transformModel: (m) => m,
    capabilities: {
      apiStyle: "openai-chat",
      toolCallStyle: "openai-chat",
      instructionPlacement: "system-message",
      supportsToolCalling: true,
      supportsThinking: false,
      supportsHostedWebSearch: false,
      summaryModel: "gpt-4o-mini",
      contextWindow: 128000,
    },
  };
}

// Backwards compat — used in test-suite.mjs extraction
function isOpenAIModel(model) {
  const p = detectProvider(model);
  return p.name !== "Anthropic";
}

function isResponsesAPIModel(model) {
  return model.includes("-codex");
}

// ── AnthropicClient ─────────────────────────────────────────────

class AnthropicClient {
  constructor({ apiKey, authToken, apiUrl = "https://api.anthropic.com" }) {
    this.apiKey = apiKey;
    this.authToken = authToken;
    this.apiUrl = apiUrl;
  }

  _authHeaders() {
    if (this.authToken) {
      return { "Authorization": `Bearer ${this.authToken}` };
    }
    return { "x-api-key": this.apiKey };
  }

  _betaHeaders() {
    const betas = [
      "prompt-caching-scope-2026-01-05",
      "interleaved-thinking-2025-05-14",
      "web-search-2025-03-05",
      "structured-outputs-2025-12-15",
      "advanced-tool-use-2025-11-20",
      "tool-search-tool-2025-10-19",
      "effort-2025-11-24",
      "redact-thinking-2026-02-12",
      "context-management-2025-06-27",
    ];
    if (this.authToken) {
      betas.push("claude-code-20250219", "oauth-2025-04-20");
    }
    return betas.join(",");
  }

  _extraHeaders() {
    const headers = {
      "x-app": "cli",
      "User-Agent": `claude-code/${_VERSION || "2.1.86"}`,
      "x-service-name": "claude-code",
    };
    if (this.authToken) {
      headers["anthropic-dangerous-direct-browser-access"] = "true";
    }
    // Remote/sandbox headers (from env vars, like CC baseline)
    if (process.env.CLAUDE_CODE_CONTAINER_ID) headers["x-claude-remote-container-id"] = process.env.CLAUDE_CODE_CONTAINER_ID;
    if (process.env.CLAUDE_CODE_REMOTE_SESSION_ID) headers["x-claude-remote-session-id"] = process.env.CLAUDE_CODE_REMOTE_SESSION_ID;
    if (process.env.CLAUDE_AGENT_SDK_CLIENT_APP) headers["x-client-app"] = process.env.CLAUDE_AGENT_SDK_CLIENT_APP;
    if (process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION) headers["x-anthropic-additional-protection"] = "true";
    return headers;
  }

  async *stream(body, opts = {}) {
    const url = this.authToken
      ? `${this.apiUrl}/v1/messages?beta=true`
      : `${this.apiUrl}/v1/messages`;
    const signal = opts.signal;
    let lastError;
    let retryDelayMs = null;

    for (let attempt = 0; attempt < 10; attempt++) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      if (attempt > 0) {
        const delay = retryDelayMs ?? _computeRetryDelay(attempt, null);
        log(`Retry ${attempt}/10 after ${delay}ms...`);
        await sleep(delay);
        retryDelayMs = null;
      }

      let resp;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...this._authHeaders(),
            ...this._extraHeaders(),
            "anthropic-version": "2023-06-01",
            "anthropic-beta": this._betaHeaders(),
          },
          body: JSON.stringify({ ...body, stream: true }),
          signal,
        });
      } catch (e) {
        if (signal?.aborted || e?.name === "AbortError") throw e;
        lastError = e;
        retryDelayMs = _computeRetryDelay(attempt, null);
        continue;
      }

      if (_isRetryableStatus(resp.status, resp.headers)) {
        if (resp.status === 429 || resp.status === 529) {
          const rateLimit = await _handleRateLimitResponse("Anthropic", resp, attempt);
          lastError = rateLimit.error;
          retryDelayMs = rateLimit.delayMs;
          if (!rateLimit.retryable) break;
        } else {
          const text = await resp.text().catch(() => "");
          lastError = new Error(`API error ${resp.status}: ${text}`);
          retryDelayMs = _computeRetryDelay(attempt, null);
        }
        continue;
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`API error ${resp.status}: ${text}`);
      }

      yield* this._parseSSE(resp.body);
      return;
    }

    throw lastError || new Error("Max retries exceeded");
  }

  async *_parseSSE(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const chunks = buf.split("\n\n");
        buf = chunks.pop();

        for (const chunk of chunks) {
          let eventType = null;
          let data = null;
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event: ")) eventType = line.slice(7);
            else if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (eventType && data) {
            try {
              yield { event: eventType, data: JSON.parse(data) };
            } catch { /* skip malformed */ }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ── OpenAIClient ────────────────────────────────────────────────
//
// Drop-in replacement for AnthropicClient. Translates OpenAI's chat
// completions SSE format into the same { event, data } shape that
// AgentLoop expects (Anthropic SSE events).

class OpenAIClient {
  constructor({ apiKey, apiUrl = "https://api.openai.com", capabilities = {} }) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this._provider = { capabilities };
  }

  // Convert Anthropic tool defs to OpenAI function-calling format
  _convertTools(tools) {
    if (!tools || tools.length === 0) return undefined;
    return tools
      .filter((t) => !t.type) // skip server-side tools (web_search etc.)
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
  }

  _isReasoningModel(model) {
    // Declared as a provider capability, not a hardcoded regex.
    // Falls back to the old pattern for backwards compat with custom providers.
    const pattern = this._provider?.capabilities?.reasoningModelPattern;
    if (pattern) return new RegExp(pattern).test(model);
    return false;
  }

  // Convert Anthropic system blocks + messages to OpenAI format
  _convertMessages(systemBlocks, messages) {
    const out = [];
    // System prompt: reasoning models (o3, o4-mini) use "developer" role, others use "system"
    if (systemBlocks?.length > 0) {
      const systemText = systemBlocks.map((b) => b.text).join("\n\n");
      const role = this._isReasoningModel(this._model) ? "developer" : "system";
      out.push({ role, content: systemText });
    }
    for (const msg of messages) {
      if (msg.role === "assistant") {
        // Convert Anthropic content blocks to OpenAI format
        if (Array.isArray(msg.content)) {
          const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          const toolCalls = msg.content.filter((b) => b.type === "tool_use").map((b) => ({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input) },
          }));
          const oaiMsg = { role: "assistant", content: text || "" };
          if (toolCalls.length > 0) oaiMsg.tool_calls = toolCalls;
          out.push(oaiMsg);
        } else {
          out.push({ role: "assistant", content: msg.content ?? "" });
        }
      } else if (msg.role === "user") {
        // User messages may be tool_result arrays
        if (Array.isArray(msg.content)) {
          const toolResults = msg.content.filter((b) => b.type === "tool_result");
          if (toolResults.length > 0) {
            const pendingImages = []; // Images extracted from tool results — sent as user message after
            for (const tr of toolResults) {
              // OpenAI tool messages only accept string content — extract images separately
              let textContent;
              if (Array.isArray(tr.content)) {
                const textParts = [];
                for (const block of tr.content) {
                  if (block.type === "image" && block.source?.type === "base64") {
                    pendingImages.push({ type: "image_url", image_url: { url: `data:${block.source.media_type};base64,${block.source.data}`, detail: "low" } });
                  } else if (block.type === "text") {
                    textParts.push(block.text);
                  } else {
                    textParts.push(JSON.stringify(block));
                  }
                }
                textContent = textParts.join("\n") || "(see attached image)";
              } else {
                textContent = typeof tr.content === "string" ? tr.content : (tr.content == null ? "" : JSON.stringify(tr.content));
              }
              out.push({
                role: "tool",
                tool_call_id: tr.tool_use_id,
                content: textContent,
              });
            }
            // Send extracted images as a user message so the model can see them
            if (pendingImages.length > 0) {
              log(`[openai] Injecting ${pendingImages.length} image(s) as user message`);
              out.push({
                role: "user",
                content: [{ type: "text", text: "Here is the screenshot captured by the Screenshot tool. Please describe in detail what you see in this image:" }, ...pendingImages],
              });
            }
          } else {
            const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
            out.push({ role: "user", content: text || JSON.stringify(msg.content) });
          }
        } else {
          out.push({ role: "user", content: msg.content ?? "" });
        }
      }
    }
    return out;
  }

  async *stream(body, opts = {}) {
    const signal = opts.signal;
    this._model = body.model; // stash for _isReasoningModel
    const oaiTools = this._convertTools(body.tools);
    const oaiMessages = this._convertMessages(body.system, body.messages);

    const oaiBody = {
      model: body.model,
      messages: oaiMessages,
      max_completion_tokens: body.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (oaiTools?.length > 0) oaiBody.tools = oaiTools;

    let lastError;
    let retryDelayMs = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      if (attempt > 0) {
        const delay = retryDelayMs ?? _computeRetryDelay(attempt, null);
        log(`[openai] Retry ${attempt}/10 after ${delay}ms...`);
        await sleep(delay);
        retryDelayMs = null;
      }

      let resp;
      try {
        resp = await fetch(`${this.apiUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(oaiBody),
          signal,
        });
      } catch (e) {
        if (signal?.aborted || e?.name === "AbortError") throw e;
        lastError = e;
        retryDelayMs = _computeRetryDelay(attempt, null);
        continue;
      }

      if (_isRetryableStatus(resp.status, resp.headers)) {
        if (resp.status === 429 || resp.status === 529) {
          const rateLimit = await _handleRateLimitResponse("OpenAI", resp, attempt);
          lastError = rateLimit.error;
          retryDelayMs = rateLimit.delayMs;
          if (!rateLimit.retryable) break;
        } else {
          const text = await resp.text().catch(() => "");
          lastError = new Error(`OpenAI API error ${resp.status}: ${text}`);
          log(`[openai] Error ${resp.status}: ${text.substring(0, 300)}`);
          retryDelayMs = _computeRetryDelay(attempt, null);
        }
        continue;
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`OpenAI API error ${resp.status}: ${text}`);
      }

      yield* this._translateStream(resp.body);
      return;
    }

    throw lastError || new Error("Max retries exceeded");
  }

  async *_translateStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    // Track tool call state: index → { id, name, arguments }
    const toolCalls = new Map();
    let sentStart = false;
    let textBlockIndex = null;
    let usage = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const lines = buf.split("\n");
        buf = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;

          let chunk;
          try { chunk = JSON.parse(payload); } catch { continue; }

          // Emit message_start on first chunk
          if (!sentStart) {
            sentStart = true;
            yield {
              event: "message_start",
              data: { message: { usage: { input_tokens: 0, output_tokens: 0 } } },
            };
          }

          // Usage (comes in final chunk with stream_options.include_usage)
          if (chunk.usage) {
            usage = {
              input_tokens: chunk.usage.prompt_tokens || 0,
              output_tokens: chunk.usage.completion_tokens || 0,
            };
          }

          const delta = chunk.choices?.[0]?.delta;
          const finishReason = chunk.choices?.[0]?.finish_reason;
          if (!delta && !finishReason) continue;

          // Text content — delta.content can be a string or an array of content parts (multimodal)
          if (delta?.content) {
            let textDelta;
            if (typeof delta.content === "string") {
              textDelta = delta.content;
            } else if (Array.isArray(delta.content)) {
              // Extract text parts from multimodal content array
              textDelta = delta.content
                .filter((p) => p.type === "text" && p.text)
                .map((p) => p.text)
                .join("");
            } else {
              textDelta = String(delta.content);
            }
            if (textDelta) {
              if (textBlockIndex === null) {
                textBlockIndex = 0;
                yield {
                  event: "content_block_start",
                  data: { index: textBlockIndex, content_block: { type: "text", text: "" } },
                };
              }
              yield {
                event: "content_block_delta",
                data: { index: textBlockIndex, delta: { type: "text_delta", text: textDelta } },
              };
            }
          }

          // Tool calls
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls.has(idx)) {
                // New tool call — close text block if open, then start tool_use block
                if (textBlockIndex !== null) {
                  yield { event: "content_block_stop", data: { index: textBlockIndex } };
                  textBlockIndex = null;
                }
                toolCalls.set(idx, { id: tc.id, name: tc.function?.name || "", arguments: "" });
                yield {
                  event: "content_block_start",
                  data: {
                    index: idx + 1,
                    content_block: { type: "tool_use", id: tc.id, name: tc.function?.name || "" },
                  },
                };
              }
              const entry = toolCalls.get(idx);
              if (tc.function?.name && !entry.name) entry.name = tc.function.name;
              if (tc.function?.arguments) {
                entry.arguments += tc.function.arguments;
                yield {
                  event: "content_block_delta",
                  data: { index: idx + 1, delta: { type: "input_json_delta", partial_json: tc.function.arguments } },
                };
              }
            }
          }

          // Finish
          if (finishReason) {
            // Close any open blocks
            if (textBlockIndex !== null) {
              yield { event: "content_block_stop", data: { index: textBlockIndex } };
            }
            for (const [idx] of toolCalls) {
              yield { event: "content_block_stop", data: { index: idx + 1 } };
            }

            // Map finish reason
            const stopReason = finishReason === "tool_calls" ? "tool_use"
              : finishReason === "length" ? "max_tokens"
              : "end_turn";

            yield {
              event: "message_delta",
              data: {
                delta: { stop_reason: stopReason },
                usage: usage || { input_tokens: 0, output_tokens: 0 },
              },
            };
            yield { event: "message_stop", data: {} };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ── OpenAIResponsesClient ────────────────────────────────────────
//
// For *-codex models that only work on POST /v1/responses.
// Translates to/from Anthropic SSE events like OpenAIClient does.
// Key difference: uses `instructions` instead of system messages,
// `input` instead of messages, and `previous_response_id` for multi-turn.

class OpenAIResponsesClient {
  constructor({ apiKey, apiUrl = "https://api.openai.com" }) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl;
    this._lastResponseId = null;
    // Map call_id → item_id (Responses API needs item_id in function_call input items)
    this._callIdToItemId = new Map();
  }

  // Convert Anthropic tool defs → Responses API format (flat, no "function" wrapper)
  _convertTools(tools) {
    if (!tools || tools.length === 0) return undefined;
    return tools
      .filter((t) => !t.type) // skip Anthropic server-side tools
      .map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      }));
  }

  // Convert Anthropic system blocks + messages → Responses API input format
  _convertInput(systemBlocks, messages) {
    const input = [];

    for (const msg of messages) {
      if (msg.role === "user") {
        if (Array.isArray(msg.content)) {
          // Tool results
          const toolResults = msg.content.filter((b) => b.type === "tool_result");
          if (toolResults.length > 0) {
            const pendingImages = [];
            for (const tr of toolResults) {
              // Responses API function_call_output only accepts string output
              let output;
              if (Array.isArray(tr.content)) {
                const textParts = [];
                for (const block of tr.content) {
                  if (block.type === "text") textParts.push(block.text);
                  else if (block.type === "image" && block.source?.type === "base64") {
                    pendingImages.push({ type: "input_image", image_url: `data:${block.source.media_type};base64,${block.source.data}` });
                    textParts.push("[image captured and attached below]");
                  }
                  else textParts.push(JSON.stringify(block));
                }
                output = textParts.join("\n");
              } else {
                output = typeof tr.content === "string" ? tr.content : (tr.content == null ? "" : JSON.stringify(tr.content));
              }
              input.push({
                type: "function_call_output",
                call_id: tr.tool_use_id,
                output,
              });
            }
            if (pendingImages.length > 0) {
              input.push({ role: "user", content: [{ type: "input_text", text: "Here is the screenshot from the tool above:" }, ...pendingImages] });
            }
          } else {
            const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
            input.push({ role: "user", content: text || JSON.stringify(msg.content) || "" });
          }
        } else {
          input.push({ role: "user", content: msg.content ?? "" });
        }
      } else if (msg.role === "assistant") {
        if (Array.isArray(msg.content)) {
          // Text part
          const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
          if (text) {
            input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
          }
          // Tool calls — b.id is the call_id; look up the Responses API item_id
          for (const b of msg.content.filter((b) => b.type === "tool_use")) {
            const itemId = this._callIdToItemId.get(b.id) || b.id;
            input.push({
              type: "function_call",
              id: itemId,
              call_id: b.id,
              name: b.name,
              arguments: JSON.stringify(b.input),
            });
          }
        } else {
          input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: msg.content ?? "" }] });
        }
      }
    }
    return input;
  }

  _getInstructions(systemBlocks) {
    if (!systemBlocks?.length) return undefined;
    const instructions = systemBlocks.map((b) => b.text).join("\n\n");
    return instructions.trim() ? instructions : undefined;
  }

  async *stream(body, opts = {}) {
    const signal = opts.signal;
    const instructions = this._getInstructions(body.system);
    const input = this._convertInput(body.system, body.messages);
    const tools = this._convertTools(body.tools);

    const reqBody = {
      model: body.model,
      input,
      stream: true,
      store: false,
      max_output_tokens: body.max_tokens,
    };
    if (instructions) reqBody.instructions = instructions;
    if (tools?.length > 0) reqBody.tools = tools;

    let lastError;
    let retryDelayMs = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Request aborted");
      }
      if (attempt > 0) {
        const delay = retryDelayMs ?? _computeRetryDelay(attempt, null);
        log(`[openai-responses] Retry ${attempt}/10 after ${delay}ms...`);
        await sleep(delay);
        retryDelayMs = null;
      }

      let resp;
      try {
        resp = await fetch(`${this.apiUrl}/v1/responses`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(reqBody),
          signal,
        });
      } catch (e) {
        if (signal?.aborted || e?.name === "AbortError") throw e;
        lastError = e;
        retryDelayMs = _computeRetryDelay(attempt, null);
        continue;
      }

      if (_isRetryableStatus(resp.status, resp.headers)) {
        if (resp.status === 429 || resp.status === 529) {
          const rateLimit = await _handleRateLimitResponse("OpenAI", resp, attempt);
          lastError = rateLimit.error;
          retryDelayMs = rateLimit.delayMs;
          if (!rateLimit.retryable) break;
        } else {
          const text = await resp.text().catch(() => "");
          lastError = new Error(`OpenAI Responses API error ${resp.status}: ${text}`);
          retryDelayMs = _computeRetryDelay(attempt, null);
        }
        continue;
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`OpenAI Responses API error ${resp.status}: ${text}`);
      }

      yield* this._translateStream(resp.body);
      return;
    }

    throw lastError || new Error("Max retries exceeded");
  }

  async *_translateStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let sentStart = false;
    let textBlockStarted = false;
    const funcCalls = new Map();
    let blockIndex = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // Responses API SSE: "event: <type>\ndata: <json>\n\n"
        const chunks = buf.split("\n\n");
        buf = chunks.pop();

        for (const chunk of chunks) {
          // Extract data line from the chunk
          let dataLine = null;
          for (const line of chunk.split("\n")) {
            if (line.startsWith("data: ")) dataLine = line.slice(6);
          }
          if (!dataLine) continue;

          let event;
          try { event = JSON.parse(dataLine); } catch { continue; }

          // Emit message_start on first event
          if (!sentStart) {
            sentStart = true;
            yield {
              event: "message_start",
              data: { message: { usage: { input_tokens: 0, output_tokens: 0 } } },
            };
          }

          switch (event.type) {
            case "response.output_item.added": {
              const item = event.item;
              if (item?.type === "function_call") {
                if (textBlockStarted) {
                  yield { event: "content_block_stop", data: { index: blockIndex } };
                  textBlockStarted = false;
                  blockIndex++;
                }
                funcCalls.set(item.id, { callId: item.call_id, name: item.name });
                // Store mapping: call_id → item_id (needed when reconstructing input)
                this._callIdToItemId.set(item.call_id, item.id);
                yield {
                  event: "content_block_start",
                  data: {
                    index: blockIndex,
                    content_block: { type: "tool_use", id: item.call_id, name: item.name },
                  },
                };
              }
              break;
            }

            // Text delta — Responses API uses "response.output_text.delta"
            case "response.output_text.delta": {
              if (!textBlockStarted) {
                textBlockStarted = true;
                yield {
                  event: "content_block_start",
                  data: { index: blockIndex, content_block: { type: "text", text: "" } },
                };
              }
              yield {
                event: "content_block_delta",
                data: { index: blockIndex, delta: { type: "text_delta", text: event.delta } },
              };
              break;
            }

            case "response.output_text.done":
              break;

            case "response.function_call_arguments.delta": {
              yield {
                event: "content_block_delta",
                data: { index: blockIndex, delta: { type: "input_json_delta", partial_json: event.delta } },
              };
              break;
            }

            case "response.function_call_arguments.done":
              break;

            case "response.output_item.done": {
              if (textBlockStarted) {
                yield { event: "content_block_stop", data: { index: blockIndex } };
                textBlockStarted = false;
                blockIndex++;
              } else if (event.item?.type === "function_call") {
                yield { event: "content_block_stop", data: { index: blockIndex } };
                blockIndex++;
              }
              break;
            }

            case "response.completed": {
              if (textBlockStarted) {
                yield { event: "content_block_stop", data: { index: blockIndex } };
                textBlockStarted = false;
              }

              const response = event.response;
              this._lastResponseId = response?.id;

              const hasToolCalls = response?.output?.some((o) => o.type === "function_call");
              const stopReason = hasToolCalls ? "tool_use" : "end_turn";

              const usage = response?.usage || {};
              yield {
                event: "message_delta",
                data: {
                  delta: { stop_reason: stopReason },
                  usage: {
                    input_tokens: usage.input_tokens || 0,
                    output_tokens: usage.output_tokens || 0,
                  },
                },
              };
              yield { event: "message_stop", data: {} };
              break;
            }

            case "response.failed": {
              const errMsg = event.response?.error?.message || "Responses API call failed";
              throw new Error(errMsg);
            }

            default:
              break;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export {
  PROVIDERS,
  getInstructionPlacement,
  detectProvider,
  isOpenAIModel,
  isResponsesAPIModel,
  AnthropicClient,
  OpenAIClient,
  OpenAIResponsesClient,
};
