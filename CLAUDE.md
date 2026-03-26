# cloclo (claude-native) — Project Conventions

## Architecture

Single-file CLI (`claude-native.mjs`, ~7900 lines) with multi-language ports (`claude-native.py`, `claude-native.go`, `rust-sdk/`). The JS version is the primary implementation. Ink UI in `ink-ui.mjs` (optional runtime deps: `ink`, `ink-select-input`, `ink-text-input`, `react`). NDJSON bridge in `claude-tool-loop.js` (~943 lines, supports `stream` and `mcp` modes). `gstack/` is a vendored skill/tool framework sub-project.

npm package: `cloclo`. Binary: `cloclo`. Shipped files: `claude-native.mjs`, `ink-ui.mjs`, `README.md`, `ROADMAP.md`.

## Provider Contract

All providers in the `PROVIDERS` object. Required fields: `name`, `detect(model)`, `envKey`, `defaultUrl`, `createClient(cfg)`, `resolveAuth(cfg)`, `resolveBaseUrl(cfg)`, `transformModel(model)`, `capabilities`. Optional: `oauthSupport` (Anthropic, OpenAI only). `envKey` is `null` for local providers.

Valid providers: `anthropic`, `openai`, `openai-responses`, `google`, `deepseek`, `mistral`, `groq`, `ollama`, `lmstudio`, `vllm`, `jan`, `llamacpp`.

## Convention Files

Provider-aware: Anthropic → `CLAUDE.md`, OpenAI/Mistral → `AGENTS.md`, Gemini → `GEMINI.md`, Others → `INIT.md`. `INIT.md` always loaded as base layer. Use `/init` to generate or update.

## Testing

```bash
npm test                         # 133 test sections, 760+ assertions
node test-ink-smoke.mjs          # Ink UI smoke tests
node test-e2e-deferred.mjs       # Deferred tool E2E
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

## Known Limitations

- OAuth only for Anthropic and OpenAI (others use API keys)
- macOS keychain for credential storage (no Linux/Windows yet)
- Single-file means no tree-shaking; entire file loaded even for `--help`
