import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveStatus, compareSessions } from "../src/status.js";

const opts = { stallSec: 300, pendingToolSec: 90, autoDoneHours: 12 };
const now = Date.parse("2026-10-09T12:00:00Z");
const snap = (phase, secAgo, extra = {}) => ({ phase, lastActivity: now - secAgo * 1000, pendingTool: null, ...extra });

test("ログだけで決める状態", () => {
  assert.equal(resolveStatus(snap("turn_end", 10), null, null, now, opts).status, "your_turn");
  assert.equal(resolveStatus(snap("prompt", 10), null, null, now, opts).status, "working");
  assert.equal(resolveStatus(snap("prompt", 600), null, null, now, opts).status, "stalled");
  assert.equal(resolveStatus(snap("tool_pending", 30, { pendingTool: "Bash" }), null, null, now, opts).status, "working");
  assert.equal(resolveStatus(snap("tool_pending", 120, { pendingTool: "Bash" }), null, null, now, opts).status, "stalled");
  assert.equal(resolveStatus(snap("tool_pending", 1, { pendingTool: "AskUserQuestion" }), null, null, now, opts).status, "needs_input");
  assert.equal(resolveStatus(snap("tool_pending", 1, { pendingTool: "ExitPlanMode" }), null, null, now, opts).status, "needs_approval");
});

test("ログより新しいフックを信じる", () => {
  const s = snap("tool_pending", 5, { pendingTool: "Bash" });
  const hook = { event: "PermissionRequest", ts: now - 4000, message: null };
  const r = resolveStatus(s, hook, null, now, opts);
  assert.equal(r.status, "needs_approval");
  assert.equal(r.source, "hook");
});

test("フックより新しいログがあれば、ログから決める（承認した後に動いた）", () => {
  const s = snap("tool_done", 1);
  const hook = { event: "PermissionRequest", ts: now - 30_000 };
  assert.equal(resolveStatus(s, hook, null, now, opts).status, "working");
});

test("指示を出した直後はログがまだでも作業中にする", () => {
  const s = snap("turn_end", 20);
  const hook = { event: "UserPromptSubmit", ts: now - 1000 };
  assert.equal(resolveStatus(s, hook, null, now, opts).status, "working");
});

test("確認済みの印と、時間がたったものの扱い", () => {
  const s = snap("turn_end", 60);
  assert.equal(resolveStatus(s, null, s.lastActivity, now, opts).status, "done");
  // 印のあとに新しい動きがあれば、また「あなたの番」に戻る
  assert.equal(resolveStatus(s, null, s.lastActivity - 1, now, opts).status, "your_turn");
  assert.equal(resolveStatus(snap("turn_end", 13 * 3600), null, null, now, opts).status, "done");
});

test("並び順: 急ぎが先、あなた待ちは待たせている時間が長い順", () => {
  const list = [
    { status: "working", lastActivity: 5 },
    { status: "your_turn", lastActivity: 9 },
    { status: "your_turn", lastActivity: 3 },
    { status: "needs_approval", lastActivity: 10 },
  ].sort(compareSessions);
  assert.deepEqual(list.map((s) => [s.status, s.lastActivity]), [
    ["needs_approval", 10],
    ["your_turn", 3],
    ["your_turn", 9],
    ["working", 5],
  ]);
});

test("あなたの番は、あなたにしてほしいことの急ぐ順。4行がないものは「確認」と同じ扱い", () => {
  const s = (askType, lastActivity) => ({ status: "your_turn", lastActivity, card: askType ? { askType } : null });
  const list = [s("なし", 1), s(null, 2), s("確認", 3), s("作業", 4), s("判断", 5)].sort(compareSessions);
  assert.deepEqual(list.map((x) => x.card?.askType ?? "-"), ["作業", "判断", "-", "確認", "なし"]);
});
