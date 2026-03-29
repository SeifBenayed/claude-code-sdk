# cloclo — Project Conventions

## Project
cloclo is an open-source Claude Code alternative: a multi-provider AI coding agent CLI. The main runtime is `claude-native.mjs`, a deliberately single-file Node.js CLI with zero native dependencies. Supporting parity/reference implementations exist in `claude-native.py`, `claude-native.go`, and `rust-sdk/`.

## Architecture
- Main product logic lives in `claude-native.mjs`; prefer small, surgical edits over broad rewrites.
- Keep core agent logic provider-agnostic. Provider differences belong in the `PROVIDERS` contract and client conversion layers, not in `AgentLoop`.
- Built-in tools are registered through `ToolRegistry`; some tools are eager, others deferred and surfaced via `ToolSearch`.
- Extensibility features are built into the main CLI: `CLAUDE.md` loading, `.claude/settings*.json`, rules, skills, hooks, memory, sessions, and MCP integration.
- `ink-ui.mjs` contains the Ink terminal UI; avoid coupling UI-only behavior into non-interactive/NDJSON paths.
- `gstack/` is a separate subtree with its own docs/conventions; do not assume its patterns apply to the root CLI unless files explicitly integrate.

## Key Patterns
- Preserve the single-file distribution model for the main CLI unless a change explicitly requires otherwise.
- When adding a provider, implement the full provider contract: detection, auth/base URL resolution, model transform, client creation, and capabilities.
- Respect instruction-placement differences by provider (`system-blocks`, `system-message`, `developer-message`, `instructions-field`).
- Keep deferred tools marked as deferred; register `ToolSearch` when deferred tools exist.
- Maintain backward-compatible CLI behavior and help text for user-facing flags where possible.

## Build / Run
- `node claude-native.mjs` — interactive REPL
- `node claude-native.mjs -p "explain this code"` — one-shot mode
- `npm test` or `node test-suite.mjs` — main test suite
- `npm run test:ink` — Ink smoke test
- `npm run test:e2e` — deferred-tools E2E test
- `npx cloclo` — package entrypoint behavior

## Testing Conventions
- Add tests before changing behavior; do not ship untested changes.
- Primary tests live in `test-suite.mjs`; this file mixes extraction-based unit tests with spawned-process E2E checks.
- Unit tests commonly extract code blocks from `claude-native.mjs` and eval them in isolation; preserve stable function/class boundaries where practical.
- E2E tests spawn `node claude-native.mjs`; keep CLI I/O and exit codes deterministic.
- API-backed E2E in `test-suite.mjs --e2e` require credentials; keep non-E2E tests runnable without API keys.
- If you change NDJSON, deferred tools, provider detection, permissions, skills/hooks, or CLAUDE.md loading, update or add targeted tests.

## Important Constraints
- Read files before editing; do not make assumptions about uninspected code.
- Avoid introducing native dependencies or unnecessary package dependencies.
- Do not break macOS-oriented auth/keychain flows; current conventions assume macOS for OAuth helpers.
- Preserve support for multiple invocation styles: REPL, one-shot, NDJSON bridge, packaged binary entrypoint.
- Be careful with security-sensitive areas: Bash/tool permissions, hooks, file editing, auth handling, MCP tool registration.
- Keep user-facing errors concise and consistent with existing CLI messaging.
- Ignore generated/runtime state such as `.claude-native/`, `node_modules/`, `target/`, and packaged artifacts unless the task is specifically about them.