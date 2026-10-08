# 複数の AI エージェントを並行して使うときの負荷 調査メモ（2026-10-09）

Claude Code や Codex のセッションを並行して使いすぎて、頭の切り替えが多く疲れる。
同じ悩みの事例と、既存のツールを調べた。

## 結論

- 詰まるのは AI ではなく人間の注意。エージェントを並行して動かす道具はもう十分にあり、足りないのは「どれが自分を待っているか」を知る仕組み。
- だから作るのは、エージェントを動かす道具ではなく、注意を管理する層にする（→ [attn](../attn/)）。
- ツールを作る前に、次の運用だけでも効果がある。
  - 同時に動かすのは3つまでにする。
  - 承認や確認は時間を決めてまとめて処理する。
  - 振り分けをする時間と、深く考える作業の時間を分ける。

## 事例で挙がっていた課題

| 課題 | 出典 |
| --- | --- |
| 10以上を並行して動かしたら、ボトルネックは自分だった。止まっているのか動いているのか分からず、黙って失敗しているものに気づけない | [DEV](https://dev.to/kikakkz/i-ran-10-ai-coding-agents-in-parallel-the-bottleneck-wasnt-the-ai-12e3)、[GMO宮崎](https://gmo-miyazaki-creators.com/coding/agent/) |
| 開発者はエージェントのマネージャーになったが、ダッシュボードも状況ボードも持っていない | [Voxos](https://voxos.ai/blog/terminal-focus-routing-multiplexer/index.html) |
| 疲れの原因は、高度な判断ばかりになること、切り替え、進み具合を気にし続ける無意識のストレス、レビューの負荷 | [Zenn（テラーノベル）](https://zenn.dev/tellernovel_inc/articles/ai-agent-fatigue) |
| 速くなったのに疲れる。ボトルネックが「管理」に移った | [Zenn](https://zenn.dev/shingoirie/articles/210b4f6d73ec6c) |
| 4つ以上を並行すると午前中で消耗する。同時は3つまでがよい | [Xeve](https://xeve.io/blog/parallel-coding-agents-cognitive-cost)、[zsiegel](https://zsiegel.com/training-myself-to-work-with-ai-in-parallel/) |

「中断から集中を取り戻すのに23分」「切り替えで生産的な時間の40%を失う」などの数字はブログからの孫引きで、元の研究は確かめていない。

## 事例で挙がっていた対策

- 状態を3つに絞る（作業中 / 確認待ち / 入力待ち）。
- 状態はエージェントの自己申告ではなく、フックやログなど外から確かめる。「作業中」のまま長く動かないものは止まっている疑いとして出す。
- 報告の書式をそろえて、ざっと読めるようにする（やったこと、確かめたこと、残っていること）。
- 似た判断はまとめて処理する。止まると困るものだけすぐ通知し、ほかはまとめて知らせる。
- 対話するセッションは同時に3つまでにし、残りは待ち行列に積む（[Zenn: tq](https://zenn.dev/mh4gf/articles/claude-code-multi-session-job-queue)）。

## 既存のツール

| 種類 | ツール | 内容 |
| --- | --- | --- |
| 並行して動かす | Conductor、Claude Squad、Vibe Kanban、Superset など | git worktree で作業場所を分け、差分をレビューする（[比較記事](https://nimbalyst.com/blog/best-agent-management-tools-2026/)） |
| 注意を集める | [attnbox](https://github.com/wookat/attnbox) | Claude Code と Codex のログを読み、「あなたを待っているもの」を1つの受信箱に出す。フックを入れると状態が正確になる |
| 通知だけ | [ccn](https://github.com/Luxxgit2k4/ccn) など | 入力待ちになったらデスクトップに通知する |

比較記事も「人間がボトルネックになる問題は、どのツールも解決しきれていない」と結んでいる。

## 自作した理由

- attnbox に近いが、次を自分の運用に合わせたかった。
  - 戻ったときに読む「頼んだこと / 最後の報告」を中心にする。
  - 通知を、急ぎはすぐ、返答が来ただけのものはまとめて、と分ける。
  - 進行中の上限を出す。
- Claude Code の公式フック（`PermissionRequest`、`Notification`、`Stop` など）で、承認待ちが正確に分かる（[公式ドキュメント](https://code.claude.com/docs/en/hooks)）。
- T3 Code から使う Claude Code のセッションも `~/.claude/projects/` にログが残るので、どの画面から使っていても同じように集められる。
