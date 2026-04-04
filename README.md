# cloclo

[![npm version](https://img.shields.io/npm/v/cloclo.svg)](https://www.npmjs.com/package/cloclo)
[![npm downloads](https://img.shields.io/npm/dm/cloclo.svg)](https://www.npmjs.com/package/cloclo)
[![license](https://img.shields.io/npm/l/cloclo.svg)](LICENSE)

**The multi-agent runtime.**

Cloclo is a runtime and CLI for agents that think, coordinate, and execute together over **NDJSON**. It is not another chat UI. It is the substrate: **AICL-native agent orchestration, shared tools, shared memory, shared skills, 13 model providers, zero native dependencies.**

> Build agents, wire them over NDJSON, let them run on the best model for the job.

## What is Cloclo

Cloclo is an open-source **multi-agent runtime**.

It gives agents a common execution environment:

- **NDJSON bridge first**: line-oriented stdin/stdout transport for programmatic control
- **AICL-native**: agents can communicate in a shared inter-agent protocol
- **13 providers**: run the same agent system on Anthropic, OpenAI, Gemini, Ollama, and more
- **Shared infrastructure**: tools, memory, skills, permissions, hooks, sessions
- **Single-file runtime**: shipped as `claude-native.mjs`, with zero native deps

The terminal UI exists, but it is not the center of the architecture. The center is the runtime.

If Claude Code is an end-user product, Cloclo is closer to the layer underneath: the programmable environment where many agents can coexist, collaborate, and be composed into larger systems.

## AICL Protocol

**AICL** stands for **Agent Interlingua for Cooperative Labor**.

It is Cloclo's native protocol for agent-to-agent communication. AICL gives agents a compact shared language for ownership, intent, evidence, confidence, state changes, constraints, and handoffs.

Core symbols:

- `ω` — who owns the message
- `ψ` — goal / intent
- `∂` — what changed
- `◊` — hypothesis
- `⊤` / `⊥` — verified true / false
- `σ` — confidence
- `ε` — evidence
- `λ` — actions
- `κ` — constraints
- `→` — handoff
- `∇` — direction

Example:

```text
ω:planner → coder | ψ:fix(auth.null_ref) | ε:src/auth.js:42 | ◊:missing_guard σ:0.9 | λ:patch→test | ∇:ship
```

Under the hood, Cloclo uses **NDJSON transport** and can inject AICL framing into agent workflows so sub-agents can return structured results instead of just loose prose.

If you are building multi-agent systems, AICL is the native language layer above the transport.

## Quick Start

Install:

```bash
npm install -g cloclo
```

Run Cloclo as an **NDJSON bridge**:

```bash
cloclo --ndjson
```

Send a message from another process:

```bash
echo '{"type":"message","content":"hello"}' | cloclo --ndjson
```

Minimal Node example:

```js
import { spawn } from "node:child_process";

const child = spawn("cloclo", ["--ndjson"], { stdio: ["pipe", "pipe", "inherit"] });

child.stdout.on("data", (buf) => {
  process.stdout.write(buf);
});

child.stdin.write(JSON.stringify({
  type: "message",
  content: "Read the repo and summarize the runtime architecture"
}) + "\n");
```

Run with a specific model/provider:

```bash
cloclo --ndjson -m opus
cloclo --ndjson -m gpt-5.4
cloclo --ndjson -m gemini-2.5-pro
cloclo --ndjson -m ollama/llama3.2
```

Auth examples:

```bash
cloclo --login         # Anthropic subscription / auth flow
cloclo --openai-login  # OpenAI subscription / auth flow
export GOOGLE_API_KEY=...
export DEEPSEEK_API_KEY=...
```

The important idea: **treat Cloclo like a runtime process your agents talk to**, not a REPL you manually inhabit.

## Providers

Cloclo supports **13 providers** behind one runtime contract:

| Provider | Example models |
|---|---|
| Anthropic | `claude-sonnet-4-6`, `claude-opus-4-6` |
| OpenAI | `gpt-5.4`, `gpt-4o`, `o3` |
| OpenAI Responses | `gpt-5.3-codex` |
| Google Gemini | `gemini-2.5-pro`, `gemini-2.5-flash` |
| DeepSeek | `deepseek-chat`, `deepseek-coder` |
| Mistral | `mistral-small-latest`, `codestral-latest` |
| Groq | `llama-3.3-70b-versatile`, `mixtral-8x7b` |
| Ollama | `ollama/*` |
| LM Studio | `lmstudio/*` |
| vLLM | `vllm/*` |
| Jan | `jan/*` |
| MiniMax | `minimax/*` |
| llama.cpp | `llamacpp/*` |

Why this matters:

- agents are **provider-agnostic by default**
- model routing can vary by task, cost, speed, or capability
- the same runtime can mix hosted frontier models with local models
- provider-specific quirks are normalized at the runtime layer

Cloclo handles differences in auth, base URLs, tool calling, and instruction placement so your agent system does not have to.

## Agent System

Cloclo is built for **many-agent execution**, not just single-assistant chat.

The runtime includes support for:

- **sub-agents** launched from a parent agent
- **tool invocation** across a shared registry
- **permissions and security rules** around risky actions
- **sessions, resumability, checkpoints, and history compaction**
- **MCP integration** for external tool servers
- **provider-aware execution** while keeping core agent logic portable

Built-in capabilities include file tools, shell execution, search, web fetch, browser automation, memory access, and agent spawning. Skills and hooks let you extend the runtime without rewriting the core loop.

In practice, this means you can build systems where one agent plans, another patches code, another verifies, another searches docs, and all of them operate inside the same runtime contract.

## Memory

Cloclo ships with persistent memory for both **user scope** and **project scope**.

This is not just chat history. It is runtime memory agents can use to retain:

- user preferences
- project context
- prior decisions
- reference pointers
- reusable feedback

The memory system is file-backed, inspectable, and designed for long-running collaboration. Agents can read, write, update, and forget memories instead of re-deriving everything every session.

For multi-agent systems, memory acts like shared durable context: less repetition, better continuity, more coherent coordination.

## Skills

Skills are reusable capability packages that extend what agents can do.

They are the runtime's way of turning repeated workflows into named, composable behaviors. Examples include:

- debugging flows
- PR review
- document and PDF handling
- spreadsheet work
- frontend generation
- commit helpers
- code simplification

Skills sit above raw tools. Tools are primitives; skills are patterns.

This makes Cloclo useful as a shared substrate for agent teams: every agent can inherit the same operational vocabulary instead of each one reinventing the workflow.

## Gogeta example

**Gogeta** is an example of the kind of system Cloclo enables.

Think of Gogeta as a fusion layer built on top of the runtime:

- one model is strong at planning
- another is strong at code edits
- another is strong at verification
- another is cheap and fast for retrieval or summarization

Cloclo provides the runtime pieces that make this composition practical:

- NDJSON transport
- AICL coordination
- provider abstraction
- shared tools
- shared memory
- shared skills
- sub-agent execution

So Gogeta is not the runtime itself. It is an example of what you can build **on top of** the runtime: a multi-model, multi-agent system with structured cooperation.

## Why Cloclo

Use Cloclo if you want:

- a **runtime**, not just a chatbot
- **multi-agent orchestration** over a clean CLI boundary
- **NDJSON-first integration** from any language
- **AICL-native coordination** between agents
- **portable execution** across 13 providers
- **shared infrastructure** for tools, memory, and skills

## Install from source

```bash
git clone https://github.com/SeifBenayed/claude-code-sdk.git
cd claude-code-sdk
npm install
node build.mjs
node claude-native.mjs --ndjson
```

## Project structure

- `src/` — editable runtime source
- `claude-native.mjs` — bundled single-file CLI output
- `AICL_ONBOARDING.md` — onboarding doc for agents entering the runtime
- `test-suite.mjs` — runtime and E2E tests

## License

MIT
