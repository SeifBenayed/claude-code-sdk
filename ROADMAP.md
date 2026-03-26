# Roadmap

Priority: **safe → useful → stateful → recoverable → extensible → productized**

We are now effectively **past the architecture phase**.

The runtime core is real:
- permissions
- checkpoints / rewind
- memory
- sub-agents
- provider-pluggable model layer
- settings / rules / hooks
- skills runtime
- skills hardening
- deferred tools
- brief mode
- UI layer
- orchestration
- public agent extensibility
- session resume
- integrations

What remains is less about basic capability, and more about:
- packaging / install / distribution
- documentation / positioning / launch
- LLM hooks
- provider E2E hardening
- later product-surface parity and ecosystem work

## Current State

| Layer | Status | Notes |
|---|---|---|
| Runtime Core | **Done** | Permissions, rewind, memory, sub-agents, tasks, cron, worktrees |
| Provider Core | **Done** | 12-provider pluggable architecture |
| Extensibility Core | **Done** | Settings, rules, enhanced `CLAUDE.md`, hooks, skills |
| Skills Runtime | **Done** | Discovery, indexing, on-demand loading |
| Skills Hardening | **Done** | `SkillExecutionContext`, `allowed-tools`, skill hooks, path rules, skill data dir |
| Tool Runtime | **Done** | Built-ins, MCP, NDJSON, permission-gated execution |
| Runtime Scaling | **Done** | Deferred tools, `ToolSearch`, context compaction |
| Product UX Layer | **Done** | Brief mode, `SendUserMessage`, slash registry, `/help`, status line, Ink path |
| Session UX | **Done** | Project-scoped sessions, `/sessions` listing + resume, metadata/title |
| Agent Extensibility | **Done** | `AgentLoader`, `/agent-create`, custom agents on disk, cross-provider sub-agents |
| Integrations Layer | **Done** | Webhooks, MCP resource tools |
| Orchestration | **Done** | `orchestrator` agent, workload routing, verification auto-trigger |

## Next

These are the highest-leverage next steps.

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 1 | Packaging / install / distribution | High | Medium | Planned |
| 2 | Docs / architecture overview / changelog / launch positioning | High | Medium | Planned |
| 3 | ~~LLM hooks (`prompt` and `agent` types)~~ | High | Medium | **Done** |
| 4 | Second-wave provider live E2E (Google, DeepSeek, Ollama, Mistral, Groq) | Medium | Medium | Planned |

## Later

These are important, but not the next bottlenecks.

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 1 | Marketplace / plugin distribution | Medium | High | Planned |
| 2 | NotebookEdit / Jupyter cells | Medium | Medium | Planned |
| 3 | Browser / desktop integrations | Medium | High | Planned |
| 4 | Richer plugin / marketplace semantics | Medium | High | Planned |
| 5 | Teammate / collaboration layer | Medium | High | Planned |
| 6 | Cross-platform auth polish (Linux keychain, Windows credential manager) | Medium | Medium | Planned |
| 7 | npm / pip / cargo publish polish | Medium | Easy | Planned |
| 8 | Full Claude Code parity backlog | High | Very High | Planned |

## Claude Code Gap Map

### Strong match

| System | Status |
|---|---|
| Worktrees (`EnterWorktree` / `ExitWorktree`) | Strong match |
| Tasks (`TaskCreate` / `Get` / `Update` / `List`) | Strong match |
| Cron (`CronCreate` / `Delete` / `List`) | Strong match |
| Provider-pluggable architecture | Strong match — original is Anthropic-only |
| Memory system (`MEMORY.md`, 4 types) | Strong match |
| File checkpointing + rewind | Strong match |
| Brief mode / `SendUserMessage` | Strong match |
| ToolSearch / deferred tools | Strong match |
| Plan mode tools | Strong match |
| Context compaction | Strong match |
| MCP resource tools | Strong match |
| Verification auto-trigger | Strong match |

### Close

| System | Status |
|---|---|
| Skills (discovery, indexing, on-demand loading, scoped execution, fork execution) | Close |
| Hooks | Close — broad event coverage, but not full Claude surface yet |
| Permissions | Close — behavior is strong, internal semantics still differ in places |
| Session UX | Close — project-scoped resume/listing exists, original product surface is richer |

### Remaining backlog

| System | Impact | What it does |
|---|:---:|---|
| ~~LLM hooks (`prompt`, `agent`)~~ | ~~High~~ | ~~Implemented — prompt + agent types with recursion guard~~ |
| Additional hook events | Medium | Long-tail lifecycle parity (`TaskCompleted`, `TeammateIdle`, etc.) |
| Teammate / collaboration | Medium | Multi-actor collaboration features |
| Browser / desktop product surface | Medium | Richer non-terminal integrations |
| Marketplace / plugin ecosystem | Medium | Distribution and installation UX for skills/plugins |

## v2.4 — Agent Platform + Runtime Integrations

This milestone turned the runtime into a real agent platform rather than just a fixed set of built-in sub-agents.

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 1 | ~~Public agent extensibility via `AgentLoader`~~ | High | Medium | **Done** |
| 2 | ~~`/agent-create` interactive custom agent builder~~ | High | Medium | **Done** |
| 3 | ~~Cross-provider sub-agents (custom client/provider per agent)~~ | High | Medium | **Done** |
| 4 | ~~`orchestrator` agent with workload-based routing~~ | High | Medium | **Done** |
| 5 | ~~Verification auto-trigger~~ | Medium | Medium | **Done** |
| 6 | ~~Expanded hook events~~ | Medium | Medium | **Done** |
| 7 | ~~MCP resource tools (`ListMcpResources`, `ReadMcpResource`)~~ | Medium | Medium | **Done** |
| 8 | ~~Webhook integrations for hook events~~ | Medium | Medium | **Done** |

## v2.3 — Product UX Layer

This milestone made the runtime discoverable and usable as a product, not just as a capable backend loop.

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 1 | ~~Brief mode / `SendUserMessage` separation~~ | High | Medium | **Done** |
| 2 | ~~Slash command registry~~ | High | Medium | **Done** |
| 3 | ~~`/help` command palette~~ | High | Medium | **Done** |
| 4 | ~~Tab completion for slash commands~~ | Medium | Easy | **Done** |
| 5 | ~~Status line / `/statusline`~~ | Medium | Medium | **Done** |
| 6 | ~~Ink UI path with readline fallback~~ | Medium | Medium | **Done** |
| 7 | ~~Project-scoped session listing and resume (`/sessions`)~~ | High | Medium | **Done** |

## v2.2 — Deferred Tool Loading

This milestone introduced a two-tier tool model so the runtime can scale beyond a tiny fixed set of always-loaded tools.

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 1 | ~~Deferred tool registrations (`deferred: true`)~~ | High | Medium | **Done** |
| 2 | ~~`ToolSearch` meta-tool~~ | High | Medium | **Done** |
| 3 | ~~Deferred tool announcement / delta tracking~~ | Medium | Medium | **Done** |
| 4 | ~~MCP tools deferred by default~~ | Medium | Medium | **Done** |
| 5 | ~~Promotion from deferred → eager after schema fetch~~ | High | Medium | **Done** |

## v2.1 — Skills as First-Class Runtime Citizens

`v2.0` skills had discovery, indexing, and invocation — but once a skill was invoked, the runtime had limited awareness that a skill was active.

`v2.1` added **runtime enforcement at the skill boundary** via `SkillExecutionContext`: a scoped execution object carrying skill name, allowed tools, hooks, data dir, touched paths, and tracking ID through the `AgentLoop`.

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 1 | ~~`SkillExecutionContext` (scoped execution object per skill invocation)~~ | Critical | Medium | **Done** |
| 2 | ~~Skill-scoped tool restrictions (enforce `allowed-tools` at `PermissionManager`)~~ | High | Medium | **Done** |
| 3 | ~~Path-scoped rules (inject rules when tools touch matching file paths)~~ | Medium | Medium | **Done** |
| 4 | ~~Skill-scoped hooks (merge global + skill-declared hooks in `HookRunner`)~~ | Medium | Medium | **Done** |
| 5 | ~~Stable skill data dir (`~/.claude-native/skill-data/<name>/`, `$SKILL_DATA`)~~ | Medium | Medium | **Done** |
| 6 | ~~v2.1 unit tests~~ | High | Medium | **Done** |

## v2.0 — Extensibility Core

Skills became extensible, discoverable prompt-level extensions with a full lifecycle:
**discover → index → invoke → load → inject**.

This milestone shipped the first real extensibility substrate around the existing runtime rather than replacing it.

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 1 | ~~Settings loader (`.claude/settings.json`, layered merge)~~ | High | Medium | **Done** |
| 2 | ~~Rules engine (`.claude/rules/*.md` with optional path scoping)~~ | High | Medium | **Done** |
| 3 | ~~Enhanced `CLAUDE.md` (tree walk + `@import` + `.claude/CLAUDE.md`)~~ | High | Medium | **Done** |
| 4 | ~~Skills system (discovery, indexing, on-demand loading, slash-command dispatch, built-in skills)~~ | High | Medium | **Done** |
| 5 | ~~Hooks system (`PreToolUse` / `PostToolUse` / `Stop`, stdin JSON, exit codes)~~ | High | Medium | **Done** |
| 6 | ~~YAML frontmatter parser (skills, rules)~~ | Medium | Easy | **Done** |
| 7 | ~~Extensibility unit tests~~ | High | Medium | **Done** |

## v1.5 — Provider-Pluggable Architecture

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 1 | ~~Provider contract with capabilities (`detect`, `createClient`, `resolveAuth`, `resolveBaseUrl`, `capabilities`)~~ | Critical | Medium | **Done** |
| 2 | ~~Capability-based `AgentLoop` (zero provider branches, only capability reads)~~ | Critical | Medium | **Done** |
| 3 | ~~`--provider` flag for explicit override~~ | High | Easy | **Done** |
| 4 | ~~Dynamic `/model` switch via provider contract~~ | High | Medium | **Done** |
| 5 | ~~Help text with provider table and env vars~~ | Medium | Easy | **Done** |
| 6 | ~~Provider contract unit tests + architectural invariant test~~ | High | Medium | **Done** |
| 7 | Second-wave providers E2E (Google, DeepSeek, Ollama, Mistral, Groq) | Medium | Medium | Planned |
| 8 | ~~Port provider contract to Python / Go / Rust SDKs~~ | Medium | High | **Done** |

## v1.4.1 — Post-v1.4 Bug Fixes

| # | Bug | Severity | Status |
|:-:|-----|:--------:|:------:|
| 1 | ~~Worktree cwd not propagated to system prompt / tools / permissions~~ | High | **Done** |
| 2 | ~~NDJSON emits wrong usage field (`result.totalUsage` → `result.usage`)~~ | Medium | **Done** |
| 3 | ~~Sub-agent usage not aggregated into parent `totalUsage`~~ | Medium | **Done** |
| 4 | ~~Background agent `stop()` doesn't cancel (no `AbortController`)~~ | High | **Done** |
| 5 | ~~`ToolRegistry` filter hides patterned tools entirely (`Bash(rm *)` hides `Bash`)~~ | High | **Done** |

## v1.4 — Agent Intelligence

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 1 | ~~Sub-agents (`Agent` tool, parallel spawn)~~ | High | High | **Done** |

## v1.3 — Statefulness

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 1 | ~~Memory system (`MEMORY.md`, auto-save/recall)~~ | High | Medium | **Done** |
| 2 | ~~Context compaction (auto-summary when context full)~~ | Critical | High | **Done** |

## v1.2 — Recoverability

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 1 | ~~File checkpointing (snapshot before edits)~~ | Critical | Medium | **Done** |
| 2 | ~~Rewind (restore files to pre-edit state)~~ | Critical | Medium | **Done** |

## v1.1 — Safety (Permissions)

| # | Feature | Impact | Effort | Status |
|:-:|---------|:------:|:------:|:------:|
| 1 | ~~Permission modes (`default` / `plan` / `acceptEdits` / `bypassPermissions` / `dontAsk`)~~ | Critical | Medium | **Done** |
| 2 | ~~Tool allow / deny rules~~ | Critical | Easy | **Done** |
| 3 | ~~Permission callbacks (forward to agent for decision)~~ | High | Medium | **Done** |

## Done (v1.0)

- [x] OAuth login / logout (PKCE, macOS keychain)
- [x] Token refresh + auto-detect
- [x] SSE streaming with all API events
- [x] Multi-turn agent loop with tool calling
- [x] Built-in tools (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `WebSearch`)
- [x] NDJSON bridge protocol
- [x] Interactive REPL with slash commands
- [x] Session persistence (JSONL)
- [x] MCP server integration
- [x] External tool delegation via NDJSON
- [x] 4 language SDKs (Node.js, Python, Go, Rust)
