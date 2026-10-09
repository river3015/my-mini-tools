import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths, collectSessions, appendHookEvent, writeAck, DEFAULT_OPTS } from "../src/store.js";
import { withHooks, withoutHooks } from "../src/hooks.js";
import { createNotifier } from "../src/notify.js";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "attn-test-"));
  const p = paths({
    ATTN_CLAUDE_DIR: path.join(root, "claude"),
    ATTN_CODEX_DIR: path.join(root, "codex"),
    ATTN_STATE_DIR: path.join(root, "state"),
  });
  return { root, p };
}

function writeClaude(p, sessionId, entries, { entrypoint = "cli", cwd = "/work/repo" } = {}) {
  const dir = path.join(p.claudeDir, "-work-repo");
  fs.mkdirSync(dir, { recursive: true });
  const lines = entries.map((e) => JSON.stringify({ sessionId, cwd, entrypoint, ...e }));
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
}

const iso = (ms) => new Date(ms).toISOString();

test("ログとフックと確認済みの印を合わせて一覧にする", () => {
  const { p } = setup();
  const now = Date.now();
  writeClaude(p, "done-1", [
    { type: "user", timestamp: iso(now - 60_000), message: { content: "作って" } },
    { type: "assistant", timestamp: iso(now - 50_000), message: { content: [{ type: "text", text: "作りました" }], stop_reason: "end_turn" } },
  ]);
  writeClaude(p, "ask-1", [
    { type: "user", timestamp: iso(now - 20_000), message: { content: "消して" } },
    { type: "assistant", timestamp: iso(now - 10_000), message: { content: [{ type: "tool_use", name: "Bash" }], stop_reason: "tool_use" } },
  ]);
  writeClaude(p, "headless", [{ type: "user", timestamp: iso(now), message: { content: "hi" } }], { entrypoint: "sdk-cli" });
  writeClaude(p, "ignored", [{ type: "user", timestamp: iso(now), message: { content: "hi" } }], { cwd: "/private/tmp/x" });

  appendHookEvent(p, { session_id: "ask-1", hook_event_name: "PermissionRequest", tool_name: "Bash" }, now - 9_000);
  appendHookEvent(p, { session_id: "ask-1", hook_event_name: "Notification", notification_type: "auth_success" }, now - 8_000);

  const opts = { ...DEFAULT_OPTS, ignore: ["/private/tmp"] };
  let sessions = collectSessions(p, opts, now);
  assert.deepEqual(sessions.map((s) => [s.sessionId, s.status]), [
    ["ask-1", "needs_approval"],
    ["done-1", "your_turn"],
  ]);
  assert.equal(sessions[1].report, "作りました");
  assert.equal(sessions[1].project, "repo");

  writeAck(p, "claude:done-1", sessions[1].lastActivity);
  sessions = collectSessions(p, opts, now);
  assert.equal(sessions.find((s) => s.sessionId === "done-1").status, "done");
});

test("フックの入力が壊れていても例外を出さず、何も書かない", () => {
  const { p } = setup();
  appendHookEvent(p, null);
  appendHookEvent(p, { hook_event_name: "Stop" });
  assert.equal(fs.existsSync(p.eventsFile), false);
});

test("フックの設定は、ほかのフックを残したまま足し引きできる", () => {
  const other = { hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] }, model: "x" };
  const added = withHooks(other, 'node "/x/attn.js" hook');
  assert.equal(added.hooks.Stop.length, 2);
  assert.equal(withHooks(added, 'node "/x/attn.js" hook').hooks.Stop.length, 2); // 何度足しても重複しない
  const removed = withoutHooks(added);
  assert.deepEqual(removed, other);
});

test("通知: 急ぎの状態に変わったときだけすぐ知らせ、あなたの番はまとめて知らせる", () => {
  const sent = [];
  let t = 0;
  const notify = createNotifier({ digestMinutes: 30, send: (title) => sent.push(title), now: () => t });
  const s = (status) => [{ key: "a", status, project: "repo", title: "x" }];
  notify(s("working")); // 最初の1回は知らせない
  notify(s("needs_approval"));
  notify(s("needs_approval")); // 変わっていなければ知らせない
  notify(s("your_turn"));
  t = 31 * 60_000;
  notify(s("your_turn"));
  assert.deepEqual(sent, ["attn: 承認待ち", "attn: 1件があなたの番"]);
});
