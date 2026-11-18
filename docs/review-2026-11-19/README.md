# kobun レビュー ― ソフトウェアファクトリーとしての現在地と次の一手

> **想定読者**: kobun の持ち主本人。組織・振り返り・行動ルール・API キーの分離を要望し、実装されたコードはまだ読んでいない前提。
> **省いたもの**: 各ロールの役割の説明、Temporal や Docker の一般的な説明、API の一覧（README にある）。部品の構成は [docs/architecture](../architecture/README.md) にある。
> **所要時間**: 10 分。
> **検証方法**: 初稿はクマ（Muse）がリポジトリを読んで書いた。そのあと Claude（Code セッション）が全項目を実物と照合し、コマンドで再現できるものは `checks.json` に入れた（手順は付録）。各指摘は「確認済み」と「未確認」を分けて書く。
> **初稿から変えた点**: 3 か所を訂正し、4 件を追加した（5 節）。4 節の 3 点は、そのあと実装した。

節の並び: 0 一枚で → 1 良い点 → 2 指摘事項 → 3 決めてほしいこと → 4 実装した 3 点 → 5 初稿との差分 → 付録。

## 0. 一枚で

ソフトウェアファクトリーの標準形（工程）と kobun の対応。

| 工程 | kobun の実現 | 状態 |
| --- | --- | --- |
| ① 受付・要件定義 | grilling と ask-a-person（3 時間で保留、後から再開できる） | 動く形がある |
| ② 計画・分解 | チーフ → PjM → 8 ロール、ボード共有、担当と期限、巡回 | 動く形がある（巡回は未反映。4 節） |
| ③ 隔離環境で実装 | sandbox と、Pi Durable か `claude -p` | **未接続**（2-1） |
| ④ テスト・検証ゲート | kobun 自身のテストはある | 対象リポジトリ向けは無い |
| ⑤ レビュー・PR | — | 未実装 |
| ⑥ マージ・出荷 | — | 未実装 |
| ⑦ 計測・振り返り | 週次の振り返り、27 指標、コードが組むレポート | 動く形がある |
| 基盤（耐久性） | Entity Workflow、Continue-As-New、`patched` による版管理 | 強い |
| 基盤（権限分離） | egress のデフォルト拒否、broker への秘密の集約 | 設計は強い。認証が無い（2-2、2-3） |

**総評: ①②⑦と基盤は標準形を押さえている。③④⑤が、まだ線で繋がっていない。**

指摘事項の一覧（優先順）。

| 番号 | 指摘 | 確認 | 対応の重さ |
| --- | --- | --- | --- |
| 2-1 | 生産ライン後段が未接続 | 確認済み | 大（設計の判断が要る） |
| 2-2 | broker と sandbox デーモンに認証が無い | 確認済み | 中 |
| 2-3 | api・Postgres・Temporal がホストの全インターフェースに公開されている | 設定と待ち受けは確認済み。LAN から届くかは未確認 | 小（compose の 4 行） |
| 2-4 | git の衛生（未コミットが多い、CI が無い） | 確認済み | 小。ただしコミットは持ち主の判断 |
| 2-5 | LLM の費用に上限も計測も無い | 確認済み | 中 |
| 2-6 | バックアップが無い（鍵を失うと復号できない） | 確認済み | 小 |
| 2-7 | egress の読み取りは自 org に限定されていない | コードは確認済み。実通信は未確認 | 小 |
| 2-8 | モデル ID の既定値 | **問題なし**（実在する ID）。呼び出しは未確認 | — |

## 1. 確認できた良い点

7 点とも実物で確認した。

| 良い点 | 根拠 |
| --- | --- |
| Entity Workflow と版管理 | `patched` が 2 か所にある（下の出力） |
| 暴走防止が構造にある | ターン上限 24、差し戻し上限 3、同時実行 3、`combineEnvelopes` によるまとめ処理 |
| データソースの秘密の分離 | `broker.ts` は AES-256-GCM で保存し、値を返す経路が無い。ホストへは `127.0.0.1` だけに公開 |
| repo 読み取りの防御 | `sandbox/repo-access.mjs` が `..` とリンクを解決してから範囲を確かめ、資格情報らしいファイルを拒否する。`repo.test.ts` に 7 件 |
| レポートを LLM に書かせない | `metrics/report.ts` に LLM の呼び出しが無い |
| テストが要所にある | LLM も DB も要らない 7 ファイル 71 件が通る（下の出力。うち 2 ファイル 25 件は 4 節の実装で足した） |
| 未検証を隠さない | README の「制限」と docs/architecture の 5 節 |

<!-- output: limits -->
```
47: export const TURN_BUDGET = 24;
49: const CHIEF_BOUNCE_LIMIT = 3;
53: const MAX_PARALLEL_TURNS = 3;
```

<!-- output: offline-tests -->
```
Test Files  7 passed (7)
Tests  71 passed (71)
```

2 点、範囲に注意が要る。

- 「秘密を持たない」のはデータソースの API キーについてである。LLM の資格情報は worker に、GitHub のトークンは egress にある。
- `conformance.test.ts`（Pi Durable の適合性）は実行していない。`replay.test.ts` は 4 節の実装のあとに実行した（付録）。

## 2. 指摘事項（優先順）

### 2-1. 生産ライン後段が未接続

| | 内容 |
| --- | --- |
| 確認済み | 対象リポジトリは読み取り専用でマウントされる（compose の `/repos:ro`） |
| 確認済み | エージェントが書けるのは sandbox の `projects/<slug>/` だけ（`org-activities.ts:66`） |
| 確認済み | 実装担当にツールを渡す経路は `LLM_BACKEND=pi` のときだけ通る（`org-activities.ts:582`） |
| 確認済み | 型チェックが落ちるのは `src/pi/harness.ts` の 1 ファイルだけ（下の出力） |
| 未確認 | 型を直したあと、Pi Durable が実際に動くか。conformance は実行していない |

<!-- output: typecheck -->
```
7 src/pi/harness.ts
```

7 件の内訳は、モジュールが見つからないエラーが 5 件、引数の型の不一致が 2 件である。`postgres-database.ts` と `sandbox-env.ts` は通っている。**README の「`worker/src/pi/` は tsc が通らない」より範囲は狭い。**

既定の `claude-cli` で実装担当がツールを使わないのは、依頼であって強制ではない。ツールを止めるフラグは渡しておらず、プロンプトで頼んでいるだけである。

<!-- source: ../../worker/src/llm.ts -->
```ts
  args.push(
    'Answer the latest user request in the transcript provided on stdin. ' +
      'Do not call tools. Respond with text only, in the language of the latest user message.',
  );
```

`claude -p` は worker のコンテナの中で、worker の環境変数（LLM の資格情報を含む）を引き継いで動く。モデルが指示に従わなければ、worker の中でツールが動く。

提案: 次の一手として最優先。道は 2 つある。

- `harness.ts` の 7 件を直す。モジュールの 5 件は、README が書いている「ESM のパッケージを CommonJS から読んでいる」ことが原因と見られる。
- 実装担当だけ、sandbox の中でツールを実行できる別の経路を作る。

どちらでも、書き込み先（対象リポジトリの作業用コピーか、ブランチか）を先に決める必要がある。ここが決まると④⑤の置き場所も決まる。

### 2-2. broker と sandbox デーモンに認証が無い

<!-- output: no-auth -->
```
worker/src/broker.ts: 0
worker/src/server.ts: 0
sandbox/server.mjs: 0
```

認証に関わる語は、3 つのサーバーのどこにも無い。

`sandbox-net` にいるのは worker、broker、sandbox、egress の 4 つである。エージェントの生成コードが走る sandbox から届く相手と、できることは次のとおり。

| 相手 | sandbox からできること | できないこと |
| --- | --- | --- |
| broker | シークレットの上書き・**削除**、名前の一覧、取得の実行（`POST /collect`） | 値の読み出し（経路が無い） |
| sandbox デーモン（自分） | `/exec`、`/read`、`/write` | — |
| api、Postgres、Temporal | — | 届かない（`sandbox-net` にいない） |

| | 内容 |
| --- | --- |
| 確認済み | 上の表（compose のネットワーク定義と、各サーバーのコード） |
| 確認済み | sandbox デーモンの `/read` と `/write` は、パスが `/workspace` の中かを確かめていない |
| 未確認 | 実際に sandbox のコンテナから broker を叩く試験。今回は Docker を起動していない |

<!-- source: ../../sandbox/server.mjs -->
```js
      } else if (req.url === '/read') {
        const content = await readFile(path.join(WORKSPACE, data.path), 'utf8');
```

`data.path` に `../repos/<リポジトリ>/.env` を渡すと、`repo-access.mjs` の拒否リストを通らずに読める。`/exec` でも同じことができるので新しい穴ではないが、**拒否リストが効くのは `/repo` の経路だけ**である。

提案は、相手ごとに分ける。

- **broker**: 共有トークンを 1 つ入れ、worker と broker とユーザーだけが持つ。sandbox には渡さない。これで sandbox からの上書き・削除・取得の実行が止まる。ユーザーが `curl` でシークレットを登録するときにも、トークンが要るようになる。
- **sandbox デーモン**: トークンを入れても、sandbox の中で走るコードには効かない（同じコンテナにいるため）。効くのは、ほかのコンテナからの呼び出しに対してだけである。優先度は broker より低い。
- あわせて `/read` と `/write` に、`/workspace` の外を拒否する確認を足す。

### 2-3. api・Postgres・Temporal がホストの全インターフェースに公開されている

`127.0.0.1` に絞ってあるのは broker だけである。

| サービス | compose の公開 | 認証 |
| --- | --- | --- |
| broker | `127.0.0.1:3100` | 無し |
| api | `3000:3000` | 無し |
| Postgres | `5432:5432` | パスワード `postgres`（compose に平文） |
| Temporal | `7233:7233` | 無し |
| Temporal UI | `8080:8080` | 無し |

| | 内容 |
| --- | --- |
| 確認済み | 上の表（`docker-compose.yml` と `server.ts`） |
| 確認済み | 動いているコンテナも、4 つとも `0.0.0.0` で待ち受けている（`docker ps`。Postgres は 55432 番） |
| 未確認 | 同じ LAN の別の機械から実際に届くか。ファイアウォールによる |

api に届く人は、チーフへの発言、ルールの変更、承認待ちの提案の承認ができる。Postgres に届く人は、会話の全文と暗号文を読める。Air と mini の 2 台で使うなら、同じ LAN に出ている前提で考えるほうが安全である。

提案: 4 つの公開を broker と同じ `127.0.0.1:` 付きに変える。別の機械から使いたい場合は、そのときに認証を足す。

### 2-4. git の衛生

<!-- output: gitignore -->
```
.env  <-  .gitignore:1:.env
personas  <-  .gitignore:5:personas/
worker/node_modules  <-  .gitignore:2:node_modules/
docs/node_modules  <-  docs/.gitignore:1:node_modules/
docs/architecture/test-results  <-  docs/.gitignore:2:test-results/
docs/architecture/dist/index.open.html  <-  docs/.gitignore:5:*.open.html
docs/architecture/dist/index.html  <-  (除外されていない)
.env  <-  (コミットされた履歴なし)
```

| | 内容 |
| --- | --- |
| 確認済み | `.env`、`node_modules`（worker と docs）、`personas/` は除外されている |
| 確認済み | `.env` がコミットされた履歴は無い |
| 確認済み | `test-results`（PNG を含む）は **除外されている**。ルートではなく `docs/.gitignore` にある |
| 確認済み | 除外されていない生成物は `docs/architecture/dist/index.html` の 1 ファイルだけ |
| 確認済み | 未コミットは、変更 15 ファイルと未追跡 26 項目（うち 5 ファイルは 4 節の実装で増えた）。組織・broker・振り返りの実装は、ほぼ全部が未コミット |
| 確認済み | `.github/workflows` は無い。テストを自動で回す仕組みが無い |
| 確認済み | リモートは `origin` の 1 つだけ |
| 未確認 | mini 側のコピーの状態。このレビューが見たのは Air のコピーだけ |

提案。

- 一度コミットし、Air と mini のどちらを正にするか決める。**コミットは実行していない**（持ち主の判断待ち）。
- `dist/index.html` を残すか決める。残すと、資料を作り直すたびに差分が出る。
- CI を足すなら、最初の 1 本は付録の 2 コマンド（型チェックとテスト）で足りる。

### 2-5. LLM の費用に上限も計測も無い

<!-- output: catalog -->
```
指標の数: 27
token / usage を含む行: 0
```

| | 内容 |
| --- | --- |
| 確認済み | 8 ロール中 5 つが Opus（`roles.ts`） |
| 確認済み | 上限はターン数だけ。トークンや金額の指標は無い |
| 確認済み | `claude -p` の JSON 応答からは `result` だけを取り出し、残りは捨てている（`llm.ts` の `callClaudeCli`） |
| 未確認 | 1 回の依頼や 1 回の振り返りで、実際にいくら掛かるか。LLM を動かしていない |

提案: `claude -p --output-format json` の応答には、使用量と金額の欄がある。捨てずに記録し、ロール別・プロジェクト別の指標として振り返りに載せる。そのうえで日次の上限を決める。Anthropic API を直接呼ぶ経路（`callAnthropicApi`）の応答にも使用量がある。

応答の欄の名前は、この環境で実行して確かめていない。実装のときに実際の応答を見て決める。

### 2-6. バックアップ

| ボリューム | 中身 | 失うと |
| --- | --- | --- |
| `broker-data` | 暗号鍵 `broker.key` | 保存済みのシークレットが全部復号できなくなる |
| `pgdata` | 会話、ルール、指標、改善アクション、暗号文、Temporal の状態 | すべて失う |
| `sandbox-workspace` | 成果物（仕様書、ADR、レポート） | 成果物を失う |

| | 内容 |
| --- | --- |
| 確認済み | `.env` の `BROKER_KEY` は空。鍵は自動生成されたファイルで、**`broker-data` の中にしか無い** |
| 確認済み | バックアップの仕組みはリポジトリに無い |
| 確認済み | Postgres のパスワードは compose に平文（`postgres`）。2-3 と合わせて効く |

提案: まず `broker.key` を 1 回、別の場所へ写す。次に `pgdata` と `sandbox-workspace` を定期的に取る。`BROKER_KEY` を自分で決めて控えておく方法もある（切り替えると、登録済みのシークレットは入れ直しになる）。

### 2-7. egress の読み取りは自 org に限定されていない

<!-- source: ../../egress/addon.py -->
```py
    ("api.github.com", {"GET"}, re.compile(r"^/")),
    ("api.github.com", {"POST", "PATCH", "PUT", "DELETE"}, re.compile(rf"^/repos/{ORG}/")),
```

書き込みは自 org（`ORG` はコードに直書き）に限られる。読み取りは `api.github.com` の全パスに、本物のトークンを付けて通る。

| | 内容 |
| --- | --- |
| 確認済み | 上の許可リスト |
| 未確認 | 実際の通信での挙動。egress を起動していない |

sandbox の中のコードは、そのトークンで読めるものを全部読める。トークンの権限を対象リポジトリだけに絞っておくのが、いちばん安い対策である。

### 2-8. モデル ID の既定値は問題なし

初稿は「実在しない ID なら全ロールが失敗する」と懸念した。

| | 内容 |
| --- | --- |
| 確認済み | 既定値は `claude-opus-5-5` と `claude-sonnet-5-5`（compose と `llm.ts:48-49`）。Anthropic の現行モデル（Claude 5 ファミリー）の ID と一致し、typo ではない |
| 確認済み | `.env` に `MODEL_OPUS` と `MODEL_SONNET` が設定されている。実際に使われるのは `.env` の値（値そのものは見ていない） |
| 未確認 | この ID での実際の呼び出し。LLM を動かしていない |

気になる点が 1 つ残る。`pi` バックエンドの既定は `claude-sonnet-4-5` で、1 世代前である。また worker の Dockerfile は Claude Code CLI を版の指定なしで入れるので、ビルドした日によって CLI の版が変わる。

## 3. 決めてほしいこと

1. 実装担当をどう動かすか（2-1）。書き込み先を含めて決める。
2. Air と mini、どちらを正にするか。未コミット分をいつコミットするか（2-4）。
3. broker にトークンを入れるか（2-2）。入れると、シークレットの登録にもトークンが要る。
4. api・Postgres・Temporal の公開を `127.0.0.1` に絞ってよいか（2-3）。別の機械から使う予定があるか。
5. `docs/architecture/dist/index.html` をコミット対象に残すか（2-4）。
6. 4 節の実装をコミットに含めるか。有効にする件は承認済みで、反映した（4-5）。Outer Loop の日次スケジュールを登録するか。

先にやっておくと安全なことが 1 つある。`broker.key` の写しを取ること（2-6）。判断は要らない。

## 4. タスクを積極的に進めるための 3 点 ― 実装した

クマが Muse のアーキテクチャとの比較から出した 3 点である。初稿では未実装の提案だった。持ち主の指示で、2026-11-19 に Claude が 4-2 → 4-3 → 4-1 の順に実装した。**コミットはしていない。** 動いているコンテナには、持ち主の承認を受けて 2026-11-19 に反映した（4-5）。

止まっている仕事を見つけて段階を上げるのは、コードである。LLM（チーフ）を呼ぶのは、判断が要るものを新しく見つけたときだけである。

| 節 | 実現している部品 | 強制 | 確認の状態 |
| --- | --- | --- | --- |
| 4-1 | 質問と「やること」に、担当と期限が必ず付く | コード（省くと既定が入る） | 実物の Postgres で確認 |
| 4-1 | エージェントが守れる期限を書き、終わったら下ろす | プロンプト | **未検証**（LLM を動かしていない） |
| 4-2 | 期限切れを 担当 → PjM → ユーザー と 1 段ずつ上げる | コード | テスト済み。実物の Postgres でも確認 |
| 4-2 | 巡回が催促を配り、チーフに一覧を渡す | コード | Temporal のテストサーバーで確認 |
| 4-2 | チーフが一覧を読んで、PjM かユーザーに振り分ける | プロンプト | **未検証** |
| 4-3 | 保留した実装タスクを、後から届いた回答で再開する | コード | Workflow と DB はテスト済み。API を通した再開は未実施（保留中のタスクが無い） |
| 4-3 | 承認待ちの提案に 7 日の期限。過ぎても自動では決まらない | コード | 実物の Postgres で確認 |
| 4-3 | 却下した提案を、同じ内容で二度と出さない | コード（文面が同じ場合だけ） | 実物の Postgres で確認 |

### 4-1. 仕事への期限と所有者

ボードの「未解決の質問」と、新しく足した「やること」（`task`）が、担当と期限を持つ。

| 項目 | 決まり |
| --- | --- |
| 担当 | プロジェクトのロールか、ユーザー。省くと書いた本人。書いたのがチーフかユーザーなら PjM |
| 期限 | `36h`、`3d`、`2026-11-21` の形。省くと、質問は 2 日、やることは 7 日 |
| 引き直し | `<board-due>` で変えられる。理由が必須で、理由は項目の本文に残る。段階は 0 に戻る |
| 指標 | 期限を過ぎたまま残っている件数（`board_overdue`）が、振り返りの指標に入る |

振り返りの改善アクションは、今までどおり週次の判定のままである。変えていない。

### 4-2. チーフの巡回

![期限切れの段階上げ](figures/escalation.svg)

`patrolWorkflow` が、9〜21 時の毎時 0 分に走る（Temporal Schedule `chief-patrol`）。次は、段階を上げる関数のテストである。

<!-- source: ../../worker/test/followup.test.ts -->
```ts
  it('段階 3: ユーザーに出す。そこから先は何もしない', () => {
    const step = nextEscalation(item({ level: 2, escalatedMs: now - ESCALATION_GRACE_MS }), now)!;
    expect(step).toEqual({ level: 3, user: true });
    expect(nextEscalation(item({ level: 3, escalatedMs: now - 10 * ESCALATION_GRACE_MS }), now)).toBeNull();
  });
```

**同じ項目は、同じ段階で二度と通知されない。** 段階 3 から先は、何日たっても何も出ない。

| 場合 | 動き |
| --- | --- |
| 担当がユーザーの項目 | エージェントを催促せず、期限切れで直接ユーザーのフィードに出す |
| 担当が PjM の項目 | 段階 2 では PjM に同じ催促を繰り返さず、チーフの一覧にだけ載せる |
| 新しい判断待ちが無い回 | LLM を 1 回も呼ばない |
| チーフが停止している | 一覧をそのままユーザーのフィードに届ける |
| 催促を届けられない（プロジェクトの Workflow が停止中） | ユーザーにアラートを出す |

チーフの一覧に載るのは 3 種類である。PjM に上がった期限切れ、保留から 3 日たった実装タスク、承認の期限を過ぎた提案。どれも 1 回しか載らない。

### 4-3. 保留の再開と、承認待ち提案の期限

保留した実装タスクは、保留した時点でユーザーに知らせる（再開の方法つき）。回答が来たら、質問をやり直さずに実装から始める。

| 入口 | 動き |
| --- | --- |
| `/resume <番号> <回答>`、`POST /parked/<番号>/answer` | その番号のタスクを再開する |
| `POST /sessions/<id>/answer` に、期限の後で回答した | そのセッションで最後に保留になったタスクの再開として扱う |
| `/drop <番号>` | 取り下げる。以後、巡回の一覧に載らない |

再開は 1 回だけである。セッションの Workflow が終了していても、同じ ID で起動し直して渡す。

承認待ちの提案は、7 日の期限を持つ。過ぎても適用も却下もされない。同じ提案が承認待ちの間は重ねず、却下された提案は同じ文面では二度と出ない。ユーザーが直接ルールを足すことは、却下の後でもできる。

### 4-4. 実装しなかったこと（提案として残す）

曖昧か、今の材料では大きすぎるものである。

| 残したもの | 理由 |
| --- | --- |
| 期限の無い「止まっている仕事」の検出（メンバーの状況から推測する） | 何をもって止まっているとするかが決まっていない。まず期限つきの項目で運用し、指標（`board_overdue`）を見てから決める |
| 期限が近づいたときの事前の通知 | 通知が増える。期限切れの後の 3 段階だけで足りるかを先に見る |
| 言い換えた提案の蒸し返しの検出 | 文面が同じ場合しか見ていない。LLM が言い換えると通る。意味の比較には LLM が要る |
| 期限の引き直しの回数の上限 | 理由つきなら何度でも延ばせる。延ばした履歴は本文に残るので、まず件数を見る |
| 保留した実装タスクの担当と期限 | セッションの機能で、プロジェクトにもボードにも属していない。組織の側に寄せる設計が先に要る |
| 巡回の時間帯と間隔の設定 | 9〜21 時の毎時で固定した。変えるには `register-schedule.ts` を直す |

費用の注意は残る。巡回そのものは LLM を呼ばないが、催促を受けたロールと、一覧を受けたチーフは 1 回ずつ動く。2-5 の計測はまだ無い。

### 4-5. 有効にした（2026-11-19）

持ち主の承認を受けて、動いているコンテナに反映した。実行したのは次の 2 つである。

```sh
docker compose up --build -d                                # worker・api・broker を作り直す。起動時に DB の列が足される
docker compose exec worker npm run schedule -- chief-patrol # 巡回のスケジュールだけを登録する
```

| 確かめたこと | 結果 |
| --- | --- |
| コンテナ | 8 つとも running。作り直されたのは worker・api・broker |
| 既存の行 | 12 テーブルの行数が、反映の前後で同じ。`parked_tasks`（0 行）が増えた |
| 既存の質問 | 未解決の 3 件は、担当も期限も空のまま。催促の対象にならない |
| 期限が付いた承認待ちの提案 | 0 件。`rule_proposals` が空だった |
| スケジュール | `chief-patrol` が登録された。次回は 9:00。`infra-daily-…` と `retro-weekly-…` は変わっていない |
| 動いている Workflow | `chief`（572 イベント）と稼働中のプロジェクト1件（369 イベント）が、新しい worker で状態の問い合わせに答えた。履歴の再生も通った |
| 巡回 | `POST /patrol/run` で 1 回回した。期限切れは 0 件で、LLM は呼ばれていない |

**`outer-loop-daily` は登録していない。** 引数なしの `npm run schedule` は Outer Loop の日次スケジュールも登録する。反映の前に登録されていなかったので、承認の範囲（巡回）に含めなかった。登録するなら、引数なしで実行する。

まだ確かめていないのは、LLM を通した挙動である。エージェントが担当と期限を書くか、催促に応じるか、チーフが一覧を振り分けるかは、実際に期限切れが出るまで分からない。

## 5. 初稿から変えた点

訂正した 3 か所。

| 初稿の記述 | 実物 |
| --- | --- |
| `test-results` の PNG が除外されていない | 除外されている。`docs/.gitignore` にあり、ルートの `.gitignore` だけを見ると見落とす |
| モデル ID が実在するか要確認 | 実在する。優先度を下げ、2-8 に移した |
| `worker/src/pi/` の tsc が通らない | 落ちるのは `harness.ts` の 1 ファイル、7 件 |

追加した 4 件。

| 追加 | 節 |
| --- | --- |
| api・Postgres・Temporal が全インターフェースに公開されている | 2-3 |
| `claude -p` のツール不使用は、強制ではなく依頼である | 2-1 |
| sandbox デーモンの `/read` と `/write` に範囲の確認が無い。broker のシークレットは削除もできる。sandbox デーモンへのトークンは、sandbox の中のコードには効かない | 2-2 |
| egress の読み取りが自 org に限定されていない。`sandbox-workspace` もバックアップの対象 | 2-7、2-6 |

## 付録：再現

```sh
cd worker && npx tsc --noEmit -p .                                           # 型チェック (harness.ts の 7 件が出る)
cd worker && npx vitest run test/org.test.ts test/org-workflow.test.ts \
  test/board.test.ts test/line-editor.test.ts test/repo.test.ts \
  test/followup.test.ts test/followup-workflow.test.ts                       # LLM も DB も要らないテスト
git status --short                                                           # 未コミットの一覧
node ~/.claude/skills/explainer/scripts/verify-doc.mjs docs/review-2026-11-19 --skip-html   # この資料の検証
```

この資料は HTML に組んでいない（`--skip-html`）。生成物を増やさないためである。

4 節の実装では、次の 2 つも実行した。どちらも通っている。

```sh
# SQL と、古い DB からの移行。空の使い捨て Postgres に向ける (動いている kobun の DB には向けない)
docker run -d --rm --name kobun-followup-test -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55999:5432 postgres:16
cd worker && FOLLOWUP_DB=postgres://postgres:postgres@127.0.0.1:55999/postgres npx vitest run test/followup-db.test.ts
docker stop kobun-followup-test

# 動いている Workflow の履歴を、変更後のコードで再生する (読み取りだけ)
cd worker && REPLAY_TEMPORAL=localhost:7233 npx vitest run test/replay.test.ts
```

| 確認 | 結果 |
| --- | --- |
| `followup-db.test.ts` | 6 件が通った。使い捨てのコンテナは削除済み |
| `replay.test.ts` | 動いていた `chief`（495 イベント）と稼働中のプロジェクト1件（226 イベント）を再生できた。動いているセッションは無かった |

今回やっていないこと。

- コンテナをまたぐ試験。kobun のコンテナは動いていたが、触っていない。2-2、2-3、2-7 は、コードと設定を読んだ結果である。
- 4 節の実装の、動いているコンテナへの反映と、API・対話コマンドを通した確認。
- LLM の呼び出し。費用（2-5）とモデル ID での実行（2-8）は確かめていない。
- `conformance.test.ts` の実行。
- mini 側のコピーの確認。

| 読んだファイル | 見たこと |
| --- | --- |
| `docker-compose.yml` | 公開ポート、ネットワーク、ボリューム、モデル ID の既定値 |
| `.gitignore`、`docs/.gitignore` | 除外の範囲 |
| `.env`、`.env.example` | どの項目が設定されているかだけ。値は見ていない |
| `worker/src/llm.ts` | バックエンドの切り替え、`claude -p` の呼び方 |
| `worker/src/broker.ts` | 暗号化、API の一覧、鍵の置き場所 |
| `sandbox/server.mjs`、`sandbox/repo-access.mjs` | デーモンの経路、拒否リスト |
| `egress/addon.py` | 許可リスト |
| `worker/src/org-workflows.ts`、`workflows.ts` | 上限の定数、`patched`、期限 |
| `worker/src/org-activities.ts`、`server.ts`、`metrics/` | 該当箇所を検索して確認。全文は読んでいない |
