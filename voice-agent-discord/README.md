# voice-agent-discord

Discord のボイスチャンネルを電話代わりにして、AI エージェント（ElevenLabs Agents ＋ Claude Code）と音声で話すための Bot。

電話網（Twilio など）を使わないので、番号の取得や通話料が要らない。Discord は 2026-03-01 から通話の E2EE（DAVE）を必須にしたため、DAVE に対応した `@discordjs/voice` 0.19.2 以上を使う。

## 状態

1. ✅ エコー Bot（`echo.js`）: DAVE 必須の環境で音声を受信できるかの確認（2026-10-06、DAVE protocol v1 で受信・再生できた）
2. 💡 ElevenLabs Agents との会話
3. 💡 Claude Code の呼び出し、完了通知、承認ボタン

## 必要なもの

- Node.js 22 以上（26 で確認）
- Discord のアプリと Bot。Privileged Gateway Intents は不要。
  - 招待時の scope は `bot`、権限は `Connect`・`Speak`・`Send Messages`。
- （手順2以降）ElevenLabs の API キー。権限は ElevenLabs Agents の Write。

## セットアップ

```sh
# トークン・API キーをキーチェーンに保存する（プロンプトで入力）
security add-generic-password -s voice-agent-discord-token -a "$USER" -w
security add-generic-password -s voice-agent-elevenlabs -a "$USER" -w

npm install
```

トークンは環境変数 `DISCORD_TOKEN` からも読む。環境変数がある場合はそちらを優先する。

## エコー Bot

```sh
npm run echo        # VOICE_DEBUG=1 で音声接続のデバッグログを出す
```

- アプリのオーナーがボイスチャンネルに入ると、Bot も同じチャンネルに入る。オーナーが抜けると Bot も抜ける。
- オーナーの音声だけを受け取り、0.8 秒黙ったところで区切って、そのまま再生し返す。0.3 秒未満は捨てる。
- 受信したパケット数と DAVE のプロトコルバージョンをログに出す。
- オーナーはアプリの所有者から自動で決める。チーム所有のアプリでは `DISCORD_OWNER_ID` に自分のユーザー ID を指定する。
