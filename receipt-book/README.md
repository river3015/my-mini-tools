# receipt-book

iPhone で撮ったレシートの写真を Mac で読み取り、品目ごとの家計簿にする。

## 仕組み

1. iPhone で撮った写真を、iCloud Drive の `receipts/inbox/` に保存する。
2. Mac で `./receipt_book.py ingest` を実行すると、inbox の画像を1枚ずつ JPEG に変換して Claude に送る。
   店名・日時・支払方法・合計・税額・品目（品名、数量、金額、税率、カテゴリ）を JSON で受け取る。
3. 検算して SQLite に保存し、画像を `receipts/processed/YYYY/MM/日付_店名.jpg` に移す。
4. `report` で月ごとのカテゴリ別・店別の集計を見る。

### 検算と要確認

次のどれかに当たるレシートは「要確認」として保存し、`review` で一覧にする。

- 品目の金額の合計（外税なら税額を足す）と合計金額が2円を超えて違う
- 日付・合計が読み取れない、品目がない
- モデルが「読めない箇所がある」とメモを残した

値引きの行は、金額が負の品目として残す。

### 取り込まないもの

| 場合 | 画像の移動先 |
| --- | --- |
| 同じ画像をもう一度取り込んだ | `receipts/duplicates/` |
| 店名・日時・合計が同じレシートがすでにある | `receipts/duplicates/` |
| レシートではない | `receipts/rejected/` |
| API エラーなどで読めなかった | inbox に残す（次の `ingest` でやり直す） |

### カテゴリ

上から順に当てて、最初に当たったものを使う。

1. 設定の `item_rules`（品名に含まれる文字列）
2. 設定の `store_rules`（店名に含まれる文字列）
3. モデルが選んだカテゴリ

ルールを足したら `recategorize` で既存の品目に当て直す。`set-category` で手で直した品目は変えない。

### 集計

カテゴリ別の金額は、レシートの合計を品目の金額の比で按分して出す。
外税の税額や端数もカテゴリに含まれ、カテゴリ別の合計がレシートの合計と一致する。

## 必要なもの

- macOS（画像の変換に `sips` を使う）
- [uv](https://docs.astral.sh/uv/)
- Anthropic の API キー

## セットアップ

```sh
# API キーをキーチェーンに保存する（プロンプトで入力）
security add-generic-password -s receipt-book-anthropic -a "$USER" -w

# 設定ファイル（既定値のままでよければ省略できる）
mkdir -p ~/.config/receipt-book
cp config.example.toml ~/.config/receipt-book/config.toml

# inbox を作る
mkdir -p ~/Library/Mobile\ Documents/com~apple~CloudDocs/receipts/inbox
```

API キーは環境変数 `ANTHROPIC_API_KEY` からも読む。環境変数がある場合はそちらを優先する。

### iPhone のショートカット

ショートカットアプリで、次のアクションを並べたショートカット「レシート」を作る。ホーム画面や背面タップに置くと撮りやすい。

1. 「写真を撮る」
2. 「イメージを変換」: 形式を JPEG にする
3. 「ファイルを保存」: 保存先を iCloud Drive の `receipts/inbox` にし、「保存先を尋ねる」をオフにする

ショートカットを使わず、ファイルアプリで inbox に写真を保存してもよい。HEIC のままでも取り込める。

## 使い方

```sh
./receipt_book.py ingest                 # inbox の画像を取り込む
./receipt_book.py ingest ~/Desktop/a.jpg # 指定した画像を取り込む（元のファイルは残す）

./receipt_book.py report 2026-10         # 月のカテゴリ別・店別の集計（省略すると今月）
./receipt_book.py list 2026-10           # 月のレシート一覧
./receipt_book.py show 12                # レシート #12 の品目
./receipt_book.py export 2026-10 > 2026-10.csv  # 品目の CSV

./receipt_book.py review                 # 要確認のレシート
./receipt_book.py set-category 外食 34 35  # 品目 34・35 のカテゴリを直す
./receipt_book.py resolve 12             # 確認し終えたレシートを ok にする
./receipt_book.py recategorize           # 設定のルールを既存の品目に当て直す
./receipt_book.py usage                  # モデルごとのトークン使用量
```

`ingest` は、読めなかった画像が1枚でもあると終了コード1で終わる。

## データとプライバシー

- レシートの画像は Anthropic の API に送る。カードの下4桁や会員番号が写っていることがある。
- データベースは `~/Library/Application Support/receipt-book/receipts.db`、画像は iCloud Drive に置く。どちらもこのリポジトリには入れない。
- データベースの `raw_json` に、モデルが返した JSON をそのまま残している。読み取りの誤りを調べるときに使う。

## テスト

API を呼ばずに、検算・カテゴリ・取り込み・集計を確かめる。

```sh
uv run -p 3.12 --with anthropic --with pytest pytest receipt-book
```

## 今後

- inbox に画像が入ったら自動で取り込む（LaunchAgent の `WatchPaths`）
- `set-category` で直した内容を `item_rules` に追加する
- カードの明細 CSV と突き合わせて、記録漏れや二重計上を見つける
- 現金の支出を音声で記録する（voice-input と連携）
