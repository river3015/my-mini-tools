// 同じ Bot のトークンで2つ動くと、両方がボイスチャンネルに入る。bot.js・local.js・echo.js のどれか1つだけを動かす
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.js";

const LOCK_FILE = join(CONFIG_DIR, "bot.pid");

export function lockBot(name) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(LOCK_FILE, `${process.pid} ${name}\n`, { flag: "wx" });
      process.on("exit", () => {
        if (holder()?.pid === process.pid) rmSync(LOCK_FILE, { force: true });
      });
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    const other = holder();
    if (other && alive(other.pid)) {
      console.error(
        `${other.name} (pid ${other.pid}) is already running with the same bot token. Stop it first.\n` +
          `If it is the LaunchAgent: voice-agent-discord/launchd/install.sh stop`,
      );
      // launchd から起動したときは、しばらくして起動し直す（手で動かしている方が止まれば入れ替わる）
      process.exit(1);
    }
    rmSync(LOCK_FILE, { force: true }); // 前に落ちたプロセスが残したもの
  }
  throw new Error(`could not create ${LOCK_FILE}`);
}

function holder() {
  try {
    const [pid, name] = readFileSync(LOCK_FILE, "utf8").trim().split(" ");
    return { pid: Number(pid), name };
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}
