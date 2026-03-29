# World Models — Vision & Research

## What Are World Models?

A LLM predicts the next **word**. A world model predicts the next **state of the physical world**.

```
LLM:          "the cat is on" → "the table"
World Model:  [image + "push the cup"] → [image of the cup falling]
```

World models learn physics, spatial reasoning, object permanence, and cause-effect from video and simulation data. They approximate the transition function `P(s_{t+1} | s_t, a_t)` — given the current state and an action, predict the next state.

---

## APIs Available Today

| Provider | API | Input → Output | Pricing |
|----------|-----|-----------------|---------|
| **NVIDIA Cosmos** | `build.nvidia.com` NIM API | video + prompt → predicted video | Free tier available |
| **Google Gemini Robotics-ER** | `gemini-robotics-er-1.5-preview` | images + instruction → trajectory/actions | $0.30-2.50/1M tokens |
| **World Labs** | `platform.worldlabs.ai` | text/image → persistent 3D world | $20-95/mo |

### NVIDIA Cosmos

- **Cosmos Predict 2.5** — 2B-14B params, predicts future video frames
- **Cosmos Policy** (Jan 2026) — VLA model, robot actions encoded as latent frames, 98.5% on LIBERO benchmark
- **Cosmos Reason 2** (Feb 2026) — enhanced physics reasoning
- Three modes: Text2World, Image2World, Video2World
- Open source: https://github.com/nvidia-cosmos

### Google Gemini Robotics

- Model ID: `gemini-robotics-er-1.5-preview`
- Available now via Google AI Studio and Gemini API
- Input: camera images + natural language → outputs action plans (coordinates, trajectories, grasp poses)
- Uses function calling to interface with robot controllers
- Paper: https://arxiv.org/abs/2503.20020

### World Labs (Fei-Fei Li)

- **Marble** (Nov 2025) — generates persistent, editable 3D environments from text/images
- **World API** (Jan 2026) — programmatic access at platform.worldlabs.ai
- $1B raised Feb 2026 (a16z, NVIDIA, AMD, Autodesk)
- 3D world generation, not robot control — useful for simulation environments and digital twins

---

## Open Source Models (Run Locally)

| Model | Params | What It Does | License | GPU Req |
|-------|--------|--------------|---------|---------|
| **NVIDIA Cosmos Predict 2.5** | 2B-14B | Predicts next video frames | NVIDIA Open | Varies |
| **Physical Intelligence pi0.5** | ~3B | Controls robots directly (VLA) | Apache 2.0 | >8GB (inference), >70GB (full train) |
| **Meta V-JEPA 2** | — | Predicts in latent space (physics understanding) | CC-BY-NC | — |
| **LeRobot** (HuggingFace) | Varies | Full robot learning framework | Apache 2.0 | Varies |
| **DreamerV3** | — | World model for RL from pixels | MIT | — |

### Physical Intelligence pi0

- Flow-matching VLA: camera images + language + joint state → action chunks
- Trained on 7 robot configurations, 68 tasks, 10k+ hours
- Open weights: https://github.com/Physical-Intelligence/openpi
- Supports: ALOHA (bimanual), DROID (Franka), UR5, LIBERO

### LeRobot (Hugging Face)

- v0.4.0 — full robot learning framework with CLI
- Policies: ACT, Diffusion Policy, VQ-BeT, pi0Fast, GR00T N1.5, SmolVLA
- Robots: SO100, Koch, Unitree G1, and more
- CLI: `lerobot-train`, `lerobot-eval`, `lerobot-info`
- https://github.com/huggingface/lerobot

---

## Major Players (2026)

| Player | Model | Open Source? | Focus |
|--------|-------|-------------|-------|
| NVIDIA | Cosmos (2B-14B) | Yes | Full stack: GPU + simulation + world model |
| Google DeepMind | Gemini Robotics, Genie 2 | API only | VLA + spatial reasoning |
| Meta (FAIR) | V-JEPA 2, LeWorldModel | Yes | Latent prediction (LeCun thesis) |
| Physical Intelligence | pi0, pi0.5 | Yes (Apache 2.0) | Embodiment-agnostic VLA |
| Tesla | Optimus world model | No | Driving + humanoid |
| World Labs (Fei-Fei Li) | Marble / World API | No (API access) | 3D world generation |
| 1X Technologies | NEO world model | No | Humanoid learns from video |
| AMI Labs (Yann LeCun) | — | TBD | $1.03B raised Mar 2026 |
| Skild AI | General robot brain | No | $300M raised |

---

## The Emerging Architecture

```
Natural language (user intent)
    → LLM (planning, reasoning)
        → World Foundation Model (physics prediction, validation)
            → VLA (action generation, robot-agnostic)
                → Robot adapter (ROS 2 / proprietary SDK)
                    → Physical robot
```

Three distinct layers:
1. **LLMs** — language, reasoning, planning (text-based)
2. **World Foundation Models** — physics, spatial understanding, future prediction (video/3D)
3. **VLAs** — vision-language-action, direct motor control

---

## The Gap: Orchestration

Nobody has built a clean CLI that orchestrates model selection, policy serving, and robot communication in a unified interface.

- **LeRobot** — training-focused, not orchestration
- **ROS 2** — communication bus, no AI integration
- **OpenPI** — policy server, no multi-model orchestration
- **Isaac** — NVIDIA-only, not provider-agnostic

---

## Cloclo Vision: From Code to Robots

### Today — Code Agent
```bash
cloclo -m claude-sonnet -p "fix the bug"
cloclo -m ollama/llama3 -p "add a test"
```

### Tomorrow — Robot Agent
```bash
cloclo -m nvidia/cosmos-policy -p "pick up the red cup" --robot aloha
cloclo -m pi0.5 -p "stack the blocks" --robot ur5
cloclo -m gemini-robotics -p "navigate to kitchen" --robot neo
```

Same CLI. Same loop. Provider-agnostic on models AND robot-agnostic on hardware.

### Tool Loop Mapping

| Code Agent | Robot Agent | Description |
|------------|-------------|-------------|
| `Read` | `Observe` | Read file / capture camera + sensors |
| `Bash` | `Act` | Execute command / execute physical action |
| `Edit` | `Manipulate` | Modify file / grasp, place, move objects |
| `Grep` | `Perceive` | Search code / detect objects, segment scene |
| `Write` | `Navigate` | Create file / move robot base to location |
| `Glob` | `Scan` | Find files by pattern / scan environment |

### Provider Interface

```javascript
// LLM provider (today)
const llm = new AnthropicClient({ apiKey, apiUrl });
const response = await llm.stream(messages, tools);

// World model provider (tomorrow)
const wm = new CosmosClient({ apiKey, apiUrl });
const prediction = await wm.predict(state, action, horizon);

// VLA provider (tomorrow)
const vla = new Pi0Client({ endpoint });
const actions = await vla.infer(observation, prompt);

// Same pattern. Same abstraction.
```

---

## Market Signal

- **$2B+** invested in world models in Q1 2026 alone
- **AMI Labs** (Yann LeCun): $1.03B raised March 2026
- **World Labs** (Fei-Fei Li): $1B raised February 2026
- **Physical Intelligence**: $400M+
- **Unitree**: 5,500+ humanoid robots sold in 2025 ($16k-$90k)
- **1X NEO**: $20,000, pre-orders open, shipping 2026

---

## Roadmap

### Phase 1 — World Model as Reasoning Provider
- Add NVIDIA Cosmos API as provider (video prediction)
- Add Gemini Robotics-ER API (spatial reasoning + action planning)
- Interface: send scene + prompt → get predicted future / action plan
- Use case: reason about physical scenarios without controlling a robot

### Phase 2 — Robot-Agnostic Execution
- Bridge to ROS 2 for real robot communication
- Standardize `WorldModelProvider` interface: `predict(state, action) → next_state`
- Support pi0/LeRobot policy servers via WebSocket
- Embodiment configuration (URDF, action space definitions)

### Phase 3 — Full Loop
- Real-time streaming for closed-loop control
- Multi-modal state management (vision + proprioception + tactile)
- Safety constraints and sim-to-real validation
- Edge deployment for latency-critical control (100Hz+)

---

## Key References

### Papers
- Ha & Schmidhuber, "World Models" (2018) — https://arxiv.org/abs/1803.10122
- Hafner et al., "DreamerV3" (2023) — https://arxiv.org/abs/2301.04104
- Bardes et al., "V-JEPA" (2024) — https://arxiv.org/abs/2404.16930
- Bruce et al., "Genie" (2024) — https://arxiv.org/abs/2402.15391
- Brohan et al., "RT-2" (2023) — https://arxiv.org/abs/2307.15818
- Black et al., "pi-zero" (2024) — Physical Intelligence
- NVIDIA, "Cosmos World Foundation Model" (2025) — https://arxiv.org/abs/2501.03575
- Google DeepMind, "Gemini Robotics" (2025) — https://arxiv.org/abs/2503.20020
- Hu et al., "GAIA-1" (Wayve, 2023) — https://arxiv.org/abs/2309.17080

### Repos
- NVIDIA Cosmos — https://github.com/nvidia-cosmos
- Physical Intelligence OpenPI — https://github.com/Physical-Intelligence/openpi
- LeRobot — https://github.com/huggingface/lerobot
- DreamerV3 — https://github.com/danijar/dreamerv3
- Meta JEPA — https://github.com/facebookresearch/jepa

### APIs
- NVIDIA Cosmos NIM — https://docs.nvidia.com/nim/cosmos/1.0.0/api-reference.html
- Gemini Robotics-ER — https://ai.google.dev/gemini-api/docs/robotics-overview
- World Labs API — https://docs.worldlabs.ai/api/pricing
