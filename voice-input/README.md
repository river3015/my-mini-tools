# voice-input

macOS で、キーを押している間だけ録音し、ElevenLabs Scribe で文字起こしした結果を前面のアプリに貼り付ける。
AI エージェントへの指示を音声で出すためのツール。

背景と調査は [docs/voice-input-research.md](../docs/voice-input-research.md) を参照。
設計は [VoiceInk](https://github.com/Beingpax/VoiceInk) を参考にしたが、コードは流用していない。

実装は2つある。動作は同じで、設定ファイル・API キー・履歴を共有する。

| 実装 | 場所 | 用途 |
| --- | --- | --- |
| macOS アプリ（Swift） | `macos/` | 常駐用。権限を VoiceInput.app だけに与えられる |
| Python スクリプト | `voice_input.py` | ターミナルでの試用、`--file` での確認 |

## 仕組み

1. ホットキー（既定は右 Command）を押している間、マイクから 16kHz で録音する。
2. 離すと、`config.toml` の `keyterms` を付けて Scribe v2 に送る。
3. 置換辞書（`replacements`）を当てる。
4. クリップボード経由で Cmd+V を送って貼り付け、元のクリップボードの内容を戻す。

- ホットキーを押している間にほかのキーを押した場合は、通常のショートカットとみなして録音を捨てる。
- 0.3 秒未満の録音も捨てる。
- 開始時に Tink、送信時に Pop、失敗時に Basso の音を鳴らす。
- 無音しか録れなかった場合は送らない。マイクの権限がないと無音になる。
- 設定ファイルが更新されると、次の文字起こしの前に読み直す。`hotkey` の変更だけは再起動が必要。
- 認識結果を `~/.local/state/voice-input/history.jsonl` に直近1000件まで残す（権限 600）。誤認識の見直しに使う。

## 必要なもの

- macOS 14 以上
- アプリ: Xcode の Command Line Tools（`swiftc`、`codesign`）
- Python 版: [uv](https://docs.astral.sh/uv/)
- ElevenLabs の API キー。権限は Speech to Text のみでよい。

## セットアップ

```sh
# API キーをキーチェーンに保存する（プロンプトで入力）
security add-generic-password -s voice-input-elevenlabs -a "$USER" -w

# 設定ファイル
mkdir -p ~/.config/voice-input
cp config.example.toml ~/.config/voice-input/config.toml
```

API キーは環境変数 `ELEVENLABS_API_KEY` からも読む。環境変数がある場合はそちらを優先する。

Python 版をターミナルで動かす場合は、ターミナルアプリに、システム設定の「プライバシーとセキュリティ」で次の権限を与える。

- マイク
- 入力監視（ホットキーの検知）
- アクセシビリティ（Cmd+V の送信）

## 使い方（Python 版）

```sh
./voice_input.py              # 常駐して、ホットキーで音声入力する
./voice_input.py --no-paste   # 貼り付けず、結果を表示するだけ
./voice_input.py --file a.wav # 音声ファイルを1つ文字起こしして終了する
```

VoiceInk など、同じホットキーを使うアプリとは同時に動かさない。

## macOS アプリとして常駐させる

```sh
macos/make-cert.sh            # 初回だけ: 署名用の自己署名証明書をログインキーチェーンに作る
macos/build.sh                # macos/build/VoiceInput.app をビルドして署名する
launchd/install.sh            # ~/Applications に入れ、LaunchAgent に登録して起動する
launchd/install.sh uninstall  # 登録を解除し、アプリを消す
```

- 権限（マイク・入力監視・アクセシビリティ）は VoiceInput.app に与える。初回起動時に確認の画面が出る。
- 固定の証明書で署名するので、ビルドし直しても権限は外れない。証明書がない場合は ad-hoc 署名になり、ビルドのたびに付け直しになる。
- `build.sh` の署名時に、キーチェーンの秘密鍵を使ってよいか確認の画面が出る。「常に許可」にすると、ほかのプロセスも確認なしでこの鍵で署名できるようになるので、都度「許可」を選ぶ。
- ターミナルで動かしている voice_input.py は先に止めておく（二重起動を検知すると登録しない）。
- ログは `~/Library/Logs/voice-input.log` に出る。異常終了したら 30 秒後に再起動する。
- 再起動: `launchctl kickstart -k gui/$(id -u)/io.github.river3015.voice-input`
- コードを変えたら `build.sh` と `install.sh` をやり直す。

アプリも `--file 音声ファイル`、`--no-paste`、`--check-config`（設定の読み込み結果を表示）を受け付ける。
設定ファイルの場所は環境変数 `VOICE_INPUT_CONFIG` で変えられる。
設定ファイルは、使っている TOML の範囲（文字列、真偽値、文字列の配列、`[replacements]` 表）だけを読む。

## 語彙の更新（Claude Code スキル）

`skills/voice-vocab/` は、誤認識を `keyterms` や `replacements` に反映する手順をまとめたスキル。
次のようにリンクすると、Claude Code で「音声入力で〇〇が△△になった」や `/voice-vocab` で使える。

```sh
ln -sfn "$PWD/skills/voice-vocab" ~/.claude/skills/voice-vocab
```

設定ファイルと履歴は個人の語彙を含むので、このリポジトリには入れない。

## 制限

- 録音が終わってから送るので、話しながら文字は出ない。
- 貼り付け後、0.5 秒待ってからクリップボードを戻す。貼り付けが遅いアプリでは、戻したあとの古い内容が貼られることがある。
