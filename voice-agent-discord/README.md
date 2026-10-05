# voice-agent-discord

Discord のボイスチャンネルを電話代わりにして、AI エージェント（ElevenLabs Agents ＋ Claude Code）と音声で話すための Bot。

電話網（Twilio など）を使わないので、番号の取得や通話料が要らない。Discord は 2026-03-01 から通話の E2EE（DAVE）を必須にしたため、DAVE に対応した `@discordjs/voice` 0.19.2 以上を使う。

## 状態

1. ✅ エコー Bot（`echo.js`）: DAVE 必須の環境で音声を受信できるかの確認（2026-10-06、DAVE protocol v1 で受信・再生できた）
2. 🚧 ElevenLabs Agents との会話（`bot.js`）
3. 💡 Claude Code の呼び出し、完了通知、承認ボタン

## 必要なもの

- Node.js 22 以上（26 で確認）
- Discord のアプリと Bot。Privileged Gateway Intents は不要。
  - 招待時の scope は `bot`、権限は `Connect`・`Speak`・`Send Messages`。
- ElevenLabs の API キー。権限は ElevenLabs Agents の Write。voice-input の STT 専用キーとは分ける。

## セットアップ

```sh
# トークン・API キーをキーチェーンに保存する（プロンプトで入力）
security add-generic-password -s voice-agent-discord-token -a "$USER" -w
security add-generic-password -s voice-agent-elevenlabs -a "$USER" -w

npm install
```

環境変数 `DISCORD_TOKEN`・`ELEVENLABS_AGENT_API_KEY` からも読む。環境変数がある場合はそちらを優先する。
voice-input が使う `ELEVENLABS_API_KEY` は読まない。

## エージェントとの会話

```sh
npm run agent   # agent-config.js の内容でエージェントを作成・更新する
npm start       # VOICE_DEBUG=1 で音声接続のデバッグログを出す
```

- エージェントの ID は `~/.config/voice-agent-discord/agent.json` に保存する（環境変数 `ELEVENLABS_AGENT_ID` でも指定できる）。
- エージェントは署名付き URL でしか接続できない設定（`enable_auth`）にしている。
- オーナーがボイスチャンネルに入ると Bot も入り、話し始めた時点で ElevenLabs との会話を始める。
- 会話時間で課金されるため、60 秒間どちらも話さなければ会話を切る。次に話すとまた始める。
- 音声の流れ: Discord の Opus（48kHz ステレオ）をデコードして 16kHz モノラルにし、100ms ごとに送る。黙っている間は無音を送る。エージェントの音声は 48kHz モノラルで受け取り、ステレオにして再生する。
- 話している途中にこちらが話すと、ElevenLabs が割り込みを検知して再生を止める。
- 会話の文字起こしとエージェントの返答をログに出す。
- Opus のデコードは `opusscript`（純 JS）で行う。npm 11 はネイティブモジュールのビルドを既定で止めるため、`@discordjs/opus` は使わない。

## エコー Bot

```sh
npm run echo        # VOICE_DEBUG=1 で音声接続のデバッグログを出す
```

- アプリのオーナーがボイスチャンネルに入ると、Bot も同じチャンネルに入る。オーナーが抜けると Bot も抜ける。
- オーナーの音声だけを受け取り、0.8 秒黙ったところで区切って、そのまま再生し返す。0.3 秒未満は捨てる。
- 受信したパケット数と DAVE のプロトコルバージョンをログに出す。
- オーナーはアプリの所有者から自動で決める。チーム所有のアプリでは `DISCORD_OWNER_ID` に自分のユーザー ID を指定する。
