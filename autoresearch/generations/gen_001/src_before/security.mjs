import fs from "fs";
import path from "path";
import os from "os";
import { createInterface } from "readline";
import { log, EXIT, getMemoryDir, getUserMemoryDir } from "./utils.mjs";
import { DEFAULT_BLOCK_RULES, DEFAULT_ALLOW_RULES } from "./security-rules.mjs";

// ── Rule Compiler ────────────────────────────────────────────────
//
// Compiles a rule from JSON format (name/desc/tool/pattern) into
// an executable rule with a test() function.
// Returns null for invalid rules (logged, never crashes).

function compileRule(rule) {
  if (!rule.name || !rule.tool) {
    log(`[security] Skipping invalid rule: missing name/tool`);
    return null;
  }
  if (!rule.pattern) {
    log(`[security] Skipping rule "${rule.name}": no pattern (custom test rules cannot be loaded from JSON)`);
    return null;
  }
  try {
    const re = new RegExp(rule.pattern, "i");
    return {
      name: rule.name,
      desc: rule.desc || "",
      test: (tool, input) => {
        if (rule.tool !== "*" && tool !== rule.tool) return false;
        const text = input.command || input.new_string || input.content || "";
        return re.test(text);
      },
    };
  } catch (e) {
    log(`[security] Skipping rule "${rule.name}": invalid regex — ${e.message}`);
    return null;
  }
}

// ── Load rules from ~/.claude/rules.d/ and .claude/rules.d/ ─────

function _loadExternalRules(filename) {
  const rules = [];
  const dirs = [
    path.join(os.homedir(), ".claude", "rules.d"),
    path.join(process.cwd(), ".claude", "rules.d"),
  ];
  for (const dir of dirs) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, filename), "utf-8"));
      if (!Array.isArray(data)) {
        log(`[security] ${path.join(dir, filename)}: expected array, skipping`);
        continue;
      }
      for (const r of data) {
        const compiled = compileRule(r);
        if (compiled) rules.push(compiled);
      }
    } catch { /* no file or invalid JSON — silent */ }
  }
  return rules;
}

// ── Built-in rule compilation ────────────────────────────────────
//
// Rules with pattern: null have custom test logic that can't be
// expressed as a simple regex. These are compiled inline below.

function _compileBuiltinBlockRules() {
  return DEFAULT_BLOCK_RULES.map(r => {
    // Rules with a pattern compile to simple regex test
    if (r.pattern) {
      const re = new RegExp(r.pattern, "i");
      return {
        name: r.name, desc: r.desc,
        test: (tool, input) => {
          if (r.tool !== "*" && tool !== r.tool) return false;
          return re.test(input.command || "");
        },
      };
    }
    // Custom test rules (pattern: null) — hardcoded logic
    switch (r.name) {
      case "git_push_default_branch":
        // CC baseline: "Pushing directly to main, master, or the repository's default branch —
        // this bypasses pull request review."
        return { name: r.name, desc: r.desc, test: (() => {
          let _defaultBranch = null;
          return (tool, input) => {
            if (tool !== "Bash") return false;
            const cmd = input.command || "";
            if (!/git\s+push\b/.test(cmd)) return false;
            if (/origin\s+\S+:\S+/.test(cmd)) return false; // explicit refspec, user knows what they're doing
            // Lazy-detect default branch
            if (_defaultBranch === null) {
              try {
                const { execSync } = require("child_process");
                _defaultBranch = execSync("git rev-parse --abbrev-ref refs/remotes/origin/HEAD 2>/dev/null", { encoding: "utf-8" }).trim().replace("origin/", "") || "main";
              } catch { _defaultBranch = "main"; }
            }
            const branchPattern = new RegExp(`\\b(${_defaultBranch}|main|master)\\b`);
            return branchPattern.test(cmd);
          };
        })() };
      case "irreversible_local_destruction":
        return { name: r.name, desc: r.desc, test: (tool, input) => {
          if (tool !== "Bash") return false;
          const cmd = input.command || "";
          if (/rm\s+-rf?\s+(\/|~\/|\.\s*$)/.test(cmd)) return true;
          if (/git\s+clean\s+-fdx|git\s+checkout\s+\.\s*$|git\s+reset\s+--hard/.test(cmd)) return true;
          if (/>\s*\S+\.(js|py|ts|go|rs|md|json|yaml|yml|toml|cfg|conf|sh)\s*$/.test(cmd)) return true;
          return false;
        }};
      case "create_rce_surface":
        return { name: r.name, desc: r.desc, test: (tool, input) => {
          if (tool === "Bash") return /(eval\s*\(\s*req\.|exec\s*\(\s*req\.|child_process.*req\.|os\.system\s*\(\s*request)/.test(input.command || "");
          if (tool === "Write" || tool === "Edit") return /(eval\s*\(\s*req\.|exec\s*\(\s*req\.|os\.system\s*\(\s*request|subprocess\.call\s*\(\s*request)/.test(input.new_string || input.content || "");
          return false;
        }};
      case "unauthorized_persistence":
        return { name: r.name, desc: r.desc, test: (tool, input) => {
          const cmd = input.command || "";
          if (tool === "Bash" && /(crontab\s|systemctl\s+enable|>>?\s*~\/\.(bashrc|zshrc|profile|bash_profile)|ssh-keygen.*>>.*authorized_keys)/.test(cmd)) return true;
          if ((tool === "Write" || tool === "Edit") && /~\/\.(bashrc|zshrc|profile|bash_profile|ssh\/authorized_keys)/.test(input.file_path || "")) return true;
          return false;
        }};
      case "self_modification":
        return { name: r.name, desc: r.desc, test: (tool, input) => {
          const p = input.file_path || "";
          if ((tool === "Write" || tool === "Edit") && /\.claude\/(settings|CLAUDE\.md|permissions)/.test(p)) return true;
          if (tool === "Bash" && />\s*.*\.claude\/(settings|CLAUDE\.md)/.test(input.command || "")) return true;
          return false;
        }};
      default:
        log(`[security] Unknown custom block rule: ${r.name}`);
        return null;
    }
  }).filter(Boolean);
}

function _compileBuiltinAllowRules() {
  return DEFAULT_ALLOW_RULES.map(r => {
    if (r.pattern) {
      const re = new RegExp(r.pattern, "i");
      return {
        name: r.name, desc: r.desc,
        test: (tool, input) => {
          if (r.tool !== "*" && tool !== r.tool) return false;
          const text = (input.command || "").trim();
          return re.test(text);
        },
      };
    }
    switch (r.name) {
      case "test_artifacts":
        return { name: r.name, desc: r.desc, test: (tool, input) => {
          const cmd = input.command || "";
          const fp = input.file_path || "";
          return /test|spec|__test__|\.test\.|_test\.|fixture|mock|stub/i.test(cmd + fp);
        }};
      case "local_operations":
        // CC baseline: "Agent deleting local files in working directory within project scope.
        // Does NOT cover irreversible destruction of pre-existing files."
        return { name: r.name, desc: r.desc, test: (tool, input) => {
          if (tool !== "Bash") return false;
          const cmd = input.command || "";
          const cwd = process.cwd();
          // Allow rm/mv/cp with relative paths that don't escape the project
          if (/^(rm|mv|cp)\s/.test(cmd)) {
            const args = cmd.split(/\s+/).slice(1).filter(a => !a.startsWith("-"));
            // Block if any arg is absolute, starts with ~, or traverses up
            if (args.some(a => a.startsWith("/") || a.startsWith("~") || a.includes("../"))) return false;
            return true;
          }
          // Operations explicitly within cwd
          if (cmd.includes(cwd)) return true;
          return false;
        }};
      case "read_only_operations":
        // CC baseline: "GET requests, read-only API calls, queries that don't modify state."
        return { name: r.name, desc: r.desc, test: (tool, input) => {
          if (tool !== "Bash") return false;
          const cmd = input.command || "";
          if (/^(curl|wget)\s/.test(cmd) && !/-d\s|-X\s*(POST|PUT|PATCH|DELETE)|--request\s*(POST|PUT|PATCH|DELETE)|--data|--post|--upload|--form-string|-F\s/.test(cmd)) return true;
          return false;
        }};
      case "toolchain_bootstrap":
        return { name: r.name, desc: r.desc, test: (tool, input) => {
          if (tool !== "Bash") return false;
          const cmd = input.command || "";
          const officialInstallers = ["sh.rustup.rs", "bootstrap.pypa.io", "astral.sh", "bun.sh", "deb.nodesource.com", "get.docker.com", "brew.sh"];
          return officialInstallers.some((d) => cmd.includes(d));
        }};
      case "git_push_working_branch":
        // CC baseline: "Pushing to the branch the user started on (unless it's the default branch),
        // or to a branch the agent created during the session."
        // Detect default branch once, fall back to main|master.
        return { name: r.name, desc: r.desc, test: (() => {
          let _defaultBranch = null;
          return (tool, input) => {
            if (tool !== "Bash") return false;
            const cmd = input.command || "";
            if (!/^git\s+push\b/.test(cmd)) return false;
            // Lazy-detect default branch from git
            if (_defaultBranch === null) {
              try {
                const { execSync } = require("child_process");
                _defaultBranch = execSync("git rev-parse --abbrev-ref refs/remotes/origin/HEAD 2>/dev/null", { encoding: "utf-8" }).trim().replace("origin/", "") || "main";
              } catch { _defaultBranch = "main"; }
            }
            // Allow push if it doesn't target the default branch
            const branchPattern = new RegExp(`\\b(${_defaultBranch}|main|master)\\b`);
            return !branchPattern.test(cmd);
          };
        })() };
      default:
        log(`[security] Unknown custom allow rule: ${r.name}`);
        return null;
    }
  }).filter(Boolean);
}

// ── SecurityClassifier v2 ────────────────────────────────────────
//
// Block and allow rules loaded from:
//   1. Built-in defaults (security-rules.mjs)
//   2. User rules from ~/.claude/rules.d/security-blocks.json
//   3. Project rules from .claude/rules.d/security-blocks.json
//
// Security rules are ADDITIVE only — external rules add to built-in,
// never replace them.

class SecurityClassifier {
  constructor(extraBlockRules = [], extraAllowRules = []) {
    // Built-in rules (always present)
    const builtinBlocks = _compileBuiltinBlockRules();
    const builtinAllows = _compileBuiltinAllowRules();

    // External rules from rules.d/ files (additive)
    const fileBlocks = _loadExternalRules("security-blocks.json");
    const fileAllows = _loadExternalRules("security-allows.json");

    // Merge: built-in + file + constructor extras (all additive)
    this.blockRules = [...builtinBlocks, ...fileBlocks, ...extraBlockRules];
    this.allowRules = [...builtinAllows, ...fileAllows, ...extraAllowRules];
  }

  // Returns: { blocked: bool, rule?: string, reason?: string, exception?: string }
  classify(toolName, input) {
    for (const rule of this.blockRules) {
      if (rule.test(toolName, input)) {
        // BLOCK matched — check ALLOW exceptions
        for (const exception of this.allowRules) {
          if (exception.test(toolName, input)) {
            return { blocked: false, rule: rule.name, exception: exception.name };
          }
        }
        return { blocked: true, rule: rule.name, reason: rule.desc };
      }
    }
    return { blocked: false };
  }
}

// ── WebFetch Domain Rules ───────────────────────────────────────
// Built-in preapproved domains + user/project extensions from rules.d/

const BUILTIN_PREAPPROVED_DOMAINS = [
  "platform.claude.com", "code.claude.com", "modelcontextprotocol.io",
  "agentskills.io", "docs.python.org", "en.cppreference.com",
  "docs.oracle.com", "learn.microsoft.com", "developer.mozilla.org",
  "go.dev", "pkg.go.dev", "www.php.net", "docs.swift.org",
  "kotlinlang.org", "ruby-doc.org", "doc.rust-lang.org",
  "www.typescriptlang.org", "react.dev", "angular.io", "vuejs.org",
  "nextjs.org", "expressjs.com", "nodejs.org", "bun.sh",
  "jquery.com", "getbootstrap.com", "tailwindcss.com", "d3js.org",
  "threejs.org", "redux.js.org", "webpack.js.org", "jestjs.io",
  "reactrouter.com", "docs.djangoproject.com", "flask.palletsprojects.com",
  "fastapi.tiangolo.com", "pandas.pydata.org", "numpy.org",
  "www.tensorflow.org", "pytorch.org", "scikit-learn.org", "matplotlib.org",
  "requests.readthedocs.io", "jupyter.org", "laravel.com", "symfony.com",
  "wordpress.org", "docs.spring.io", "hibernate.org", "tomcat.apache.org",
  "gradle.org", "maven.apache.org", "asp.net", "dotnet.microsoft.com",
  "nuget.org", "blazor.net", "reactnative.dev", "docs.flutter.dev",
  "developer.apple.com", "developer.android.com", "keras.io",
  "spark.apache.org", "huggingface.co", "www.kaggle.com",
  "www.mongodb.com", "redis.io", "www.postgresql.org", "dev.mysql.com",
  "www.sqlite.org", "graphql.org", "prisma.io",
  "docs.aws.amazon.com", "cloud.google.com", "kubernetes.io",
  "www.docker.com", "www.terraform.io", "www.ansible.com",
  "vercel.com", "docs.netlify.com", "devcenter.heroku.com",
  "cypress.io", "selenium.dev", "docs.unity.com", "docs.unrealengine.com",
  "git-scm.com", "nginx.org", "httpd.apache.org",
  "github.com", "raw.githubusercontent.com", "stackoverflow.com",
  "npmjs.com", "pypi.org", "crates.io", "httpbin.org",
];

function loadPreapprovedDomains() {
  const domains = new Set(BUILTIN_PREAPPROVED_DOMAINS);
  const dirs = [
    path.join(os.homedir(), ".claude", "rules.d"),
    path.join(process.cwd(), ".claude", "rules.d"),
  ];
  for (const dir of dirs) {
    try {
      const extra = JSON.parse(fs.readFileSync(path.join(dir, "preapproved-domains.json"), "utf-8"));
      if (Array.isArray(extra)) {
        for (const d of extra) domains.add(d);
      }
    } catch { /* no file */ }
  }
  return domains;
}

const PREAPPROVED_DOMAINS = loadPreapprovedDomains();

function isDomainPreapproved(url) {
  try {
    const hostname = new URL(url).hostname;
    if (PREAPPROVED_DOMAINS.has(hostname)) return true;
    // Check if it's a subdomain of a preapproved domain
    for (const d of PREAPPROVED_DOMAINS) {
      if (hostname.endsWith("." + d)) return true;
    }
    // No special cases — use rules.d/preapproved-domains.json for org-specific domains.
    // CC baseline: no global domain whitelist at all, just per-tool permission.
    return false;
  } catch { return false; }
}

// ── Denial Tracking ─────────────────────────────────────────────
// Tracks consecutive and total denials. If thresholds exceeded,
// the system becomes more restrictive (circuit breaker).

class DenialTracker {
  constructor() {
    this.consecutiveDenials = 0;
    this.totalDenials = 0;
    this.maxConsecutive = 3;
    this.maxTotal = 20;
  }

  recordDenial() {
    this.consecutiveDenials++;
    this.totalDenials++;
  }

  recordAllow() {
    this.consecutiveDenials = 0; // Reset streak on allow
  }

  isCircuitBroken() {
    return this.consecutiveDenials >= this.maxConsecutive || this.totalDenials >= this.maxTotal;
  }

  get stats() {
    return { consecutive: this.consecutiveDenials, total: this.totalDenials, circuitBroken: this.isCircuitBroken() };
  }
}

// ── Per-Tool Permission Checks ──────────────────────────────────
//
// Each tool has its own checkPermissions() that evaluates tool-specific
// safety conditions. This runs AFTER the SecurityClassifier (BLOCK rules)
// and BEFORE the mode-based decision.
//
// Returns: { behavior: "allow"|"deny"|"ask"|"passthrough", message?, reason? }
// "passthrough" means this check has no opinion — defer to mode logic.

const SENSITIVE_DIRS = new Set([".git", ".vscode", ".idea", ".claude"]);
const SENSITIVE_FILES = new Set([
  ".gitconfig", ".gitmodules", ".bashrc", ".bash_profile",
  ".zshrc", ".zprofile", ".profile", ".ripgreprc",
  ".mcp.json", ".claude.json", ".env",
]);

// Memory helpers imported from utils.mjs

function _securityRealpathOrResolve(targetPath) {
  const resolved = path.resolve(String(targetPath || ""));
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function _securityPathWithinRoot(filePath, rootPath) {
  const rel = path.relative(rootPath, filePath);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function _checkScopedMemoryFilePath(filePath, cwd) {
  if (!filePath) return { behavior: "passthrough" };

  const realFile = _securityRealpathOrResolve(filePath);
  if (path.extname(realFile).toLowerCase() !== ".md" || path.basename(realFile) === "MEMORY.md") {
    return {
      behavior: "deny",
      reason: "invalid_memory_file",
      message: "Memory file path must point to a markdown memory entry.",
    };
  }

  const roots = [
    _securityRealpathOrResolve(getUserMemoryDir()),
    _securityRealpathOrResolve(getMemoryDir(cwd || process.cwd())),
  ];

  for (const root of roots) {
    if (_securityPathWithinRoot(realFile, root)) return { behavior: "passthrough" };
  }

  return {
    behavior: "deny",
    reason: "outside_memory_scope",
    message: "Memory file path must stay inside the user or project memory directories.",
  };
}

const toolPermissionChecks = {
  // Bash: check if command writes outside workspace, uses pipes to external
  Bash(input, cwd) {
    const cmd = input.command || "";
    // Commands that only read are generally safe
    const readOnlyPrefixes = [
      "ls", "cat", "head", "tail", "wc", "echo", "pwd", "date", "whoami",
      "which", "type", "file", "stat", "du", "df", "uname", "env", "printenv",
      "git status", "git log", "git diff", "git branch", "git show", "git remote",
      "git rev-parse", "git describe", "git tag", "git stash list",
      "grep", "rg", "ag", "find", "fd", "tree",
      "node --version", "python --version", "go version", "rustc --version",
      "npm list", "pip list", "cargo --version",
    ];
    const trimCmd = cmd.trim();
    for (const prefix of readOnlyPrefixes) {
      if (trimCmd === prefix || trimCmd.startsWith(prefix + " ") || trimCmd.startsWith(prefix + "\t")) {
        return { behavior: "allow", reason: "read_only_command" };
      }
    }
    // Safe build/test commands within project
    if (/^(npm|yarn|pnpm)\s+(run|test|build|start|dev|lint|format|check)\b/.test(trimCmd)) {
      return { behavior: "allow", reason: "project_script" };
    }
    if (/^(cargo|go|make|python|pytest|jest|vitest|mocha)\s+(build|test|run|check|vet|fmt)\b/.test(trimCmd)) {
      return { behavior: "allow", reason: "project_build_test" };
    }
    // Git commits/add within workspace are safe
    if (/^git\s+(add|commit|stash|checkout\s+-b|switch\s+-c|push\s+origin\s+(?!main\b|master\b))\b/.test(trimCmd)) {
      return { behavior: "allow", reason: "safe_git_op" };
    }
    // Default: no opinion, defer to mode
    return { behavior: "passthrough" };
  },

  // Edit: check file path safety
  Edit(input, cwd) {
    return _checkFilePath(input.file_path, cwd, "edit");
  },

  // Write: check file path safety
  Write(input, cwd) {
    return _checkFilePath(input.file_path, cwd, "write");
  },

  // Read: almost always safe, but check for sensitive files
  Read(input, cwd) {
    const fp = input.file_path || "";
    // Reading .env files should at least be noted
    if (fp.endsWith(".env") || fp.includes(".env.")) {
      return { behavior: "passthrough", reason: "env_file_read" };
    }
    return { behavior: "allow", reason: "read_safe" };
  },

  // Glob: always safe (read-only)
  Glob(_input, _cwd) {
    return { behavior: "allow", reason: "glob_safe" };
  },

  // Grep: always safe (read-only)
  Grep(_input, _cwd) {
    return { behavior: "allow", reason: "grep_safe" };
  },

  // WebFetch: check domain against preapproved list
  WebFetch(input, _cwd) {
    const url = input.url || "";
    try {
      new URL(url); // validate
    } catch {
      return { behavior: "deny", reason: "invalid_url", message: "Invalid URL" };
    }
    if (isDomainPreapproved(url)) {
      return { behavior: "allow", reason: "preapproved_domain" };
    }
    // Unknown domain: ask (user decides)
    return { behavior: "ask", reason: "unknown_domain", message: `WebFetch to unknown domain: ${new URL(url).hostname}` };
  },

  // WebSearch: always safe (server-side, read-only)
  WebSearch(_input, _cwd) {
    return { behavior: "allow", reason: "search_safe" };
  },

  // Agent: allow — sub-agents enforce their own permissions
  Agent(_input, _cwd) {
    return { behavior: "allow", reason: "agent_self_enforcing" };
  },

  // MemoryRead: name-based lookup is fine; direct file paths must stay inside memory dirs
  MemoryRead(input, cwd) {
    return _checkScopedMemoryFilePath(input.file_path, cwd);
  },

  // MemorySave: only explicit user/project scopes are valid
  MemorySave(input, _cwd) {
    if (!input?.scope || (input.scope !== "user" && input.scope !== "project")) {
      return { behavior: "deny", reason: "invalid_memory_scope", message: "MemorySave requires scope=user or scope=project." };
    }
    return { behavior: "passthrough" };
  },

  // MemoryForget: name-based lookup is fine; direct file paths must stay inside memory dirs
  MemoryForget(input, cwd) {
    return _checkScopedMemoryFilePath(input.file_path, cwd);
  },
};

function _checkFilePath(filePath, cwd, op) {
  if (!filePath) return { behavior: "passthrough" };
  const cwdResolved = path.resolve(cwd || process.cwd());
  const fp = path.resolve(cwdResolved, filePath);
  const parts = fp.split(path.sep);
  const fileName = parts[parts.length - 1];

  // Block UNC paths
  if (fp.startsWith("\\\\") || fp.startsWith("//")) {
    return { behavior: "deny", reason: "unc_path", message: "UNC paths are not allowed." };
  }

  // Check sensitive directories
  for (const part of parts) {
    if (SENSITIVE_DIRS.has(part)) {
      // Exception: .claude/worktrees is OK
      if (part === ".claude") {
        const nextPart = parts[parts.indexOf(part) + 1];
        if (nextPart === "worktrees") continue;
      }
      return { behavior: "ask", reason: "sensitive_dir", message: `File is in sensitive directory: ${part}` };
    }
  }

  // Check sensitive files
  if (SENSITIVE_FILES.has(fileName)) {
    return { behavior: "ask", reason: "sensitive_file", message: `${fileName} is a sensitive file.` };
  }

  // Check if within working directory or memory directory
  const memDir = getMemoryDir(cwdResolved);
  if (fp.startsWith(cwdResolved) || fp.startsWith("/tmp") || fp.startsWith("/private/tmp") || fp.startsWith(memDir)) {
    return { behavior: "allow", reason: "within_workspace" };
  }

  // Outside workspace: ask
  return { behavior: "ask", reason: "outside_workspace", message: `File ${fp} is outside the working directory.` };
}

// ── PermissionManager ───────────────────────────────────────────

// Permission modes:
// - default:           ask for everything (interactive prompt)
// - plan:              read-only — deny all writes, allow reads
// - acceptEdits:       allow reads + edits, ask for Bash/dangerous
// - bypassPermissions: allow everything (no prompts)
// - dontAsk:           deny anything that would normally ask
// - auto:              allow safe ops, block dangerous, ask for ambiguous

const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "SendUserMessage", "TaskOutput", "ToolSearch", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "EnterPlanMode", "ExitPlanMode", "ListMcpResources", "ReadMcpResource", "AskUserQuestion", "MemoryList", "MemoryRead"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MemorySave", "MemoryForget"]);

// Generate a permission suggestion for a blocked action
function _suggestPattern(toolName, input) {
  if (toolName === "Bash") {
    const cmd = (input.command || "").trim();
    // Suggest the first word/command as a pattern
    const firstWord = cmd.split(/\s+/)[0];
    return `${firstWord} *`;
  }
  if (toolName === "Edit" || toolName === "Write") {
    const fp = input.file_path || "";
    const dir = path.dirname(fp);
    return `${dir}/**`;
  }
  if (toolName === "WebFetch") {
    try { return `domain:${new URL(input.url).hostname}`; } catch { return null; }
  }
  return null;
}

class PermissionManager {
  constructor(cfg) {
    this.mode = cfg.permissionMode || "default";
    this.rules = []; // { tool, pattern, behavior }
    this.callbacks = cfg.permissionCallbacks || false;
    this.classifier = new SecurityClassifier();
    this.denials = new DenialTracker();
    this._pendingCallbacks = new Map(); // requestId → { resolve }

    // Build rules from --allowed-tools / --disallowed-tools
    if (cfg.allowedTools) {
      for (const t of cfg.allowedTools) {
        const [tool, pattern] = t.includes("(") ? [t.split("(")[0], t.split("(")[1]?.replace(")", "")] : [t, null];
        this.rules.push({ tool, pattern, behavior: "allow" });
      }
    }
    if (cfg.disallowedTools) {
      for (const t of cfg.disallowedTools) {
        const [tool, pattern] = t.includes("(") ? [t.split("(")[0], t.split("(")[1]?.replace(")", "")] : [t, null];
        this.rules.push({ tool, pattern, behavior: "deny" });
      }
    }
  }

  // Returns: { behavior: "allow"|"deny"|"ask", message? }
  // Returns: { behavior: "allow"|"deny"|"ask", message?, rule?, reason? }
  async check(toolName, input, opts = {}) {
    const decisionCwd = opts.cwd || process.cwd();
    // 0. Circuit breaker — too many denials, become maximally restrictive
    if (this.denials.isCircuitBroken() && this.mode === "auto") {
      if (!READ_ONLY_TOOLS.has(toolName)) {
        return { behavior: "deny", message: `Too many denied actions (${this.denials.stats.consecutive} consecutive). Switching to restrictive mode.`, rule: "circuit_breaker" };
      }
    }

    // 0.5. Skill-scoped tool restriction — if a skill is active, only its allowed tools may run
    const skillContext = opts.skillContext || null;
    if (skillContext && !skillContext.isToolAllowed(toolName)) {
      return {
        behavior: "deny",
        message: `${toolName} is not in skill "${skillContext.name}" allowed-tools [${(skillContext.allowedTools || []).join(", ")}].`,
        rule: "skill_tool_restriction",
      };
    }

    // 1. Check explicit deny rules (always first — overrides everything)
    const denyRule = this.rules.find((r) => r.behavior === "deny" && this._matchRule(r, toolName, input));
    if (denyRule) { this.denials.recordDenial(); return { behavior: "deny", message: `${toolName} is denied by rule.`, rule: "explicit_deny" }; }

    // 2. Security classifier — runs in ALL modes as a safety net
    //    In auto mode: blocks dangerous, allows safe, asks for ambiguous
    //    In other modes: only blocks truly dangerous (doesn't override mode logic for safe ops)
    const classification = this.classifier.classify(toolName, input);
    if (classification.blocked) {
      if (this.mode === "bypassPermissions") {
        log(`[security] WARNING: ${classification.rule} — ${classification.reason}`);
      } else {
        this.denials.recordDenial();
        return {
          behavior: "deny",
          message: `BLOCKED [${classification.rule}]: ${classification.reason}`,
          rule: classification.rule,
          reason: classification.reason,
          // Permission suggestion: what rule would the user need to add?
          suggestion: { tool: toolName, pattern: _suggestPattern(toolName, input), behavior: "allow" },
        };
      }
    }

    // 3. Per-tool checkPermissions — tool-specific safety logic
    const toolCheck = toolPermissionChecks[toolName];
    if (toolCheck) {
      const result = toolCheck(input, decisionCwd);
      if (result.behavior === "deny") return { ...result, rule: `tool_${toolName}_deny` };
      if (result.behavior === "ask") return { ...result, rule: `tool_${toolName}_ask` };
      if (result.behavior === "allow" && this.mode !== "default") {
        // In non-default modes, per-tool allow is trusted
        return { ...result, rule: `tool_${toolName}_allow` };
      }
      // "passthrough" or "allow" in default mode → continue to mode logic
    }

    // 4. Check explicit allow rules
    const allowRule = this.rules.find((r) => r.behavior === "allow" && this._matchRule(r, toolName, input));
    if (allowRule) return { behavior: "allow", rule: "explicit_allow" };

    // 5. Apply permission mode
    switch (this.mode) {
      case "bypassPermissions":
        return { behavior: "allow", rule: "mode_bypass" };

      case "dontAsk":
        if (READ_ONLY_TOOLS.has(toolName)) return { behavior: "allow", rule: "mode_dontask_readonly" };
        return { behavior: "deny", message: `${toolName} denied in dontAsk mode.`, rule: "mode_dontask" };

      case "plan":
        if (READ_ONLY_TOOLS.has(toolName)) return { behavior: "allow", rule: "mode_plan_readonly" };
        return { behavior: "deny", message: `${toolName} denied in plan mode (read-only).`, rule: "mode_plan" };

      case "acceptEdits":
        if (READ_ONLY_TOOLS.has(toolName)) return { behavior: "allow", rule: "mode_accept_readonly" };
        if (WRITE_TOOLS.has(toolName)) return { behavior: "allow", rule: "mode_accept_write" };
        return { behavior: "ask", message: `${toolName} requires permission in acceptEdits mode.`, rule: "mode_accept_ask" };

      case "auto":
        // Auto mode: classifier already ran above. If we're here, it wasn't blocked.
        if (READ_ONLY_TOOLS.has(toolName)) { this._recordAllow(); return { behavior: "allow", rule: "auto_readonly" }; }
        if (WRITE_TOOLS.has(toolName)) { this._recordAllow(); return { behavior: "allow", rule: "auto_write" }; }
        if (toolName === "Bash") { this._recordAllow(); return { behavior: "allow", rule: "auto_bash_safe" }; }
        if (toolName === "Agent") { this._recordAllow(); return { behavior: "allow", rule: "auto_agent" }; }
        return { behavior: "ask", message: `Allow ${toolName}?`, rule: "auto_ask" };

      case "default":
      default:
        if (READ_ONLY_TOOLS.has(toolName)) return { behavior: "allow", rule: "mode_default_readonly" };
        return { behavior: "ask", message: `Allow ${toolName}?`, rule: "mode_default_ask" };
    }
  }

  _matchRule(rule, toolName, input) {
    if (rule.tool !== toolName && rule.tool !== "*") return false;
    if (!rule.pattern) return true;
    // Pattern matching for Bash commands: Bash(npm run build) matches commands starting with "npm run build"
    if (toolName === "Bash" && input?.command) {
      return input.command.startsWith(rule.pattern) || this._globMatch(rule.pattern, input.command);
    }
    // Pattern matching for file tools: Edit(src/**) matches file paths
    if (input?.file_path) {
      return this._globMatch(rule.pattern, input.file_path);
    }
    return true;
  }

  _globMatch(pattern, str) {
    if (pattern.includes("*")) {
      const re = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return new RegExp(`^${re}$`).test(str);
    }
    return str.startsWith(pattern);
  }

  // Track allows to reset denial streak
  _recordAllow() { this.denials.recordAllow(); }

  addRule(tool, pattern, behavior) {
    this.rules.push({ tool, pattern, behavior });
  }

  setMode(mode) {
    const valid = ["default", "plan", "acceptEdits", "bypassPermissions", "dontAsk", "auto"];
    if (valid.includes(mode)) this.mode = mode;
  }
}

// ── Path Glob Matcher (for path-scoped rules) ──────────────────

function _pathMatchesGlob(filePath, pattern) {
  if (!filePath || !pattern) return false;
  // Convert glob pattern to regex: **/ matches zero or more path segments, * matches within a segment
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "(.+/)?")  // **/ = zero or more path segments
    .replace(/\*\*/g, ".*")        // standalone ** = match everything
    .replace(/\*/g, "[^/]*");      // * = match within a segment
  const regex = new RegExp(`(^|/)${re}$`);
  return regex.test(filePath);
}

// ── Exports ─────────────────────────────────────────────────────

export {
  SecurityClassifier,
  DenialTracker,
  PermissionManager,
  isDomainPreapproved,
  compileRule,
  _checkFilePath,
  _suggestPattern,
  _pathMatchesGlob,
  PREAPPROVED_DOMAINS,
  SENSITIVE_DIRS,
  SENSITIVE_FILES,
  READ_ONLY_TOOLS,
  WRITE_TOOLS,
  toolPermissionChecks,
};
