// ログの場所を探して読み、フックのイベントと確認済みの印を保存する。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseClaude, parseCodex, findPullRequests } from "./transcript.js";
import { resolveStatus, compareSessions, statusFromHook } from "./status.js";

export function paths(env = process.env) {
  const home = os.homedir();
  const stateDir = env.ATTN_STATE_DIR ?? path.join(home, ".local", "state", "attn");
  return {
    claudeDir: env.ATTN_CLAUDE_DIR ?? path.join(home, ".claude", "projects"),
    codexDir: env.ATTN_CODEX_DIR ?? path.join(home, ".codex", "sessions"),
    stateDir,
    eventsFile: path.join(stateDir, "events.jsonl"),
    acksFile: path.join(stateDir, "acks.json"),
  };
}

// --- ログを読む ---

const TAIL_BYTES = 512 * 1024;

// 大きいログは末尾だけ読む。タイトルや最初の指示が末尾にないときだけ、全体を読み直す。
function readLines(file, size, fromStart) {
  const start = fromStart ? 0 : Math.max(0, size - TAIL_BYTES);
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // 途中から読んだ最初の行は欠けている
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

const cache = new Map(); // file -> { mtimeMs, size, snap }

function readSnapshot(file, agent, stat) {
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.snap;
  const parse = agent === "claude" ? parseClaude : parseCodex;
  let snap = parse(readLines(file, stat.size, false));
  if (stat.size > TAIL_BYTES && (!snap.title || !snap.cwd || !snap.sessionId)) {
    const full = parse(readLines(file, stat.size, true));
    snap = { ...snap, title: snap.title ?? full.title, cwd: snap.cwd ?? full.cwd, sessionId: snap.sessionId ?? full.sessionId };
  }
  cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, snap });
  return snap;
}

function statIfRecent(file, since) {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.mtimeMs >= since ? st : null;
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

export function findTranscripts(p, since) {
  const found = [];
  for (const project of listDir(p.claudeDir)) {
    const dir = path.join(p.claudeDir, project);
    for (const name of listDir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      const stat = statIfRecent(file, since);
      if (stat) found.push({ file, agent: "claude", stat });
    }
  }
  // Codex は日付のディレクトリに分かれている。対象期間の日付だけを見る。
  for (let t = since - 86400_000; t <= Date.now() + 86400_000; t += 86400_000) {
    const d = new Date(t);
    const dir = path.join(
      p.codexDir,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, "0"),
      String(d.getDate()).padStart(2, "0"),
    );
    for (const name of listDir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(dir, name);
      const stat = statIfRecent(file, since);
      if (stat) found.push({ file, agent: "codex", stat });
    }
  }
  return found;
}

// --- フックのイベント ---

const EVENTS_MAX_BYTES = 2 * 1024 * 1024;

// Claude Code のフックから呼ばれる。何があっても例外を外に出さず、すぐ終わる。
export function appendHookEvent(p, input, now = Date.now()) {
  if (!input?.session_id || !input?.hook_event_name) return;
  const event = {
    ts: now,
    sessionId: input.session_id,
    event: input.hook_event_name,
    notificationType: input.notification_type ?? null,
    message: typeof input.message === "string" ? input.message.slice(0, 200) : null,
    tool: input.tool_name ?? null,
    cwd: input.cwd ?? null,
    transcript: input.transcript_path ?? null,
  };
  fs.mkdirSync(p.stateDir, { recursive: true });
  fs.appendFileSync(p.eventsFile, `${JSON.stringify(event)}\n`);
  if (fs.statSync(p.eventsFile).size > EVENTS_MAX_BYTES) compactEvents(p);
}

function compactEvents(p) {
  const latest = readHookEvents(p);
  const tmp = `${p.eventsFile}.tmp`;
  fs.writeFileSync(tmp, [...latest.values()].map((e) => `${JSON.stringify(e)}\n`).join(""));
  fs.renameSync(tmp, p.eventsFile);
}

// セッションごとに、状態を変えた最新のイベントを返す。
export function readHookEvents(p) {
  const latest = new Map();
  let text;
  try {
    text = fs.readFileSync(p.eventsFile, "utf8");
  } catch {
    return latest;
  }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      // 状態を決めないイベント（認証成功の通知など）で、直前の「承認待ち」を上書きしない。
      if (statusFromHook(e) === null) continue;
      latest.set(e.sessionId, e);
    } catch {
      // 壊れた行は読み飛ばす
    }
  }
  return latest;
}

// --- 確認済みの印 ---

export function readAcks(p) {
  try {
    return JSON.parse(fs.readFileSync(p.acksFile, "utf8"));
  } catch {
    return {};
  }
}

export function writeAck(p, key, ts) {
  const acks = readAcks(p);
  if (ts) acks[key] = ts;
  else delete acks[key];
  // 古い印は捨てる（30日）
  const limit = Date.now() - 30 * 86400_000;
  for (const [k, v] of Object.entries(acks)) if (v < limit) delete acks[k];
  fs.mkdirSync(p.stateDir, { recursive: true });
  const tmp = `${p.acksFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(acks, null, 2));
  fs.renameSync(tmp, p.acksFile);
}

// --- まとめ ---

// cd で下のディレクトリに移っていても、プロジェクトは git のルートで表す。
const rootCache = new Map();
function gitRoot(cwd) {
  if (!cwd) return null;
  if (rootCache.has(cwd)) return rootCache.get(cwd);
  let root = null;
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      root = dir;
      break;
    }
    if (path.dirname(dir) === dir) break;
  }
  rootCache.set(cwd, root);
  return root;
}

function readBranchFromGit(root) {
  if (!root) return null;
  try {
    let gitDir = path.join(root, ".git");
    if (fs.statSync(gitDir).isFile()) {
      // worktree では .git がファイルで、本当の場所を指している
      gitDir = path.resolve(root, fs.readFileSync(gitDir, "utf8").replace(/^gitdir:\s*/, "").trim());
    }
    const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : null;
  } catch {
    return null;
  }
}

// 人が返事をしないセッション（claude -p や codex exec で動かしたもの）は出さない。
const NON_INTERACTIVE = new Set(["sdk-cli", "codex_exec"]);

function ignored(snap, ignore) {
  if (NON_INTERACTIVE.has(snap.entrypoint)) return true;
  return ignore.some((prefix) => snap.cwd?.startsWith(prefix));
}

export const DEFAULT_OPTS = {
  hours: 24, // この時間内に動いたセッションだけを出す
  stallSec: 300, // 考え中のまま、この秒数ログが動かなければ「動きなし」
  pendingToolSec: 90, // ツールを呼んだまま、この秒数動かなければ「動きなし」（承認待ちかも）
  autoDoneHours: 12, // 「あなたの番」のまま、この時間がたったものは確認済みとして扱う
  // このパスで始まる場所のセッションは出さない。試しに動かした claude -p などが /tmp に溜まるため
  ignore: (process.env.ATTN_IGNORE ?? "/tmp,/private/tmp").split(",").filter(Boolean),
};

export function collectSessions(p, opts = DEFAULT_OPTS, now = Date.now()) {
  const since = now - opts.hours * 3600_000;
  const hooks = readHookEvents(p);
  const acks = readAcks(p);
  const sessions = [];
  for (const { file, agent, stat } of findTranscripts(p, since)) {
    let snap;
    try {
      snap = readSnapshot(file, agent, stat);
    } catch {
      continue;
    }
    if (!snap.sessionId || !snap.lastActivity || ignored(snap, opts.ignore)) continue;
    const key = `${agent}:${snap.sessionId}`;
    const hook = agent === "claude" ? hooks.get(snap.sessionId) : null;
    const resolved = resolveStatus(snap, hook, acks[key], now, opts);
    const root = gitRoot(snap.cwd) ?? snap.cwd;
    sessions.push({
      key,
      agent,
      sessionId: snap.sessionId,
      cwd: snap.cwd,
      project: root ? path.basename(root) : null,
      branch: snap.branch ?? readBranchFromGit(root),
      title: snap.title,
      lastPrompt: snap.lastPrompt,
      lastPromptAt: snap.lastPromptAt,
      report: snap.finalText ?? snap.lastText,
      pullRequests: findPullRequests(snap.finalText, snap.lastText),
      ...resolved,
      resumeCommand:
        agent === "claude"
          ? `cd ${shellQuote(root ?? ".")} && claude --resume ${snap.sessionId}`
          : `cd ${shellQuote(root ?? ".")} && codex resume ${snap.sessionId}`,
    });
  }
  sessions.sort(compareSessions);
  return sessions;
}

function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}
