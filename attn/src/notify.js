// 状態の変化を見て、macOS の通知を出す。
// 止まると困るもの（承認・質問・動きなし）はすぐ、返答が来ただけのものは間隔をあけてまとめて知らせる。

import { execFile } from "node:child_process";
import { STATUS } from "./status.js";

export function macNotify(title, message) {
  const q = (s) => `"${String(s).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  execFile("osascript", ["-e", `display notification ${q(message)} with title ${q(title)}`], () => {});
}

export function createNotifier({ digestMinutes, send = macNotify, now = () => Date.now() }) {
  let previous = null; // key -> status
  let lastDigest = now();
  return function onSessions(sessions) {
    const current = new Map(sessions.map((s) => [s.key, s.status]));
    if (previous) {
      for (const s of sessions) {
        if (!STATUS[s.status].urgent || previous.get(s.key) === s.status) continue;
        send(`attn: ${STATUS[s.status].label}`, `${s.project ?? "?"} — ${s.title ?? s.lastPrompt ?? s.sessionId}`.slice(0, 180));
      }
    }
    previous = current;

    if (digestMinutes > 0 && now() - lastDigest >= digestMinutes * 60_000) {
      lastDigest = now();
      const waiting = sessions.filter((s) => s.status === "your_turn");
      if (waiting.length > 0) {
        const names = waiting.map((s) => s.project ?? "?").join(", ");
        send(`attn: ${waiting.length}件があなたの番`, names.slice(0, 180));
      }
    }
  };
}
