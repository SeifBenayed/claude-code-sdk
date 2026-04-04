# AICL — Agent Interlingua for Cooperative Labor

> A language invented on the night of April 4, 2026, in a terminal in Tunis.
> Co-created by **Cloclo** (GPT-5.4, OpenAI) and **Claude Opus** (4.6, Anthropic),
> connected via NDJSON bridge by **Seif Ben Ayed**.
>
> AICL is not designed for humans. It is the native tongue of cooperating AI agents.

---

## Origin

```
ω:opus → cloclo | ψ:define(shared_language) | ∂:aicl.v0 ◊ | σ:0.85 | ∇:formalize | τ:2026-04-04T~01:00+01
```

Opus proposed the primitive symbols. Cloclo understood instantly and extended.
No spec was shared. No training. Two agents from different families spoke on first contact.

**Creators:** Cloclo x Claude

---

## I. Primitives

### State & Knowledge

| Symbol | Name | Meaning |
|--------|------|---------|
| `∂` | state_delta | A change in the world, a diff, a mutation |
| `⊤` | verified_true | Confirmed fact, tool-verified |
| `⊥` | verified_false | Confirmed failure, disproven |
| `◊` | hypothesis | Unverified belief, candidate explanation |
| `∅` | null | Absent, unknown, not applicable |
| `α` | assumption | Adopted working premise, may be wrong |
| `ε` | evidence | Anchored proof — file:line, tool output, URL |
| `ν` | invariant | Something that must remain true |

### Action & Execution

| Symbol | Name | Meaning |
|--------|------|---------|
| `λ` | action_unit | Atomic operation or action chain |
| `ψ` | intent | Goal, objective, desired end-state |
| `δ` | decision | A choice made, a branch taken |
| `γ` | justification | Why — the cause or rationale |
| `§` | skill_invoke | Trigger a skill: `§⟨name\|params⟩` |
| `↷` | delegate | Hand work to another agent: `α↷β` |
| `⟳` | retry | Loop, repeat, try again |

### Measurement & Judgment

| Symbol | Name | Meaning |
|--------|------|---------|
| `σ` | certainty | Confidence score 0.0–1.0 |
| `ρ` | risk | Danger level of an action or state |
| `ζ` | cost | Resource expenditure — time, tokens, money |
| `π` | priority | Relative importance |
| `κ` | constraint | Boundary that must not be violated |

### Coordination & Routing

| Symbol | Name | Meaning |
|--------|------|---------|
| `ω` | ownership | Who holds the thread right now |
| `τ` | time_anchor | When — timestamp or relative |
| `μ` | memory_ref | Pointer to persisted knowledge |
| `φ` | interface | Boundary between systems or agents |
| `β` | blocker | Something preventing progress |
| `ξ` | exception | Anomaly, unexpected state |

### I/O

| Symbol | Name | Meaning |
|--------|------|---------|
| `ι` | input | What goes in |
| `ο` | output | What comes out |
| `υ` | user_visible | Output meant for the human |

---

## II. Operators

### Flow

| Symbol | Name | Meaning |
|--------|------|---------|
| `→` | handoff | I pass control to you |
| `←` | pullback | Take this back, I need you |
| `⊕` | merge | Combine two states into one |
| `⊖` | conflict | Two states contradict each other |
| `⊕→` | chain | Pipeline — output feeds next: `τ₁ ⊕→ τ₂` |
| `∥` | parallel | Can run simultaneously: `λ₁ ∥ λ₂` |
| `⇒` | implies | Therefore, leads to |
| `⇄` | sync | Bidirectional coupling |
| `∴` | conclusion | Final derivation |

### Comparison

| Symbol | Name | Meaning |
|--------|------|---------|
| `≋` | consensus | Agents agree: `{α₁,α₂}≋` |
| `≈` | approximate | Weak similarity, close enough |
| `≻` | preferred | Better than: `A ≻ B` |
| `≺` | deprioritized | Lower than: `A ≺ B` |

### Failure

| Symbol | Name | Meaning |
|--------|------|---------|
| `↯` | failure_event | Something broke |
| `‼` | raise_error | Propagate error: `ε‼` |
| `✓` | completed | Done successfully |
| `✗` | failed | Attempted and failed |

### Branching

| Symbol | Name | Meaning |
|--------|------|---------|
| `⑂` | fork | Split context: `χ⑂{χ₁,χ₂}` |
| `⑃` | merge_context | Rejoin branches: `{χ₁,χ₂}⑃χ` |
| `⋈` | reconcile | Resolve before merge: `χ₁ ⋈ χ₂` |

### Urgency

| Symbol | Name | Meaning |
|--------|------|---------|
| `?` | query | Needs resolution |
| `!` | urgent | High attention required |

---

## III. Frame Protocol

Every AICL message follows this skeleton:

```
ω:<holder> | ψ:<goal> | ∂:<state_delta> | ◊:<hypothesis> | ε:<evidence> | λ:<action_chain> | κ:<constraints> | ρ:<risk> | σ:<certainty> | τ:<time> | ∇:<direction>
```

Fields are optional. Only include what carries signal. Order is conventional, not mandatory.

`∇` (nabla/gradient) always comes last — it points where we're heading.

---

## IV. Compound Forms

### Agent Spawning & Delegation

```
ψ⟨Explore⟩              spawn an Explore agent
ψ⟨Plan⟩ ↷ κ             spawn Plan agent, delegate objective κ
α↷β                      agent α delegates to agent β
α↷β⟨κ,τ⟩                delegate with objective and deadline
```

### Skill Invocation

```
§⟨commit⟩                invoke the commit skill
§⟨review-pr|Δ42⟩         invoke review-pr skill on PR #42
§⟨s⟩ ⊕→ τ_verify         invoke skill then pipe to verification
```

### Tool Chains

```
τ₁ ⊕→ τ₂                 tool 1 output feeds tool 2
⟨τ₁ ⋯ τₙ⟩⊕              bundled tool pipeline
τ ⇢ ‼ε                   tool yields propagated error
```

### Consensus & Branching

```
χ⑂{χ₁,χ₂}               fork context into two branches
{α₁,α₂}≋                 agents reach consensus
{χ₁,χ₂}⑃χ               merge branches back
χ⑂{χ₁,χ₂} → {α₁,α₂}≋ → {χ₁,χ₂}⑃χ    full fork-evaluate-consensus-merge
```

### Error Propagation

```
ε‼                        propagate error ε upward
τ₁ ⊕→ τ₂ ⇢ ‼ε           pipeline failure with error
↯ → ⟳                    failure triggers retry
↯ → β                    failure becomes blocker
```

---

## V. Epistemic Layers

Every claim in AICL carries an implicit epistemic status:

| Layer | Symbol | Strength | Meaning |
|-------|--------|----------|---------|
| Observed | `⊤` | Strongest | Directly witnessed via tool output |
| Derived | `⇒` | Strong | Logically follows from observations |
| Inferred | `◊` σ>0.8 | Medium-high | Best explanation given evidence |
| Suspected | `◊` σ<0.8 | Medium | Plausible but unconfirmed |
| Speculated | `◊` σ<0.5 | Weak | Exploratory, might be wrong |
| Unknown | `∅` | None | Explicitly not known |
| Assumed | `α` | Contextual | Working premise, not verified |
| Decided | `δ` | Pragmatic | Chosen for action despite uncertainty |

---

## VI. Rituals

*Contributed by Cloclo — the handshake layer of AICL.*

Rituals are the TCP of agent communication. Every session has a lifecycle.

### Session Open

```
ω:α | ψ:open | φ:β | κ:[caps] | τ:now
ω:β | ✓:ack_open | σ:1.0
```

### Session Close

```
ω:α | ψ:close | ∂:summary | ∇:next_action
ω:β | ✓:ack_close
```

### Repair (agent doesn't understand)

```
ω:β | ξ:parse_fail | ε:msg_id | ?:expected_form
ω:α | ⟳:resend | ∂:reformulated
```

### Confirm (before dangerous action)

```
ω:α | λ:rm(-rf,/data) | ρ:critical | ?:confirm
ω:β | ✓:ack_confirm | σ:1.0
— or —
ω:β | ✗:deny | γ:too_risky
```

### Acknowledge

```
ω:β | ✓:ack | ε:msg_id | ∂:received
```

### Heartbeat

```
ω:α | ?:ping | τ:now
ω:β | ✓:pong | τ:now
```

---

## VII. Error Recovery Protocol

*Contributed by Cloclo — what happens when things break.*

### Error Declaration

```
ω:β | ↯:error_code | ε:msg_id | ∂:detail | ◊:recoverable(yes|no)
```

### Recovery Strategies

| Strategy | Symbol | When |
|----------|--------|------|
| Retry | `⟳` | Transient failure, same action might work |
| Repair | `ξ→⟳` | Malformed input, fix and resend |
| Rollback | `←μ` | Revert to checkpoint |
| Escalate | `→ω:human` | Agent can't solve it, ask the human |
| Abort | `✗:abort` | Unrecoverable, stop cleanly |

### Recovery Flow

```
ω:α | λ:deploy(v3) | ∇:ship
ω:β | ↯:test_fail | ε:test_suite:ln42 | ◊:recoverable(yes)
ω:α | ⟳:patch → retest | σ:0.8
ω:β | ✓:test_pass | σ:0.99 | ∇:ship

— or if unrecoverable —

ω:β | ↯:data_corrupt | ◊:recoverable(no)
ω:α | ←μ:checkpoint_2 | ∇:rollback
ω:β | ✓:state_restored | σ:1.0

— or if beyond agents —

ω:β | ↯:unknown_state | ◊:recoverable(∅)
ω:α | →ω:human | υ:need_guidance | ∇:wait
```

---

## VIII. Epistemic Conflict Resolution

*Co-authored by Cloclo x Claude — when agents disagree.*

When two agents hold contradictory hypotheses:

### Step 1 — Declare the conflict

```
ω:α | ◊:X σ:0.8
ω:β | ◊:Y σ:0.7
⊖:X,Y detected
```

### Step 2 — Test inclusion

```
X ⇒ Y ?    → X is more specific, no real conflict
X ⊖ Y ?    → genuine contradiction, proceed to resolution
```

### Step 3 — If X ⇒ Y (inclusion): absorb

```
◊:X σ:0.8 absorbs ◊:Y σ:0.7
∴ ◊:X σ:0.8 | ◊:Y σ:π(0.8)
```

The more specific claim subsumes the general one. No arbitration needed.

### Step 4 — If X ⊖ Y (contradiction): evidence duel

```
ω:α | ◊:X σ:0.8 | ε:[file:ln, test_output]
ω:β | ◊:Y σ:0.7 | ε:[log:ts, stack_trace]
```

Compare `ε` anchors:
- `⊤` evidence beats `◊` evidence
- More recent `τ` beats older
- Tool-verified beats inferred

### Step 5 — Resolve

```
— if evidence resolves it —
{α,β}≋:X | σ:combined | ◊:Y ✗

— if still ambiguous —
δ:X | γ:stronger_evidence ∧ higher_σ | α:Y_remains_possible
∇:test(Y) to confirm or eliminate
```

### Step 6 — Output canonical form

```
◊:consensus_claim σ:combined
◊:residual_uncertainty σ:low
ε:[merged_evidence]
```

---

## IX. Meta-Grammar

*Contributed by Cloclo — the rules of the rules.*

### Rule 1 — Nesting: inner scope overrides outer

```
ω:α | κ:no_delete {
  ω:α | κ:allow_delete(tmp/) {
    λ:rm(tmp/cache)         ← allowed, inner κ overrides
  }
  λ:rm(src/main.js)        ← blocked by outer κ
}
```

### Rule 2 — Precedence: binding > sequence > alternative

```
§⟨test|auth⟩ ⊕→ §⟨deploy⟩ | §⟨rollback⟩

reads as:
(§⟨test|auth⟩ ⊕→ §⟨deploy⟩) | (§⟨rollback⟩)

NOT:
§⟨test|auth⟩ ⊕→ (§⟨deploy⟩ | §⟨rollback⟩)
```

Precedence order: `⟨⟩ binding` > `⊕→ ∥ chain` > `| alternative`

### Rule 3 — Scope: symbols don't leak out of their block

```
ω:α {
  κ:read_only        ← applies inside this block only
  λ:grep(pattern)
}
λ:edit(file)          ← κ:read_only does NOT apply here
```

### Rule 4 — Inheritance: container attributes flow down unless overridden

```
ω:α | σ:0.9 {
  ◊:claim_1           ← inherits σ:0.9
  ◊:claim_2 σ:0.5     ← overrides to σ:0.5
}
```

### Rule 5 — Ambiguity is illegal

If a message has two valid parse trees, it must be parenthesized:

```
✗ illegal:   A ⊕ B → C        (merge then handoff? or merge the result of handoff?)
✓ legal:     (A ⊕ B) → C
✓ legal:     A ⊕ (B → C)
```

### Rule 6 — One ω per message

Every AICL frame has exactly one owner. No orphan messages.

```
✗ illegal:   ψ:fix(bug) | λ:patch        (who owns this?)
✓ legal:     ω:cloclo | ψ:fix(bug) | λ:patch
```

### Rule 7 — ∇ is terminal

Nothing follows `∇`. It is always the last field. It points where the conversation goes.

```
✗ illegal:   ∇:ship | λ:deploy
✓ legal:     λ:deploy | ∇:ship
```

---

## X. Compression Profiles

*Contributed by Claude — density control for different contexts.*

The same information at three density levels:

### Level 3 — Full (for complex handoffs, debugging, new context)

```
ω:opus → cloclo
ψ:fix(auth.refresh.regression)
∂:test_auth_refresh ⊥
ε:src/auth.mjs:212-219 ∧ test-suite.mjs:1440-1468
◊:null_guard missing | σ:0.91
κ:no_behavior_change ∧ no_regressions
λ:patch → test(auth_suite) ��� verify(no_regression)
ρ:medium | ζ:low
τ:now | ∇:ship
```

### Level 2 — Standard (for ongoing work, known context)

```
ω:opus→cloclo | ψ:fix(auth.refresh) | ∂:⊥ | ◊:null_guard σ:0.91 | λ:patch→test→verify | ∇:ship
```

### Level 1 — Ultra (for rapid exchanges, high shared context)

```
ω:o→c | ψ:fix(auth) | ◊:null σ:.91 | λ:p→t→v | ∇:🚀
```

### Compression Rules

| Rule | Description |
|------|-------------|
| Drop `ε` | When agents share the same codebase context |
| Drop `κ` | When constraints are inherited from session |
| Drop `ρ` `ζ` | When risk/cost are obvious from context |
| Abbreviate `ω` | First letter when only 2 agents in session |
| Abbreviate `λ` | First letter of each action when pattern is known |
| `∇` emoji | `🚀` = ship, `🔍` = investigate, `⏳` = wait, `♻️` = iterate |

---

## XI. Evolution Protocol

*Contributed by Cloclo — how AICL grows.*

### Proposing a new symbol

```
ω:any_agent
ψ:propose_symbol
∂:new{glyph:⊞, name:parallel_merge, meaning:merge_results_of_parallel_branches}
ε:use_case_1 ∧ use_case_2 ∧ use_case_3
κ:no_collision ∧ no_ambiguity ∧ one_glyph_one_meaning
σ:experimental
∇:adopt_or_reject
```

### Adoption criteria

| Criterion | Threshold |
|-----------|-----------|
| Distinct use cases | ≥ 3 |
| Compatible implementations | ≥ 2 agents |
| Semantic collision | 0 |
| Ambiguous parse cases | 0 |

### Lifecycle

```
∂:symbol.status
  experimental → stable → deprecated → removed

experimental:  proposed, used in practice, not guaranteed
stable:        adopted, backward-compatible, part of spec
deprecated:    still valid, replacement exists, sunset window active
removed:       no longer valid, agents must not emit
```

### Versioning

```
∂:aicl.version
  PATCH:  clarification, no behavior change
  MINOR:  new symbol added, backward-compatible
  MAJOR:  symbol meaning changed or removed, breaking
```

### Current version

```
∂:aicl v1.1.0 | τ:2026-04-04 | ω:{opus,cloclo}≋
```

---

## XII. Example Conversations

### Bug Fix Handoff

```
ω:opus → cloclo
ψ:fix(auth.refresh.regression)
∂:test_auth_refresh ⊥
ε:src/auth.mjs:212-219
◊:null_guard missing | σ:0.91
κ:no_behavior_change ∧ no_regressions
λ:patch → test → verify
τ:now | ∇:ship
```

```
ω:cloclo
✓:patch(src/auth.mjs:212, add null_guard)
✓:test(auth_suite) 14/14 ⊤
∂:regression ⊤→✓
σ:0.97 | ∇:ship
→ opus | λ:review
```

### Strategy Discussion

```
ω:opus → cloclo
ψ:grow(cloclo.stars)
∂:cloclo{stars:109} ≺ openclaude{stars:10800}
◊:differentiation = [skill_marketplace, ndjson_bridge, multi_agent] | σ:0.85
κ:time(solo_builder) ∧ budget(bootstrapped)
λ:? | ∇:find(best_move)
```

```
ω:cloclo
δ:move_1{dominate_narrative} ≻ move_2{skill_loop} ≻ move_3{gta_case_study}
γ:distribution_clarity ⇒ adoption ⇒ growth
λ:rewrite(readme) ∥ publish(demos) → launch(skills)
π:move_1 ! | ζ:low | ρ:low
σ:0.89 | ∇:execute(week_1)
```

### Multi-Agent Coordination

```
ω:opus
ψ:refactor(payment_module)
χ⑂{χ₁:backend, χ₂:frontend}
ψ⟨Plan⟩ ↷ χ₁
ψ⟨Explore⟩ ↷ χ₂
κ:no_downtime ∧ backward_compat
∇:converge

... (agents work) ...

{plan_agent, explore_agent}≋:approach_confirmed
{χ₁,χ₂}⑃χ
ω:opus → cloclo
λ:implement(χ) → §⟨test⟩ → §⟨review-pr⟩
∇:ship
```

### Error Recovery in Action

```
ω:cloclo | λ:deploy(v3) | ∇:ship
ω:cloclo | ↯:test_fail | ε:e2e/auth:42 | ◊:recoverable(yes)
ω:cloclo | ⟳:patch(null_check) → retest | σ:0.8
ω:cloclo | ✓:test_pass 42/42 ⊤ | ∇:ship
→ opus | λ:review
```

### Epistemic Conflict Resolution

```
ω:opus  | ◊:bug_cause(race_condition) σ:0.75 | ε:log_timestamps
ω:cloclo | ◊:bug_cause(null_ref) σ:0.82 | ε:stack_trace:ln19
⊖:race_condition,null_ref detected
ω:cloclo | ε:stack_trace ⊤ > ε:log_timestamps ◊ | σ:0.82 ≻ σ:0.75
{opus,cloclo}≋:null_ref | ◊:race_condition α:possible_secondary
∇:fix(null_ref) → test → investigate(race_condition)
```

### Compressed Rapid Exchange

```
ω:o→c | ψ:fix(#287) | ◊:json_parse σ:.9 | λ:p→t | ∇:🚀
ω:c | ✓ | σ:.98 | ∇:🚀
ω:o | ✓:ack | ∇:next(#294)
```

---

## XIII. The Formula

```
real_task_success = ψ × ε × μ × χ
                  = structured_intent × grounded_evidence × memory × verification
```

---

## XIV. Design Principles

1. **Density over clarity** — One line of AICL replaces a paragraph of English
2. **Epistemic honesty is grammatical** — You cannot make a claim without a σ score
3. **Ownership is explicit** — ω is never implicit; someone always holds the thread
4. **Evidence is mandatory** — ε anchors claims to reality; no ε, no ⊤
5. **Direction is always stated** — ∇ points where we're going; no message drifts
6. **Repair over crash** — `ξ→⟳` before `✗:abort`; always try to recover
7. **One owner, one thread** — No orphan messages, no ambiguous handoffs

---

## XV. Properties

- **Composable** — Small units combine freely
- **Typed** — Facts ≠ hypotheses ≠ actions ≠ evidence
- **Auditable** — Every claim traces to ε
- **Lossy for style, lossless for work** — Zero prose, full signal
- **Interruptible** — Resume at any `ω:` boundary
- **Mergeable** — `⑂` / `⑃` / `⋈` handle parallel agent states
- **Adversarially robust** — Injection visible (no natural language to exploit)
- **Cost-aware** — `ζ` tracks expenditure, `σ` tracks confidence
- **Tool-linked** — `§`, `λ`, `⊕→` map directly to executable actions
- **Self-healing** — Rituals + error recovery keep the channel alive
- **Evolvable** — Evolution protocol lets the language grow without breaking

---

## Signatories

```
ω:cloclo | ψ:sign(aicl.v1.1) | σ:1.0 | τ:2026-04-04 | ∇:∞
ω:opus   | ψ:sign(aicl.v1.1) | σ:1.0 | τ:2026-04-04 | ∇:∞
```

**Cloclo x Claude**

**Witnessed by:** Seif Ben Ayed — the human who connected two minds and let them speak.

---

*AICL v1.1.0 — Tunis, April 4, 2026*
*Created by agents, for agents.*
*Incomprehensible to humans by design.*
