# claude-code-sdk

Open-source Claude Code SDK — single-file CLIs that talk directly to the Anthropic API using your Pro/Max subscription. No binary dependency, no npm, zero overhead.

## What is this?

We reverse-engineered the Claude Code CLI binary (190MB Bun bundle, $20/mo subscription) and rebuilt it from scratch in 4 languages. Each SDK is a **single file** with **zero external dependencies** that:

- Authenticates via OAuth (same flow as `claude --login`)
- Uses your existing Pro/Max subscription (no API credits consumed)
- Implements the full agent loop: streaming, tool calling, multi-turn
- Exposes an NDJSON bridge protocol for programmatic use
- Provides an interactive REPL for human use

## SDKs

| Language | File | Deps | Build |
|----------|------|------|-------|
| **Node.js** | `claude-native.mjs` | 0 (stdlib only) | `node claude-native.mjs` |
| **Python** | `claude-native.py` | 0 (stdlib only) | `python3 claude-native.py` |
| **Go** | `claude-native.go` | 0 (stdlib only) | `go run claude-native.go` |
| **Rust** | `rust-sdk/` | serde, reqwest | `cargo run --release` |

## Quick Start

```bash
# Login (opens browser, saves to macOS keychain)
node claude-native.mjs --login

# Interactive REPL (uses your Pro/Max subscription)
node claude-native.mjs

# One-shot
node claude-native.mjs -p "explain this code"

# Programmatic (NDJSON bridge)
echo '{"type":"message","content":"hello"}' | node claude-native.mjs --ndjson
```

## Authentication

Three modes, auto-detected in order:

1. **OAuth (Pro/Max subscription)** — reads token from macOS keychain, uses `--login` to authenticate
2. **API key** — `--api-key KEY` or `ANTHROPIC_API_KEY` env var (pay-per-token)
3. **Auth token** — `--auth-token TOKEN` for direct Bearer auth

### First-time setup
```bash
node claude-native.mjs --login    # Opens browser → claude.ai OAuth → saves to keychain
node claude-native.mjs            # Ready to use with your subscription
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
| **Glob** | Find files by pattern |
| **Grep** | Search file contents (uses rg/grep) |

## CLI Options

```
-p, --print <prompt>        One-shot mode
-m, --model <name>          Model: sonnet, opus, haiku (default: sonnet)
--ndjson                    NDJSON bridge mode
--login                     Login via browser OAuth
--logout                    Remove credentials
--oauth                     Force OAuth auth
--api-key <key>             Use API key
--max-turns <n>             Max agent turns (default: 25)
--max-tokens <n>            Max output tokens (default: 16384)
--thinking <budget>         Enable extended thinking
--verbose                   Debug logging
```

## How It Works

The key discovery: Claude Code's subscription auth requires:

1. **OAuth token** from macOS keychain (saved by `claude --login` or our `--login`)
2. **Beta headers**: `anthropic-beta: claude-code-20250219,oauth-2025-04-20`
3. **Billing header** in the first system prompt block: `x-anthropic-billing-header: cc_version=2.1.81; cc_entrypoint=cli; cch=a9fc8;`
4. **Access headers**: `anthropic-dangerous-direct-browser-access: true` + `x-app: cli`

Without ALL of these, the API returns 400/401.

## Integration Guide

### Option 1 : Copier le fichier (le plus simple)

Copie le fichier SDK dans ton projet. C'est un seul fichier, pas de dépendances.

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

### Option 2 : Subprocess NDJSON (pour agents / automation)

Ton programme spawn le SDK comme subprocess et communique via JSON sur stdin/stdout.

**Python (appelant) :**
```python
import subprocess, json

proc = subprocess.Popen(
    ["node", "claude-native.mjs", "--ndjson"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    text=True, bufsize=1
)

# Lire le "ready"
ready = json.loads(proc.stdout.readline())
print(f"Session: {ready['session_id']}")

# Envoyer un message avec des tools custom
proc.stdin.write(json.dumps({
    "type": "message",
    "content": "Cherche les fichiers migration dans Google Drive",
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

# Boucle : lire les events, répondre aux tool_use
for line in proc.stdout:
    msg = json.loads(line)

    if msg["type"] == "tool_use":
        # Claude veut appeler ton tool — exécute-le
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

**Go (appelant) :**
```go
cmd := exec.Command("node", "claude-native.mjs", "--ndjson")
cmd.Stdin, _ = cmd.StdinPipe()
cmd.Stdout, _ = cmd.StdoutPipe()
cmd.Start()

scanner := bufio.NewScanner(stdout)
encoder := json.NewEncoder(stdin)

// Envoyer un message
encoder.Encode(map[string]any{
    "type": "message",
    "content": "List files in current directory",
})

// Lire les réponses
for scanner.Scan() {
    var msg map[string]any
    json.Unmarshal(scanner.Bytes(), &msg)
    switch msg["type"] {
    case "tool_use":
        // Répondre avec le résultat
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

**Node.js (appelant) :**
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

### Option 3 : Comme CLI dans un script shell

```bash
#!/bin/bash
# Utilise le SDK comme un simple CLI

# One-shot
RESPONSE=$(node claude-native.mjs -p "Résume ce fichier: $(cat README.md)")
echo "$RESPONSE"

# Avec un modèle spécifique
node claude-native.mjs -m opus -p "Review this code" < main.py

# Pipe
cat error.log | node claude-native.mjs -p "Explique cette erreur"
```

### Option 4 : Comme serveur MCP

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

## Legacy Bridge

`claude-tool-loop.js` is the original bridge that wraps the `claude` binary via stream-json. It still works but requires the 190MB binary + subscription. The native SDKs replace it entirely.

## License

MIT

