# my-mini-tools

自分の日常作業を少し楽にするための小さなツール置き場。

## 方針

- 1ツール1ディレクトリで置き、ツールごとに短い README を付ける。
- 依存は最小限にし、単体で動かせるようにする。
- 秘密値や個人情報はコードに含めず、環境変数や設定ファイル（コミットしない）から読む。

## ディレクトリ構成

```
my-mini-tools/
├── README.md
└── <tool-name>/
    ├── README.md   # 使い方
    └── ...
```

## 作りたいツール

状態: 💡 アイデア / 🚧 作成中 / ✅ 完成

| 状態 | ツール | 概要 |
| --- | --- | --- |
| ✅ | [voice-input](voice-input/) | 高精度STT（語彙ヒント付き）＋整形で、AIエージェントへの音声入力を改善する（[調査メモ](docs/voice-input-research.md)） |
| 🚧 | [voice-agent-discord](voice-agent-discord/) | Discord のボイスチャンネルで AI エージェント（ElevenLabs Agents ＋ Claude Code）と音声で話す |
| 🚧 | [receipt-book](receipt-book/) | iPhone で撮ったレシートを Claude で読み取り、品目ごとの家計簿にする |
| 🚧 | [room-env](room-env/) | 部屋の CO2・温度・湿度を ESP32 で測って Grafana で見る。ゆくゆくは赤外線でエアコンや照明を操作する |
| 🚧 | [mac-pulse](mac-pulse/) | Mac のメモリ・スワップ・ディスクなどを1分ごとに Cloudflare（Worker ＋ D1）へ送り、出先のスマホで見る。危険なときは Discord に通知する |
| 🚧 | [attn](attn/) | 複数の AI エージェント（Claude Code、Codex）のセッションのうち、自分を待っているものを1か所に集めて見せる（[調査メモ](docs/attn-research.md)） |
| 💡 | aws-whoami | 現在のAWSアカウント・ロール・リージョンを一目で表示する |
| 💡 | tf-plan-summary | `terraform plan` の出力から削除・置換されるリソースだけを抜き出して要約する |
| 💡 | gitlab-ci-lint | ローカルの `.gitlab-ci.yml` をGitLabのLint APIで検証する |
| 💡 | branch-cleaner | マージ済みのローカル／リモートブランチを一覧・削除する |
| 💡 | handoff-check | エージェント用の引き継ぎファイルと現在のブランチ・コミットの整合を確認する |
| 💡 | ci-watch-notify | GitLab のパイプライン（`glab ci status --live`）の完了を macOS の通知で知らせる |
| 💡 | status-aggregate | AWS Health と、依存している SaaS のステータスページをまとめて見る |
| 💡 | subsc-check | サブスクの一覧・月額・次回更新日・解約期限を管理し、更新の数日前に通知する |
| 💡 | health-export-viz | iPhone のヘルスケアデータを書き出して、睡眠・歩数・体重の推移を見る |
| 💡 | sleep-wind-down | 就寝時刻の前に、通知・照明・画面をまとめて夜モードに切り替える |
| 💡 | life-slo | 睡眠・部屋の CO2・食費・運動を SLO にし、エラーバジェットの残りを Grafana で見て、使い切りそうなら Discord に通知する |
| 💡 | home-oncall | 自作の常駐プロセス（voice-input、Discord Bot、room-env など）の死活を監視し、止まったら通知する |
| 💡 | walk-and-write | 散歩中に voice-agent-discord へ話した内容から、ブログや SNS の下書きを作る |
| 💡 | walk-quiz | 勉強用リポジトリのメモから問題を作り、散歩中に Discord の音声で出題・採点する |

<!-- アイデアが増えたら上の表に行を追加する。完成したらツールのディレクトリへのリンクを付ける。 -->
