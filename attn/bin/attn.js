#!/usr/bin/env node
// attn: 複数の AI エージェントのセッションのうち、あなたを待っているものを1か所に集める。

import fs from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { paths, collectSessions, appendHookEvent, DEFAULT_OPTS } from "../src/store.js";
import { STATUS } from "../src/status.js";
import { startServer } from "../src/server.js";
import { hookCommand, settingsPath, updateSettings, withHooks, withoutHooks, HOOK_EVENTS } from "../src/hooks.js";

const USAGE = `使い方:
  attn serve [--port 7878] [--hours 24] [--wip 3] [--no-notify] [--digest 30]
      画面（http://127.0.0.1:7878/）を出し、承認待ちなどを macOS の通知で知らせる
  attn list [--hours 24] [--json]
      今の状態を端末に表示する
  attn hooks [--install | --uninstall]
      Claude Code のフックの設定を表示する。--install で ~/.claude/settings.json に足す
  attn hook
      （Claude Code のフックから呼ばれる。標準入力のイベントを記録する）`;

const BIN = fileURLToPath(import.meta.url);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      port: { type: "string", default: "7878" },
      hours: { type: "string", default: String(DEFAULT_OPTS.hours) },
      wip: { type: "string", default: "3" },
      "no-notify": { type: "boolean", default: false },
      digest: { type: "string", default: "30" },
      json: { type: "boolean", default: false },
      install: { type: "boolean", default: false },
      uninstall: { type: "boolean", default: false },
    },
  });
  const p = paths();
  const opts = { ...DEFAULT_OPTS, hours: Number(values.hours) };

  switch (cmd) {
    case "hook":
      return runHook(p);
    case "serve":
      startServer({
        p,
        opts,
        port: Number(values.port),
        wipLimit: Number(values.wip),
        notify: !values["no-notify"],
        digestMinutes: Number(values.digest),
      });
      return;
    case "list":
      return list(p, opts, values.json);
    case "hooks":
      return hooks(values);
    default:
      console.log(USAGE);
      process.exitCode = cmd ? 1 : 0;
  }
}

// フックは Claude Code の動きを止めないよう、失敗しても黙って終わる。標準出力にも何も書かない
// （SessionStart や UserPromptSubmit の標準出力は会話に差し込まれるため）。
async function runHook(p) {
  try {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    appendHookEvent(p, JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    // 記録できなくても Claude Code には影響させない
  }
}

function list(p, opts, asJson) {
  const sessions = collectSessions(p, opts);
  if (asJson) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }
  if (sessions.length === 0) {
    console.log(`直近${opts.hours}時間に動いたセッションはありません。`);
    return;
  }
  const now = Date.now();
  for (const s of sessions) {
    const label = STATUS[s.status].label.padEnd(8, "　");
    const where = `${s.project ?? "?"}${s.branch ? `@${s.branch}` : ""}`;
    const title = (s.title ?? s.lastPrompt ?? "").split("\n")[0].slice(0, 50);
    console.log(`${label} ${ago(now - s.lastActivity).padStart(6)}  ${s.agent.padEnd(6)} ${where}  ${title}`);
    const ask = s.card?.askType ? `あなたへ[${s.card.askType}] ${s.card.ask ?? ""}` : null;
    if (ask || s.hint) console.log(`${" ".repeat(26)}└ ${ask ?? s.hint}`);
  }
}

function ago(ms) {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "今";
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}時間前` : `${Math.floor(h / 24)}日前`;
}

function hooks(values) {
  const file = settingsPath();
  const command = hookCommand(BIN);
  if (values.install) {
    updateSettings(file, (s) => withHooks(s, command));
    console.log(`${file} に ${HOOK_EVENTS.join(", ")} のフックを足しました（元の設定は ${file}.bak-attn）。`);
    console.log("新しく始めたセッションから効きます。");
    return;
  }
  if (values.uninstall) {
    if (!fs.existsSync(file)) return;
    updateSettings(file, withoutHooks);
    console.log(`${file} から attn のフックを外しました。`);
    return;
  }
  console.log(`~/.claude/settings.json に足す設定（attn hooks --install で自動で足せます）:\n`);
  console.log(JSON.stringify(withHooks({}, command), null, 2));
}

main();
