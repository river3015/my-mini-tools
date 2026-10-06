# mac-pulse

Mac のメモリ・スワップ・CPU 負荷・ディスク・メモリを使っているアプリを1分ごとに Cloudflare へ送り、出先のスマホで見る。
危険な状態になったら Discord に通知する。

メモリ 8GB の M1 Mac で使う前提で、Mac 側には常駐プロセスを置かない。

## 構成

```
[Mac] launchd が1分ごとに collector/mac_pulse.py を実行（標準ライブラリだけ）
   │  POST /api/ingest（ホストごとのトークン ＋ Access のサービストークン）
   ▼
[Cloudflare Access] ログインしていない人・トークンのない通信を止める
   ▼
[Worker] worker/src/index.js
   ├ D1 に保存（生データ7日、1時間ごとの集計90日）
   ├ GET /  … スマホ用のダッシュボード
   └ 5分ごとの cron … 通知の判定、毎時0分に集計と古いデータの削除
         ▼
      Discord（Webhook）
```

- 送れなかったデータは Mac の `~/.local/state/mac-pulse/spool/` に残し、次の回にまとめて送る（1日分まで）。
- Worker は、Cloudflare Access を通っていないリクエストをすべて 403 で断る（`ctx.access` の `aud` を `ACCESS_AUD` と照合）。
- さらに、Access を通った相手で使える API を分ける。`POST /api/ingest` はサービストークン（Access の JWT `Cf-Access-Jwt-Assertion` に `common_name` がある）だけ、ダッシュボードと `/api/summary`・`/api/hosts` はログインした人（メールがある）だけ。本番ではサービストークンでも `getIdentity()` だけでは人と判定されたため、判定は JWT を優先する。サービストークンが漏れても、データは読まれない。ローカル（`ACCESS_AUD=local-dev`）では、模擬の人の ID でも送信できる。
- D1 のスキーマと設計の理由は [worker/migrations/0001_init.sql](worker/migrations/0001_init.sql) のコメントを参照。

### 送る項目

| 項目 | 取得元 |
| --- | --- |
| メモリ使用量（アプリ＋固定＋圧縮）、圧縮メモリ | `vm_stat` |
| メモリプレッシャー（1 正常・2 警告・4 危険）、空きの割合 | `sysctl kern.memorystatus_*` |
| スワップの確保量・使用量、スワップイン・アウトの累計 | `sysctl vm.swapusage`、`vm_stat` |
| 負荷（1分・5分）、起動からの時間 | `sysctl vm.loadavg kern.boottime` |
| CPU の速度制限（温度） | `pmset -g therm`（M1 では今のところ取れず NULL） |
| ディスクの空き | `/` の空き容量 |
| バッテリー、電源 | `pmset -g batt` |
| メモリを使っているアプリの上位10件 | `ps`。アプリ単位でまとめ、実行ファイル名だけを送る（引数は送らない） |
| launchd ジョブの状態 | `launchctl list`。設定の `watch_jobs` に合うものだけ |

Mac 側の負荷は、1回あたり CPU 時間 約0.25秒、最大メモリ 約29MB、実行時間 0.5〜1.7秒（負荷 17 のときに計測）。

### 通知

| 通知 | 条件 |
| --- | --- |
| メモリプレッシャー | 最新のデータで「危険」 |
| ディスクの空き | `DISK_LOW_GB`（既定 10GB）未満 |
| 常駐ジョブの停止 | `watch_jobs` のジョブにプロセスがない |
| データが届かない | `STALE_MINUTES` 分以上届かない。既定は 0（無効）。ノート PC はスリープで毎晩止まるため |

発生したときと解消したときに1回ずつ送る。発生中は6時間ごとに再通知する。
10分以上前のデータでは、メモリ・ディスク・ジョブの判定をしない（スリープ中に通知が揺れないように）。

## セットアップ

### 1. Worker と D1

```sh
cd worker
npm install
npx wrangler login
npx wrangler d1 create mac-pulse      # 表示された database_id を wrangler.jsonc に書く
npm run migrate:remote
npx wrangler deploy
npm run add-host -- mbp --remote       # ホストを登録。トークンが1回だけ表示される
```

### 2. Cloudflare Access

1. ダッシュボードの Workers & Pages → mac-pulse → 設定で、Cloudflare Access を有効にする（全トラフィック）。
2. 作られた Access アプリケーションの AUD タグを Worker に登録する。

   ```sh
   npx wrangler secret put ACCESS_AUD
   ```

3. ポリシーに、自分のメールアドレス（スマホから見る用）を許可するルールを入れる。
4. Mac から送る用に、Zero Trust → Access → サービス認証でサービストークンを作り、ポリシーに Service Auth のルールとして加える。

### 3. Discord への通知（任意）

```sh
npx wrangler secret put DISCORD_WEBHOOK_URL
```

### 4. Mac

```sh
# トークン類をキーチェーンに保存する（プロンプトで入力）
security add-generic-password -s mac-pulse-token -a "$USER" -w
security add-generic-password -s mac-pulse-access-client-id -a "$USER" -w
security add-generic-password -s mac-pulse-access-client-secret -a "$USER" -w

mkdir -p ~/.config/mac-pulse
cp collector/config.example.toml ~/.config/mac-pulse/config.toml   # endpoint を書き換える

collector/mac_pulse.py print   # 送る内容を確認する
launchd/install.sh             # 1分ごとの実行を登録する（外すときは uninstall）
```

ログは `~/Library/Logs/mac-pulse.log`。

## ローカルで試す

Cloudflare にデプロイせずに、Worker・D1・ダッシュボードを手元で動かせる。Access は `wrangler.jsonc` の `access.dev` で模擬する。

```sh
cd worker
cp .dev.vars.example .dev.vars
npm run migrate:local
npm run add-host -- mbp --local
npx wrangler dev --test-scheduled     # http://localhost:8787/

# 別のターミナルで（MAC_PULSE_TOKEN は add-host で表示されたもの）
printf 'endpoint = "http://localhost:8787"\n' > /tmp/mp.toml
MAC_PULSE_TOKEN=... ../collector/mac_pulse.py --config /tmp/mp.toml
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"   # cron を手で動かす
```

## テスト

```sh
uv run -p 3.12 --with pytest pytest mac-pulse/collector   # 収集側（パーサー、送信の再試行）
cd mac-pulse/worker && npm test                           # Worker 側（入力の検証、通知の判定）
```

## 将来

- `mac_pulse.py prometheus` で Prometheus の形式でも出せる。room-env のラズパイ（Prometheus / Grafana）ができたら、Tailscale 経由で集めて同じダッシュボードに載せる。
- メモリを使いすぎているアプリを、スマホから終了できるようにする（書き込み操作なので、認証と確認の設計をしてから）。
