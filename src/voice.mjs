// src/voice.mjs — Voice mode: STT (Whisper) + TTS (macOS say / OpenAI)
// + Realtime speech-to-speech via OpenAI Realtime API (WebSocket)
//
// Zero npm dependencies. Uses: sox (rec/play), say, afplay, OpenAI API via fetch/WebSocket.

import { spawn, execSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import _https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

import { log } from "./utils.mjs";

// ── Minimal WebSocket client (Node built-ins only) ─────────────────
// Supports text frames only — sufficient for OpenAI Realtime API.

class MiniWebSocket extends EventEmitter {
  constructor(url, opts = {}) {
    super();
    this.readyState = 0; // CONNECTING
    this._buf = Buffer.alloc(0);
    this._socket = null;

    const parsed = new URL(url);
    const key = randomBytes(16).toString("base64");

    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "Upgrade": "websocket",
        "Connection": "Upgrade",
        "Sec-WebSocket-Key": key,
        "Sec-WebSocket-Version": "13",
        ...(opts.headers || {}),
      },
    };

    const req = _https.request(reqOpts);

    req.on("upgrade", (res, socket) => {
      this._socket = socket;
      this.readyState = 1; // OPEN

      socket.on("data", (chunk) => this._onData(chunk));
      socket.on("close", () => { this.readyState = 3; this.emit("close", { code: 1000 }); });
      socket.on("error", (e) => {
        if (e.code === "EPIPE" || e.code === "ECONNRESET") {
          this.readyState = 3;
          this.emit("close", { code: 1006 });
        } else {
          this.emit("error", e);
        }
      });

      this.emit("open");
    });

    req.on("error", (e) => {
      this.readyState = 3;
      this.emit("error", e);
    });

    // If server responds with non-101, handle it
    req.on("response", (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => {
        this.readyState = 3;
        this.emit("error", new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
      });
    });

    req.end();
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);

    while (this._buf.length >= 2) {
      const byte0 = this._buf[0];
      const byte1 = this._buf[1];
      const opcode = byte0 & 0x0f;
      const masked = (byte1 & 0x80) !== 0;
      let payloadLen = byte1 & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this._buf.length < 4) return;
        payloadLen = this._buf.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buf.length < 10) return;
        payloadLen = Number(this._buf.readBigUInt64BE(2));
        offset = 10;
      }

      if (masked) offset += 4; // skip mask key (server should not mask)
      if (this._buf.length < offset + payloadLen) return; // incomplete frame

      const payload = this._buf.slice(offset, offset + payloadLen);
      this._buf = this._buf.slice(offset + payloadLen);

      if (opcode === 0x1) {
        // Text frame
        this.emit("message", { data: payload.toString("utf-8") });
      } else if (opcode === 0x8) {
        // Close frame
        this.readyState = 3;
        this.emit("close", { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1000 });
        this._socket?.end();
      } else if (opcode === 0x9) {
        // Ping → Pong (client must mask all frames per RFC 6455)
        this._sendFrame(0xa, payload, true);
      }
      // ignore other opcodes (binary 0x2, pong 0xa)
    }
  }

  send(data) {
    if (this.readyState !== 1) return;
    const payload = Buffer.from(data, "utf-8");
    this._sendFrame(0x1, payload, true); // text frame, masked (client must mask)
  }

  _sendFrame(opcode, payload, mask = false) {
    if (!this._socket || this._socket.destroyed || this.readyState !== 1) return;

    const len = payload.length;
    let header;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode; // FIN + opcode
      header[1] = (mask ? 0x80 : 0) | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = (mask ? 0x80 : 0) | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = (mask ? 0x80 : 0) | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }

    try {
      if (mask) {
        const maskKey = randomBytes(4);
        const masked = Buffer.alloc(len);
        for (let i = 0; i < len; i++) masked[i] = payload[i] ^ maskKey[i & 3];
        this._socket.write(Buffer.concat([header, maskKey, masked]));
      } else {
        this._socket.write(Buffer.concat([header, payload]));
      }
    } catch { /* EPIPE / socket closed — ignore */ }
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2; // CLOSING
    const closePayload = Buffer.alloc(2);
    closePayload.writeUInt16BE(1000, 0); // 1000 = normal closure
    this._sendFrame(0x8, closePayload, true); // client must mask all frames
    setTimeout(() => {
      if (this._socket) { this._socket.destroy(); this._socket = null; }
      this.readyState = 3;
    }, 1000);
  }
}

class VoiceManager {
  constructor(cfg) {
    this.cfg = cfg;
    this._recProc = null;
    this._ttsProc = null;
    this._tmpFiles = [];
    this._recording = false;
    this._speaking = false;
  }

  // ── Prerequisites ──────────────────────────────────────────

  checkDeps() {
    const missing = [];
    try { execSync("which rec", { stdio: "ignore" }); } catch { missing.push("sox (brew install sox)"); }
    try { execSync("which say", { stdio: "ignore" }); } catch { missing.push("say (macOS only)"); }
    try { execSync("which afplay", { stdio: "ignore" }); } catch { missing.push("afplay (macOS only)"); }
    const apiKey = this.cfg.openaiApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) missing.push("OPENAI_API_KEY (for Whisper STT)");
    return { ok: missing.length === 0, missing };
  }

  // ── Recording (STT) ───────────────────────────────────────

  get isRecording() { return this._recording; }
  get isSpeaking() { return this._speaking; }

  startRecording() {
    if (this._recording) return;
    const tmpFile = path.join(os.tmpdir(), `cloclo-voice-${Date.now()}.wav`);
    this._tmpFiles.push(tmpFile);
    this._currentRecFile = tmpFile;
    this._recording = true;

    // 16kHz mono 16-bit WAV — optimal for Whisper
    // VAD via sox silence filter: tight params for fast turn detection
    const silenceThreshold = this.cfg.voiceVadThreshold || "3%";  // amplitude threshold
    const silenceDuration = this.cfg.voiceVadSilence || "1.2";    // seconds of silence to stop
    const maxDuration = this.cfg.voiceMaxDuration || "30";        // max recording seconds

    this._recProc = spawn("rec", [
      "-q",           // quiet (no progress)
      "-r", "16000",  // sample rate
      "-c", "1",      // mono
      "-b", "16",     // bit depth
      "-e", "signed-integer",
      "-t", "wav",
      tmpFile,
      "trim", "0", maxDuration,                        // hard cap on recording length
      "silence", "1", "0.1", silenceThreshold,         // start on sound (fast: 0.1s)
      "1", silenceDuration, silenceThreshold,           // stop after silence duration
      "vad",                                            // sox built-in VAD post-filter
      "reverse", "vad", "reverse",                      // trim trailing silence too
    ], { stdio: ["ignore", "ignore", "pipe"] });

    this._recProc.stderr.on("data", (d) => log(`[voice] rec: ${d.toString().trim()}`));
    this._recProc.on("close", () => {
      this._recording = false;
      this._recProc = null;
    });
    this._recProc.on("error", (e) => {
      this._recording = false;
      this._recProc = null;
      log(`[voice] rec error: ${e.message}`);
    });
  }

  stopRecording() {
    return new Promise((resolve) => {
      if (!this._recProc) {
        this._recording = false;
        resolve(this._currentRecFile);
        return;
      }
      this._recProc.on("close", () => {
        this._recording = false;
        resolve(this._currentRecFile);
      });
      this._recProc.kill("SIGTERM");
    });
  }

  async transcribe(wavPath) {
    const apiKey = this.cfg.openaiApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("No OpenAI API key for Whisper STT");

    const fileData = fs.readFileSync(wavPath);

    // Skip empty/tiny recordings (just silence or noise)
    if (fileData.length < 4096) {
      return { text: "", language: null, duration: 0 };
    }

    // Build multipart/form-data manually (zero deps)
    const boundary = `----cloclo${Date.now()}${Math.random().toString(36).slice(2)}`;
    const parts = [];

    // model field
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n` +
      `whisper-1\r\n`
    );

    // response_format field
    parts.push(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
      `json\r\n`
    );

    // file field
    const fileName = path.basename(wavPath);
    const fileHeader =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: audio/wav\r\n\r\n`;

    const body = Buffer.concat([
      Buffer.from(parts.join("") + fileHeader, "utf-8"),
      fileData,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8"),
    ]);

    const apiUrl = this.cfg.openaiApiUrl || "https://api.openai.com";
    const resp = await fetch(`${apiUrl}/v1/audio/transcriptions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Whisper API error ${resp.status}: ${text}`);
    }

    const result = await resp.json();
    return {
      text: (result.text || "").trim(),
      language: result.language || null,
      duration: result.duration || 0,
    };
  }

  // Convenience: record → stop (on silence) → transcribe
  async recordAndTranscribe() {
    this.startRecording();
    const startTime = Date.now();

    // Wait for rec to finish (silence detection auto-stops)
    await new Promise((resolve) => {
      if (!this._recProc) { resolve(); return; }
      this._recProc.on("close", resolve);
    });
    this._recording = false;

    const recordMs = Date.now() - startTime;
    log(`[voice] Recording took ${recordMs}ms`);

    const wavPath = this._currentRecFile;
    if (!wavPath || !fs.existsSync(wavPath)) return "";

    const transcribeStart = Date.now();
    const result = await this.transcribe(wavPath);
    log(`[voice] Transcribe took ${Date.now() - transcribeStart}ms`);
    return result.text;
  }

  // ── Streaming TTS ──────────────────────────────────────────
  // Feed text deltas as they arrive from the model. Speaks sentence by sentence.

  createStreamSpeaker() {
    const self = this;
    let buffer = "";
    let speaking = false;
    const queue = [];

    const _clean = (text) => {
      return text
        .replace(/```[\s\S]*?```/g, "")  // strip code blocks
        .replace(/`[^`]+`/g, "")          // strip inline code
        .replace(/\[.*?\]\(.*?\)/g, "")   // strip markdown links
        .replace(/[#*_~>]/g, "")          // strip markdown formatting
        .trim();
    };

    const _speakNext = async () => {
      if (speaking || queue.length === 0) return;
      speaking = true;
      const sentence = queue.shift();
      const cleaned = _clean(sentence);
      if (cleaned.length > 2) {
        speaker._spoke = true;
        await self._speakSentence(cleaned);
      }
      speaking = false;
      _speakNext(); // chain next sentence
    };

    const speaker = {
      _spoke: false,
      // Feed a text delta from the streaming model
      push(delta) {
        buffer += delta;
        // Split on sentence boundaries
        const sentenceEnd = /([.!?。]\s)|(\n\n)/;
        let match;
        while ((match = sentenceEnd.exec(buffer)) !== null) {
          const sentence = buffer.substring(0, match.index + match[0].length).trim();
          buffer = buffer.substring(match.index + match[0].length);
          if (sentence) {
            queue.push(sentence);
            _speakNext();
          }
        }
      },
      // Flush remaining buffer at end of response
      async flush() {
        if (buffer.trim()) {
          queue.push(buffer.trim());
          buffer = "";
        }
        // Wait for all queued sentences to finish
        while (queue.length > 0 || speaking) {
          await new Promise(r => setTimeout(r, 100));
        }
        await _speakNext();
      },
      // Stop immediately
      stop() {
        queue.length = 0;
        buffer = "";
        self.stopSpeaking();
      },
    };
    return speaker;
  }

  async _speakSentence(text) {
    const engine = this._resolveTtsEngine();
    if (engine === "openai") {
      await this._speakOpenAI(text);
    } else {
      await this._speakMacOS(text);
    }
  }

  // Auto-resolve TTS engine based on provider
  _resolveTtsEngine() {
    // Explicit override always wins
    if (this.cfg.voiceTts && this.cfg.voiceTts !== "auto") return this.cfg.voiceTts;
    // If user has OpenAI key and is using an OpenAI model → OpenAI TTS
    const provider = this.cfg._provider;
    if (provider && (provider.name === "OpenAI" || provider.name === "OpenAI Responses")) {
      if (this.cfg.openaiApiKey || process.env.OPENAI_API_KEY) return "openai";
    }
    return "say";
  }

  // ── Playback (TTS) ────────────────────────────────────────

  async speak(text) {
    if (!text || this._speaking) return;

    // Truncate long text for TTS (don't read out code blocks)
    let ttsText = text;
    // Strip code blocks
    ttsText = ttsText.replace(/```[\s\S]*?```/g, " (code block omitted) ");
    // Strip inline code
    ttsText = ttsText.replace(/`[^`]+`/g, "");
    // Truncate to ~500 chars
    if (ttsText.length > 500) {
      ttsText = ttsText.substring(0, 500) + "...";
    }
    ttsText = ttsText.trim();
    if (!ttsText) return;

    this._speaking = true;

    const engine = this._resolveTtsEngine();

    if (engine === "openai") {
      await this._speakOpenAI(ttsText);
    } else {
      await this._speakMacOS(ttsText);
    }

    this._speaking = false;
  }

  async _speakMacOS(text) {
    const voice = this.cfg.voiceVoice || "Samantha";
    const rate = Math.round(200 * (this.cfg.voiceSpeed || 1.0));

    return new Promise((resolve) => {
      this._ttsProc = spawn("say", ["-v", voice, "-r", String(rate), text], {
        stdio: "ignore",
      });
      this._ttsProc.on("close", () => {
        this._ttsProc = null;
        resolve();
      });
      this._ttsProc.on("error", (e) => {
        log(`[voice] say error: ${e.message}`);
        this._ttsProc = null;
        resolve();
      });
    });
  }

  async _speakOpenAI(text) {
    const apiKey = this.cfg.openaiApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) { await this._speakMacOS(text); return; }

    const voice = this.cfg.voiceVoice || "nova";
    const speed = this.cfg.voiceSpeed || 1.0;
    const apiUrl = this.cfg.openaiApiUrl || "https://api.openai.com";

    try {
      const resp = await fetch(`${apiUrl}/v1/audio/speech`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "tts-1",
          voice,
          input: text,
          speed,
        }),
      });

      if (!resp.ok) {
        log(`[voice] OpenAI TTS error ${resp.status}, falling back to macOS say`);
        await this._speakMacOS(text);
        return;
      }

      // Save to temp file and play with afplay
      const tmpFile = path.join(os.tmpdir(), `cloclo-tts-${Date.now()}.mp3`);
      this._tmpFiles.push(tmpFile);
      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(tmpFile, buffer);

      await new Promise((resolve) => {
        this._ttsProc = spawn("afplay", [tmpFile], { stdio: "ignore" });
        this._ttsProc.on("close", () => { this._ttsProc = null; resolve(); });
        this._ttsProc.on("error", () => { this._ttsProc = null; resolve(); });
      });
    } catch (e) {
      log(`[voice] OpenAI TTS failed: ${e.message}, falling back to macOS say`);
      await this._speakMacOS(text);
    }
  }

  stopSpeaking() {
    if (this._ttsProc) {
      try { this._ttsProc.kill("SIGTERM"); } catch { /* already exited */ }
      this._ttsProc = null;
    }
    this._speaking = false;
  }

  // ── Cleanup ────────────────────────────────────────────────

  destroy() {
    if (this._recProc) { try { this._recProc.kill("SIGTERM"); } catch { /* already exited */ } }
    if (this._ttsProc) { try { this._ttsProc.kill("SIGTERM"); } catch { /* already exited */ } }
    for (const f of this._tmpFiles) {
      try { fs.unlinkSync(f); } catch { /* already cleaned */ }
    }
    this._tmpFiles = [];
    this._recording = false;
    this._speaking = false;
  }
}

// ── Realtime Speech-to-Speech ──────────────────────────────────────
// Uses OpenAI Realtime API (WebSocket) for true S2S with server-side VAD.
// Audio: PCM16 24kHz mono — streamed both ways.

class RealtimeSession {
  constructor(cfg, opts = {}) {
    this.cfg = cfg;
    this._ws = null;
    this._mic = null;
    this._speaker = null;
    this._active = false;
    this._audioBuf = [];       // PCM16 chunks buffer before playback
    this._audioBufBytes = 0;   // total bytes in buffer
    // no extra state needed — audio streams directly to speaker
    this._transcript = "";     // accumulated assistant transcript
    this._userTranscript = ""; // last user transcript
    this._responseActive = false; // true while assistant is generating a response
    this._audioGen = 0;        // generation counter — incremented on interrupt to discard stale audio
    this._responseAudioStarted = false; // true after first audio chunk in a response
    this._onTranscript = opts.onTranscript || (() => {});   // (role, text) callback
    this._onStateChange = opts.onStateChange || (() => {});  // (state) callback
    this._onToolCall = opts.onToolCall || null;               // (name, args) → result
    this._tools = opts.tools || [];                           // tool definitions for the session
    // Auto-detect realtime model: prefer explicit config, then try to match user's model
    this._model = cfg.voiceRealtimeModel || this._detectRealtimeModel(cfg.model);
    this._voice = cfg.voiceRealtimeVoice || "alloy";
    this._instructions = opts.instructions || "You are a helpful assistant. Be concise and conversational. Respond in the same language the user speaks.";
    this._tmpFiles = [];
    this._keepAliveInterval = null; // periodic silence sender to prevent server timeout
  }

  _detectRealtimeModel(userModel) {
    // If user model is already a realtime model, use it
    if (userModel?.includes("realtime")) return userModel;
    // Map known models to their realtime variant
    if (userModel?.startsWith("gpt-4o")) return "gpt-4o-realtime-preview";
    if (userModel?.startsWith("gpt-5")) return "gpt-4o-realtime-preview"; // fallback until gpt-5 realtime exists
    return "gpt-4o-realtime-preview";
  }

  get active() { return this._active; }

  async start() {
    const apiKey = this.cfg.openaiApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY required for Realtime API");

    this._active = true;
    this._greetOnConnect = true;
    this._onStateChange("connecting");

    // Connect WebSocket (using built-in MiniWebSocket for Node <22 compat)
    const url = `wss://api.openai.com/v1/realtime?model=${this._model}`;
    this._ws = new MiniWebSocket(url, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Realtime API connection timeout"));
        this.stop();
      }, 10000);

      this._ws.on("open", () => {
        clearTimeout(timeout);
        log("[realtime] WebSocket connected");
        this._configureSession();
        this._startMic();
        this._onStateChange("listening");
        resolve();
      });

      this._ws.on("error", (e) => {
        clearTimeout(timeout);
        log(`[realtime] WebSocket error: ${e.message || "unknown"}`);
        reject(new Error(`Realtime connection failed: ${e.message || "unknown"}`));
      });

      this._ws.on("close", (e) => {
        log(`[realtime] WebSocket closed (code ${e?.code || "?"})`);
        this._stopMic();
        this._stopSpeaker();
        this._active = false;
        this._onStateChange("disconnected");
      });

      this._ws.on("message", (msg) => {
        try {
          const event = JSON.parse(msg.data);
          this._handleEvent(event);
        } catch (e) {
          log(`[realtime] Parse error: ${e.message}`);
        }
      });
    });
  }

  _configureSession() {
    // Configure session with server VAD, tools, and instructions
    const sessionConfig = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: this._instructions,
        voice: this._voice,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: {
          model: "whisper-1",
        },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,   // 500ms silence = end of speech (fast!)
        },
      },
    };

    // Add tools if any
    if (this._tools.length > 0) {
      sessionConfig.session.tools = this._tools.map(t => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.input_schema || t.parameters || { type: "object", properties: {} },
      }));
    }

    this._send(sessionConfig);
  }

  _send(event) {
    if (this._ws?.readyState === 1) {
      this._ws.send(JSON.stringify(event));
    }
  }

  _handleEvent(event) {
    switch (event.type) {
      case "session.created":
        log(`[realtime] Session created (id: ${event.session?.id})`);
        break;

      case "session.updated":
        log("[realtime] Session configured");
        // Auto-greet: have the assistant say hello first
        if (this._greetOnConnect) {
          this._greetOnConnect = false;
          this._send({
            type: "response.create",
            response: {
              modalities: ["text", "audio"],
              instructions: "Greet the user briefly. Say hello and that you're ready to help. Keep it to one short sentence. Speak in English.",
            },
          });
        }
        break;

      case "error": {
        const errMsg = event.error?.message || JSON.stringify(event.error);
        // Suppress harmless cancellation errors
        if (errMsg.includes("Cancellation failed") || errMsg.includes("no active response")) break;
        log(`[realtime] Error: ${errMsg}`);
        this._onStateChange("error", errMsg);
        break;
      }

      // ── Input (user speaking) ──
      case "input_audio_buffer.speech_started":
        this._onStateChange("user_speaking");
        // Barge-in: interrupt any playing audio when user starts speaking
        this._interruptPlayback();
        break;

      case "input_audio_buffer.speech_stopped":
        this._onStateChange("processing");
        break;

      case "input_audio_buffer.committed":
        break;

      case "conversation.item.input_audio_transcription.completed":
        this._userTranscript = event.transcript || "";
        if (this._userTranscript.trim()) {
          this._onTranscript("user", this._userTranscript.trim());
        }
        break;

      // ── Output (assistant responding) ──
      case "response.created":
        this._transcript = "";
        this._audioQueue = [];
        this._responseActive = true;
        // Don't mute mic — server VAD handles barge-in correctly
        break;

      case "response.audio_transcript.delta":
        this._transcript += event.delta || "";
        break;

      case "response.audio_transcript.done":
        if (this._transcript.trim()) {
          this._onTranscript("assistant", this._transcript.trim());
        }
        break;

      case "response.audio.delta":
        if (event.delta) {
          // Clear stale audio buffer on first chunk (prevents echo from pre-response mic data)
          if (!this._responseAudioStarted) {
            this._responseAudioStarted = true;
            this._send({ type: "input_audio_buffer.clear" });
          }
          const pcm = Buffer.from(event.delta, "base64");
          // Stream directly to speaker — audio plays as it arrives
          // Mic stays active for barge-in detection (server VAD handles echo)
          this._enqueueAudio(pcm, this._audioGen);
        }
        break;

      case "response.audio.done":
        this._responseAudioStarted = false;
        // All audio received — close speaker stdin to let it finish playing
        this._finishSpeaker();
        break;

      // ── Tool calls ──
      case "response.function_call_arguments.done": {
        const callId = event.call_id;
        const fnName = event.name;
        let args = {};
        try { args = JSON.parse(event.arguments || "{}"); } catch { /* ignore */ }
        log(`[realtime] Tool call: ${fnName}(${JSON.stringify(args).slice(0, 80)})`);

        if (this._onToolCall) {
          // Execute tool and send result back
          Promise.resolve(this._onToolCall(fnName, args)).then(result => {
            const output = typeof result === "string" ? result : JSON.stringify(result);
            this._send({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: callId,
                output,
              },
            });
            // Trigger response generation after tool result
            this._send({ type: "response.create" });
          }).catch(e => {
            this._send({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: callId,
                output: `Error: ${e.message}`,
              },
            });
            this._send({ type: "response.create" });
          });
        }
        break;
      }

      case "response.done":
        this._responseActive = false;
        break;

      case "rate_limits.updated":
        break;

      default:
        if (event.type?.startsWith("response.content_part") || event.type?.startsWith("response.output_item")
            || event.type?.startsWith("response.function_call_arguments")
            || event.type?.startsWith("conversation.item")
            || event.type === "input_audio_buffer.cleared"
            || event.type?.includes("transcription.delta")) break;
        log(`[realtime] Unhandled: ${event.type}`);
    }
  }

  // ── Microphone (PCM16 24kHz mono → WebSocket) ──

  _startMic() {
    this._mic = spawn("rec", [
      "-q",                  // quiet
      "-r", "24000",         // 24kHz (Realtime API requirement)
      "-c", "1",             // mono
      "-b", "16",            // 16-bit
      "-e", "signed-integer",
      "-t", "raw",           // raw PCM, no headers
      "-",                   // output to stdout
    ], { stdio: ["ignore", "pipe", "ignore"] });

    this._mic.stdout.on("data", (chunk) => {
      if (!this._active || !this._ws || this._ws.readyState !== 1) return;
      // Send audio as base64
      this._send({
        type: "input_audio_buffer.append",
        audio: chunk.toString("base64"),
      });
    });

    this._mic.on("error", (e) => {
      log(`[realtime] Mic error: ${e.message}`);
    });

    this._mic.on("close", () => {
      this._mic = null;
    });
  }

  _stopMic() {
    if (this._mic) {
      try { this._mic.kill("SIGTERM"); } catch { /* already dead */ }
      this._mic = null;
    }
  }

  // Keep WebSocket alive with ping frames (not audio data, which can cause protocol errors)
  _startKeepAlive() {
    if (this._keepAliveInterval) return;
    this._keepAliveInterval = setInterval(() => {
      if (!this._active || !this._ws || this._ws.readyState !== 1) return;
      // Send WebSocket ping frame
      this._ws._sendFrame(0x9, Buffer.from("keepalive"), true);
    }, 5000); // every 5s
  }

  _stopKeepAlive() {
    if (this._keepAliveInterval) {
      clearInterval(this._keepAliveInterval);
      this._keepAliveInterval = null;
    }
  }

  // ── Speaker (streaming PCM via WAV header → play) ──
  // Sends a WAV header with max size, then streams PCM chunks directly.
  // This lets `play` start audio output immediately without temp files.

  _ensureSpeaker() {
    if (this._speaker && !this._speaker.killed) return;
    // WAV header: tells play the format upfront, max size = keep reading until EOF
    const h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(0x7FFFFFFF, 4); h.write("WAVE", 8);
    h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); // PCM
    h.writeUInt16LE(1, 22);      // mono
    h.writeUInt32LE(24000, 24);   // 24kHz
    h.writeUInt32LE(48000, 28);   // byte rate
    h.writeUInt16LE(2, 32);       // block align
    h.writeUInt16LE(16, 34);      // 16-bit
    h.write("data", 36); h.writeUInt32LE(0x7FFFFFFF, 40);

    this._speaker = spawn("play", ["-q", "-t", "wav", "-"], { stdio: ["pipe", "ignore", "ignore"] });
    this._speaker.stdin.on("error", () => { /* EPIPE on close is expected */ });
    this._speaker.on("error", (e) => { log(`[realtime] Speaker error: ${e.message}`); this._speaker = null; });
    this._speaker.on("close", (code) => {
      log(`[realtime] Speaker closed (code ${code})`);
      this._speaker = null;
    });
    this._speaker.stdin.write(h);
    log("[realtime] Speaker started (streaming WAV)");
  }

  _enqueueAudio(pcmChunk, gen) {
    if (gen !== this._audioGen) return;
    this._ensureSpeaker();
    try {
      if (this._speaker?.stdin?.writable) {
        this._speaker.stdin.write(pcmChunk);
      }
    } catch { /* speaker may have died */ }
  }

  _finishSpeaker() {
    // Close stdin to let play finish and exit
    if (this._speaker?.stdin?.writable) {
      try { this._speaker.stdin.end(); } catch { /* already closed */ }
    }
    const sp = this._speaker;
    if (sp) {
      sp.on("close", () => {
        this._onStateChange("listening");
      });
    } else {
      this._onStateChange("listening");
    }
  }

  _interruptPlayback() {
    // Increment generation so stale audio chunks are discarded
    this._audioGen++;
    this._audioBuf = [];
    this._audioBufBytes = 0;
    // Kill current speaker to stop audio immediately
    if (this._speaker) {
      try { this._speaker.kill("SIGTERM"); } catch { /* already dead */ }
      this._speaker = null;
    }
    // Unmute mic
    this._responseAudioStarted = false;
    // Only cancel if there's an active response
    if (this._responseActive) {
      this._responseActive = false;
      this._send({ type: "response.cancel" });
    }
  }

  _stopSpeaker() {
    if (this._speaker) {
      try { this._speaker.kill("SIGTERM"); } catch { /* already dead */ }
      this._speaker = null;
    }
  }

  // ── Send text message (for injecting context) ──

  sendText(text) {
    this._send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this._send({ type: "response.create" });
  }

  // ── Mute/unmute ──

  mute() { this._stopMic(); }
  unmute() { this._startMic(); }

  // ── Stop ──

  stop() {
    this._active = false;
    this._stopKeepAlive();
    this._stopMic();
    this._stopSpeaker();
    if (this._ws) {
      try { this._ws.close(); } catch { /* ignore */ }
      this._ws = null;
    }
    for (const f of this._tmpFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    this._tmpFiles = [];
  }
}

export { VoiceManager, RealtimeSession };
