// src/teams.mjs — Multi-agent coordination with shared task boards
//
// Architecture:
//   Team        → named group of agents sharing a TaskBoard
//   TaskBoard   → shared state: tasks, messages, artifacts
//   TeamAgent   → wrapper around SubAgentRunner with board access
//
// Agents within a team can:
//   - See all tasks and their statuses
//   - Claim/update/complete tasks
//   - Post messages visible to all team members
//   - Share artifacts (findings, code snippets, decisions)
//   - Read other agents' outputs
//
// The board is injected into each agent's system prompt as context,
// so every agent naturally sees what others are doing.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "./utils.mjs";

// ── Task Board ───────────────────────────────────────────────

class TaskBoard {
  constructor(teamId) {
    this.teamId = teamId;
    this.tasks = new Map();      // id → Task
    this.messages = [];          // { from, ts, text, taskId? }
    this.artifacts = new Map();  // key → { from, ts, value }
    this.createdAt = new Date().toISOString();
  }

  // ── Tasks ──────────────────────────────────────────────────

  addTask(title, { description = "", assignee = null, priority = "medium", depends = [] } = {}) {
    const id = `task-${this.tasks.size + 1}`;
    const task = {
      id,
      title,
      description,
      status: "pending",  // pending → in_progress → completed | failed | blocked
      assignee,
      priority,           // low, medium, high, critical
      depends,            // task IDs that must complete first
      result: null,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      completedAt: null,
    };
    this.tasks.set(id, task);
    return task;
  }

  claimTask(taskId, agentId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (task.status !== "pending") return null;

    // Check dependencies
    for (const depId of task.depends) {
      const dep = this.tasks.get(depId);
      if (dep && dep.status !== "completed") return null;
    }

    task.status = "in_progress";
    task.assignee = agentId;
    task.updatedAt = new Date().toISOString();
    return task;
  }

  updateTask(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    if (updates.status) task.status = updates.status;
    if (updates.result !== undefined) task.result = updates.result;
    if (updates.assignee !== undefined) task.assignee = updates.assignee;
    if (updates.title !== undefined) task.title = updates.title;
    if (updates.description !== undefined) task.description = updates.description;
    if (updates.priority !== undefined) task.priority = updates.priority;
    if (updates.depends !== undefined) task.depends = updates.depends;
    task.updatedAt = new Date().toISOString();
    if (task.status === "completed" || task.status === "failed") {
      task.completedAt = new Date().toISOString();
    }
    return task;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  listTasks({ status = null } = {}) {
    let tasks = [...this.tasks.values()];
    if (status) tasks = tasks.filter(t => t.status === status);
    return tasks;
  }

  getReadyTasks() {
    const ready = [];
    for (const task of this.tasks.values()) {
      if (task.status !== "pending") continue;
      const depsReady = task.depends.every(depId => {
        const dep = this.tasks.get(depId);
        return dep && dep.status === "completed";
      });
      if (depsReady) ready.push(task);
    }
    return ready;
  }

  getTasksByStatus(status) {
    return [...this.tasks.values()].filter(t => t.status === status);
  }

  // ── Messages ───────────────────────────────────────────────

  postMessage(from, text, taskId = null) {
    const msg = { from, ts: new Date().toISOString(), text: text.slice(0, 1000), taskId };
    this.messages.push(msg);
    if (this.messages.length > 200) this.messages = this.messages.slice(-100);
    return msg;
  }

  getMessages({ since = null, taskId = null, limit = 50 } = {}) {
    let msgs = this.messages;
    if (since) msgs = msgs.filter(m => m.ts > since);
    if (taskId) msgs = msgs.filter(m => m.taskId === taskId);
    return msgs.slice(-limit);
  }

  // ── Artifacts ──────────────────────────────────────────────

  setArtifact(key, value, from) {
    this.artifacts.set(key, { from, ts: new Date().toISOString(), value: String(value).slice(0, 5000) });
  }

  getArtifact(key) {
    return this.artifacts.get(key) || null;
  }

  // ── Snapshot (for system prompt injection) ─────────────────

  snapshot() {
    const tasks = [...this.tasks.values()].map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      assignee: t.assignee || "unassigned",
      priority: t.priority,
      depends: t.depends,
      result: t.result ? t.result.slice(0, 200) : null,
    }));

    const recentMessages = this.messages.slice(-20).map(m =>
      `[${m.from}] ${m.text.slice(0, 150)}`
    );

    const artifacts = [...this.artifacts.entries()].map(([k, v]) =>
      `${k}: ${v.value.slice(0, 100)}`
    );

    return { tasks, recentMessages, artifacts };
  }

  toPromptBlock() {
    const snap = this.snapshot();
    const lines = [`<team-board team="${this.teamId}">`];

    // Tasks
    lines.push("  <tasks>");
    for (const t of snap.tasks) {
      const deps = t.depends.length ? ` depends="${t.depends.join(",")}"` : "";
      const result = t.result ? ` result="${t.result}"` : "";
      lines.push(`    <task id="${t.id}" status="${t.status}" assignee="${t.assignee}" priority="${t.priority}"${deps}${result}>${t.title}</task>`);
    }
    lines.push("  </tasks>");

    // Recent messages
    if (snap.recentMessages.length > 0) {
      lines.push("  <messages>");
      for (const m of snap.recentMessages) lines.push(`    ${m}`);
      lines.push("  </messages>");
    }

    // Shared artifacts
    if (snap.artifacts.length > 0) {
      lines.push("  <artifacts>");
      for (const a of snap.artifacts) lines.push(`    ${a}`);
      lines.push("  </artifacts>");
    }

    lines.push("</team-board>");
    return lines.join("\n");
  }
}

// ── Team ─────────────────────────────────────────────────────

class Team {
  constructor(name, { goal = "", agents = [] } = {}) {
    this.id = `team-${randomUUID().slice(0, 8)}`;
    this.name = name;
    this.goal = goal;
    this.board = new TaskBoard(this.id);
    this.agents = new Map();       // agentId → { type, model, status, description }
    this.results = new Map();      // agentId → result text
    this.createdAt = new Date().toISOString();
    this._abortController = new AbortController();

    // Pre-register planned agents
    for (const a of agents) {
      const agentId = `agent-${randomUUID().slice(0, 8)}`;
      this.agents.set(agentId, {
        type: a.type || "general-purpose",
        model: a.model || null,
        status: "pending",
        description: a.description || a.type || "agent",
        taskIds: a.taskIds || [],
      });
    }
  }

  addAgent(type, { model = null, description = "" } = {}) {
    const agentId = `agent-${randomUUID().slice(0, 8)}`;
    this.agents.set(agentId, { type, model, status: "pending", description, taskIds: [] });
    return agentId;
  }

  // Run all agents with board access
  async run(subAgentRunner, cfg) {
    const startTime = Date.now();
    log(`[team:${this.name}] Starting with ${this.agents.size} agents, ${this.board.tasks.size} tasks`);

    this.board.postMessage("coordinator", `Team "${this.name}" started. Goal: ${this.goal}`);

    // Phase 1: Launch agents for ready tasks (no unmet dependencies)
    const promises = [];

    for (const [agentId, agent] of this.agents) {
      const readyTasks = agent.taskIds.length > 0
        ? agent.taskIds.map(id => this.board.tasks.get(id)).filter(t => t && t.status === "pending")
        : this.board.getReadyTasks().filter(t => !t.assignee);

      if (readyTasks.length === 0) continue;

      // Claim tasks
      for (const task of readyTasks) {
        this.board.claimTask(task.id, agentId);
      }

      const taskDescriptions = readyTasks.map(t => `- [${t.id}] ${t.title}: ${t.description}`).join("\n");

      const boardContext = this.board.toPromptBlock();

      const agentPrompt = `You are agent "${agentId}" in team "${this.name}".

TEAM GOAL: ${this.goal}

YOUR ASSIGNED TASKS:
${taskDescriptions}

SHARED BOARD STATE:
${boardContext}

INSTRUCTIONS:
- Complete your assigned tasks
- Post updates via the team board (your results will be shared automatically)
- If blocked, note it — another agent may help
- Be concise — other agents will read your output

Execute your tasks now.`;

      agent.status = "running";
      this.board.postMessage(agentId, `Starting tasks: ${readyTasks.map(t => t.id).join(", ")}`);

      const promise = this._runAgent(subAgentRunner, agentId, agent, agentPrompt, readyTasks, cfg);
      promises.push(promise);
    }

    // Wait for all agents
    const results = await Promise.allSettled(promises);

    // Phase 2: Check for blocked tasks that are now unblocked
    const unblocked = this.board.getReadyTasks().filter(t => !t.assignee);
    if (unblocked.length > 0) {
      log(`[team:${this.name}] Phase 2: ${unblocked.length} tasks unblocked`);

      // Find an idle agent or use the first available
      for (const task of unblocked) {
        let runner = null;
        for (const [id, a] of this.agents) {
          if (a.status === "completed" || a.status === "idle") { runner = [id, a]; break; }
        }
        if (!runner) {
          // Create ad-hoc agent
          const adhocId = this.addAgent("general-purpose", { description: `Follow-up for ${task.id}` });
          runner = [adhocId, this.agents.get(adhocId)];
        }

        const [runnerId, runnerAgent] = runner;
        this.board.claimTask(task.id, runnerId);

        const prompt = `You are agent "${runnerId}" in team "${this.name}".

TEAM GOAL: ${this.goal}

YOUR TASK (follow-up after earlier agents completed prerequisites):
- [${task.id}] ${task.title}: ${task.description}

SHARED BOARD STATE:
${this.board.toPromptBlock()}

Previous agents' results are visible on the board. Use them to complete your task.`;

        runnerAgent.status = "running";
        await this._runAgent(subAgentRunner, runnerId, runnerAgent, prompt, [task], cfg);
      }
    }

    const elapsed = Date.now() - startTime;
    this.board.postMessage("coordinator", `Team finished in ${(elapsed / 1000).toFixed(1)}s`);

    log(`[team:${this.name}] Completed in ${elapsed}ms`);
    return this._buildReport();
  }

  async _runAgent(subAgentRunner, agentId, agent, prompt, tasks, cfg) {
    try {
      const result = await subAgentRunner.run({
        prompt,
        subagentType: agent.type,
        model: agent.model,
        description: agent.description,
        depth: 1,
        parentAgentId: null,
        runInBackground: false,
      });

      agent.status = "completed";
      this.results.set(agentId, result.content || result.text || "");

      // Update tasks
      for (const task of tasks) {
        this.board.updateTask(task.id, {
          status: "completed",
          result: (result.content || "").slice(0, 500),
        });
      }

      this.board.postMessage(agentId, `Completed: ${tasks.map(t => t.id).join(", ")}. ${(result.content || "").slice(0, 200)}`);

      return result;
    } catch (e) {
      agent.status = "failed";

      for (const task of tasks) {
        this.board.updateTask(task.id, {
          status: "failed",
          result: `Error: ${e.message}`,
        });
      }

      this.board.postMessage(agentId, `Failed: ${e.message}`);
      log(`[team:${this.name}] Agent ${agentId} failed: ${e.message}`);
      return null;
    }
  }

  _buildReport() {
    const snap = this.board.snapshot();

    const completed = snap.tasks.filter(t => t.status === "completed").length;
    const failed = snap.tasks.filter(t => t.status === "failed").length;
    const pending = snap.tasks.filter(t => t.status === "pending" || t.status === "in_progress").length;

    const agentResults = [];
    for (const [id, result] of this.results) {
      const agent = this.agents.get(id);
      agentResults.push(`## Agent: ${agent?.description || id} (${agent?.type})\n${result.slice(0, 1000)}`);
    }

    return {
      team: this.name,
      goal: this.goal,
      summary: `${completed} completed, ${failed} failed, ${pending} remaining out of ${snap.tasks.length} tasks`,
      tasks: snap.tasks,
      board: this.board.toPromptBlock(),
      agentResults: agentResults.join("\n\n"),
      messages: snap.recentMessages,
    };
  }

  abort() {
    this._abortController.abort();
    for (const [, agent] of this.agents) {
      if (agent.status === "running") agent.status = "cancelled";
    }
  }
}

// ── Team Manager (singleton) ─────────────────────────────────

class TeamManager {
  constructor() {
    this._teams = new Map(); // teamId → Team
  }

  create(name, opts) {
    const team = new Team(name, opts);
    this._teams.set(team.id, team);
    return team;
  }

  get(teamId) { return this._teams.get(teamId) || null; }
  list() { return [...this._teams.values()].map(t => ({ id: t.id, name: t.name, goal: t.goal, agents: t.agents.size, tasks: t.board.tasks.size })); }
  remove(teamId) { this._teams.delete(teamId); }
}

// ── Tool Registration ────────────────────────────────────────

function registerTeamTools(registry, subAgentRunner, cfg) {
  if (!subAgentRunner) return;
  const manager = new TeamManager();
  cfg._teamManager = manager;

  registry.register("Team", {
    description: `Coordinate multiple agents working together on a complex task. Creates a team with a shared task board where agents can see each other's progress, results, and communicate.

Use this for tasks that benefit from parallelism or specialization:
- Research + implementation + review (3 agents)
- Multi-file refactoring with verification
- Explore → Plan → Implement → Test pipeline

Each agent sees the full board state and other agents' results.`,
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create_and_run", "status", "list"],
          description: "Action to perform",
        },
        name: { type: "string", description: "Team name (for create_and_run)" },
        goal: { type: "string", description: "Overall team goal" },
        tasks: {
          type: "array",
          description: "Tasks for the team to complete",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              description: { type: "string" },
              priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
              depends: { type: "array", items: { type: "string" }, description: "Task IDs that must complete first" },
            },
            required: ["title"],
          },
        },
        agents: {
          type: "array",
          description: "Agent configurations",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "Agent type (general-purpose, Explore, Plan, etc.)" },
              model: { type: "string", description: "Optional model override" },
              description: { type: "string", description: "What this agent does" },
              task_ids: { type: "array", items: { type: "string" }, description: "Assigned task IDs" },
            },
          },
        },
        team_id: { type: "string", description: "Team ID (for status)" },
      },
      required: ["action"],
    },
  }, async (input) => {
    const action = input.action;

    if (action === "list") {
      const teams = manager.list();
      if (teams.length === 0) return { content: "No teams active.", is_error: false };
      const lines = teams.map(t => `${t.id}: "${t.name}" — ${t.agents} agents, ${t.tasks} tasks`);
      return { content: lines.join("\n"), is_error: false };
    }

    if (action === "status") {
      if (!input.team_id) return { content: "team_id required for status", is_error: true };
      const team = manager.get(input.team_id);
      if (!team) return { content: `Team not found: ${input.team_id}`, is_error: true };
      return { content: team.board.toPromptBlock(), is_error: false };
    }

    if (action === "create_and_run") {
      if (!input.name || !input.goal) return { content: "name and goal are required", is_error: true };
      if (!input.tasks || input.tasks.length === 0) return { content: "At least one task required", is_error: true };
      if (!input.agents || input.agents.length === 0) return { content: "At least one agent required", is_error: true };

      // Create team
      const team = manager.create(input.name, {
        goal: input.goal,
        agents: input.agents.map(a => ({
          type: a.type || "general-purpose",
          model: a.model,
          description: a.description || a.type,
          taskIds: a.task_ids || [],
        })),
      });

      // Add tasks
      const taskIdMap = {};
      for (const t of input.tasks) {
        // Resolve depends references (user may use "task-1" etc.)
        const depends = (t.depends || []).map(d => taskIdMap[d] || d);
        const task = team.board.addTask(t.title, {
          description: t.description || "",
          priority: t.priority || "medium",
          depends,
        });
        taskIdMap[task.id] = task.id;
      }

      // Auto-assign tasks to agents if not explicitly assigned
      const agentIds = [...team.agents.keys()];
      let agentIdx = 0;
      for (const task of team.board.tasks.values()) {
        if (!task.assignee && agentIds.length > 0) {
          const assigneeId = agentIds[agentIdx % agentIds.length];
          const agent = team.agents.get(assigneeId);
          if (agent && !agent.taskIds.includes(task.id)) {
            agent.taskIds.push(task.id);
          }
          agentIdx++;
        }
      }

      // Run team
      try {
        const report = await team.run(subAgentRunner, cfg);
        return {
          content: `# Team "${report.team}" Report\n\n**Goal:** ${report.goal}\n**Result:** ${report.summary}\n\n${report.agentResults}\n\n## Board State\n${report.board}`,
          is_error: false,
        };
      } catch (e) {
        return { content: `Team execution failed: ${e.message}`, is_error: true };
      }
    }

    return { content: `Unknown action: ${action}`, is_error: true };
  }, { deferred: true });
}

// ── Exports ──────────────────────────────────────────────────

export {
  TaskBoard,
  Team,
  TeamManager,
  registerTeamTools,
};
