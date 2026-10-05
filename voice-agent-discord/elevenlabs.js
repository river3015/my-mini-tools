// ElevenLabs Agents との1回分の会話（WebSocket）
// https://elevenlabs.io/docs/agents-platform/api-reference/agents-platform/websocket
import { EventEmitter } from "node:events";

const SIGNED_URL_API = "https://api.elevenlabs.io/v1/convai/conversation/get-signed-url";
const MAX_QUEUED_CHUNKS = 100; // 接続待ちの間に貯める音声（100ms × 100 = 10秒）

// emit するイベント: ready / audio(Buffer) / interruption / user_transcript(text) / agent_response(text) / close(reason)
export class Conversation extends EventEmitter {
  constructor({ apiKey, agentId }) {
    super();
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.queue = [];
  }

  async start() {
    const res = await fetch(`${SIGNED_URL_API}?agent_id=${encodeURIComponent(this.agentId)}`, {
      headers: { "xi-api-key": this.apiKey },
    });
    if (!res.ok) throw new Error(`get-signed-url: HTTP ${res.status} ${await res.text()}`);
    const { signed_url } = await res.json();
    if (this.closed) return;

    this.ws = new WebSocket(signed_url);
    this.ws.addEventListener("open", () => {
      this.ws.send(JSON.stringify({ type: "conversation_initiation_client_data" }));
    });
    this.ws.addEventListener("message", (event) => this.#onMessage(JSON.parse(event.data)));
    this.ws.addEventListener("error", () => this.close("websocket error"));
    this.ws.addEventListener("close", (event) => this.close(`closed by server (${event.code} ${event.reason})`));
  }

  // 16kHz モノラル PCM。接続が整うまでは貯めておく
  sendAudio(pcm) {
    if (this.closed) return;
    if (!this.ready) {
      this.queue.push(pcm);
      if (this.queue.length > MAX_QUEUED_CHUNKS) this.queue.shift();
      return;
    }
    this.ws.send(JSON.stringify({ user_audio_chunk: pcm.toString("base64") }));
  }

  close(reason = "closed by client") {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    this.queue = [];
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
    this.emit("close", reason);
  }

  #onMessage(msg) {
    switch (msg.type) {
      case "conversation_initiation_metadata": {
        const meta = msg.conversation_initiation_metadata_event;
        if (meta.user_input_audio_format !== "pcm_16000" || meta.agent_output_audio_format !== "pcm_48000") {
          this.close(
            `unexpected audio format (in: ${meta.user_input_audio_format}, out: ${meta.agent_output_audio_format}); run npm run agent`,
          );
          return;
        }
        this.ready = true;
        this.emit("ready", meta.conversation_id);
        for (const pcm of this.queue.splice(0)) this.sendAudio(pcm);
        break;
      }
      case "audio":
        this.emit("audio", Buffer.from(msg.audio_event.audio_base_64, "base64"));
        break;
      case "interruption":
        this.emit("interruption");
        break;
      case "user_transcript":
        this.emit("user_transcript", msg.user_transcription_event.user_transcript);
        break;
      case "agent_response":
        this.emit("agent_response", msg.agent_response_event.agent_response);
        break;
      case "ping":
        this.ws.send(JSON.stringify({ type: "pong", event_id: msg.ping_event.event_id }));
        break;
      case "client_error":
        this.close(`client error: ${msg.error_event.message}`);
        break;
    }
  }
}
