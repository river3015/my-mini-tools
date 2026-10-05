// bot.js（ElevenLabs 版）と local.js（ローカル版）で共通の Discord まわりの処理
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from "discord.js";
import { git, stateLabel } from "./jobs.js";

export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

export async function resolveOwnerId(client) {
  if (process.env.DISCORD_OWNER_ID) return process.env.DISCORD_OWNER_ID;
  const app = await client.application.fetch();
  // チームで所有するアプリの場合は owner がチームになるので、環境変数で指定してもらう
  if (!app.owner?.username) {
    console.error("The application is owned by a team. Set DISCORD_OWNER_ID to your user ID.");
    process.exit(1);
  }
  return app.owner.id;
}

export async function post(channel, content, components = []) {
  try {
    return await channel?.send({ content, components });
  } catch (err) {
    log("failed to post to Discord:", err.message);
  }
}

export const quote = (text) => text.replace(/\n/g, "\n> ").slice(0, 500);
export const codeBlock = (text) => "```\n" + text.slice(0, 600) + "\n```";

export function pushButton(job) {
  const button = new ButtonBuilder().setCustomId(`push:${job.id}`).setLabel("プッシュする").setStyle(ButtonStyle.Primary);
  return new ActionRowBuilder().addComponents(button);
}

// ジョブの結果の投稿。コミットがあればプッシュボタンを付ける
export function jobResultMessage(job, ownerId) {
  const minutes = Math.round((job.finishedAt - job.startedAt) / 60_000);
  const lines = [
    `<@${ownerId}> ジョブ${job.id}（${job.repo}）が${stateLabel(job.state)}（${minutes}分）`,
    `> ${quote(job.task)}`,
    "",
    job.result?.slice(0, 1200) || "(報告なし)",
  ];
  if (job.commits) lines.push("", `**コミット**（${job.branch}、未プッシュ）`, codeBlock(`${job.commits}\n\n${job.diffStat}`));
  if (job.uncommitted) lines.push("", "**コミットされていない変更**", codeBlock(job.uncommitted));
  return { content: lines.join("\n").slice(0, 2000), components: job.commits ? [pushButton(job)] : [] };
}

// 「プッシュする」ボタン。押せるのはオーナーだけ
export async function handlePushButton(interaction, { ownerId, runner }) {
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
  if (job.pushed) {
    await interaction.reply({ content: `ジョブ${job.id}のコミットはプッシュ済みです。`, flags: MessageFlags.Ephemeral });
    return;
  }
  await interaction.deferReply();
  try {
    // ジョブの後にブランチが切り替わっていたら、別の変更を押し出さないよう止める
    const branch = await git(job.cwd, "rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== job.branch) throw new Error(`ブランチが ${job.branch} から ${branch} に変わっています。`);
    await git(job.cwd, "push", "origin", job.branch);
    job.pushed = true;
    await interaction.editReply(`ジョブ${job.id}のコミットを origin/${job.branch} にプッシュしました。`);
    // まとめの投稿にはボタンが複数あるので、押したものだけを消す
    const rows = interaction.message.components
      .map((row) => ActionRowBuilder.from(row))
      .map((row) => row.setComponents(row.components.filter((c) => c.data.custom_id !== interaction.customId)))
      .filter((row) => row.components.length);
    await interaction.message.edit({ components: rows });
    log(`job ${job.id} pushed to origin/${job.branch}`);
  } catch (err) {
    await interaction.editReply(`プッシュできませんでした: ${err.message.slice(0, 1500)}`);
  }
}
