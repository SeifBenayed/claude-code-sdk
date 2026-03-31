# Changelog

## 1.1.0 (2026-03-31) — CC Parity Audit & Major Overhaul

### Security
- **LLM Security Classifier**: Full 2-stage classifier (28 BLOCK rules, 7 ALLOW exceptions, 6 User Intent rules, 10 Evaluation rules). Provider-aware model selection.
- **bypassPermissions guard**: Classifier blocks dangerous ops even in bypass mode.
- **Sandbox fallback warning**: Visible warning when Docker unavailable.

### Reliability
- **Retry**: 3 → 10 retries, exponential backoff with jitter, `x-should-retry` header, 529 persistent retry.
- **Token estimation**: 3.5 → 4 chars/token + x1.333 safety multiplier.
- **Auto-compact**: Threshold raised 75% → 85%.
- **Prompt caching**: `cache_control` on last user message (60-70% cost reduction).

### Architecture
- **Fork mode**: Sub-agents inherit parent context + prompt cache when no `subagent_type` specified.
- **5 new hooks**: `PostToolUseFailure`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PermissionRequest`.
- **Flat agents**: CC-compatible `.md` files in `.claude/agents/`.

### Shareable Moments
- `/share` command: Capture exchanges as markdown, HTML, SVG, or JSON.
- `MemoryShare` tool: Agent can capture moments programmatically.
- Auto-suggest: Detects noteworthy exchanges (bug fixes, refactors, one-shots).
- Sanitization: Auto-strips secrets and absolute paths.

### Ink UI Overhaul (777 → 1130 lines)
- Event-driven streaming (token-by-token with cursor).
- Permission dialogs (y/n/a inline).
- Tool spinners with elapsed timer.
- Markdown rendering + syntax highlighting.
- Context %, token usage, thinking display, diff rendering.
- Arrow key history navigation + Ctrl+R fuzzy search.
- Ctrl+C proper exit handling.

### Marketplace
- `/marketplace` command with local fallback when registry empty.
- 45 skills published to registry (gstack-*, office, dev tools).
- No more hardcoded command intercepts in ink-ui.

### Stats
- 3008 insertions, 611 deletions across 12 files + 1 new module (share.mjs)
- 1625 tests passed, 0 regressions

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
