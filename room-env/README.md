# room-env

部屋の CO2・温度・湿度を ESP32 で測って Grafana で見る。ゆくゆくは赤外線でエアコンや照明を操作し、条件に応じて自動で動かす。

段階1の途中。ESPHome の設定は [esphome/](esphome/) にある。

## 状態

- 2026-10-06: 部品を購入した（下表）。
- 2026-10-07: 部品が届いた。ATOMS3 Lite 用の ESPHome の設定を書き、`esphome config` が通ることを確かめた。実機への書き込みはまだ。

## 購入済みの部品

| 品名 | 価格（税込） | 役割 |
| --- | --- | --- |
| [ATOMS3 Lite](https://www.switch-science.com/products/8778)（M5Stack、M5STACK-C124） | ¥1,793 | ESP32-S3 のマイコン。赤外線 LED を内蔵 |
| [M5Stack用SCD40搭載CO2ユニット](https://www.switch-science.com/products/8496)（M5STACK-U103） | ¥6,413 | CO2・温度・湿度センサー。Grove ケーブル（20cm）付き |

- 2つは Grove ケーブルでつなぐだけ。はんだ付けやブレッドボードは要らない。
- ほかに、データ通信できる USB-C ケーブルと USB 充電器が要る（手持ちを使う）。
- SCD40 ユニットの仕様（販売ページの記載）: CO2 400〜2000ppm、精度 ±(50ppm＋測定値の5%)、I2C アドレス 0x62。

## 構成（最終形）

```
[部屋ごと] ESP32 (ESPHome)
  ├ SCD40: CO2・温度・湿度
  ├ 人感センサー（任意、LD2410 など）
  └ 赤外線 LED（送信）・受光モジュール（学習）
        │ /metrics（Prometheus 形式）、ESPHome API
        ▼
[ラズパイ] k3s
  ├ Prometheus または VictoriaMetrics … 収集・保存
  ├ Grafana                          … ダッシュボード
  ├ Alertmanager → Discord           … 「CO2 が高い、換気して」
  ├ 自動化コントローラー（自作）     … 条件に応じて赤外線を送る
  ├ Argo CD / Flux                   … GitOps
  └ Tailscale                        … 外から見る
```

## 段階

1. ATOMS3 Lite と SCD40 を ESPHome で動かし、Mac の Docker で Prometheus と Grafana を立ててグラフを出す。
2. ラズパイを買い、k3s に移す。GitOps で管理する。
3. 赤外線でエアコン・照明を操作する。HTTP から叩けるようにする。
4. Alertmanager から Discord への通知、温度や在室に応じた自動操作。
5. （任意）`kind: Aircon` の Operator。赤外線は一方通行なので、温度の変化から実際の状態を推定して送り直す reconcile ループにする。
6. （任意）voice-agent-discord に「部屋の状態」を答えるツールや家電を操作するツールを足す。

## 最初の作業

1. ~~Mac に Docker があるか確認する。~~ Docker Desktop の CLI はある。使う前にアプリを起動する。
2. ~~ESPHome をインストールし、ATOMS3 Lite 用の YAML を書く。~~ `uv tool install esphome` で入れ、[esphome/room-env.yaml](esphome/room-env.yaml) を書いた。
3. USB で書き込み、`http://<IP>/metrics` に CO2・温度・湿度が出るか確認する。2回目以降は OTA で更新する。
4. docker-compose で Prometheus と Grafana を立て、`/metrics` を収集してダッシュボードを作る。

## 書き込み

```sh
cd room-env/esphome
cp secrets.yaml.example secrets.yaml   # Wi-Fi などを入れる。鍵は openssl rand -base64 32 で作る
esphome run room-env.yaml              # 初回は USB。2回目以降は OTA を選べる
esphome logs room-env.yaml             # 起動ログの I2C スキャンに 0x62 が出れば SCD40 を認識している
```

- OTA は `api` と同じ鍵で暗号化する。`web_server` の平文の `/update` は無効にした。

## 未確認・決めること

- ATOMS3 Lite の内蔵 RGB LED・ボタン・赤外線 LED のピン番号。公式ドキュメントの仕様表に載っていない。Grove ポートは SDA が G2、SCL が G1（公式ドキュメントで確認済み）。
- ATOMS3 Lite の内蔵赤外線 LED がエアコンまで届くか。出力が小さいと推測している。届かなければ外付けの赤外線ユニットを買う。
- エアコンのメーカー・型番。ESPHome の `climate_ir` が対応していれば、リモコンの信号を学習しなくても操作できる。
- 照明が赤外線リモコン式か。
- SCD40 の温度は自己発熱で高めに出るので、オフセット補正が要る。自動校正は時々外気（約400ppm）に触れる前提なので、換気の少ない部屋ではずれる可能性がある。
- ラズパイのモデル、k3s を1台にするか複数台にするか（段階2で決める）。

## 参考

- [ESPHome: SCD4X](https://esphome.io/components/sensor/scd4x/)
- [ESPHome: Prometheus Component](https://esphome.io/components/prometheus/)
