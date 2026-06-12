# imagegen-server 設計ドキュメント

- 日付: 2026-06-13
- ステータス: 承認済み(実装計画 未着手)
- 対象リポジトリ: okash1n/imagegen-server

## 1. 目的と背景

Codex のセッション内で使える imagegen(画像生成)を、セッション外から使える独立ツールにする。

解決したい課題:

- Codex セッション内の imagegen は対話の一部としてしか呼べず、並列生成に向かない
- Claude Code / Codex のどちらからも共通の方法で呼びたい
- GUI から複数枚を並列生成し、結果を一覧・再利用したい
- ChatGPT サブスクリプションの範囲内で動かす(API キー課金を使わない)

成果物は、ローカル常駐の単一サーバー「imagegen-server」。3 つの入口(Claude Code 向け MCP、Codex 向け MCP、ブラウザ GUI)と、Codex App Server を使う 1 つの生成エンジンを持つ。

## 2. 前提となる調査結果(openai/codex リポジトリ)

設計の根拠となる事実。参照パスは openai/codex リポジトリ内の相対パス。

### 2.1 imagegen の実体

- Codex セッション内の `imagegen` ツールは拡張(extension)として実装されており、モデルがツール呼び出しで prompt を渡すと、拡張が ChatGPT バックエンドの `images/generations` / `images/edits` エンドポイントへ直接 POST する
  - ツール本体: `codex-rs/ext/image-generation/src/tool.rs`(モデルは `gpt-image-2` 固定、参照画像は最大 5 枚)
  - HTTP クライアント: `codex-rs/codex-api/src/endpoint/images.rs`
- 有効条件: OpenAI プロバイダ + ChatGPT サブスク認証(Codex backend auth)。API キーでは無効(`codex-rs/ext/image-generation/src/extension.rs:82`)
- 結果は base64 PNG で返り、`$CODEX_HOME/generated_images/<thread_id>/<call_id>.png` に保存される(`codex-rs/core/src/stream_events_utils.rs`)

### 2.2 App Server

- `codex app-server` は JSON-RPC 2.0 の統合面(VS Code 拡張が利用する公式面)。transport は stdio(デフォルト)/ unix socket / WebSocket
- ライフサイクル: `initialize` → `thread/start`(ephemeral 可、approvalPolicy / sandbox / model 指定可)→ `turn/start`(text / local_image 入力)→ `item/*` イベント → `turn/completed`
- 1 プロセスで複数スレッド・並列ターンを公式にサポート(`codex-rs/app-server/src/lib.rs` の接続・スレッド管理)
- 画像生成専用の RPC は存在しない。画像生成はターン内で imagegen ツールが呼ばれた結果(`ThreadItem::ImageGeneration`)としてのみ発生する

### 2.3 並列実行と認証

- App Server 1 プロセス内での並列が最も安全。認証・トークンリフレッシュは codex プロセス内の AuthManager が一元管理するため、多重プロセスで起きうるリフレッシュ競合を回避できる
- `getAuthStatus` RPC で認証状態の確認・リフレッシュを要求できる

## 3. 決定事項

| 論点 | 決定 | 理由 |
| --- | --- | --- |
| 用途・規模 | 挿絵・図版用途、1 バッチ数枚〜十数枚 | ユーザー要件。キューはインメモリで十分 |
| 編集対応 | 生成 + 編集(参照画像)両対応 | 「気に入った 1 枚を微調整」が中核ワークフローのため |
| 生成エンジン | App Server 経由のみ。Engine interface で将来の拡張に備える | 公式面でサブスク準拠が構造的に保証される。非公式エンドポイント直叩きはリスク(ToS・互換性)に見合う必要がまだない |
| スタック | TypeScript + Node.js LTS + pnpm。サーバーは Hono、GUI は React + Vite、MCP は公式 SDK | 安定性と実績。Hono は Node/Bun 両対応で将来の移行も安価 |

## 4. 全体構成

```
Claude Code ──MCP(HTTP)──┐
Codex CLI  ──MCP(HTTP)──┤
ブラウザGUI ──REST/SSE──┼─→ JobQueue(worker pool, 同時3・設定可)
                          │        ↓
                          │   ImageEngine interface
                          │        ↓
                          │   AppServerEngine
                          │        ↓ JSON-RPC (stdio)
                          └── codex app-server 子プロセス(常駐1つ)
                                   ↓ ephemeral thread × 並列
                              ChatGPT バックエンド(サブスク認証)
```

- 単一 Node プロセス。`127.0.0.1:7878`(デフォルト、設定可)にのみバインド。認証なし(ローカル限定が前提)
- 認証トークンには一切触らない。サブスク認証はすべて codex 子プロセスに委譲

## 5. コンポーネント設計

### 5.1 JobQueue

- インメモリ FIFO + worker pool(同時実行数はデフォルト 3、設定可)
- ジョブ状態: `queued → running → succeeded | failed`
- 失敗ジョブは手動リトライ(同パラメータで新規ジョブとして再投入)
- キューは揮発。完了結果(画像 + メタ)はディスク永続のため、再起動してもギャラリーは残る。実行中だったジョブは再起動時に failed 扱い

### 5.2 ImageEngine interface

```ts
interface ImageEngine {
  generate(req: { prompt: string; opts?: EngineOpts }): Promise<GeneratedImage>;
  edit(req: { prompt: string; refPaths: string[]; opts?: EngineOpts }): Promise<GeneratedImage>;
}
```

- v1 実装は `AppServerEngine` のみ
- 将来、images エンドポイント直叩きエンジン等を追加する場合もこの interface への純増とする

### 5.3 AppServerEngine

1 ジョブの処理フロー:

1. プロセス起動時に `codex app-server` を stdio で spawn し、`initialize` 済みの接続を維持する。子プロセスがクラッシュしたら自動再起動(バックオフ付き)し、実行中ジョブは failed にする
2. ジョブごとに `thread/start`(ephemeral、`approvalPolicy: never`、read-only sandbox、cwd は `~/.imagegen-server/work` の空ディレクトリ)
3. `turn/start` で厳格な指示を送る: 「imagegen ツールを、この prompt を一字一句そのまま使って 1 回だけ呼べ。他の操作はするな」。編集ジョブでは参照画像の絶対パスを `referenced_image_paths` に指定させる
4. `item/*` イベントから ImageGeneration アイテムの完了を待つ。`saved_path`($CODEX_HOME/generated_images/ 配下)から PNG を回収し、イベント内 base64 をフォールバックとする
5. 自前の保存先にコピーしてジョブ完了。タイムアウトは 1 ジョブ 180 秒

- ターン用モデルは設定値(未指定なら codex のデフォルトモデル)。軽量モデルでの安定動作は実装時に実機検証して既定値を決める
- 参照画像はサーバーの管理ディレクトリ内に配置した上で絶対パスを渡す(アップロード画像・生成済み画像のどちらも同じ扱い)

### 5.4 保存とメタデータ

- 画像: `~/.imagegen-server/images/<job_id>.png`
- メタ: `~/.imagegen-server/images/<job_id>.json`
  - prompt、種別(generate / edit)、参照画像パス、所要時間、生成日時、使用エンジン、エラー(失敗時)
- ギャラリー = メタファイルのスキャン。DB は使わない
- 設定: `~/.imagegen-server/config.json`(port、同時実行数、ターン用モデル、保存先)。CLI フラグで上書き可

### 5.5 GUI(React + Vite SPA、同サーバーから静的配信)

- プロンプト入力 + 枚数(1〜10)→ 枚数分のジョブを一括投入
- ジョブ一覧: キュー待ち / 実行中 / 完了 / 失敗を SSE でリアルタイム表示
- ギャラリー: グリッド表示。クリックで原寸 + メタ表示、ファイルパスのコピー
- 画像ごとに「これを元に再生成」(その画像を参照画像とした編集ジョブを投入)。参照画像のアップロードも可
- 失敗ジョブのリトライボタン

### 5.6 MCP サーバー(Claude Code / Codex 共通のプラグイン面)

`http://127.0.0.1:<port>/mcp` で MCP(streamable HTTP)を提供する。

| ツール | 引数 | 返り値 |
| --- | --- | --- |
| `generate_image` | `prompt`(必須)、`count?`(1〜10、デフォルト 1)、`ref_image_paths?`(編集時) | 完了までブロックし、保存ファイルパスの一覧 + メタを返す。count > 1 は内部で並列処理 |
| `list_recent_images` | `limit?` | 直近の生成結果のパス + メタ |

- 登録方法を README に記載する
  - Claude Code: `claude mcp add --transport http imagegen http://127.0.0.1:7878/mcp`
  - Codex: `config.toml` の `mcp_servers` に streamable HTTP として追加

### 5.7 REST API(GUI 用)

- `POST /api/jobs`(投入)、`GET /api/jobs`(一覧)、`POST /api/jobs/:id/retry`
- `GET /api/images`(ギャラリー)、`GET /api/images/:id`(ファイル配信)
- `GET /api/events`(SSE: ジョブ状態変化)
- `GET /api/health`(認証状態を含むヘルスチェック)

## 6. エラー処理

| 事象 | 挙動 |
| --- | --- |
| 未ログイン / トークン失効 | 起動時とジョブ失敗時に `getAuthStatus` で確認し、「`codex login` が必要」と GUI / MCP 双方に明示 |
| ターンが imagegen を呼ばずに終了(拒否・逸脱) | モデルの応答文をエラーメッセージとして failed に |
| レート制限・バックエンドエラー | failed + メッセージ表示。手動リトライ(自動バックオフは v1 対象外) |
| app-server 子プロセスのクラッシュ | 自動再起動(バックオフ付き)。実行中ジョブは failed |
| 入力検証 | prompt 必須・非空。参照画像は存在 + 画像形式チェック。count は 1〜10 |

## 7. テスト戦略

- ユニット: JobQueue / worker、JSON-RPC イベントストリームの解析(フィクスチャ)、メタストア
- 統合: 偽 app-server(台本どおりに応答する stdio プロセス)を使い、ジョブのライフサイクルを実サブスクなしで E2E 検証(CI 可能)
- 実機スモーク: 環境変数フラグで opt-in した場合のみ、本物の生成を 1 回流す(手動)

## 8. リポジトリ構成

```
imagegen-server/
  package.json          # pnpm workspace ルート
  server/               # Hono サーバー(API / MCP / queue / engine)
  web/                  # React + Vite SPA
  shared/               # サーバー・GUI 共有の型定義
  docs/
```

## 9. 未検証の前提とリスク

実装着手前または最初の実装ステップで実機検証が必要:

1. **ephemeral thread で imagegen 拡張が有効になるか。** 拡張の executor 選択は feature flag / モデルメタデータに依存するため、`thread/start` のパラメータ(モデル選択を含む)次第で imagegen ツールが出てこない可能性がある。あわせて、read-only sandbox の thread から `~/.imagegen-server` 配下の参照画像(`referenced_image_paths`)が読めることも確認する。最優先で検証する
2. **「prompt をそのまま使え」指示の遵守率。** imagegen ツールの契約上、prompt はモデルが書く引数であり、書き換えの余地が残る。実機検証で指示文を固める。ごく僅かな逸脱は許容する(完全な決定性が必要なら将来の直叩きエンジンで対応)
3. **App Server プロトコルの安定性。** 実験的 API への opt-in(`experimentalApi`)が必要な可能性がある。動作確認した codex CLI のバージョンを README に固定記録し、更新時に追従する
4. **コスト面。** 画像 1 枚ごとにモデルターン 1 回分のサブスク利用枠を消費する。挿絵用途の規模では許容と判断したが、大量生成用途に転用する場合は再検討が必要
5. **MCP の長時間ブロッキング呼び出し。** `generate_image`(count 最大 10)は数分かかりうる。クライアント側タイムアウトとの相性は実装時に確認し、必要なら進捗通知または非同期(ジョブ ID 返却 + ポーリング)に切り替える

## 10. スコープ外(v1 では作らない)

- images エンドポイント直叩きエンジン(interface だけ用意)
- キューの永続化・自動バックオフ・進捗復元
- launchd / systemd によるデーモン化(v1 はフォアグラウンド起動)
- リモートアクセス・認証付き公開
