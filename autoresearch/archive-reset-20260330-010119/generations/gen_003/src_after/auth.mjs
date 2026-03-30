import { spawn, execSync } from "child_process";
import { randomUUID, createHash } from "crypto";
import { createServer } from "http";
import os from "os";
import { log, sleep } from "./utils.mjs";

// ── OpenAI OAuth ────────────────────────────────────────────────
//
// OAuth 2.1 PKCE flow against auth.openai.com, similar to Anthropic's.
// Tokens cached in macOS keychain under "Claude Native OpenAI-credentials".

export const OPENAI_AUTH_URL = "https://auth.openai.com/oauth/authorize";
export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const OPENAI_CLIENT_ID = "app_codex_cli";  // Codex CLI's registered client ID

export async function openaiOAuthLogin() {
  const state = randomUUID();
  const codeVerifier = randomUUID() + randomUUID();
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: "http://127.0.0.1:9876/callback",
    scope: "openid profile email offline_access",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${OPENAI_AUTH_URL}?${params}`;

  // Start local server to receive callback
  const { code, receivedState } = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1:9876");
      if (url.pathname !== "/callback") { res.writeHead(404); res.end(); return; }

      const code = url.searchParams.get("code");
      const receivedState = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body><h2>Login successful!</h2><p>You can close this tab.</p><script>window.close()</script></body></html>");
      server.close();

      if (error) reject(new Error(`OAuth error: ${error}`));
      else resolve({ code, receivedState });
    });

    server.listen(9876, "127.0.0.1", () => {
      process.stderr.write(`\nOpening browser for OpenAI login...\n`);
      try { execSync(`open "${authUrl}"`); } catch {
        process.stderr.write(`Open this URL in your browser:\n${authUrl}\n`);
      }
    });

    setTimeout(() => { server.close(); reject(new Error("Login timed out (120s)")); }, 120000);
  });

  if (receivedState !== state) throw new Error("OAuth state mismatch");

  // Exchange code for tokens
  const tokenResp = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_CLIENT_ID,
      code,
      redirect_uri: "http://127.0.0.1:9876/callback",
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenResp.ok) {
    const text = await tokenResp.text();
    throw new Error(`Token exchange failed: ${tokenResp.status} ${text}`);
  }

  const tokens = await tokenResp.json();

  // Save to macOS keychain
  const user = process.env.USER || os.userInfo().username;
  const service = "Claude Native OpenAI-credentials";
  const payload = JSON.stringify({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
  });

  try {
    execSync(`security delete-generic-password -a "${user}" -s "${service}"`, { stdio: ["pipe", "pipe", "pipe"] });
  } catch { /* no existing entry */ }
  execSync(
    `security add-generic-password -a "${user}" -s "${service}" -w '${payload.replace(/'/g, "'\\''")}'`,
    { stdio: ["pipe", "pipe", "pipe"] }
  );

  process.stderr.write(`\nOpenAI credentials saved to macOS keychain.\n`);
  return tokens.access_token;
}

export async function getOpenAIAccessToken(verbose = false) {
  const user = process.env.USER || os.userInfo().username;
  const service = "Claude Native OpenAI-credentials";

  let raw;
  try {
    raw = execSync(`security find-generic-password -a "${user}" -s "${service}" -w`, {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error("No OpenAI credentials found. Run --openai-login first.");
  }

  const creds = JSON.parse(raw);

  // Check if token is expired → refresh
  if (creds.expires_at && Date.now() > creds.expires_at - 60000 && creds.refresh_token) {
    if (verbose) log("[openai-auth] Token expired, refreshing...");
    const resp = await fetch(OPENAI_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: OPENAI_CLIENT_ID,
        refresh_token: creds.refresh_token,
      }),
    });

    if (!resp.ok) throw new Error("OpenAI token refresh failed. Run --openai-login again.");
    const tokens = await resp.json();

    creds.access_token = tokens.access_token;
    if (tokens.refresh_token) creds.refresh_token = tokens.refresh_token;
    creds.expires_at = Date.now() + (tokens.expires_in || 3600) * 1000;

    const payload = JSON.stringify(creds);
    try { execSync(`security delete-generic-password -a "${user}" -s "${service}"`, { stdio: ["pipe", "pipe", "pipe"] }); } catch { /* ignore: old entry may not exist */ }
    execSync(`security add-generic-password -a "${user}" -s "${service}" -w '${payload.replace(/'/g, "'\\''")}'`, { stdio: ["pipe", "pipe", "pipe"] });
  }

  return creds.access_token;
}

export function openaiOAuthLogout() {
  try {
    const user = process.env.USER || os.userInfo().username;
    execSync(`security delete-generic-password -a "${user}" -s "Claude Native OpenAI-credentials"`, { stdio: ["pipe", "pipe", "pipe"] });
    process.stderr.write("OpenAI credentials removed from keychain.\n");
  } catch {
    process.stderr.write("No OpenAI credentials found in keychain.\n");
  }
}

// ── OAuth (Pro/Max subscription via macOS Keychain) ─────────────

export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

export function readKeychainCredentials() {
  try {
    const user = process.env.USER || os.userInfo().username;
    const service = "Claude Code-credentials";
    const raw = execSync(
      `security find-generic-password -a "${user}" -w -s "${service}"`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function refreshOAuthToken(refreshToken) {
  const body = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
    scope: "user:profile user:inference user:sessions:claude_code user:mcp_servers",
  };

  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

export async function getOAuthAccessToken(verbose) {
  const creds = readKeychainCredentials();
  if (!creds?.claudeAiOauth) {
    throw new Error("No OAuth credentials found in keychain. Run with --login to authenticate.");
  }

  const oauth = creds.claudeAiOauth;
  let accessToken = oauth.accessToken;
  const expiresIn = (oauth.expiresAt - Date.now()) / 1000;

  if (expiresIn <= 300) {
    // Token expired or expiring soon — refresh
    if (verbose) log(`OAuth token expiring in ${Math.floor(expiresIn)}s, refreshing...`);
    const refreshed = await refreshOAuthToken(oauth.refreshToken);
    accessToken = refreshed.access_token;

    // Update keychain with new tokens
    const newCreds = {
      ...creds,
      claudeAiOauth: {
        ...oauth,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token || oauth.refreshToken,
        expiresAt: Date.now() + (refreshed.expires_in || 3600) * 1000,
      },
    };

    try {
      const user = process.env.USER || os.userInfo().username;
      const service = "Claude Code-credentials";
      const payload = JSON.stringify(newCreds);
      const hex = Buffer.from(payload).toString("hex");
      execSync(
        `security add-generic-password -U -a "${user}" -s "${service}" -X "${hex}"`,
        { stdio: ["pipe", "pipe", "pipe"] }
      );
      if (verbose) log("OAuth token refreshed and saved to keychain");
    } catch (e) {
      if (verbose) log(`Warning: could not update keychain: ${e.message}`);
    }
  } else {
    if (verbose) log(`OAuth token valid (${Math.floor(expiresIn)}s remaining, plan: ${oauth.subscriptionType})`);
  }

  // Return the access token directly — the API accepts Bearer auth
  // with the "anthropic-beta: oauth-2025-04-20" header
  return { authToken: accessToken, subscriptionType: oauth.subscriptionType };
}

// ── OAuth Login (full PKCE flow) ─────────────────────────────────

export const OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const OAUTH_SCOPES = "user:inference user:profile user:sessions:claude_code user:mcp_servers";

export function generatePKCE() {
  // code_verifier: 43-128 chars from [A-Za-z0-9-._~]
  const verifier = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  // code_challenge: SHA256(verifier) base64url-encoded
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

export function openBrowser(url) {
  try {
    if (process.platform === "darwin") execSync(`open "${url}"`, { stdio: "ignore" });
    else if (process.platform === "linux") execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    else process.stderr.write(`Open this URL in your browser:\n${url}\n`);
  } catch {
    process.stderr.write(`Open this URL in your browser:\n${url}\n`);
  }
}

export function saveKeychainCredentials(data) {
  const user = process.env.USER || os.userInfo().username;
  const service = "Claude Code-credentials";
  const payload = JSON.stringify(data);
  const hex = Buffer.from(payload).toString("hex");
  execSync(
    `security add-generic-password -U -a "${user}" -s "${service}" -X "${hex}"`,
    { stdio: ["pipe", "pipe", "pipe"] }
  );
}

export async function oauthLogin() {
  process.stderr.write("Logging in to Claude...\n\n");

  const { verifier, challenge } = generatePKCE();
  const state = randomUUID();

  // Find a free port
  const server = createServer();
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  const redirectUri = `http://localhost:${port}/callback`;

  // Build authorization URL
  const authUrl = new URL(OAUTH_AUTHORIZE_URL);
  authUrl.searchParams.set("code", "true");
  authUrl.searchParams.set("client_id", OAUTH_CLIENT_ID);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", OAUTH_SCOPES);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  process.stderr.write(`Opening browser for authentication...\n`);
  openBrowser(authUrl.toString());
  process.stderr.write(`\nWaiting for callback on port ${port}...\n`);
  process.stderr.write(`\x1b[2m(If browser didn't open, visit: ${authUrl.toString()})\x1b[0m\n\n`);

  // Wait for the OAuth callback
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("Login timed out (5 minutes)"));
    }, 300000);

    server.on("request", (req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);

      if (url.pathname === "/callback") {
        const callbackCode = url.searchParams.get("code");
        const callbackState = url.searchParams.get("state");

        if (callbackState !== state) {
          res.writeHead(400, { "content-type": "text/html" });
          res.end("<h1>Error: State mismatch</h1><p>Please try logging in again.</p>");
          clearTimeout(timeout);
          server.close();
          reject(new Error("OAuth state mismatch"));
          return;
        }

        if (!callbackCode) {
          const error = url.searchParams.get("error") || "No authorization code received";
          res.writeHead(400, { "content-type": "text/html" });
          res.end(`<h1>Error</h1><p>${error}</p>`);
          clearTimeout(timeout);
          server.close();
          reject(new Error(error));
          return;
        }

        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0">
          <div style="text-align:center">
            <h1 style="color:#7c5cfc">Login successful!</h1>
            <p>You can close this tab and return to the terminal.</p>
          </div>
        </body></html>`);

        clearTimeout(timeout);
        server.close();
        resolve(callbackCode);
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });
  });

  // Exchange authorization code for tokens
  process.stderr.write("Exchanging code for tokens...\n");

  const tokenBody = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: OAUTH_CLIENT_ID,
    code_verifier: verifier,
    state,
  };

  const tokenResp = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(tokenBody),
    signal: AbortSignal.timeout(15000),
  });

  if (!tokenResp.ok) {
    const text = await tokenResp.text().catch(() => "");
    throw new Error(`Token exchange failed (${tokenResp.status}): ${text}`);
  }

  const tokens = await tokenResp.json();

  // Fetch account info
  let accountInfo = {};
  try {
    const infoResp = await fetch("https://api.anthropic.com/api/oauth/claude_cli/roles", {
      headers: { "Authorization": `Bearer ${tokens.access_token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (infoResp.ok) accountInfo = await infoResp.json();
  } catch { /* optional */ }

  // Determine subscription type from account info
  let subscriptionType = null;
  let rateLimitTier = null;
  const orgType = accountInfo?.organization?.organization_type;
  if (orgType === "claude_max") subscriptionType = "max";
  else if (orgType === "claude_pro") subscriptionType = "pro";
  else if (orgType) subscriptionType = orgType;

  // Parse scopes
  const scopes = tokens.scope ? tokens.scope.split(" ").filter(Boolean) : OAUTH_SCOPES.split(" ");

  // Save to keychain
  const credsToSave = {
    claudeAiOauth: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
      scopes,
      subscriptionType,
      rateLimitTier,
    },
  };

  // Merge with existing keychain data (preserve other fields)
  const existing = readKeychainCredentials();
  if (existing) {
    Object.assign(credsToSave, existing, { claudeAiOauth: credsToSave.claudeAiOauth });
  }

  saveKeychainCredentials(credsToSave);

  process.stderr.write(`\n\x1b[32mLogin successful!\x1b[0m\n`);
  if (subscriptionType) {
    process.stderr.write(`Plan: ${subscriptionType}\n`);
  }
  if (accountInfo?.organization?.organization_name) {
    process.stderr.write(`Org: ${accountInfo.organization.organization_name}\n`);
  }
  process.stderr.write(`Scopes: ${scopes.join(", ")}\n`);
  process.stderr.write(`\nCredentials saved to macOS keychain.\n`);
  process.stderr.write(`Run \x1b[1mcloclo\x1b[0m to start.\n`);
}

export function oauthLogout() {
  try {
    const user = process.env.USER || os.userInfo().username;
    const service = "Claude Code-credentials";
    execSync(
      `security delete-generic-password -a "${user}" -s "${service}"`,
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    process.stderr.write("Logged out. Credentials removed from keychain.\n");
  } catch {
    process.stderr.write("No credentials found in keychain.\n");
  }
}
