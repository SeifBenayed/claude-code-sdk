# cloclo (claude-native) — Project Conventions

## Architecture

**CRITICAL: `claude-native.mjs` is a BUILD OUTPUT. NEVER edit it directly.**
All source code lives in `src/` (21 modules). Edit there, then run `node build.mjs` to regenerate `claude-native.mjs`. Any direct edit to `claude-native.mjs` will be lost on next build.

Source modules in `src/` (dependency order):
`utils.mjs` → `config.mjs` → `providers.mjs` → `auth.mjs` → `security-rules.mjs` → `security.mjs` → `browser.mjs` → `tools.mjs` → `lsp.mjs` → `auto-memory.mjs` → `memory-metrics.mjs` → `memory-dream.mjs` → `audit.mjs` → `teams.mjs` → `sandbox.mjs` → `context-refs.mjs` → `smart-routing.mjs` → `skill-metrics.mjs` (optional) → `cron.mjs` → `engine.mjs` → `session.mjs` → `index.mjs`

Ink UI in `ink-ui.mjs` (runtime deps: `ink`, `ink-select-input`, `ink-text-input`, `react`). NDJSON bridge in `claude-tool-loop.js` (~943 lines, supports `stream` and `mcp` modes). `gstack/` is a vendored skill/tool framework sub-project.

npm package: `cloclo` (v1.0.1). Binary: `cloclo`. Shipped files: `claude-native.mjs`, `ink-ui.mjs`, `README.md`, `ROADMAP.md`.

## Testing & Build Workflow

```bash
node build.mjs              # Rebuild claude-native.mjs from src/
npm test                     # test-suite.mjs && test-loop.js && test-mcp.js
node test-suite.mjs          # Unit tests only (1542+ assertions)
node test-suite.mjs --e2e    # + live API calls (needs keys)
node test-suite.mjs --verbose # Verbose on failures
```

**Baseline**: `git stash && node test-suite.mjs` → 1453 passed, 0 failed, 13 skipped. Working tree has ~89 additional passing tests and 53 tests for unimplemented features (skill-metrics wiring, nudge system, CLI -p validation). These are test-ahead-of-implementation, not regressions.

**After any code change**: always `node build.mjs` then `npm test` (or at least `node test-suite.mjs`).

### Test Patterns

- **Unit tests**: Extract functions via `extractBlock()`, eval in isolated namespace. Beware: `extractBlock` counts braces — destructured default params like `{ type, since } = {}` will break extraction. Use `opts` param + `opts?.type` instead.
- **E2E tests**: `runCLI(args, envOverrides, timeout)` — spawns child process, captures stdout/stderr/exitCode.
- Add new test sections before the `// SUMMARY` block (~line 7099) in `test-suite.mjs`.

## Memory System

Two-scope persistent memory: **user** (`~/.claude-native/user-memory/`) and **project** (`~/.claude-native/projects/<sanitized-cwd>/memory/`). Each has a `MEMORY.md` index.

Key modules:
- `auto-memory.mjs` — Per-exchange LLM classifier (tier 1 regex pre-filter → tier 2 LLM). Accepts 5-exchange rolling window for context.
- `memory-metrics.mjs` — JSONL tracking (`memory-metrics.jsonl`) of `memory_loaded` and `memory_referenced` events. Rotates at 5000→3000 lines.
- `memory-dream.mjs` — Background "Dream" consolidation agent. Triggers after 5+ sessions AND 24+ hours AND new memories. 4-phase: Orient → Gather Signal → Consolidate → Prune. Lockfile-based concurrency guard.
- `engine.mjs` — `buildMemoryPrompt()`, `loadMemoryIndex()` (enriches display with `(saved: YYYY-MM-DD)` timestamps), `memory-dream` agent definition in `AGENT_DEFINITIONS`.
- `tools.mjs` — `MemoryList`, `MemoryRead` (emits `memory_referenced` metric), `MemorySave`, `MemoryForget`.
- `session.mjs` — `_exchangeBuffer` (5-exchange ring buffer), dream trigger after each exchange, `incrementDreamSessionCount()` on session exit.
- `index.mjs` — `incrementDreamSessionCount()` on one-shot exit too.

Dream state: `~/.claude-native/dream-state.json`

## Provider Contract

All providers in the `PROVIDERS` object. Required fields: `name`, `detect(model)`, `envKey`, `defaultUrl`, `createClient(cfg)`, `resolveAuth(cfg)`, `resolveBaseUrl(cfg)`, `transformModel(model)`, `capabilities`. Optional: `oauthSupport` (Anthropic, OpenAI only). `envKey` is `null` for local providers.

Valid providers: `anthropic`, `openai`, `openai-responses`, `google`, `deepseek`, `mistral`, `groq`, `ollama`, `lmstudio`, `vllm`, `jan`, `llamacpp`.

## Agent System

`AGENT_DEFINITIONS` in `engine.mjs`: `general-purpose`, `Explore`, `Plan`, `claude-code-guide`, `verification`, `orchestrator`, `code-reviewer`, `security-reviewer`, `import-reviewer`, `memory-dream`. Custom agents via `.claude/agents/` YAML files loaded by `AgentLoader`.

## Convention Files

Provider-aware: Anthropic → `CLAUDE.md`, OpenAI/Mistral → `AGENTS.md`, Gemini → `GEMINI.md`, Others → `INIT.md`. `INIT.md` always loaded as base layer. Use `/init` to generate or update.

## macOS /tmp Gotcha

`process.cwd()` resolves `/tmp` → `/private/tmp` on macOS. The sanitized memory dir path will differ. Use `$HOME`-relative paths for E2E tests, not `/tmp`.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Runtime error |
| 2 | Bad arguments |
| 3 | Auth failure |
| 4 | Provider error |
| 5 | Timeout |

## Error Conventions

- `Error:` prefix — all user-facing errors that exit
- `Fatal:` prefix — only the top-level unhandled exception catch

## Key Directories

- `gstack/` — Vendored skill/tool framework with sub-skills (`agents/`, `qa/`, `review/`, `ship/`, etc.), Supabase edge functions (`supabase/functions/`), and browser automation (`browse/`).
- `rust-sdk/` — Rust port (Cargo workspace in `rust-sdk/Cargo.toml`).
- `package/` — Packaged build output for npm publishing.
- `autoresearch/` — Automated evolution framework (mutations, benchmarks, scoring).

## Known Limitations

- OAuth only for Anthropic and OpenAI (others use API keys)
- macOS keychain for credential storage (no Linux/Windows yet)
- Single-file means no tree-shaking; entire file loaded even for `--help`
- `extractBlock()` in tests breaks on destructured default params (use plain `opts` param)
- 53 test failures in working tree are test-ahead-of-implementation (skill-metrics, nudge, CLI -p) — not regressions
