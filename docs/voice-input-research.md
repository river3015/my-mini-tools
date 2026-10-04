# 音声入力の精度改善 調査メモ（2026-10-04）

macOS 標準の音声入力で AI エージェントに指示を出しているが、精度に不満がある。
改善策と、Python で自作する場合の構成を調べた。

## 結論

- 精度を上げる仕組みは、ほぼ「高精度な STT（音声→テキスト）」と「LLM による整形」の組み合わせに落ち着いている。
  - Superwhisper、Wispr Flow、Aqua Voice、VoiceInk などの市販・OSS アプリも同じ仕組み。
- 勝間和代さんの構成は次のように変わってきた。
  1. Pixel、Windows 11 の標準音声入力、Simeji（〜2023）
  2. Whisper と Groq の LLM で整形（PC では SuperWhisper、Pixel では Dictate）（〜2026-04）
  3. ElevenLabs Scribe（2026-05〜）。「Whisper よりはるかに優秀」で、LLM の整形がいらなくなったと評価している。
- この Mac は M1 / メモリ 8GB。ローカルで LLM 整形（Qwen3-32B など）を回すのは難しい。
  クラウド API を使う構成が現実的。

## 勝間和代さんの知見

| 時期 | 内容 | 出典 |
| --- | --- | --- |
| 2023-03 | 日本語 STT の優劣は「同音異義語の間違いの少なさ」で決まる | [ブログ](https://katsumakazuyo.hatenablog.com/entry/2023/03/29/085130) |
| 2023-04 | マイクの性能より、話す本人の滑舌のほうが効く | [ブログ](https://katsumakazuyo.hatenablog.com/entry/2023/04/17/095734) |
| 2023-04 | カラオケ用マイクカバーを付けると、小声にしなくて済み、音質も上がる | [ブログ](https://katsumakazuyo.hatenablog.com/entry/2023/04/12/094519) |
| 2023-01 | 「変換が速いほうが訂正も速い」。速度も精度と同じくらい大事 | [ブログ](https://katsumakazuyo.hatenablog.com/entry/2023/01/06/095107) |
| 2026-01 | Chrome 拡張の Voice In で、句読点を単語登録（音声コマンド）で入れる | [ブログ](https://katsumakazuyo.hatenablog.com/entry/2026/01/05/223943) |
| 2026 | PC では USB / Type-C より 3.5mm ジャックのマイクのほうが精度が上がる | [note（実践者）](https://note.com/keiji_hiramoto50/n/n2e4abcf8e5e5) |
| 2026-04 | PC で作った「Whisper ＋ Groq の LLM で修正」の環境は、Pixel の Dictate で既にできていた | [公式サイト](https://www.katsumaweb.com/news.php?id=6566) |
| 2026-05 | ElevenLabs Scribe は雑音に強く、固有名詞に強く、LLM の後処理がいらない | [公式サイト](https://www.katsumaweb.com/news.php?id=6588) |

ポッドキャスト「メルマガ1000字を3分で」でも、Whisper と LLM 整形の構成を紹介している（[Spotify](https://open.spotify.com/episode/45zBVYC40Fl4xXQ3QHWdH7)）。

## よく使われる工夫

- **語彙のヒント**: 固有名詞や技術用語を STT に渡す。
  - Whisper では `prompt` / `initial_prompt`、Scribe では keyterm prompting（最大 1000 語）を使う。
- **LLM 整形のプロンプト**: 句読点、フィラー（「えー」など）の削除、同音異義語の修正だけを指示する。
  「内容に回答・翻訳しない」と明記し、LLM が指示に答えてしまう事故を防ぐ（[QuickVoice 自作記事](https://note.com/ai_tools_note/n/naf6fce844a76)）。
- **置換辞書**: よく間違える語を、認識結果をキーにした辞書で機械的に置き換える。
- **貼り付け方**: クリップボードに入れて Cmd+V で貼り、元のクリップボードを戻す。
  IME を通らないので、変換の競合が起きない。
- **使い分け**: 背景や意図は音声で話し、ファイルパスやコマンドはキーボードで打つ（[Zenn](https://zenn.dev/joemike/articles/claude-code-voice-input-20260424)）。

## 選択肢

| 方式 | 日本語精度 | 費用 | 備考 |
| --- | --- | --- | --- |
| macOS 標準 | △〜○ | 無料 | 専門用語をカタカナに誤変換しやすい。語彙ヒントは渡せない |
| Claude Code `/voice` | ○ | プランに含まれる | Claude Code の中でしか使えない。固有名詞に弱いという報告あり |
| Groq Whisper large-v3-turbo ＋ LLM 整形 | ○〜◎ | STT は約 $0.04/時間 | 勝間さんの旧構成。速い |
| ElevenLabs Scribe v2 | ◎ | 約 $0.22/時間（keyterm を使うと +$0.05） | 勝間さんの現行構成。Realtime 版は約 $0.39/時間 |
| ローカル Whisper（whisper.cpp / MLX） | ○ | 無料 | M1 / 8GB だと turbo モデルでも数秒かかる見込み（未計測） |
| VoiceInk（OSS アプリ） | 設定による | アプリは無料（ビルド）〜$25 | ElevenLabs、Groq などの API キーを持ち込める。置換辞書と AI 整形あり |

※ 価格はいずれも 2026-10 時点の Web 記事の値で、公式ページでは未確認。

## 自作する場合の構成案（Python）

1. グローバルホットキーで録音を始め、離したら止める（push-to-talk）。
   - 例: `pynput`、録音は `sounddevice`
2. 録音した音声を STT API に送る。
   - Scribe なら keyterm、Whisper なら prompt に、自分の語彙リストを渡す。
3. （必要なら）LLM で整形する。
4. 置換辞書を当てる。
5. クリップボード経由で、前面のアプリに貼り付ける。

macOS では、マイク・アクセシビリティ・入力監視の権限が必要。

## VoiceInk での試用（2026-10-04〜）

- `brew install --cask voiceink` で v2.21 を入れた（macOS 15 以上が必要）。無料試用のあと、ライセンスは有料。
- ソースで確認した事実:
  - ElevenLabs の `scribe_v2`（録音後に一括で文字起こし）と、ストリーミング版に対応している。
  - 辞書（Dictionary）に登録した語は、Scribe の `keyterms` として送られる（[LLMkit の ElevenLabsClient.swift](https://github.com/Beingpax/LLMkit/blob/main/Sources/LLMkit/Transcription/ElevenLabsClient.swift)）。
- 評価方法: 同じ文を macOS 標準の音声入力と VoiceInk の Scribe でそれぞれ読み上げ、誤認識の数を比べる。

## voice-input（自作版）の動作確認（2026-10-04）

macOS の `say -v Kyoko` で作った合成音声を、`--file` で Scribe v2 に送った。

| 条件 | 結果 |
| --- | --- |
| 読み上げた文 | テラグラントのプランで意図しない置換が出ているので、原因をステートと突き合わせて調べて。えーと、クロードコードで実行してください。 |
| 設定なし | TeraGrantのプランで意図しない遅延が出ているので、原因をstateと突き合わせて調べて、A8 Cloud Codeで実行してください。 |
| keyterms・置換あり | Terragruntのプランで意図しない遅延が出ているので、原因をstateと突き合わせて調べて、Claude Codeで実行してください。 |

- keyterms で「Terragrunt」「Claude Code」が正しくなった。
- `no_verbatim` で「えーと」が消えた。
- 「置換」が「遅延」になった。合成音声の発音のせいか、Scribe の誤認識かは未確認。
- 処理時間は約2.6秒（uv の起動時間を含む）。
- 合成音声での確認なので、実際の声での精度は別途確かめる。

## 参考

- [ElevenLabs STT API](https://elevenlabs.io/speech-to-text-api) / [料金](https://elevenlabs.io/pricing/api)
- [Groq Speech to Text](https://console.groq.com/docs/speech-to-text)
- [完全ローカル構成（TypeWhisper ＋ Qwen3-32B）](https://blog.cloudnative.co.jp/articles/typewhisper-with-local-llm/)
- [Claude Code 時代の音声入力アプリ4選（Qiita）](https://qiita.com/kazuki_ogawa/items/776340b97f0ca63292a8)
- [macOS 26 SpeechAnalyzer の語彙指定の制約](https://dev.to/simple_memo/ios-26-didnt-kill-custom-vocabulary-youre-adding-it-to-the-wrong-module-5bdc)
