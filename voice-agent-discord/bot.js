// オーナーがボイスチャンネルに入ると同じチャンネルに入り、ElevenLabs Agents と音声で会話させる。
// エージェントが Claude Code に作業を頼むと、claude -p で実行し、結果をボイスチャンネルのチャットに投稿する
import { PassThrough } from "node:stream";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
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
import { loadAgentId } from "./agent.js";
import { monoToStereo, toMono16k } from "./audio.js";
import { loadConfig } from "./config.js";
import { Conversation } from "./elevenlabs.js";
import { JobRunner, git, headline, stateLabel } from "./jobs.js";
import { discordToken, elevenLabsKey } from "./secrets.js";

const TICK_MS = 100; // ElevenLabs へ音声を送る間隔
const SILENCE_16K = Buffer.alloc((16000 * 2 * TICK_MS) / 1000); // 黙っている間は無音を送り続ける
const IDLE_MS = 60_000; // この間やり取りがなければ会話を切る（会話時間で課金されるため）
const RETRY_MS = 10_000; // 会話の開始に失敗したら、しばらく開始し直さない
const DEBUG = process.env.VOICE_DEBUG === "1";

const apiKey = elevenLabsKey();
const agentId = loadAgentId();
if (!agentId) {
  console.error("ElevenLabs agent not found. Create it first: npm run agent");
  process.exit(1);
}

const runner = new JobRunner(loadConfig());
const repoNames = Object.keys(runner.repos);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
// エージェントの音声が届くのが遅れても再生を止めないよう、1秒までは無音でつなぐ
const player = createAudioPlayer({ behaviors: { maxMissedFrames: 50 } });
const decoder = new OpusScript(48000, 2, OpusScript.Application.AUDIO);

let ownerId;
let connection = null;
let voiceChannel = null; // ジョブの結果を投稿する先（ボイスチャンネルのチャット）
let conversation = null;
let ticker = null;
let input = []; // 次の tick で送る 16kHz モノラル PCM
let speech = null; // 再生中のエージェントの音声
let lastActivity = 0;
let retryAfter = 0;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

player.on("error", (err) => log("player error:", err.message));
player.on(AudioPlayerStatus.Idle, () => {
  speech?.destroy();
  speech = null;
});

async function resolveOwnerId() {
  if (process.env.DISCORD_OWNER_ID) return process.env.DISCORD_OWNER_ID;
  const app = await client.application.fetch();
  // チームで所有するアプリの場合は owner がチームになるので、環境変数で指定してもらう
  if (!app.owner?.username) {
    console.error("The application is owned by a team. Set DISCORD_OWNER_ID to your user ID.");
    process.exit(1);
  }
  return app.owner.id;
}

// --- ElevenLabs との会話 ---

function startConversation() {
  if (Date.now() < retryAfter) return;
  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "full", timeStyle: "short" });
  const dynamicVariables = { now, repos: repoNames.join("、") || "なし" };
  const conv = new Conversation({ apiKey, agentId, dynamicVariables });
  conversation = conv;
  conv.on("ready", (id) => log(`conversation started (${id})`));
  conv.on("user_transcript", (text) => log("you:", text));
  conv.on("agent_response", (text) => log("agent:", text));
  conv.on("audio", playAgentAudio);
  conv.on("interruption", stopAgentAudio);
  conv.on("tool_call", (call) => handleToolCall(conv, call));
  conv.on("close", (reason) => {
    log(`conversation ended: ${reason}`);
    if (conversation === conv) conversation = null;
  });
  conv.start().catch((err) => {
    log("failed to start conversation:", err.message);
    retryAfter = Date.now() + RETRY_MS;
    conv.close("start failed");
  });
}

function endConversation(reason) {
  conversation?.close(reason);
  conversation = null;
  stopAgentAudio();
}

function tick() {
  if (!conversation) {
    input = [];
    return;
  }
  conversation.sendAudio(input.length ? Buffer.concat(input) : SILENCE_16K);
  input = [];
  if (Date.now() - lastActivity > IDLE_MS) endConversation("idle");
}

// --- Claude Code のジョブ ---

async function handleToolCall(conv, { tool_name, tool_call_id, parameters }) {
  log(`tool call: ${tool_name} ${JSON.stringify(parameters)}`);
  lastActivity = Date.now();
  let result;
  let isError = false;
  try {
    if (tool_name === "run_claude_code") {
      const job = await runner.start(parameters.repo, parameters.task, { channel: voiceChannel });
      result = `ジョブ${job.id}を開始しました。`;
      await post(job, `🛠️ ジョブ${job.id}（${job.repo}）を開始しました\n> ${quote(job.task)}`);
    } else if (tool_name === "get_job_status") {
      result = runner.describe();
    } else if (tool_name === "cancel_job") {
      result = runner.cancel();
    } else {
      throw new Error(`unknown tool: ${tool_name}`);
    }
  } catch (err) {
    result = err.message;
    isError = true;
  }
  log(`tool result: ${result}`);
  conv.sendToolResult(tool_call_id, result, isError);
}

runner.on("done", async (job) => {
  const minutes = Math.round((job.finishedAt - job.startedAt) / 60_000);
  log(`job ${job.id} ${job.state} in ${minutes}min`);
  const lines = [
    `<@${ownerId}> ジョブ${job.id}（${job.repo}）が${stateLabel(job.state)}（${minutes}分）`,
    `> ${quote(job.task)}`,
    "",
    job.result?.slice(0, 1200) || "(報告なし)",
  ];
  if (job.commits) lines.push("", `**コミット**（${job.branch}、未プッシュ）`, codeBlock(`${job.commits}\n\n${job.diffStat}`));
  if (job.uncommitted) lines.push("", "**コミットされていない変更**", codeBlock(job.uncommitted));
  const button = new ButtonBuilder().setCustomId(`push:${job.id}`).setLabel("プッシュする").setStyle(ButtonStyle.Primary);
  const components = job.commits ? [new ActionRowBuilder().addComponents(button)] : [];
  await post(job, lines.join("\n").slice(0, 2000), components);

  // 通話中なら、エージェントに声で伝えてもらう
  if (conversation?.ready) {
    lastActivity = Date.now();
    conversation.sendUserMessage(
      `[システム通知] ジョブ${job.id}（${job.repo}）が${stateLabel(job.state)}。報告の要点: ${headline(job.result ?? "")}` +
        (job.commits ? " コミットがあり、Discord のボタンでプッシュできる。" : ""),
    );
  }
});

async function post(job, content, components = []) {
  try {
    await job.meta.channel?.send({ content, components });
  } catch (err) {
    log("failed to post to Discord:", err.message);
  }
}

const quote = (text) => text.replace(/\n/g, "\n> ").slice(0, 500);
const codeBlock = (text) => "```\n" + text.slice(0, 600) + "\n```";

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton() || !interaction.customId.startsWith("push:")) return;
  if (interaction.user.id !== ownerId) {
    await interaction.reply({ content: "オーナーだけが操作できます。", flags: MessageFlags.Ephemeral });
    return;
  }
  const job = runner.get(Number(interaction.customId.slice("push:".length)));
  if (!job) {
    await interaction.reply({ content: "ジョブが見つかりません（ボットを再起動したため）。手元でプッシュしてください。" });
    return;
  }
  await interaction.deferReply();
  try {
    // ジョブの後にブランチが切り替わっていたら、別の変更を押し出さないよう止める
    const branch = await git(job.cwd, "rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== job.branch) throw new Error(`ブランチが ${job.branch} から ${branch} に変わっています。`);
    await git(job.cwd, "push", "origin", job.branch);
    await interaction.editReply(`ジョブ${job.id}のコミットを origin/${job.branch} にプッシュしました。`);
    await interaction.message.edit({ components: [] });
    log(`job ${job.id} pushed to origin/${job.branch}`);
  } catch (err) {
    await interaction.editReply(`プッシュできませんでした: ${err.message.slice(0, 1500)}`);
  }
});

// --- Discord の音声 ---

function onOwnerPacket(packet) {
  let pcm;
  try {
    pcm = decoder.decode(packet);
  } catch (err) {
    if (DEBUG) log("opus decode error:", err.message);
    return;
  }
  lastActivity = Date.now();
  if (!conversation) startConversation();
  input.push(toMono16k(pcm));
}

function playAgentAudio(pcm) {
  lastActivity = Date.now();
  if (!speech) {
    speech = new PassThrough();
    player.play(createAudioResource(speech, { inputType: StreamType.Raw }));
  }
  speech.write(monoToStereo(pcm));
}

function stopAgentAudio() {
  speech?.destroy();
  speech = null;
  player.stop(true);
}

async function join(channel) {
  voiceChannel = channel;
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
  log(`joined #${channel.name}`);
  conn.subscribe(player);
  conn.receiver
    .subscribe(ownerId, { end: { behavior: EndBehaviorType.Manual } })
    .on("data", onOwnerPacket)
    .on("error", (err) => log("receive error:", err.message));
  ticker = setInterval(tick, TICK_MS);
}

function leave() {
  endConversation("left the voice channel");
  clearInterval(ticker);
  ticker = null;
  input = [];
  if (!connection) return;
  connection.destroy();
  connection = null;
  log("left the voice channel");
}

client.once(Events.ClientReady, async () => {
  ownerId = await resolveOwnerId();
  log(`logged in as ${client.user.tag}; repos: ${repoNames.join(", ") || "(none)"}`);
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
  leave();
  client.destroy().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.login(discordToken());
