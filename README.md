# kobun

ローカルで動くソフトウェアファクトリ

## 構成

| 役割 | 実装 |
| --- | --- |
| ワークフロー基盤 | `temporal` (temporalio/auto-setup) + `temporal-ui` |
| エージェントの実行 | `worker` (Temporal Workflow が受付・直列化、実行は Pi Durable) |
| エージェントハーネス | `@earendil-works/pi-durable` 1.3.0 (バージョン固定) |
| セッション・チェックポイントの保存 | `postgres` の `checkpoints` DB (Pi のテーブル + 平文ログ) |
| Web/Bot 層 | `api` (Hono, REST) |
| 隔離された実行環境 | `sandbox` コンテナ + デーモン (server.mjs) |
| 宛先制御 + クレデンシャル付与 | `egress` (mitmproxy + addon.py) |
| 自律改善の Outer Loop | `outerLoopWorkflow` (Temporal Schedule で日次起動) |
| エージェント組織 | チーフ / PjM / 各ロール、3層の行動ルール、週次の振り返りと改善レポート |
| プロジェクト内の情報共有 | ボード (共有された情報・決定事項・質問・やること・メンバーの状況) |
| 止まっている仕事の催促 | `patrolWorkflow` (巡回。Temporal Schedule で 9〜21 時の毎時起動) |
| API キーの保管とデータ取得の代行 | `broker` (クレデンシャルブローカー) |
| ユーザーの窓口 | 対話コマンド `npm run chief` (チーフとの会話、ボード、承認) |

部品のつながりと、どこまで確かめてあるかは [docs/architecture](docs/architecture/README.md) にまとめてある (ボードと巡回を足す前の時点の内容)。

## はじめかた

```sh
cp .env.example .env   # LLM_BACKEND と資格情報を設定する (下記「LLM 認証」。空でも起動はする)
docker compose up --build -d
docker compose exec worker npm run schedule   # Outer Loop (日次) と巡回 (毎時) のスケジュール登録。何度実行してもよい
docker compose exec worker npm run schedule -- chief-patrol   # 巡回だけを登録する
docker compose exec worker npm run schedule -- outer-loop-daily   # Outer Loop だけを登録する
```

起動したら、対話コマンドでチーフに話しかける (ホストで実行する)。

```sh
cd worker && npm install   # 初回のみ
npm run chief              # リポジトリのルートからなら npm --prefix worker run chief
```

- Temporal UI: http://localhost:8080
- API: http://localhost:3000
- クレデンシャルブローカー: http://localhost:3100 (シークレットの登録専用)

`.env` で変えられるもの:

| 変数 | 用途 |
| --- | --- |
| `LLM_BACKEND`、`CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_API_KEY` | LLM のバックエンドと資格情報 (下記「LLM 認証」) |
| `MODEL_OPUS` / `MODEL_SONNET` | ロール別のモデル |
| `REPOS_DIR` | エージェントに読ませるリポジトリの親ディレクトリ (下記「エージェントにコードを読ませる」) |
| `POSTGRES_PORT` / `BROKER_PORT` | ホストに公開するポート (既定 5432 / 3100)。ホストで使用中なら変える |
| `BROKER_KEY` | ブローカーの暗号鍵の元になる文字列 (空なら自動生成) |
| `GITHUB_TOKEN` | サンドボックスから GitHub を触るときに egress が付与するトークン |
| `EGRESS_GITHUB_ORG` | サンドボックスから GitHub への書き込みを許す org / ユーザー名 (空なら読み取りだけ) |

コードや `.env` を変えたあとは `docker compose up --build -d` で作り直す。会話・ボード・ルールは Postgres と Temporal に残るので、作り直しても続きから動く。

## 設計のポイント

- **Entity Workflow**: セッション1つ = Workflow 1つ (`worker/src/workflows.ts`)。Signal は直列に処理されるため、共有セッションでも排他制御が構造で担保される。履歴が伸びたら Continue-As-New で作り直す。Temporal は「受付と直列化とスケジュール」を持ち、エージェントの実行そのものは Pi Durable に任せる分担。
- **Pi Durable**: 会話・モデルターン・ツール実行は Pi のハーネスが担い、各ステップを Postgres にコミットしてから進む (`worker/src/pi/harness.ts`)。Worker が落ちても `resume()` で途中から再開できる。入力には Temporal の Activity リトライと二重投入を防ぐ `requestId` を付けている。
- **Postgres バックエンド**: Pi 標準の保存先は SQLite / JSONL のローカルファイルで、複数 Worker からは触れない。そこで SQLite コアが要求する `SqliteDatabase` ファサードを Postgres で実装し (`worker/src/pi/postgres-database.ts`)、`SqliteStorage.open(db, { prefix })` の実体を Postgres に置いた。セッションごとに prefix を分けて単一ライター前提を守る。
- **Sandbox-as-a-tool**: ツール (read / write / edit / bash) の実行環境は Pi の `ExecutionEnv` をサンドボックスデーモン越しに実装したもの (`worker/src/pi/sandbox-env.ts`)。ハーネスはサンドボックスの外にいる。
- **egress 制御**: サンドボックスは `internal: true` のネットワークに閉じ込められ、直接インターネットに出られない。外向き通信はすべて `egress` プロキシ経由で、許可リスト (ホスト/メソッド/パス) を通ったリクエストにだけ本物の GitHub トークンが付与される。サンドボックス内のトークンは `dummy-placeholder` のみ。
- **Outer Loop**: 毎日 03:00 (Asia/Tokyo) に `outerLoopWorkflow` が、直近 24 時間のエージェントの動きを集計して改善レポートを残す。全プロジェクトを横断して見るので、対象は kobun 全体 (ハーネス・プロンプト・共通ルール)。プロジェクト毎の改善は週次の振り返りが担う。共通ルールの提案は承認待ちに載るだけで、ユーザーが承認するまで変わらない。手順は下記「Outer Loop」。
- **LLM バックエンド切替**: `LLM_BACKEND` で Pi Durable と `claude -p` を切り替える。資格情報の要件はバックエンドごとに異なる (下記「LLM 認証」)。

## エージェント組織

ユーザーの窓口はチーフだけ。プロジェクト毎に PjM が1名付き、その下にチームが付く。

| ロール | モデル | 役割 | 話せる相手 |
| --- | --- | --- | --- |
| チーフ (`chief`) | Opus | オーガナイザー。全体で1名。ユーザーと会話してプロジェクトを立ち上げ、PjM を束ねる | ユーザー、PjM |
| PjM (`pjm`) | Opus | プロジェクト毎に1名。要件をまとめ、仕様書と UX設計をレビューする | チーフ、BA、エンジニア(リード)、デザイナー |
| シニアビジネスアナリスト (`business-analyst`) | Opus | 目的・背景・アウトカムを詰める。運用でカバーすることとシステム化することを分ける | PjM |
| シニアエンジニア・リード (`engineer-lead`) | Opus | 仕様書とアーキテクチャ。コード品質の指標に責任を持つ | PjM、実装、デザイナー、インフラ |
| シニアエンジニア・実装 (`engineer-impl`) | Sonnet | 実装とテスト | リード |
| シニアデザイナー (`designer`) | Opus | UX設計。UI の理由をエンジニアに説明する | PjM、エンジニア(リード)、UXアナリスト |
| UXアナリスト (`ux-analyst`) | Sonnet | 迷い・離脱の計測 (デザイナーから分離した計測担当) | デザイナー |
| インフラエンジニア (`infra-engineer`) | Sonnet | パフォーマンスとコストの監視、遅いクエリの報告、コスト削減提案 | エンジニア(リード) |

- 定義は `worker/src/agents/roles.ts`。表に無い宛先へのメッセージは配送されず、送り主に差し戻される (回数は指標 `agent_routing_violations_7d` になる)。
- チーフは `chiefWorkflow` (1つだけ)、プロジェクトは `projectWorkflow` (プロジェクト毎)。どちらも Entity Workflow。
- メッセージはロールごとにまとめて処理する。自分の番が来たロールは、たまっている自分宛のメッセージを全部受け取り、1回の発言で答える (1通ずつ答えると、答えている間に届いた分への返事が古くなり、行き違いが増える)。
- 別々のロールは同時に動く (同時に3ロールまで)。同じロールが同時に2つの発言を作ることはない。
- Workflow のコードを変えたときは、動いている会話の履歴をいまのコードで再生して確かめられる: `cd worker && REPLAY_TEMPORAL=localhost:7233 npx vitest run test/replay.test.ts`
- 1通の外部メッセージをきっかけにチーム内で回せるのは 24 回の発言まで。超えたら打ち切り、破棄した件数をユーザーに通知する。
- エージェントの出力はタグ形式 (`worker/src/agents/protocol.ts`)。成果物は `<artifact>` でサンドボックスの `projects/<slug>/` に保存される。
- モデルは `.env` の `MODEL_OPUS` / `MODEL_SONNET` で差し替えられる。

### ボード (プロジェクト内の情報共有)

プロジェクト毎に、チーム全員が**毎回の発言の前に読む**共有の掲示板がある。行き違いと聞き直しを防ぐためのもの。

| 欄 | 中身 | 書く人 |
| --- | --- | --- |
| 共有された情報 | ユーザーから得た事実・前提・資料の場所 | チーフ、各ロール、ユーザー (`/note`) |
| 決定事項 | 決まったことと、誰が決めたか | チーフ、各ロール |
| 未解決の質問 | 誰かの回答・判断を待っていること。**担当と期限を持つ** | チーフ、各ロール |
| やること | 誰かが引き受けた仕事。**担当と期限を持つ** | チーフ、各ロール |
| メンバーの状況 | 対応中か待機か、直前に何をしたか、本人のメモ (いま / 次 / 待ち) | 対応中かどうかと直前の動きは実際の記録から自動。メモは本人 |
| 直近の動き | 誰が誰の依頼で何を送り、どの成果物を更新したか (新しい順) | 自動 |

- エージェントには「ボードにあることは問い合わせない・繰り返さない」「ユーザーから得た情報と決定は、聞いたその発言の中でボードに書く」「回答をもらった質問はその場で下ろす」と指示してある。
- チーフには、各プロジェクトのボードが見えている (共有済みのことをユーザーに聞き直さないため)。
- 解決済みにした項目はボードから下りるが、DB (`board` テーブル) には残る。

### 期限と巡回 (止まっている仕事を動かす)

ボードの「未解決の質問」と「やること」には、担当と期限が必ず付く (定義は `worker/src/followup.ts`)。

- 担当はプロジェクトのロールか `user`。省くと書いた本人 (チーフとユーザーが書いた場合は PjM)
- 期限は `36h` / `3d` / `2026-11-21` の形。省くと、質問は 2 日、やることは 7 日
- 期限の引き直し (`<board-due>`) には理由が要る。理由は項目の本文に残る

**巡回** (`patrolWorkflow`、Schedule `chief-patrol`、9〜21 時の毎時 0 分) が、期限を過ぎた項目の段階を1つずつ上げる。段階を上げるのはコードで、LLM は関わらない。

| 段階 | いつ | 何が起きるか |
| --- | --- | --- |
| 1 | 期限を過ぎた | 担当ロールに催促が届く (片付けるか、理由つきで期限を引き直す) |
| 2 | 段階 1 から 24 時間 | PjM に上がり、チーフの「判断待ちの一覧」に載る |
| 3 | 段階 2 から 24 時間 | ユーザーのフィードに出る。ここから先は通知しない |

- 担当が `user` の項目は、エージェントを催促せず、期限切れで直接ユーザーのフィードに出る
- チーフ (LLM) が呼ばれるのは、判断待ちを新しく見つけた回だけ。一覧に載るのは、PjM に上がった期限切れ・保留から 3 日たった実装タスク・承認の期限を過ぎたルール提案で、どれも1回しか載らない
- 期限を過ぎたまま残っている件数は、指標 `board_overdue` として振り返りに出る

```sh
curl localhost:3000/pending               # 判断待ちの一覧 (期限切れ・保留中の実装タスク・承認待ちの提案)
curl -X POST localhost:3000/patrol/run    # 巡回を手動で1回回す
curl -X POST localhost:3000/projects/<slug>/board -H 'content-type: application/json' -d '{"kind":"task","owner":"engineer-lead","due":"3d","text":"API 仕様の初版を書く"}'
```

対話コマンドでは `/board [slug]` で見る、`/note <slug> <内容>` で情報を直接書く、`/done <slug> <B-番号> [理由]` で下ろす。API は `GET` / `POST /projects/<slug>/board`、`POST /projects/<slug>/board/<B-番号>/resolve`。

### プロジェクトの立ち上げ

チーフがユーザーと会話して立ち上げる。クライアントは複数いるため、**クライアント未指定のプロジェクトは作成されない** (チーフに差し戻され、ユーザーに確認する)。

対話コマンドで話す (入力した行がチーフに送られ、返事・アラート・改善レポート・依頼が届き次第表示される):

```sh
cd worker && npm run chief   # 接続先は KOBUN_API (既定 http://localhost:3000)
```

- **Enter** で送信。**Shift+Enter** で改行 (Shift+Enter を区別して送らない端末では **Alt/Option+Enter** か **Ctrl+J**)
- 貼り付けた文章は、改行を含んでいても送信されず入力欄に入る。確認して Enter で送る
- `/board [slug]` でボード、`/note <slug> <内容>` でボードへの書き込み、`/done <slug> <B-番号>` で項目を下ろす
- `/team [slug]` で、チームのメンバーと状況が見える (いま対応中のロール、順番待ちの件数、各ロールの最後の依頼と結果、順番待ちのメッセージ)
- `/pending` で判断待ちの一覧、`/parked` で保留中の実装タスク、`/resume <番号> <回答>` で再開、`/drop <番号>` で取り下げ、`/patrol` で巡回を今すぐ1回
- `/projects`、`/repos <slug>`、`/repo <slug> <名前> <URLかパス> [説明]`、`/proposals`、`/approve <番号>`、`/reject <番号>`、`/history`、`/help`、`/quit` が使える

API を直接叩く場合:

```sh
curl -X POST localhost:3000/chief/messages -H 'content-type: application/json' -d '{"text":"アクメ商事の請求書発行を自動化したい"}'
curl localhost:3000/feed          # ユーザーに届いたもの全部 (チーフの発言・依頼・アラート・改善レポート)
curl localhost:3000/chief         # チーフとの会話履歴
curl localhost:3000/projects          # プロジェクトの一覧
curl localhost:3000/clients           # クライアントの一覧
curl localhost:3000/projects/<slug>   # プロジェクト内の各ロールの会話状態
curl localhost:3000/projects/<slug>/team   # メンバーと状況 (対話コマンドの /team と同じ)
```

### 行動ルール (3層)

| 層 | 範囲 | ID |
| --- | --- | --- |
| kobun 共通 | すべてのプロジェクト | `K-n` |
| クライアント | そのクライアントの全プロジェクト | `C-n` |
| プロジェクト | そのプロジェクトだけ | `P-n` |

矛盾する場合は **プロジェクト > クライアント > kobun 共通** の順に優先する (下の層が上書きする)。3層とも全ロールのプロンプトに毎回入り、振り返りで追加・置換・廃止される。変更は改善レポートに層・操作・ID 付きで載る。

振り返りによる変更の適用は、層で分かれる。

- **プロジェクトの層**: その場で適用される
- **kobun 共通・クライアントの層**: 他のプロジェクトにも効くので、**ユーザーが承認するまで適用されない**。承認の依頼がフィードに届き、レポートには「承認待ち」として載る
  - 承認待ちには 7 日の期限がある。過ぎても自動では適用も却下もされず、巡回がチーフの一覧に1回だけ載せる
  - 同じ提案が承認待ちの間は重ねない。却下した提案は、同じ文面では二度と出ない (ユーザーが直接足すことはできる)

```sh
curl localhost:3000/rule-proposals                       # 承認待ちの一覧
curl -X POST localhost:3000/rule-proposals/<番号>/approve  # 承認して適用
curl -X POST localhost:3000/rule-proposals/<番号>/reject   # 却下 (何も適用しない)
```

```sh
curl localhost:3000/projects/<slug>/rules
# ユーザーが直接変更する (承認は不要。どの層もその場で適用される)
curl -X POST localhost:3000/projects/<slug>/rules -H 'content-type: application/json' -d '{"scope":"client","text":"請求書の金額は税込で表示する"}'
curl -X POST localhost:3000/projects/<slug>/rules -H 'content-type: application/json' -d '{"scope":"client","text":"...","replaces":"C-1"}'
curl -X POST localhost:3000/projects/<slug>/rules -H 'content-type: application/json' -d '{"retire":"P-2","reason":"..."}'
```

## 振り返りと改善

各プロジェクトで週1回 (月曜 09:00 JST、Temporal Schedule `retro-weekly-<slug>`) `retroWorkflow` が走る。

1. データソースから数字を取得する
2. 各ロールが、数字を根拠に担当領域の改善を提案する
3. PjM が、今週実行する改善アクションと、行動ルールの追加・置換・廃止、ADR を決める
4. 改善レポートをユーザーに送り、PjM に実行を指示する。結果は翌週の計測値で自動判定される

改善レポートは LLM に書かせず、取得した数字からコードが組み立てる (`worker/src/metrics/report.ts`)。必ず載るもの: 指標の前週比、前週アクションの達成/未達と連続未達回数、5% を超えて悪化した指標と対応アクションの有無、指標や目標値のないアクションの件数、ルールの変更、取得できなかった数字 (指標単位) と必要な対応。

```sh
curl -X POST localhost:3000/projects/<slug>/retro/run        # 手動で1回回す
curl localhost:3000/projects/<slug>/metrics                  # 最新の指標と改善アクション
curl localhost:3000/metrics/catalog                          # 必要な指標の一覧と行動規範
```

### 振り返りに必要なデータと取得方法

定義は `worker/src/metrics/catalog.ts`。取れていない指標は、レポートに取得方法つきで「未計測」と出る。

| 担当 | 指標 (キー) | 取得元 |
| --- | --- | --- |
| シニアエンジニア | 重複率 `duplication_pct`、複雑度 `complexity_avg`、カバレッジ `coverage_pct` | `command` (サンドボックスでコマンドを実行し、最後の行の数値を読む) |
| シニアエンジニア | 不具合発生率 `bug_rate_per_100_prs`、CI 実行時間 `ci_duration_avg_sec` / `ci_duration_p95_sec`、CI 失敗率 `ci_failure_rate_pct` | `github` (登録したリポジトリすべてを集計) |
| UXアナリスト | 離脱率 `ux_dropoff_pct`、所要時間 `ux_task_time_sec`、エラー率 `ux_error_rate_pct` | `http-json` (分析 API の JSON 応答から取り出す) |
| ビジネスアナリスト | アウトカム適合スコア `outcome_fit_score`、フィードバック件数 `outcome_feedback_28d` | ユーザーのフィードバック (下記) |
| ビジネスアナリスト | 運用でカバーした件数 `ops_workaround_7d`、プロジェクト固有の `outcome_*` | `http-json` |
| インフラエンジニア | コスト `cost_usd_7d` / `cost_usd_day`、任意の CloudWatch メトリクス | `aws` (Cost Explorer / CloudWatch) |
| インフラエンジニア | 遅いクエリ `db_slow_queries`、キャッシュヒット率、接続数、サイズ | `postgres` (`pg_stat_statements` 推奨) |
| PjM | 改善アクション達成率、応答失敗、会話経路の違反、期限切れの仕事 `board_overdue`、期限切れの提案 `rule_proposals_overdue` など | kobun が常に自動計測 |

```sh
# アウトカムへのフィードバック (1〜5 点)。ビジネスアナリストが振り返りでズレの確認に使う
curl -X POST localhost:3000/projects/<slug>/feedback -H 'content-type: application/json' -d '{"score":2,"comment":"締め日の例外が考慮されていない"}'
```

### 改善の行動規範

`catalog.ts` の `CODE_OF_CONDUCT` (12項目) が kobun 共通ルール `K-1`〜`K-12` として初期登録される。以後は他のルールと同じく振り返りで置換・廃止できる。要点:

- 結果確認 → 悪化した指標 → 原因 → 次のアクション → ルール化、の順に行う
- アクションは担当1ロール・指標1つ・現在値・来週の目標値を持つ。計測できない領域は、まず計測できるようにする
- 5% を超えて悪化した指標は、対応アクションか数字での許容理由が要る
- 未達は原因を特定してやり方を変える。2週連続の未達はルールか ADR で対処する。「気をつける」は対策として認めない
- ルールは最も狭い層に置き、4週間効果が確認できなければ廃止を提案する

守られているかは、レポートの「対応アクションなしの悪化指標」「連続未達」「指標・目標値なしのアクション」の件数で確認する。

## Outer Loop

kobun 全体の運用を、毎日見直す仕組み。直近 24 時間のエージェントの動き (`agent_turns`: チーフ・PjM・各ロールの発言の記録。旧来のセッションの `checkpoints` があれば件数も) を集計し、レポートを残す。

- 数字 (発言数・失敗の種類・ロール別の所要時間・経路違反・繰り返された依頼・ユーザーの入力) はコードが集計する。LLM は、その数字を根拠にした解釈と改善案だけを書く (実装は `worker/src/outer-loop.ts`)。LLM が失敗しても、数字のレポートは残る
- 記録が無い日は、LLM を呼ばずに「記録なし」と書く
- レポートは、サンドボックスの `reports/outer-loop-<日付>.md` に書かれる。日付は日本時間。同じ日に2回動かすと上書きされる
- 記録がある日は、要点 (数字) がユーザーのフィードにも届く (失敗があれば alert)
- **kobun 共通ルールの提案**: 分析の中で、全プロジェクトの全ロールに効くと判断されたルールの追加・置換・廃止は、**承認待ち**に載る (1回 3 件まで)。クライアント・プロジェクトの層の提案は捨てる。承認するまでルールは変わらず、承認の依頼がフィードに届く。同じ提案は重ならず、却下したものや、すでに有効な同文のルールは、もう出ない
- ハーネスやプロンプトの改善案は、コードの変更なので、レポートに書かれるだけ (人が直す)

### 定期実行する

日次の Temporal Schedule (`outer-loop-daily`、毎日 03:00 Asia/Tokyo) に登録する。スタックを起動したあと、一度だけ実行すればよい。

```sh
docker compose up --build -d
docker compose exec worker npm run schedule -- outer-loop-daily   # Outer Loop だけを登録する
# 引数なしなら、Outer Loop と巡回 (毎時) をまとめて登録する
docker compose exec worker npm run schedule
```

- 何度実行してもよい (登録済みなら `schedule already registered` と出る)
- 登録の確認・一時停止・再開・時刻の確認は、Temporal UI (http://localhost:8080) の Schedules から行える。時刻を変えるときは `worker/src/register-schedule.ts` の `cron` を直し、UI で `outer-loop-daily` を削除してから登録し直す
- 動くのは worker が起動している間。コードを変えたあとは、`docker compose up --build -d` で作り直す

### 手動で実行する

LLM を1回呼ぶ (記録が無い日は呼ばない)。レポートができるまで応答は返らず、数分かかることがある。

```sh
curl -X POST localhost:3000/outer-loop/run
# => {"reportPath":"reports/outer-loop-2026-11-19.md"}
```

Temporal UI の Schedules で `outer-loop-daily` を開き、Trigger でも起動できる (定期実行と同じ経路を通る)。

### 結果を見る

```sh
# レポート (日付は日本時間)
docker compose exec sandbox cat /workspace/reports/outer-loop-<YYYY-MM-DD>.md
# フィード (要点と、ルール変更の承認依頼)。対話コマンドなら /history
curl localhost:3000/feed
# 承認待ちの共通ルール。対話コマンドなら /proposals、/approve <番号>、/reject <番号>
curl localhost:3000/rule-proposals
```

実行の履歴は、Temporal UI の Workflows で `outerLoopWorkflow` を探す (定期実行は `outer-loop-<日時>`、手動実行は `outer-loop-manual-<時刻>`)。

## リポジトリ・データソース・シークレット

プロジェクト毎に、リポジトリ (複数) とデータソース (複数) を登録する。エージェントに見えるのは名前・種類・説明・状態だけで、調査のときは `<fetch source="名前"/>` で数字を取り寄せる。

```sh
curl -X PUT localhost:3000/projects/<slug>/repositories/api -H 'content-type: application/json' -d '{"url":"https://github.com/owner/repo","description":"API サーバー"}'
curl -X PUT localhost:3000/projects/<slug>/connections/ci -H 'content-type: application/json' -d '{"kind":"github","config":{"token":"{{secret:GITHUB_TOKEN}}"}}'
curl -X PUT localhost:3000/projects/<slug>/connections/product-db -H 'content-type: application/json' -d '{"kind":"postgres","description":"本番 DB (読み取り専用)","config":{"url":"postgres://reader:{{secret:DB_PASSWORD}}@host:5432/app"}}'
curl -X PUT localhost:3000/projects/<slug>/connections/quality -H 'content-type: application/json' -d '{"kind":"command","config":{"commands":{"coverage_pct":{"cmd":"...","unit":"%"}}}}'
# 一覧と削除 (connections も同じ形)
curl localhost:3000/projects/<slug>/repositories
curl -X DELETE localhost:3000/projects/<slug>/repositories/api
```

データソースの種類は `github` / `postgres` / `aws` / `command` / `http-json` (定義は `worker/src/metrics/collectors.ts`)。

### エージェントにコードを読ませる

`.env` の `REPOS_DIR` に、リポジトリの親ディレクトリ (ホストの絶対パス) を指定して起動し直す。サンドボックスの `/repos` に**読み取り専用**でマウントされ、その下にあるパスで登録したリポジトリをエージェントが読めるようになる。

```sh
# .env
REPOS_DIR=/Users/you/work/client-a
```

```
/repo <slug> backend /Users/you/work/client-a/backend-repo    # 対話コマンドで登録
```

エージェントは一覧 (`<repo-list>`)・検索 (`<repo-grep>`)・読み取り (`<repo-read>`) を要求し、結果を受け取ってから続きを書く (1ターンに最大8往復、1回の読み取りは 400 行まで)。

- リポジトリの外、`/repos` の外、外を指すシンボリックリンクは読めない
- 資格情報を含みうるファイルは読み取りを拒否し、一覧と検索にも出さない: `.env*` (`.env.example` などの見本は除く)、秘密鍵 (`*.pem`、`*.key`、`id_rsa*` など)、`.git/`、`.ssh/`、`.aws/`、`.npmrc`、`credentials*`、`secrets*`、`*.tfstate`、`*.tfvars` (定義は `sandbox/repo-access.mjs`)
- 読んだ内容は次のターンに残らないので、エージェントは分かったことを成果物 (`<artifact>`) に書き残す

**API キーなどの値は、クレデンシャルブローカー (`broker`, `localhost:3100`) に直接渡す。** 設定には `{{secret:名前}}` とだけ書く。

```sh
curl -X PUT localhost:3100/secrets/<slug>/GITHUB_TOKEN -H 'content-type: application/json' -d '{"value":"ghp_..."}'
curl localhost:3100/secrets/<slug>     # 名前と更新日時だけが返る
curl -X DELETE localhost:3100/secrets/<slug>/GITHUB_TOKEN
```

- ブローカーに値を返す API は無い。保存値は、ブローカーのコンテナだけがマウントするボリューム (`broker-data`) の鍵 (または `BROKER_KEY`) で暗号化される
- データ取得はブローカーが実行し、worker (エージェント) には数字だけを返す。worker・api・サンドボックスはシークレットの値を持たない
- 設定に資格情報の値が直接書かれていると、api は登録を拒否する (`token` / `secret` / `password` / `authorization` / `api key` / `cookie` というキーの値と、パスワード入りの URL)
- `command` のデータソースはサンドボックスで実行されるため、`{{secret:名前}}` を書いた設定は登録を拒否する (値がサンドボックスに渡らないように)
- ブローカーに認証は無い。同じ Docker ネットワークにいるコンテナ (サンドボックスを含む) からは、シークレットの上書きと取得の実行ができる (値の読み出しはできない)
- シークレット未登録・認証切れ (セッション切れ) を検知すると、状態が変わったときに1回、ブローカーへの登録依頼がフィードに届く
- ブローカーのポートは `127.0.0.1` にだけ公開される。番号は `.env` の `BROKER_PORT` で変えられる

### インフラチェック

毎日 08:00 JST (Schedule `infra-daily-<slug>`) に `infraCheckWorkflow` が `aws` と `postgres` のデータソースを取得する。コストが直近平均より 20% を超えて増えた場合、その他の指標が標準偏差の3倍を超えて外れた場合は、ユーザーにアラートを送り、インフラエンジニアに原因の切り分けを依頼する。新しく見つかった遅いクエリは、エンジニア (リード) に修正を依頼する。

```sh
curl -X POST localhost:3000/projects/<slug>/infra-check/run
```

## テスト

```sh
cd worker && npx vitest run --exclude test/conformance.test.ts
```

DB も LLM も不要 (84 件)。

| ファイル | 確かめること |
| --- | --- |
| `org.test.ts` | 出力タグの解釈、会話経路、指標の判定、改善レポートの組み立て、シークレットの扱い |
| `org-workflow.test.ts` | Temporal のテストサーバーで、チーフ → PjM → チームの会話経路と差し戻しを通しで |
| `followup.test.ts` | 期限の解釈と、期限切れの段階の上げ方 |
| `followup-workflow.test.ts` | Temporal のテストサーバーで、巡回の配送と、保留からの再開 |
| `board.test.ts` | ボードの表示 |
| `outer-loop.test.ts` | Outer Loop の集計 (失敗の分類、経路違反の扱い、繰り返しの検出、記録なしの日、LLM 失敗時のレポート) |
| `repo.test.ts` | リポジトリ読み取りの範囲と拒否リスト |
| `line-editor.test.ts` | 対話コマンドの入力欄 (貼り付け、Shift+Enter、全角文字の幅) |

環境変数を渡したときだけ動くテストが2つある (渡さなければスキップ)。`replay.test.ts` は、動いている会話の履歴をいまのコードで再生する (上記「エージェント組織」)。`followup-db.test.ts` は下記。

期限・巡回・保留の SQL と、古い DB からの移行は、空の使い捨て Postgres で確かめる (動いている kobun の DB には向けない):

```sh
docker run -d --rm --name kobun-followup-test -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55999:5432 postgres:16
cd worker && FOLLOWUP_DB=postgres://postgres:postgres@127.0.0.1:55999/postgres npx vitest run test/followup-db.test.ts
docker stop kobun-followup-test
```

## 制限

- `claude-cli` バックエンドではエージェントはツールを使えない。実装担当も `<artifact>` でファイルを出すだけで、サンドボックスでコマンドを実行しない。ツール付きの実装は `LLM_BACKEND=pi` が前提だが、Pi Durable のハーネスは現状型チェックが通っていない (下記「注意」)
- `aws` と `http-json` のコレクタ、および `github` の正常系は、実アカウントでは未検証
- エージェントが読めるのは、`REPOS_DIR` の下にあるローカルのリポジトリだけ。GitHub の URL で登録したリポジトリは読めない (指標の集計には使われる)
- リポジトリは読み取り専用。エージェントはコードを書き換えられない
- 読んだ内容は LLM に送られる。`.env` などは拒否するが、コードに直接書かれた資格情報までは検出しない
- `LLM_BACKEND=pi` の実装担当と、`bash:` ショートカット、`command` のデータソースはサンドボックスでコマンドを実行できるので、`/repos` の拒否リストを通らずに読める
- サンドボックスからの git 操作は従来どおり egress の `GITHUB_TOKEN` (全体で1つ) を使う。プロジェクト毎のリポジトリ権限の分離は未実装
- 振り返りで PjM が決めたプロジェクトの層のルール変更は、人の承認なしに適用される (レポートで事後に報告される)。承認を挟むのは kobun 共通とクライアントの層だけ
- 承認待ちの提案は、期限 (7 日) を過ぎても自動では適用も却下もされない。チーフの一覧に1回載るだけ
- 却下した提案の蒸し返しは、文面が同じ場合しか止められない (LLM が言い換えると通る)
- 期限の無い仕事は、巡回の対象にならない。エージェントが担当と期限を正しく書くか、催促に応じるかは、LLM を通しては未検証
- 期限の引き直しに回数の上限は無い (理由と履歴は項目の本文に残る)
- 巡回の時間帯 (9〜21 時の毎時) は固定。変えるには `worker/src/register-schedule.ts` を直して登録し直す
- Outer Loop が共通ルールを提案するかは、集計した数字と LLM の判断による。実際の LLM では「提案なし」になることがある。提案が承認待ちに載る経路は、決まった入力でテストしてある
- ルールの「4週間効果がなければ廃止」は行動規範としてエージェントに課しているだけで、自動判定はしていない

## 実装前の grilling と ask-a-person (運用ルール)

実装タスクは、着手前に必ず要件を詰める。セッションへの入力が `impl:` で始まると実装タスクとして扱い、次の流れになる:

1. **grilling**: エージェントが実装依頼から要件確認の質問を生成する (`grillQuestions`)。質問は `GET /sessions/:id/questions` で取得できる
2. **ask-a-person**: エージェントは質問を公開して人の回答を待つ。回答は `POST /sessions/:id/answer` で送る。待ちは Temporal の durable timer なので、Worker が再起動しても期限は保持される
3. **期限は3時間**: 回答がなければ、タスクの状態 (依頼文と質問) を `parked_tasks` テーブルに保存してそのタスクを停止し、セッションは次のタスクの処理に進む。回答があれば、質問と回答で要件を補強したうえで実装に入る
4. **保留からの再開**: 保留したことは、再開の方法つきでフィードに届く。あとから回答すれば、質問をやり直さずに実装から再開する (再開は1回だけ)。期限の後に `POST /sessions/:id/answer` へ送った回答も、そのセッションで最後に保留になったタスクの再開として扱う。不要なら取り下げる

```sh
# 実装タスクを投入
curl -X POST localhost:3000/sessions/<id>/messages -H 'content-type: application/json' -d '{"text":"impl:請求書PDFを生成する機能がほしい"}'
# grilling の質問を見る
curl localhost:3000/sessions/<id>/questions
# 回答する (3時間以内)
curl -X POST localhost:3000/sessions/<id>/answer -H 'content-type: application/json' -d '{"text":"対象は月次請求。完了条件は…"}'
# 保留になったタスクの一覧・再開・取り下げ
curl localhost:3000/parked
curl -X POST localhost:3000/parked/<番号>/answer -H 'content-type: application/json' -d '{"text":"対象は月次請求。完了条件は…"}'
curl -X POST localhost:3000/parked/<番号>/drop -H 'content-type: application/json' -d '{"reason":"不要になった"}'
```

## LLM 認証 (バックエンド別の要件)

LLM バックエンドは `.env` の `LLM_BACKEND` で切り替える。資格情報の要件はバックエンドごとに決まっている:

- **`claude-cli`** (既定): 公式 Claude Code を `claude -p --output-format json` で呼ぶ。**`CLAUDE_CODE_OAUTH_TOKEN` か `ANTHROPIC_API_KEY` のどちらかが必要**。
  - `CLAUDE_CODE_OAUTH_TOKEN` は Mac 上で `claude setup-token` を実行して発行する (ブラウザ認証。トークンは端末に表示されるだけで保存されず、有効期限は1年)。Claude Max のサブスクリプションとして認証される
  - `ANTHROPIC_API_KEY` を使う場合は API 課金になる。両方設定されている場合の優先順位は Claude Code 側の仕様に従う (Max 枠で使いたい場合は `ANTHROPIC_API_KEY` を空にする)
  - worker コンテナには Claude Code CLI を同梱してある
- **`pi`**: Pi Durable のエージェントループ (ツール実行つき)。**`ANTHROPIC_API_KEY` が必須** (API 課金)。単発のテキスト生成 (grilling の質問生成、Outer Loop の分析) も同じキーで Anthropic API を直接呼ぶ

資格情報が不足している場合、エージェントは黙って失敗せず、どの資格情報が必要かを応答に明示する。

## 動作確認

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

# Outer Loop を手動で1回回す (レポートは sandbox の reports/ に生成。LLM を1回呼ぶ。記録が無い日は呼ばない)
curl -X POST localhost:3000/outer-loop/run

# 耐久性の確認: worker を再起動しても会話が続く
docker compose restart worker
```

CLI からも操作できる:

```sh
docker compose exec worker npm run client -- "こんにちは"
docker compose exec worker npm run client -- "bash:pwd" <sessionId>
```

## 適合性テスト (Pi Durable カスタム実装の検証)

Postgres バックエンドとサンドボックス環境は、Pi 公式の conformance suite で検証できる:

```sh
docker compose exec worker npm test
```

`npm test` は上記「テスト」の分も一緒に走らせる。適合性テスト (`test/conformance.test.ts`、48 件) は現状通らない。`SandboxExecutionEnv` に `writeFile` / `createDir` / `watch` が無いことによる失敗が含まれる。

## egress ポリシーの変更

`egress/addon.py` の `ALLOW` リストを編集する。デフォルトは拒否で、許可を足していく運用が前提。GitHub への書き込みを許す org / ユーザー名は、`.env` の `EGRESS_GITHUB_ORG` で渡す (空なら読み取りだけ)。
GitHub API をサンドボックスから叩く場合は `Authorization: Bearer dummy-placeholder` を付けてリクエストすると、egress が本物のトークンに差し替える。

## 注意: Pi Durable は Experimental

- API は予告なく変わるため、pi-durable / pi-ai / chord は **1.3.0 に固定**してある。上げる際は README と CHANGELOG の確認が必須。
- Postgres ファサードは README の Storage 節のアダプタ契約に基づいて実装したが、SQLite 方言の SQL が Postgres で弾かれる可能性が残る。`npm test` の conformance 結果が正否の基準。
- `SandboxExecutionEnv` のメソッド形状も README の Environment 節に基づく実装で、型定義と完全一致していない箇所がありうる (同じく conformance で検証)。
- Node は pi-durable の要求に合わせて 22 系。
- `worker/src/pi/` は現状 `tsc` が通らない (ESM のみのパッケージを CommonJS から読んでいる、API の型不一致)。`LLM_BACKEND=pi` のときだけ読み込まれるので、`claude-cli` バックエンドには影響しない。
- `claude setup-token` のトークンは1年で期限切れになる。再発行して `.env` を差し替えること。

## 次の一手 (未実装)

- Outer Loop のレポートから改善 PR を自動作成する (サンドボックス + egress の書き込み経路は用意済み)
- セッションごとのサンドボックス払い出し (現状は固定1コンテナ)
- Slack からの起動 (grilling の質問・回答も Slack で完結させる)
- GraphQL 操作単位の egress 制御
- クレデンシャルブローカーの認証 (現状は同じ Docker ネットワークから誰でも呼べる)
- 実装担当がサンドボックスでコードを動かす経路 (Pi Durable のハーネスを直すか、別の実行方法にする)
- プロジェクト毎のリポジトリ権限の分離 (現状は egress の `GITHUB_TOKEN` が全体で1つ)
- GitHub の URL で登録したリポジトリを、エージェントが読めるようにする
