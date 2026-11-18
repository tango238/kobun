# kobun

ローカルで動くソフトウェアファクトリ。ユーザーの窓口は「チーフ」1名で、プロジェクト毎に PjM とチーム (BA・エンジニア・デザイナーなど) が付く。週次の振り返りと日次の Outer Loop で、運用を数字で改善し続ける。

## 構成

| 部品 | 役割 |
| --- | --- |
| `temporal` + `temporal-ui` | ワークフロー基盤 (受付・直列化・スケジュール) |
| `worker` | エージェント組織の実行 (Temporal Workflow / Activity)。LLM の呼び出しもここ |
| `api` | REST API (Hono)。対話コマンドもここに接続する |
| `postgres` | 会話・ボード・ルール・指標・Pi のチェックポイントの保存先 |
| `sandbox` | 隔離された実行環境 (成果物の保存、コマンド実行、リポジトリの読み取り、Pi の `ExecutionEnv`) |
| `egress` | サンドボックスの外向き通信の許可リストと、GitHub トークンの付与 (mitmproxy) |
| `broker` | API キーの保管とデータ取得の代行 (クレデンシャルブローカー) |

部品のつながりと、どこまで確かめてあるかは [docs/architecture](docs/architecture/README.md) (ボードと巡回を足す前の時点の内容)。

## はじめかた

```sh
cp .env.example .env              # LLM の資格情報などを設定する (下記「LLM 認証」)
docker compose up --build -d
docker compose exec worker npm run schedule   # Outer Loop (日次) と巡回 (毎時) を登録。何度実行してもよい
cd worker && npm install && npm run chief     # チーフと話す (初回のみ npm install)
```

- Temporal UI: http://localhost:8080 / API: http://localhost:3000 / ブローカー: http://localhost:3100
- コードや `.env` を変えたら `docker compose up --build -d` で作り直す。会話・ボード・ルールは Postgres と Temporal に残るので、続きから動く

`.env` の主な設定:

| 変数 | 用途 |
| --- | --- |
| `LLM_BACKEND` / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | LLM のバックエンドと資格情報 (下記「LLM 認証」) |
| `MODEL_OPUS` / `MODEL_SONNET` | ロール別のモデル |
| `REPOS_DIR` | エージェントに読ませるリポジトリの親ディレクトリ (ホストの絶対パス。下記「リポジトリを読ませる」) |
| `POSTGRES_PORT` / `BROKER_PORT` | ホストに公開するポート (既定 5432 / 3100) |
| `BROKER_KEY` | ブローカーの暗号鍵の元 (空なら自動生成) |
| `GITHUB_TOKEN` | サンドボックスから GitHub を触るとき、egress が付与するトークン |
| `EGRESS_GITHUB_ORG` | サンドボックスから GitHub への書き込みを許す org / ユーザー名 (空なら読み取りだけ) |

## コマンド

### 対話コマンド (`npm run chief` の中)

`/` で始まらない入力はチーフへのメッセージになる。**Enter** で送信、**Shift+Enter** で改行 (区別できない端末では Alt/Option+Enter か Ctrl+J)。貼り付けた文章は、改行を含んでいても送信されない。`[slug]` は、プロジェクトが1つだけなら省略できる。

| コマンド | 内容 |
| --- | --- |
| `/help` | コマンドの一覧 |
| `/projects` | プロジェクトの一覧 |
| `/team [slug]` | メンバーと、いま何をしているか (対応中のロール、順番待ち、各ロールの最後の依頼と結果) |
| `/board [slug]` | ボードを見る |
| `/note <slug> <内容>` | ボードに情報を書く (チーム全員が次の発言から読む) |
| `/done <slug> <B-番号> [理由]` | ボードの質問・やることを解決済みにして下ろす |
| `/repos <slug>` | 登録されたリポジトリの一覧 |
| `/repo <slug> <名前> <URL かパス> [説明]` | リポジトリを登録する (同じ名前は上書き) |
| `/pending` | 判断待ちの一覧 (期限切れの仕事・保留中の実装タスク・承認待ちのルール変更) |
| `/patrol` | 巡回を今すぐ1回回す |
| `/parked` / `/resume <番号> <回答>` / `/drop <番号> [理由]` | 保留中の実装タスクの一覧 / 再開 / 取り下げ |
| `/proposals` / `/approve <番号>` / `/reject <番号>` | 承認待ちのルール変更の一覧 / 承認 / 却下 |
| `/history` | これまでにフィードへ届いたものを全部表示する |
| `/quit` (`/exit`) | 終了する |

### 実行コマンド (`worker/` で `npm run <名前>`)

Docker 上では `docker compose exec worker npm run <名前>` (`chief` だけはホストで実行)。

| コマンド | 内容 |
| --- | --- |
| `chief` | 対話コマンド (接続先は `KOBUN_API`、既定 `http://localhost:3000`) |
| `schedule [-- <ID>]` | Temporal Schedule を登録する。ID は `outer-loop-daily` (毎日 03:00) と `chief-patrol` (9〜21 時の毎時)。省くと両方 |
| `client -- "<メッセージ>" [sessionId]` | 旧来のセッションに発言する簡易クライアント |
| `test` | テストを実行する (Pi の適合性テストを含む。下記「テスト」) |

### API の早見表 (`localhost:3000`)

| 用途 | エンドポイント |
| --- | --- |
| チーフ | `POST /chief/messages` `{"text"}` / `GET /chief` (会話履歴) / `GET /feed` (ユーザーに届いたもの全部) |
| プロジェクト | `GET /projects` / `GET /clients` / `GET /projects/:slug` / `GET /projects/:slug/team` |
| ボード | `GET`・`POST /projects/:slug/board` / `POST /projects/:slug/board/:B-番号/resolve` |
| ルール | `GET`・`POST /projects/:slug/rules` / `GET /rule-proposals` / `POST /rule-proposals/:番号/approve`・`reject` |
| リポジトリ・データソース | `GET /projects/:slug/repositories`・`connections`、`PUT`・`DELETE` は末尾に `/:名前` |
| 指標 | `GET /metrics/catalog` / `GET /projects/:slug/metrics` / `POST /projects/:slug/feedback` `{"score":1〜5,"comment"}` |
| 手動実行 | `POST /projects/:slug/retro/run` / `POST /projects/:slug/infra-check/run` / `POST /patrol/run` / `POST /outer-loop/run` |
| 判断待ち | `GET /pending` / `GET /parked` / `POST /parked/:番号/answer`・`drop` |
| 旧来のセッション | `POST /sessions` / `POST /sessions/:id/messages` / `GET /sessions/:id`・`/questions` / `POST /sessions/:id/answer` |

## エージェント組織

プロジェクト毎に PjM が1名付く。ユーザーと話せるのはチーフだけ。

| ロール | モデル | 役割 | 話せる相手 |
| --- | --- | --- | --- |
| チーフ `chief` | Opus | 全体で1名。ユーザーと会話してプロジェクトを立ち上げ、PjM を束ねる | ユーザー、PjM |
| PjM `pjm` | Opus | 要件をまとめ、仕様書と UX 設計をレビューする | チーフ、BA、エンジニア(リード)、デザイナー |
| BA `business-analyst` | Opus | 目的・背景・アウトカムを詰める。運用でカバーすることとシステム化することを分ける | PjM |
| エンジニア(リード) `engineer-lead` | Opus | 仕様書とアーキテクチャ。コード品質の指標に責任を持つ | PjM、実装、デザイナー、インフラ |
| エンジニア(実装) `engineer-impl` | Sonnet | 実装とテスト | リード |
| デザイナー `designer` | Opus | UX 設計。UI の理由をエンジニアに説明する | PjM、リード、UX アナリスト |
| UX アナリスト `ux-analyst` | Sonnet | 迷い・離脱の計測 | デザイナー |
| インフラエンジニア `infra-engineer` | Sonnet | 性能とコストの監視、遅いクエリの報告、コスト削減提案 | リード |

- 定義は `worker/src/agents/roles.ts`。表に無い宛先へのメッセージは配送されず、送り主に差し戻される (回数は指標になる)
- 自分の番が来たロールは、たまっている自分宛のメッセージを全部まとめて受け取り、1回の発言で答える。別々のロールは同時に動く (最大 3 ロール)
- 1通の外部メッセージから回せるのは 24 回の発言まで。超えたら打ち切り、破棄した件数をユーザーに通知する
- クライアントは複数いるため、**クライアント未指定のプロジェクトは作成されない** (チーフがユーザーに確認する)
- エージェントの出力はタグ形式 (`worker/src/agents/protocol.ts`)。成果物は `<artifact>` でサンドボックスの `projects/<slug>/` に保存される
- Workflow のコードを変えたら、動いている会話の履歴を新しいコードで再生して確かめる: `cd worker && REPLAY_TEMPORAL=localhost:7233 npx vitest run test/replay.test.ts`

### ボード

プロジェクト毎の共有の掲示板。チーム全員が**毎回の発言の前に読む**ので、行き違いと聞き直しが減る。チーフには全プロジェクトのボードが見える。

| 欄 | 中身 |
| --- | --- |
| 共有された情報 | ユーザーから得た事実・前提・資料の場所 |
| 決定事項 | 決まったことと、誰が決めたか |
| 未解決の質問 / やること | 回答・仕事を待っていること。**担当と期限を持つ** |
| メンバーの状況 | 対応中か待機か、直前の動き (自動)、本人のメモ (いま / 次 / 待ち) |
| 直近の動き | 誰が誰の依頼で何を送り、どの成果物を更新したか (自動) |

解決済みの項目はボードから下りるが、DB (`board` テーブル) には残る。

### 期限と巡回

質問とやることの担当は、ロールか `user`。期限は `36h` / `3d` / `2026-11-21` の形で、省くと質問は 2 日、やることは 7 日 (`worker/src/followup.ts`)。期限の引き直しには理由が要る。

巡回 (`patrolWorkflow`、9〜21 時の毎時 0 分) が、期限を過ぎた項目の段階をコードで1つずつ上げる (LLM は関わらない)。

| 段階 | いつ | 何が起きるか |
| --- | --- | --- |
| 1 | 期限を過ぎた | 担当ロールに催促が届く |
| 2 | 段階 1 から 24 時間 | PjM に上がり、チーフの「判断待ちの一覧」に載る |
| 3 | 段階 2 から 24 時間 | ユーザーのフィードに出る (以後は通知しない) |

担当が `user` の項目は、期限切れで直接フィードに出る。

### 行動ルール (3層)

| 層 | 範囲 | ID |
| --- | --- | --- |
| kobun 共通 | すべてのプロジェクト | `K-n` |
| クライアント | そのクライアントの全プロジェクト | `C-n` |
| プロジェクト | そのプロジェクトだけ | `P-n` |

矛盾したら **プロジェクト > クライアント > kobun 共通** の順に優先する。全ロールのプロンプトに毎回入り、振り返りと Outer Loop で追加・置換・廃止される。

- **プロジェクト層**: その場で適用される
- **共通・クライアント層**: 他のプロジェクトにも効くので、**ユーザーが承認するまで適用されない**。承認の依頼がフィードに届く。期限は 7 日で、過ぎても自動では決まらない (チーフの一覧に1回載る)。同じ提案は重ならず、却下した提案は同じ文面では二度と出ない
- ユーザーが API で直接変更するときは承認不要

## 振り返りと改善

各プロジェクトで毎週月曜 09:00 (JST、Schedule `retro-weekly-<slug>`) に `retroWorkflow` が走る。

1. データソースから数字を取得する
2. 各ロールが、数字を根拠に担当領域の改善を提案する
3. PjM が、今週のアクションと、ルールの追加・置換・廃止、ADR を決める
4. 改善レポートをユーザーに送り、PjM に実行を指示する。結果は翌週の数字で自動判定される

改善レポートは LLM に書かせず、数字からコードが組み立てる (`worker/src/metrics/report.ts`)。必ず載るもの: 指標の前週比、前週アクションの達成/未達と連続未達回数、5% を超えて悪化した指標と対応の有無、指標や目標値のないアクションの件数、ルールの変更、取得できなかった数字と必要な対応。手動実行は `POST /projects/<slug>/retro/run`。

必要な指標と取得方法 (定義は `worker/src/metrics/catalog.ts`。取れていない指標は「未計測」と取得方法つきで出る):

| 担当 | 指標 | 取得元 |
| --- | --- | --- |
| エンジニア | 重複率・複雑度・カバレッジ | `command` (サンドボックスでコマンドを実行し、最後の行の数値を読む) |
| エンジニア | 不具合発生率・CI 実行時間・CI 失敗率 | `github` (登録したリポジトリを集計) |
| UX アナリスト | 離脱率・所要時間・エラー率 | `http-json` (分析 API の応答から取り出す) |
| BA | アウトカム適合スコア・フィードバック件数 | ユーザーのフィードバック (`POST /projects/<slug>/feedback`) |
| BA | 運用でカバーした件数など | `http-json` |
| インフラ | コスト、CloudWatch メトリクス | `aws` (Cost Explorer / CloudWatch) |
| インフラ | 遅いクエリ・キャッシュヒット率・接続数・サイズ | `postgres` (`pg_stat_statements` 推奨) |
| PjM | 改善アクション達成率、応答失敗、経路違反、期限切れの仕事・提案 | kobun が自動計測 |

行動規範 (`CODE_OF_CONDUCT` の 12 項目) は共通ルール `K-1`〜`K-12` として初期登録され、以後は他のルールと同じく置換・廃止できる。要点:

- 結果確認 → 悪化した指標 → 原因 → 次のアクション → ルール化、の順に行う
- アクションは担当1ロール・指標1つ・現在値・来週の目標値を持つ。計測できない領域は、まず計測できるようにする
- 5% を超えて悪化した指標は、対応アクションか、数字での許容理由が要る
- 2週連続の未達は、ルールか ADR で対処する。「気をつける」は対策として認めない
- ルールは最も狭い層に置き、4週間効果が確認できなければ廃止を提案する

### インフラチェック

毎日 08:00 (JST、Schedule `infra-daily-<slug>`) に `aws` と `postgres` のデータソースを取得する。コストが直近平均より 20% 超増えた、または他の指標が標準偏差の3倍を超えて外れたら、ユーザーにアラートを送り、インフラエンジニアに切り分けを依頼する。新しい遅いクエリは、リードに修正を依頼する。手動実行は `POST /projects/<slug>/infra-check/run`。

## Outer Loop

kobun 全体の運用を毎日見直す。直近 24 時間のエージェントの動き (`agent_turns`) を集計し、レポートを残す。全プロジェクトを横断するので、対象は kobun 全体 (ハーネス・プロンプト・共通ルール)。プロジェクト毎の改善は週次の振り返りが担う。

- 数字 (発言数・失敗の種類・ロール別の所要時間・経路違反・繰り返された依頼・ユーザーの入力) はコードが集計し、LLM はその数字を根拠にした解釈と改善案だけを書く (`worker/src/outer-loop.ts`)。LLM が失敗しても数字のレポートは残り、記録が無い日は LLM を呼ばない
- 記録がある日は、要点 (数字) がフィードにも届く (失敗があれば alert)
- 共通ルールの追加・置換・廃止の提案は**承認待ち**に載る (1回 3 件まで。共通以外の層は捨てる)。承認するまでルールは変わらない。ハーネスやプロンプトの改善案は、人が直す前提でレポートに書かれるだけ

| やること | 方法 |
| --- | --- |
| 定期実行 | `docker compose exec worker npm run schedule -- outer-loop-daily` (毎日 03:00 JST。何度実行してもよい)。確認・一時停止・時刻の変更は Temporal UI の Schedules (時刻を変えるときは `register-schedule.ts` の `cron` を直し、UI で削除してから登録し直す) |
| 手動実行 | `curl -X POST localhost:3000/outer-loop/run` (LLM を1回呼ぶ。数分かかることがある)。または UI の Schedules で Trigger |
| レポートを見る | `docker compose exec sandbox cat /workspace/reports/outer-loop-<YYYY-MM-DD>.md` (日付は日本時間。同じ日に2回動かすと上書き) |
| 提案を見る・決める | `/history` (要点と承認依頼)、`/proposals`、`/approve <番号>`、`/reject <番号>` |
| 実行の履歴 | Temporal UI の Workflows で `outerLoopWorkflow` (定期実行は `outer-loop-<日時>`、手動実行は `outer-loop-manual-<時刻>`) |

## リポジトリ・データソース・シークレット

プロジェクト毎に、リポジトリとデータソース (数字の取得方法) を複数登録できる。エージェントに見えるのは名前・種類・説明・状態だけで、必要な数字は `<fetch source="名前"/>` で取り寄せる。

```sh
# リポジトリ (対話コマンドの /repo でもよい)
curl -X PUT localhost:3000/projects/<slug>/repositories/api -H 'content-type: application/json' \
  -d '{"url":"https://github.com/owner/repo","description":"API サーバー"}'
# データソース。種類は github / postgres / aws / command / http-json (worker/src/metrics/collectors.ts)
curl -X PUT localhost:3000/projects/<slug>/connections/ci -H 'content-type: application/json' \
  -d '{"kind":"github","config":{"token":"{{secret:GITHUB_TOKEN}}"}}'
```

### リポジトリを読ませる

`.env` の `REPOS_DIR` にリポジトリの親ディレクトリを指定して起動し直す。サンドボックスの `/repos` に**読み取り専用**でマウントされ、その下にあるローカルのパスで登録したリポジトリを、プロジェクトの**全ロール**が読める (ロール毎の設定は無い)。

```sh
# .env
REPOS_DIR=/Users/you/work/client-a
# 対話コマンド
/repo <slug> backend /Users/you/work/client-a/backend-repo
```

- エージェントは一覧 (`<repo-list>`)・検索 (`<repo-grep>`)・読み取り (`<repo-read>`) を要求し、結果を受けて続きを書く (1ターン最大 8 往復、1回 400 行まで)。読んだ内容は次のターンに残らないので、分かったことは成果物に書き残す
- リポジトリの外・`/repos` の外・外を指すシンボリックリンクは読めない
- 資格情報を含みうるファイルは読み取りを拒否し、一覧と検索にも出さない: `.env*` (`.env.example` などの見本は除く)、秘密鍵、`.git/`、`.ssh/`、`.aws/`、`.npmrc`、`credentials*`、`secrets*`、`*.tfstate`、`*.tfvars` (`sandbox/repo-access.mjs`)

### シークレット

API キーなどの値は、**クレデンシャルブローカー (`localhost:3100`) に直接渡す**。設定には `{{secret:名前}}` とだけ書く。

```sh
curl -X PUT localhost:3100/secrets/<slug>/GITHUB_TOKEN -H 'content-type: application/json' -d '{"value":"ghp_..."}'
curl localhost:3100/secrets/<slug>      # 名前と更新日時だけが返る
```

- 値を返す API は無い。保存値は、ブローカーだけがマウントするボリュームの鍵 (または `BROKER_KEY`) で暗号化される
- データ取得はブローカーが実行し、worker (エージェント) には数字だけを返す。worker・api・サンドボックスは値を持たない
- 設定に資格情報の値が直接書かれていると、api は登録を拒否する。`command` のデータソースはサンドボックスで実行されるため、`{{secret:名前}}` を書いた設定も拒否する
- 未登録・認証切れを検知すると、状態が変わったときに1回、登録依頼がフィードに届く
- ブローカーに認証は無い。同じ Docker ネットワークのコンテナ (サンドボックスを含む) から、シークレットの上書きと取得の実行ができる (値の読み出しはできない)。ポートは `127.0.0.1` にだけ公開される

## 実装タスクの grilling と ask-a-person

旧来のセッションで、入力が `impl:` で始まると実装タスクとして扱い、着手前に必ず要件を詰める。

1. エージェントが要件確認の質問を作る (`GET /sessions/:id/questions`)
2. 人の回答を最大 **3 時間**待つ (`POST /sessions/:id/answer`。待ちは Temporal の durable timer なので、Worker を再起動しても期限は保持される)
3. 回答がなければ、状態を保存してそのタスクを停止し、次のタスクへ進む。回答があれば、質問と回答で要件を補強して実装に入る
4. 保留したタスクは、あとから回答すれば質問をやり直さずに実装から再開できる (1回だけ。`/parked`、`/resume`、`/drop`)

## LLM 認証

`.env` の `LLM_BACKEND` で切り替える。資格情報が不足していると、エージェントは黙って失敗せず、必要な資格情報を応答に明示する。

- **`claude-cli`** (既定): 公式 Claude Code を `claude -p` で呼ぶ (worker に同梱)。`CLAUDE_CODE_OAUTH_TOKEN` か `ANTHROPIC_API_KEY` のどちらかが必要
  - `CLAUDE_CODE_OAUTH_TOKEN` は Mac で `claude setup-token` を実行して発行する (Claude Max として認証。有効期限は 1 年なので、切れたら再発行して `.env` を差し替える)
  - `ANTHROPIC_API_KEY` は API 課金。両方あるときの優先順位は Claude Code の仕様に従う (Max 枠で使うなら空にする)
- **`pi`**: Pi Durable のエージェントループ (ツール実行つき)。`ANTHROPIC_API_KEY` が必須 (API 課金)。単発の生成 (grilling、Outer Loop の分析) も同じキーで Anthropic API を呼ぶ

## テスト

```sh
cd worker && npx vitest run --exclude test/conformance.test.ts   # DB も LLM も不要 (89 件)
```

| ファイル | 確かめること |
| --- | --- |
| `org.test.ts` | 出力タグの解釈、会話経路、指標の判定、改善レポート、シークレットの扱い |
| `org-workflow.test.ts` / `followup-workflow.test.ts` | Temporal のテストサーバーで、会話経路・差し戻し・巡回・保留からの再開を通しで |
| `followup.test.ts` / `board.test.ts` / `outer-loop.test.ts` | 期限と段階の上げ方 / ボードの表示 / Outer Loop の集計とルール提案 |
| `repo.test.ts` / `line-editor.test.ts` | リポジトリ読み取りの範囲と拒否リスト / 対話コマンドの入力欄 |

環境変数を渡したときだけ動くテスト (渡さなければスキップ):

- `replay.test.ts`: `REPLAY_TEMPORAL=localhost:7233`。動いている会話の履歴を新しいコードで再生する
- `followup-db.test.ts`: `FOLLOWUP_DB=<使い捨て Postgres の URL>`。期限・巡回・保留の SQL と、古い DB からの移行を確かめる。動いている kobun の DB には向けない

  ```sh
  docker run -d --rm --name kobun-followup-test -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55999:5432 postgres:16
  cd worker && FOLLOWUP_DB=postgres://postgres:postgres@127.0.0.1:55999/postgres npx vitest run test/followup-db.test.ts
  docker stop kobun-followup-test
  ```

### Pi の適合性テスト

Postgres バックエンドとサンドボックス環境を、Pi 公式の conformance suite (`test/conformance.test.ts`) で検証する。Postgres・サンドボックス・egress を起動した状態で、worker のコンテナの中から実行する:

```sh
docker compose exec worker npx vitest run test/conformance.test.ts
```

- **Postgres バックエンド** (24 件): 通る。Pi が流す SQLite 方言の SQL は、`worker/src/pi/postgres-database.ts` が Postgres 向けに書き換える
- **サンドボックス環境** (24 件): 通る。サンドボックスの中で Pi の `NodeExecutionEnv` を動かし (`sandbox/env-rpc.mjs`)、worker の `SandboxExecutionEnv` (`worker/src/pi/sandbox-env.ts`) が HTTP で中継する。ファイル操作・コマンド実行・ファイル監視の意味は Pi の実装そのもの。`exec` と `watch` は NDJSON で流し、中断は別の呼び出しで伝える

## 制限

- `claude-cli` ではエージェントはツールを使えず、実装担当も `<artifact>` でファイルを出すだけで、コマンドを実行しない。ツール付きの実装は `LLM_BACKEND=pi` が前提だが、Pi のハーネスは現状 `tsc` が通らない (ESM のみのパッケージの読み込みと、API の型不一致)。`worker/src/pi/` は `pi` のときだけ読み込まれる
- Pi Durable は Experimental。API は予告なく変わるため、pi-durable / pi-ai / chord は **1.3.0 に固定**してある (Node は 22 系)
- `aws` と `http-json` のコレクタ、`github` の正常系は、実アカウントでは未検証
- エージェントが読めるのは、`REPOS_DIR` の下のローカルのリポジトリだけ (GitHub の URL で登録したものは、指標の集計にだけ使われる)。読み取り専用で、書き換えられない。読んだ内容は LLM に送られ、コードに直接書かれた資格情報までは検出しない
- `LLM_BACKEND=pi` の実装担当、`bash:` ショートカット、`command` のデータソースはサンドボックスでコマンドを実行できるので、`/repos` の拒否リストを通らずに読める。`REPOS_DIR` に広いディレクトリを指定すると、その範囲が届く
- サンドボックスからの git 操作は egress の `GITHUB_TOKEN` (全体で1つ) を使う。プロジェクト毎のリポジトリ権限の分離は未実装
- 振り返りで PjM が決めたプロジェクト層のルール変更は、承認なしに適用される (レポートで事後に報告)
- 却下した提案の蒸し返しは、文面が同じ場合しか止められない。期限の無い仕事は巡回の対象にならない。期限の引き直しに回数の上限は無い。巡回の時間帯は固定 (`register-schedule.ts`)
- 「4週間効果がなければ廃止」は、エージェントに課しているだけで自動判定していない
- Outer Loop が共通ルールを提案するかは、数字と LLM の判断による (実際の LLM では「提案なし」になることがある)。提案が承認待ちに載る経路は、決まった入力でテストしてある

## 未実装

- Outer Loop のレポートからの改善 PR の自動作成 (サンドボックス + egress の書き込み経路は用意済み)
- 実装担当がサンドボックスでコードを動かす経路 (Pi のハーネスを直すか、別の実行方法にする)
- クレデンシャルブローカーの認証
- プロジェクト毎のリポジトリ権限の分離
- GitHub の URL で登録したリポジトリの読み取り
- セッションごとのサンドボックス払い出し (現状は固定1コンテナ)
- Slack からの起動 (grilling の質問・回答も Slack で完結させる)
- GraphQL 操作単位の egress 制御
