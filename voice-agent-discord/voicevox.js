// VOICEVOX エンジンで読み上げ音声を作る。エンジンが動いていなければ起動し、ボットの終了時に止める
import { spawn } from "node:child_process";

const ENGINE = "/Applications/VOICEVOX.app/Contents/Resources/vv-engine/run";
const BASE = "http://127.0.0.1:50021";

export class Voicevox {
  constructor({ speaker = 3, speedScale = 1.15 } = {}) {
    this.speaker = speaker;
    this.speedScale = speedScale;
    this.proc = null; // 自分で起動したエンジン
  }

  async start(log) {
    if (await this.#alive()) return;
    log("starting the VOICEVOX engine");
    this.proc = spawn(ENGINE, ["--host", "127.0.0.1", "--port", "50021"], { stdio: "ignore" });
    this.proc.on("exit", (code) => {
      log(`VOICEVOX engine exited (${code})`);
      this.proc = null;
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      if (await this.#alive()) {
        await this.synthesize("あ"); // 初回の合成はモデルの読み込みで遅いので、先に済ませる
        return;
      }
    }
    throw new Error("VOICEVOX engine did not start within 60s");
  }

  stop() {
    this.proc?.kill("SIGTERM");
  }

  // Discord でそのまま流せる 48kHz ステレオの 16bit PCM を返す
  async synthesize(text) {
    const query = await this.#post(`/audio_query?speaker=${this.speaker}&text=${encodeURIComponent(text)}`);
    const q = await query.json();
    Object.assign(q, { speedScale: this.speedScale, outputSamplingRate: 48000, outputStereo: true });
    const wav = Buffer.from(await (await this.#post(`/synthesis?speaker=${this.speaker}`, q)).arrayBuffer());
    return pcmFromWav(wav);
  }

  async #alive() {
    try {
      return (await fetch(`${BASE}/version`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  }

  async #post(path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`VOICEVOX ${path.split("?")[0]}: HTTP ${res.status}`);
    return res;
  }
}

// WAV の data チャンクを取り出す
function pcmFromWav(wav) {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in WAV");
}
