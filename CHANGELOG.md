# Changelog

## 1.0.1 (2026-03-27)

- Skills: manifest, list, info, remove, update, export, verify, search, publish
- Marketplace: self-hosted registry on Cloud Run, /marketplace UI
- Tools: management (list, info, enable, disable, test), custom tools (TOOL.json), AI backends (provider, ollama, openai-compatible, transformers)
- Browser: CDP-native tool pack with 19 actions, DOM indexing, loop detection
- Fix: bridge --resume no longer eats next flag
- Fix: version now reads from package.json (single source of truth)
- Fix: npm test runs bridge + MCP tests

## 1.0.0 (2026-03-26)

Initial public release.

### Features

- **13 providers**: Anthropic, OpenAI (Chat + Responses), Google Gemini, DeepSeek, Mistral, Groq, Ollama, LM Studio, vLLM, Jan, llama.cpp
- **Full agent loop**: streaming, tool calling, multi-turn, sub-agents
- **Built-in tools**: Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, Agent, NotebookEdit, TaskManager
- **Extended thinking**: `--thinking <budget>` for Claude models
- **MCP integration**: external tool servers via `--mcp-config`
- **Permissions**: 6 modes from `auto` to `bypassPermissions`
- **Session management**: resume, checkpoints, rewind
- **Memory system**: persistent cross-session memory
- **Skills & hooks**: extensible slash commands, lifecycle hooks (command, webhook, prompt, agent)
- **NDJSON bridge**: programmatic use from any language
- **Ink UI**: rich terminal interface with slash menu and status bar
- **OAuth**: Anthropic Pro/Max and OpenAI ChatGPT Plus/Pro subscription support
- **Structured output**: `--json` for machine-readable one-shot results
- **Agent-friendly CLI**: `--yes`, `--timeout`, strict exit codes (0-5)

### Architecture

- Single-file (`claude-native.mjs`, ~7800 lines), zero npm runtime deps
- Provider-pluggable core: AgentLoop reads capabilities, never checks provider names
- 760 tests (unit + E2E + Ink smoke)
