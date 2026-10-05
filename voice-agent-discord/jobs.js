// Claude Code（claude -p）に作業させるジョブ。同時に動かすのは1件だけ
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// 読み書きと git のコミットまでは任せ、push は Discord のボタンで承認してからボットが行う
const ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit",
  "Write",
  "Bash(ls:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git add:*)",
  "Bash(git commit:*)",
];
const DISALLOWED_TOOLS = ["Bash(git push:*)"];
const SYSTEM_PROMPT = `この依頼は、ユーザーが Discord の音声通話で AI エージェントに話した内容から作られている。
- 依頼の範囲だけを作業する。判断に迷う点があれば、推測で進めずに最終報告で質問する。
- ファイルを変更したら、意味のまとまりでコミットする。git push はしない（ユーザーが Discord で承認してから行う）。
- 最終報告は日本語で書き、最初の1〜2文に結論（何をしたか、できなかったなら何が理由か）を書く。最初の部分は読み上げに使うので、記号やコードを含めない。`;

export async function git(cwd, ...args) {
  const { stdout } = await execFileP("git", ["-C", cwd, ...args]);
  return stdout.trim();
}

// emit するイベント: done(job)
export class JobRunner extends EventEmitter {
  constructor({ repos, jobTimeoutMinutes }) {
    super();
    this.repos = repos;
    this.timeoutMs = jobTimeoutMinutes * 60_000;
    this.jobs = new Map();
    this.current = null;
    this.nextId = 1;
  }

  // 開始できなければ、理由をそのまま利用者に伝えられる文で投げる
  async start(repo, task, meta = {}) {
    if (this.current) throw new Error(`ジョブ${this.current.id}が実行中です。終わるまで待つか、取り消してください。`);
    const cwd = this.repos[repo];
    if (!cwd) {
      const names = Object.keys(this.repos);
      throw new Error(names.length ? `使えるリポジトリは ${names.join("、")} だけです。` : "使えるリポジトリが設定されていません。");
    }
    if (!task?.trim()) throw new Error("依頼内容が空です。");
    // 利用者の未コミットの変更を巻き込まないよう、作業ツリーがきれいなときだけ始める
    if (await git(cwd, "status", "--porcelain")) {
      throw new Error(`${repo} に未コミットの変更があるので、始められません。`);
    }

    const job = {
      id: this.nextId++,
      repo,
      cwd,
      task,
      meta,
      state: "running",
      startedAt: Date.now(),
      branch: await git(cwd, "rev-parse", "--abbrev-ref", "HEAD"),
      headBefore: await git(cwd, "rev-parse", "HEAD"),
    };
    const env = { ...process.env };
    delete env.CLAUDECODE; // Claude Code の中から起動したときに、入れ子とみなされないようにする
    job.proc = spawn(
      "claude",
      [
        "-p",
        task,
        "--output-format",
        "json",
        "--permission-mode",
        "acceptEdits",
        "--append-system-prompt",
        SYSTEM_PROMPT,
        "--allowedTools",
        ...ALLOWED_TOOLS,
        "--disallowedTools",
        ...DISALLOWED_TOOLS,
      ],
      { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    job.proc.stdout.on("data", (d) => (stdout += d));
    job.proc.stderr.on("data", (d) => (stderr += d));
    job.timer = setTimeout(() => this.#kill(job, "timeout"), this.timeoutMs);
    job.proc.on("error", (err) => (stderr += err.message));
    job.proc.on("close", (code) => this.#finish(job, code, stdout, stderr));

    this.jobs.set(job.id, job);
    this.current = job;
    return job;
  }

  cancel() {
    if (!this.current) return "実行中のジョブはありません。";
    const { id } = this.current;
    this.#kill(this.current, "cancelled");
    return `ジョブ${id}を取り消しました。`;
  }

  describe() {
    if (this.current) {
      const minutes = Math.floor((Date.now() - this.current.startedAt) / 60_000);
      return `ジョブ${this.current.id}（${this.current.repo}）を実行中です。開始から${minutes}分たちました。`;
    }
    const last = [...this.jobs.values()].at(-1);
    if (!last) return "まだジョブはありません。";
    return `直近のジョブ${last.id}（${last.repo}）は${stateLabel(last.state)}。${headline(last.result ?? "")}`;
  }

  get(id) {
    return this.jobs.get(id);
  }

  #kill(job, state) {
    if (job.state !== "running") return;
    job.state = state;
    job.proc.kill("SIGTERM");
  }

  async #finish(job, code, stdout, stderr) {
    clearTimeout(job.timer);
    this.current = null;
    job.finishedAt = Date.now();
    try {
      const out = JSON.parse(stdout);
      job.result = out.result ?? "";
      job.costUsd = out.total_cost_usd;
      if (job.state === "running") job.state = out.is_error ? "failed" : "done";
    } catch {
      job.result = (stderr || stdout).trim().slice(0, 1000);
      if (job.state === "running") job.state = code === 0 ? "done" : "failed";
    }
    try {
      job.commits = await git(job.cwd, "log", "--oneline", `${job.headBefore}..HEAD`);
      job.diffStat = job.commits ? await git(job.cwd, "diff", "--stat", job.headBefore, "HEAD") : "";
      job.uncommitted = await git(job.cwd, "status", "--short");
    } catch (err) {
      job.commits = "";
      job.result += `\n(git の状態を取得できませんでした: ${err.message})`;
    }
    this.emit("done", job);
  }
}

export function stateLabel(state) {
  return { done: "完了しました", failed: "失敗しました", cancelled: "取り消されました", timeout: "時間切れで止めました" }[
    state
  ];
}

// 最終報告の最初の1〜2文（読み上げ用）
export function headline(text, max = 200) {
  const sentences = text.trim().split(/(?<=[。！？])/).slice(0, 2).join("");
  return sentences.length > max ? sentences.slice(0, max) + "…" : sentences;
}
