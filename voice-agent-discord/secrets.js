import { execFileSync } from "node:child_process";

// 環境変数を優先し、なければキーチェーンから読む
export function readSecret(service, envName) {
  if (process.env[envName]) return process.env[envName];
  try {
    return execFileSync("security", ["find-generic-password", "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    console.error(
      `${envName} not found. Store it in the Keychain:\n` +
        `  security add-generic-password -s ${service} -a "$USER" -w`,
    );
    process.exit(1);
  }
}

export const discordToken = () => readSecret("voice-agent-discord-token", "DISCORD_TOKEN");
// voice-input の ELEVENLABS_API_KEY（STT 専用）と取り違えないよう、別の名前にしている
export const elevenLabsKey = () => readSecret("voice-agent-elevenlabs", "ELEVENLABS_AGENT_API_KEY");
// voice-input と同じキーを使う（STT だけの用途なので共有する）
export const groqKey = () => readSecret("voice-input-groq", "GROQ_API_KEY");
