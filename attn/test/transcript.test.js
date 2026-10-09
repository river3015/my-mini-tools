import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaude, parseCodex, findPullRequests, parseCard } from "../src/transcript.js";

const sid = "s-1";
const base = { sessionId: sid, cwd: "/repo", gitBranch: "feat/x", entrypoint: "cli" };
const line = (o) => JSON.stringify(o);
const user = (content, ts, extra = {}) => line({ ...base, type: "user", timestamp: ts, message: { role: "user", content }, ...extra });
const assistant = (content, stop, ts) => line({ ...base, type: "assistant", timestamp: ts, message: { role: "assistant", content, stop_reason: stop } });

test("Claude: 応答を返し終えたら turn_end で、最後の報告を拾う", () => {
  const s = parseClaude([
    line({ type: "ai-title", aiTitle: "テスト", sessionId: sid }),
    user("ビルドを直して", "2026-10-09T00:00:00Z"),
    assistant([{ type: "tool_use", name: "Bash", input: {} }], "tool_use", "2026-10-09T00:00:01Z"),
    user([{ type: "tool_result", content: "ok" }], "2026-10-09T00:00:02Z"),
    assistant([{ type: "text", text: "直しました https://github.com/a/b/pull/3" }], "end_turn", "2026-10-09T00:00:03Z"),
  ]);
  assert.equal(s.phase, "turn_end");
  assert.equal(s.title, "テスト");
  assert.equal(s.lastPrompt, "ビルドを直して");
  assert.equal(s.finalText, "直しました https://github.com/a/b/pull/3");
  assert.equal(s.branch, "feat/x");
  assert.equal(s.entrypoint, "cli");
  assert.equal(s.lastActivity, Date.parse("2026-10-09T00:00:03Z"));
});

test("Claude: ツールを呼んだまま結果がなければ tool_pending", () => {
  const s = parseClaude([
    user("質問して", "2026-10-09T00:00:00Z"),
    assistant([{ type: "tool_use", name: "AskUserQuestion", input: {} }], "tool_use", "2026-10-09T00:00:01Z"),
  ]);
  assert.equal(s.phase, "tool_pending");
  assert.equal(s.pendingTool, "AskUserQuestion");
});

test("Claude: 差し込まれた文やサブエージェントの行は指示として数えない", () => {
  const s = parseClaude([
    user("本当の指示", "2026-10-09T00:00:00Z"),
    user("<system-reminder>x</system-reminder>", "2026-10-09T00:00:01Z"),
    user("meta", "2026-10-09T00:00:02Z", { isMeta: true }),
    user("サブエージェントへの指示", "2026-10-09T00:00:03Z", { isSidechain: true }),
    "壊れた行",
  ]);
  assert.equal(s.lastPrompt, "本当の指示");
  assert.equal(s.lastActivity, Date.parse("2026-10-09T00:00:02Z"));
});

test("Claude: 中断は interrupted", () => {
  const s = parseClaude([
    user("x", "2026-10-09T00:00:00Z"),
    user([{ type: "text", text: "[Request interrupted by user]" }], "2026-10-09T00:00:01Z"),
  ]);
  assert.equal(s.phase, "interrupted");
});

test("Codex: task_complete で turn_end、注記ではない最初の指示をタイトルにする", () => {
  const ev = (ts, type, payload) => line({ timestamp: ts, type, payload });
  const s = parseCodex([
    ev("2026-10-09T00:00:00Z", "session_meta", { id: "c-1", cwd: "/repo", originator: "T3 Code" }),
    ev("2026-10-09T00:00:01Z", "event_msg", { type: "task_started" }),
    ev("2026-10-09T00:00:01Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "<env>x</env>" }] }),
    ev("2026-10-09T00:00:02Z", "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "テストを足して" }] }),
    ev("2026-10-09T00:00:03Z", "response_item", { type: "function_call", name: "exec" }),
    ev("2026-10-09T00:00:04Z", "response_item", { type: "function_call_output" }),
    ev("2026-10-09T00:00:05Z", "event_msg", { type: "task_complete", last_agent_message: "足しました" }),
  ]);
  assert.equal(s.sessionId, "c-1");
  assert.equal(s.phase, "turn_end");
  assert.equal(s.title, "テストを足して");
  assert.equal(s.finalText, "足しました");
  assert.equal(s.entrypoint, "T3 Code");
});

test("PR と MR の URL を重複なく拾う", () => {
  assert.deepEqual(
    findPullRequests("see https://github.com/a/b/pull/1 and https://gitlab.example.com/g/p/-/merge_requests/9", "https://github.com/a/b/pull/1"),
    ["https://github.com/a/b/pull/1", "https://gitlab.example.com/g/p/-/merge_requests/9"],
  );
});

test("応答の先頭の4行を読み取る（太字・全角コロン・引用の書き方の違いを許す）", () => {
  const text = [
    "**目的**: 並列のエージェントを切り替えやすくする",
    "**依頼**：報告の書式を決める",
    "> **結果:** 完了。書式を決めて attn で読めるようにした",
    "- **あなたへ**: [確認] PR #3 を見てマージ",
    "",
    "## 変更内容",
    "**結果**: 本文の中の同じ語は拾わない",
  ].join("\n");
  assert.deepEqual(parseCard(text), {
    purpose: "並列のエージェントを切り替えやすくする",
    request: "報告の書式を決める",
    result: "完了。書式を決めて attn で読めるようにした",
    ask: "PR #3 を見てマージ",
    askType: "確認",
  });
});

test("「あなたへ」が種類だけ・かっこなしでも読める。4行がなければ null", () => {
  assert.deepEqual(parseCard("**結果**: 完了\n**あなたへ**: なし"), { result: "完了", ask: null, askType: "なし" });
  assert.equal(parseCard("**あなたへ**: 判断 — A と B のどちらにするか").askType, "判断");
  assert.equal(parseCard("ふつうの報告です。\n結果として直りました。"), null);
  assert.equal(parseCard(null), null);
});
