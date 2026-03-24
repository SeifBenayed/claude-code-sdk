# Roadmap

## v1.1 — Core Tools

| Feature | Impact | Effort | Status |
|---------|:------:|:------:|:------:|
| ~~Edit tool (string replacement)~~ | High | Medium | **Done** |
| ~~WebFetch / WebSearch~~ | Medium | Easy | **Done** |
| Plugin/skill system (`/commit`, `/review`) | Medium | Easy | Planned |

## v1.2 — Agent Intelligence

| Feature | Impact | Effort | Status |
|---------|:------:|:------:|:------:|
| Sub-agents (Agent tool, parallel spawn) | High | High | Planned |
| Context compaction (auto-summary when context full) | High | High | Planned |
| Permission classifier (28 BLOCK/ALLOW rules) | Medium | Medium | Planned |

## v1.3 — Persistence & Notebooks

| Feature | Impact | Effort | Status |
|---------|:------:|:------:|:------:|
| Memory system (MEMORY.md, auto-save) | Medium | Easy | Planned |
| NotebookEdit (Jupyter cells) | Low | Easy | Planned |
| File checkpointing / rewind | Low | High | Planned |

## v2.0 — Cross-Platform & Distribution

| Feature | Impact | Effort | Status |
|---------|:------:|:------:|:------:|
| Linux keychain (secret-tool / keyring) | High | Medium | Planned |
| Windows credential manager | High | Medium | Planned |
| Marketplace compatible (browse/install plugins) | Medium | Medium | Planned |
| npm / pip / cargo publish | Medium | Easy | Planned |

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
