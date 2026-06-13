# imagegen-server

Codex の画像生成ツール(imagegen)を、Codex のセッション外から使えるようにするローカル常駐サーバー。

- Claude Code / Codex から MCP(streamable HTTP)経由で画像を生成できる
- ブラウザ GUI から複数枚を並列生成し、ギャラリーで一覧・再利用できる
- 新規生成(generate)と、参照画像を使った編集(edit)の両方に対応
- 生成はすべて ChatGPT サブスクリプション認証の範囲内で行う(API キー課金は使わない)

## アーキテクチャ

単一の Node.js プロセスが `codex app-server` を子プロセスとして 1 つだけ常駐させ、画像 1 件ごとに ephemeral thread + 1 ターンで imagegen ツールを呼ばせる。認証(ChatGPT サブスク)とトークン管理はすべて codex 子プロセスに委譲し、本サーバーは認証トークンに一切触れない。ジョブはインメモリの worker pool(既定: 同時 3)で並列処理され、完了した画像とメタデータだけがディスクに永続化される(キュー自体は揮発で、再起動するとジョブ一覧は消えるがギャラリーは残る)。サーバーは `127.0.0.1` にのみバインドし、認証機構を持たない(ローカル利用限定)。

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

## 前提

- Node.js >= 22.18
- pnpm
- codex CLI がインストール済みで、**`codex login` 済み(ChatGPT サブスクリプション認証)** であること
  - **API キー認証(`OPENAI_API_KEY`)では画像生成できない。** imagegen は ChatGPT サブスク認証でのみ有効
  - 現在の認証状態は、サーバー起動後に `curl -s http://127.0.0.1:7878/api/health` の `auth` フィールドで確認できる

## セットアップ

```bash
pnpm install
pnpm -r build
```

## 起動

```bash
node server/dist/index.js
```

起動に成功すると次のログが出る:

```
imagegen-server: http://127.0.0.1:7878 (GUI/API) , /mcp (MCP)
```

終了は Ctrl+C(graceful shutdown: エンジン停止 → HTTP クローズ)。

開発時はビルドなしで起動できる(サーバーを tsx で直接実行):

```bash
pnpm dev
```

GUI 側のホットリロードが必要な場合は、別ターミナルで `pnpm --filter @imagegen/web dev` を実行する(Vite の dev サーバーが `/api` と `/mcp` を 7878 に proxy する)。

### CLI フラグ

| フラグ | 既定値 | 説明 |
| --- | --- | --- |
| `--port` | `7878` | リッスンポート(1〜65535)。バインド先は常に `127.0.0.1`(変更不可) |
| `--concurrency` | `3` | 画像生成の同時実行数(1〜10) |
| `--model` | (codex の既定モデル) | 画像生成ターンに使うモデル |
| `--data-dir` | `~/.imagegen-server` | データディレクトリ(画像・設定・作業領域の置き場) |
| `--codex-bin` | `codex` | codex CLI の実行コマンド(PATH に無い場合は絶対パスを指定) |

例: `node server/dist/index.js --port 8080 --concurrency 5`

### config.json

`<data-dir>/config.json`(既定: `~/.imagegen-server/config.json`)でも設定できる。優先順位は **CLI フラグ > config.json > 既定値**。

```json
{
  "port": 7878,
  "concurrency": 3,
  "turnModel": "gpt-5.1",
  "codexBin": "codex"
}
```

- 利用できるキーは `port` / `concurrency` / `turnModel`(`--model` に対応)/ `codexBin` の 4 つ。すべて省略可
- `dataDir` を変えたい場合は `--data-dir` フラグを使う(config.json 自体が `<data-dir>` 配下から読まれるため、ファイル内の `dataDir` キーは無視される)
- config.json が JSON として壊れている場合、起動時に日本語のエラーメッセージで停止する

## GUI

ブラウザで http://127.0.0.1:7878 を開く(`--port` を変えた場合はそのポート)。

- プロンプト + 枚数(1〜10)を入力して一括投入
- ジョブ一覧(キュー待ち / 実行中 / 完了 / 失敗)が SSE でリアルタイム更新される
- ギャラリー: グリッド表示。クリックで原寸 + メタ表示、ファイルパスのコピー
- 画像ごとの「これを元に再生成」で、その画像を参照画像とした編集ジョブを投入できる。参照画像のアップロードも可
- 失敗ジョブはリトライボタンで同パラメータのまま再投入できる

## MCP 登録

### Claude Code

```bash
claude mcp add --transport http imagegen http://127.0.0.1:7878/mcp
```

### Codex

`~/.codex/config.toml` に追加する:

```toml
[mcp_servers.imagegen]
url = "http://127.0.0.1:7878/mcp"
```

> **注意:** codex の streamable HTTP MCP クライアントは実装が流動的で、`experimental_use_rmcp_client` の要否や `mcp_servers` での URL 指定方法は**バージョンによって異なる**。上記で接続できない場合は `codex mcp add --help` を確認し、使用中のバージョンに合った登録方法に読み替えること。バージョンによっては次の指定が必要になる:

```toml
experimental_use_rmcp_client = true

[mcp_servers.imagegen]
url = "http://127.0.0.1:7878/mcp"
```

## MCP ツール仕様

### generate_image

画像を生成し、**全ジョブの完了までブロックして**結果を返す。`count > 1` は内部で並列処理される。`count` が大きいと数分かかりうるので、MCP クライアント側のツールタイムアウト設定に注意。

入力:

| 引数 | 型 | 説明 |
| --- | --- | --- |
| `prompt` | string(必須・非空) | 画像生成プロンプト。一字一句そのまま imagegen ツールに渡すようモデルに指示される |
| `count` | number(任意、1〜10、既定 1) | 生成枚数 |
| `ref_image_paths` | string[](任意、最大 5) | 指定すると編集(edit)になる。サーバーから読める絶対パス(.png / .jpg / .jpeg / .webp) |

返り値: text コンテンツ(JSON 文字列)。`images` の各要素は ImageMeta の全フィールド(`id` / `kind` / `prompt` / `revisedPrompt?` / `refImagePaths?` / `createdAt` / `durationMs` / `engine`)に `path`(保存先絶対パス)を加えたオブジェクト:

```json
{
  "images": [
    {
      "id": "<id>",
      "kind": "generate",
      "prompt": "...",
      "revisedPrompt": "...",
      "createdAt": "...",
      "durationMs": 12345,
      "engine": "app-server",
      "path": "/Users/you/.imagegen-server/images/<id>.png"
    }
  ],
  "failed": [
    { "error": "..." }
  ]
}
```

- `path` は保存済み PNG の絶対パス
- `revisedPrompt` はモデルが実際にツールへ渡した prompt(取得できた場合のみ)
- 一部失敗は `failed` 配列に載る。**全件失敗の場合のみ** `isError: true` のエラー結果になる

### list_recent_images

生成済み画像のメタデータと絶対パスを新しい順に返す。

| 引数 | 型 | 説明 |
| --- | --- | --- |
| `limit` | number(任意、1〜100) | 返す件数の上限 |

返り値: text コンテンツ(JSON 文字列)。各要素はメタデータ(`id` / `kind` / `prompt` / `revisedPrompt?` / `refImagePaths?` / `createdAt` / `durationMs` / `engine`)に画像ファイルの絶対パス `path` を加えたオブジェクトの配列。

## 保存場所

- 画像: `~/.imagegen-server/images/<id>.png`
- メタデータ: `~/.imagegen-server/images/<id>.json`
- アップロードした参照画像: `~/.imagegen-server/uploads/`

(`--data-dir` を変更した場合はそのディレクトリ配下)

ギャラリーはこのディレクトリのメタファイルをスキャンして表示する。DB は無いので、ファイルを消せばギャラリーからも消える。

## v1 の制限事項

- **失敗ジョブは永続化されない。** 完了した画像とメタデータのみがディスクに残る。失敗したジョブの記録はインメモリのキューにしか存在しないため、サーバーを再起動すると消える
- **再起動で実行中・キュー待ちのジョブは失われる。** キューは揮発で、再起動時に処理中だったジョブは復元されない(完了済みのギャラリーは残る)
- **`dataDir` は `--data-dir` フラグでのみ変更できる。** config.json の `dataDir` キーは無視される(config.json 自体が `<data-dir>` 配下から読まれるため)

## 検証済み codex バージョン

本サーバーは `codex app-server` のプロトコル(行区切り JSON-RPC)に依存する。下表は実機検証スクリプト(`scripts/probe.mjs`)を通したバージョンの記録。codex CLI を更新したら `node scripts/probe.mjs "a watercolor cat"` を再実行し、この表を更新すること。

| 項目 | 値 |
| --- | --- |
| codex CLI バージョン | codex-cli 0.139.0 |
| 検証日 | 2026-06-13 |

検証時(2026-06-13)に確認した挙動:

- アカウント種別: ChatGPT(plan: pro)
- ephemeral thread + read-only sandbox で imagegen が動作することを確認
- enum のワイヤ形式は kebab-case を受け付ける(`"approvalPolicy":"never"` / `"sandbox":"read-only"`)
- `experimentalApi` の opt-in は不要
- プロンプト忠実性: `revisedPrompt` が入力プロンプトと完全一致(generate / edit とも)
- `savedPath` あり: `~/.codex/generated_images/<thread>/ig_<hex>.png` 配下に保存される
- imageGeneration item の status は `"generating"`(`"completed"` ではない)。完了は item/completed + result/savedPath + turn.status completed で判定する
- read-only sandbox から cwd 外の参照画像を読めた(edit が動作)
- 1 ターンあたりの所要時間: 約 40〜50 秒(検証環境では多数の MCP サーバーが起動時間を押し上げている)

## トラブルシューティング

### 「codex login が必要です」と表示される / 認証エラーで失敗する

`codex login` で ChatGPT アカウントにログインする。API キー認証になっている場合も画像生成は不可(「画像生成には ChatGPT サブスクリプション認証(codex login)が必要です(API キー認証では不可)」と表示される)なので、ChatGPT サブスクリプションでログインし直す。現在の認証状態は `curl -s http://127.0.0.1:7878/api/health` の `auth` で確認できる。

### レート制限・バックエンドエラーで失敗する

ジョブは failed になり、エラーメッセージが GUI / MCP の結果に表示される。自動リトライはしない。時間をおいて、GUI のリトライボタン(API なら `POST /api/jobs/:id/retry`、MCP なら再度 `generate_image`)で再実行する。

### 「モデルが imagegen ツールを呼びませんでした」と失敗する

モデルが指示に従わず、画像生成ツールを呼ばずにターンを終えたケース。エラーメッセージにモデルの応答文が含まれる。**再リトライで解消することが多い。** 続く場合は `--model` で別のモデルを試す。

### GUI が「GUI は未ビルド(pnpm --filter @imagegen/web build)」というテキストを返す

`pnpm --filter @imagegen/web build` を実行してからサーバーを再起動する。

## 実機スモークチェックリスト(手動・任意)

自動テストは偽 app-server で挙動を網羅している。下記は**実サブスク認証での end-to-end 最終確認**で、実行は任意。**ChatGPT サブスクの利用枠を画像 4〜5 枚分(モデルターン 4〜5 回分)消費する。** 途中で失敗したら上のトラブルシューティング章に従い、解消してから続ける。

1. サーバー起動: `node server/dist/index.js`
   - Expected: `imagegen-server: http://127.0.0.1:7878 (GUI/API) , /mcp (MCP)` が表示され、プロセスが常駐する
2. ヘルスチェック(別ターミナル): `curl -s http://127.0.0.1:7878/api/health`
   - Expected: `"ok":true` かつ `auth.loggedIn` が `true`。`false` なら `codex login` してから 1. をやり直す
3. GUI で 1 枚生成: ブラウザで http://127.0.0.1:7878 を開き、プロンプト `a tiny watercolor cat`・枚数 1 で投入
   - Expected: ジョブ一覧が queued → running → succeeded と(リロードなしで)遷移し、ギャラリーに猫の画像が表示される
4. 生成物の確認: `ls ~/.imagegen-server/images/`
   - Expected: `<uuid>.png` と `<uuid>.json` のペアが存在する
5. Claude Code に MCP 登録: `claude mcp add --transport http imagegen http://127.0.0.1:7878/mcp` のあと `claude mcp list`
   - Expected: 一覧に `imagegen` が表示され、接続ステータスが正常(Connected 等)
6. MCP 経由で 1 枚生成: `claude` を起動し、「imagegen の generate_image ツールで "a pencil sketch of a lighthouse" を 1 枚生成して、返ってきた path を教えて」と依頼
   - Expected: ツール結果の `images[0].path` が返り、`ls <そのパス>` で PNG が実在する
7. MCP 経由で複数枚生成: Claude Code から `generate_image` を `count` 2〜3 で呼ぶ(サブスク枠を消費する点に注意)
   - Expected: MCP クライアントのタイムアウトで切断されずに全件完了する。タイムアウトする場合はクライアント側タイムアウト設定で暫定対処する
8. 終了: サーバーのターミナルで Ctrl+C
   - Expected: graceful shutdown(エンジン停止 → HTTP クローズ)でプロセスが終了し、ハングしない
