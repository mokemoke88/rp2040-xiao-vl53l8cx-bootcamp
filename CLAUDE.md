# CLAUDE.md

README.md は公開向け(GitHub の単体リポジトリの入口)。制約事項・段階構成・ビルド方法は README.md と docs/ を参照。

## 管理元リポジトリでの位置づけ

このディレクトリは管理元リポジトリ(`claude_general`)の `workspaces/rp2040/xiao-vl53l8cx-bootcamp` に submodule として置かれている。以下は管理元リポジトリでの情報で、公開向けの README には書かない。

- 参照元アイデア: なし(会話での相談から直接ワークスペース化)。近いテーマは `ideas/2026-07-11-microcontroller-rc-brainstorm.md` の「LiDAR」軸(紐づけはしていない)
- ビルド構成は `workspaces/rp2040/xiao-takeover-ctrl` を踏襲している
- 開発規約: ファームウェアは `rules/develop/c.md` + `rules/develop/c-pico-sdk.md`、ブラウザ(`web/`)は `rules/develop/typescript-vite.md`(Vite の概要は管理元リポジトリの `docs/vite-overview.md`)
- ツールチェーンの入手先とボード固有の注意点: knowledge の `pico-sdk-windows-toolchain-sources`、`xiao-rp2040-pico-sdk-notes`、`vl53l8cx-uld-and-pololu-carrier-notes`
- Python は管理元リポジトリのルートの `.venv` を使う(pyserial 入り)
- USB シリアルのログは serial-read スキルで読める(Pico の USB CDC は DTR を立てないと出力しないので `--dtr` を付ける)

## 書き分け

- README.md: 公開向けの入口(概要、配線、ビルド、使い方の要点、ライセンス)。Step の状態は README の「段階構成」の表
- docs/usage.md: 使い方の詳細
- docs/design-notes.md: 決定事項、設計の判断と見積もり、今後の候補
- docs/verification.md: 実機で確認する項目と結果
- 公開される文書・コメントには、作業ログ調の言い回し(「ユーザー報告」など)や管理元リポジトリへの参照(`ideas/`、`rules/`、knowledge など)を書かない。実機の結果は「実機で確認(日付)」と書く
