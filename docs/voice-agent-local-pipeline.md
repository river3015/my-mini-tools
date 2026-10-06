# voice-agent: ElevenLabs を使わない構成の計測（2026-10-06）

ElevenLabs Agents を挟まず、音声認識・応答・音声合成を Mac 上と Claude のサブスクリプションだけで組めるかを確かめるために計測した。

- 環境: MacBook（Apple M1、メモリ 8GB）、macOS 26.5.2、Claude Code 2.1.288
- 構成案: Discord の音声 → 音声認識 → `claude`（stream-json で常駐）→ 音声合成 → Discord

## 音声認識

テスト音声は12本。Discord 経由で録れた実際の声7本（ElevenLabs の会話録音から切り出し）と、`say -v Kyoko` で作った技術用語入りの合成音声5本。時間は1本あたり（ウォームアップ後）。

| 方式 | 平均 | 実際の声7本 | 合成音声（技術用語） |
| --- | --- | --- | --- |
| macOS 純正 SpeechTranscriber（`.transcription`） | **0.11 秒** | 7本とも正確 | 英語の用語はカタカナ化・誤認識あり（「ロンちゃじゃん」「ジトラブ CI」「プランデース 3」） |
| mlx-whisper large-v3-turbo | 1.56 秒 | 7本とも正確 | やや良い（「リードミー」「Gitrab CI」「S3」）。「ロンチャジャント」 |
| mlx-whisper small | 0.47 秒 | 「電気」「ウェブスターち」など誤りあり | 誤りが多い |

- SpeechTranscriber は日本語（ja_JP）に対応し、初回に言語のアセットをダウンロードした。音声認識の権限の確認は出なかった。
- SpeechTranscriber では `AnalysisContext.contextualStrings`（語彙のヒント）を渡しても結果は変わらなかった。語彙のヒントを使うのは DictationTranscriber だけで、SpeechTranscriber は無視するという報告がある（下の「DictationTranscriber と語彙のヒント」）。
- DictationTranscriber（`.shortDictation`）は、同じ書き方では結果が空だった。確定（`isFinal`）の結果を出さずに終わり、暫定の結果だけを返していたため。
- 合成音声は Kyoko が英単語を日本語読みするため、実際の発話より不利な条件になっている。誤認識がカタカナ読み（「タラフォームのプラン」など）なら、Claude はそのまま意味を取れる見込み。
- 「無音で」が「部員で」になる誤りは、SpeechTranscriber と whisper turbo の両方で起きた。

### DictationTranscriber と語彙のヒント（2026-10-06）

用語の誤認識を減らせるかを確かめるため、短い口述向けの DictationTranscriber（`.shortDictation`）に語彙のヒント（`contextualStrings`）を渡して、SpeechTranscriber と比べた。

- テスト音声: 技術用語を含む10文を、`say` の Kyoko と Eddy で読ませた20本（16kHz モノラル）。用語はカタカナで書いて、日本人が話すときの読みに近づけた。
- ヒント: voice-input の keyterms（Terraform、Terragrunt、GitLab CI、Claude Code、tfstate、AGENTS.md）と、my-mini-tools、sandbox、voice-agent、Discord、claude -p、T3 Code の12語。
- DictationTranscriber は、最後の暫定の結果も拾うようにした。

| 方式 | 1本あたり | 結果 |
| --- | --- | --- |
| SpeechTranscriber | 0.20 秒 | 20本中、Kyoko の大半は読みどおりのカタカナで取れた。Eddy は崩れが多い |
| DictationTranscriber | 0.71 秒 | 文頭を落とすことが多い（「マイミニツールズの」が消える、「クロード」が「ロード」になる）。全体に SpeechTranscriber より悪い |
| DictationTranscriber とヒント | 0.78 秒 | ヒントの語で返ったのは「Terragrunt」の1本だけ。ほかに「Discord」「TFステート」が直った例があるが、ほとんどはヒントなしと同じ |

- 文頭に0.5秒の無音を足しても、DictationTranscriber の文頭の欠けは一部しか直らず、ヒントの効きも変わらなかった。
- 同じ音声でも、実行ごとに結果が少し変わる。
- 結論: 日本語では、DictationTranscriber とヒントの組み合わせで用語の精度は上がらなかった。ローカル版は SpeechTranscriber のままにする。
- 合成音声での比較なので、実際の声では差が変わる可能性がある。

### Groq の Whisper（2026-10-06）

同じ20本を Groq の whisper-large-v3（`language=ja`、`temperature=0`）で文字にした。語彙は DictationTranscriber のときと同じ12語を、カンマ区切りで `prompt` に入れた。

| 条件 | 1本あたり（往復） | 結果の例 |
| --- | --- | --- |
| prompt なし | 約 0.5〜0.9 秒 | 「MyMiniTools」「GitLab CI」「agents.md」は取れた。「クロードマイナスP」「TFステート」「クロードコード」はカタカナのまま |
| prompt あり | 約 0.6〜1.0 秒 | 「my-mini-tools」「Claude-p」「tfstate」「Claude Code」「Terraform」「Terragrunt」「Voice Agent」「Sandbox」。崩れたのは Eddy の「ブランティ」「起きた」くらい |

- SpeechTranscriber や DictationTranscriber より、用語ははっきり良い。合成音声で、英単語の読みはカタカナに寄せている。
- 物音（0.6 秒のノイズ）や無音を送ると、「ご視聴ありがとうございました」が返った。`no_speech_prob` は 0 で、判定に使えない。SpeechTranscriber は同じ音声で空を返したので、ローカル版では SpeechTranscriber を物音の判定に使う。
- 無料枠は、Whisper で1分20回、1日2,000回、1時間に音声 7,200 秒、1日に 28,800 秒（[Groq の Rate Limits](https://console.groq.com/docs/rate-limits)）。

## 応答（Claude Code）

`claude -p --input-format stream-json --output-format stream-json --include-partial-messages` を1プロセスで起動したまま3往復させ、送信から最初の1文（。！？まで）ができるまでを測った。各1回の計測なのでばらつきは大きい。

| モデル | 1往復目（起動を含む） | 2往復目 | 3往復目 |
| --- | --- | --- | --- |
| haiku | 4.2 秒 | 2.3 秒 | 1.8 秒 |
| sonnet | 2.6 秒 | 1.1 秒 | 1.4 秒 |
| opus | 3.3 秒 | 1.2 秒 | 1.9 秒 |

- stream-json の入力では、最初のメッセージを送るまで `system/init` が出ない。起動を待たずにすぐ送ればよい。
- 2往復目以降は、どのモデルでも最初の1文まで1〜2秒。今回は Haiku が速いとは言えなかった。

## 音声合成

| 方式 | 1文の合成時間 | 備考 |
| --- | --- | --- |
| VOICEVOX 0.25.2（ずんだもん、エンジンのみ起動） | 0.4〜1.5 秒（音声の長さの約 0.25 倍） | エンジンは約4秒で起動 |
| `say -v Kyoko` | 1.0〜1.3 秒（ファイル出力） | |

- 最初の計測は、別の作業（動画の書き出しで ffmpeg が CPU を約400%使用）と重なり、VOICEVOX が1文に13秒かかった。メモリ8GBではスワップが約5GBあり、重い処理と同時に使うと大きく遅れる。
- 3秒の文の合成は0.8秒程度なので、1文目を再生している間に次の文を合成すれば、途切れずに読み上げられる。

## 返事が始まるまでの見積もり

| 段階 | 時間 |
| --- | --- |
| 話し終わりの判定（無音の待ち時間） | 0.6〜0.8 秒（設定値） |
| 音声認識（SpeechTranscriber） | 0.1 秒 |
| Claude の最初の1文 | 1.1〜1.9 秒 |
| VOICEVOX の最初の1文 | 0.4〜0.8 秒 |
| **合計** | **約 2.2〜3.6 秒** |

ElevenLabs Agents を挟む構成（約1秒）より遅い。ただし、歩きながら話し続ける用途なら許容できる範囲と見ている。待ち時間を短く感じさせる手段:

- 話し終わりを判定したら、短い効果音を鳴らす（聞き取ったことが伝わる）。
- 1文目を短くするようプロンプトで指示する（「はい。」「なるほど。」から始める）。
- 文ができた順に合成・再生する。

## 採用案

- 音声認識: SpeechTranscriber（速く、実際の声の精度も十分）。Swift の小さな補助プログラムとして動かす。
- 応答: `claude` を stream-json で常駐させる（セッションの文脈が続く。モデルは sonnet か opus で試す）。
- 音声合成: VOICEVOX のエンジン（キャラクターごとの利用規約は未確認）。

## 通し試験（部品をつないだ結果、2026-10-06）

`voice-agent-discord` のローカル版の部品（stt.js、claude-session.js、voicevox.js、mcp.js、jobs.js）を Discord なしでつなぎ、録音済みの声と文字の発話で試した（sonnet、Claude Code 2.1.288）。

| 発話 | 送信から最初の1文ができるまで | 最初の音声ができるまで |
| --- | --- | --- |
| 雑談（ツールなし） | 1.8〜2.3 秒 | 2.6〜3.1 秒 |
| リポジトリのファイルを読む（Glob、Read） | 5.6 秒 | 6.8 秒 |
| ジョブを頼む（MCP の run_claude_code） | 4.5 秒 | 5.0 秒 |

- 実際の話し終わりからは、これに無音の待ち時間 0.7 秒と音声認識 0.1 秒が加わる。
- MCP のツールは、既定では ToolSearch で探してから呼ぶため1往復（約1秒）増える。`ENABLE_TOOL_SEARCH=false` で起動すると直接呼ぶ。
- stream-json の入力では、返事の途中に送ったメッセージは同じターンに取り込まれ、`result` は1つしか出ない。発話と `result` を1対1で対応づけられない。
- `{"type":"control_request","request":{"subtype":"interrupt"}}` を送ると、返事を作っている途中でも数ミリ秒で止まり、`result`（`error_during_execution`）が出る。止めた後の発話にも文脈を保ったまま答える。
- 通話の終わりに頼んだまとめ（決まったこと、やること、未解決の論点、ジョブ）は、ジョブの結果や中断した話題まで正しく拾えていた。

## 設定の比較（2026-10-06）

常駐させた claude（sonnet）で、雑談5往復とファイルの読み取り1回を、設定を変えて比べた（各1回）。

| 設定 | 最初の呼び出しの入力トークン | 雑談の最初の1文 | ファイルの読み取り | グローバルの CLAUDE.md |
| --- | --- | --- | --- | --- |
| そのまま | 31,403 | 1.1〜1.3 秒 | 4.3 秒 | 読み込まれる（その中のルールを「ある」と答えた） |
| `--setting-sources project,local` | 32,868 | 0.7〜1.4 秒 | 4.0 秒 | 読み込まれない（「ない」と答えた） |

- ユーザー設定を読まなくても、入力トークンは減らず（Claude Code 自体のシステムプロンプトとツールの説明が大半を占める）、速さの差は誤差の範囲だった。
- 通話に関係ない指示（コミットや報告の決まり）を持ち込まないために、`--setting-sources project,local` を採用した。
- thinking は、雑談では一度も入らず、「歴代の総理大臣を全員」のような重い質問でだけ入った。`--settings '{"alwaysThinkingEnabled":false}'`、`MAX_THINKING_TOKENS=0`、`--effort low` のどれでも止まらなかった。
- ツールを使う前に一言（「読みますね。」）言わせると、ツールを使う返事でも最初の音声までが 6.8 秒から 2.6 秒になった（待つ時間は変わらないが、黙っている時間がなくなる）。
