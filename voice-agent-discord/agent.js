// agent-config.js の内容で ElevenLabs のツールとエージェントを作成し、2回目以降は更新する
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentConfig, tools } from "./agent-config.js";
import { CONFIG_DIR } from "./config.js";
import { elevenLabsKey } from "./secrets.js";

const API = "https://api.elevenlabs.io/v1/convai";
const STATE_FILE = join(CONFIG_DIR, "agent.json");

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

export function loadAgentId() {
  return process.env.ELEVENLABS_AGENT_ID ?? loadState().agent_id;
}

async function request(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "xi-api-key": elevenLabsKey(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const state = loadState();
  state.tool_ids ??= {};

  for (const tool of tools) {
    const id = state.tool_ids[tool.name];
    if (id) {
      await request("PATCH", `/tools/${id}`, { tool_config: tool });
      console.log(`updated tool ${tool.name}`);
    } else {
      state.tool_ids[tool.name] = (await request("POST", "/tools", { tool_config: tool })).id;
      saveState(state);
      console.log(`created tool ${tool.name}`);
    }
  }

  const config = structuredClone(agentConfig);
  config.conversation_config.agent.prompt.tool_ids = tools.map((t) => state.tool_ids[t.name]);
  if (state.agent_id) {
    await request("PATCH", `/agents/${state.agent_id}`, config);
    console.log(`updated agent ${state.agent_id}`);
  } else {
    state.agent_id = (await request("POST", "/agents/create", config)).agent_id;
    saveState(state);
    console.log(`created agent ${state.agent_id} (saved to ${STATE_FILE})`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
