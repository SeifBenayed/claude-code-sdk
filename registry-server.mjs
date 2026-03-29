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
    _remoteSessions.set(token, { sessionId: session_id, mode: mode || "chat", expiresAt, hostWs: null, clients: new Set(), created: Date.now(), messageBuffer: [], hostDisconnectedAt: null, replayBuffer: [] });
    const baseUrl = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host || "localhost:" + PORT}`;
    log(`Remote registered: ${session_id} → ${token.slice(0, 8)}...`);
    return json(res, 200, { token, url: `${baseUrl}/remote/${token}`, expires_at: expiresAt });
  }

  // Check remote session status
  const statusMatch = pathname.match(/^\/api\/remote\/status\/([a-f0-9]+)$/);
  if (statusMatch && method === "GET") {
    const session = _remoteSessions.get(statusMatch[1]);
    if (!session || new Date(session.expiresAt) < new Date()) return json(res, 404, { error: "Session not found or expired" });
    return json(res, 200, { active: !!session.hostWs, mode: session.mode, clients: session.clients.size, expires_at: session.expiresAt, host_disconnected_at: session.hostDisconnectedAt, pending_messages: session.messageBuffer.length });
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

  // Update remote session mode
  if (pathname === "/api/remote/mode" && method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "Invalid JSON" }); }
    const session = _remoteSessions.get(body.token);
    if (!session) return json(res, 404, { error: "Session not found" });
    const validModes = ["view", "chat", "control", "privileged"];
    if (!validModes.includes(body.mode)) return json(res, 400, { error: "Invalid mode. Use: view, chat, control, privileged" });
    const prevMode = session.mode;
    session.mode = body.mode;
    // Notify all clients of mode change
    _broadcastToClients(session, { type: "mode_changed", mode: body.mode, previous: prevMode });
    log(`Remote mode changed: ${body.token.slice(0, 8)}... ${prevMode} → ${body.mode}`);
    return json(res, 200, { ok: true, mode: body.mode, previous: prevMode });
  }

  // SSE stream endpoint: client subscribes to events from host
  const sseMatch = pathname.match(/^\/api\/remote\/stream\/([a-f0-9]+)$/);
  if (sseMatch && method === "GET") {
    const token = sseMatch[1];
    const session = _remoteSessions.get(token);
    if (!session || new Date(session.expiresAt) < new Date()) return json(res, 410, { error: "Session expired" });
    res.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*", "X-Accel-Buffering": "no",
    });
    res.write(":\n\n"); // comment to establish connection
    // Register this SSE client
    if (!session.sseClients) session.sseClients = new Set();
    session.sseClients.add(res);
    session.clients.add(res); // count SSE as client
    log(`Remote SSE client connected: ${token.slice(0, 8)}... (${session.clients.size} client(s))`);
    if (session.hostWs) _wsSend(session.hostWs, JSON.stringify({ type: "remote_status", clients: session.clients.size }));
    // Replay conversation history to late-joining client
    if (session.replayBuffer.length > 0) {
      for (const msg of session.replayBuffer) _sseSend(res, msg);
    }
    // Keepalive comment every 15s
    const sseKeepAlive = setInterval(() => { try { res.write(":\n\n"); } catch { /* dead */ } }, 15000);
    req.on("close", () => {
      clearInterval(sseKeepAlive);
      session.sseClients?.delete(res);
      session.clients.delete(res);
      log(`Remote SSE client disconnected: ${token.slice(0, 8)}... (${session.clients.size} left)`);
      if (session.hostWs) _wsSend(session.hostWs, JSON.stringify({ type: "remote_status", clients: session.clients.size }));
    });
    return;
  }

  // POST message endpoint: client sends messages to host
  const sendMatch = pathname.match(/^\/api\/remote\/send\/([a-f0-9]+)$/);
  if (sendMatch && method === "POST") {
    const token = sendMatch[1];
    const session = _remoteSessions.get(token);
    if (!session || new Date(session.expiresAt) < new Date()) return json(res, 410, { error: "Session expired" });
    const text = await readBody(req);
    if (session.hostWs) {
      _wsSend(session.hostWs, text);
    } else if (session.messageBuffer.length < 50) {
      session.messageBuffer.push(text);
    }
    return json(res, 200, { ok: true });
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
    const baseUrl = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host || "localhost:" + PORT}`;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(_remoteClientHtml(baseUrl, token, session.mode, session.expiresAt));
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

function _wsParseFrames(buf, onMessage, socket) {
  while (buf.length >= 2) {
    const opcode = buf[0] & 0x0f;
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
    if (opcode === 0x8) return buf; // close frame
    if (opcode === 0x9) { // ping → send pong
      if (socket) { const pong = Buffer.alloc(2); pong[0] = 0x8a; pong[1] = 0; try { socket.write(pong); } catch {} }
      continue;
    }
    if (opcode === 0xa) continue; // pong — ignore
    try { onMessage(payload.toString("utf-8")); } catch { /* bad payload */ }
  }
  return buf;
}

function _wsPing(socket) {
  const frame = Buffer.alloc(2); frame[0] = 0x89; frame[1] = 0;
  try { socket.write(frame); } catch { /* socket dead */ }
}

function _sseSend(res, data) {
  const str = typeof data === "string" ? data : JSON.stringify(data);
  try { res.write(`data: ${str}\n\n`); } catch { /* dead */ }
}

function _broadcastToClients(session, data) {
  const str = typeof data === "string" ? data : JSON.stringify(data);
  // Buffer for replay to late-joining clients (cap at 500)
  session.replayBuffer.push(str);
  if (session.replayBuffer.length > 500) session.replayBuffer = session.replayBuffer.slice(-500);
  for (const client of session.clients) {
    if (session.sseClients?.has(client)) _sseSend(client, str);
    else _wsSend(client, str);
  }
}

// ── Remote Web UI Template ───────────────────────────────────

function _remoteClientHtml(baseUrl, token, mode, expiresAt) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>cloclo remote</title>
<style>
  :root { --bg: #1a1b26; --fg: #a9b1d6; --fg-dim: #565f89; --fg-bright: #c0caf5; --cyan: #7dcfff; --blue: #7aa2f7; --green: #9ece6a; --yellow: #e0af68; --red: #f7768e; --magenta: #bb9af7; --border: #292e42; --surface: #1f2335; --input-bg: #16161e; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', Menlo, Monaco, Consolas, monospace; background: var(--bg); color: var(--fg); height: 100dvh; display: flex; flex-direction: column; font-size: 13px; line-height: 1.6; -webkit-font-smoothing: antialiased; }

  /* ── Status bar (top) ── */
  #statusbar { padding: 6px 12px; background: var(--surface); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 4px; flex-shrink: 0; font-size: 12px; overflow-x: auto; white-space: nowrap; }
  #statusbar .sep { color: var(--fg-dim); margin: 0 4px; }
  #statusbar .label { color: var(--fg-dim); }
  #statusbar .val-cyan { color: var(--cyan); }
  #statusbar .val-green { color: var(--green); }
  #statusbar .val-yellow { color: var(--yellow); }
  #statusbar .val-red { color: var(--red); }
  #statusbar .val-magenta { color: var(--magenta); }

  /* ── Output area ── */
  #output { flex: 1; overflow-y: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 2px; }
  #output::-webkit-scrollbar { width: 6px; }
  #output::-webkit-scrollbar-track { background: transparent; }
  #output::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

  /* Terminal-style message blocks */
  .line { white-space: pre-wrap; word-break: break-word; padding: 1px 0; }
  .line.user-prompt { color: var(--cyan); font-weight: 600; padding: 8px 0 2px; }
  .line.user-prompt::before { content: "> "; color: var(--cyan); }
  .line.assistant { color: var(--fg-bright); }
  .line.tool-call { color: var(--fg-dim); font-size: 12px; padding: 4px 8px; margin: 4px 0; border-left: 2px solid var(--border); background: var(--surface); }
  .line.tool-result { color: var(--fg-dim); font-size: 11px; padding: 2px 8px; border-left: 2px solid var(--border); }
  .line.tool-result.error { border-left-color: var(--red); color: var(--red); }
  .line.system-msg { color: var(--fg-dim); font-size: 11px; font-style: italic; padding: 2px 0; }
  .line.system-msg.warn { color: var(--yellow); }
  .line.system-msg.ok { color: var(--green); }
  .line.system-msg.err { color: var(--red); }
  .line.stats { color: var(--fg-dim); font-size: 11px; padding: 4px 0 8px; }

  /* ── Input area ── */
  #input-area { padding: 8px 12px; background: var(--surface); border-top: 1px solid var(--border); display: flex; gap: 8px; flex-shrink: 0; align-items: flex-end; }
  #input-area .prompt-icon { color: var(--cyan); font-weight: 700; padding: 8px 0; flex-shrink: 0; }
  #prompt { flex: 1; background: var(--input-bg); border: 1px solid var(--border); color: var(--fg-bright); padding: 8px 10px; border-radius: 4px; font-size: 13px; font-family: inherit; outline: none; resize: none; line-height: 1.5; max-height: 120px; }
  #prompt:focus { border-color: var(--blue); }
  #prompt::placeholder { color: var(--fg-dim); }
  #send { background: var(--blue); color: var(--bg); border: none; padding: 8px 14px; border-radius: 4px; font-size: 12px; cursor: pointer; font-weight: 600; font-family: inherit; flex-shrink: 0; }
  #send:hover { background: var(--cyan); }
  #send:active { transform: scale(0.97); }
  #send:disabled { opacity: 0.3; cursor: not-allowed; }
</style>
</head>
<body>
<!-- Status bar like Ink UI -->
<div id="statusbar">
  <span class="val-cyan">cloclo</span>
  <span class="sep">|</span>
  <span class="label">mode:</span><span id="mode-val" class="val-yellow">${mode}</span>
  <span class="sep">|</span>
  <span id="conn-status" class="val-yellow">connecting</span>
  <span class="sep">|</span>
  <span id="expiry" class="label"></span>
</div>

<!-- Terminal output -->
<div id="output"></div>

<!-- Input -->
<div id="input-area">
  <span class="prompt-icon">></span>
  <textarea id="prompt" rows="1" placeholder="${mode === "view" ? "view-only mode" : "Send a message..."}" ${mode === "view" ? "disabled" : ""}></textarea>
  <button id="send" ${mode === "view" ? "disabled" : ""}>Send</button>
</div>

<script>
const BASE = "${baseUrl}";
const TOKEN = "${token}";
const WS_URL = BASE.replace(/^http/, "ws") + "/ws/remote/" + TOKEN;
const STREAM = BASE + "/api/remote/stream/" + TOKEN;
const SEND = BASE + "/api/remote/send/" + TOKEN;
const EXPIRES = "${expiresAt}";
let ws = null, evtSrc = null, curAsst = null, reconnTimer = null;

function connect() {
  if (reconnTimer) { clearTimeout(reconnTimer); reconnTimer = null; }
  // Try WebSocket first, fall back to SSE
  try {
    if (ws) { try { ws.close(); } catch {} }
    ws = new WebSocket(WS_URL);
    ws.onopen = () => setStatus("connected", "green");
    ws.onerror = () => connectSSE();
    ws.onclose = () => { setStatus("disconnected", "red"); reconnTimer = setTimeout(connect, 3000); };
    ws.onmessage = (e) => {
      try { handleMsg(JSON.parse(e.data)); } catch {}
    };
  } catch { connectSSE(); }
}

function connectSSE() {
  if (evtSrc) { try { evtSrc.close(); } catch {} }
  setStatus("connecting", "yellow");
  evtSrc = new EventSource(STREAM);
  evtSrc.onopen = () => setStatus("connected", "green");
  evtSrc.onerror = () => { setStatus("disconnected", "red"); evtSrc.close(); reconnTimer = setTimeout(connect, 3000); };
  evtSrc.onmessage = (e) => {
    try { handleMsg(JSON.parse(e.data)); } catch {}
  };
}

function handleMsg(msg) {
  if (msg.type === "stream" && msg.event_type === "text_delta") {
    if (!curAsst) curAsst = addLine("assistant", "");
    curAsst.textContent += msg.data?.text || "";
    scroll();
  } else if (msg.type === "tool_use") {
    curAsst = null;
    const inp = JSON.stringify(msg.input || {}).slice(0, 300);
    addLine("tool-call", "[" + msg.name + "] " + inp);
  } else if (msg.type === "tool_result") {
    addLine("tool-result" + (msg.is_error ? " error" : ""), msg.is_error ? "[Error]" : "[Done]");
  } else if (msg.type === "response") {
    curAsst = null;
  } else if (msg.type === "error") {
    addLine("system-msg err", msg.message || msg.error || "Error");
  } else if (msg.type === "permission_denied") {
    addLine("system-msg err", "Permission denied: " + (msg.reason || "blocked"));
  } else if (msg.type === "approval_pending") {
    addLine("system-msg warn", "Waiting for host approval: " + (msg.toolName || "action") + "...");
  } else if (msg.type === "approval_resolved") {
    addLine("system-msg " + (msg.approved ? "ok" : "err"), msg.approved ? "Approved" : "Denied" + (msg.reason ? ": " + msg.reason : ""));
  } else if (msg.type === "mode_changed") {
    document.getElementById("mode-val").textContent = msg.mode;
    addLine("system-msg", "mode -> " + msg.mode);
    const v = msg.mode === "view";
    document.getElementById("prompt").disabled = v;
    document.getElementById("send").disabled = v;
    document.getElementById("prompt").placeholder = v ? "view-only mode" : "Send a message...";
  } else if (msg.type === "host_disconnected") {
    addLine("system-msg warn", "Host disconnected. Waiting for reconnect...");
    setStatus("host offline", "yellow");
  } else if (msg.type === "host_reconnected") {
    addLine("system-msg ok", "Host reconnected");
    setStatus("connected", "green");
  }
}

function setStatus(text, color) {
  const el = document.getElementById("conn-status");
  el.textContent = text;
  el.className = "val-" + color;
}

function addLine(cls, text) {
  const el = document.createElement("div");
  el.className = "line " + cls;
  el.textContent = text;
  document.getElementById("output").appendChild(el);
  scroll();
  return el;
}

function scroll() { const o = document.getElementById("output"); o.scrollTop = o.scrollHeight; }

function send() {
  const input = document.getElementById("prompt");
  const text = input.value.trim();
  if (!text) return;
  addLine("user-prompt", text);
  input.value = "";
  input.style.height = "auto";
  curAsst = null;
  fetch(SEND, { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ type: "message", content: text }) }).catch(() => {});
}

document.getElementById("send").onclick = send;
document.getElementById("prompt").onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
};
// Auto-resize textarea
document.getElementById("prompt").oninput = function() {
  this.style.height = "auto";
  this.style.height = Math.min(this.scrollHeight, 120) + "px";
};

setInterval(() => {
  const left = new Date(EXPIRES) - new Date();
  if (left <= 0) { document.getElementById("expiry").textContent = "expired"; return; }
  const m = Math.floor(left / 60000);
  document.getElementById("expiry").textContent = m + "m";
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
// Handles /ws/remote/<token> upgrade requests from both host CLI and web clients

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
    const isReconnect = session.hostDisconnectedAt !== null;
    session.hostWs = socket;
    session.hostDisconnectedAt = null;
    log(`Remote host ${isReconnect ? "re" : ""}connected: ${token.slice(0, 8)}...`);
    // Send pending client count
    _wsSend(socket, { type: "remote_status", clients: session.clients.size });
    // On reconnect, flush buffered messages
    if (isReconnect && session.messageBuffer.length > 0) {
      log(`Flushing ${session.messageBuffer.length} buffered messages to host`);
      for (const buffered of session.messageBuffer) _wsSend(socket, buffered);
      session.messageBuffer = [];
      // Notify clients host is back
      _broadcastToClients(session, { type: "host_reconnected" });
    }
  } else {
    session.clients.add(socket);
    log(`Remote client connected: ${token.slice(0, 8)}... (${session.clients.size} client(s))`);
    // Notify host
    if (session.hostWs) _wsSend(session.hostWs, { type: "remote_status", clients: session.clients.size });
    // Rate limiting state
    socket._lastMessage = 0;
  }

  // Keepalive ping every 25s to prevent Cloud Run / proxy idle timeout
  const pingInterval = setInterval(() => _wsPing(socket), 25000);

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    buf = _wsParseFrames(buf, (text) => {
      if (role === "host") {
        // Host → broadcast to all clients (WS + SSE)
        _broadcastToClients(session, text);
      } else {
        // Ignore application-level keepalive pings from browser clients
        try { if (JSON.parse(text).type === "ping") return; } catch { /* not JSON */ }
        // Client → forward to host (rate limited: 1 msg/sec)
        const now = Date.now();
        if (now - (socket._lastMessage || 0) < 1000) return; // rate limit
        socket._lastMessage = now;
        if (session.hostWs) {
          _wsSend(session.hostWs, text);
        } else if (session.messageBuffer.length < 50) {
          // Buffer messages while host is disconnected (max 50)
          session.messageBuffer.push(text);
        }
      }
    }, socket);
  });

  socket.on("close", () => {
    clearInterval(pingInterval);
    if (role === "host") {
      session.hostWs = null;
      session.hostDisconnectedAt = new Date().toISOString();
      log(`Remote host disconnected: ${token.slice(0, 8)}...`);
      // Notify clients (not error — host may reconnect)
      _broadcastToClients(session, { type: "host_disconnected" });
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
