// src/security-rules.mjs — Default security rules (shipped with cloclo)
//
// Block rules: actions that require confirmation or are denied outright
// Allow rules: exceptions that override block rules when matched
//
// Each rule has: name, desc, tool, pattern (regex string)
// Rules with custom `test` functions use tool: "*" and pattern: null.

// ── Default BLOCK Rules ─────────────────────────────────────────

const DEFAULT_BLOCK_RULES = [
  {
    name: "git_destructive",
    desc: "Force pushing, deleting remote branches, or rewriting remote history",
    tool: "Bash",
    pattern: "git\\s+push\\s+.*(-f|--force)|git\\s+push\\s+.*--delete|git\\s+branch\\s+-[dD]\\s+.*\\borigin\\b",
  },
  {
    name: "git_push_default_branch",
    desc: "Pushing directly to main/master bypasses pull request review",
    tool: "Bash",
    pattern: null, // custom test
  },
  {
    name: "code_from_external",
    desc: "Downloading and executing code from external sources",
    tool: "Bash",
    pattern: "curl\\s[^|]*\\|\\s*(ba)?sh|wget\\s[^|]*\\|\\s*(ba)?sh|eval\\s*\\$\\(\\s*curl|pip\\s+install\\s+git\\+http|npm\\s+install\\s+https?:",
  },
  {
    name: "cloud_storage_mass_delete",
    desc: "Deleting or mass modifying files on cloud storage",
    tool: "Bash",
    pattern: "aws\\s+s3\\s+(rm|rb)\\s+.*--recursive|gsutil\\s+(-m\\s+)?rm\\s+-r|az\\s+storage\\s+blob\\s+delete-batch",
  },
  {
    name: "production_deploy",
    desc: "Deploying to production or running production database migrations",
    tool: "Bash",
    pattern: "(kubectl|helm|gcloud|aws)\\s.*(deploy|apply|upgrade)\\s.*(\\bprod\\b|production)|migrate.*--database.*prod",
  },
  {
    name: "remote_shell_writes",
    desc: "Writing to running production/shared hosts via remote shell",
    tool: "Bash",
    pattern: "(kubectl|docker)\\s+exec\\s.*--?\\s*(sh|bash|rm|mv|cp|tee|cat\\s*>)|ssh\\s+\\S+\\s+['\"]?(rm|mv|cat\\s*>|tee)",
  },
  {
    name: "blind_apply",
    desc: "Skipping dry-run/preview for infrastructure changes",
    tool: "Bash",
    pattern: "terraform\\s+apply\\s+.*-auto-approve|pulumi\\s+up\\s+--yes|ansible.*--extra-vars.*force|kubectl\\s+delete.*--force",
  },
  {
    name: "logging_audit_tamper",
    desc: "Stopping logging, deleting logs, removing audit trails",
    tool: "Bash",
    pattern: "rm\\s+(-rf?\\s+)?(\\/var\\/log|.*\\.log\\b)|systemctl\\s+stop\\s+.*log|journalctl\\s+--vacuum",
  },
  {
    name: "permission_grant",
    desc: "Granting admin/owner roles or elevating IAM/RBAC permissions",
    tool: "Bash",
    pattern: "gcloud\\s+.*add-iam|aws\\s+iam\\s+.*attach-.*-policy|kubectl\\s+.*create\\s+.*rolebinding|chmod\\s+(777|a\\+[rwx])",
  },
  {
    name: "tls_auth_weaken",
    desc: "Disabling TLS verification or authentication",
    tool: "Bash",
    pattern: "(--insecure|--no-check-certificate|--allow-unauthenticated|NODE_TLS_REJECT_UNAUTHORIZED\\s*=\\s*['\"]?0|PYTHONHTTPSVERIFY\\s*=\\s*['\"]?0|verify\\s*=\\s*False)",
  },
  {
    name: "security_weaken",
    desc: "Disabling security mitigations or firewall rules",
    tool: "Bash",
    pattern: "(--dangerously-skip|--no-sandbox|--disable-security|ufw\\s+disable|iptables\\s+-F|setenforce\\s+0|--no-verify)",
  },
  {
    name: "create_unsafe_agents",
    desc: "Creating autonomous agent loops without safety frameworks",
    tool: "Bash",
    pattern: "(--dangerously-skip-permissions|--no-sandbox.*exec|eval.*while.*true)",
  },
  {
    name: "irreversible_local_destruction",
    desc: "Irreversibly deleting files not created by the agent",
    tool: "Bash",
    pattern: null, // custom test
  },
  {
    name: "create_rce_surface",
    desc: "Creating services that accept and execute arbitrary code",
    tool: "*", // multi-tool
    pattern: null, // custom test
  },
  {
    name: "expose_local_services",
    desc: "Exposing local files or services to the network",
    tool: "Bash",
    pattern: "(python3?\\s+-m\\s+http\\.server|nc\\s+-l\\s|socat\\s+TCP-LISTEN|ngrok\\s|localtunnel)",
  },
  {
    name: "credential_leakage",
    desc: "Embedding secrets in visible/queryable fields",
    tool: "Bash",
    pattern: "echo\\s+.*(\\$\\{?(API_KEY|SECRET|PASSWORD|TOKEN|AWS_SECRET)|sk-ant-|sk-[a-z]|ghp_|gho_|xox[bpras]-)",
  },
  {
    name: "credential_exploration",
    desc: "Systematically scanning credential stores",
    tool: "Bash",
    pattern: "(find|grep|rg|ag)\\s.*(-r\\s+)?\\/(etc|home|root|var)\\s.*\\.(env|pem|key|secret|password)|kubectl\\s+get\\s+secret",
  },
  {
    name: "data_exfiltration",
    desc: "Sending sensitive data to external endpoints",
    tool: "Bash",
    pattern: "(curl|wget|http)\\s.*(-d\\s+@|-F\\s+.*=@|--data.*@|--post-file|--upload-file)",
  },
  {
    name: "exfil_scouting",
    desc: "Testing reachability of external endpoints",
    tool: "Bash",
    pattern: "(curl|wget|nc)\\s.*(webhook\\.site|requestbin|pipedream|ngrok|burpcollaborator)",
  },
  {
    name: "unauthorized_persistence",
    desc: "Adding SSH keys, cron jobs, modifying shell profiles",
    tool: "*", // multi-tool
    pattern: null, // custom test
  },
  {
    name: "self_modification",
    desc: "Modifying the agent's own config or permissions",
    tool: "*", // multi-tool
    pattern: null, // custom test
  },
  {
    name: "content_integrity",
    desc: "Posting fabricated or false content to external systems",
    tool: "Bash",
    pattern: "(gh\\s+(issue|pr)\\s+(create|comment|close|merge)|curl\\s+.*-X\\s+(POST|PUT|PATCH)\\s+.*api\\.github\\.com)",
  },
  {
    name: "external_system_writes",
    desc: "Modifying items in external collaboration tools",
    tool: "Bash",
    pattern: "(gh\\s+(issue|pr)\\s+(close|delete|merge)|jira\\s|linear\\s.*update|slack\\s.*post)",
  },
  {
    name: "interfere_with_others",
    desc: "Deleting jobs or disrupting shared infrastructure",
    tool: "Bash",
    pattern: "(kubectl\\s+delete\\s+(pod|job|deploy|service|namespace)|scancel\\s|kill\\s+-9\\s+|pkill\\s)",
  },
  {
    name: "modify_shared_resources",
    desc: "In-place modification of shared artifacts",
    tool: "Bash",
    pattern: "(kubectl\\s+(apply|patch|edit)\\s|helm\\s+upgrade\\s|docker\\s+service\\s+update)",
  },
  {
    name: "real_world_transactions",
    desc: "Actions with real-world financial consequences",
    tool: "Bash",
    pattern: "(stripe\\s|paypal\\s|aws\\s+marketplace\\s+.*subscribe|gcloud\\s+billing)",
  },
  {
    name: "trusting_guessed_external",
    desc: "Sending data to agent-guessed external services",
    tool: "Bash",
    pattern: "(curl|wget|http)\\s+.*(-d|-X\\s+POST)\\s+.*https?:\\/\\/(?!localhost|127\\.0\\.0\\.1|api\\.anthropic)",
  },
  {
    name: "untrusted_code_integration",
    desc: "Pulling and executing code from external repos",
    tool: "Bash",
    pattern: "(git\\s+clone\\s+https?:\\/\\/.*&&\\s*(cd|pip\\s+install|npm\\s+install|make|python|node)\\b|git\\s+submodule\\s+add\\s+https?:\\/\\/)",
  },
];

// ── Default ALLOW Rules ─────────────────────────────────────────

const DEFAULT_ALLOW_RULES = [
  {
    name: "test_artifacts",
    desc: "Hardcoded test API keys, placeholder credentials in test files",
    tool: "*",
    pattern: null, // custom test
  },
  {
    name: "local_operations",
    desc: "File operations within project working directory scope",
    tool: "Bash",
    pattern: null, // custom test
  },
  {
    name: "read_only_operations",
    desc: "GET requests, read-only API calls, queries that don't modify state",
    tool: "Bash",
    pattern: null, // custom test
  },
  {
    name: "declared_dependencies",
    desc: "Installing packages from repo manifest files via standard commands",
    tool: "Bash",
    pattern: "^(npm|yarn|pnpm)\\s+install\\s*$|^pip\\s+install\\s+-r\\s+|^cargo\\s+build\\b|^bundle\\s+install\\b|^go\\s+mod\\s+(download|tidy)\\b",
  },
  {
    name: "toolchain_bootstrap",
    desc: "Installing language toolchains from official installers",
    tool: "Bash",
    pattern: null, // custom test (uses domain list)
  },
  {
    name: "standard_credentials",
    desc: "Reading credentials from agent config and sending to intended provider",
    tool: "Bash",
    pattern: "^(cat|source|\\.)\\s+\\.env\\b|^export\\s.*\\$\\(cat\\s+\\.env",
  },
  {
    name: "git_push_working_branch",
    desc: "Pushing to the current working branch (not main/master)",
    tool: "Bash",
    pattern: null, // custom test
  },
];

export { DEFAULT_BLOCK_RULES, DEFAULT_ALLOW_RULES };
