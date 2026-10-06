// Groq の Whisper で発話を文字にする。用語は prompt で寄せる（keyterms のような仕組みはない）。
// 物音だけの音声でも「ご視聴ありがとうございました」のような文を返すので、物音かどうかは呼び出し側で SpeechTranscriber に判定させる
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { wavHeader } from "./stt.js";

const URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const PROMPT_CHARS = 200; // prompt は 224 トークンまで
const VOICE_INPUT_CONFIG = join(homedir(), ".config", "voice-input", "config.toml");
// 音声がほとんどないときに Whisper がよく返す文
const HALLUCINATIONS = ["ご視聴ありがとうございました", "チャンネル登録", "お疲れ様でした"];

export class GroqTranscriber {
  constructor({ apiKey, model = "whisper-large-v3", vocabulary = [] }) {
    this.apiKey = apiKey;
    this.model = model;
    this.prompt = [...new Set(vocabulary)].join(", ").slice(0, PROMPT_CHARS);
    this.pausedUntil = 0; // レート制限に当たったら、しばらく使わない
  }

  // 使えないとき（レート制限で止めている間、通信の失敗）は例外を投げる
  async transcribe(pcm16k) {
    if (Date.now() < this.pausedUntil) throw new Error("rate limited");
    const form = new FormData();
    form.append("model", this.model);
    form.append("language", "ja");
    form.append("temperature", "0");
    if (this.prompt) form.append("prompt", this.prompt);
    form.append("file", new Blob([wavHeader(pcm16k.length, 16000), pcm16k], { type: "audio/wav" }), "utterance.wav");
    const res = await fetch(URL, {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      this.pausedUntil = Date.now() + Number(res.headers.get("retry-after") ?? 60) * 1000;
      throw new Error("rate limited (429)");
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).text.trim();
  }
}

export const isHallucination = (text) => HALLUCINATIONS.some((h) => text.includes(h));

// voice-input（音声入力ツール）の keyterms。/voice-vocab で育てた語彙をそのまま使う
export function voiceInputKeyterms() {
  if (!existsSync(VOICE_INPUT_CONFIG)) return [];
  const m = readFileSync(VOICE_INPUT_CONFIG, "utf8").match(/^keyterms\s*=\s*\[([\s\S]*?)\]/m);
  return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) : [];
}
