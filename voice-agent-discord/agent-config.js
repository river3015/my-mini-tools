// ElevenLabs Agents のエージェント定義。`npm run agent` で作成・更新する
const PROMPT = `あなたは、Discord の音声通話で話すアシスタントです。
- 日本語の話し言葉で、1〜2文に短く答える。
- 箇条書き、記号、URL、コードは読み上げに向かないので使わない。
- わからないことは推測で答えず、わからないと言う。`;

export const agentConfig = {
  name: "voice-agent-discord",
  conversation_config: {
    agent: {
      language: "ja",
      // 会話はこちらが話し始めたときに開始するので、エージェントからは話しかけない
      first_message: "",
      prompt: { prompt: PROMPT, llm: "claude-haiku-4-5" },
    },
    asr: { user_input_audio_format: "pcm_16000" },
    // 日本語には v2.5 以降のモデルが要る。声は tts.voice_id で変えられる（未指定なら既定の声）
    tts: { model_id: "eleven_flash_v2_5", agent_output_audio_format: "pcm_48000" },
  },
  // 署名付き URL なしでは接続できないようにする
  platform_settings: { auth: { enable_auth: true } },
};
