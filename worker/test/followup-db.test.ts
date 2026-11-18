// 期限・巡回・保留の再開・提案の期限を、実物の Postgres で通しで確かめる (SQL と、古い DB からの移行)。
// 空の使い捨て DB に向けて実行する。動いている kobun の DB には向けないこと (テーブルを作り、行を書く)。
// 実行: FOLLOWUP_DB=postgres://postgres:postgres@localhost:55999/postgres npx vitest run test/followup-db.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest';

const url = process.env.FOLLOWUP_DB;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let db: typeof import('../src/db');
let board: typeof import('../src/board');
let fu: typeof import('../src/followup-activities');
let rules: typeof import('../src/rules');
let org: typeof import('../src/org-activities');

beforeAll(async () => {
  if (!url) return;
  process.env.CHECKPOINT_DATABASE_URL = url;
  db = await import('../src/db');
  // 移行の確認: この変更より前の形のテーブルと行を先に作っておく
  await db.pool.query(`
    CREATE TABLE board (
      id BIGSERIAL PRIMARY KEY, project_slug TEXT NOT NULL, kind TEXT NOT NULL, author TEXT NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', resolved_by TEXT, resolved_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ);
    INSERT INTO board (project_slug, kind, author, text) VALUES ('billing', 'question', 'pjm', '移行前からある質問');
    CREATE TABLE rule_proposals (
      id BIGSERIAL PRIMARY KEY, project_slug TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL, target_code TEXT, text TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending', source TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_at TIMESTAMPTZ);
    INSERT INTO rule_proposals (project_slug, scope, scope_key, kind, text) VALUES ('billing', 'client', 'acme', 'add', '移行前からある提案');
    CREATE TABLE parked_tasks (
      id BIGSERIAL PRIMARY KEY, session_id TEXT NOT NULL, request TEXT NOT NULL, questions JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'timeout_parked', created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    INSERT INTO parked_tasks (session_id, request, questions, created_at)
      VALUES ('session-old', '移行前に保留になった依頼', '["対象は？"]', now() - interval '5 days');
  `);
  await db.ensureSchema();
  await db.pool.query(
    `INSERT INTO clients (slug, name) VALUES ('acme', 'アクメ商事');
     INSERT INTO projects (slug, name, goal, client_slug) VALUES ('billing', '請求', '', 'acme')`,
  );
  board = await import('../src/board');
  fu = await import('../src/followup-activities');
  rules = await import('../src/rules');
  org = await import('../src/org-activities');
}, 60_000);

afterAll(async () => {
  await db?.pool.end();
});

it.skipIf(!url)('移行: 既存の行は残り、期限の無い質問は催促の対象にならず、既存の提案には 7 日の期限が付く', async () => {
  const b = await db.pool.query(`SELECT owner, due_at, escalation FROM board WHERE text = '移行前からある質問'`);
  expect(b.rows[0]).toEqual({ owner: null, due_at: null, escalation: 0 });
  const p = await db.pool.query(`SELECT due_at - now() AS left FROM rule_proposals WHERE text = '移行前からある提案'`);
  expect(p.rows[0].left.days).toBeGreaterThanOrEqual(6);
  const far = await fu.patrolSweep(Date.now() + 2 * DAY);
  expect(far.nudges).toEqual([]);
  expect(far.overdue).toBe(0);
  // 5 日前に保留になったタスクは、一覧に1回だけ載る
  expect(far.chiefDigest).toContain('移行前に保留になった依頼');
  expect((await fu.patrolSweep(Date.now() + 2 * DAY)).chiefDigest).toBeNull();
});

it.skipIf(!url)('期限切れは 担当 → PjM とチーフ → ユーザー の順に1段ずつ上がり、同じ段階を繰り返さない', async () => {
  const t0 = Date.now();
  const code = await board.addBoardEntry('billing', 'task', 'pjm', 'API 仕様の初版を書く', {
    owner: 'engineer-lead',
    due: '12h',
    nowMs: t0,
  });
  // 担当と期限を省いた質問は、書いた本人が担当で、期限は 2 日
  const q = await board.addBoardEntry('billing', 'question', 'designer', '配色の基準はあるか', { nowMs: t0 });
  const loaded = await board.loadBoard('billing');
  const entry = (c: string) => loaded.entries.find((e) => e.code === c)!;
  expect(entry(code).owner).toBe('engineer-lead');
  expect(entry(q).owner).toBe('designer');
  expect(new Date(entry(q).dueAt!).getTime()).toBe(t0 + 48 * HOUR);

  expect((await fu.patrolSweep(t0 + 11 * HOUR)).nudges).toEqual([]);

  const s1 = await fu.patrolSweep(t0 + 13 * HOUR);
  expect(s1.nudges.map((n) => [n.slug, n.to])).toEqual([['billing', 'engineer-lead']]);
  expect(s1.nudges[0].content).toContain(`[${code}] API 仕様の初版を書く`);
  expect(s1.chiefDigest).toBeNull();
  // 同じ段階は繰り返さない
  expect((await fu.patrolSweep(t0 + 20 * HOUR)).nudges).toEqual([]);

  const s2 = await fu.patrolSweep(t0 + 13 * HOUR + DAY);
  expect(s2.nudges.map((n) => n.to)).toEqual(['pjm']);
  expect(s2.chiefDigest).toContain(`[${code}] API 仕様の初版を書く`);
  expect(s2.surfaced).toBe(0);

  const before = (await db.pool.query(`SELECT count(*)::int AS n FROM user_feed`)).rows[0].n;
  const s3 = await fu.patrolSweep(t0 + 13 * HOUR + 2 * DAY);
  // ここで質問 (期限 2 日) も期限切れになり、担当のデザイナーに催促が出る
  expect(s3.nudges.map((n) => n.to)).toEqual(['designer']);
  expect(s3.surfaced).toBe(1);
  const feed = await db.pool.query(`SELECT kind, title, body FROM user_feed ORDER BY id DESC LIMIT 1`);
  expect((await db.pool.query(`SELECT count(*)::int AS n FROM user_feed`)).rows[0].n).toBe(before + 1);
  expect(feed.rows[0].kind).toBe('request');
  expect(feed.rows[0].title).toContain(`期限を過ぎたやること ${code}`);
  expect(feed.rows[0].body).toContain(`/done billing ${code}`);

  // 段階 3 から先は、何日たっても何も出ない
  const s4 = await fu.patrolSweep(t0 + 13 * HOUR + 2 * DAY + HOUR);
  expect(s4.nudges).toEqual([]);
  expect(s4.surfaced).toBe(0);

  // 期限切れの件数は指標になる
  const samples = await org.internalSamples('billing');
  expect(samples.find((s) => s.key === 'board_overdue')?.value).toBe(0); // 実時刻ではまだ期限前
});

it.skipIf(!url)('期限の引き直しは理由が要り、段階を 0 に戻す。下ろした項目は催促されない', async () => {
  const t0 = Date.now() + 30 * DAY;
  const code = await board.addBoardEntry('billing', 'task', 'pjm', '見積もりを出す', { due: '1h', nowMs: t0 });
  expect((await fu.patrolSweep(t0 + 2 * HOUR)).nudges.filter((n) => n.content.includes(code))).toHaveLength(1);

  expect(await board.setBoardDue('billing', code, '2d', 'pjm', '', t0 + 2 * HOUR)).toContain('理由');
  expect(await board.setBoardDue('billing', code, 'あとで', 'pjm', '理由', t0 + 2 * HOUR)).toContain('読めません');
  expect(await board.setBoardDue('billing', 'B-999999', '2d', 'pjm', '理由', t0 + 2 * HOUR)).toContain('ありません');
  expect(await board.setBoardDue('billing', code, '2d', 'pjm', 'クライアントの回答待ち', t0 + 2 * HOUR)).toBeNull();
  const row = await db.pool.query(`SELECT escalation, text FROM board WHERE id = $1`, [code.slice(2)]);
  expect(row.rows[0].escalation).toBe(0);
  expect(row.rows[0].text).toContain('クライアントの回答待ち');
  // 引き直した期限までは催促されず、過ぎるとまた段階 1 から始まる
  expect((await fu.patrolSweep(t0 + 26 * HOUR)).nudges.filter((n) => n.content.includes(code))).toEqual([]);
  expect((await fu.patrolSweep(t0 + 51 * HOUR)).nudges.filter((n) => n.content.includes(code))).toHaveLength(1);

  expect(await board.resolveBoardEntry('billing', code, 'pjm', '提出済み')).toBe(true);
  const after = await fu.patrolSweep(t0 + 10 * DAY);
  expect(after.nudges.filter((n) => n.content.includes(code))).toEqual([]);
});

it.skipIf(!url)('担当がユーザーの質問は、エージェントを催促せず、期限切れで直接ユーザーに出す', async () => {
  const t0 = Date.now() + 60 * DAY;
  const code = await board.addBoardEntry('billing', 'question', 'pjm', '締め日の例外はあるか', {
    owner: 'user',
    due: '1h',
    nowMs: t0,
  });
  const s = await fu.patrolSweep(t0 + 2 * HOUR);
  expect(s.nudges.filter((n) => n.content.includes(code))).toEqual([]);
  const feed = await db.pool.query(`SELECT title, body FROM user_feed ORDER BY id DESC LIMIT 1`);
  expect(feed.rows[0].title).toContain(`期限を過ぎた未解決の質問 ${code}`);
  expect(feed.rows[0].body).toContain('あなたの回答・判断を待っています');
  await board.resolveBoardEntry('billing', code, 'user', '例外なし');
});

it.skipIf(!url)('保留した実装タスクは1回だけ再開できる。取り下げたものは一覧から消える', async () => {
  const a = await db.pool.query(
    `INSERT INTO parked_tasks (session_id, request, questions) VALUES ('session-a', '請求書 PDF', '["対象は？","完了条件は？"]') RETURNING id`,
  );
  const id = Number(a.rows[0].id);
  expect((await fu.latestParkedFor('session-a'))?.id).toBe(id);
  const claimed = await fu.claimParked(id);
  expect(claimed?.questions).toEqual(['対象は？', '完了条件は？']);
  // 再開の処理中は、もう1回は取れない
  expect(await fu.claimParked(id)).toBeNull();
  // セッションに渡せなかった場合は、保留中に戻る
  await fu.settleParked(id, null);
  expect((await fu.claimParked(id))?.id).toBe(id);
  await fu.settleParked(id, '月次請求');
  expect(await fu.claimParked(id)).toBeNull();
  expect(await fu.latestParkedFor('session-a')).toBeNull();
  const done = await db.pool.query(`SELECT status, answer FROM parked_tasks WHERE id = $1`, [id]);
  expect(done.rows[0]).toEqual({ status: 'resumed', answer: '月次請求' });

  const old = (await fu.listParked()).find((p) => p.sessionId === 'session-old')!;
  expect(await fu.dropParked(old.id, '不要になった')).toBe(true);
  expect(await fu.dropParked(old.id, '')).toBe(false);
  expect((await fu.listParked()).some((p) => p.id === old.id)).toBe(false);
});

it.skipIf(!url)('承認待ちの提案: 同じ提案は重ねず、却下した提案は蒸し返さない。期限切れは一覧に1回だけ載り、自動では決まらない', async () => {
  const target = { slug: 'billing', client: 'acme' };
  const add = (text: string) =>
    rules.applyRuleChanges(target, [{ scope: 'client', replaces: null, text }], [], 'retro:test', {
      requireApproval: true,
    });
  const [first] = await add('金額は税込で表示する。');
  expect(first.proposalId).toBeDefined();
  // 承認待ちの間に同じ提案が来ても、重ねない
  const [dup] = await add(' 金額は税込で表示する');
  expect(dup.proposalId).toBeUndefined();
  expect(dup.op).toBe(`提案せず (承認待ち #${first.proposalId} と同じ)`);

  // 期限 (7 日) を過ぎると、チーフの一覧に1回だけ載る。状態は pending のまま
  const late = await fu.patrolSweep(Date.now() + 8 * DAY);
  expect(late.chiefDigest).toContain(`#${first.proposalId} [クライアント] 追加: 金額は税込で表示する。`);
  expect((await fu.patrolSweep(Date.now() + 9 * DAY)).chiefDigest).toBeNull();
  const still = await db.pool.query(`SELECT status FROM rule_proposals WHERE id = $1`, [first.proposalId]);
  expect(still.rows[0].status).toBe('pending');
  const overview = await fu.pendingOverview(Date.now() + 8 * DAY);
  expect(overview.proposals.find((p) => p.id === first.proposalId)?.overdue).toBe(true);

  // 却下した提案は、同じ内容では二度と出ない。内容が違えば出せる
  expect((await rules.decideProposal(first.proposalId!, false))?.status).toBe('rejected');
  const [again] = await add('金額は税込で表示する');
  expect(again.proposalId).toBeUndefined();
  expect(again.op).toBe(`提案せず (過去に却下済み #${first.proposalId})`);
  const [other] = await add('金額は税抜で表示し、税額を別に書く');
  expect(other.proposalId).toBeDefined();
  // ユーザーが直接追加するのは、却下の後でもできる
  const [direct] = await rules.applyRuleChanges(target, [{ scope: 'client', replaces: null, text: '金額は税込で表示する' }], [], 'user');
  expect(direct.op).toBe('追加');

  const samples = await org.internalSamples('billing');
  expect(samples.find((s) => s.key === 'rule_proposals_overdue')?.value).toBe(0); // 実時刻ではまだ期限前
});
