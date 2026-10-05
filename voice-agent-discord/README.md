# voice-agent-discord

Discord のボイスチャンネルを電話代わりにして、AI エージェントと音声で話すための Bot。歩いている間に話しながら作業を進め、通話を抜けたらまとめと引き継ぎ文が残ることを目指している。

構成は2つあり、起動するコマンドで選ぶ。

| 構成 | コマンド | 音声認識 | 応答 | 読み上げ | 返事が始まるまで |
| --- | --- | --- | --- | --- | --- |
| ローカル版 | `npm run local` | macOS の SpeechTranscriber | `claude`（サブスクリプション） | VOICEVOX | 約 3〜4 秒 |
| ElevenLabs 版 | `npm start` | ElevenLabs Agents | ElevenLabs Agents（作業は Claude Code に依頼） | ElevenLabs Agents | 約 1 秒 |

電話網（Twilio など）を使わないので、番号の取得や通話料が要らない。Discord は 2026-03-01 から通話の E2EE（DAVE）を必須にしたため、DAVE に対応した `@discordjs/voice` 0.19.2 以上を使う。

## 状態

1. ✅ エコー Bot（`echo.js`）: DAVE 必須の環境で音声を受信できるかの確認（2026-10-06、DAVE protocol v1 で受信・再生できた）
2. ✅ ElevenLabs Agents との会話（`bot.js`）
3. ✅ Claude Code の呼び出し、完了通知、承認ボタン（ElevenLabs 版は実機で会話を確認。声で依頼を通しで試すのはまだ）
4. 🚧 ローカル版（`local.js`）: 部品を Discord なしでつないだ通し試験は済み。Discord での実機の会話はまだ
5. ⬜ LaunchAgent で常駐させる

## 必要なもの

- Node.js 22 以上（26 で確認）
- ローカル版: macOS 26 以上（SpeechTranscriber）、Xcode のコマンドラインツール（`swiftc`）、[VOICEVOX](https://voicevox.hiroshiba.jp/)（`/Applications/VOICEVOX.app`）
- Discord のアプリと Bot。Privileged Gateway Intents は不要。
  - 招待時の scope は `bot`、権限は `Connect`・`Speak`・`Send Messages`。
- ElevenLabs 版: ElevenLabs の API キー。権限は ElevenLabs Agents の Write。voice-input の STT 専用キーとは分ける。
- Claude Code（`claude` コマンド）

## セットアップ

```sh
# トークン・API キーをキーチェーンに保存する（プロンプトで入力）
security add-generic-password -s voice-agent-discord-token -a "$USER" -w
security add-generic-password -s voice-agent-elevenlabs -a "$USER" -w   # ElevenLabs 版だけ

npm install

# Claude Code に作業させてよいリポジトリと、ローカル版の設定
mkdir -p ~/.config/voice-agent-discord
cp config.example.json ~/.config/voice-agent-discord/config.json
```

環境変数 `DISCORD_TOKEN`・`ELEVENLABS_AGENT_API_KEY` からも読む。環境変数がある場合はそちらを優先する。
voice-input が使う `ELEVENLABS_API_KEY` は読まない。

## ローカル版

```sh
npm run local   # VOICE_DEBUG=1 で音声接続のデバッグログを出す
```

ElevenLabs を使わず、Claude のサブスクリプションと Mac 上の無料の仕組みだけで動かす。

| ファイル | 役割 |
| --- | --- |
| `local.js` | 本体。Discord の音声の送受信、話し終わりの判定、読み上げの順番と割り込み、まとめ |
| `local-prompts.js` | 常駐させる claude に渡すプロンプトと、許可するツール |
| `stt/main.swift`・`stt.js` | SpeechTranscriber（ja_JP）で発話を文字にする常駐プログラム。起動時に `swiftc` でビルドする（`stt/stt` はコミットしない） |
| `claude-session.js` | `claude -p` を stream-json の入出力で常駐させ、返事を文ごとに渡す |
| `voicevox.js` | VOICEVOX エンジンが動いていなければ起動し、48kHz ステレオで合成する。自分で起動したエンジンは終了時に止める |
| `mcp.js` | claude にジョブのツールを渡す、127.0.0.1 だけで待ち受ける MCP サーバー |

`config.json` の `local` で設定を変えられる。

| キー | 既定値 | 内容 |
| --- | --- | --- |
| `model` | `sonnet` | 応答に使うモデル |
| `speaker` | `3` | VOICEVOX の話者 ID（3 はずんだもん） |
| `speedScale` | `1.15` | 読み上げの速さ |
| `textChannelId` | なし | まとめやジョブの結果を投稿するテキストチャンネルの ID。なければボイスチャンネルのチャットに投稿する |

### 投稿先

- `textChannelId` を設定すると、通話ごとにそのチャンネルにスレッド（「2026-10-06 09:00 の通話」）を作り、その通話のジョブの開始・結果と最後のまとめをすべてスレッドに投稿する。スレッドは最初に投稿するときに作るので、何も頼まずに話しただけの通話ではまとめのときにだけ作る。
- Bot には、そのチャンネルでの「チャンネルを見る」「公開スレッドの作成」「スレッドでメッセージを送信」の権限が要る。スレッドを作れなかったときは、ボイスチャンネルのチャットに投稿する。
- 専用のサーバーでは、ツールごとにチャンネルを作り、名前をリポジトリのディレクトリ名に合わせる（例: カテゴリ「VOICE AGENT」に、ボイスチャンネル `voice-agent` とテキストチャンネル `#voice-agent`）。

### 会話の流れ

- オーナーがボイスチャンネルに入ると Bot も入り、その通話用に `claude` を1つ起動する。リポジトリの状態（未プッシュのコミット、未コミットの変更）と前回の通話のまとめを渡して、あいさつと話題の候補を話してもらう。
- 発話の区切り: Discord はオーナーが話している間だけ音声を送ってくるので、0.7 秒途切れたら話し終わりとみなす。0.3 秒未満の発話（相づちや物音）は捨てる。
- 文字にできたら短い効果音（2音）を鳴らしてから claude に送る。
- ツール（検索、読み取り、ジョブの依頼）を使う前に、「調べますね。」のような一言を先に言わせる。ツールの結果を待つ間、黙ったままにならない。
- claude の返事は文ができた順に VOICEVOX で合成し、前の文の再生中に次を合成する。記号、コード、URL は読み上げ前に落とす。
- 割り込み: 読み上げ中や返事を作っている途中にオーナーが 0.3 秒以上話すと、読み上げを止め、claude にも中断を送る（stream-json の `control_request` の `interrupt`）。
- ジョブが終わると、ElevenLabs 版と同じ投稿をしたうえで、claude に「[システム通知]」を送って声で伝えてもらう。

### claude に許すこと

- 自分でしてよいのは、Web 検索、`config.json` のリポジトリの読み取り、`git status/log/diff/show` だけ。ファイルの変更は禁止している（`--permission-mode dontAsk` なので、許可していないツールは確認なしで拒否される）。
- ファイルの変更やコミットが要る作業は、MCP のツール（`run_claude_code`・`get_job_status`・`cancel_job`）でジョブとして頼ませる。ジョブの扱いは ElevenLabs 版と同じ（下の「Claude Code への依頼」）。
- 作業ディレクトリは `~/.config/voice-agent-discord/session`。セッションは保存されるので、ログに出るセッション ID から後で開ける見込み（未確認）。
- MCP のツールを探す往復（ToolSearch）を省くため、`ENABLE_TOOL_SEARCH=false` で起動する。
- `--setting-sources project,local` で起動し、ユーザー設定とグローバルの `CLAUDE.md` を読まない（コミットや報告の決まりなど、通話に関係ない指示を持ち込まないため）。

### 通話を抜けたとき

- claude に通話のまとめ（決まったこと、やること、未解決の論点、ジョブ）を書かせ、ボイスチャンネルのチャットに投稿する。この通話のジョブに未プッシュのコミットがあれば、プッシュボタンを付ける（5件まで）。
- 同じ内容を引き継ぎ文として `~/.agent-handoffs/voice-agent-YYYYMMDD-HHMM.md` に書く。先頭には作成日時、モデル、セッション ID、各リポジトリのブランチと最新コミットを書く。既存の引き継ぎ文を上書きしないよう、通話ごとに別のファイルにする。
- 次の通話の開始時に、いちばん新しい `voice-agent-*.md` を claude に渡す。
- ユーザーが一度も話さなかった通話では、まとめを作らない。

### 気をつけること

- オーナーの声だけを受け取るので、Bot の読み上げを拾うことはない。ただし、スピーカーで聞いていると読み上げがオーナーのマイクに入り、割り込みとみなされる。イヤホンで使う。
- メモリ 8GB の M1 では、動画の書き出しなど重い処理と重なると、合成や認識が大きく遅れる。
- VOICEVOX の音声は、キャラクターごとの利用規約に従う（録音を公開するときのクレジット表記など）。

## ElevenLabs 版

```sh
npm run agent   # agent-config.js の内容でエージェントを作成・更新する
npm start       # VOICE_DEBUG=1 で音声接続のデバッグログを出す
```

- エージェントとツールの ID は `~/.config/voice-agent-discord/agent.json` に保存する（エージェントの ID は環境変数 `ELEVENLABS_AGENT_ID` でも指定できる）。
- エージェントは署名付き URL でしか接続できない設定（`enable_auth`）にしている。
- オーナーがボイスチャンネルに入ると Bot も入り、話し始めた時点で ElevenLabs との会話を始める。
- 会話時間で課金されるため、60 秒間どちらも話さなければ会話を切る。次に話すとまた始める。
- 音声の流れ: Discord の Opus（48kHz ステレオ）をデコードして 16kHz モノラルにし、100ms ごとに送る。黙っている間は無音を送る。エージェントの音声は 48kHz モノラルで受け取り、ステレオにして再生する。
- 話している途中にこちらが話すと、ElevenLabs が割り込みを検知して再生を止める。
- 会話の文字起こし、エージェントの返答、ツールの呼び出しをログに出す。
- 会話の開始時に、現在時刻と使えるリポジトリの名前をエージェントに渡す（`{{now}}`・`{{repos}}`）。
- Opus のデコードは `opusscript`（純 JS）で行う。npm 11 はネイティブモジュールのビルドを既定で止めるため、`@discordjs/opus` は使わない。

## Claude Code への依頼

エージェントには、次のツールを持たせている（ElevenLabs 版はクライアントツール、ローカル版は MCP のツール）。呼ばれると bot.js・local.js が処理する。

| ツール | 動作 |
| --- | --- |
| `run_claude_code(repo, task)` | `claude -p` をバックグラウンドで起動し、すぐにジョブ番号を返す |
| `get_job_status()` | 実行中のジョブ、または直近のジョブの結果を返す |
| `cancel_job()` | 実行中のジョブを止める |

- 作業できるのは `config.json` の `repos` に書いたリポジトリだけ。
- 同時に動かすジョブは1件。`jobTimeoutMinutes`（既定 15 分）を過ぎたら止める。
- 作業ツリーに未コミットの変更があるリポジトリでは始めない（利用者の変更を巻き込まないため）。
- Claude Code に許すのは、ファイルの読み書きと `ls`・`git status/diff/log/show/add/commit` だけ。`git push` は禁止している。ほかのコマンド（テストの実行など）は拒否される。
- 開始と結果を、ボイスチャンネルのチャットにオーナーへのメンション付きで投稿する。コミットがあれば「プッシュする」ボタンを付ける。
- ボタンはオーナーだけが押せる。押すと `git push origin <ブランチ>` を実行する。ジョブの後にブランチが変わっていたら止める。ボットを再起動すると、それ以前のジョブのボタンは使えない。
- 通話中にジョブが終わると、「[システム通知]」で始まるメッセージをエージェントに送り、結果を声で伝えてもらう。
- 共通の処理（ジョブの結果の投稿、プッシュボタン）は `discord-common.js` にある。

## エコー Bot

```sh
npm run echo        # VOICE_DEBUG=1 で音声接続のデバッグログを出す
```

- アプリのオーナーがボイスチャンネルに入ると、Bot も同じチャンネルに入る。オーナーが抜けると Bot も抜ける。
- オーナーの音声だけを受け取り、0.8 秒黙ったところで区切って、そのまま再生し返す。0.3 秒未満は捨てる。
- 受信したパケット数と DAVE のプロトコルバージョンをログに出す。
- オーナーはアプリの所有者から自動で決める。チーム所有のアプリでは `DISCORD_OWNER_ID` に自分のユーザー ID を指定する。
