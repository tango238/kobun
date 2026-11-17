# kobun

ローカルで動く小さなソフトウェアファクトリ。Docker Compose だけで動き、要件確認 (grilling) → 実装セッション → 日次の自己改善 (Outer Loop) までを一通り自動で回す。

## 何をするものか

- セッション (チャット) でタスクを受け取り、エージェントがサンドボックス内でツール (read / write / edit / bash) を使って作業する
- 実装タスクは着手前に必ず grilling で要件を確認し、人の回答を待つ (ask-a-person)。回答期限は3時間で、無回答なら状態を保存して停止し、次のタスクに進む
- 毎日1回、Outer Loop が前日のセッション記録を分析してレポートを作る。制約内に収まる改善案があれば Draft PR まで自動で作る
- セッションの状態は Temporal Workflow として保持されるので、再起動しても会話とタスクが続く

## 構成

| サービス | 役割 |
| --- | --- |
| postgres | Temporal 用 DB + チェックポイント用 DB |
| temporal / temporal-ui | ワークフロー基盤 (UI: http://localhost:8080) |
| worker | Temporal Worker + エージェント実行 (Pi Durable) + REST API (:3000) |
| sandbox | ツール実行環境。内部ネットワークのみ、資格情報なし |
| egress | 外向き通信の許可リスト判定と GitHub トークンの差し替え (mitmproxy) |

エージェントループは Pi Durable (`@earendil-works/pi-durable`、1.3.0 に固定)。チェックポイントの保存先は、SQLite コア向けのファサードを Postgres で実装したカスタムアダプタ (`worker/src/pi/postgres-database.ts`)。ツール実行環境は `SandboxExecutionEnv` (`worker/src/pi/sandbox-env.ts`) がサンドボックス越しに提供する。

## 起動

```sh
cp .env.example .env   # LLM_BACKEND と資格情報を設定する (空でも起動はする)
docker compose up --build
docker compose exec worker npm run schedule   # Outer Loop の日次スケジュール登録 (初回のみ)
```

- Temporal UI: http://localhost:8080
- API: http://localhost:3000

## LLM 認証

`.env` の `LLM_BACKEND` でエージェントの実行バックエンドを切り替える。

- **`claude-cli`** (既定): 公式 Claude Code を `claude -p` で呼ぶ。**`CLAUDE_CODE_OAUTH_TOKEN` か `ANTHROPIC_API_KEY` のどちらかが必要**
  - `CLAUDE_CODE_OAUTH_TOKEN` は `claude setup-token` で発行する Claude Max のトークン (有効期限1年)。Max のプラン枠で使いたい場合は `ANTHROPIC_API_KEY` を空にすること
  - worker コンテナには Claude Code CLI を同梱してある
- **`pi`**: Pi Durable のエージェントループ (ツール実行つき)。**`ANTHROPIC_API_KEY` が必須**。単発のテキスト生成 (grilling の質問生成、Outer Loop の分析) も同じキーで Anthropic API を直接呼ぶ

資格情報が不足している場合、エージェントは黙って失敗せず、どの資格情報が必要かを応答に明示する。

## 使い方

```sh
# セッション開始
curl -X POST localhost:3000/sessions
# => {"sessionId":"session-..."}

# 発言 (選択中のバックエンドで応答する)
curl -X POST localhost:3000/sessions/<id>/messages -H 'content-type: application/json' -d '{"text":"こんにちは"}'

# サンドボックスで bash 実行 (ショートカット)
curl -X POST localhost:3000/sessions/<id>/messages -H 'content-type: application/json' -d '{"text":"bash:ls -la && git --version"}'

# 履歴取得
curl localhost:3000/sessions/<id>

# Outer Loop を手動で1回回す (レポートは sandbox の reports/ に生成)
curl -X POST localhost:3000/outer-loop/run
```

実装タスクは `impl:` で始める:

```sh
curl -X POST localhost:3000/sessions/<id>/messages -H 'content-type: application/json' -d '{"text":"impl:請求書PDFを生成する機能がほしい"}'
curl localhost:3000/sessions/<id>/questions   # grilling の質問を見る
curl -X POST localhost:3000/sessions/<id>/answer -H 'content-type: application/json' -d '{"text":"対象は…"}'   # 3時間以内に回答する
```

CLI からも操作できる:

```sh
docker compose exec worker npm run client -- "こんにちは"
docker compose exec worker npm run client -- "bash:pwd" <sessionId>
```

## Outer Loop の改善 PR

Outer Loop は分析レポートの作成に加えて、改善 PR の作成まで自動で行う。

1. 前日分のチェックポイントを分析してレポートを作る
2. 現在のリポジトリ内容 (sandbox の `/workspace` に clone した kobun) とレポートを LLM に渡し、小さな改善案を1つ作らせる (変更後のファイル全文形式)
3. ブランチ `outer-loop/<日付>` を切り、変更を commit して push する
4. GitHub API で **Draft PR** を作成し、レポート末尾に PR の URL (または作らなかった理由) を記録する

ガードレール:

- PR は Draft で作る。マージは人間が行う
- 1回の実行で PR は最大1本、変更は最大5ファイルまで。収まらない改善案は PR 化せず、レポートに残るだけになる
- `egress/addon.py` と `docker-compose.yml` (セキュリティ境界) と `.env` は自動変更の対象外
- 同日のブランチが既にあれば作り直さない (日次で冪等)
- sandbox 内に実トークンは置かない。git のリモート URL と API の Authorization にはプレースホルダーを入れ、egress が通信時に本物の `GITHUB_TOKEN` へ差し替える

前提: `.env` の `GITHUB_TOKEN` に、対象リポジトリへの書き込み権限のあるトークンを設定すること (未設定だと push の段階で失敗し、理由がレポートに残る)。

## テスト

Postgres バックエンドとサンドボックス環境は、Pi 公式の conformance suite で検証できる:

```sh
docker compose exec worker npm test
```

## egress ポリシー

`egress/addon.py` の `ALLOW` リストと `ORG` を編集する。デフォルトは拒否で、許可を足していく運用が前提。サンドボックスから GitHub API を叩く場合は `Authorization: Bearer dummy-placeholder` を付けてリクエストすると、egress が本物のトークンに差し替える。

## 注意

- Pi Durable は Experimental で API が予告なく変わるため、pi-durable / pi-ai / chord は **1.3.0 に固定**してある。上げる際は README と CHANGELOG の確認が必須
- Postgres ファサードは SQLite 方言の SQL をそのまま Postgres に流すため、SQLite 固有構文で失敗する可能性がある。`npm test` の conformance 結果が正否の基準
- `claude setup-token` のトークンは1年で期限切れになる。再発行して `.env` を差し替えること
