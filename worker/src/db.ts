import { Pool } from 'pg';
import { CODE_OF_CONDUCT } from './metrics/catalog';

// kobun 自身の状態を置く Postgres (checkpoints DB)。worker と api の両方が使う。
export const pool = new Pool({
  connectionString:
    process.env.CHECKPOINT_DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/checkpoints',
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS checkpoints (
  id BIGSERIAL PRIMARY KEY,
  messages JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS clients (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS projects (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  client_slug TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 行動ルール。3層あり、下の層が上の層を上書きする:
--   common  (kobun 全体, scope_key = '')
--   client  (クライアント毎, scope_key = クライアントの slug)
--   project (プロジェクト毎, scope_key = プロジェクトの slug)
-- 振り返りで追加・置換・廃止される。廃止したルールも履歴として残す。
CREATE TABLE IF NOT EXISTS rules (
  id BIGSERIAL PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'user',
  retired_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  UNIQUE (scope, scope_key, code)
);
-- 承認待ちのルール変更。振り返りが kobun 共通・クライアントの層を変えようとしたときは、
-- すぐには適用せず、ここに置いてユーザーの承認を待つ (プロジェクトの層は即時に適用する)。
CREATE TABLE IF NOT EXISTS rule_proposals (
  id BIGSERIAL PRIMARY KEY,
  project_slug TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  target_code TEXT,
  text TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  source TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ
);
-- プロジェクトのボード (チーム全員が毎回読む共有の掲示板)。
-- kind: fact (共有された情報) / decision (決定事項) / question (未解決の質問) / status (各メンバーのメモ)
CREATE TABLE IF NOT EXISTS board (
  id BIGSERIAL PRIMARY KEY,
  project_slug TEXT NOT NULL,
  kind TEXT NOT NULL,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  resolved_by TEXT,
  resolved_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS board_lookup ON board (project_slug, status, id);
-- プロジェクトが使うリポジトリ (複数)
CREATE TABLE IF NOT EXISTS repositories (
  project_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_slug, name)
);
-- データソース: 改善や調査に必要な数字の取得方法 (プロジェクト毎に名前を付けて複数登録できる)。
-- config に API キーなどの値は書かない。{{secret:名前}} で参照し、値はクレデンシャルブローカーが
-- 取得の瞬間に差し込む。
CREATE TABLE IF NOT EXISTS connections (
  project_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  config JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'unverified',
  last_error TEXT,
  checked_at TIMESTAMPTZ,
  PRIMARY KEY (project_slug, name)
);
-- シークレット (API キーなど)。値はブローカーだけが持つ鍵で暗号化されている。
-- worker / api はこの表を読めても復号できない。
CREATE TABLE IF NOT EXISTS secrets (
  project_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_slug, name)
);
CREATE TABLE IF NOT EXISTS metric_samples (
  id BIGSERIAL PRIMARY KEY,
  project_slug TEXT NOT NULL,
  key TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  detail JSONB,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS metric_samples_lookup
  ON metric_samples (project_slug, key, collected_at DESC);
CREATE TABLE IF NOT EXISTS improvements (
  id BIGSERIAL PRIMARY KEY,
  project_slug TEXT NOT NULL,
  week DATE NOT NULL,
  owner TEXT NOT NULL,
  action TEXT NOT NULL,
  metric_key TEXT,
  baseline DOUBLE PRECISION,
  target DOUBLE PRECISION,
  status TEXT NOT NULL DEFAULT 'open',
  result_value DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);
-- ユーザーに届くもの全部 (チーフの発言、アラート、改善レポート、提案、依頼)
CREATE TABLE IF NOT EXISTS user_feed (
  id BIGSERIAL PRIMARY KEY,
  project_slug TEXT,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_turns (
  id BIGSERIAL PRIMARY KEY,
  project_slug TEXT,
  role TEXT NOT NULL,
  sender TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 仕事の期限と所有者 (followup.ts)。ボードの「未解決の質問」と「やること」(kind = question / task) が持つ。
--   owner: 担当 (プロジェクトのロールか user) / due_at: 期限
--   escalation: 期限切れの段階 (0 = まだ / 1 = 担当に催促 / 2 = PjM とチーフ / 3 = ユーザー)
ALTER TABLE board ADD COLUMN IF NOT EXISTS owner TEXT;
ALTER TABLE board ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
ALTER TABLE board ADD COLUMN IF NOT EXISTS escalation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE board ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
-- 承認待ちのルール提案の期限。過ぎても自動では適用も却下もしない (巡回がチーフの一覧に1回載せる)
ALTER TABLE rule_proposals ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days');
ALTER TABLE rule_proposals ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;
-- 回答期限 (3時間) を過ぎて保留になった実装タスク。あとから回答すれば再開できる。
--   status: timeout_parked (保留中) / resuming (再開の処理中) / resumed (再開済み) / dropped (不要として取り下げ)
CREATE TABLE IF NOT EXISTS parked_tasks (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  request TEXT NOT NULL,
  questions JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'timeout_parked',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE parked_tasks ADD COLUMN IF NOT EXISTS answer TEXT;
ALTER TABLE parked_tasks ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE parked_tasks ADD COLUMN IF NOT EXISTS reminded_at TIMESTAMPTZ;
`;

let ready: Promise<void> | null = null;
export function ensureSchema(): Promise<void> {
  ready ??= (async () => {
    const client = await pool.connect();
    try {
      // worker と api が同時に起動しても CREATE が競合しないよう直列化する
      await client.query('SELECT pg_advisory_lock(7411001)');
      await client.query(SCHEMA);
      // 改善の行動規範を kobun 共通ルールとして初期登録する (共通ルールが空のときだけ)
      const seeded = await client.query(
        "SELECT 1 FROM rules WHERE scope = 'common' LIMIT 1",
      );
      if ((seeded.rowCount ?? 0) === 0) {
        for (const [i, text] of CODE_OF_CONDUCT.entries()) {
          await client.query(
            `INSERT INTO rules (scope, scope_key, code, text, source)
             VALUES ('common', '', $1, $2, 'seed') ON CONFLICT DO NOTHING`,
            [`K-${i + 1}`, text],
          );
        }
      }
      await client.query('SELECT pg_advisory_unlock(7411001)');
    } finally {
      client.release();
    }
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}
