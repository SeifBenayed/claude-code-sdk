# claude-code-sdk

Open-source Claude Code SDK — single-file CLIs that talk directly to the Anthropic API **and OpenAI API** using your subscription or API key. No binary dependency, no npm, zero overhead.

## What is this?

A single-file coding agent CLI built from scratch in 4 languages, with **zero external dependencies**. One tool, two backends:

- **Multi-backend**: Anthropic (Claude) and OpenAI (GPT-5, Codex, o3) in the same CLI
- **Live model switching**: `/model codex` → `/model sonnet` → `/model o3` mid-conversation
- **OAuth for both**: uses your Anthropic Pro/Max or ChatGPT Plus/Pro subscription directly
- Full agent loop: streaming, tool calling, multi-turn, sub-agents
- NDJSON bridge protocol for programmatic use
- Interactive REPL with permissions, checkpoints, and memory

## SDKs

| Language | File | Deps | Build |
|----------|------|------|-------|
| **Node.js** | `claude-native.mjs` | 0 (stdlib only) | `node claude-native.mjs` |
| **Python** | `claude-native.py` | 0 (stdlib only) | `python3 claude-native.py` |
| **Go** | `claude-native.go` | 0 (stdlib only) | `go run claude-native.go` |
| **Rust** | `rust-sdk/` | serde, reqwest | `cargo run --release` |

## Quick Start

```bash
# Login to Anthropic (opens browser, saves to macOS keychain)
node claude-native.mjs --login

# Login to OpenAI (same flow)
node claude-native.mjs --openai-login

# Interactive REPL with Claude (default)
node claude-native.mjs

# Interactive REPL with OpenAI Codex
node claude-native.mjs -m codex

# One-shot
node claude-native.mjs -p "explain this code"
node claude-native.mjs -m gpt-5.4 -p "explain this code"

# Programmatic (NDJSON bridge)
echo '{"type":"message","content":"hello"}' | node claude-native.mjs --ndjson
```

## Authentication

### Anthropic (Claude)

Three modes, auto-detected in order:

1. **OAuth (Pro/Max subscription)** — reads token from macOS keychain, uses `--login` to authenticate
2. **API key** — `--api-key KEY` or `ANTHROPIC_API_KEY` env var (pay-per-token)
3. **Auth token** — `--auth-token TOKEN` for direct Bearer auth

```bash
node claude-native.mjs --login    # Opens browser → claude.ai OAuth → saves to keychain
node claude-native.mjs            # Ready to use with your subscription
```

### OpenAI (GPT-5, Codex, o3)

Two modes, auto-detected:

1. **OAuth (ChatGPT Plus/Pro subscription)** — `--openai-login` to authenticate, reads from keychain
2. **API key** — `--openai-api-key KEY` or `OPENAI_API_KEY` env var

```bash
node claude-native.mjs --openai-login    # Opens browser → OpenAI OAuth → saves to keychain
node claude-native.mjs -m codex          # Ready to use
```

### Both at once

You can have both backends authenticated and switch on the fly:

```bash
node claude-native.mjs --login           # Anthropic
node claude-native.mjs --openai-login    # OpenAI
node claude-native.mjs                   # Start with Claude, /model codex to switch
```

## NDJSON Bridge Protocol

For programmatic use (agents, automation, CI):

```
→ {"type":"message","content":"search for X","tools":[...]}
← {"type":"ready","version":"1.0.0","mode":"native","session_id":"..."}
← {"type":"tool_use","id":"...","name":"search_drive","input":{"query":"X"}}
→ {"type":"tool_result","id":"...","content":"...","is_error":false}
← {"type":"response","content":"Found 3 results...","iterations":2}
```

### External Tools

Pass custom tools in the `message` payload. The SDK calls them via NDJSON:

```json
{
  "type": "message",
  "content": "Search Google Drive for migration files",
  "tools": [{
    "name": "search_drive",
    "description": "Search Google Drive",
    "input_schema": {"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}
  }]
}
```

## Built-in Tools

| Tool | Description |
|------|-------------|
| **Bash** | Execute shell commands (120s timeout) |
| **Read** | Read files with line numbers |
| **Write** | Write files (creates parent dirs) |
| **Edit** | Exact string replacement in files |
| **Glob** | Find files by pattern |
| **Grep** | Search file contents (uses rg/grep) |
| **WebFetch** | Fetch and summarize web pages |
| **WebSearch** | Server-side web search (Anthropic only) |
| **Agent** | Launch sub-agents (Explore, Plan, general-purpose) |

## Models

| Alias | Model | Backend | API |
|-------|-------|---------|-----|
| `sonnet` | claude-sonnet-4-6 | Anthropic | Messages |
| `opus` | claude-opus-4-6 | Anthropic | Messages |
| `haiku` | claude-haiku-4-5 | Anthropic | Messages |
| `codex` | gpt-5.3-codex | OpenAI | Responses |
| `gpt5` / `5.4` | gpt-5.4 | OpenAI | Chat Completions |
| `4.1` | gpt-4.1 | OpenAI | Chat Completions |
| `4o` | gpt-4o | OpenAI | Chat Completions |
| `o3` | o3 | OpenAI | Chat Completions |
| `o4-mini` | o4-mini | OpenAI | Chat Completions |

Switch live in the REPL: `/model codex`, `/model sonnet`, `/model o3`

## CLI Options

```
-p, --print <prompt>        One-shot mode
-m, --model <name>          Model (sonnet, opus, haiku, codex, gpt-5.4, o3, etc.)
--provider <name>           Explicit provider override (anthropic, openai, google, etc.)
--ndjson                    NDJSON bridge mode
--login                     Login to Anthropic via browser OAuth
--logout                    Remove Anthropic credentials
--oauth                     Force Anthropic OAuth auth
--openai-login              Login to OpenAI via browser OAuth
--openai-logout             Remove OpenAI credentials
--openai                    Force OpenAI OAuth auth
--api-key <key>             Anthropic API key (or ANTHROPIC_API_KEY env)
--openai-api-key <key>      OpenAI API key (or OPENAI_API_KEY env)
--permission-mode <mode>    auto|default|plan|acceptEdits|bypassPermissions|dontAsk
--max-turns <n>             Max agent turns (default: 25)
--max-tokens <n>            Max output tokens (default: 16384)
--thinking <budget>         Enable extended thinking (Anthropic only)
--mcp-config <path>         MCP servers config JSON file
--resume                    Resume most recent session
--verbose                   Debug logging
```

## REPL Commands

```
/model <name>       Switch model (live backend switching)
/model              Show current model
/thinking [budget]  Toggle extended thinking
/permissions <mode> Change permission mode
/memory             Show saved memories
/checkpoints        List file checkpoints
/rewind             Restore files to a checkpoint
/cost               Show session cost
/clear              New session
/login              Login to Anthropic
/openai-login       Login to OpenAI
/exit               Quit
```

## Architecture

### Provider-Pluggable Core

AgentLoop is **provider-agnostic** — it reads capabilities from the provider contract, never checks provider names. All provider-specific logic lives in the provider definition or client implementation.

```
┌───────────────────────────────────────────────────────────┐
│                      AgentLoop                             │
│  (streaming, tool execution, permissions)                  │
│  reads: provider.capabilities.supportsThinking             │
│         provider.capabilities.supportsHostedWebSearch       │
│         provider.capabilities.summaryModel                  │
├───────────┬──────────────┬─────────────┬─────────────────┤
│ Anthropic │  OpenAI Chat │  OpenAI     │  OpenAI-compat  │
│ Client    │  Completions │  Responses  │  (Gemini, etc.) │
├───────────┼──────────────┼─────────────┼─────────────────┤
│ /v1/      │ /v1/chat/    │ /v1/        │  varies         │
│ messages  │ completions  │ responses   │                 │
└───────────┴──────────────┴─────────────┴─────────────────┘
```

### Provider Contract

Every provider implements:

```js
{
  name: "Provider Name",
  detect(model): boolean,           // does this model belong here?
  createClient(cfg): StreamClient,  // returns object with stream(body) method
  resolveAuth(cfg): string|null,    // returns API key or null
  resolveBaseUrl(cfg): string,      // returns effective API URL
  transformModel(model): string,    // e.g. "ollama/llama3.2" → "llama3.2"
  capabilities: {
    apiStyle: "anthropic" | "openai-chat" | "openai-responses",
    toolCallStyle: "anthropic" | "openai-chat" | "responses",
    instructionPlacement: "system-blocks" | "system-message" | "developer-message" | "instructions-field",
    supportsToolCalling: boolean,
    supportsThinking: boolean,
    supportsHostedWebSearch: boolean,
    summaryModel: string|null,
  },
  envKey: string|null,              // env var for API key (null = no auth)
}
```

### Supported Providers

| Provider | Models | Auth | Default URL | Status |
|----------|--------|------|-------------|--------|
| **Anthropic** | claude-* | `ANTHROPIC_API_KEY` or `--login` | api.anthropic.com | Tested |
| **OpenAI** | gpt-*, o1/o3/o4-* | `OPENAI_API_KEY` or `--openai-login` | api.openai.com | Tested |
| **OpenAI Responses** | *-codex | `OPENAI_API_KEY` or `--openai-login` | api.openai.com | Tested |
| **Google Gemini** | gemini-* | `GOOGLE_API_KEY` | generativelanguage.googleapis.com | Placeholder |
| **DeepSeek** | deepseek-* | `DEEPSEEK_API_KEY` | api.deepseek.com | Placeholder |
| **Mistral** | mistral-*, codestral-* | `MISTRAL_API_KEY` | api.mistral.ai | Placeholder |
| **Groq** | llama-*, mixtral-* | `GROQ_API_KEY` | api.groq.com | Placeholder |
| **Ollama** | ollama/*, local/* | (none) | localhost:11434 | Placeholder |
| **LM Studio** | lmstudio/* | (none) | localhost:1234 | Placeholder |
| **vLLM** | vllm/* | (none) | localhost:8000 | Placeholder |
| **Jan** | jan/* | (none) | localhost:1337 | Placeholder |
| **llama.cpp** | llamacpp/* | (none) | localhost:8080 | Placeholder |

Local providers use prefix-based model names:

```bash
node claude-native.mjs -m ollama/llama3.2 -p "hello"
node claude-native.mjs -m lmstudio/qwen2.5-coder -p "hello"
node claude-native.mjs -m vllm/mistral-7b -p "hello"
```

Override the URL with env vars (`OLLAMA_API_URL`, `LMSTUDIO_API_URL`, `VLLM_API_URL`, `JAN_API_URL`, `LLAMACPP_API_URL`) or `--provider`:

```bash
OLLAMA_API_URL=http://gpu-box:11434 node claude-native.mjs -m ollama/llama3.2
node claude-native.mjs --provider openai -m my-fine-tune -p "hello"
```

### Adding a New Provider

1. Add an entry to `PROVIDERS` in `claude-native.mjs` with the full contract
2. Add model aliases to `MODEL_ALIASES` if desired
3. The provider auto-detects from model name via `detect()`, or can be forced with `--provider`
4. If the provider uses the OpenAI API format, reuse `OpenAIClient`; otherwise implement a new client class that yields the same SSE events

### Anthropic Auth

The key discovery: Claude Code's subscription auth requires:

1. **OAuth token** from macOS keychain (saved by `claude --login` or our `--login`)
2. **Beta headers**: `anthropic-beta: claude-code-20250219,oauth-2025-04-20`
3. **Billing header** in the first system prompt block: `x-anthropic-billing-header: cc_version=2.1.81; cc_entrypoint=cli; cch=a9fc8;`
4. **Access headers**: `anthropic-dangerous-direct-browser-access: true` + `x-app: cli`

Without ALL of these, the API returns 400/401.

### OpenAI Auth

OpenAI Codex CLI uses OAuth 2.1 with PKCE against `auth.openai.com`. ChatGPT Plus/Pro subscribers can use the CLI without a separate API key. Tokens are cached in macOS keychain with auto-refresh.

## Integration Guide

### Option 1: Copy the file (simplest)

Copy the SDK file into your project. It's a single file, no dependencies.

```bash
# Node.js
cp claude-native.mjs ~/mon-projet/
node ~/mon-projet/claude-native.mjs -p "hello"

# Python
cp claude-native.py ~/mon-projet/
python3 ~/mon-projet/claude-native.py -p "hello"

# Go — compile en binaire statique
cp claude-native.go ~/mon-projet/
cd ~/mon-projet && go build -o claude-native claude-native.go
./claude-native -p "hello"

# Rust
cp -r rust-sdk/ ~/mon-projet/claude-sdk/
cd ~/mon-projet/claude-sdk && cargo build --release
./target/release/claude-native -p "hello"
```

### Option 2: Subprocess NDJSON (for agents / automation)

Your program spawns the SDK as a subprocess and communicates via JSON on stdin/stdout.

**Python (caller):**
```python
import subprocess, json

proc = subprocess.Popen(
    ["node", "claude-native.mjs", "--ndjson"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    text=True, bufsize=1
)

# Read the "ready" message
ready = json.loads(proc.stdout.readline())
print(f"Session: {ready['session_id']}")

# Send a message with custom tools
proc.stdin.write(json.dumps({
    "type": "message",
    "content": "Search Google Drive for migration files",
    "tools": [{
        "name": "search_drive",
        "description": "Search Google Drive",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"]
        }
    }]
}) + "\n")
proc.stdin.flush()

# Loop: read events, respond to tool_use
for line in proc.stdout:
    msg = json.loads(line)

    if msg["type"] == "tool_use":
        # Claude wants to call your tool — execute it
        result = my_search_drive(msg["input"]["query"])
        proc.stdin.write(json.dumps({
            "type": "tool_result",
            "id": msg["id"],
            "content": json.dumps(result),
            "is_error": False
        }) + "\n")
        proc.stdin.flush()

    elif msg["type"] == "response":
        print(f"Claude: {msg['content']}")
        break
```

**Go (caller):**
```go
cmd := exec.Command("node", "claude-native.mjs", "--ndjson")
cmd.Stdin, _ = cmd.StdinPipe()
cmd.Stdout, _ = cmd.StdoutPipe()
cmd.Start()

scanner := bufio.NewScanner(stdout)
encoder := json.NewEncoder(stdin)

// Send a message
encoder.Encode(map[string]any{
    "type": "message",
    "content": "List files in current directory",
})

// Read responses
for scanner.Scan() {
    var msg map[string]any
    json.Unmarshal(scanner.Bytes(), &msg)
    switch msg["type"] {
    case "tool_use":
        // Respond with the result
        encoder.Encode(map[string]any{
            "type": "tool_result", "id": msg["id"],
            "content": "file1.txt\nfile2.txt", "is_error": false,
        })
    case "response":
        fmt.Println("Claude:", msg["content"])
        return
    }
}
```

**Node.js (caller):**
```javascript
import { spawn } from "node:child_process";

const sdk = spawn("node", ["claude-native.mjs", "--ndjson"]);
const send = (msg) => sdk.stdin.write(JSON.stringify(msg) + "\n");

let buffer = "";
sdk.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (const line of buffer.split("\n").slice(0, -1)) {
    const msg = JSON.parse(line);
    if (msg.type === "ready") {
      send({ type: "message", content: "What is 2+2?" });
    } else if (msg.type === "response") {
      console.log("Claude:", msg.content);
      sdk.stdin.end();
    }
  }
  buffer = buffer.split("\n").pop();
});
```

### Option 3: CLI in a shell script

```bash
#!/bin/bash

# One-shot
RESPONSE=$(node claude-native.mjs -p "Summarize this file: $(cat README.md)")
echo "$RESPONSE"

# With a specific model
node claude-native.mjs -m opus -p "Review this code" < main.py

# Pipe
cat error.log | node claude-native.mjs -p "Explain this error"
```

### Option 4: MCP server integration

```bash
# Avec un fichier de config MCP
node claude-native.mjs --mcp-config mcp-servers.json
```

```json
// mcp-servers.json
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
# Unit + NRT tests (no API key needed)
node test-openai-integration.mjs

# Full E2E (needs OPENAI_API_KEY)
OPENAI_API_KEY=sk-... node test-openai-integration.mjs --e2e

# E2E with OAuth
node test-openai-integration.mjs --e2e --oauth
```

## Legacy Bridge

`claude-tool-loop.js` is the original bridge that wraps the `claude` binary via stream-json. It still works but requires the 190MB binary + subscription. The native SDKs replace it entirely.

## License

MIT

