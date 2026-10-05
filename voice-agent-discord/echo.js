// 手順1: DAVE（E2EE）必須の Discord で Bot が音声を受信できるかを確かめるエコー Bot。
// オーナーがボイスチャンネルに入ると同じチャンネルに入り、話した内容を区切りごとにそのまま返す。
import { execFileSync } from "node:child_process";
import { Readable } from "node:stream";
import { Client, Events, GatewayIntentBits } from "discord.js";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from "@discordjs/voice";

const KEYCHAIN_SERVICE = "voice-agent-discord-token";
const SILENCE_MS = 800; // この長さ黙ったら一区切りとみなす
const MIN_PACKETS = 15; // 20ms/パケット。0.3秒未満は捨てる
const DEBUG = process.env.VOICE_DEBUG === "1";

function loadToken() {
  if (process.env.DISCORD_TOKEN) return process.env.DISCORD_TOKEN;
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    console.error(
      "Discord bot token not found. Store it in the Keychain:\n" +
        `  security add-generic-password -s ${KEYCHAIN_SERVICE} -a "$USER" -w`,
    );
    process.exit(1);
  }
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const player = createAudioPlayer();
let ownerId;
let recording = false;

player.on("error", (err) => log("player error:", err.message));

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

function daveStatus(connection) {
  const dave = connection.state.networking?.state?.dave;
  return dave ? `DAVE protocol v${dave.protocolVersion}` : "DAVE not active";
}

async function join(channel) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    debug: DEBUG,
  });
  if (DEBUG) connection.on("debug", (m) => log("[voice]", m));
  connection.on("error", (err) => log("connection error:", err.message));
  connection.on("stateChange", (from, to) => log(`connection: ${from.status} -> ${to.status}`));

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    log("failed to connect within 20s");
    connection.destroy();
    return;
  }
  log(`joined #${channel.name} (${daveStatus(connection)})`);
  connection.subscribe(player);
  connection.receiver.speaking.on("start", (userId) => {
    if (userId === ownerId) record(connection);
  });
}

function record(connection) {
  if (recording || player.state.status !== AudioPlayerStatus.Idle) return;
  recording = true;
  const packets = [];
  const stream = connection.receiver.subscribe(ownerId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
  });
  stream.on("data", (packet) => packets.push(packet));
  stream.on("error", (err) => log("receive error:", err.message));
  stream.on("close", () => {
    recording = false;
    const seconds = (packets.length * 0.02).toFixed(1);
    if (packets.length < MIN_PACKETS) {
      log(`received ${packets.length} packets (${seconds}s), too short, skipped`);
      return;
    }
    log(`received ${packets.length} packets (${seconds}s), playing back (${daveStatus(connection)})`);
    // 受け取った Opus パケットをデコードせずにそのまま送り返す
    player.play(createAudioResource(Readable.from(packets), { inputType: StreamType.Opus }));
  });
}

function leave(guildId) {
  const connection = getVoiceConnection(guildId);
  if (!connection) return;
  connection.destroy();
  log("left the voice channel");
}

client.once(Events.ClientReady, async () => {
  ownerId = await resolveOwnerId();
  log(`logged in as ${client.user.tag}; waiting for the owner to join a voice channel`);
  for (const guild of client.guilds.cache.values()) {
    const state = guild.voiceStates.cache.get(ownerId);
    if (state?.channel) await join(state.channel);
  }
});

client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (newState.id !== ownerId || oldState.channelId === newState.channelId) return;
  if (oldState.channelId) leave(oldState.guild.id);
  if (newState.channel) await join(newState.channel);
});

function shutdown() {
  for (const guild of client.guilds.cache.values()) leave(guild.id);
  client.destroy().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.login(loadToken());
