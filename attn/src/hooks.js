// Claude Code の設定（~/.claude/settings.json）に、attn のフックを足し引きする。
// SessionStart と SessionEnd は使わない。T3 Code などはターンごとにプロセスを起動・終了するため、
// 「終わった」と「まだあなたの返事を待っている」を見分けられない。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOOK_EVENTS = ["UserPromptSubmit", "PermissionRequest", "Notification", "Stop"];
const MARK = /attn\.js"? hook$/;

export function hookCommand(binPath) {
  return `node ${JSON.stringify(binPath)} hook`;
}

export function settingsPath(env = process.env) {
  return env.ATTN_CLAUDE_SETTINGS ?? path.join(os.homedir(), ".claude", "settings.json");
}

function isOurs(group) {
  return (group.hooks ?? []).some((h) => typeof h.command === "string" && MARK.test(h.command));
}

export function withHooks(settings, command) {
  const next = structuredClone(settings);
  next.hooks ??= {};
  for (const event of HOOK_EVENTS) {
    const groups = (next.hooks[event] ?? []).filter((g) => !isOurs(g));
    groups.push({ hooks: [{ type: "command", command, timeout: 5 }] });
    next.hooks[event] = groups;
  }
  return next;
}

export function withoutHooks(settings) {
  const next = structuredClone(settings);
  if (!next.hooks) return next;
  for (const [event, groups] of Object.entries(next.hooks)) {
    const kept = groups.filter((g) => !isOurs(g));
    if (kept.length > 0) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

export function updateSettings(file, transform) {
  let current = {};
  if (fs.existsSync(file)) {
    current = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.copyFileSync(file, `${file}.bak-attn`);
  }
  const next = transform(current);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
