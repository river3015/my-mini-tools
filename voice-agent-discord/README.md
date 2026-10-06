# voice-agent-discord

Discord のボイスチャンネルを電話代わりにして、AI エージェントと音声で話すための Bot。歩いている間に話しながら作業を進め、通話を抜けたらまとめと引き継ぎ文が残ることを目指している。

構成は2つあり、起動するコマンドで選ぶ。

| 構成 | コマンド | 音声認識 | 応答 | 読み上げ | 返事が始まるまで |
| --- | --- | --- | --- | --- | --- |
| ローカル版 | `npm run local` | Groq の Whisper（または macOS の SpeechTranscriber） | `claude`（サブスクリプション） | VOICEVOX | 約 3〜4 秒 |
| ElevenLabs 版 | `npm start` | ElevenLabs Agents | ElevenLabs Agents（作業は Claude Code に依頼） | ElevenLabs Agents | 約 1 秒 |

電話網（Twilio など）を使わないので、番号の取得や通話料が要らない。Discord は 2026-03-01 から通話の E2EE（DAVE）を必須にしたため、DAVE に対応した `@discordjs/voice` 0.19.2 以上を使う。

## 状態

1. ✅ エコー Bot（`echo.js`）: DAVE 必須の環境で音声を受信できるかの確認（2026-10-06、DAVE protocol v1 で受信・再生できた）
2. ✅ ElevenLabs Agents との会話（`bot.js`）
3. ✅ Claude Code の呼び出し、完了通知、承認ボタン（ElevenLabs 版は実機で会話を確認。声で依頼を通しで試すのはまだ）
4. ✅ ローカル版（`local.js`）: Discord での実機の会話、スレッドへの投稿、ほかのセッションへの依頼を確認した（2026-10-06）
5. 🚧 LaunchAgent で常駐させる（`launchd/install.sh`）: 起動（キーチェーン、VOICEVOX、SpeechTranscriber の準備、ログイン）、停止、異常終了からの再起動、子プロセスの後片付けを確認した。launchd の下での通話は未確認

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
security add-generic-password -s voice-input-groq -a "$USER" -w         # ローカル版で stt を groq にするとき（voice-input と共有）

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
| `groq-stt.js` | Groq の Whisper（whisper-large-v3）で発話を文字にする。用語は `prompt` で寄せる |
| `stt/main.swift`・`stt.js` | SpeechTranscriber（ja_JP）で発話を文字にする常駐プログラム。起動時に `swiftc` でビルドする（`stt/stt` はコミットしない） |
| `claude-session.js` | `claude -p` を stream-json の入出力で常駐させ、返事を文ごとに渡す |
| `voicevox.js` | VOICEVOX エンジンが動いていなければ起動し、48kHz ステレオで合成する。自分で起動したエンジンは終了時に止める |
| `mcp.js` | claude にジョブのツールを渡す、127.0.0.1 だけで待ち受ける MCP サーバー |

`config.json` の `local` で設定を変えられる。

| キー | 既定値 | 内容 |
| --- | --- | --- |
| `model` | `sonnet` | 応答に使うモデル |
| `stt` | `apple` | 音声認識。`groq` にすると Groq の Whisper を使う（下の「音声認識」） |
| `groqModel` | `whisper-large-v3` | Groq のモデル |
| `vocabulary` | なし | Groq に `prompt` として渡す用語。リポジトリ名と voice-input の `keyterms` も足す |
| `speaker` | `3` | VOICEVOX の話者 ID（3 はずんだもん） |
| `speedScale` | `1.15` | 読み上げの速さ |
| `bargeIn` | `false` | 読み上げ中に話したら止めるか（下の「割り込み」） |
| `textChannelId` | なし | まとめやジョブの結果を投稿するテキストチャンネルの ID。なければボイスチャンネルのチャットに投稿する |
| `transcript` | `true` | 発言と返事を投稿先に残すか（下の「投稿先」） |

### 音声認識

- `stt: "apple"`: macOS の SpeechTranscriber だけを使う。速い（約 0.2 秒）が、英語の用語はカタカナ化や誤認識が多い。
- `stt: "groq"`: 発話を Groq の Whisper と SpeechTranscriber に同時に送り、SpeechTranscriber が空なら物音として捨て、そうでなければ Groq の結果を使う。Whisper は物音だけの音声にも「ご視聴ありがとうございました」と返すため。
  - 用語は、`vocabulary`、`config.json` のリポジトリ名、voice-input の `~/.config/voice-input/config.toml` の `keyterms` をつないで、`prompt`（先頭から200文字）として渡す。
  - Groq が失敗したとき（通信の失敗、レート制限）は SpeechTranscriber の結果を使う。429 が返ったら `retry-after` の間は Groq に送らない。
  - キーは voice-input と同じ `voice-input-groq` を使う。無料枠（Whisper は1分20回、1時間に音声2時間、1日に8時間）は voice-input と共有になる。
  - 用語入りの合成音声20本では、語彙を渡すと「Claude-p」「tfstate」「Claude Code」「my-mini-tools」「Terraform」のように取れた。SpeechTranscriber では「クロードマイナスピー」「TFステート」「PFステージ」など。1発話あたり約 0.4〜1.3 秒（2026-10-06、`docs/voice-agent-local-pipeline.md`）。
- ログの `you (1.2s, groq 650ms)` の `groq`/`apple` は、どちらの結果を使ったか。

### 投稿先

- `textChannelId` を設定すると、通話ごとにそのチャンネルにスレッド（「2026-10-06 09:00 の通話」）を作り、その通話の文字起こし、ジョブの開始・結果、最後のまとめをすべてスレッドに投稿する。スレッドは最初に投稿するときに作る（文字起こしを残すなら、最初のあいさつのとき）。
- 文字起こし: claude に送った発言を `🗣️ 本文`（小さく「発話の長さ・使った認識・認識にかかった時間」を添える）、claude の返事を `🤖 本文` として、1件ずつ通知を鳴らさずに（@silent）投稿する。物音として捨てた発話と、まとめを作るときのやり取りは残さない。ほかのセッションからの連絡への返事は、これまでどおり 📥 で残す。`transcript: false` で止められる。
- Bot には、そのチャンネルでの「チャンネルを見る」「公開スレッドの作成」「スレッドでメッセージを送信」の権限が要る。スレッドを作れなかったときは、ボイスチャンネルのチャットに投稿する。
- 専用のサーバーでは、ツールごとにチャンネルを作り、名前をリポジトリのディレクトリ名に合わせる（例: カテゴリ「VOICE AGENT」に、ボイスチャンネル `voice-agent` とテキストチャンネル `#voice-agent`）。

### 会話の流れ

- オーナーがボイスチャンネルに入ると Bot も入り、その通話用に `claude` を1つ起動する。リポジトリの状態（未プッシュのコミット、未コミットの変更）と前回の通話のまとめを渡して、あいさつと話題の候補を話してもらう。
- 発話の区切り: Discord はオーナーが話している間だけ音声を送ってくるので、0.7 秒途切れたら話し終わりとみなす。0.3 秒未満の発話（相づちや物音）は捨てる。
- 文字にできたら短い効果音（2音）を鳴らしてから claude に送る。
- ツール（検索、読み取り、ジョブの依頼）を使う前に、「調べますね。」のような一言を先に言わせる。ツールの結果を待つ間、黙ったままにならない。
- claude の返事は文ができた順に VOICEVOX で合成し、前の文の再生中に次を合成する。記号、コード、URL は読み上げ前に落とす。
- 割り込み: 既定では受け付けない。読み上げ中に話しても読み上げは続き、発言は claude に送る（返事を作っている途中なら、同じ返事に取り込まれる）。読み上げ中は効果音を鳴らさない。
  - `bargeIn: true` にすると、読み上げ中や返事を作っている途中にオーナーが 0.3 秒以上話したとき、読み上げを止め、claude にも中断を送る（stream-json の `control_request` の `interrupt`）。実機では、物音でも止まってしまったため既定で切っている。
- ジョブが終わると、ElevenLabs 版と同じ投稿をしたうえで、claude に「[システム通知]」を送って声で伝えてもらう。

### claude に許すこと

- 自分でしてよいのは、Web 検索、`config.json` のリポジトリの読み取り、`git status/log/diff/show` だけ。ファイルの変更は禁止している（`--permission-mode dontAsk` なので、許可していないツールは確認なしで拒否される）。
- ファイルの変更やコミットが要る作業は、MCP のツール（`run_claude_code`・`get_job_status`・`cancel_job`）でジョブとして頼ませる。ジョブの扱いは ElevenLabs 版と同じ（下の「Claude Code への依頼」）。
- 作業ディレクトリは `~/.config/voice-agent-discord/session`。セッションは保存されるので、ログに出るセッション ID から後で開ける見込み（未確認）。
- MCP のツールを探す往復（ToolSearch）を省くため、`ENABLE_TOOL_SEARCH=false` で起動する。
- `--setting-sources project,local` で起動し、ユーザー設定とグローバルの `CLAUDE.md` を読まない（コミットや報告の決まりなど、通話に関係ない指示を持ち込まないため）。

### 動いているセッションへの依頼

「T3 Code の my-mini-tools のセッションに〜と頼んで」のように言うと、ジョブではなく、動いているほかの Claude Code のセッションに依頼を送る（Claude Code の[セッション間メッセージ](https://code.claude.com/docs/en/cross-session-messaging)）。作業の様子は T3 Code のアプリなどで見る。

- 通話の claude が `ListAgents` で送り先を探し、`SendMessage` で送る。セッションの名前は起動し直すたびに変わる（例: `my-mini-tools-06`）。候補が1つに決まらなければ、声で確かめる。
- 依頼文の最後には必ず「Discord の音声通話からの依頼であること、git push はしないこと、終わったら SendMessage で結果を返すこと」を入れさせる。相手のセッションは自分の権限とルールで作業するので、push をボタンの承認に限る仕組みは効かない。
- 相手の返事が届くと、通話の claude の新しいターンが自動で始まり、要点を読み上げる。届いた本文そのものは stream-json の出力に出ない（`command_lifecycle` の `started` だけが出る）ので、それを受けた返事を「📥」として通話のスレッドに投稿する。送った依頼も「📤」として投稿する。
- 届くかどうかは、受け取る側の権限モードで決まる。フルアクセス（bypassPermissions）のセッションは、dontAsk の通話の claude からのメッセージを保留する。auto などのセッションには、設定を変えずに届く（2026-10-06 に、T3 Code の auto のセッションとの往復を確認した）。
- 通話を抜けた後に届いた返事は、受け取る claude がいないので失われる。

### 通話を抜けたとき

- claude に通話のまとめ（決まったこと、やること、未解決の論点、ジョブ）を書かせ、投稿先（スレッド、なければボイスチャンネルのチャット）に投稿する。オーナーへのメンションは付けるが、通知は鳴らさない（@silent。未読のバッジは付く）。この通話のジョブに未プッシュのコミットがあれば、プッシュボタンを付ける（5件まで）。
- 同じ内容を引き継ぎ文として `~/.agent-handoffs/voice-agent-YYYYMMDD-HHMM.md` に書く。先頭には作成日時、モデル、セッション ID、各リポジトリのブランチと最新コミットを書く。既存の引き継ぎ文を上書きしないよう、通話ごとに別のファイルにする。
- 次の通話の開始時に、いちばん新しい `voice-agent-*.md` を claude に渡す。
- ユーザーが一度も話さなかった通話では、まとめを作らない。

### 常駐させる（LaunchAgent）

```sh
launchd/install.sh            # 登録して起動する（入れ直しにも使う）
launchd/install.sh stop       # 次のログインまで止める
launchd/install.sh uninstall  # 止めて登録を消す
tail -f ~/Library/Logs/voice-agent-discord.log
```

- ログイン時に起動し、異常終了したら 30 秒おいて起動し直す。`stop`（SIGTERM）で止めたときは起動し直さない。
- launchd の PATH は最小限なので、`node`・`claude`・`git`・`swiftc`・`security` のディレクトリを登録時に調べて plist に書く。`node` や `claude` の場所が変わったら入れ直す。
- コードを変えたら `launchd/install.sh` で入れ直す（起動し直すだけで反映される）。
- Mac がスリープしている間は動かない。復帰すると discord.js が接続し直す。
- `kill -9` などで落ちても、launchd がプロセスグループごと片付けるので、VOICEVOX や stt は残らない（2026-10-06 に確認）。
- ログは消さないので、大きくなったら手で消す。

`local.js`・`bot.js`・`echo.js` は同じトークンを使うので、`~/.config/voice-agent-discord/bot.pid` で1つしか動かないようにしている。常駐させている間に `npm run local` などを手で動かすと、すぐに終了する。手で動かしている間に常駐の方が起動すると、終了して 30 秒ごとに起動し直し、手で動かしている方を止めると入れ替わる。

### 気をつけること

- オーナーの声だけを受け取るので、Bot の読み上げを拾うことはない。ただし、スピーカーで聞いていると読み上げがオーナーのマイクに入り、オーナーの発言として claude に送られる（`bargeIn` が有効なら割り込みにもなる）。イヤホンで使う。
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
