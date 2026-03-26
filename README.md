# cloclo

[![npm version](https://img.shields.io/npm/v/cloclo.svg)](https://www.npmjs.com/package/cloclo)
[![npm downloads](https://img.shields.io/npm/dm/cloclo.svg)](https://www.npmjs.com/package/cloclo)
[![license](https://img.shields.io/npm/l/cloclo.svg)](LICENSE)

Open-source Claude Code alternative — multi-provider AI coding agent CLI. Single file, 13 providers, zero native deps.

## Install

```bash
# npm (recommended)
npm install -g cloclo

# Or run directly
npx cloclo

# Or clone and run
git clone https://github.com/SeifBenayed/claude-code-sdk.git
cd claude-code-sdk && node claude-native.mjs
```

## Quick Start

```bash
# Login (opens browser, saves token to macOS keychain)
cloclo --login              # Anthropic (Pro/Max subscription)
cloclo --openai-login       # OpenAI (ChatGPT Plus/Pro subscription)

# Interactive REPL
cloclo                      # Default: Claude Sonnet
cloclo -m codex             # OpenAI Codex
cloclo -m ollama/llama3.2   # Local Ollama

# One-shot
cloclo -p "explain this code"
cloclo -m gpt-5.4 -p "fix the bug in main.js"
cat error.log | cloclo -p "explain this error"

# Programmatic (NDJSON bridge)
echo '{"type":"message","content":"hello"}' | cloclo --ndjson
```

## Providers

| Provider | Models | Auth | Status |
|----------|--------|------|--------|
| **Anthropic** | claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5 | `ANTHROPIC_API_KEY` or `--login` | Tested |
| **OpenAI Chat** | gpt-5.4, gpt-4.1, gpt-4o, o3, o4-mini | `OPENAI_API_KEY` or `--openai-login` | Tested |
| **OpenAI Responses** | gpt-5.3-codex | `OPENAI_API_KEY` or `--openai-login` | Tested |
| **Google Gemini** | gemini-2.5-flash, gemini-2.5-pro | `GOOGLE_API_KEY` | Supported |
| **DeepSeek** | deepseek-chat, deepseek-coder | `DEEPSEEK_API_KEY` | Supported |
| **Mistral** | mistral-small-latest, codestral-latest | `MISTRAL_API_KEY` | Supported |
| **Groq** | llama-3.3-70b-versatile, mixtral-8x7b | `GROQ_API_KEY` | Supported |
| **Ollama** | ollama/* (any pulled model) | None (local) | Supported |
| **LM Studio** | lmstudio/* | None (local) | Supported |
| **vLLM** | vllm/* | None (local) | Supported |
| **Jan** | jan/* | None (local) | Supported |
| **llama.cpp** | llamacpp/* | None (local) | Supported |

Switch providers live in the REPL: `/model codex`, `/model sonnet`, `/model ollama/llama3.2`

## Model Aliases

| Alias | Resolves to | Backend |
|-------|-------------|---------|
| `sonnet` | claude-sonnet-4-6 | Anthropic |
| `opus` | claude-opus-4-6 | Anthropic |
| `haiku` | claude-haiku-4-5 | Anthropic |
| `codex` | gpt-5.3-codex | OpenAI Responses |
| `gpt5` / `5.4` | gpt-5.4 | OpenAI Chat |
| `4o` | gpt-4o | OpenAI Chat |
| `o3` | o3 | OpenAI Chat |
| `o4-mini` | o4-mini | OpenAI Chat |

## Features

- **Multi-provider**: 13 backends, one CLI. Switch mid-conversation.
- **Full agent loop**: streaming, tool calling, multi-turn, sub-agents
- **Built-in tools**: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, Agent
- **Extended thinking**: `--thinking 8192` for Claude Sonnet/Opus
- **MCP integration**: `--mcp-config servers.json` for external tool servers
- **Permissions**: 6 modes from `auto` to `bypassPermissions`
- **Session management**: resume, checkpoints, rewind
- **Memory system**: persistent cross-session memory
- **Skills & hooks**: extensible slash commands, lifecycle hooks (command, webhook, prompt, agent)
- **NDJSON bridge**: programmatic use from any language
- **Ink UI**: rich terminal interface with slash menu, status bar, and live output

## REPL Commands

```
/model [name]       Switch model (live backend switching)
/thinking [budget]  Toggle extended thinking
/compact            Compress conversation to save context
/permissions <mode> Change permission mode
/memory             Show saved memories
/checkpoints        List file checkpoints
/rewind             Restore files to a checkpoint
/sessions           List recent sessions
/cost               Show session cost
/webhook            Manage webhook hooks
/clear              New session
/login              Login to Anthropic
/openai-login       Login to OpenAI
/exit               Quit
```

## CLI Options

```
-p, --print <prompt>        One-shot mode
-m, --model <name>          Model name or alias
--provider <name>           Force a specific provider
--ndjson                    NDJSON bridge mode (stdin/stdout)
--output <format>           Output format: text (default) or json
--json                      Shorthand for --output json
--output-version <v>        Lock JSON output schema version (default: 1)
-y, --yes                   Skip all permission prompts
--timeout <seconds>         Global timeout (exit code 5 if exceeded)
--login                     Anthropic OAuth login
--openai-login              OpenAI OAuth login
--api-key <key>             Anthropic API key
--openai-api-key <key>      OpenAI API key
--permission-mode <mode>    auto|default|plan|acceptEdits|bypassPermissions|dontAsk
--max-turns <n>             Max agent turns (default: 25)
--max-tokens <n>            Max output tokens (default: 16384)
--thinking <budget>         Extended thinking token budget
--mcp-config <path>         MCP servers config file
--resume                    Resume most recent session
--session-id <id>           Resume specific session
--verbose                   Debug logging
```

### Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Runtime error |
| 2 | Bad arguments |
| 3 | Authentication failure |
| 4 | Provider/model error |
| 5 | Timeout |

### Structured JSON Output

Use `--json` (or `--output json`) in one-shot mode for machine-readable output:

```bash
cloclo -p "what is 2+2" --json
```

```json
{
  "version": "1",
  "message": "2 + 2 = 4",
  "model": "claude-sonnet-4-6",
  "provider": "Anthropic",
  "usage": {
    "input_tokens": 42,
    "output_tokens": 12,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0
  },
  "stop_reason": "end_turn",
  "turns": 1,
  "session_id": "abc123..."
}
```

Pin the schema version with `--output-version` to protect against future changes.

## Authentication

### Anthropic (Claude)

```bash
cloclo --login         # OAuth — uses your Pro/Max subscription
# or
ANTHROPIC_API_KEY=sk-ant-... cloclo   # API key — pay-per-token
```

### OpenAI

```bash
cloclo --openai-login  # OAuth — uses your ChatGPT Plus/Pro subscription
# or
OPENAI_API_KEY=sk-... cloclo -m codex  # API key
```

### Local Providers

```bash
# Ollama (install: https://ollama.com)
ollama pull llama3.2
cloclo -m ollama/llama3.2

# LM Studio
cloclo -m lmstudio/qwen2.5-coder

# Custom URL
OLLAMA_API_URL=http://gpu-box:11434 cloclo -m ollama/llama3.2
```

## NDJSON Bridge Protocol

For programmatic use from any language:

```
→ {"type":"message","content":"search for X","tools":[...]}
← {"type":"ready","version":"...","session_id":"..."}
← {"type":"tool_use","id":"...","name":"Bash","input":{"command":"..."}}
→ {"type":"tool_result","id":"...","content":"...","is_error":false}
← {"type":"response","content":"Found 3 results...","iterations":2}
```

Pass custom tools in the message payload — the SDK calls them via NDJSON and returns results.

## MCP Integration

```bash
cloclo --mcp-config mcp-servers.json
```

```json
{
  "mcpServers": {
    "my-tools": {
      "command": "node",
      "args": ["my-mcp-server.js"]
    }
  }
}
```

## Testing

```bash
# Unit tests (no API keys needed)
npm test

# E2E tests (needs API keys)
node test-suite.mjs --e2e

# Ink UI smoke tests
node test-ink-smoke.mjs

# Verbose output on failures
node test-suite.mjs --verbose
```

## Architecture

Single-file SDK (`claude-native.mjs`, ~7500 lines) with provider-pluggable core. AgentLoop reads capabilities from the provider contract — never checks provider names. All provider-specific logic lives in the provider definition.

```
AgentLoop (streaming, tools, permissions, hooks)
  ├── AnthropicClient      → /v1/messages
  ├── OpenAIClient         → /v1/chat/completions
  ├── OpenAIResponsesClient → /v1/responses
  └── OpenAI-compat        → Gemini, DeepSeek, Mistral, Groq, local
```

Every provider implements: `detect()`, `createClient()`, `resolveAuth()`, `capabilities`.

## License

MIT
