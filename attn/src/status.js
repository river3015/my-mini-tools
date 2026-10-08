// ログから読んだ様子（snapshot）とフックのイベントを合わせて、セッションの状態を1つに決める。

export const STATUS = {
  needs_approval: { label: "承認待ち", rank: 0, urgent: true },
  needs_input: { label: "質問・入力待ち", rank: 1, urgent: true },
  stalled: { label: "動きなし", rank: 2, urgent: true },
  your_turn: { label: "あなたの番", rank: 3, urgent: false },
  working: { label: "作業中", rank: 4, urgent: false },
  done: { label: "確認済み", rank: 5, urgent: false },
};

// フックのイベントから決まる状態。null のイベントは状態を変えない。
export function statusFromHook(event) {
  switch (event.event) {
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
      return "working";
    case "PermissionRequest":
      return "needs_approval";
    case "Notification":
      if (event.notificationType === "permission_prompt") return "needs_approval";
      if (event.notificationType === "elicitation_dialog") return "needs_input";
      if (event.notificationType === "idle_prompt") return "your_turn";
      return null;
    case "Stop":
      return "your_turn";
    default:
      return null;
  }
}

// 承認や質問のために止まるツール。ログに呼び出しだけがあり、結果がまだないときに使う。
const ASK_TOOLS = new Set(["AskUserQuestion", "request_user_input"]);
const APPROVAL_TOOLS = new Set(["ExitPlanMode"]);

export function statusFromSnapshot(snap, now, opts) {
  const idleSec = snap.lastActivity ? (now - snap.lastActivity) / 1000 : Infinity;
  switch (snap.phase) {
    case "turn_end":
    case "interrupted":
      return { status: "your_turn", hint: snap.phase === "interrupted" ? "中断しました" : null };
    case "tool_pending":
      if (ASK_TOOLS.has(snap.pendingTool)) return { status: "needs_input", hint: snap.pendingTool };
      if (APPROVAL_TOOLS.has(snap.pendingTool)) return { status: "needs_approval", hint: snap.pendingTool };
      // ツールを呼んだまま止まっている。長いコマンドの実行中か、承認待ちのどちらか。
      if (idleSec > opts.pendingToolSec) {
        return { status: "stalled", hint: `${snap.pendingTool ?? "ツール"} の承認待ちか、長い実行中かも` };
      }
      return { status: "working", hint: snap.pendingTool };
    case "prompt":
    case "tool_done":
      if (idleSec > opts.stallSec) return { status: "stalled", hint: "応答が止まっている" };
      return { status: "working", hint: null };
    default:
      return { status: "your_turn", hint: null };
  }
}

// フックはその場で起きたことを確実に伝えるので、ログより新しければフックを信じる。
// ログのほうが新しい（承認した後にツールが動いた、など）ならログから決める。
export function resolveStatus(snap, hook, ack, now, opts) {
  let result = statusFromSnapshot(snap, now, opts);
  let source = "log";
  const hookStatus = hook ? statusFromHook(hook) : null;
  if (hookStatus && hook.ts >= (snap.lastActivity ?? 0) - 1000) {
    // Stop の後もログのほうが「考え中」に見えることはないので、そのまま採用する。
    // working はログの判定（止まっているかどうか）を優先する。
    if (hookStatus !== "working" || result.status === "your_turn") {
      result = { status: hookStatus, hint: hook.message ?? null };
    }
    source = "hook";
  }
  const lastActivity = Math.max(snap.lastActivity ?? 0, hook?.ts ?? 0) || null;
  if (result.status === "your_turn") {
    if (ack && lastActivity && ack >= lastActivity) result = { status: "done", hint: null };
    else if (lastActivity && now - lastActivity > opts.autoDoneHours * 3600_000) {
      result = { status: "done", hint: `${opts.autoDoneHours}時間以上前に終わったもの` };
    }
  }
  return { ...result, source, lastActivity };
}

export function compareSessions(a, b) {
  const r = STATUS[a.status].rank - STATUS[b.status].rank;
  if (r !== 0) return r;
  // あなた待ちは、待たせている時間が長い順。それ以外は新しい順。
  if (STATUS[a.status].rank <= STATUS.your_turn.rank) return (a.lastActivity ?? 0) - (b.lastActivity ?? 0);
  return (b.lastActivity ?? 0) - (a.lastActivity ?? 0);
}
