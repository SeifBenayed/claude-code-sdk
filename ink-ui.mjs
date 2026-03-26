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

// ── App (root component) ───────────────────────────────────────

function App({ interactiveMode, onSubmit, onExit }) {
  const [input, setInput] = useState("");
  const [outputLines, setOutputLines] = useState([]);
  const [menuVisible, setMenuVisible] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuCommands, setMenuCommands] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
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

    setIsProcessing(true);
    addOutput("\x1b[36m> " + trimmed + "\x1b[0m");

    try {
      await onSubmit(trimmed, addOutput);
    } catch (e) {
      addOutput("\x1b[31mError: " + e.message + "\x1b[0m");
    }

    setIsProcessing(false);
  }, [menuVisible, menuCommands, menuIndex, onSubmit, addOutput]);

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
