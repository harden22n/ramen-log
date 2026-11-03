# 拉麺帖（ラーメン記録）

行ったラーメン屋を、店名ですぐ引けるスマホ用アプリ（PWA）。

- 近くの店：位置情報で近い順に5軒出し、「行った」を1タップで記録。地図にない店は店名を手で足すと、その場所を覚えて次から候補に出る。
- 札幌市内の店は `data/sapporo-ramen.json` に入れてある（OpenStreetMap から取得）。札幌の外では OpenStreetMap の検索サーバー（Overpass）に聞く。
- 「行った」の直後に、頼んだもの・★（タップ）・写真（スマホの写真から選ぶ。アプリには長い辺1280pxに縮めた控えを IndexedDB に保存）・メモを入れる画面が出る。「あとで」で閉じて、店の詳細からあとで入れてもいい。
- 店名で検索（全角半角・カタカナひらがなの違いは気にしなくていい）。
- バックアップ：「Obsidianに保存」で保管庫の `プロジェクト/ラーメン記録/拉麺帖バックアップ.md` に上書き保存（obsidian:// のリンクを使う）。JSON ファイルへの書き出しもできる。読み込みは .json と .md のどちらでもよく、今の記録に足すだけで消さない。
- 記録はスマホのブラウザの中（localStorage）だけに保存する。サーバーには送らない。

## ファイル
- `index.html` `style.css` `app.js` … 画面と動き
- `sw.js` `manifest.webmanifest` `icons/` … ホーム画面に置くための設定（ファイルを直したら `sw.js` の `CACHE` の番号を上げる）
- `data/sapporo-ramen.json` … 札幌のラーメン店リスト。取り直すときは `node tools/update-sapporo.mjs`
- `design/` … デザインの見本（決定.html が採用案）

店のデータ © OpenStreetMap contributors（ODbL）
