# ETH4N / Walker dsp

`index.html` と `img/` をそのままサーバーに置けば動きます。ビルドは要りません。

## 手元で見る

```bash
python3 -m http.server 8000
```

このフォルダで実行して、ブラウザで http://localhost:8000 を開く。
（`index.html` を直接ダブルクリックで開くと、Spotify のプレーヤーが読み込まれないことがあります）

## GitHub Pages で公開する

1. このフォルダを GitHub の新しいリポジトリに push する
2. リポジトリの Settings → Pages → Build and deployment で
   「Deploy from a branch」、ブランチ `main`、フォルダ `/ (root)` を選んで Save
3. 数分で `https://<ユーザー名>.github.io/<リポジトリ名>/` に公開される

## 中身

- `index.html` … ページ本体。CSS と JavaScript もこの中にある
- `img/` … ロゴ、製品の画面写真、ファビコン（`favicon.png`）、ホーム画面用アイコン（`apple-touch-icon.png`）
- `sow/` … SOW（SIREN Lite）。SOW タブがタブを開いたときに `sow/?embed` を読み込む。単独でも
  `sow/` で開ける。SOW プロジェクトの `tools/deploy_site.sh` が書き出すもので、ここでは直接編集しない

## メモ

- 書体は Google Fonts から読み込んでいる（Geist / Geist Mono / Zen Kaku Gothic New）
- SNS でリンクを貼ったときのサムネイル画像（`og:image`）は未設定。公開 URL が決まったら、
  `<head>` に `<meta property="og:image" content="https://…/img/…png">` を絶対 URL で足す
