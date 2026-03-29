# Autoresearch: Cloclo Self-Improvement Directives

## Objective
You are optimizing cloclo to maximize benchmark scores across 1000 tasks.
Cloclo is a modular CLI — source files are in `~/claude-tool-loop/src/`.
After modifying src/, run `npm run build` from `~/claude-tool-loop/` to rebuild.

## Source Files (modifiable)
```
src/engine.mjs        — system prompt, message handling, response generation
src/tools.mjs         — tool definitions, orchestration, execution
src/session.mjs       — context management, conversation flow
src/providers.mjs     — model routing, provider detection, API calls
src/config.mjs        — configuration, defaults, settings
src/smart-routing.mjs — intelligent model/provider selection
src/utils.mjs         — shared utilities
src/security.mjs      — input validation, safety checks
src/auth.mjs          — authentication flow
src/index.mjs         — CLI entry point, arg parsing
src/context-refs.mjs  — context reference handling
src/auto-memory.mjs   — memory system
src/sandbox.mjs       — sandboxed execution
src/browser.mjs       — web browsing capability
src/cron.mjs          — scheduled tasks
src/lsp.mjs           — language server protocol
src/audit.mjs         — audit logging
src/teams.mjs         — team features
```

## Build
```bash
cd ~/claude-tool-loop && npm run build
```
This compiles src/*.mjs → claude-native.mjs (the monolith).

## Reward Signal
Score = keyword overlap with ground truth (60%) + length similarity (20%) + non-empty response (20%)

## Constraints
- DO NOT break the CLI interface (-p flag, REPL, NDJSON mode)
- DO NOT remove existing provider support
- DO NOT modify benchmark-1000.json, ground-truth.json, or autoresearch/ scripts
- After each mutation, run `npm run build` to rebuild
- Run `npm test` to verify nothing is broken
- Each mutation should be targeted: ONE file, ONE improvement

## Optimization Targets (priority order)

### 1. System Prompt Engineering (src/engine.mjs)
- Improve the default system prompt for better structured answers
- Add chain-of-thought triggers for complex reasoning
- Add format instructions (tables, code blocks, concise answers)

### 2. Tool Orchestration (src/tools.mjs)
- Improve tool selection logic (when to use bash vs file ops)
- Add retry logic with backoff for failed tool calls
- Better error messages when tools fail

### 3. Response Quality (src/engine.mjs, src/session.mjs)
- Ensure code outputs are runnable (no pseudocode when real code is asked)
- Better formatting for different question types
- Handle edge cases (empty input, unicode, large numbers)

### 4. Provider Optimization (src/providers.mjs, src/smart-routing.mjs)
- Optimize prompt construction per provider
- Better token management
- Tune temperature/parameters per task type

### 5. Multi-Step Reasoning (src/engine.mjs, src/tools.mjs)
- Break complex tasks into sub-steps
- Maintain context between tool calls
- Verify intermediate results before proceeding

### 6. Error Recovery (src/engine.mjs, src/session.mjs)
- Graceful fallbacks when primary approach fails
- Detect and retry transient errors
- Never return empty responses

## Strategy
1. Read recent results from `autoresearch/results/` to find weakest categories
2. Read the relevant src/ file for that weakness
3. Propose a hypothesis for why that category is weak
4. Make ONE targeted change in ONE file
5. Run `npm run build` to rebuild
6. Run `npm test` to verify no breakage
