# Roadmap

Priority: **safe → useful → stateful → recoverable → extensible**

## v1.1 — Safety (Permissions)

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 1 | ~~Permission modes (default/plan/acceptEdits/bypassPermissions/dontAsk)~~ | Critical | Medium | **Done** |
| 1 | ~~Tool allow/deny rules~~ | Critical | Easy | **Done** |
| 1 | ~~Permission callbacks (forward to agent for decision)~~ | High | Medium | **Done** |

## v1.2 — Recoverability

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 2 | ~~File checkpointing (snapshot before edits)~~ | Critical | Medium | **Done** |
| 2 | ~~Rewind (restore files to pre-edit state)~~ | Critical | Medium | **Done** |

## v1.3 — Statefulness

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 3 | Context compaction (auto-summary when context full) | Critical | High | Planned |
| 4 | ~~Memory system (MEMORY.md, auto-save/recall)~~ | High | Medium | **Done** |

## v1.4 — Agent Intelligence

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 5 | Sub-agents (Agent tool, parallel spawn) | High | High | Planned |

## v2.0 — Extensibility

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 6 | Plugin/skill system (`/commit`, `/review`) | Medium | Easy | Planned |
| 7 | Cross-platform auth (Linux keychain, Windows credential manager) | High | Medium | Planned |
| 8 | Marketplace (browse/install plugins) | Medium | Medium | Planned |
| 9 | npm / pip / cargo publish | Medium | Easy | Planned |
| 10 | NotebookEdit (Jupyter cells) | Low | Easy | Planned |

## Done (v1.0)

- [x] OAuth login/logout (PKCE, macOS keychain)
- [x] Token refresh + auto-detect
- [x] SSE streaming with all API events
- [x] Multi-turn agent loop with tool calling
- [x] 8 built-in tools (Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch)
- [x] NDJSON bridge protocol
- [x] Interactive REPL with slash commands
- [x] Session persistence (JSONL)
- [x] MCP server integration
- [x] External tool delegation via NDJSON
- [x] 4 language SDKs (Node.js, Python, Go, Rust)
