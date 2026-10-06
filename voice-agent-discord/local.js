// ElevenLabs を使わない版。音声認識は macOS の SpeechTranscriber、応答は常駐させた claude、読み上げは VOICEVOX で行う。
// オーナーがボイスチャンネルに入ると同じチャンネルに入って会話を始め、抜けると会話のまとめを投稿して引き継ぎ文を書く
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";
import { Readable } from "node:stream";
import { Client, Events, GatewayIntentBits, ThreadAutoArchiveDuration } from "discord.js";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import OpusScript from "opusscript";
import { toMono16k } from "./audio.js";
import { ClaudeSession } from "./claude-session.js";
import { CONFIG_DIR, loadConfig } from "./config.js";
import { handlePushButton, jobResultMessage, log, post, pushButton, quote, resolveOwnerId } from "./discord-common.js";
import { JobRunner, git, headline, stateLabel } from "./jobs.js";
import { ALLOWED_TOOLS, DISALLOWED_TOOLS, SUMMARY_PROMPT, systemPrompt } from "./local-prompts.js";
import { startMcpServer } from "./mcp.js";
import { discordToken } from "./secrets.js";
import { Transcriber } from "./stt.js";
import { Voicevox } from "./voicevox.js";

const SILENCE_MS = 700; // この長さ黙ったら話し終わりとみなす
const MIN_PACKETS = 15; // 20ms/パケット。0.3秒未満の発話（相づちや物音）は捨てる
const SUMMARY_TIMEOUT_MS = 120_000;
const HANDOFF_DIR = joinPath(homedir(), ".agent-handoffs");
const SESSION_DIR = joinPath(CONFIG_DIR, "session"); // 常駐させる claude の作業ディレクトリ
const DEBUG = process.env.VOICE_DEBUG === "1";

const config = loadConfig();
const model = config.local.model ?? "sonnet";
// 物音でも返事が止まってしまうので、既定では割り込みを受け付けない
const bargeIn = config.local.bargeIn ?? false;
const textChannelId = config.local.textChannelId; // まとめやジョブの結果を投稿するテキストチャンネル
const runner = new JobRunner(config);
const repos = runner.repos;
const repoNames = Object.keys(repos);
const stt = new Transcriber();
const voicevox = new Voicevox({ speaker: config.local.speaker ?? 3, speedScale: config.local.speedScale ?? 1.15 });

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const player = createAudioPlayer();
const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
const EARCON = makeEarcon();

let ownerId;
let connection = null;
// 今の通話。target は投稿先（テキストチャンネルに作るスレッド）で、最初に投稿するときに作る
let call = null; // { voiceChannel, startedAt, jobs, target }
let session = null; // この通話の claude
let utterance = null; // 話している途中の発話 { chunks, packets, lastAt }
let endpointTimer = null;
let sttChain = Promise.resolve(); // 発話を話した順に文字にする

// --- 読み上げ ---
// 文ができた順に VOICEVOX で合成し（同時には1文ずつ）、再生が終わったら次を流す。
// 割り込まれたら generation を進め、それより前の文は合成も再生もしない

let generation = 0;
let synthChain = Promise.resolve();
const playQueue = []; // Promise<{ gen, pcm }>
let pumping = false;

function say(text) {
  if (!connection) return;
  const gen = generation;
  const synth = synthChain.then(() => (gen === generation ? voicevox.synthesize(text) : null));
  synthChain = synth.catch(() => {});
  playQueue.push(
    synth.then(
      (pcm) => ({ gen, pcm }),
      (err) => {
        log("synthesis failed:", err.message);
        return { gen, pcm: null };
      },
    ),
  );
  pump();
}

async function pump() {
  if (pumping || player.state.status !== AudioPlayerStatus.Idle || !playQueue.length) return;
  pumping = true;
  const { gen, pcm } = await playQueue.shift();
  pumping = false;
  if (gen === generation && pcm) play(pcm);
  else pump();
}

function play(pcm) {
  player.play(createAudioResource(Readable.from([pcm]), { inputType: StreamType.Raw }));
}

function speaking() {
  return player.state.status !== AudioPlayerStatus.Idle || playQueue.length > 0 || pumping;
}

function stopSpeech() {
  generation++;
  playQueue.length = 0;
  player.stop(true);
}

player.on(AudioPlayerStatus.Idle, pump);
player.on("error", (err) => log("player error:", err.message));

// 聞き取ったことを知らせる短い音（48kHz ステレオ、2音）
function makeEarcon() {
  const tones = [
    [880, 0.06],
    [1320, 0.08],
  ];
  const parts = tones.map(([freq, sec]) => {
    const n = Math.round(48000 * sec);
    const buf = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
      const fade = Math.min(1, i / 240, (n - i) / 240);
      const s = Math.round(Math.sin((2 * Math.PI * freq * i) / 48000) * 6000 * fade);
      buf.writeInt16LE(s, i * 4);
      buf.writeInt16LE(s, i * 4 + 2);
    }
    return buf;
  });
  return Buffer.concat(parts);
}

// --- claude との会話 ---

function startSession() {
  mkdirSync(SESSION_DIR, { recursive: true });
  const s = new ClaudeSession({
    model,
    cwd: SESSION_DIR,
    addDirs: Object.values(repos),
    systemPrompt: systemPrompt(repos),
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DISALLOWED_TOOLS,
    mcpUrl: mcp.url,
  });
  s.on("sentence", (text) => {
    if (session === s) say(text);
  });
  s.on("tool_use", (name, input) => {
    log(`tool: ${name} ${JSON.stringify(input).slice(0, 200)}`);
    // ほかのセッションへの依頼は、通話のスレッドにも残す
    if (name === "SendMessage" && call) {
      const c = call;
      callTarget(c).then((ch) => post(ch, `📤 セッション \`${input.to}\` に送信しました\n> ${quote(String(input.message ?? ""))}`));
    }
  });
  s.on("external_turn", () => log("message from another session"));
  s.on("turn_end", ({ text, isError, external }) => {
    log(`agent${external ? " (on a message from another session)" : ""}${isError ? " (interrupted or failed)" : ""}:`, text.replace(/\n+/g, " "));
    // 届いた本文は出力に出ないので、それを受けた返事を残す
    if (external && call && session === s && text) {
      const c = call;
      callTarget(c).then((ch) => post(ch, `📥 ほかのセッションから連絡がありました\n> ${quote(text)}`));
    }
  });
  s.on("error", (err) => log("claude session error:", err.message));
  s.on("exit", (code, stderr) => {
    log(`claude exited (${code})${stderr ? `: ${stderr.slice(-500)}` : ""}`);
  });
  s.start();
  return s;
}

// 会話の開始時に、話題の候補になる状況を渡してあいさつしてもらう
async function greet(s) {
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "full", timeStyle: "short" });
  const lines = [`[システム通知] 通話が始まった。現在時刻は ${now}。`, "", "# リポジトリの状態"];
  for (const [name, dir] of Object.entries(repos)) lines.push(`- ${name}: ${await repoStatus(dir)}`);
  const handoff = latestHandoff();
  if (handoff) lines.push("", `# 前回の通話のまとめ（${handoff.name}）`, handoff.text.slice(0, 2000));
  lines.push("", "短くあいさつし、話題の候補（未プッシュのコミットや、前回のやること・未解決の論点）があれば1つだけ挙げる。");
  s.send(lines.join("\n"), "system");
}

async function repoStatus(dir) {
  try {
    const branch = await git(dir, "rev-parse", "--abbrev-ref", "HEAD");
    const parts = [`ブランチ ${branch}`];
    try {
      const ahead = Number(await git(dir, "rev-list", "--count", "@{u}..HEAD"));
      parts.push(ahead ? `未プッシュのコミット ${ahead} 件` : "未プッシュのコミットなし");
    } catch {
      parts.push("上流ブランチなし");
    }
    if (await git(dir, "status", "--porcelain")) parts.push("未コミットの変更あり（ジョブは頼めない）");
    return parts.join("、");
  } catch (err) {
    return `状態を取得できない（${err.message.split("\n")[0]}）`;
  }
}

// このボットが書いた引き継ぎ文のうち、いちばん新しいもの
function latestHandoff() {
  try {
    const files = readdirSync(HANDOFF_DIR)
      .filter((f) => f.startsWith("voice-agent-") && f.endsWith(".md"))
      .map((f) => ({ name: f, mtime: statSync(joinPath(HANDOFF_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    return { name: files[0].name, text: readFileSync(joinPath(HANDOFF_DIR, files[0].name), "utf8") };
  } catch {
    return null;
  }
}

// 通話を抜けたら、まとめを投稿して引き継ぎ文を書き、claude を止める
async function closeSession(s, c) {
  if (!s.history.some((h) => h.role === "user")) {
    s.stop();
    return;
  }
  try {
    if (s.busy) {
      s.interrupt();
      await waitTurnEnd(s, 10_000);
    }
    const ended = waitTurnEnd(s, SUMMARY_TIMEOUT_MS);
    s.send(SUMMARY_PROMPT, "system");
    const { text } = await ended;
    if (!text) throw new Error("empty summary");
    const file = await writeHandoff(s, text);
    const channel = await callTarget(c);
    const unpushed = c.jobs.filter((j) => j.commits && !j.pushed);
    const header = `<@${ownerId}> 通話のまとめ（引き継ぎ文: \`${file.replace(homedir(), "~")}\`）`;
    const chunks = splitMessage(`${header}\n\n${text}`);
    for (const [i, chunk] of chunks.entries()) {
      const last = i === chunks.length - 1;
      await post(channel, chunk, last ? unpushed.slice(0, 5).map(pushButton) : []);
    }
    log(`summary posted; handoff written to ${file}`);
  } catch (err) {
    log("failed to summarize the call:", err.message);
    await post(await callTarget(c), `<@${ownerId}> 通話のまとめを作れませんでした: ${err.message}`);
  } finally {
    s.stop();
  }
}

function waitTurnEnd(s, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      s.off("turn_end", onEnd);
      reject(new Error(`no reply from claude within ${ms / 1000}s`));
    }, ms);
    const onEnd = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    s.once("turn_end", onEnd);
  });
}

// 2026-10-06 02:30
const jstStamp = (date) => date.toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" }).slice(0, 16);

async function writeHandoff(s, summary) {
  const stamp = jstStamp(new Date());
  const lines = [
    "# 引き継ぎ: 音声通話のまとめ",
    "",
    `- 作成日時: ${stamp} JST`,
    `- 作成したツール: voice-agent-discord（claude --model ${model}、セッション ${s.sessionId ?? "不明"}）`,
    "- 作業ディレクトリとブランチ:",
  ];
  for (const [name, dir] of Object.entries(repos)) {
    try {
      const branch = await git(dir, "rev-parse", "--abbrev-ref", "HEAD");
      const head = await git(dir, "log", "-1", "--format=%h %s");
      lines.push(`  - ${name}（${dir}）: ${branch}、最新コミット ${head}`);
    } catch {
      lines.push(`  - ${name}（${dir}）: 状態を取得できない`);
    }
  }
  lines.push("", summary.trim(), "");
  mkdirSync(HANDOFF_DIR, { recursive: true });
  const file = joinPath(HANDOFF_DIR, `voice-agent-${stamp.replace(/[-: ]/g, "").replace(/^(\d{8})/, "$1-")}.md`);
  writeFileSync(file, lines.join("\n"));
  return file;
}

// Discord の上限（2000文字）に収まるよう、行の区切りで分ける
function splitMessage(text, max = 1900) {
  const chunks = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && current.length + line.length + 1 > max) {
      chunks.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + line.slice(0, max);
  }
  if (current) chunks.push(current);
  return chunks;
}

// 投稿先。textChannelId があればそこに通話ごとのスレッドを作り、なければ（作れなければ）ボイスチャンネルのチャットにする
function callTarget(c) {
  c.target ??= openThread(c).catch((err) => {
    log("failed to create a thread; posting to the voice channel chat:", err.message);
    return c.voiceChannel;
  });
  return c.target;
}

async function openThread(c) {
  if (!textChannelId) return c.voiceChannel;
  const channel = await client.channels.fetch(textChannelId);
  const thread = await channel.threads.create({
    name: `${jstStamp(c.startedAt)} の通話`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
  });
  log(`created thread "${thread.name}"`);
  return thread;
}

// --- ジョブ（claude から MCP のツールで呼ばれる） ---

const mcp = await startMcpServer("bot", {
  run_claude_code: {
    description:
      "Claude Code に、リポジトリの調査やコードの変更を依頼する。依頼はバックグラウンドで実行され、すぐにジョブ番号が返る。結果は後で [システム通知] で届く。",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "作業するリポジトリの名前" },
        task: { type: "string", description: "Claude Code への具体的な指示（日本語）" },
      },
      required: ["repo", "task"],
    },
    handler: async ({ repo, task }) => {
      if (!call) throw new Error("通話中ではないので、ジョブを始められません。");
      const c = call;
      const job = await runner.start(repo, task, { call: c });
      c.jobs.push(job);
      log(`job ${job.id} started: ${task.replace(/\n/g, " ").slice(0, 200)}`);
      await post(await callTarget(c), `🛠️ ジョブ${job.id}（${job.repo}）を開始しました\n> ${quote(job.task)}`);
      return `ジョブ${job.id}を開始しました。`;
    },
  },
  get_job_status: {
    description: "Claude Code のジョブが実行中か、直近のジョブの結果を調べる。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => runner.describe(),
  },
  cancel_job: {
    description: "実行中の Claude Code のジョブを取り消す。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => runner.cancel(),
  },
});

runner.on("done", async (job) => {
  log(`job ${job.id} ${job.state}`);
  const { content, components } = jobResultMessage(job, ownerId);
  await post(await callTarget(job.meta.call), content, components);
  if (session && connection) {
    session.send(
      `[システム通知] ジョブ${job.id}（${job.repo}）が${stateLabel(job.state)}。報告の要点: ${headline(job.result ?? "")}` +
        (job.commits ? " コミットがあり、Discord のボタンでプッシュできる。" : ""),
      "system",
    );
  }
});

client.on(Events.InteractionCreate, (interaction) => handlePushButton(interaction, { ownerId, runner }));

// --- Discord の音声 ---

function onOwnerPacket(packet) {
  let pcm;
  try {
    pcm = decoder.decode(packet);
  } catch (err) {
    if (DEBUG) log("opus decode error:", err.message);
    return;
  }
  if (!utterance) utterance = { chunks: [], packets: 0 };
  utterance.chunks.push(toMono16k(pcm));
  utterance.packets++;
  utterance.lastAt = Date.now();
  // 一定の長さ話したら、読み上げや返事の途中でも止めてこちらの話を聞く（bargeIn を有効にしたときだけ）
  if (bargeIn && utterance.packets === MIN_PACKETS && (speaking() || session?.busy)) {
    log("barge-in");
    stopSpeech();
    session?.interrupt();
  }
}

function checkEndpoint() {
  if (!utterance || Date.now() - utterance.lastAt < SILENCE_MS) return;
  const u = utterance;
  utterance = null;
  if (u.packets < MIN_PACKETS) return;
  const pcm = Buffer.concat(u.chunks);
  sttChain = sttChain.then(() => handleUtterance(pcm, u.packets));
}

async function handleUtterance(pcm, packets) {
  const started = Date.now();
  let text;
  try {
    text = await stt.transcribe(pcm);
  } catch (err) {
    log("transcription failed:", err.message);
    return;
  }
  log(`you (${(packets * 0.02).toFixed(1)}s, stt ${Date.now() - started}ms):`, text || "(empty)");
  if (!text || !session || !connection) return;
  if (!speaking()) {
    play(EARCON);
  } else if (bargeIn) {
    // 話している間に読み上げが始まっていたら、ここで止める
    stopSpeech();
    session.interrupt();
    play(EARCON);
  }
  // 割り込まない場合は読み上げを続け、発言は claude に送る（返事の途中なら同じ返事に取り込まれる）
  session.send(text);
}

async function join(channel) {
  call = { voiceChannel: channel, startedAt: new Date(), jobs: [], target: null };
  connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    debug: DEBUG,
  });
  const conn = connection;
  if (DEBUG) conn.on("debug", (m) => log("[voice]", m));
  conn.on("error", (err) => log("connection error:", err.message));
  try {
    await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    log("failed to connect within 20s");
    leave();
    return;
  }
  if (connection !== conn) return;
  log(`joined #${channel.name}`);
  conn.subscribe(player);
  conn.receiver
    .subscribe(ownerId, { end: { behavior: EndBehaviorType.Manual } })
    .on("data", onOwnerPacket)
    .on("error", (err) => log("receive error:", err.message));
  endpointTimer = setInterval(checkEndpoint, 50);
  session = startSession();
  await greet(session);
}

function leave() {
  clearInterval(endpointTimer);
  endpointTimer = null;
  utterance = null;
  stopSpeech();
  if (session) {
    log("call ended; summarizing");
    closeSession(session, call);
    session = null;
  }
  call = null;
  if (!connection) return;
  connection.destroy();
  connection = null;
  log("left the voice channel");
}

client.once(Events.ClientReady, async () => {
  ownerId = await resolveOwnerId(client);
  log(`logged in as ${client.user.tag}; model: ${model}; repos: ${repoNames.join(", ") || "(none)"}`);
  log("waiting for the owner to join a voice channel");
  for (const guild of client.guilds.cache.values()) {
    const state = guild.voiceStates.cache.get(ownerId);
    if (state?.channel) await join(state.channel);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (newState.id !== ownerId || oldState.channelId === newState.channelId) return;
  if (oldState.channelId) leave();
  if (newState.channel) await join(newState.channel);
});

function shutdown() {
  // 終了時はまとめを待たない
  session?.stop();
  session = null;
  leave();
  stt.stop();
  voicevox.stop();
  mcp.close();
  client.destroy().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all([stt.start(log), voicevox.start(log)]);
log("speech recognition and VOICEVOX are ready");
client.login(discordToken());
