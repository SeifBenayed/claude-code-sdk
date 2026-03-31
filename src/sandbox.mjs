// src/sandbox.mjs — Container-based sandbox for Bash tool execution
//
// Modes:
//   "host"      — direct execution (current behavior, no isolation)
//   "docker"    — run inside Docker container with volume mounts
//   "auto"      — use Docker if available, fall back to host with warning
//
// Security layers:
//   1. Project dir mounted read-write (only the workspace)
//   2. Home dir mounted read-only (for configs, SSH keys)
//   3. /tmp mounted ephemeral (container-local)
//   4. Network: configurable (enabled by default, can disable)
//   5. Resource limits: memory, CPU, PID count
//   6. No privileged mode, no host PID/IPC namespace
//   7. Read-only root filesystem (except mounted volumes)

import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "./utils.mjs";

// ── Constants ────────────────────────────────────────────────

const DEFAULT_IMAGE = "node:20-slim";
const CONTAINER_PREFIX = "cloclo-sandbox-";
const DEFAULT_MEMORY = "512m";
const DEFAULT_CPU = "1.0";
const DEFAULT_PIDS = 256;

// ── Docker Detection ─────────────────────────────────────────

let _dockerAvailable = null;

function isDockerAvailable() {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    execSync("docker info", { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}

// ── Sandbox Configuration ────────────────────────────────────

const SANDBOX_DEFAULTS = {
  mode: "auto",            // "host" | "docker" | "auto"
  image: DEFAULT_IMAGE,
  network: true,           // allow network access
  memory: DEFAULT_MEMORY,  // memory limit
  cpu: DEFAULT_CPU,        // CPU shares
  pids: DEFAULT_PIDS,      // max PIDs
  readOnlyRoot: true,      // read-only root filesystem
  extraMounts: [],         // additional volume mounts [{src, dst, mode}]
  envPassthrough: [        // env vars to pass into container
    "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM",
    "GITHUB_TOKEN", "GH_TOKEN",
    "NODE_PATH", "PATH",
  ],
  allowedWritePaths: [],   // extra writable paths beyond project dir
};

function resolveSandboxConfig(cfg) {
  const settings = cfg?._sandboxSettings || {};
  return { ...SANDBOX_DEFAULTS, ...settings };
}

// ── Sandbox Runner ───────────────────────────────────────────

class SandboxRunner {
  constructor(config = {}) {
    this.config = { ...SANDBOX_DEFAULTS, ...config };
    this._containersToClean = new Set();
  }

  get effectiveMode() {
    if (this.config.mode === "docker") return "docker";
    if (this.config.mode === "host") return "host";
    // auto: use Docker if available
    return isDockerAvailable() ? "docker" : "host";
  }

  // Execute a command in the sandbox
  async exec(command, { cwd, timeout = 120000, env = {} } = {}) {
    const mode = this.effectiveMode;

    if (mode === "host" && this.config.mode === "auto" && !this._hostWarningEmitted) {
      this._hostWarningEmitted = true;
      process.stderr.write("\x1b[33m[sandbox] Warning: Docker unavailable — running commands on host without sandbox.\x1b[0m\n");
    }

    if (mode === "host") {
      return this._execHost(command, { cwd, timeout, env });
    }

    return this._execDocker(command, { cwd, timeout, env });
  }

  // ── Host execution (no sandbox) ────────────────────────────

  _execHost(command, { cwd, timeout, env }) {
    return new Promise((resolve) => {
      const proc = spawn("bash", ["-c", command], {
        timeout,
        cwd: cwd || process.cwd(),
        env: { ...process.env, ...env, TERM: "dumb" },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "", stderr = "";
      proc.stdout.on("data", (d) => { stdout += d; });
      proc.stderr.on("data", (d) => { stderr += d; });
      proc.stdin.end();

      proc.on("error", (e) => {
        resolve({ content: `Spawn error: ${e.message}`, is_error: true, sandboxMode: "host" });
      });

      proc.on("close", (code) => {
        const out = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
        if (code !== 0 && code !== null) {
          resolve({ content: `Exit code ${code}\n${out}`, is_error: true, sandboxMode: "host" });
        } else {
          resolve({ content: out || "(no output)", is_error: false, sandboxMode: "host" });
        }
      });
    });
  }

  // ── Docker execution ───────────────────────────────────────

  async _execDocker(command, { cwd, timeout, env }) {
    const projectDir = cwd || process.cwd();
    const homeDir = os.homedir();
    const containerId = CONTAINER_PREFIX + Date.now().toString(36);

    // Build docker run args
    const args = ["run", "--rm"];

    // Container name for tracking
    args.push("--name", containerId);

    // Resource limits
    args.push("--memory", this.config.memory);
    args.push("--cpus", this.config.cpu);
    args.push("--pids-limit", String(this.config.pids));

    // No privileges
    args.push("--security-opt", "no-new-privileges");

    // Read-only root filesystem
    if (this.config.readOnlyRoot) {
      args.push("--read-only");
      // Need writable /tmp for many tools
      args.push("--tmpfs", "/tmp:rw,noexec,nosuid,size=256m");
      // Node needs writable dirs
      args.push("--tmpfs", "/root:rw,size=64m");
    }

    // Network
    if (!this.config.network) {
      args.push("--network", "none");
    }

    // Volume mounts
    // Project dir: read-write
    args.push("-v", `${projectDir}:/workspace:rw`);
    args.push("-w", "/workspace");

    // Home dir: read-only (for .ssh, .gitconfig, etc.)
    args.push("-v", `${homeDir}:${homeDir}:ro`);

    // Extra mounts
    for (const mount of this.config.extraMounts) {
      const mode = mount.mode || "ro";
      args.push("-v", `${mount.src}:${mount.dst}:${mode}`);
    }

    // Extra writable paths
    for (const p of this.config.allowedWritePaths) {
      args.push("-v", `${p}:${p}:rw`);
    }

    // Environment variables
    for (const key of this.config.envPassthrough) {
      if (process.env[key]) {
        args.push("-e", `${key}=${process.env[key]}`);
      }
    }
    // Custom env
    for (const [key, val] of Object.entries(env)) {
      args.push("-e", `${key}=${val}`);
    }

    // User mapping: run as current user to preserve file ownership
    try {
      const uid = process.getuid();
      const gid = process.getgid();
      if (uid !== undefined) args.push("--user", `${uid}:${gid}`);
    } catch { /* ignore: may not be available on all platforms */ }

    // Image and command
    args.push(this.config.image);
    args.push("bash", "-c", command);

    this._containersToClean.add(containerId);

    // Execute with timeout
    return new Promise((resolve) => {
      const proc = spawn("docker", args, {
        timeout: timeout + 10000, // extra buffer for container startup
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      let stdout = "", stderr = "";
      proc.stdout.on("data", (d) => { stdout += d; });
      proc.stderr.on("data", (d) => { stderr += d; });
      proc.stdin.end();

      // Timeout kill
      const timer = setTimeout(() => {
        try { execSync(`docker kill ${containerId}`, { stdio: "pipe", timeout: 5000 }); } catch { /* ignore */ }
        resolve({
          content: `Container timeout (${timeout}ms)\n${stdout}${stderr ? "\n[stderr]\n" + stderr : ""}`,
          is_error: true,
          sandboxMode: "docker",
        });
      }, timeout);

      proc.on("error", (e) => {
        clearTimeout(timer);
        this._containersToClean.delete(containerId);
        // Docker not working — fall back to host
        if (e.message.includes("ENOENT") || e.message.includes("spawn")) {
          log("[sandbox] Docker spawn failed, falling back to host");
          this._execHost(command, { cwd, timeout, env }).then(resolve);
          return;
        }
        resolve({ content: `Docker error: ${e.message}`, is_error: true, sandboxMode: "docker" });
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        this._containersToClean.delete(containerId);

        // Filter out Docker-specific noise from stderr
        const cleanStderr = stderr.split("\n")
          .filter(l => !l.includes("Unable to find image") && !l.includes("Pulling from") && !l.includes("Digest:") && !l.includes("Status:") && !l.includes("docker.io"))
          .join("\n").trim();

        const out = stdout + (cleanStderr ? `\n[stderr]\n${cleanStderr}` : "");

        if (code !== 0 && code !== null) {
          resolve({ content: `Exit code ${code}\n${out}`, is_error: true, sandboxMode: "docker" });
        } else {
          resolve({ content: out || "(no output)", is_error: false, sandboxMode: "docker" });
        }
      });
    });
  }

  // ── Image management ───────────────────────────────────────

  async ensureImage() {
    if (this.effectiveMode !== "docker") return true;
    try {
      execSync(`docker image inspect ${this.config.image}`, { stdio: "pipe", timeout: 10000 });
      return true;
    } catch {
      log(`[sandbox] Pulling image ${this.config.image}...`);
      try {
        execSync(`docker pull ${this.config.image}`, { stdio: "pipe", timeout: 120000 });
        return true;
      } catch (e) {
        log(`[sandbox] Failed to pull image: ${e.message}`);
        return false;
      }
    }
  }

  // ── Cleanup ────────────────────────────────────────────────

  shutdown() {
    for (const id of this._containersToClean) {
      try { execSync(`docker kill ${id}`, { stdio: "pipe", timeout: 5000 }); } catch { /* ignore */ }
    }
    this._containersToClean.clear();
  }

  // ── Status ─────────────────────────────────────────────────

  status() {
    return {
      mode: this.config.mode,
      effectiveMode: this.effectiveMode,
      dockerAvailable: isDockerAvailable(),
      image: this.config.image,
      network: this.config.network,
      memory: this.config.memory,
      cpu: this.config.cpu,
      readOnlyRoot: this.config.readOnlyRoot,
    };
  }
}

// ── Bash Tool Wrapper ────────────────────────────────────────
//
// Drop-in replacement for the Bash tool executor.
// Routes through SandboxRunner based on config.

function createSandboxedBashExecutor(registry, sandboxRunner) {
  return async (input) => {
    const command = input.command;
    if (!command) return { content: "No command provided", is_error: true };

    const timeout = Math.min(input.timeout || 120000, 600000);
    const cwd = input.cwd || registry._cwd || process.cwd();

    // Check if command needs host access (e.g., docker commands themselves)
    const needsHost = /^\s*(docker|podman|kubectl|helm)\s/.test(command);

    if (needsHost && sandboxRunner.effectiveMode === "docker") {
      // Docker-in-docker is complex — run these on host
      const result = await sandboxRunner._execHost(command, { cwd, timeout });
      result.content = `[host] ${result.content}`;
      return result;
    }

    const result = await sandboxRunner.exec(command, { cwd, timeout });

    // Annotate sandbox mode in verbose output
    if (result.sandboxMode === "docker") {
      log(`[sandbox] Ran in Docker: ${command.slice(0, 80)}`);
    }

    return result;
  };
}

// ── Exports ──────────────────────────────────────────────────

export {
  SandboxRunner,
  isDockerAvailable,
  createSandboxedBashExecutor,
  resolveSandboxConfig,
  SANDBOX_DEFAULTS,
  DEFAULT_IMAGE,
};
