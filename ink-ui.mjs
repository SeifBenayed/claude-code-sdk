// ink-ui.mjs — Ink-based terminal UI for claude-native interactive mode
//
// Components:
//   App            — Root layout: output area + slash menu + input + status bar
//   SlashMenu      — Popup command palette when input starts with /
//   StatusBar      — Persistent bottom bar: provider | model | modes | branch | cwd
//   OutputArea     — Scrollable conversation output
//   InputLine      — Text input with slash detection

import React, { useState, useEffect, useCallback, useRef } from "react";
import { render, Box, Text, useInput, useApp, useStdout } from "ink";
import TextInput from "ink-text-input";
import { execSync } from "node:child_process";
import os from "node:os";

// ── Slash Menu ─────────────────────────────────────────────────

function SlashMenu({ commands, filter, selectedIndex, visible }) {
  if (!visible || commands.length === 0) return null;

  return React.createElement(Box, {
    flexDirection: "column",
    borderStyle: "single",
    borderColor: "gray",
    paddingX: 1,
    marginBottom: 0,
  },
    React.createElement(Text, { bold: true, dimColor: true }, "Commands"),
    ...commands.map((cmd, i) => {
      const isSelected = i === selectedIndex;
      const nameStr = "/" + cmd.name + (cmd.argumentHint ? " " + cmd.argumentHint : "");
      const aliases = cmd.aliases?.length > 0 ? ` (${cmd.aliases.map(a => "/" + a).join(", ")})` : "";
      const tag = cmd.source === "skill" ? " [skill]" : "";

      return React.createElement(Box, { key: cmd.name },
        React.createElement(Text, {
          color: isSelected ? "black" : (cmd.source === "skill" ? "magenta" : "cyan"),
          backgroundColor: isSelected ? "cyan" : undefined,
        }, nameStr),
        React.createElement(Text, { dimColor: true }, "  " + cmd.description + aliases + tag),
      );
    })
  );
}

// ── Status Bar ─────────────────────────────────────────────────

function StatusBar({ cfg, sessionId, messageCount, totalCost, gitBranch }) {
  const provider = cfg._provider?.name || "?";
  const model = cfg.model || "?";
  const modes = [];
  if (cfg.briefMode) modes.push("brief");
  if (cfg.thinkingBudget > 0) modes.push("think:" + cfg.thinkingBudget);
  if (cfg._planMode) modes.push("plan");

  const cwd = (cfg.cwd || "").replace(os.homedir(), "~");
  const session = sessionId ? sessionId.slice(0, 8) : "-";
  const cost = totalCost > 0 ? "$" + totalCost.toFixed(4) : "";

  const parts = [
    React.createElement(Text, { key: "p", dimColor: true }, provider),
    React.createElement(Text, { key: "m", color: "cyan" }, model),
  ];

  if (modes.length > 0) {
    parts.push(React.createElement(Text, { key: "mo", color: "yellow" }, "[" + modes.join(",") + "]"));
  }
  if (gitBranch) {
    parts.push(React.createElement(Text, { key: "g", color: "magenta" }, gitBranch));
  }
  parts.push(React.createElement(Text, { key: "c", dimColor: true }, cwd));
  parts.push(React.createElement(Text, { key: "s", dimColor: true }, session));
  parts.push(React.createElement(Text, { key: "msg", dimColor: true }, messageCount + "msg"));
  if (cost) {
    parts.push(React.createElement(Text, { key: "$", dimColor: true }, cost));
  }

  // Interleave with separators
  const withSeps = [];
  parts.forEach((p, i) => {
    if (i > 0) withSeps.push(React.createElement(Text, { key: "sep" + i, dimColor: true }, " | "));
    withSeps.push(p);
  });

  return React.createElement(Box, { borderStyle: "single", borderColor: "gray", paddingX: 1 }, ...withSeps);
}

// ── Output Area ────────────────────────────────────────────────

function OutputArea({ lines }) {
  const { stdout } = useStdout();
  const maxLines = (stdout?.rows || 24) - 8; // Reserve space for input + status + menu
  const visible = lines.slice(-maxLines);

  return React.createElement(Box, { flexDirection: "column", flexGrow: 1 },
    ...visible.map((line, i) =>
      React.createElement(Text, { key: i, wrap: "wrap" }, line)
    )
  );
}

// ── Marketplace View ──────────────────────────────────────────

function MarketplaceView({ skills, installed, onInstall, onClose }) {
  const [cursor, setCursor] = useState(0);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [detailIdx, setDetailIdx] = useState(null);
  const [installing, setInstalling] = useState(null);
  const { stdout } = useStdout();
  const maxVisible = Math.max(3, (stdout?.rows || 24) - 10);

  const filtered = search
    ? skills.filter(s =>
        s.name.toLowerCase().includes(search.toLowerCase()) ||
        (s.description || "").toLowerCase().includes(search.toLowerCase()) ||
        (s.author || "").toLowerCase().includes(search.toLowerCase())
      )
    : skills;

  // Clamp cursor
  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  useInput((ch, key) => {
    if (installing) return;

    // Detail view
    if (detailIdx !== null) {
      if (key.escape || key.return) setDetailIdx(null);
      return;
    }

    if (key.escape) {
      if (search) { setSearch(""); setCursor(0); }
      else onClose();
      return;
    }
    if (key.upArrow) { setCursor(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setCursor(i => Math.min(filtered.length - 1, i + 1)); return; }
    if (key.return && filtered.length > 0) {
      setDetailIdx(cursor);
      return;
    }
    if (ch === " " && filtered.length > 0) {
      const s = filtered[cursor];
      if (installed.has(s.name)) return; // already installed
      setInstalling(s.name);
      onInstall(s.name).then(() => {
        setInstalling(null);
        installed.add(s.name);
        setSelected(prev => { const n = new Set(prev); n.add(s.name); return n; });
      }).catch(() => setInstalling(null));
      return;
    }
    // Typing → search
    if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch !== " ") {
      setSearch(prev => prev + ch);
      setCursor(0);
      return;
    }
    if (key.backspace || key.delete) {
      setSearch(prev => prev.slice(0, -1));
      setCursor(0);
      return;
    }
  });

  // Detail view
  if (detailIdx !== null && filtered[detailIdx]) {
    const s = filtered[detailIdx];
    const isInst = installed.has(s.name) || selected.has(s.name);
    return React.createElement(Box, { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1, paddingY: 0 },
      React.createElement(Text, { bold: true, color: "cyan" }, "  " + s.name),
      React.createElement(Text, {}, ""),
      s.description ? React.createElement(Text, { wrap: "wrap" }, "  " + s.description) : null,
      React.createElement(Text, {}, ""),
      s.author ? React.createElement(Text, { dimColor: true }, "  Author:    " + s.author) : null,
      s.version ? React.createElement(Text, { dimColor: true }, "  Version:   " + s.version) : null,
      s.downloads !== undefined ? React.createElement(Text, { dimColor: true }, "  Downloads: " + s.downloads) : null,
      React.createElement(Text, { dimColor: true }, "  Status:    " + (isInst ? "✓ installed" : "not installed")),
      React.createElement(Text, {}, ""),
      React.createElement(Text, { dimColor: true }, "  Esc/Enter to go back" + (!isInst ? " · Space to install" : "")),
    );
  }

  // Scroll window
  const scrollStart = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), filtered.length - maxVisible));
  const visible = filtered.slice(scrollStart, scrollStart + maxVisible);
  const hasMore = scrollStart + maxVisible < filtered.length;
  const hasLess = scrollStart > 0;

  return React.createElement(Box, { flexDirection: "column" },
    // Header
    React.createElement(Box, { borderStyle: "round", borderColor: "cyan", paddingX: 1 },
      React.createElement(Text, { bold: true, color: "cyan" }, "Skill Marketplace"),
      React.createElement(Text, { dimColor: true }, "  " + filtered.length + "/" + skills.length + " skills"),
    ),
    // Search
    React.createElement(Box, { paddingX: 1 },
      React.createElement(Text, { dimColor: true }, "  🔍 "),
      React.createElement(Text, {}, search || React.createElement(Text, { dimColor: true }, "type to search")),
    ),
    React.createElement(Text, {}, ""),
    // Scroll indicator top
    hasLess ? React.createElement(Text, { dimColor: true }, "   ↑ more above") : null,
    // List
    ...visible.map((s, i) => {
      const realIdx = scrollStart + i;
      const isCursor = realIdx === cursor;
      const isInst = installed.has(s.name) || selected.has(s.name);
      const icon = isInst ? "◉" : "◯";
      const iconColor = isInst ? "green" : (isCursor ? "cyan" : "gray");
      const desc = (s.description || "").length > 50 ? (s.description || "").slice(0, 47) + "..." : (s.description || "");

      return React.createElement(Box, { key: s.name, flexDirection: "column", paddingLeft: 2 },
        React.createElement(Box, {},
          React.createElement(Text, { color: iconColor }, (isCursor ? "▸ " : "  ") + icon + " "),
          React.createElement(Text, { bold: isCursor, color: isCursor ? "cyan" : undefined }, s.name),
          s.author ? React.createElement(Text, { dimColor: true }, " · " + s.author) : null,
        ),
        React.createElement(Text, { dimColor: true }, "      " + desc),
        React.createElement(Text, {}, ""),
      );
    }),
    // Scroll indicator bottom
    hasMore ? React.createElement(Text, { dimColor: true }, "   ↓ more below") : null,
    // Installing indicator
    installing ? React.createElement(Box, { paddingX: 1 },
      React.createElement(Text, { color: "yellow" }, "  Installing " + installing + "..."),
    ) : null,
    // Footer
    React.createElement(Text, {}, ""),
    React.createElement(Box, { paddingX: 1 },
      React.createElement(Text, { dimColor: true }, "  type to search · Space to install · Enter to details · Esc to back"),
    ),
  );
}

// ── Tool Catalog View ─────────────────────────────────────────

function ToolCatalogView({ tools, installed, onInstall, onClose }) {
  const [cursor, setCursor] = useState(0);
  const [search, setSearch] = useState("");
  const [detailIdx, setDetailIdx] = useState(null);
  const [installing, setInstalling] = useState(null);
  const { stdout } = useStdout();
  const maxVisible = Math.max(3, (stdout?.rows || 24) - 10);

  const filtered = search
    ? tools.filter(t =>
        t.name.toLowerCase().includes(search.toLowerCase()) ||
        (t.description || "").toLowerCase().includes(search.toLowerCase()) ||
        (t.type || "").toLowerCase().includes(search.toLowerCase()) ||
        (t.category || "").toLowerCase().includes(search.toLowerCase())
      )
    : tools;

  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  useInput((ch, key) => {
    if (installing) return;
    if (detailIdx !== null) { if (key.escape || key.return) setDetailIdx(null); return; }
    if (key.escape) { if (search) { setSearch(""); setCursor(0); } else onClose(); return; }
    if (key.upArrow) { setCursor(i => Math.max(0, i - 1)); return; }
    if (key.downArrow) { setCursor(i => Math.min(filtered.length - 1, i + 1)); return; }
    if (key.return && filtered.length > 0) { setDetailIdx(cursor); return; }
    if (ch === " " && filtered.length > 0) {
      const t = filtered[cursor];
      if (installed.has(t.name)) return;
      setInstalling(t.name);
      onInstall(t.name).then(() => { setInstalling(null); installed.add(t.name); }).catch(() => setInstalling(null));
      return;
    }
    if (ch && !key.ctrl && !key.meta && ch.length === 1 && ch !== " ") { setSearch(prev => prev + ch); setCursor(0); return; }
    if (key.backspace || key.delete) { setSearch(prev => prev.slice(0, -1)); setCursor(0); return; }
  });

  // Detail view
  if (detailIdx !== null && filtered[detailIdx]) {
    const t = filtered[detailIdx];
    const isInst = installed.has(t.name);
    return React.createElement(Box, { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 1, paddingY: 0 },
      React.createElement(Text, { bold: true, color: "yellow" }, "  " + t.name),
      React.createElement(Text, {}, ""),
      t.description ? React.createElement(Text, { wrap: "wrap" }, "  " + t.description) : null,
      React.createElement(Text, {}, ""),
      React.createElement(Text, { dimColor: true }, "  Type:      " + (t.type || "?")),
      t.binary ? React.createElement(Text, { dimColor: true }, "  Binary:    " + t.binary) : null,
      t.url ? React.createElement(Text, { dimColor: true }, "  URL:       " + (t.url || "").slice(0, 60)) : null,
      t.category ? React.createElement(Text, { dimColor: true }, "  Category:  " + t.category) : null,
      t.author ? React.createElement(Text, { dimColor: true }, "  Author:    " + t.author) : null,
      t.read_only !== undefined ? React.createElement(Text, { dimColor: true }, "  Read-only: " + (t.read_only ? "yes" : "no (mutating)")) : null,
      t.env_required?.length > 0 ? React.createElement(Text, { dimColor: true }, "  Env:       " + t.env_required.join(", ")) : null,
      t.auth_note ? React.createElement(Text, { dimColor: true }, "  Auth:      " + t.auth_note) : null,
      t.downloads !== undefined ? React.createElement(Text, { dimColor: true }, "  Downloads: " + t.downloads) : null,
      React.createElement(Text, { dimColor: true }, "  Status:    " + (isInst ? "\u2713 installed" : "not installed")),
      React.createElement(Text, {}, ""),
      React.createElement(Text, { dimColor: true }, "  Esc/Enter to go back" + (!isInst ? " \u00B7 Space to install" : "")),
    );
  }

  const scrollStart = Math.max(0, Math.min(cursor - Math.floor(maxVisible / 2), filtered.length - maxVisible));
  const visible = filtered.slice(scrollStart, scrollStart + maxVisible);
  const hasMore = scrollStart + maxVisible < filtered.length;
  const hasLess = scrollStart > 0;

  const categoryIcons = { devops: "\u2699", deploy: "\u2601", data: "\u2630", search: "\u2315", enterprise: "\u2302", communication: "\u2709", system: "\u2318", media: "\u266B" };

  return React.createElement(Box, { flexDirection: "column" },
    React.createElement(Box, { borderStyle: "round", borderColor: "yellow", paddingX: 1 },
      React.createElement(Text, { bold: true, color: "yellow" }, "Tool Marketplace"),
      React.createElement(Text, { dimColor: true }, "  " + filtered.length + "/" + tools.length + " tools"),
    ),
    React.createElement(Box, { paddingX: 1 },
      React.createElement(Text, { dimColor: true }, "  \uD83D\uDD0D "),
      React.createElement(Text, {}, search || React.createElement(Text, { dimColor: true }, "type to search")),
    ),
    React.createElement(Text, {}, ""),
    hasLess ? React.createElement(Text, { dimColor: true }, "   \u2191 more above") : null,
    ...visible.map((t, i) => {
      const realIdx = scrollStart + i;
      const isCursor = realIdx === cursor;
      const isInst = installed.has(t.name);
      const icon = isInst ? "\u25C9" : "\u25EF";
      const iconColor = isInst ? "green" : (isCursor ? "yellow" : "gray");
      const typeColor = t.type === "cli" ? "yellow" : t.type === "http" ? "magenta" : "cyan";
      const catIcon = categoryIcons[t.category] || "\u2022";
      const desc = (t.description || "").length > 50 ? (t.description || "").slice(0, 47) + "..." : (t.description || "");

      return React.createElement(Box, { key: t.name, flexDirection: "column", paddingLeft: 2 },
        React.createElement(Box, {},
          React.createElement(Text, { color: iconColor }, (isCursor ? "\u25B8 " : "  ") + icon + " "),
          React.createElement(Text, { bold: isCursor, color: isCursor ? "yellow" : undefined }, t.name),
          React.createElement(Text, { color: typeColor }, "  " + (t.type || "?")),
          React.createElement(Text, { dimColor: true }, "  " + catIcon + " " + (t.category || "")),
          t.read_only === false ? React.createElement(Text, { color: "yellow" }, " mutating") : null,
        ),
        React.createElement(Text, { dimColor: true }, "      " + desc),
        React.createElement(Text, {}, ""),
      );
    }),
    hasMore ? React.createElement(Text, { dimColor: true }, "   \u2193 more below") : null,
    installing ? React.createElement(Box, { paddingX: 1 },
      React.createElement(Text, { color: "yellow" }, "  Installing " + installing + "..."),
    ) : null,
    React.createElement(Text, {}, ""),
    React.createElement(Box, { paddingX: 1 },
      React.createElement(Text, { dimColor: true }, "  type to search \u00B7 Space to install \u00B7 Enter to details \u00B7 Esc to back"),
    ),
  );
}

// ── App (root component) ───────────────────────────────────────

function App({ interactiveMode, onSubmit, onExit }) {
  const [input, setInput] = useState("");
  const [outputLines, setOutputLines] = useState([]);
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuCommands, setMenuCommands] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [marketplaceData, setMarketplaceData] = useState(null); // { skills, installed }
  const [catalogData, setCatalogData] = useState(null); // { tools, installed }
  const { exit } = useApp();

  const im = interactiveMode;

  // Get git branch once
  const [gitBranch] = useState(() => {
    try {
      return execSync("git rev-parse --abbrev-ref HEAD 2>/dev/null", { cwd: im.cfg.cwd, encoding: "utf-8", timeout: 2000 }).trim();
    } catch { return ""; }
  });

  // Update slash menu when input changes
  useEffect(() => {
    if (input.startsWith("/") && !isProcessing) {
      const filter = input.slice(1).split(/\s/)[0].toLowerCase();
      const allCmds = im.slashCommands.list();
      const filtered = filter
        ? allCmds.filter(c => c.name.includes(filter) || c.aliases.some(a => a.includes(filter)) || c.description.toLowerCase().includes(filter))
        : allCmds;
      setMenuCommands(filtered.slice(0, 10));
      setMenuVisible(filtered.length > 0);
      setMenuIndex(0);
    } else {
      setMenuVisible(false);
      setMenuCommands([]);
    }
  }, [input, isProcessing]);

  // Handle key presses for menu navigation
  useInput((ch, key) => {
    if (isProcessing) return;

    if (menuVisible) {
      if (key.upArrow) {
        setMenuIndex(i => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setMenuIndex(i => Math.min(menuCommands.length - 1, i + 1));
        return;
      }
      if (key.tab && menuCommands.length > 0) {
        const selected = menuCommands[menuIndex];
        setInput("/" + selected.name + " ");
        return;
      }
    }

    if (key.escape) {
      if (menuVisible) {
        setMenuVisible(false);
      } else if (input) {
        setInput("");
      }
    }
  });

  const addOutput = useCallback((text) => {
    setOutputLines(prev => [...prev, text]);
  }, []);

  const handleSubmit = useCallback(async (value) => {
    const trimmed = value.trim();
    if (!trimmed) return;

    setInput("");
    setMenuVisible(false);

    // If slash menu is up and user hits enter, use selected command
    if (menuVisible && menuCommands.length > 0 && trimmed === "/") {
      const selected = menuCommands[menuIndex];
      setInput("/" + selected.name + " ");
      return;
    }

    // Marketplace — intercept before general handler to set UI state
    if (trimmed === "/marketplace" || trimmed.startsWith("/marketplace ")) {
      addOutput("\x1b[36m> " + trimmed + "\x1b[0m");
      addOutput("\x1b[2mFetching from registry...\x1b[0m");
      setIsProcessing(true);
      try {
        const origWrite = process.stderr.write.bind(process.stderr);
        let registryUrl = "";
        // Extract SKILL_REGISTRY_URL from the handler's scope
        process.stderr.write = (data) => { registryUrl += data; return true; };
        const cmd = im.slashCommands.get("marketplace");
        // We need to fetch directly — use the registry URL from the env or default
        process.stderr.write = origWrite;

        const _https = await import("node:https");
        const _http = await import("node:http");
        const regUrl = process.env.CLOCLO_REGISTRY_URL || "https://cloclo-registry-799190737906.europe-west1.run.app";
        const query = trimmed.replace(/^\/marketplace\s*/, "");
        const endpoint = query && query !== "install" ? `/api/skills/search?q=${encodeURIComponent(query)}` : "/api/skills";
        const fetchUrl = regUrl + endpoint;

        const resp = await new Promise((resolve, reject) => {
          const mod = fetchUrl.startsWith("https") ? _https.default : _http.default;
          mod.get(fetchUrl, { headers: { "User-Agent": "cloclo/1.0", Accept: "application/json" } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              mod.get(res.headers.location, { headers: { "User-Agent": "cloclo/1.0", Accept: "application/json" } }, (r2) => {
                let d = ""; r2.on("data", c => d += c); r2.on("end", () => resolve(d));
              }).on("error", reject);
              return;
            }
            let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d));
          }).on("error", reject);
        });

        const data = JSON.parse(resp);
        const skills = data.skills || [];
        const installedSet = new Set((im.cfg._skillLoader?.list() || []).map(s => s.name));

        if (skills.length === 0) {
          addOutput(query ? `No skills found matching "${query}".` : "Registry is empty.");
        } else {
          setMarketplaceData({ skills, installed: installedSet });
        }
      } catch (e) {
        addOutput("\x1b[31mRegistry unavailable: " + e.message + "\x1b[0m");
      }
      setIsProcessing(false);
      return;
    }

    // Catalog — intercept /catalog to show tool marketplace UI
    if (trimmed === "/catalog" || trimmed.startsWith("/catalog ") || trimmed === "/tool catalog" || trimmed.startsWith("/tool catalog ")) {
      addOutput("\x1b[33m> " + trimmed + "\x1b[0m");
      addOutput("\x1b[2mFetching tool catalog...\x1b[0m");
      setIsProcessing(true);
      try {
        const _https = await import("node:https");
        const _http = await import("node:http");
        const regUrl = process.env.CLOCLO_REGISTRY_URL || "https://cloclo-registry-799190737906.europe-west1.run.app";
        const query = trimmed.replace(/^\/(tool\s+)?catalog\s*/, "").trim();
        const endpoint = query ? `/api/tools/search?q=${encodeURIComponent(query)}` : "/api/tools";
        let tools = [];
        // Try registry
        try {
          const resp = await new Promise((resolve, reject) => {
            const mod = regUrl.startsWith("https") ? _https.default : _http.default;
            mod.get(regUrl + endpoint, { headers: { "User-Agent": "cloclo/1.0", Accept: "application/json" }, timeout: 5000 }, (res) => {
              let d = ""; res.on("data", c => d += c); res.on("end", () => resolve(d));
            }).on("error", reject);
          });
          tools = (JSON.parse(resp).tools || []).map(t => ({ ...t, category: t.category || "" }));
        } catch { /* registry unavailable */ }
        // Fallback: use static catalog from cfg if registry returned empty/unavailable
        if (tools.length === 0 && im.cfg?._officialToolCatalog) {
          const catalog = im.cfg._officialToolCatalog;
          let all = Object.values(catalog).map(t => ({
            name: t.name, description: t.description, type: t.type, category: t._meta?.category || "",
            author: t._meta?.author || "cloclo", binary: t.binary, url: t.url,
            read_only: t.read_only, env_required: t._meta?.env_required || t.env || [],
            auth_note: t._meta?.auth_note,
          }));
          if (query) { const q = query.toLowerCase(); all = all.filter(t => `${t.name} ${t.description} ${t.type} ${t.category}`.toLowerCase().includes(q)); }
          tools = all;
        }
        // Get installed tools
        const manifest = {};
        try {
          const fs = await import("node:fs");
          const path = await import("node:path");
          const mp = path.default.join(os.homedir(), ".claude", "tools", ".cloclo-tools.json");
          const raw = fs.default.readFileSync(mp, "utf-8");
          Object.assign(manifest, JSON.parse(raw));
        } catch { /* no manifest */ }
        const installedSet = new Set(Object.keys(manifest.tools || {}));

        if (tools.length === 0) {
          addOutput(query ? `No tools found matching "${query}".` : "Catalog is empty. Publish tools with: cloclo tool publish <name>");
        } else {
          setCatalogData({ tools, installed: installedSet });
        }
      } catch (e) {
        addOutput("\x1b[31mCatalog error: " + e.message + "\x1b[0m");
      }
      setIsProcessing(false);
      return;
    }

    setIsProcessing(true);
    addOutput("\x1b[36m> " + trimmed + "\x1b[0m");

    try {
      await onSubmit(trimmed, addOutput);
    } catch (e) {
      addOutput("\x1b[31mError: " + e.message + "\x1b[0m");
    }

    setIsProcessing(false);
  }, [menuVisible, menuCommands, menuIndex, onSubmit, addOutput]);

  // Marketplace mode — full-screen overlay (skills)
  if (marketplaceData) {
    return React.createElement(MarketplaceView, {
      skills: marketplaceData.skills,
      installed: marketplaceData.installed,
      onInstall: async (name) => {
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = () => true;
        try {
          const cmd = im.slashCommands.get("skill");
          if (cmd?.handler) { await cmd.handler(["import", `registry:${name}`]); }
        } finally { process.stderr.write = origWrite; }
      },
      onClose: () => setMarketplaceData(null),
    });
  }

  // Catalog mode — full-screen overlay (tools)
  if (catalogData) {
    return React.createElement(ToolCatalogView, {
      tools: catalogData.tools,
      installed: catalogData.installed,
      onInstall: async (name) => {
        const origWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = () => true;
        try {
          const cmd = im.slashCommands.get("tool");
          if (cmd?.handler) { await cmd.handler(["install", `official:${name}`]); }
        } finally { process.stderr.write = origWrite; }
      },
      onClose: () => setCatalogData(null),
    });
  }

  return React.createElement(Box, { flexDirection: "column", height: "100%" },
    // Output area
    React.createElement(OutputArea, { lines: outputLines }),

    // Slash menu (above input)
    React.createElement(SlashMenu, {
      commands: menuCommands,
      filter: input.slice(1),
      selectedIndex: menuIndex,
      visible: menuVisible && !isProcessing,
    }),

    // Input line
    React.createElement(Box, {},
      React.createElement(Text, { color: "cyan" }, isProcessing ? "..." : "> "),
      isProcessing
        ? React.createElement(Text, { dimColor: true }, "thinking...")
        : React.createElement(TextInput, {
            value: input,
            onChange: setInput,
            onSubmit: handleSubmit,
            placeholder: "Type / for commands, or ask anything...",
          }),
    ),

    // Status bar
    React.createElement(StatusBar, {
      cfg: im.cfg,
      sessionId: im.sessionId,
      messageCount: im.messages.length,
      totalCost: im.totalCost,
      gitBranch,
    }),
  );
}

// ── Public API ─────────────────────────────────────────────────

export function startInkUI(interactiveMode) {
  return new Promise((resolve) => {
    const im = interactiveMode;

    const onSubmit = async (input, addOutput) => {
      // Bare "/" or "/help"
      if (input === "/" || input === "/help") {
        const cmds = im.slashCommands.list();
        addOutput("\x1b[1m  Commands\x1b[0m");
        for (const c of cmds) {
          const name = "/" + c.name + (c.argumentHint ? " " + c.argumentHint : "");
          const aliases = c.aliases.length > 0 ? ` (${c.aliases.map(a => "/" + a).join(", ")})` : "";
          const tag = c.source === "skill" ? " [skill]" : "";
          addOutput("  \x1b[36m" + name + "\x1b[0m  " + c.description + aliases + tag);
        }
        return;
      }

      // Slash commands
      if (input.startsWith("/")) {
        const [rawCmd, ...args] = input.split(/\s+/);
        const cmdName = rawCmd.slice(1);

        // Skills — run through _handleSlashCommand which handles the full skill execution path
        if (im.cfg._skillLoader?.has(cmdName)) {
          addOutput("\x1b[2mRunning skill: /" + cmdName + "\x1b[0m");
          const origWrite = process.stderr.write.bind(process.stderr);
          let buffer = "";
          process.stderr.write = (data) => {
            buffer += data;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const line of lines) { addOutput(line); }
            return true;
          };
          try {
            await im._handleSlashCommand(input);
          } finally {
            process.stderr.write = origWrite;
            if (buffer.trim()) addOutput(buffer);
          }
          return;
        }

        const cmd = im.slashCommands.get(cmdName);
        if (cmd) {
          if (cmd.name === "exit") {
            inkInstance.unmount();
            resolve();
            return;
          }
          if (cmd.handler) {
            // Capture stderr output
            const origWrite = process.stderr.write.bind(process.stderr);
            let captured = "";
            process.stderr.write = (data) => { captured += data; return true; };
            try {
              await cmd.handler(args);
            } finally {
              process.stderr.write = origWrite;
            }
            if (captured.trim()) {
              for (const line of captured.split("\n")) {
                if (line.trim()) addOutput(line);
              }
            }
            return;
          }
        }

        addOutput("\x1b[2mUnknown command: " + rawCmd + "\x1b[0m");
        return;
      }

      // Regular input — run through agent loop
      // Capture stderr output from the agent
      const origWrite = process.stderr.write.bind(process.stderr);
      let buffer = "";
      process.stderr.write = (data) => {
        buffer += data;
        // Flush complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          addOutput(line);
        }
        return true;
      };

      try {
        await im._processInput(input);
      } finally {
        process.stderr.write = origWrite;
        if (buffer.trim()) addOutput(buffer);
      }
    };

    const app = React.createElement(App, {
      interactiveMode: im,
      onSubmit,
      onExit: () => { resolve(); },
    });

    const inkInstance = render(app, {
      exitOnCtrlC: true,
    });

    inkInstance.waitUntilExit().then(resolve);
  });
}

export { SlashMenu, StatusBar, OutputArea, App };
