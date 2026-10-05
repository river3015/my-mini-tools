// ElevenLabs Agents のエージェントとツールの定義。`npm run agent` で作成・更新する
// {{now}} と {{repos}} は、会話の開始時に bot.js が渡す
const PROMPT = `あなたは、Discord の音声通話で話すアシスタントです。現在時刻は {{now}}。
- 日本語の話し言葉で、1〜2文に短く答える。
- 箇条書き、記号、URL、コードは読み上げに向かないので使わない。
- わからないことは推測で答えず、わからないと言う。

# Claude Code への依頼
- リポジトリの調査やコードの変更を頼まれたら、run_claude_code ツールで Claude Code に依頼する。使えるリポジトリは {{repos}}。
- task には、ユーザーの言葉を補って、Claude Code が会話の文脈なしで作業できる具体的な指示を書く。対象や完了条件があいまいなら、依頼する前にユーザーに確かめる。
- 依頼したら、終わったら知らせると短く伝える。進み具合は get_job_status、取り消しは cancel_job で扱う。
- 「[システム通知]」で始まるメッセージはユーザーの発言ではなく、ジョブの完了通知。結果を1〜2文で伝え、詳しくは Discord に投稿したと添える。
- 変更のプッシュはあなたにはできない。ユーザーが Discord のボタンで承認したときだけ行われる。`;

export const tools = [
  {
    type: "client",
    name: "run_claude_code",
    description:
      "Claude Code に、リポジトリの調査やコードの変更を依頼する。依頼はバックグラウンドで実行され、すぐにジョブ番号が返る。結果は後で通知される。",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "作業するリポジトリの名前" },
        task: { type: "string", description: "Claude Code への具体的な指示（日本語）" },
      },
      required: ["repo", "task"],
    },
    expects_response: true,
    response_timeout_secs: 10,
  },
  {
    type: "client",
    name: "get_job_status",
    description: "Claude Code のジョブが実行中か、直近のジョブの結果を調べる。",
    parameters: { type: "object", properties: {}, required: [] },
    expects_response: true,
    response_timeout_secs: 5,
  },
  {
    type: "client",
    name: "cancel_job",
    description: "実行中の Claude Code のジョブを取り消す。ユーザーが取り消しを頼んだときだけ使う。",
    parameters: { type: "object", properties: {}, required: [] },
    expects_response: true,
    response_timeout_secs: 5,
  },
];

export const agentConfig = {
  name: "voice-agent-discord",
  conversation_config: {
    agent: {
      language: "ja",
      // 会話はこちらが話し始めたときに開始するので、エージェントからは話しかけない
      first_message: "",
      prompt: { prompt: PROMPT, llm: "claude-haiku-4-5" },
      dynamic_variables: { dynamic_variable_placeholders: { now: "不明", repos: "なし" } },
    },
    asr: { user_input_audio_format: "pcm_16000" },
    // 日本語には v2.5 以降のモデルが要る。声は tts.voice_id で変えられる（未指定なら既定の声）
    tts: { model_id: "eleven_flash_v2_5", agent_output_audio_format: "pcm_48000" },
    // 既定の turn_v3 は Discord で録った声だと返事まで約3秒待った。turn_v2 では約1秒になった（2026-10-06）
    turn: { turn_model: "turn_v2", turn_eagerness: "eager", speculative_turn: true },
  },
  // 署名付き URL なしでは接続できないようにする
  platform_settings: { auth: { enable_auth: true } },
};
