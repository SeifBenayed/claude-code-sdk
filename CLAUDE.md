# cloclo (claude-native) — Project Conventions

## Architecture

Single-file CLI (`claude-native.mjs`, ~7900 lines) with multi-language ports (`claude-native.py`, `claude-native.go`, `rust-sdk/`). The JS version is the primary implementation. Ink UI in `ink-ui.mjs` (optional, has runtime deps). NDJSON bridge in `claude-tool-loop.js`.

npm package name: `cloclo`. Binary: `cloclo`. Runtime deps: `ink`, `react` (for TUI only).

## Provider Contract

All providers live in the `PROVIDERS` object. Each entry must implement:

- `name`, `detect(model)`, `envKey`, `defaultUrl`
- `createClient(cfg)`, `resolveAuth(cfg)`, `resolveBaseUrl(cfg)`
- `transformModel(model)`, `capabilities`
- Optional: `oauthSupport` (Anthropic, OpenAI, OpenAI Responses only)

`envKey` can be `null` for local providers (Ollama, LM Studio, vLLM, Jan, llama.cpp).

Valid providers: `anthropic`, `openai`, `openai-responses`, `google`, `deepseek`, `mistral`, `groq`, `ollama`, `lmstudio`, `vllm`, `jan`, `llamacpp`.

## Convention Files

Provider-aware: Anthropic → `CLAUDE.md`, OpenAI/Mistral → `AGENTS.md`, Gemini → `GEMINI.md`, Others → `INIT.md`. `INIT.md` always loaded as base layer.

## Testing

```bash
npm test                    # Unit tests (760+, no API keys needed)
node test-ink-smoke.mjs     # Ink UI smoke tests
node test-e2e-deferred.mjs  # Deferred tool E2E
node test-suite.mjs --e2e   # E2E tests (needs API keys)
node test-suite.mjs --verbose  # Verbose output on failures
```

### Patterns

- **Unit tests**: Extract functions from source via `extractBlock()`, eval in isolated namespace.
- **E2E tests**: `runCLI(args, envOverrides, timeout)` — spawns child process, captures stdout/stderr/exitCode.
- **Ink smoke tests**: Separate file (`test-ink-smoke.mjs`).

Add new test sections before the summary block (~line 3460) in `test-suite.mjs`.

## Exit Codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `EXIT.OK` | Success |
| 1 | `EXIT.RUNTIME_ERROR` | Catch-all runtime failure |
| 2 | `EXIT.BAD_ARGS` | Invalid/missing CLI arguments |
| 3 | `EXIT.AUTH_FAILURE` | No credentials or rejected |
| 4 | `EXIT.PROVIDER_ERROR` | Provider/model unavailable |
| 5 | `EXIT.TIMEOUT` | Global `--timeout` exceeded |

## Error Message Conventions

- `Error:` prefix — all user-facing errors that exit
- `Fatal:` prefix — only the top-level unhandled exception catch

## Known Limitations

- OAuth only for Anthropic and OpenAI (others use API keys)
- macOS keychain for credential storage (no Linux/Windows yet)
- Single-file means no tree-shaking; entire file loaded even for `--help`
