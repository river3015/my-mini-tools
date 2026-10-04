---
name: voice-vocab
description: voice-input（自作の音声入力ツール）の語彙と置換辞書を更新する。「音声入力で〇〇が△△になった」「誤認識を直して」「音声入力の語彙を見直して」と言われたとき、または /voice-vocab で呼ばれたときに使う。
---

# voice-vocab

voice-input の設定 `~/.config/voice-input/config.toml` を更新し、誤認識を減らす。
ツール本体は `~/git/my-mini-tools/voice-input/`。仕組みは同じディレクトリの README.md を参照。

## 使うファイル

| パス | 内容 |
| --- | --- |
| `~/.config/voice-input/config.toml` | 編集する設定。`keyterms`（Scribe に渡す語彙）と `[replacements]`（認識後の置換） |
| `~/.local/state/voice-input/history.jsonl` | 直近1000件の認識結果。`raw` は置換前、`text` は置換後 |
| `~/Library/Logs/voice-input.log` | 常駐プロセスのログ |

history には口述した内容がそのまま入っている。必要な行だけを読み、回答に全文を貼らない。
設定と履歴は個人の語彙を含むので、リポジトリにコミットしない。

## 手順

1. 直したい誤認識を特定する。
   - ユーザーが「A が B になった」と具体的に言った場合は、それを使う。
   - 「見直して」とだけ言われた場合は、history の直近100件ほどから、誤認識らしい箇所を探す。
     例: 不自然なカタカナ語、意味の通らない英字、同じ誤りの繰り返し。
2. 直し方を決める。
   - **keyterms を優先する。** 正しい表記が固有名詞や技術用語なら、正しい表記を `keyterms` に足す。
     認識そのものが正しい表記に寄るので、言い方の揺れにも効く。
   - **replacements は次の場合に限る。**
     - keyterms を足しても同じ誤りが続く。
     - 表記の好みを揃えたい（例: 「プルリク」を「PR」に）。
   - replacements の置換元には、ほかの文脈で誤爆しない程度に長い文字列を使う。2文字以下や一般的な語は避ける。
3. 推測で直す場合は、変更案を表で示して確認を取る。ユーザーが具体的に指示した場合は、そのまま反映してよい。
4. `config.toml` を編集する。コメントと既存の並びは残す。
   - keyterms の制約: 1語50文字未満、5単語以下、`< > { } [ ] \` は使えない、合計1000語まで。
5. 検証する。

   ```sh
   ~/Applications/VoiceInput.app/Contents/MacOS/VoiceInput --check-config
   ```

   アプリは TOML の一部（文字列、真偽値、文字列の配列、`[replacements]` 表）しか読めないので、その範囲で書く。

6. 報告する。追加・変更した語と、keyterms と replacements のどちらに入れたかを伝える。

再起動は不要。voice-input は次の文字起こしの前に設定ファイルの更新を検知して読み直し、ログに `config reloaded` を出す。
`hotkey` を変えたときだけ、`launchctl kickstart -k gui/$(id -u)/io.github.river3015.voice-input` で再起動する（常駐しているのは ~/Applications/VoiceInput.app）。
