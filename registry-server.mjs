#!/usr/bin/env node
// registry-server.mjs — Self-hosted cloclo skill registry
//
// Zero npm dependencies. GCS or file-based storage.
//
// Usage:
//   node registry-server.mjs                                    # Local (file storage)
//   GCS_BUCKET=my-bucket node registry-server.mjs               # GCS storage
//   PORT=8080 REGISTRY_TOKENS=tok1,tok2 node registry-server.mjs
//
// API:
//   GET  /api/skills                    List all skills
//   GET  /api/skills/search?q=<query>   Search skills
//   GET  /api/skills/:name              Get skill package
//   POST /api/skills/publish            Publish a skill (auth required)
//   DELETE /api/skills/:name            Unpublish a skill (auth required)
//   GET  /health                        Health check

import { createServer } from "node:http";
import _http from "node:http";
import _https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const PORT = parseInt(process.env.PORT || "8080", 10);
const GCS_BUCKET = process.env.GCS_BUCKET || "";
const DATA_DIR = process.env.REGISTRY_DATA || path.join(os.homedir(), ".cloclo-registry");
const AUTH_TOKENS = (process.env.REGISTRY_TOKENS || "").split(",").filter(Boolean);
const REMOTE_SECRET = process.env.REMOTE_SECRET || crypto.randomBytes(32).toString("hex");

// ── GCS Storage Backend ───────────────────────────────────────

let _gcsToken = null;
let _gcsTokenExpiry = 0;

async function _getGCSToken() {
  if (_gcsToken && Date.now() < _gcsTokenExpiry - 30000) return _gcsToken;
  // Cloud Run metadata server provides tokens automatically
  return new Promise((resolve, reject) => {
    const req = _http.get(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } },
      (res) => {
        let data = "";
        res.on("data", (c) => data += c);
        res.on("end", () => {
          try {
            const tok = JSON.parse(data);
            _gcsToken = tok.access_token;
            _gcsTokenExpiry = Date.now() + (tok.expires_in || 3600) * 1000;
            resolve(_gcsToken);
          } catch (e) { reject(new Error(`Token parse failed: ${data.slice(0, 100)}`)); }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("Metadata timeout")); });
  });
}

function _gcsRequest(method, objectPath, body) {
  return new Promise(async (resolve, reject) => {
    let token;
    try { token = await _getGCSToken(); } catch (e) { return reject(e); }
    const url = `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o${method === "GET" ? `/${encodeURIComponent(objectPath)}?alt=media` : method === "DELETE" ? `/${encodeURIComponent(objectPath)}` : ""}`;
    const opts = {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    };
    if (method === "POST") {
      // Upload via upload endpoint
      const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${GCS_BUCKET}/o?uploadType=media&name=${encodeURIComponent(objectPath)}`;
      const data = typeof body === "string" ? body : JSON.stringify(body);
      const req = _https.request(uploadUrl, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => {
        let d = "";
        res.on("data", (c) => d += c);
        res.on("end", () => res.statusCode < 400 ? resolve(d) : reject(new Error(`GCS ${res.statusCode}: ${d.slice(0, 200)}`)));
      });
      req.on("error", reject);
      req.write(data);
      req.end();
      return;
    }
    const req = _https.request(url, opts, (res) => {
      let d = "";
      res.on("data", (c) => d += c);
      res.on("end", () => res.statusCode < 400 ? resolve(d) : reject(new Error(`GCS ${res.statusCode}`)));
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Storage Interface ─────────────────────────────────────────

const storage = GCS_BUCKET ? {
  async load(key) {
    try { return JSON.parse(await _gcsRequest("GET", key)); }
    catch { return null; }
  },
  async save(key, data) {
    await _gcsRequest("POST", key, data);
  },
  async remove(key) {
    try { await _gcsRequest("DELETE", key); } catch { /* ok */ }
  },
} : {
  // Local file storage
  async load(key) {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, key), "utf-8")); }
    catch { return null; }
  },
  async save(key, data) {
    const p = path.join(DATA_DIR, key);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
  },
  async remove(key) {
    try { fs.unlinkSync(path.join(DATA_DIR, key)); } catch { /* ok */ }
  },
};

// ── Index Cache ───────────────────────────────────────────────
// In-memory cache to avoid reading index on every request

let _indexCache = null;

async function loadIndex() {
  if (_indexCache) return _indexCache;
  _indexCache = (await storage.load("index.json")) || { skills: {} };
  return _indexCache;
}

async function saveIndex(index) {
  _indexCache = index;
  await storage.save("index.json", index);
}

// ── Auth ──────────────────────────────────────────────────────

function checkAuth(req) {
  if (AUTH_TOKENS.length === 0) return true;
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return AUTH_TOKENS.includes(token);
}

// ── Request Helpers ───────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) { req.destroy(new Error("Body too large")); return; }
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function parseUrl(url) {
  const [pathname, qs] = (url || "/").split("?");
  const params = {};
  if (qs) for (const part of qs.split("&")) {
    const [k, ...v] = part.split("=");
    params[decodeURIComponent(k)] = decodeURIComponent(v.join("="));
  }
  return { pathname, params };
}

// ── Routes ────────────────────────────────────────────────────

async function handleRequest(req, res) {
  const { pathname, params } = parseUrl(req.url);
  const method = req.method;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Author");
  if (method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Health
  if (pathname === "/health") {
    const index = await loadIndex();
    return json(res, 200, { status: "ok", skills: Object.keys(index.skills).length, storage: GCS_BUCKET ? "gcs" : "local" });
  }

  // List all skills
  if (pathname === "/api/skills" && method === "GET") {
    const index = await loadIndex();
    const skills = Object.values(index.skills).map(s => ({
      name: s.name, description: s.description, author: s.author,
      version: s.version, publishedAt: s.publishedAt, downloads: s.downloads || 0,
    }));
    return json(res, 200, { skills });
  }

  // Search
  if (pathname === "/api/skills/search" && method === "GET") {
    const q = (params.q || "").toLowerCase();
    const index = await loadIndex();
    const skills = Object.values(index.skills).filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.description || "").toLowerCase().includes(q) ||
      (s.author || "").toLowerCase().includes(q)
    ).map(s => ({
      name: s.name, description: s.description, author: s.author,
      version: s.version, downloads: s.downloads || 0,
    }));
    return json(res, 200, { skills, query: params.q });
  }

  // Get skill package
  const skillMatch = pathname.match(/^\/api\/skills\/([a-zA-Z0-9_-]+)$/);
  if (skillMatch && method === "GET") {
    const name = skillMatch[1];
    const pkg = await storage.load(`skills/${name}.json`);
    if (!pkg) return json(res, 404, { error: `Skill "${name}" not found` });
    // Increment download counter (async, don't block response)
    const index = await loadIndex();
    if (index.skills[name]) {
      index.skills[name].downloads = (index.skills[name].downloads || 0) + 1;
      saveIndex(index).catch(() => {});
    }
    return json(res, 200, pkg);
  }

  // Publish
  if (pathname === "/api/skills/publish" && method === "POST") {
    if (!checkAuth(req)) return json(res, 401, { error: "Unauthorized. Set Authorization: Bearer <token>" });

    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: "Invalid JSON body" }); }

    const { name, description, version, files, checksum, allowedTools, hooks } = body;
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) {
      return json(res, 400, { error: "Invalid skill name. Use alphanumeric, hyphens, underscores." });
    }
    if (!files || !files["SKILL.md"]) {
      return json(res, 400, { error: "Package must contain a SKILL.md file" });
    }

    const author = req.headers["x-author"] || "anonymous";
    const pkg = { name, description, version, author, files, checksum, allowedTools, hooks, publishedAt: new Date().toISOString() };
    await storage.save(`skills/${name}.json`, pkg);

    const index = await loadIndex();
    const prev = index.skills[name];
    index.skills[name] = {
      name, description: description || "", author,
      version: version || "1.0.0",
      publishedAt: pkg.publishedAt, updatedAt: pkg.publishedAt,
      firstPublished: prev?.firstPublished || pkg.publishedAt,
      downloads: prev?.downloads || 0, checksum,
    };
    await saveIndex(index);

    log(`Published: ${name}@${version || "1.0.0"} by ${author}`);
    return json(res, 200, { ok: true, name, version: version || "1.0.0", url: `/api/skills/${name}` });
  }

  // Delete (unpublish)
  if (skillMatch && method === "DELETE") {
    if (!checkAuth(req)) return json(res, 401, { error: "Unauthorized" });
    const name = skillMatch[1];
    const index = await loadIndex();
    if (!index.skills[name]) return json(res, 404, { error: `Skill "${name}" not found` });
    delete index.skills[name];
    await saveIndex(index);
    await storage.remove(`skills/${name}.json`);
    log(`Unpublished: ${name}`);
    return json(res, 200, { ok: true, removed: name });
  }

  // ── Tool Catalog Endpoints ────────────────────────────────────

  // List all tools
  if (pathname === "/api/tools" && method === "GET") {
    const index = await loadIndex();
    const tools = Object.values(index.tools || {}).map(t => ({
      name: t.name, description: t.description, type: t.type, author: t.author,
      version: t.version, category: t.category, publishedAt: t.publishedAt, downloads: t.downloads || 0,
    }));
    return json(res, 200, { tools });
  }

  // Search tools
  if (pathname === "/api/tools/search" && method === "GET") {
    const q = (params.q || "").toLowerCase();
    const index = await loadIndex();
    const tools = Object.values(index.tools || {}).filter(t =>
      t.name.toLowerCase().includes(q) ||
      (t.description || "").toLowerCase().includes(q) ||
      (t.type || "").toLowerCase().includes(q) ||
      (t.category || "").toLowerCase().includes(q) ||
      (t.author || "").toLowerCase().includes(q)
    ).map(t => ({
      name: t.name, description: t.description, type: t.type, author: t.author,
      version: t.version, category: t.category, downloads: t.downloads || 0,
    }));
    return json(res, 200, { tools, query: params.q });
  }

  // Get tool package
  const toolMatch = pathname.match(/^\/api\/tools\/([a-zA-Z0-9_-]+)$/);
  if (toolMatch && method === "GET") {
    const name = toolMatch[1];
    const pkg = await storage.load(`tools/${name}.json`);
    if (!pkg) return json(res, 404, { error: `Tool "${name}" not found` });
    const index = await loadIndex();
    if (index.tools?.[name]) { index.tools[name].downloads = (index.tools[name].downloads || 0) + 1; saveIndex(index).catch(() => {}); }
    return json(res, 200, pkg);
  }

  // Publish tool
  if (pathname === "/api/tools/publish" && method === "POST") {
    if (!checkAuth(req)) return json(res, 401, { error: "Unauthorized. Set Authorization: Bearer <token>" });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "Invalid JSON body" }); }
    const { name, description, type, category, version, toolJson, author: bodyAuthor } = body;
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return json(res, 400, { error: "Invalid tool name" });
    if (!toolJson) return json(res, 400, { error: "Package must contain toolJson (the TOOL.json content)" });
    const author = bodyAuthor || req.headers["x-author"] || "anonymous";
    const pkg = { name, description, type, category, version, author, toolJson, publishedAt: new Date().toISOString() };
    await storage.save(`tools/${name}.json`, pkg);
    const index = await loadIndex();
    if (!index.tools) index.tools = {};
    const prev = index.tools[name];
    index.tools[name] = { name, description: description || "", type: type || "cli", author, category: category || "", version: version || "1.0.0", publishedAt: pkg.publishedAt, updatedAt: pkg.publishedAt, firstPublished: prev?.firstPublished || pkg.publishedAt, downloads: prev?.downloads || 0 };
    await saveIndex(index);
    log(`Published tool: ${name}@${version || "1.0.0"} by ${author}`);
    return json(res, 200, { ok: true, name, version: version || "1.0.0", url: `/api/tools/${name}` });
  }

  // Delete tool
  if (toolMatch && method === "DELETE") {
    if (!checkAuth(req)) return json(res, 401, { error: "Unauthorized" });
    const name = toolMatch[1];
    const index = await loadIndex();
    if (!index.tools?.[name]) return json(res, 404, { error: `Tool "${name}" not found` });
    delete index.tools[name];
    await saveIndex(index);
    await storage.remove(`tools/${name}.json`);
    log(`Unpublished tool: ${name}`);
    return json(res, 200, { ok: true, removed: name });
  }

  // ── Remote Session Endpoints ──────────────────────────────────

  // Register a remote session
  if (pathname === "/api/remote/register" && method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "Invalid JSON" }); }
    const { session_id, mode, expiry_minutes } = body;
    if (!session_id) return json(res, 400, { error: "session_id required" });
    const expiry = (expiry_minutes || 60) * 60 * 1000;
    const expiresAt = new Date(Date.now() + expiry).toISOString();
    const token = crypto.createHmac("sha256", REMOTE_SECRET).update(session_id + "::" + expiresAt).digest("hex").slice(0, 32);
    _remoteSessions.set(token, { sessionId: session_id, mode: mode || "chat", expiresAt, hostWs: null, clients: new Set(), created: Date.now() });
    const baseUrl = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host || "localhost:" + PORT}`;
    log(`Remote registered: ${session_id} → ${token.slice(0, 8)}...`);
    return json(res, 200, { token, url: `${baseUrl}/remote/${token}`, expires_at: expiresAt });
  }

  // Check remote session status
  const statusMatch = pathname.match(/^\/api\/remote\/status\/([a-f0-9]+)$/);
  if (statusMatch && method === "GET") {
    const session = _remoteSessions.get(statusMatch[1]);
    if (!session || new Date(session.expiresAt) < new Date()) return json(res, 404, { error: "Session not found or expired" });
    return json(res, 200, { active: !!session.hostWs, mode: session.mode, clients: session.clients.size, expires_at: session.expiresAt });
  }

  // Revoke a remote session
  if (pathname === "/api/remote/revoke" && method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "Invalid JSON" }); }
    const session = _remoteSessions.get(body.token);
    if (!session) return json(res, 404, { error: "Session not found" });
    // Close all connections
    if (session.hostWs) try { session.hostWs.destroy(); } catch { /* already closed */ }
    for (const ws of session.clients) try { ws.destroy(); } catch { /* already closed */ }
    _remoteSessions.delete(body.token);
    log(`Remote revoked: ${body.token.slice(0, 8)}...`);
    return json(res, 200, { revoked: true });
  }

  // Serve remote web UI
  const remoteMatch = pathname.match(/^\/remote\/([a-f0-9]+)$/);
  if (remoteMatch && method === "GET") {
    const token = remoteMatch[1];
    const session = _remoteSessions.get(token);
    if (!session || new Date(session.expiresAt) < new Date()) {
      res.writeHead(410, { "Content-Type": "text/html" });
      res.end("<html><body style='font-family:system-ui;text-align:center;padding:60px'><h1>Session expired</h1><p>This remote session link is no longer valid.</p></body></html>");
      return;
    }
    const wsUrl = `${req.headers["x-forwarded-proto"] === "https" ? "wss" : "ws"}://${req.headers.host || "localhost:" + PORT}/ws/remote/${token}`;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(_remoteClientHtml(wsUrl, session.mode, session.expiresAt));
    return;
  }

  json(res, 404, { error: "Not found" });
}

// ── Logging ───────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${ts}] ${msg}\n`);
}

// ── Remote Session State ──────────────────────────────────────

const _remoteSessions = new Map(); // token → { sessionId, mode, expiresAt, hostWs, clients: Set<socket>, created }

// Cleanup expired sessions every 60s
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of _remoteSessions) {
    if (new Date(session.expiresAt).getTime() < now) {
      if (session.hostWs) try { session.hostWs.destroy(); } catch { /* ok */ }
      for (const ws of session.clients) try { ws.destroy(); } catch { /* ok */ }
      _remoteSessions.delete(token);
      log(`Remote expired: ${token.slice(0, 8)}...`);
    }
  }
}, 60000);

// ── WebSocket Frame Helpers (raw RFC 6455) ───────────────────

function _wsAccept(key) {
  return crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-5AB5DC11D65B").digest("base64");
}

function _wsSend(socket, data) {
  const payload = Buffer.from(typeof data === "string" ? data : JSON.stringify(data), "utf-8");
  let header;
  if (payload.length < 126) { header = Buffer.alloc(2); header[0] = 0x81; header[1] = payload.length; }
  else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(payload.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
  try { socket.write(Buffer.concat([header, payload])); } catch { /* socket dead */ }
}

function _wsParseFrames(buf, onMessage) {
  while (buf.length >= 2) {
    const masked = (buf[1] & 0x80) !== 0;
    let pLen = buf[1] & 0x7f; let off = 2;
    if (pLen === 126) { if (buf.length < 4) break; pLen = buf.readUInt16BE(2); off = 4; }
    else if (pLen === 127) { if (buf.length < 10) break; pLen = Number(buf.readBigUInt64BE(2)); off = 10; }
    const maskLen = masked ? 4 : 0;
    if (buf.length < off + maskLen + pLen) break;
    let payload;
    if (masked) {
      const mask = buf.slice(off, off + 4); off += 4;
      payload = Buffer.alloc(pLen);
      for (let i = 0; i < pLen; i++) payload[i] = buf[off + i] ^ mask[i % 4];
    } else { payload = buf.slice(off, off + pLen); }
    buf = buf.slice(off + pLen);
    // Check opcode
    const opcode = buf.length > 0 ? (buf[0] & 0x0f) : 0x1;
    if (opcode === 0x8) return buf; // close frame
    try { onMessage(payload.toString("utf-8")); } catch { /* bad payload */ }
  }
  return buf;
}

// ── Remote Web UI Template ───────────────────────────────────

function _remoteClientHtml(wsUrl, mode, expiresAt) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>cloclo remote</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: #0d1117; color: #c9d1d9; height: 100dvh; display: flex; flex-direction: column; }
  #header { padding: 12px 16px; background: #161b22; border-bottom: 1px solid #30363d; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  #header h1 { font-size: 16px; color: #58a6ff; font-weight: 600; }
  #status { font-size: 12px; padding: 2px 8px; border-radius: 12px; }
  .connected { background: #1b4332; color: #2dd4bf; }
  .disconnected { background: #3b1818; color: #f87171; }
  .connecting { background: #3b3518; color: #fbbf24; }
  #expiry { font-size: 12px; color: #8b949e; margin-left: auto; }
  #messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .msg { padding: 10px 14px; border-radius: 12px; max-width: 85%; line-height: 1.5; white-space: pre-wrap; word-break: break-word; font-size: 14px; }
  .msg.user { background: #1f6feb; color: #fff; align-self: flex-end; border-bottom-right-radius: 4px; }
  .msg.assistant { background: #21262d; border: 1px solid #30363d; align-self: flex-start; border-bottom-left-radius: 4px; }
  .msg.tool { background: #161b22; border: 1px solid #30363d; align-self: flex-start; font-size: 12px; color: #8b949e; font-family: monospace; }
  .msg.system { background: transparent; color: #8b949e; font-size: 12px; text-align: center; align-self: center; }
  #input-area { padding: 12px 16px; background: #161b22; border-top: 1px solid #30363d; display: flex; gap: 8px; flex-shrink: 0; }
  #prompt { flex: 1; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 10px 14px; border-radius: 8px; font-size: 14px; font-family: inherit; outline: none; resize: none; }
  #prompt:focus { border-color: #58a6ff; }
  #send { background: #238636; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; font-size: 14px; cursor: pointer; font-weight: 500; }
  #send:hover { background: #2ea043; }
  #send:disabled { opacity: 0.5; cursor: not-allowed; }
  #mode { font-size: 11px; color: #8b949e; padding: 2px 6px; background: #21262d; border-radius: 4px; }
</style>
</head>
<body>
<div id="header">
  <h1>cloclo</h1>
  <span id="mode">${mode}</span>
  <span id="status" class="connecting">connecting...</span>
  <span id="expiry"></span>
</div>
<div id="messages"></div>
<div id="input-area">
  <textarea id="prompt" rows="1" placeholder="Type a message..." ${mode === "view" ? "disabled" : ""}></textarea>
  <button id="send" ${mode === "view" ? "disabled" : ""}>Send</button>
</div>
<script>
const WS_URL = "${wsUrl}";
const EXPIRES = "${expiresAt}";
let ws, currentAssistant = null, reconnectTimer = null;

function connect() {
  document.getElementById("status").textContent = "connecting...";
  document.getElementById("status").className = "connecting";
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    document.getElementById("status").textContent = "connected";
    document.getElementById("status").className = "connected";
    addMsg("system", "Connected to remote session");
  };
  ws.onclose = () => {
    document.getElementById("status").textContent = "disconnected";
    document.getElementById("status").className = "disconnected";
    reconnectTimer = setTimeout(connect, 3000);
  };
  ws.onerror = () => {};
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "stream" && msg.event_type === "text_delta") {
        if (!currentAssistant) { currentAssistant = addMsg("assistant", ""); }
        currentAssistant.textContent += msg.data?.text || "";
        scrollBottom();
      } else if (msg.type === "tool_use") {
        addMsg("tool", "\\u2699 " + msg.name + " " + JSON.stringify(msg.input || {}).slice(0, 200));
      } else if (msg.type === "response") {
        currentAssistant = null;
      } else if (msg.type === "error") {
        addMsg("system", "\\u26a0 " + (msg.message || msg.error || "Error"));
      }
    } catch {}
  };
}

function addMsg(role, text) {
  const el = document.createElement("div");
  el.className = "msg " + role;
  el.textContent = text;
  document.getElementById("messages").appendChild(el);
  scrollBottom();
  return el;
}

function scrollBottom() { const m = document.getElementById("messages"); m.scrollTop = m.scrollHeight; }

function send() {
  const input = document.getElementById("prompt");
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== 1) return;
  addMsg("user", text);
  ws.send(JSON.stringify({ type: "message", content: text }));
  input.value = "";
  currentAssistant = null;
}

document.getElementById("send").onclick = send;
document.getElementById("prompt").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
};

// Expiry countdown
setInterval(() => {
  const left = new Date(EXPIRES) - new Date();
  if (left <= 0) { document.getElementById("expiry").textContent = "expired"; return; }
  const m = Math.floor(left / 60000);
  document.getElementById("expiry").textContent = m + "m left";
}, 10000);

connect();
</script>
</body>
</html>`;
}

// ── Server ────────────────────────────────────────────────────

if (!GCS_BUCKET) {
  fs.mkdirSync(path.join(DATA_DIR, "skills"), { recursive: true });
}

const server = createServer(async (req, res) => {
  const start = Date.now();
  try {
    await handleRequest(req, res);
  } catch (e) {
    log(`Error: ${e.message}`);
    if (!res.headersSent) json(res, 500, { error: "Internal server error" });
  }
  log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - start}ms`);
});

// ── WebSocket Upgrade Handler ────────────────────────────────

server.on("upgrade", (req, socket, head) => {
  const { pathname } = parseUrl(req.url);
  const wsMatch = pathname.match(/^\/ws\/remote\/([a-f0-9]+)$/);
  if (!wsMatch) { socket.destroy(); return; }

  const token = wsMatch[1];
  const session = _remoteSessions.get(token);
  if (!session || new Date(session.expiresAt) < new Date()) {
    socket.write("HTTP/1.1 410 Gone\r\n\r\n"); socket.destroy(); return;
  }

  // WebSocket handshake
  const key = req.headers["sec-websocket-key"];
  if (!key) { socket.destroy(); return; }
  const accept = _wsAccept(key);
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");

  const role = req.headers["x-remote-role"] === "host" ? "host" : "client";
  let buf = Buffer.alloc(0);

  if (role === "host") {
    session.hostWs = socket;
    log(`Remote host connected: ${token.slice(0, 8)}...`);
    // Send pending client count
    _wsSend(socket, { type: "remote_status", clients: session.clients.size });
  } else {
    session.clients.add(socket);
    log(`Remote client connected: ${token.slice(0, 8)}... (${session.clients.size} client(s))`);
    // Notify host
    if (session.hostWs) _wsSend(session.hostWs, { type: "remote_status", clients: session.clients.size });
    // Rate limiting state
    socket._lastMessage = 0;
  }

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    buf = _wsParseFrames(buf, (text) => {
      if (role === "host") {
        // Host → broadcast to all clients
        for (const client of session.clients) _wsSend(client, text);
      } else {
        // Client → forward to host (rate limited: 1 msg/sec)
        const now = Date.now();
        if (now - (socket._lastMessage || 0) < 1000) return; // rate limit
        socket._lastMessage = now;
        if (session.hostWs) _wsSend(session.hostWs, text);
      }
    });
  });

  socket.on("close", () => {
    if (role === "host") {
      session.hostWs = null;
      log(`Remote host disconnected: ${token.slice(0, 8)}...`);
      // Notify clients
      for (const client of session.clients) _wsSend(client, { type: "error", message: "Host disconnected" });
    } else {
      session.clients.delete(socket);
      log(`Remote client disconnected: ${token.slice(0, 8)}... (${session.clients.size} left)`);
      if (session.hostWs) _wsSend(session.hostWs, { type: "remote_status", clients: session.clients.size });
    }
  });

  socket.on("error", () => { socket.destroy(); });
});

server.listen(PORT, () => {
  log(`cloclo skill registry on :${PORT}`);
  log(`Storage: ${GCS_BUCKET ? `gcs://${GCS_BUCKET}` : DATA_DIR}`);
  log(`Auth: ${AUTH_TOKENS.length > 0 ? `${AUTH_TOKENS.length} token(s)` : "open"}`);
});
