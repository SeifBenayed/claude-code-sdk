// ── Browser Tool Pack (CDP-native, enterprise) ────────────────────────────
// Note: --disable-blink-features=AutomationControlled removed (deprecated by Chrome, caused warning banner)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import _http from "node:http";
import _https from "node:https";
import { log, sleep, _httpGet } from "./utils.mjs";

const BROWSER_READ_ONLY_ACTIONS = new Set(["get_state","get_text","screenshot","pdf","cookies_get","list_tabs","list_sessions","list_frames","get_events","dropdown_options","extract","switch_tab","get_network_log"]);
const BROWSER_MUTATING_ACTIONS = new Set(["navigate","click_element","type_element","click","fill","send_keys","upload_file","select_dropdown","cookies_set","cookies_clear","new_tab","close_tab","new_session","close_session","back","forward","reload","close","set_dialog_auto_dismiss","inject_script","enable_network_log"]);
const BROWSER_PRIVILEGED_ACTIONS = new Set(["evaluate"]);

const _BROWSER_KEY_MAP = { Enter:{key:"Enter",code:"Enter",kc:13}, Tab:{key:"Tab",code:"Tab",kc:9}, Escape:{key:"Escape",code:"Escape",kc:27}, Backspace:{key:"Backspace",code:"Backspace",kc:8}, Delete:{key:"Delete",code:"Delete",kc:46}, Space:{key:" ",code:"Space",kc:32}, ArrowUp:{key:"ArrowUp",code:"ArrowUp",kc:38}, ArrowDown:{key:"ArrowDown",code:"ArrowDown",kc:40}, ArrowLeft:{key:"ArrowLeft",code:"ArrowLeft",kc:37}, ArrowRight:{key:"ArrowRight",code:"ArrowRight",kc:39}, Home:{key:"Home",code:"Home",kc:36}, End:{key:"End",code:"End",kc:35}, PageUp:{key:"PageUp",code:"PageUp",kc:33}, PageDown:{key:"PageDown",code:"PageDown",kc:34}, F1:{key:"F1",code:"F1",kc:112}, F2:{key:"F2",code:"F2",kc:113}, F3:{key:"F3",code:"F3",kc:114}, F4:{key:"F4",code:"F4",kc:115}, F5:{key:"F5",code:"F5",kc:116}, F6:{key:"F6",code:"F6",kc:117}, F7:{key:"F7",code:"F7",kc:118}, F8:{key:"F8",code:"F8",kc:119}, F9:{key:"F9",code:"F9",kc:120}, F10:{key:"F10",code:"F10",kc:121}, F11:{key:"F11",code:"F11",kc:122}, F12:{key:"F12",code:"F12",kc:123} };

class BrowserSession {
  constructor(id = "default", opts = {}) {
    this._id = id; this._proc = null; this._ws = null; this._cmdId = 0;
    this._callbacks = new Map(); this._eventHandlers = new Map();
    this._tabs = new Map(); // targetId → {targetId, cdpSessionId, url, title}
    this._activeTabId = null; this._mode = null; // "launch" | "attach"
    this._url = ""; this._title = ""; this._consoleErrors = [];
    this._screenshotPath = null; this._debugPort = 9222 + Math.floor(Math.random() * 1000);
    this._actionHistory = []; this._events = []; // ring buffer, max 50
    this._dialogAutoDismiss = true; this._networkLog = []; this._networkLogEnabled = false;
    this._networkBodies = new Map(); // requestId → {url, method, status, headers, body, size, mimeType, ts}
    this._profileName = opts.profileName || null;
    this._userDataDir = opts.userDataDir || null;
    this._profileDir = opts.profileDir || null;
    this._cdpUrl = opts.cdpUrl || null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  async ensureBrowser() {
    if (this._ws) return;
    const cdpUrl = this._cdpUrl || process.env.BROWSER_CDP_URL;
    if (cdpUrl) {
      try {
        await this._attachRemote(cdpUrl);
        return;
      } catch (e) {
        // Attach failed — auto-launch Chrome with remote debugging and retry
        log(`[browser] Attach to ${cdpUrl} failed (${e.message}), auto-launching Chrome...`);
        const port = parseInt(cdpUrl.match(/:(\d+)/)?.[1] || "9222", 10);
        await this._autoLaunchForAttach(port);
        await this._attachRemote(cdpUrl);
        return;
      }
    }
    await this._launchBrowser();
  }

  // Auto-launch Chrome with user's real profile + remote debugging
  // so skills that need login state (chatgpt-search, etc.) work out of the box.
  async _autoLaunchForAttach(port = 9222) {
    const paths = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/opt/homebrew/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].filter(Boolean);
    let cp = null;
    for (const p of paths) { if (fs.existsSync(p)) { cp = p; break; } }
    if (!cp) throw new Error("Chrome/Chromium not found. Set CHROME_PATH or install Chrome.");

    // Use a dedicated profile that inherits from the default to avoid locking the user's main profile
    const profileDir = path.join(os.homedir(), ".claude", "browser-profiles", "auto-attach");
    fs.mkdirSync(profileDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
    ];

    // Check if user wants headless (default: no, for login state)
    if (process.env.BROWSER_HEADLESS === "1") {
      args.push("--headless=new", "--disable-gpu");
    }

    args.push("about:blank");

    this._autoLaunchedProc = spawn(cp, args, { stdio: "pipe", detached: true });
    this._autoLaunchedProc.unref(); // don't keep cloclo alive
    this._autoLaunchedProc.on("error", () => { /* ignore spawn errors */ });
    this._autoLaunchedProc.stderr?.on("data", () => { /* suppress noise */ });

    // Wait for CDP to be ready
    for (let i = 0; i < 30; i++) {
      await sleep(300);
      try {
        await _httpGet(`http://127.0.0.1:${port}/json/version`);
        log(`[browser] Chrome auto-launched on port ${port}`);
        return;
      } catch { /* not ready yet */ }
    }
    throw new Error(`Chrome launched but CDP not available on port ${port} after 9s`);
  }

  async _launchBrowser() {
    this._mode = "launch";

    // Check if a cloclo Chrome is already running — reuse it instead of launching a new one
    try {
      const existing = execSync("ps aux | grep 'Chrome.*remote-debugging-port' | grep -v grep | head -1", { encoding: "utf-8", stdio: "pipe" }).trim();
      if (existing) {
        const portMatch = existing.match(/--remote-debugging-port=(\d+)/);
        if (portMatch) {
          const port = parseInt(portMatch[1], 10);
          try {
            const resp = await _httpGet(`http://127.0.0.1:${port}/json/version`);
            const info = JSON.parse(resp);
            if (info.webSocketDebuggerUrl) {
              log(`[browser] Reusing existing Chrome on port ${port}`);
              this._debugPort = port;
              await this._connectWs(info.webSocketDebuggerUrl);
              await this._send("Target.setDiscoverTargets", { discover: true });
              this._setupTargetListeners();
              const targetsResp = await this._send("Target.getTargets");
              const pages = (targetsResp?.targetInfos || []).filter(t => t.type === "page");
              for (const page of pages) await this._attachToTarget(page.targetId);
              return;
            }
          } catch { /* CDP not reachable, launch new */ }
        }
      }
    } catch { /* ps failed, proceed with launch */ }

    const paths = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/opt/homebrew/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/chromium", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"].filter(Boolean);
    let cp = null; for (const p of paths) { if (fs.existsSync(p)) { cp = p; break; } } if (!cp) throw new Error("Chrome/Chromium not found.\n  Install Chrome or set CHROME_PATH=/path/to/chrome\n  macOS: brew install --cask google-chrome\n  Linux: apt install chromium-browser");
    const headless = process.env.BROWSER_HEADLESS === "1";

    // Resolve user data dir
    let dataDir = this._userDataDir;
    if (!dataDir) {
      if (this._profileName) {
        dataDir = path.join(os.homedir(), ".claude", "browser-profiles", this._profileName);
        fs.mkdirSync(dataDir, { recursive: true });
      } else if (headless) {
        dataDir = path.join(os.tmpdir(), "cloclo-browser-" + this._debugPort);
      } else {
        // Use the user's real Chrome profile for visible mode (keeps cookies/sessions)
        dataDir = this._detectChromeUserDataDir();
      }
    }

    // No need to close existing Chrome — we use a separate user-data-dir
    // that syncs cookies from the real profile

    const args = [`--remote-debugging-port=${this._debugPort}`, "--no-first-run", `--user-data-dir=${dataDir}`, "--window-size=1280,720"];
    if (headless) {
      args.push("--headless=new", "--disable-gpu", "--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36");
    }
    if (this._profileDir) args.push(`--profile-directory=${this._profileDir}`);
    args.push("about:blank");
    this._proc = spawn(cp, args, { stdio: "pipe", detached: !headless });
    if (!headless) this._proc.unref();
    this._proc.on("error", () => {}); this._proc.stderr?.on("data", () => {});
    // Connect to browser-level WS via /json/version
    let browserWsUrl = null;
    for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 200)); try { const resp = await _httpGet(`http://127.0.0.1:${this._debugPort}/json/version`); const info = JSON.parse(resp); if (info.webSocketDebuggerUrl) { browserWsUrl = info.webSocketDebuggerUrl; break; } } catch { /* not ready */ } }
    if (!browserWsUrl) throw new Error("Chrome failed to start CDP");
    await this._connectWs(browserWsUrl);
    await this._send("Target.setDiscoverTargets", { discover: true });
    this._setupTargetListeners();
    // Attach to existing page targets
    const resp = await this._send("Target.getTargets");
    const pages = (resp?.targetInfos || []).filter(t => t.type === "page");
    for (const page of pages) await this._attachToTarget(page.targetId);
  }

  _detectChromeUserDataDir() {
    // Chrome requires a non-default user-data-dir for remote debugging.
    // We use a cloclo-specific dir but sync cookies/login state from the real Chrome profile.
    const clocloDir = path.join(os.homedir(), ".claude", "browser-profiles", "default");
    fs.mkdirSync(path.join(clocloDir, "Default"), { recursive: true });

    // Find the user's real Chrome profile to copy login state from
    let realDir = null;
    if (process.platform === "darwin") {
      realDir = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
    } else if (process.platform === "linux") {
      realDir = path.join(os.homedir(), ".config", "google-chrome");
      if (!fs.existsSync(realDir)) realDir = path.join(os.homedir(), ".config", "chromium");
    } else if (process.platform === "win32") {
      realDir = path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data");
    }

    // Sync key files that carry login state (cookies, local storage, extensions)
    if (realDir && fs.existsSync(realDir)) {
      const filesToSync = [
        "Default/Cookies",
        "Default/Login Data",
        "Default/Web Data",
        "Default/Preferences",
        "Default/Secure Preferences",
        "Default/Local Storage",
        "Default/Session Storage",
        "Default/Extension Cookies",
        "Local State",
      ];
      for (const rel of filesToSync) {
        const src = path.join(realDir, rel);
        const dst = path.join(clocloDir, rel);
        try {
          if (!fs.existsSync(src)) continue;
          const srcStat = fs.statSync(src);
          if (srcStat.isDirectory()) {
            // Copy directory recursively
            fs.cpSync(src, dst, { recursive: true, force: true });
          } else {
            // Only copy if source is newer
            const dstExists = fs.existsSync(dst);
            if (!dstExists || fs.statSync(dst).mtimeMs < srcStat.mtimeMs) {
              fs.mkdirSync(path.dirname(dst), { recursive: true });
              fs.copyFileSync(src, dst);
            }
          }
        } catch (e) { log(`[browser] Sync ${rel}: ${e.message}`); }
      }
      // Also sync extensions so the same extensions are available
      const extSrc = path.join(realDir, "Default", "Extensions");
      const extDst = path.join(clocloDir, "Default", "Extensions");
      try {
        if (fs.existsSync(extSrc) && !fs.existsSync(extDst)) {
          fs.cpSync(extSrc, extDst, { recursive: true });
          log("[browser] Synced extensions from real Chrome profile");
        }
      } catch { /* ignore */ }
      log("[browser] Synced login state from real Chrome profile");
    }

    return clocloDir;
  }

  async _closeExistingChrome() {
    // Check if Chrome is actually running first
    try {
      const check = execSync("pgrep -x 'Google Chrome' 2>/dev/null || true", { encoding: "utf-8", stdio: "pipe" }).trim();
      if (!check) { log("[browser] Chrome not running, skipping close"); return; }
    } catch { return; }

    log("[browser] Closing Chrome to reopen with CDP...");
    try {
      // Step 1: Try graceful quit via AppleScript
      if (process.platform === "darwin") {
        execSync('osascript -e \'tell application "Google Chrome" to quit\' 2>/dev/null', { timeout: 3000, stdio: "pipe" });
      } else {
        execSync("pkill -TERM -f 'google-chrome|chromium' 2>/dev/null || true", { timeout: 3000, stdio: "pipe" });
      }

      // Step 2: Wait up to 5s for graceful exit
      for (let i = 0; i < 10; i++) {
        await sleep(500);
        try {
          const result = execSync("pgrep -x 'Google Chrome' 2>/dev/null || true", { encoding: "utf-8", stdio: "pipe" }).trim();
          if (!result) { log("[browser] Chrome closed gracefully"); return; }
        } catch { return; }
      }

      // Step 3: Force kill if graceful quit didn't work (confirmation dialog, etc.)
      log("[browser] Graceful quit timed out, force closing...");
      if (process.platform === "darwin") {
        execSync("pkill -9 'Google Chrome' 2>/dev/null || true", { timeout: 3000, stdio: "pipe" });
      } else {
        execSync("pkill -9 -f 'google-chrome|chromium' 2>/dev/null || true", { timeout: 3000, stdio: "pipe" });
      }

      // Step 4: Wait for force kill to take effect
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        try {
          const result = execSync("pgrep -x 'Google Chrome' 2>/dev/null || true", { encoding: "utf-8", stdio: "pipe" }).trim();
          if (!result) { log("[browser] Chrome force-closed"); return; }
        } catch { return; }
      }
      log("[browser] Chrome still running after force kill, proceeding anyway");
    } catch (e) {
      log(`[browser] Could not close Chrome: ${e.message}`);
    }

    // Clean up stale lock files left by killed Chrome
    try {
      const profileDir = this._detectChromeUserDataDir();
      for (const lockFile of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        const lockPath = path.join(profileDir, lockFile);
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
          log(`[browser] Removed stale ${lockFile}`);
        }
      }
    } catch { /* ignore lock cleanup errors */ }
  }

  async _attachRemote(cdpUrl) {
    this._mode = "attach";
    let browserWsUrl;
    if (cdpUrl.startsWith("ws://") || cdpUrl.startsWith("wss://")) {
      browserWsUrl = cdpUrl;
    } else {
      const base = cdpUrl.replace(/\/$/, "").replace(/^ws/, "http");
      const resp = await _httpGet(`${base}/json/version`);
      browserWsUrl = JSON.parse(resp).webSocketDebuggerUrl;
    }
    if (!browserWsUrl) throw new Error("Could not resolve browser WS URL from: " + cdpUrl);
    await this._connectWs(browserWsUrl);
    await this._send("Target.setDiscoverTargets", { discover: true });
    this._setupTargetListeners();
    const resp = await this._send("Target.getTargets");
    const pages = (resp?.targetInfos || []).filter(t => t.type === "page");
    for (const page of pages) await this._attachToTarget(page.targetId);
  }

  async _attachToTarget(targetId) {
    const resp = await this._send("Target.attachToTarget", { targetId, flatten: true });
    const cdpSessionId = resp?.sessionId;
    if (!cdpSessionId) return null;
    this._tabs.set(targetId, { targetId, cdpSessionId, url: "", title: "" });
    if (!this._activeTabId) this._activeTabId = targetId;
    await this._send("Runtime.enable", {}, cdpSessionId);
    await this._send("Page.enable", {}, cdpSessionId);
    await this._send("DOM.enable", {}, cdpSessionId);
    this._setupPageListeners(cdpSessionId, targetId);
    // Try to set download behavior (domain may vary across Chrome versions)
    try { await this._send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: path.join(os.tmpdir(), "cloclo-downloads") }, cdpSessionId); } catch { /* older Chrome */ }
    try { await this._send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: path.join(os.tmpdir(), "cloclo-downloads") }, cdpSessionId); } catch { /* fallback */ }
    // Auto-enable network log on new tabs if already active
    if (this._networkLogEnabled) { try { await this._enableNetworkOnSession(cdpSessionId); } catch { /* non-critical */ } }
    return targetId;
  }

  _activeCdpSession() { if (!this._activeTabId) return null; return this._tabs.get(this._activeTabId)?.cdpSessionId || null; }

  async close() {
    for (const [, tab] of this._tabs) { try { await this._send("Target.detachFromTarget", { sessionId: tab.cdpSessionId }); } catch { /* already detached */ } }
    this._tabs.clear(); this._activeTabId = null;
    if (this._ws) { try { this._ws.destroy(); } catch { /* already closed */ } this._ws = null; }
    if (this._mode === "launch" && this._proc) { try { this._proc.kill("SIGTERM"); } catch { /* already dead */ } this._proc = null; }
    this._url = ""; this._title = ""; return "Browser closed.";
  }

  // ── Tab Management ────────────────────────────────────────────

  async newTab(url) {
    const resp = await this._send("Target.createTarget", { url: url || "about:blank" });
    const targetId = resp?.targetId;
    if (!targetId) throw new Error("Failed to create new tab");
    await this._attachToTarget(targetId);
    this._activeTabId = targetId;
    if (url && url !== "about:blank") {
      await new Promise(r => setTimeout(r, 800));
      try { const info = JSON.parse(await this._eval("JSON.stringify({url:location.href,title:document.title})")); const tab = this._tabs.get(targetId); if (tab) { tab.url = info.url; tab.title = info.title; } } catch { /* page still loading */ }
    }
    return `New tab: ${targetId}${url ? " → " + url : ""}`;
  }

  async switchTab(tabId) {
    if (!this._tabs.has(tabId)) return `Tab not found: ${tabId}`;
    this._activeTabId = tabId;
    await this._send("Target.activateTarget", { targetId: tabId });
    const tab = this._tabs.get(tabId);
    return `Switched to tab: ${tabId} (${tab?.url || "about:blank"})`;
  }

  async closeTab(tabId) {
    const tid = tabId || this._activeTabId;
    if (!tid || !this._tabs.has(tid)) return `Tab not found: ${tid}`;
    await this._send("Target.closeTarget", { targetId: tid });
    this._tabs.delete(tid);
    if (this._activeTabId === tid) { const next = this._tabs.keys().next().value; this._activeTabId = next || null; }
    return `Closed tab: ${tid}`;
  }

  listTabs() { return Array.from(this._tabs.entries()).map(([id, t]) => ({ id, url: t.url, title: t.title, active: id === this._activeTabId })); }

  // ── Navigation ────────────────────────────────────────────────

  async navigate(url) {
    const sid = this._activeCdpSession();
    await this._send("Page.navigate", { url }, sid); await new Promise(r => setTimeout(r, 800));
    const info = await this._eval("JSON.stringify({url:location.href,title:document.title})");
    try { const p = JSON.parse(info); this._url = p.url; this._title = p.title; const tab = this._tabs.get(this._activeTabId); if (tab) { tab.url = p.url; tab.title = p.title; } } catch { this._url = url; }
    return `Navigated to: ${this._url}\nTitle: ${this._title}`;
  }

  async back() { await this._eval("history.back()"); await new Promise(r => setTimeout(r, 500)); return "Back"; }
  async forward() { await this._eval("history.forward()"); await new Promise(r => setTimeout(r, 500)); return "Forward"; }
  async reload() { await this._send("Page.reload", {}, this._activeCdpSession()); await new Promise(r => setTimeout(r, 800)); return "Reloaded"; }

  // ── State / Observation ───────────────────────────────────────

  async getState(format) {
    const js = `(()=>{const els=document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[onclick],[tabindex]');const items=[];let lk=0,inp=0,btn=0;els.forEach((el,i)=>{const tag=el.tagName.toLowerCase();const text=(el.textContent||el.value||el.placeholder||el.getAttribute('aria-label')||'').trim().slice(0,80);const type=el.type||'';const href=el.href||'';const name=el.name||'';if(tag==='a')lk++;if(tag==='input'||tag==='textarea'||tag==='select')inp++;if(tag==='button'||el.getAttribute('role')==='button')btn++;if(text||href||name)items.push({i,tag,type,name,text,href});});return JSON.stringify({url:location.href,title:document.title,scroll:{y:window.scrollY,h:document.documentElement.scrollHeight,vw:window.innerWidth,vh:window.innerHeight},text:document.body?.innerText?.slice(0,3000)||'',elements:items.slice(0,60),stats:{total:items.length,links:lk,inputs:inp,buttons:btn}});})()`;
    const raw = await this._eval(js);
    try {
      const s = JSON.parse(raw); this._url = s.url; this._title = s.title;
      const tab = this._tabs.get(this._activeTabId); if (tab) { tab.url = s.url; tab.title = s.title; }
      if (format === "json") {
        return JSON.stringify({ url: s.url, title: s.title, scroll: { y: s.scroll.y, height: s.scroll.h, vw: s.scroll.vw, vh: s.scroll.vh }, stats: s.stats, elements: s.elements.map(e => ({ index: e.i, tag: e.tag, ...(e.type ? { type: e.type } : {}), ...(e.name ? { name: e.name } : {}), text: e.text, ...(e.href ? { href: e.href } : {}) })), text: s.text, session_id: this._id, active_tab_id: this._activeTabId }, null, 2);
      }
      const elLines = s.elements.map(e => `[${e.i}] <${e.tag}${e.type ? ":" + e.type : ""}>${e.name ? ' name="' + e.name + '"' : ""} "${e.text}"${e.href ? " -> " + e.href : ""}`);
      return [`URL: ${s.url}`, `Title: ${s.title}`, `Scroll: ${s.scroll.y}/${s.scroll.h} (${s.scroll.vw}x${s.scroll.vh})`, `Interactive: ${s.stats.total} (links:${s.stats.links} inputs:${s.stats.inputs} buttons:${s.stats.buttons})`, "", "=== DOM ===", ...elLines, "", s.text ? "=== Text ===" : "", s.text?.slice(0, 2000) || ""].join("\n");
    } catch { return raw; }
  }

  async getText(selector) { if (!selector) return (await this._eval("document.body?.innerText?.slice(0,10000)||''")).slice(0, 10000); return await this._eval(`(document.querySelector(${JSON.stringify(selector)})?.textContent||'not found')`); }

  async screenshot(op) {
    const sid = this._activeCdpSession();
    const r = await this._send("Page.captureScreenshot", { format: "png" }, sid);
    if (!r?.data) throw new Error("Screenshot failed");
    const dir = path.join(os.tmpdir(), "cloclo-screenshots"); fs.mkdirSync(dir, { recursive: true });
    const fp = op || path.join(dir, `screenshot-${Date.now()}.png`);
    fs.writeFileSync(fp, Buffer.from(r.data, "base64")); this._screenshotPath = fp;
    return `Screenshot saved: ${fp} (${(fs.statSync(fp).size / 1024).toFixed(1)} KB)`;
  }

  // ── Interaction ───────────────────────────────────────────────

  async clickElement(index, frameId) {
    const r = await this._eval(`(()=>{const els=document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[onclick],[tabindex]');const el=els[${index}];if(!el)return 'not found';el.scrollIntoView({block:"center"});el.click();return 'clicked [${index}] <'+el.tagName.toLowerCase()+'> "'+(el.textContent||'').trim().slice(0,40)+'"';})()`, frameId);
    await new Promise(r => setTimeout(r, 300)); return r;
  }

  async typeElement(index, value, frameId) {
    const sid = this._activeCdpSession();
    await this._eval(`(()=>{const els=document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[onclick],[tabindex]');const el=els[${index}];if(el){el.focus();el.value='';}})()`, frameId);
    for (const c of value) { await this._send("Input.dispatchKeyEvent", { type: "keyDown", text: c, key: c }, sid); await this._send("Input.dispatchKeyEvent", { type: "keyUp", key: c }, sid); }
    return `Typed '${value}' into [${index}]`;
  }

  async click(selector, frameId) {
    const r = await this._eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return 'not found';el.scrollIntoView({block:"center"});el.click();return 'clicked '+el.tagName.toLowerCase();})()`, frameId);
    await new Promise(r => setTimeout(r, 300)); return r;
  }

  async fill(selector, value, frameId) {
    await this._eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(el){el.focus();el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));}})()`, frameId);
    return `Filled ${selector}`;
  }

  async sendKeys(keys) {
    const sid = this._activeCdpSession();
    const parts = keys.split(" ");
    for (const part of parts) {
      const segs = part.split("+"); const keyName = segs.pop();
      const modBits = (segs.includes("Alt") ? 1 : 0) | (segs.includes("Ctrl") ? 2 : 0) | (segs.includes("Meta") || segs.includes("Cmd") ? 4 : 0) | (segs.includes("Shift") ? 8 : 0);
      const mapped = _BROWSER_KEY_MAP[keyName];
      if (mapped) {
        await this._send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: mapped.key, code: mapped.code, windowsVirtualKeyCode: mapped.kc, modifiers: modBits }, sid);
        await this._send("Input.dispatchKeyEvent", { type: "keyUp", key: mapped.key, code: mapped.code, windowsVirtualKeyCode: mapped.kc, modifiers: modBits }, sid);
      } else {
        for (const c of keyName) {
          await this._send("Input.dispatchKeyEvent", { type: "keyDown", text: c, key: c, modifiers: modBits }, sid);
          await this._send("Input.dispatchKeyEvent", { type: "keyUp", key: c, modifiers: modBits }, sid);
        }
      }
    }
    return `Sent keys: ${keys}`;
  }

  async uploadFile(selector, filePath, frameId) {
    const sid = this._activeCdpSession();
    const { root } = await this._send("DOM.getDocument", {}, sid) || {};
    if (!root) return "DOM not available";
    const { nodeId } = await this._send("DOM.querySelector", { nodeId: root.nodeId, selector }, sid) || {};
    if (!nodeId) return `File input not found: ${selector}`;
    await this._send("DOM.setFileInputFiles", { files: [path.resolve(filePath)], nodeId }, sid);
    return `Uploaded ${path.basename(filePath)} to ${selector}`;
  }

  async selectDropdown(selector, value, frameId) {
    return await this._eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return 'not found';el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('change',{bubbles:true}));return 'selected '+${JSON.stringify(value)};})()`, frameId);
  }

  async dropdownOptions(selector, frameId) {
    return await this._eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.tagName!=='SELECT')return JSON.stringify([]);return JSON.stringify(Array.from(el.options).map(o=>({value:o.value,text:o.textContent.trim(),selected:o.selected})));})()`, frameId);
  }

  async extract(schema, frameId) {
    const js = `(()=>{const s=${JSON.stringify(schema)};const r={};for(const[k,sel] of Object.entries(s)){const el=document.querySelector(sel);r[k]=el?el.textContent.trim():null;}return JSON.stringify(r);})()`;
    return await this._eval(js, frameId);
  }

  async evaluate(js, frameId) { return await this._eval(js, frameId); }

  async waitFor(selector, t) { const start = Date.now(); while (Date.now() - start < t) { if ((await this._eval(`!!document.querySelector(${JSON.stringify(selector)})`)) === "true") return `Found: ${selector} (${Date.now() - start}ms)`; await new Promise(r => setTimeout(r, 200)); } return `Timeout: ${selector} not found after ${t}ms`; }

  async scrollTo(sel, px) { if (sel) { await this._eval(`document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({block:"center"})`); return `Scrolled to: ${sel}`; } await this._eval(`window.scrollBy(0,${px || 500})`); return "Scrolled"; }

  // ── Cookies ───────────────────────────────────────────────────

  async cookiesGet() { const sid = this._activeCdpSession(); const r = await this._send("Network.getCookies", {}, sid); return JSON.stringify(r?.cookies?.slice(0, 30) || [], null, 2); }
  async cookiesSet(n, v, d, p) { const sid = this._activeCdpSession(); await this._send("Network.setCookie", { name: n, value: v, domain: d, path: p || "/" }, sid); return `Cookie set: ${n}=${v}`; }
  async cookiesClear() { const sid = this._activeCdpSession(); await this._send("Network.clearBrowserCookies", {}, sid); return "Cookies cleared"; }

  // ── Frames ────────────────────────────────────────────────────

  async listFrames() {
    const sid = this._activeCdpSession();
    const resp = await this._send("Page.getFrameTree", {}, sid);
    const frames = [];
    const walk = (node, parentId) => { frames.push({ frameId: node.frame.id, url: node.frame.url, name: node.frame.name || "", parentFrameId: parentId || null }); for (const child of (node.childFrames || [])) walk(child, node.frame.id); };
    if (resp?.frameTree) walk(resp.frameTree, null);
    return JSON.stringify(frames, null, 2);
  }

  async _evalInFrame(frameId, expr) {
    const sid = this._activeCdpSession();
    const resp = await this._send("Page.createIsolatedWorld", { frameId, worldName: "cloclo" }, sid);
    const ctxId = resp?.executionContextId;
    if (!ctxId) throw new Error("Failed to create isolated world for frame: " + frameId);
    const r = await this._send("Runtime.evaluate", { expression: expr, contextId: ctxId, returnByValue: true }, sid);
    return r?.result?.value !== undefined ? String(r.result.value) : JSON.stringify(r?.result || {});
  }

  // ── Events ────────────────────────────────────────────────────

  _pushEvent(type, payload) {
    this._events.push({ timestamp: new Date().toISOString(), type, session_id: this._id, tab_id: this._activeTabId, payload });
    if (this._events.length > 50) this._events = this._events.slice(-50);
  }

  getEvents() { return JSON.stringify(this._events, null, 2); }
  setDialogAutoDismiss(enabled) { this._dialogAutoDismiss = enabled; return `Dialog auto-dismiss: ${enabled}`; }

  // ── Network Interception (CDP-level, no JS injection) ─────────

  async enableNetworkLog(opts = {}) {
    if (this._networkLogEnabled) return "Network log already enabled.";
    this._networkLogEnabled = true; this._networkLog = []; this._networkBodies = new Map();
    // Enable on ALL current tabs
    for (const [, tab] of this._tabs) await this._enableNetworkOnSession(tab.cdpSessionId);
    const filter = opts.filter || null;
    return `Network log enabled on ${this._tabs.size} tab(s).${filter ? " Filter: " + filter : ""} Captures at CDP level (survives navigation). Auto-enables on new tabs.`;
  }

  async _enableNetworkOnSession(cdpSessionId) {
    await this._send("Network.enable", {}, cdpSessionId);
    // Track requests — use session-prefixed events for multiplexing
    this._onEvent(`${cdpSessionId}:Network.requestWillBeSent`, (params) => {
      this._networkBodies.set(params.requestId, { url: params.request.url, method: params.request.method, postData: params.request.postData?.slice(0, 5000) || null, ts: Date.now(), status: null, mimeType: null, body: null, size: 0 });
    });
    this._onEvent(`${cdpSessionId}:Network.responseReceived`, (params) => {
      const entry = this._networkBodies.get(params.requestId);
      if (entry) { entry.status = params.response.status; entry.mimeType = params.response.mimeType; }
    });
    this._onEvent(`${cdpSessionId}:Network.loadingFinished`, async (params) => {
      const entry = this._networkBodies.get(params.requestId);
      if (!entry) return;
      entry.size = params.encodedDataLength || 0;
      const mime = (entry.mimeType || "").toLowerCase();
      const isText = mime.includes("json") || mime.includes("text") || mime.includes("html") || mime.includes("event-stream") || mime.includes("javascript");
      if (isText && entry.size < 2000000) {
        try {
          const resp = await this._send("Network.getResponseBody", { requestId: params.requestId }, cdpSessionId);
          entry.body = resp?.base64Encoded ? Buffer.from(resp.body, "base64").toString("utf-8") : (resp?.body || null);
        } catch { /* body unavailable */ }
      }
      this._networkLog.push(entry);
      if (this._networkLog.length > 1000) this._networkLog = this._networkLog.slice(-1000);
      this._networkBodies.delete(params.requestId);
    });
  }

  getNetworkLog(filter) {
    let log = this._networkLog;
    if (filter) {
      const f = filter.toLowerCase();
      log = log.filter(e => (e.url || "").toLowerCase().includes(f) || (e.mimeType || "").toLowerCase().includes(f));
    }
    return JSON.stringify(log.map(e => ({ url: e.url, method: e.method, status: e.status, mimeType: e.mimeType, size: e.size, bodyLength: e.body?.length || 0, ts: e.ts, hasBody: !!e.body })), null, 2);
  }

  getNetworkResponseBody(index) {
    if (index < 0 || index >= this._networkLog.length) return "Index out of range";
    const entry = this._networkLog[index];
    return entry.body || `(no body captured for ${entry.url})`;
  }

  // ── Persistent Script Injection (survives navigation) ─────────

  async injectScript(script) {
    const sid = this._activeCdpSession();
    const resp = await this._send("Page.addScriptToEvaluateOnNewDocument", { source: script }, sid);
    return `Script injected (id: ${resp?.identifier || "unknown"}). Will run before page JS on every navigation.`;
  }

  _setupTargetListeners() {
    this._onEvent("Target.targetCreated", (params) => {
      // Track new page targets — auto-attach handled by explicit newTab calls
    });
    this._onEvent("Target.targetDestroyed", (params) => {
      const tid = params.targetId;
      this._tabs.delete(tid);
      if (this._activeTabId === tid) { const next = this._tabs.keys().next().value; this._activeTabId = next || null; }
    });
    this._onEvent("Target.targetInfoChanged", (params) => {
      const info = params.targetInfo;
      if (info && this._tabs.has(info.targetId)) {
        const tab = this._tabs.get(info.targetId);
        tab.url = info.url || tab.url; tab.title = info.title || tab.title;
      }
    });
  }

  _setupPageListeners(cdpSessionId, tabId) {
    // Dialog handler
    this._onEvent(`${cdpSessionId}:Page.javascriptDialogOpening`, (params) => {
      this._pushEvent("dialog", { message: params.message, type: params.type, tab_id: tabId });
      if (this._dialogAutoDismiss) { this._send("Page.handleJavaScriptDialog", { accept: true }, cdpSessionId); }
    });
    // Navigation handler
    this._onEvent(`${cdpSessionId}:Page.frameNavigated`, (params) => {
      if (params.frame?.parentId) return; // only top-level
      const tab = this._tabs.get(tabId);
      if (tab) { tab.url = params.frame?.url || ""; tab.title = ""; }
      this._pushEvent("navigation", { url: params.frame?.url, tab_id: tabId });
    });
    // Crash handler
    this._onEvent(`${cdpSessionId}:Inspector.targetCrashed`, () => { this._pushEvent("crash", { tab_id: tabId }); });
    // Download handlers (domain varies across Chrome versions)
    this._onEvent(`${cdpSessionId}:Page.downloadWillBegin`, (params) => { this._pushEvent("download", { url: params.url, suggestedFilename: params.suggestedFilename, tab_id: tabId }); });
    this._onEvent(`${cdpSessionId}:Browser.downloadWillBegin`, (params) => { this._pushEvent("download", { url: params.url, suggestedFilename: params.suggestedFilename, tab_id: tabId }); });
  }

  // ── Utility ───────────────────────────────────────────────────

  state() { return { open: !!this._ws, url: this._url, title: this._title, mode: this._mode, tabs: this.listTabs() }; }

  _detectLoop(k) {
    const fullKey = `${this._id}:${this._activeTabId}:${k}`;
    this._actionHistory.push(fullKey);
    if (this._actionHistory.length > 20) this._actionHistory = this._actionHistory.slice(-20);
    const n = this._actionHistory.length;
    return n >= 3 && this._actionHistory[n - 1] === this._actionHistory[n - 2] && this._actionHistory[n - 2] === this._actionHistory[n - 3];
  }

  async _eval(expr, frameId) {
    if (frameId) return this._evalInFrame(frameId, expr);
    const sid = this._activeCdpSession();
    const r = await this._send("Runtime.evaluate", { expression: expr, returnByValue: true }, sid);
    return r?.result?.value !== undefined ? String(r.result.value) : JSON.stringify(r?.result || {});
  }

  // ── WebSocket (raw RFC 6455, browser-level with session routing) ──

  _connectWs(wsUrl) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(wsUrl);
      const key = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256))).toString("base64");
      const mod = parsed.protocol === "wss:" ? _https : _http;
      const req = mod.request({ hostname: parsed.hostname, port: parsed.port || (parsed.protocol === "wss:" ? 443 : 80), path: parsed.pathname, headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" } });
      req.on("upgrade", (res, socket) => {
        this._ws = socket; let buf = Buffer.alloc(0);
        socket.on("data", (chunk) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 2) {
            const pLen = buf[1] & 0x7f; let off = 2, len = pLen;
            if (pLen === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
            else if (pLen === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
            if (buf.length < off + len) break;
            const payload = buf.slice(off, off + len).toString("utf-8"); buf = buf.slice(off + len);
            try {
              const msg = JSON.parse(payload);
              if (msg.id !== undefined && this._callbacks.has(msg.id)) { this._callbacks.get(msg.id)(msg.result || msg.error || {}); this._callbacks.delete(msg.id); }
              if (msg.method) {
                // Session-specific event handler (e.g., "CDPsessionId:Page.javascriptDialogOpening")
                if (msg.sessionId) { const sKey = `${msg.sessionId}:${msg.method}`; if (this._eventHandlers.has(sKey)) this._eventHandlers.get(sKey)(msg.params); }
                // Generic event handler
                if (this._eventHandlers.has(msg.method)) this._eventHandlers.get(msg.method)(msg.params);
              }
            } catch { /* non-JSON */ }
          }
        });
        socket.on("close", () => { this._ws = null; });
        socket.on("error", () => { this._ws = null; });
        resolve();
      });
      req.on("error", reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error("WS timeout")); });
      req.end();
    });
  }

  _send(method, params, cdpSessionId) {
    return new Promise((resolve) => {
      if (!this._ws) return resolve({});
      const id = ++this._cmdId;
      const msg = { id, method, params: params || {} };
      if (cdpSessionId) msg.sessionId = cdpSessionId;
      const payload = Buffer.from(JSON.stringify(msg), "utf-8");
      const mask = Buffer.from(Array.from({ length: 4 }, () => Math.floor(Math.random() * 256)));
      let header;
      if (payload.length < 126) { header = Buffer.alloc(2); header[0] = 0x81; header[1] = 0x80 | payload.length; }
      else if (payload.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
      else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(payload.length), 2); }
      const masked = Buffer.alloc(payload.length); for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      this._ws.write(Buffer.concat([header, mask, masked]));
      const timer = setTimeout(() => { this._callbacks.delete(id); resolve({}); }, 10000);
      this._callbacks.set(id, (v) => { clearTimeout(timer); resolve(v); });
    });
  }

  _onEvent(m, h) { this._eventHandlers.set(m, h); }
}

// ── Session Manager ─────────────────────────────────────────────

class BrowserSessionManager {
  constructor() { this._sessions = new Map(); }

  get(id = "default") {
    if (!this._sessions.has(id)) this._sessions.set(id, new BrowserSession(id));
    return this._sessions.get(id);
  }

  async create(id, opts = {}) {
    if (this._sessions.has(id)) await this.close(id);
    const session = new BrowserSession(id, opts);
    this._sessions.set(id, session);
    await session.ensureBrowser();
    return session;
  }

  async close(id) {
    const session = this._sessions.get(id);
    if (session) { await session.close(); this._sessions.delete(id); }
  }

  async closeAll() { for (const [, session] of this._sessions) { await session.close(); } this._sessions.clear(); }

  list() {
    return Array.from(this._sessions.entries()).map(([id, s]) => ({
      id, open: !!s._ws, url: s._url, title: s._title, mode: s._mode, tabs: s.listTabs()
    }));
  }
}

let _sessionManager = null;
function _getSessionManager() { if (!_sessionManager) _sessionManager = new BrowserSessionManager(); return _sessionManager; }

function registerBrowserTools(registry) {
  registry.register("Browser", {
    description: "Browser automation with DOM understanding. Actions: navigate, get_state, click_element, type_element, click, fill, send_keys, upload_file, select_dropdown, dropdown_options, extract, get_text, evaluate, wait_for, scroll_to, screenshot, pdf, cookies_get/set/clear, back, forward, reload, close, new_tab, switch_tab, close_tab, list_tabs, new_session, close_session, list_sessions, list_frames, get_events, set_dialog_auto_dismiss, inject_script, enable_network_log, get_network_log. Always get_state first, then use element indices. Use session_id for multi-session, tab_id for multi-tab, frame_id for iframes. Use inject_script to run JS before page load (persists across navigations). Use enable_network_log + get_network_log for CDP-level request/response capture.",
    input_schema: { type: "object", properties: {
      action: { type: "string", enum: ["navigate","get_state","screenshot","click_element","type_element","click","fill","send_keys","upload_file","select_dropdown","dropdown_options","extract","get_text","evaluate","wait_for","scroll_to","pdf","cookies_get","cookies_set","cookies_clear","back","forward","reload","close","new_tab","switch_tab","close_tab","list_tabs","new_session","close_session","list_sessions","list_frames","get_events","set_dialog_auto_dismiss","inject_script","enable_network_log","get_network_log"], description: "Browser action to perform" },
      url: { type: "string", description: "URL for navigate/new_tab" },
      index: { type: "integer", description: "Element index from get_state" },
      selector: { type: "string", description: "CSS selector" },
      value: { type: "string", description: "Text value for typing/filling/evaluate/scroll_to" },
      output_path: { type: "string", description: "Output path for screenshot/pdf" },
      timeout: { type: "integer", description: "Timeout in ms for wait_for" },
      cookie: { type: "object", properties: { name: { type: "string" }, value: { type: "string" }, domain: { type: "string" }, path: { type: "string" } }, description: "Cookie for cookies_set" },
      session_id: { type: "string", description: "Session ID (default: 'default'). Use for multi-session workflows." },
      tab_id: { type: "string", description: "Tab ID for switch_tab/close_tab" },
      frame_id: { type: "string", description: "Frame ID for iframe-scoped actions" },
      format: { type: "string", enum: ["text", "json"], description: "Output format for get_state (default: text)" },
      keys: { type: "string", description: "Key sequence for send_keys (e.g. 'Enter', 'Tab Tab Enter', 'Ctrl+a')" },
      file_path: { type: "string", description: "File path for upload_file" },
      schema: { type: "object", description: "Extraction schema for extract (e.g. {\"title\": \"h1\", \"price\": \".price\"})" },
      profile_name: { type: "string", description: "Named browser profile (~/.claude/browser-profiles/<name>/)" },
      user_data_dir: { type: "string", description: "Custom Chrome user data directory" },
      profile_dir: { type: "string", description: "Chrome --profile-directory flag" },
      cdp_url: { type: "string", description: "CDP URL for attach mode (e.g. http://localhost:9222)" },
      enabled: { type: "boolean", description: "Enable/disable flag for set_dialog_auto_dismiss" },
      script: { type: "string", description: "JS code for inject_script (runs before page JS on every navigation)" },
      filter: { type: "string", description: "URL/mime filter for get_network_log (e.g. 'api', 'json')" },
      body_index: { type: "integer", description: "Network log entry index for retrieving response body" }
    }, required: ["action"] }
  },
  async (input) => {
    const mgr = _getSessionManager(); const a = input.action;
    const sessionId = input.session_id || "default";
    try {
      // Session-level actions that don't need an existing browser
      if (a === "new_session") {
        const opts = {};
        if (input.profile_name) opts.profileName = input.profile_name;
        if (input.user_data_dir) opts.userDataDir = input.user_data_dir;
        if (input.profile_dir) opts.profileDir = input.profile_dir;
        if (input.cdp_url) opts.cdpUrl = input.cdp_url;
        const s = await mgr.create(input.session_id || "new-" + Date.now(), opts);
        return { content: `Session created: ${s._id} (${s._mode} mode, ${s._tabs.size} tab(s))`, is_error: false };
      }
      if (a === "close_session") { await mgr.close(sessionId); return { content: `Session closed: ${sessionId}`, is_error: false }; }
      if (a === "list_sessions") { return { content: JSON.stringify(mgr.list(), null, 2), is_error: false }; }

      const b = mgr.get(sessionId);
      const k = `${a}:${input.selector || ""}:${input.value || ""}:${input.index ?? ""}`;
      if (b._detectLoop(k)) return { content: "Loop detected: you've repeated this exact action 3 times. Try a different approach.", is_error: true };

      if (a === "close") return { content: await b.close(), is_error: false };
      await b.ensureBrowser();

      switch (a) {
        case "navigate": return { content: await b.navigate(input.url || "about:blank"), is_error: false };
        case "get_state": return { content: await b.getState(input.format), is_error: false };
        case "click_element": return { content: await b.clickElement(input.index ?? 0, input.frame_id), is_error: false };
        case "type_element": return { content: await b.typeElement(input.index ?? 0, input.value || "", input.frame_id), is_error: false };
        case "click": return { content: await b.click(input.selector || "body", input.frame_id), is_error: false };
        case "fill": return { content: await b.fill(input.selector || "input", input.value || "", input.frame_id), is_error: false };
        case "send_keys": return { content: await b.sendKeys(input.keys || input.value || ""), is_error: false };
        case "upload_file": return { content: await b.uploadFile(input.selector || 'input[type="file"]', input.file_path || input.value || "", input.frame_id), is_error: false };
        case "select_dropdown": return { content: await b.selectDropdown(input.selector || "select", input.value || "", input.frame_id), is_error: false };
        case "dropdown_options": return { content: await b.dropdownOptions(input.selector || "select", input.frame_id), is_error: false };
        case "extract": return { content: await b.extract(input.schema || {}, input.frame_id), is_error: false };
        case "get_text": return { content: await b.getText(input.selector), is_error: false };
        case "evaluate": return { content: await b.evaluate(input.value || "", input.frame_id), is_error: false };
        case "wait_for": return { content: await b.waitFor(input.selector || "body", input.timeout || 5000), is_error: false };
        case "scroll_to": return { content: await b.scrollTo(input.selector, input.value ? parseInt(input.value) : undefined), is_error: false };
        case "screenshot": return { content: await b.screenshot(input.output_path), is_error: false };
        case "pdf": { const sid = b._activeCdpSession(); const r = await b._send("Page.printToPDF", { printBackground: true }, sid); if (!r?.data) return { content: "PDF failed", is_error: true }; const dir = path.join(os.tmpdir(), "cloclo-screenshots"); fs.mkdirSync(dir, { recursive: true }); const fp = input.output_path || path.join(dir, `page-${Date.now()}.pdf`); fs.writeFileSync(fp, Buffer.from(r.data, "base64")); return { content: `PDF saved: ${fp}`, is_error: false }; }
        case "back": return { content: await b.back(), is_error: false };
        case "forward": return { content: await b.forward(), is_error: false };
        case "reload": return { content: await b.reload(), is_error: false };
        case "cookies_get": return { content: await b.cookiesGet(), is_error: false };
        case "cookies_set": { const c = input.cookie || {}; return { content: await b.cookiesSet(c.name || input.value, c.value || "", c.domain || "", c.path), is_error: false }; }
        case "cookies_clear": return { content: await b.cookiesClear(), is_error: false };
        case "new_tab": return { content: await b.newTab(input.url), is_error: false };
        case "switch_tab": return { content: await b.switchTab(input.tab_id || ""), is_error: false };
        case "close_tab": return { content: await b.closeTab(input.tab_id), is_error: false };
        case "list_tabs": return { content: JSON.stringify(b.listTabs(), null, 2), is_error: false };
        case "list_frames": return { content: await b.listFrames(), is_error: false };
        case "get_events": return { content: b.getEvents(), is_error: false };
        case "set_dialog_auto_dismiss": return { content: b.setDialogAutoDismiss(input.enabled !== false), is_error: false };
        case "inject_script": return { content: await b.injectScript(input.script || input.value || ""), is_error: false };
        case "enable_network_log": return { content: await b.enableNetworkLog(), is_error: false };
        case "get_network_log": { if (input.body_index !== undefined) return { content: b.getNetworkResponseBody(input.body_index), is_error: false }; return { content: b.getNetworkLog(input.filter), is_error: false }; }
        default: return { content: `Unknown action: ${a}`, is_error: true };
      }
    } catch (e) { return { content: `Browser error: ${e.message}`, is_error: true }; }
  }, { deferred: true });
}

export {
  BrowserSession,
  BrowserSessionManager,
  BROWSER_READ_ONLY_ACTIONS,
  BROWSER_MUTATING_ACTIONS,
  BROWSER_PRIVILEGED_ACTIONS,
  registerBrowserTools
};
