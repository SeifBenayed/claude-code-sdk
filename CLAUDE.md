# cloclo (claude-native) — Project Conventions

## Architecture

**CRITICAL: `claude-native.mjs` is a BUILD OUTPUT. NEVER edit it directly.**
All source code lives in `src/` (19 modules). Edit there, then run `node build.mjs` to regenerate `claude-native.mjs`. Any direct edit to `claude-native.mjs` will be lost on next build.

Source modules in `src/`: `utils.mjs`, `config.mjs`, `providers.mjs`, `auth.mjs`, `security-rules.mjs`, `security.mjs`, `browser.mjs`, `tools.mjs`, `lsp.mjs`, `auto-memory.mjs`, `audit.mjs`, `teams.mjs`, `sandbox.mjs`, `context-refs.mjs`, `smart-routing.mjs`, `cron.mjs`, `engine.mjs`, `session.mjs`, `index.mjs`.

Ink UI in `ink-ui.mjs` (runtime deps: `ink`, `ink-select-input`, `ink-text-input`, `react`). NDJSON bridge in `claude-tool-loop.js` (~943 lines, supports `stream` and `mcp` modes). `gstack/` is a vendored skill/tool framework sub-project.

npm package: `cloclo` (v1.0.1). Binary: `cloclo`. Shipped files: `claude-native.mjs`, `ink-ui.mjs`, `README.md`, `ROADMAP.md`.

## Provider Contract

All providers in the `PROVIDERS` object. Required fields: `name`, `detect(model)`, `envKey`, `defaultUrl`, `createClient(cfg)`, `resolveAuth(cfg)`, `resolveBaseUrl(cfg)`, `transformModel(model)`, `capabilities`. Optional: `oauthSupport` (Anthropic, OpenAI only). `envKey` is `null` for local providers.

Valid providers: `anthropic`, `openai`, `openai-responses`, `google`, `deepseek`, `mistral`, `groq`, `ollama`, `lmstudio`, `vllm`, `jan`, `llamacpp`.

## Convention Files

Provider-aware: Anthropic → `CLAUDE.md`, OpenAI/Mistral → `AGENTS.md`, Gemini → `GEMINI.md`, Others → `INIT.md`. `INIT.md` always loaded as base layer. Use `/init` to generate or update.

## Testing

```bash
npm test                         # 133 test sections, 760+ assertions
npm run test:ink                 # Ink UI smoke tests
npm run test:e2e                 # Deferred tool E2E
node test-openai-integration.mjs # OpenAI provider E2E
node test-loop.js                # Agent loop tests
node test-mcp.js                 # MCP integration tests
node test-suite.mjs --e2e        # Full E2E (needs API keys)
node test-suite.mjs --verbose    # Verbose on failures
```

### Patterns

- **Unit tests**: Extract functions via `extractBlock()`, eval in isolated namespace.
- **E2E tests**: `runCLI(args, envOverrides, timeout)` — spawns child process, captures stdout/stderr/exitCode.
- **Ink smoke tests**: Separate file (`test-ink-smoke.mjs`).

Add new test sections before the summary block (~line 3457) in `test-suite.mjs`.

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

## Known Limitations

- OAuth only for Anthropic and OpenAI (others use API keys)
- macOS keychain for credential storage (no Linux/Windows yet)
- Single-file means no tree-shaking; entire file loaded even for `--help`