# Roadmap

Priority: **safe → useful → stateful → recoverable → extensible → productized → enterprise**

## Positioning

cloclo is **the open multi-provider alternative** to Claude Code. We don't compete on Anthropic's home turf — we win where they can't: any LLM, anywhere, with tools they don't have.

| | Claude Code | cloclo | Mistral Vibe |
|---|---|---|---|
| Providers | 4 (Anthropic ecosystem) | **12 + local** | 4 |
| Architecture | Closed binary | **Single-file, open** | Python multi-module |
| Browser/Desktop | Via MCP only | **Native CDP + macOS** | No |
| Documents | Notebook only | **Spreadsheet, PDF, PPTX, DOCX** | No |
| Custom tools | MCP only | **4 backends** | MCP only |
| Remote | Polling + cloud sessions | **SSE relay + web UI** | No |
| Enterprise | Managed settings, SSO | Planned | No |
| Multi-surface | Terminal, IDE, Desktop, Web, Mobile | Terminal + Web remote | Terminal + IDEs |

## Current State

| Layer | Status | Notes |
|---|---|---|
| Runtime Core | **Done** | Permissions, rewind, memory, sub-agents, tasks, cron, worktrees |
| Provider Core | **Done** | 12-provider pluggable architecture |
| Extensibility Core | **Done** | Settings, rules, enhanced `CLAUDE.md`, hooks, skills |
| Skills Runtime | **Done** | Discovery, indexing, on-demand loading, scoped execution |
| Tool Runtime | **Done** | Built-ins, MCP, NDJSON, deferred tools, custom tools (CLI/HTTP/AI/shell) |
| Product UX | **Done** | Brief mode, slash registry, Ink UI, sessions, status line |
| Agent Platform | **Done** | AgentLoader, orchestrator, cross-provider sub-agents |
| Integrations | **Done** | Webhooks, MCP resources, tool catalog, official catalog |
| Browser/Desktop | **Done** | CDP 19 actions, macOS accessibility, DOM indexing |
| Document Tools | **Done** | Spreadsheet, PDF, Presentations, DOCX |
| Remote Sessions | **Done** | SSE relay, permission tiers (view/chat/control/privileged), approval flow, audit log, reconnect, terminal-style web UI, conversation replay |

---

## Phase 1 — Credibility (v3.0)

The monolith is the #1 blocker. Nobody contributes to an 11K-line file, and we can't parallelize work without modules. Everything else depends on this.

| # | Feature | Why | Impact | Effort | Status |
|:-:|---------|-----|:------:|:------:|:------:|
| 1 | **Split the monolith** | 11K lines in one file = zero contributors. Extract `src/providers/`, `src/tools/`, `src/agent/`, `src/skills/`, `src/ui/`, `src/permissions/`. Keep single entry point. | Critical | High | Planned |
| 2 | **LSP integration** | Without language server diagnostics, generated code is blind. TypeScript + Python LSP minimum. This is the #1 code quality multiplier. | Critical | High | Planned |
| 3 | **Native installer** | `npm install -g` loses casual users. Shell script (`curl \| sh`), Homebrew formula, standalone binary (bun compile or pkg). | High | Medium | Planned |
| 4 | **Auto-memory** | Our memory is manual (4 types, user must ask). Claude Code self-learns. Implement pattern detection: build commands, test commands, style preferences, project structure. | High | Medium | Planned |
| 5 | **Provider E2E hardening** | Live E2E tests for Google, DeepSeek, Ollama, Mistral, Groq. Can't claim 12 providers without proving they work. | High | Medium | Planned |
| 6 | **Docs + architecture guide** | No docs = no adoption. Architecture overview, getting started, provider guide, tool authoring guide, skill authoring guide. | High | Medium | Planned |

### Split plan (detail)

```
src/
  index.mjs          ← entry point, CLI arg parsing, main()
  providers/          ← PROVIDERS object, each provider in own file
    anthropic.mjs
    openai.mjs
    google.mjs
    ...
  agent/              ← AgentLoop, context compaction, sub-agent runner
  tools/              ← ToolRegistry, built-in tools, deferred loading, ToolSearch
  skills/             ← SkillLoader, SkillExecutionContext, skill discovery
  permissions/        ← PermissionManager, modes, rules, callbacks
  hooks/              ← HookRunner, webhook dispatcher
  session/            ← SessionManager, memory, checkpoints, rewind
  remote/             ← RemoteSessionManager, SSE relay client
  ui/                 ← InteractiveMode, slash commands, Ink bridge
  clients/            ← AnthropicClient, OpenAIClient, HTTP helpers
  utils/              ← shared helpers, OAuth, keychain
```

Build step: `esbuild src/index.mjs --bundle --outfile=cloclo.mjs --platform=node`

Tests import from `src/` directly. Published npm package ships the bundle.

---

## Phase 2 — Enterprise Layer (v4.0)

What a CISO needs to sign off on cloclo in a corporate environment.

| # | Feature | Why | Impact | Effort | Status |
|:-:|---------|-----|:------:|:------:|:------:|
| 7 | **Managed settings** | Org-level policies that cannot be overridden. Central API key management. Model allowlists. Tool restrictions. Precedence: managed > project > user. | Critical | High | Planned |
| 8 | **Sandbox execution** | Docker/container isolation for Bash tool. Option to run all tool execution in a sandbox. No CISO signs without this. | Critical | High | Planned |
| 9 | **Audit trail** | Full action log — not just remote audit. Every tool call, file edit, prompt, with timestamps. Exportable (JSON, SIEM-compatible). Retention policies. GDPR/SOC2 friendly. | High | Medium | Planned |
| 10 | **VS Code extension** | Side panel with the same runtime. Inline diffs, @-mentions, selection context. Most devs live in VS Code — this is table stakes. | High | High | Planned |
| 11 | **Agent teams** | Multi-agent coordination: shared task board, direct inter-agent messaging, parallel execution in worktrees. Beyond isolated sub-agents. | High | High | Planned |
| 12 | **Auto mode classifier** | AI-powered permission decisions. Evaluate tool calls for safety automatically. Reduces approval fatigue without reducing safety. | Medium | High | Planned |
| 13 | **SSO / SAML** | Enterprise auth. Tie cloclo identity to corporate IdP. Required for any serious enterprise deal. | Medium | Medium | Planned |

---

## Phase 3 — Ecosystem (v5.0)

Network effects. Make cloclo a platform others build on.

| # | Feature | Why | Impact | Effort | Status |
|:-:|---------|-----|:------:|:------:|:------:|
| 14 | **Plugin system** | Bundle skills + agents + hooks + MCP + tools in a single versioned, signed package. `cloclo plugin install @org/review-bot`. | High | High | Planned |
| 15 | **Marketplace 2.0** | Registry exists. Add: verified publishers, reviews, download stats, auto-update, categories, search ranking. | High | High | Planned |
| 16 | **Desktop app** | Tauri-based. Visual diff review, multi-session panels, drag-and-drop files, schedule tasks. The VS Code extension is for devs; the desktop app is for everyone. | High | Very High | Planned |
| 17 | **Cloud sessions** | Run cloclo in the cloud with no local setup. Like claude.ai/code but multi-provider. Serverless containers with session persistence. | High | Very High | Planned |
| 18 | **Voice mode** | Dictation + TTS. Mistral Vibe has this and it's a differentiator on mobile. Whisper for STT, edge TTS for speech. Works great with remote web UI. | Medium | Medium | Planned |
| 19 | **JetBrains plugin** | IntelliJ, PyCharm, WebStorm. Same runtime, IDE-native UI. Second IDE surface after VS Code. | Medium | High | Planned |

---

## What NOT to build

- **Full Claude Code parity** — they have 50 engineers. Pick fights we can win.
- **More features before the split** — 11K lines is the ceiling. Split first.
- **An installer before LSP works** — without LSP the code quality is mediocre, users churn after 10 minutes.
- **A desktop app before VS Code** — VS Code reaches 10x more developers.
- **Enterprise features before sandbox** — no point selling to enterprises if they can't pass security review.

---

## Moat Strategy

Our defensible advantages, in order of importance:

1. **Multi-provider + local models** — Air-gapped enterprise, Ollama, LM Studio. Claude Code can never do this.
2. **Native browser + desktop automation** — Not via MCP proxy, native CDP. Better latency, more actions, anti-bot.
3. **Document tools** — Spreadsheet, PDF, PPTX, DOCX. Nobody else has this.
4. **Custom tool backends** — CLI, HTTP, AI, shell. Not just MCP.
5. **Open single-file** — Hackable, forkable, auditable. Enterprises that can't use Anthropic's binary can use ours.
6. **Remote web UI** — Control from phone. SSE transport works everywhere.

Protect these. Don't dilute them chasing Claude Code features we can't match.

---

## Claude Code Gap Map (updated)

### Strong match (parity or better)

| System | Status |
|---|---|
| Worktrees | Strong match |
| Tasks | Strong match |
| Cron | Strong match |
| Provider architecture | **Better** — 12 providers vs 4, local model support |
| Memory system | Strong match (manual; auto-memory planned) |
| Checkpointing + rewind | Strong match |
| Brief mode | Strong match |
| ToolSearch / deferred tools | Strong match |
| Plan mode | Strong match |
| Context compaction | Strong match |
| MCP resources | Strong match |
| Verification auto-trigger | Strong match |
| Browser automation | **Better** — native CDP vs MCP proxy |
| Document tools | **Better** — they have none |
| Custom tools | **Better** — 4 backends vs MCP-only |
| Remote access | **Different** — SSE relay vs polling. Both work. |
| Remote permissions | **Better** — 4 tiers + approval flow + audit. They have basic remote control. |

### Close

| System | Status |
|---|---|
| Skills | Close — full lifecycle, scoped execution, fork. Missing: `context: fork` subagent isolation |
| Hooks | Close — 9+ events + webhooks. Missing: FileChanged, CwdChanged, team events |
| Permissions | Close — 6 modes + remote tiers. Missing: auto classifier, managed policies |
| Session UX | Close — resume/listing. Missing: multi-surface continuity |

### Gaps (what they have, we don't)

| System | Impact | Plan |
|---|:---:|---|
| LSP (20+ languages) | **Critical** | Phase 1 — #2 |
| Multi-surface (IDE, Desktop, Web, Mobile) | High | Phase 2 (VS Code) + Phase 3 (Desktop, Cloud) |
| Agent teams | High | Phase 2 — #11 |
| Auto-memory (self-learning) | High | Phase 1 — #4 |
| Managed settings / SSO | High | Phase 2 — #7, #13 |
| Sandbox execution | High | Phase 2 — #8 |
| Auto mode classifier | Medium | Phase 2 — #12 |
| Plugin system (bundled packages) | Medium | Phase 3 — #14 |
| 50+ pre-configured MCP servers | Medium | Grow organically via marketplace |
| Voice | Low | Phase 3 — #18 |

---

## Execution Order

```
Phase 1 (credibility):
  1. Split monolith          → contributors possible
  2. LSP (TS + Python)       → code quality 10x
  3. Native installer        → adoption
  4. Auto-memory             → stickiness
  5. Provider E2E            → trust
  6. Docs                    → discoverability

Phase 2 (enterprise):
  7. Managed settings        → enterprise sales
  8. Sandbox                 → security sign-off
  9. Audit trail             → compliance
  10. VS Code extension      → reach
  11. Agent teams            → differentiation
  12. Auto classifier        → UX
  13. SSO                    → enterprise auth

Phase 3 (ecosystem):
  14. Plugin system          → platform
  15. Marketplace 2.0        → network effects
  16. Desktop app            → surface
  17. Cloud sessions         → zero-setup
  18. Voice                  → mobile UX
  19. JetBrains              → second IDE
```

---

## Shipped Milestones

### T6B/C — Remote Permissions + Production Transport (v2.5)

| # | Feature | Status |
|:-:|---------|:------:|
| 1 | Permission tiers (view/chat/control/privileged) | **Done** |
| 2 | Host-side enforcement in `_processInput` | **Done** |
| 3 | Approval flow (host approves/denies remote tool use) | **Done** |
| 4 | Host auto-reconnect with exponential backoff | **Done** |
| 5 | Audit log (500-event ring buffer, 12 event types) | **Done** |
| 6 | `/remote mode`, `/remote approve`, `/remote deny`, `/remote log` | **Done** |
| 7 | SSE + POST transport (replaces WebSocket — fixes Cloud Run HTTP/2) | **Done** |
| 8 | Conversation replay for late-joining clients | **Done** |
| 9 | Terminal-style web UI (Tokyo Night, monospace, status bar) | **Done** |
| 10 | Relay: message buffering, mode change endpoint, reconnect flush | **Done** |
| 11 | 62 new test assertions (1360 total, 0 failures) | **Done** |

### T6A — Remote Sessions (v2.5)

| # | Feature | Status |
|:-:|---------|:------:|
| 1 | RemoteSessionManager (WS relay connection) | **Done** |
| 2 | `/remote` command (start/status/stop/renew) | **Done** |
| 3 | Relay server with WS upgrade, session management | **Done** |
| 4 | Web UI for mobile/browser access | **Done** |
| 5 | Host→client event forwarding (text_delta, tool_use, tool_result) | **Done** |
| 6 | HMAC token signing, session expiry, rate limiting | **Done** |

### v2.4 — Agent Platform + Runtime Integrations

| # | Feature | Status |
|:-:|---------|:------:|
| 1 | ~~Public agent extensibility via `AgentLoader`~~ | **Done** |
| 2 | ~~`/agent-create` interactive custom agent builder~~ | **Done** |
| 3 | ~~Cross-provider sub-agents~~ | **Done** |
| 4 | ~~`orchestrator` agent with workload-based routing~~ | **Done** |
| 5 | ~~Verification auto-trigger~~ | **Done** |
| 6 | ~~Expanded hook events~~ | **Done** |
| 7 | ~~MCP resource tools~~ | **Done** |
| 8 | ~~Webhook integrations~~ | **Done** |

### v2.3 — Product UX Layer

| # | Feature | Status |
|:-:|---------|:------:|
| 1 | ~~Brief mode / `SendUserMessage`~~ | **Done** |
| 2 | ~~Slash command registry~~ | **Done** |
| 3 | ~~`/help` command palette~~ | **Done** |
| 4 | ~~Tab completion~~ | **Done** |
| 5 | ~~Status line~~ | **Done** |
| 6 | ~~Ink UI with readline fallback~~ | **Done** |
| 7 | ~~Project-scoped sessions~~ | **Done** |

### v2.2 — Deferred Tool Loading

| # | Feature | Status |
|:-:|---------|:------:|
| 1 | ~~Deferred tool registrations~~ | **Done** |
| 2 | ~~`ToolSearch` meta-tool~~ | **Done** |
| 3 | ~~Delta tracking~~ | **Done** |
| 4 | ~~MCP tools deferred by default~~ | **Done** |
| 5 | ~~Deferred → eager promotion~~ | **Done** |

### v2.1 — Skills Hardening

| # | Feature | Status |
|:-:|---------|:------:|
| 1 | ~~`SkillExecutionContext`~~ | **Done** |
| 2 | ~~Skill-scoped tool restrictions~~ | **Done** |
| 3 | ~~Path-scoped rules~~ | **Done** |
| 4 | ~~Skill-scoped hooks~~ | **Done** |
| 5 | ~~Skill data dir~~ | **Done** |

### v2.0 — Extensibility Core

| # | Feature | Status |
|:-:|---------|:------:|
| 1 | ~~Settings loader~~ | **Done** |
| 2 | ~~Rules engine~~ | **Done** |
| 3 | ~~Enhanced `CLAUDE.md`~~ | **Done** |
| 4 | ~~Skills system~~ | **Done** |
| 5 | ~~Hooks system~~ | **Done** |

### v1.x — Foundation

| Version | What shipped |
|---|---|
| v1.5 | Provider-pluggable architecture (12 providers) |
| v1.4 | Sub-agents, bug fixes |
| v1.3 | Memory system, context compaction |
| v1.2 | File checkpointing, rewind |
| v1.1 | Permission modes, tool rules, callbacks |
| v1.0 | OAuth, streaming, agent loop, tools, MCP, NDJSON, REPL, sessions, 4 SDKs |
