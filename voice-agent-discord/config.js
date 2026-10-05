// ~/.config/voice-agent-discord/config.json を読む。Claude Code に作業させてよいリポジトリを決める
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".config", "voice-agent-discord");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const expand = (path) => (path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { repos: {}, jobTimeoutMinutes: 15 };
  const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  const repos = {};
  for (const [name, path] of Object.entries(raw.repos ?? {})) {
    const dir = expand(path);
    if (!existsSync(join(dir, ".git"))) throw new Error(`${CONFIG_FILE}: ${name} (${dir}) is not a git repository`);
    repos[name] = dir;
  }
  return { repos, jobTimeoutMinutes: raw.jobTimeoutMinutes ?? 15 };
}
