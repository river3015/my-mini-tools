// agent-config.js の内容で ElevenLabs のエージェントを作成し、2回目以降は更新する
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentConfig } from "./agent-config.js";
import { elevenLabsKey } from "./secrets.js";

const API = "https://api.elevenlabs.io/v1/convai/agents";
const STATE_DIR = join(homedir(), ".config", "voice-agent-discord");
const STATE_FILE = join(STATE_DIR, "agent.json");

export function loadAgentId() {
  if (process.env.ELEVENLABS_AGENT_ID) return process.env.ELEVENLABS_AGENT_ID;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")).agent_id;
  } catch {
    return undefined;
  }
}

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { "xi-api-key": elevenLabsKey(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${url}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const agentId = loadAgentId();
  if (agentId) {
    await request("PATCH", `${API}/${agentId}`, agentConfig);
    console.log(`updated agent ${agentId}`);
    return;
  }
  const { agent_id } = await request("POST", `${API}/create`, agentConfig);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ agent_id }, null, 2) + "\n", { mode: 0o600 });
  console.log(`created agent ${agent_id} (saved to ${STATE_FILE})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
