// claude を stream-json の入出力で1プロセス常駐させ、会話の文脈を保ったまま話す。
// 返事は文ができた順に sentence イベントで渡す（読み上げを早く始めるため）
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";

const SENTENCE_END = /[^。！？!?\n]*[。！？!?\n]+/g;

// emit するイベント: sentence(text), tool_use(name, input), turn_end({ text, isError }), exit(code)
export class ClaudeSession extends EventEmitter {
  constructor({ model, cwd, addDirs = [], systemPrompt, allowedTools, disallowedTools, mcpUrl }) {
    super();
    this.options = { model, cwd, addDirs, systemPrompt, allowedTools, disallowedTools, mcpUrl };
    this.proc = null;
    this.sessionId = null;
    this.busy = false; // 返事を作っている途中
    this.muted = false; // 割り込んだあと、その返事の残りを捨てる
    this.interrupting = false; // 止めた返事の result をまだ受け取っていない
    this.pendingText = ""; // まだ文として区切れていない返事
    this.turnText = ""; // この返事の全文
    this.history = []; // { role: "user" | "assistant", text }
  }

  get running() {
    return this.proc !== null;
  }

  start() {
    const { model, cwd, addDirs, systemPrompt, allowedTools, disallowedTools, mcpUrl } = this.options;
    const env = { ...process.env, ENABLE_TOOL_SEARCH: "false" }; // MCP のツールを探す往復を省く
    delete env.CLAUDECODE; // Claude Code の中から起動したときに、入れ子とみなされないようにする
    const args = [
      "-p",
      "--model",
      model,
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "dontAsk", // 許可していないツールは確認せずに拒否する
      // ユーザー設定（グローバルの CLAUDE.md を含む）を読まない。コミットや報告の決まりなど、通話に関係ない指示を持ち込まないため
      "--setting-sources",
      "project,local",
      "--append-system-prompt",
      systemPrompt,
      "--allowedTools",
      ...allowedTools,
      "--disallowedTools",
      ...disallowedTools,
    ];
    for (const dir of addDirs) args.push("--add-dir", dir);
    if (mcpUrl) {
      args.push("--mcp-config", JSON.stringify({ mcpServers: { bot: { type: "http", url: mcpUrl } } }), "--strict-mcp-config");
    }
    this.proc = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    this.proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    this.proc.on("error", (err) => (stderr += err.message));
    this.proc.on("exit", (code) => {
      this.proc = null;
      this.busy = false;
      this.interrupting = false;
      this.emit("exit", code, stderr.trim());
    });
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      try {
        this.#onEvent(JSON.parse(line));
      } catch (err) {
        this.emit("error", err);
      }
    });
  }

  send(text, role = "user") {
    if (!this.proc) this.start();
    this.history.push({ role, text });
    if (!this.interrupting) this.muted = false;
    this.busy = true;
    this.proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  }

  // 返事の途中なら止めて、残りを捨てる
  interrupt() {
    this.muted = true;
    this.pendingText = "";
    if (!this.busy || !this.proc) return;
    this.interrupting = true;
    const request = { type: "control_request", request_id: `interrupt-${Date.now()}`, request: { subtype: "interrupt" } };
    this.proc.stdin.write(JSON.stringify(request) + "\n");
  }

  stop() {
    this.proc?.stdin.end();
  }

  #onEvent(ev) {
    if (ev.type === "system" && ev.subtype === "init") {
      this.sessionId = ev.session_id;
    } else if (ev.type === "stream_event") {
      const e = ev.event;
      if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        this.turnText += e.delta.text;
        if (this.muted) return;
        this.pendingText += e.delta.text;
        let consumed = 0;
        for (const m of this.pendingText.matchAll(SENTENCE_END)) {
          this.#emitSentence(m[0]);
          consumed = m.index + m[0].length;
        }
        this.pendingText = this.pendingText.slice(consumed);
      } else if (e.type === "content_block_stop") {
        this.#flush();
        this.turnText += "\n";
      }
    } else if (ev.type === "assistant") {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "tool_use") this.emit("tool_use", block.name, block.input);
      }
    } else if (ev.type === "result") {
      this.#flush();
      const text = this.turnText.trim();
      if (text) this.history.push({ role: "assistant", text });
      this.turnText = "";
      this.busy = false;
      this.muted = false;
      this.interrupting = false;
      this.emit("turn_end", { text, isError: ev.is_error || ev.subtype !== "success" });
    }
  }

  #flush() {
    if (!this.muted) this.#emitSentence(this.pendingText);
    this.pendingText = "";
  }

  #emitSentence(raw) {
    const text = forSpeech(raw);
    if (text) this.emit("sentence", text);
  }
}

// 読み上げに向かない記号を落とす
export function forSpeech(text) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, "")
    .replace(/https?:\/\/\S+/g, "リンク")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*|__|^#+\s*|^\s*[-*]\s+|^\s*\d+\.\s+/gm, "")
    .replace(/[*_#>|`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[、。！？!?\s]+$/, "");
}
