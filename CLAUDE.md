# claude-native — Project Conventions

## Architecture

Single-file CLI (`claude-native.mjs`, ~7800 lines). Zero npm dependencies — uses only Node.js built-ins. This is intentional: the entire tool ships as one file you can `node claude-native.mjs`.

Trade-offs: large file, but trivial deployment and no dependency supply-chain risk.

## Provider Contract

All providers live in the `PROVIDERS` object. Each entry must implement:

- `name` — display name
- `detect(model)` — returns true if model string belongs to this provider
- `envKey` — environment variable name for the API key
- `defaultUrl` — base URL for the API
- `createClient(cfg)` — returns a client instance
- `resolveAuth(cfg)` / `resolveBaseUrl(cfg)` — credential/URL resolution
- `transformModel(model)` — model name normalization
- `capabilities` — object with `apiStyle`, `toolCallStyle`, `instructionPlacement`, `supportsToolCalling`, `supportsThinking`, `supportsHostedWebSearch`, `summaryModel`

Valid provider names: `anthropic`, `openai`, `openai-responses`, `google`, `deepseek`, `mistral`, `groq`, `ollama`, `lmstudio`, `vllm`, `jan`.

## Testing

Run all tests:

```bash
node test-suite.mjs
```

### Patterns

- **Unit tests**: Extract functions/classes from source via `extractBlock()`, eval in isolated namespace.
- **E2E tests**: Use `runCLI(args, envOverrides, timeout)` helper — spawns a child process and captures stdout/stderr/exitCode.
- **Ink smoke tests**: Verify TUI rendering (separate section in test-suite).

### Adding tests

Add new test sections before the summary block (`process.stderr.write(\`\\n\\x1b[1m${"═"...`), after the existing E2E sections. Use `section("...")` + `assert(...)` / `skip(...)`.

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

- `Error:` prefix — all user-facing errors that exit (bad args, auth, provider)
- `Fatal:` prefix — only the top-level unhandled exception catch
- No prefix for verbose `log()` or status messages

## Known Limitations

- No Windows support (keychain uses macOS `security` command)
- OAuth flows require a browser
- Single-file means no tree-shaking; entire file is loaded even for `--help`
