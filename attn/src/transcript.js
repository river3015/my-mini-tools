// Claude Code と Codex のセッションログ（JSONL）から、セッションの今の様子を取り出す。
// どちらも「最後に何が起きたか」だけを見る。ログ全体を理解しようとはしない。

const TEXT_LIMIT = 4000;

// 最後の行（phase）の意味:
//   prompt       … あなたが指示を出した直後。モデルが考えている
//   tool_pending … ツールを呼んだ。実行中か、承認を待っている
//   tool_done    … ツールの結果が返った。モデルが続きを考えている
//   turn_end     … 応答を返し終えた。あなたの番
//   interrupted  … あなたが中断した。あなたの番
function emptySnapshot(agent) {
  return {
    agent,
    sessionId: null,
    entrypoint: null,
    cwd: null,
    branch: null,
    title: null,
    lastPrompt: null,
    finalText: null,
    lastText: null,
    phase: null,
    pendingTool: null,
    lastActivity: null,
    lastPromptAt: null,
  };
}

function clip(text) {
  if (typeof text !== "string") return null;
  const t = text.trim();
  return t.length > TEXT_LIMIT ? `${t.slice(0, TEXT_LIMIT)}…` : t;
}

function parseLine(line) {
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function timeOf(entry) {
  const t = Date.parse(entry.timestamp);
  return Number.isNaN(t) ? null : t;
}

// エージェントが会話に差し込む文（システムからの注記やコマンドの出力）は、あなたの指示として数えない。
function looksInjected(text) {
  const t = text.trimStart();
  return t.startsWith("<") || t.startsWith("[Request interrupted");
}

// --- Claude Code: ~/.claude/projects/<dir>/<sessionId>.jsonl ---

export function parseClaude(lines) {
  const s = emptySnapshot("claude");
  for (const line of lines) {
    const e = parseLine(line);
    if (!e || e.isSidechain) continue;
    if (e.sessionId) s.sessionId = e.sessionId;
    if (e.entrypoint) s.entrypoint = e.entrypoint;

    if (e.type === "ai-title" && e.aiTitle) s.title = e.aiTitle;
    if (e.type === "last-prompt" && e.lastPrompt) s.lastPrompt = clip(e.lastPrompt);
    if (e.type !== "user" && e.type !== "assistant") continue;

    const t = timeOf(e);
    if (t) s.lastActivity = t;
    if (e.cwd) s.cwd = e.cwd;
    if (e.gitBranch && e.gitBranch !== "HEAD") s.branch = e.gitBranch;

    const msg = e.message ?? {};
    const content = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content ?? [];

    if (e.type === "user") {
      if (content.some((c) => c.type === "tool_result")) {
        s.phase = "tool_done";
        s.pendingTool = null;
        continue;
      }
      const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      if (text.includes("[Request interrupted by user")) {
        s.phase = "interrupted";
        s.pendingTool = null;
      } else if (!e.isMeta && text && !looksInjected(text)) {
        s.phase = "prompt";
        s.pendingTool = null;
        s.lastPrompt = clip(text);
        s.lastPromptAt = t;
      }
      continue;
    }

    // assistant: 1つの応答が、thinking・text・tool_use ごとに別の行で書かれる。
    for (const c of content) {
      if (c.type === "text" && c.text?.trim()) s.lastText = clip(c.text);
      if (c.type === "tool_use") {
        s.phase = "tool_pending";
        s.pendingTool = c.name ?? null;
      }
    }
    if (msg.stop_reason === "end_turn" || msg.stop_reason === "stop_sequence") {
      s.phase = "turn_end";
      s.pendingTool = null;
      if (s.lastText) s.finalText = s.lastText;
    }
  }
  return s;
}

// --- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ---

export function parseCodex(lines) {
  const s = emptySnapshot("codex");
  for (const line of lines) {
    const e = parseLine(line);
    if (!e) continue;
    const p = e.payload ?? {};
    const t = timeOf(e);

    if (e.type === "session_meta") {
      s.sessionId = p.id ?? p.session_id ?? s.sessionId;
      s.cwd = p.cwd ?? s.cwd;
      s.entrypoint = p.originator ?? s.entrypoint;
      continue;
    }
    if (e.type === "turn_context" && p.cwd) s.cwd = p.cwd;

    if (e.type === "event_msg") {
      if (p.type === "task_started") s.phase = "prompt";
      else if (p.type === "task_complete") {
        s.phase = "turn_end";
        s.pendingTool = null;
        if (p.last_agent_message) s.finalText = clip(p.last_agent_message);
      } else if (p.type === "turn_aborted") {
        s.phase = "interrupted";
        s.pendingTool = null;
      } else continue;
      if (t) s.lastActivity = t;
      continue;
    }

    if (e.type !== "response_item") continue;
    if (t) s.lastActivity = t;
    if (p.type === "message") {
      const text = (p.content ?? [])
        .filter((c) => c.type === "input_text" || c.type === "output_text")
        .map((c) => c.text)
        .join("\n");
      if (p.role === "user" && text && !looksInjected(text)) {
        s.lastPrompt = clip(text);
        s.lastPromptAt = t;
        if (!s.title) s.title = clip(text.split("\n")[0].slice(0, 80));
      } else if (p.role === "assistant" && text.trim()) {
        s.lastText = clip(text);
      }
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      s.phase = "tool_pending";
      s.pendingTool = p.name ?? null;
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      s.phase = "tool_done";
      s.pendingTool = null;
    }
  }
  return s;
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|https:\/\/[\w.-]+\/[\w./-]+\/-\/merge_requests\/\d+/g;

export function findPullRequests(...texts) {
  const urls = new Set();
  for (const text of texts) {
    for (const m of (text ?? "").matchAll(PR_URL)) urls.add(m[0]);
  }
  return [...urls];
}
