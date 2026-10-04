# voice-input

macOS で、キーを押している間だけ録音し、ElevenLabs Scribe で文字起こしした結果を前面のアプリに貼り付ける。
AI エージェントへの指示を音声で出すためのツール。

背景と調査は [docs/voice-input-research.md](../docs/voice-input-research.md) を参照。
設計は [VoiceInk](https://github.com/Beingpax/VoiceInk) を参考にしたが、コードは流用していない。

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

- macOS、[uv](https://docs.astral.sh/uv/)
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

起動するターミナルアプリに、システム設定の「プライバシーとセキュリティ」で次の権限を与える。

- マイク
- 入力監視（ホットキーの検知）
- アクセシビリティ（Cmd+V の送信）

## 使い方

```sh
./voice_input.py              # 常駐して、ホットキーで音声入力する
./voice_input.py --no-paste   # 貼り付けず、結果を表示するだけ
./voice_input.py --file a.wav # 音声ファイルを1つ文字起こしして終了する
```

VoiceInk など、同じホットキーを使うアプリとは同時に動かさない。

## ログイン時に自動で起動する

```sh
launchd/install.sh            # LaunchAgent を登録して起動する
launchd/install.sh uninstall  # 登録を解除する
```

- ターミナルで動かしている voice_input.py は、先に止めておく（スクリプトは二重起動を検知すると登録しない）。
- ログは `~/Library/Logs/voice-input.log` に出る。
- 異常終了したら 30 秒後に再起動する。
- 再起動: `launchctl kickstart -k gui/$(id -u)/io.github.river3015.voice-input`

launchd からは `~/.local/share/voice-input/venv` の Python を直接起動する（uv は Homebrew で更新するたびにパスが変わり、権限が外れるため）。
権限は、その Python の実体（`install.sh` が最後に表示するパス）に対して求められる。
ターミナルで付けた権限は引き継がれないので、システム設定で付け直す。
Python のバージョンが上がってパスが変わったときも、付け直しが必要。

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
