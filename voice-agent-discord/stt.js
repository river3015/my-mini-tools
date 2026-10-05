// stt/stt（Swift の補助プログラム）を常駐させ、16kHz モノラルの PCM を文字にする。
// 実行ファイルがないか main.swift より古ければ、起動時に swiftc でビルドする
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const DIR = join(import.meta.dirname, "stt");
const SOURCE = join(DIR, "main.swift");
const BINARY = join(DIR, "stt");

export class Transcriber {
  constructor() {
    this.proc = null;
    this.pending = []; // 返事を待っている resolve/reject（送った順に返ってくる）
    this.workDir = mkdtempSync(join(tmpdir(), "voice-agent-stt-"));
    this.seq = 0;
  }

  async start(log) {
    if (!existsSync(BINARY) || statSync(BINARY).mtimeMs < statSync(SOURCE).mtimeMs) {
      log("building stt/stt");
      execFileSync("swiftc", ["-O", SOURCE, "-o", BINARY], { stdio: "inherit" });
    }
    this.proc = spawn(BINARY, [], { stdio: ["pipe", "pipe", "inherit"] });
    let ready;
    const readyP = new Promise((resolve, reject) => {
      ready = { resolve, reject };
      this.proc.once("exit", (code) => reject(new Error(`stt exited (${code})`)));
    });
    createInterface({ input: this.proc.stdout }).on("line", (line) => {
      const msg = JSON.parse(line);
      if (msg.ready) return ready.resolve();
      const waiter = this.pending.shift();
      if (msg.error) waiter?.reject(new Error(msg.error));
      else waiter?.resolve(msg.text.trim());
    });
    this.proc.on("exit", (code) => {
      for (const w of this.pending.splice(0)) w.reject(new Error(`stt exited (${code})`));
      this.proc = null;
    });
    await readyP;
  }

  async transcribe(pcm16k) {
    if (!this.proc) throw new Error("stt is not running");
    const path = join(this.workDir, `${this.seq++ % 4}.wav`);
    writeFileSync(path, wavHeader(pcm16k.length, 16000));
    writeFileSync(path, pcm16k, { flag: "a" });
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.proc.stdin.write(path + "\n");
    });
  }

  stop() {
    this.proc?.stdin.end();
    rmSync(this.workDir, { recursive: true, force: true });
  }
}

function wavHeader(dataBytes, rate) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // モノラル
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}
