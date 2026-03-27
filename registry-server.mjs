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

const PORT = parseInt(process.env.PORT || "8080", 10);
const GCS_BUCKET = process.env.GCS_BUCKET || "";
const DATA_DIR = process.env.REGISTRY_DATA || path.join(os.homedir(), ".cloclo-registry");
const AUTH_TOKENS = (process.env.REGISTRY_TOKENS || "").split(",").filter(Boolean);

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

  json(res, 404, { error: "Not found" });
}

// ── Logging ───────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${ts}] ${msg}\n`);
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

server.listen(PORT, () => {
  log(`cloclo skill registry on :${PORT}`);
  log(`Storage: ${GCS_BUCKET ? `gcs://${GCS_BUCKET}` : DATA_DIR}`);
  log(`Auth: ${AUTH_TOKENS.length > 0 ? `${AUTH_TOKENS.length} token(s)` : "open"}`);
});
