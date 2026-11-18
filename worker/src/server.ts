import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Connection, Client } from '@temporalio/client';
import {
  userMessageSignal,
  answerSignal,
  historyQuery,
  pendingQuestionsQuery,
  chiefInboxSignal,
  chiefStateQuery,
  projectStateQuery,
  projectWorkflowId,
  resumeParkedSignal,
  CHIEF_WORKFLOW_ID,
  TASK_QUEUE,
} from './shared';
import {
  claimParked,
  dropParked,
  latestParkedFor,
  listParked,
  pendingOverview,
  settleParked,
} from './followup-activities';
import { pool, ensureSchema } from './db';
import { PROJECT_ROLES, ROLES, type RoleId } from './agents/roles';
import { addBoardEntry, loadBoard, renderBoard, resolveBoardEntry } from './board';
import { parseOutput } from './agents/protocol';
import type { ProjectState } from './shared';
import {
  COMMAND_SECRET_ERROR,
  hasSecretRef,
} from './metrics/collectors';
import { COLLECTORS, findInlineSecrets, maskConfig } from './metrics/collectors';

const BROKER_PUBLIC_URL = process.env.BROKER_PUBLIC_URL ?? 'http://localhost:3100';
import { CATALOG, CODE_OF_CONDUCT } from './metrics/catalog';
import { activeRules, applyRuleChanges, decideProposal } from './rules';

// Web/Bot 層のローカル版: REST でセッションを開始し、Signal で発言し、Query で履歴を読む
const app = new Hono();

let clientPromise: Promise<Client> | null = null;
function getClient(): Promise<Client> {
  clientPromise ??= (async () => {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    });
    return new Client({ connection });
  })();
  return clientPromise;
}

app.post('/sessions', async (c) => {
  const client = await getClient();
  const id = `session-${crypto.randomUUID()}`;
  await client.workflow.start('sessionWorkflow', {
    workflowId: id,
    taskQueue: TASK_QUEUE,
    args: [[]],
  });
  return c.json({ sessionId: id });
});

app.post('/sessions/:id/messages', async (c) => {
  const client = await getClient();
  const { text } = await c.req.json<{ text: string }>();
  const handle = client.workflow.getHandle(c.req.param('id'));
  await handle.signal(userMessageSignal, text);
  return c.json({ ok: true });
});

app.get('/sessions/:id', async (c) => {
  const client = await getClient();
  const handle = client.workflow.getHandle(c.req.param('id'));
  const history = await handle.query(historyQuery);
  return c.json({ history });
});

// grilling の回答待ち質問を取得する (ask-a-person の提示側)
app.get('/sessions/:id/questions', async (c) => {
  const client = await getClient();
  const handle = client.workflow.getHandle(c.req.param('id'));
  const questions = await handle.query(pendingQuestionsQuery);
  return c.json({ questions });
});

/**
 * 保留した実装タスクを、後から届いた回答で再開する。
 * セッションの Workflow が終了していても、同じ ID で起動し直して渡す。
 * 再開できたら true。対象が無い (再開済み・取り下げ済み) なら false。
 */
async function resumeParked(id: number, answer: string): Promise<boolean> {
  const task = await claimParked(id);
  if (!task) return false;
  try {
    const client = await getClient();
    await client.workflow.signalWithStart('sessionWorkflow', {
      workflowId: task.sessionId,
      taskQueue: TASK_QUEUE,
      args: [[]],
      signal: resumeParkedSignal,
      signalArgs: [
        { parkedId: task.id, request: task.request, questions: task.questions, answer },
      ],
    });
  } catch (err) {
    // セッションに渡せなかったら、保留中に戻す (回答を失わせないため、呼び出し側にエラーを返す)
    await settleParked(id, null);
    throw err;
  }
  await settleParked(id, answer);
  return true;
}

// grilling の質問に回答する (期限は3時間。それを過ぎるとタスクは保存されて停止する)。
// 期限の後に届いた回答は、そのセッションで最後に保留になったタスクの再開として扱う
app.post('/sessions/:id/answer', async (c) => {
  const client = await getClient();
  const { text } = await c.req.json<{ text: string }>();
  if (!text) return c.json({ error: 'text is required' }, 400);
  const id = c.req.param('id');
  const handle = client.workflow.getHandle(id);
  let waiting = false;
  try {
    waiting = (await handle.query(pendingQuestionsQuery)) !== null;
  } catch {
    waiting = false; // セッションが終了している
  }
  if (!waiting) {
    const parked = await latestParkedFor(id);
    if (parked && (await resumeParked(parked.id, text))) {
      return c.json({ ok: true, resumed: parked.id });
    }
    return c.json({ error: '回答待ちの質問も、保留中のタスクもありません' }, 404);
  }
  await handle.signal(answerSignal, text);
  return c.json({ ok: true });
});

// 保留中の実装タスク (回答期限切れ)
app.get('/parked', async (c) => c.json({ parked: await listParked() }));

// 保留中の実装タスクに回答して再開する: { "text": "回答" }
app.post('/parked/:id/answer', async (c) => {
  const id = Number(c.req.param('id'));
  const { text } = await c.req.json<{ text?: string }>().catch(() => ({ text: undefined }));
  if (!Number.isInteger(id) || !text?.trim()) {
    return c.json({ error: '番号と text (回答) が必要です' }, 400);
  }
  return (await resumeParked(id, text))
    ? c.json({ ok: true, resumed: id })
    : c.json({ error: '保留中のタスクがありません (存在しないか、再開・取り下げ済み)' }, 404);
});

// 保留中の実装タスクを取り下げる (以後、巡回の一覧に載らない)
app.post('/parked/:id/drop', async (c) => {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: '' }));
  return (await dropParked(id, body.reason ?? ''))
    ? c.json({ ok: true })
    : c.json({ error: '保留中のタスクがありません (存在しないか、再開・取り下げ済み)' }, 404);
});

// 判断待ちの一覧: 期限を過ぎた仕事、保留中の実装タスク、承認待ちのルール提案
app.get('/pending', async (c) => c.json(await pendingOverview()));

// 巡回を手動で1回回す (通常は Temporal Schedule が 9〜21 時の毎時に起動する)
app.post('/patrol/run', async (c) => {
  const client = await getClient();
  const handle = await client.workflow.start('patrolWorkflow', {
    workflowId: `patrol-manual-${Date.now()}`,
    taskQueue: TASK_QUEUE,
  });
  return c.json(await handle.result());
});

// Outer Loop を手動で1回回す (通常は Temporal Schedule が日次で起動する)
app.post('/outer-loop/run', async (c) => {
  const client = await getClient();
  const handle = await client.workflow.start('outerLoopWorkflow', {
    workflowId: `outer-loop-manual-${Date.now()}`,
    taskQueue: TASK_QUEUE,
  });
  const reportPath = await handle.result();
  return c.json({ reportPath });
});

// ---------------------------------------------------------------------------
// エージェント組織: ユーザーの窓口はチーフだけ
// ---------------------------------------------------------------------------

// チーフに話しかける (チーフの Workflow が無ければ起動する)
app.post('/chief/messages', async (c) => {
  const client = await getClient();
  const { text } = await c.req.json<{ text: string }>();
  if (!text) return c.json({ error: 'text is required' }, 400);
  await client.workflow.signalWithStart('chiefWorkflow', {
    workflowId: CHIEF_WORKFLOW_ID,
    taskQueue: TASK_QUEUE,
    args: [],
    signal: chiefInboxSignal,
    signalArgs: [{ from: 'user', to: 'chief', content: text }],
  });
  return c.json({ ok: true });
});

// チーフとの会話履歴
app.get('/chief', async (c) => {
  const client = await getClient();
  try {
    const state = await client.workflow
      .getHandle(CHIEF_WORKFLOW_ID)
      .query(chiefStateQuery);
    return c.json(state);
  } catch {
    return c.json({ thread: [], turns: 0 });
  }
});

// ユーザーに届いたもの全部 (チーフの発言・アラート・改善レポート・依頼)
app.get('/feed', async (c) => {
  await ensureSchema();
  const after = Number(c.req.query('after') ?? 0) || 0;
  const res = await pool.query(
    `SELECT id, project_slug AS project, source, kind, title, body, created_at
     FROM user_feed WHERE id > $1 ORDER BY id LIMIT 200`,
    [after],
  );
  return c.json({ items: res.rows });
});

app.get('/projects', async (c) => {
  await ensureSchema();
  const res = await pool.query(
    'SELECT slug, name, goal, client_slug AS client, created_at FROM projects ORDER BY created_at',
  );
  return c.json({ projects: res.rows });
});

app.get('/clients', async (c) => {
  await ensureSchema();
  const res = await pool.query(
    'SELECT slug, name, created_at FROM clients ORDER BY created_at',
  );
  return c.json({ clients: res.rows });
});

async function projectClient(slug: string): Promise<string | null> {
  await ensureSchema();
  const res = await pool.query(
    'SELECT client_slug FROM projects WHERE slug = $1',
    [slug],
  );
  return res.rows[0] ? String(res.rows[0].client_slug) : null;
}

// プロジェクトに効いている行動ルール (kobun 共通 / クライアント / プロジェクトの3層)
app.get('/projects/:slug/rules', async (c) => {
  const slug = c.req.param('slug');
  const client = await projectClient(slug);
  if (client === null) return c.json({ error: 'not found' }, 404);
  return c.json(await activeRules({ slug, client }));
});

// ユーザーが行動ルールを直接追加・置換・廃止する (振り返りを待たずに反映したいとき)
//   { "scope": "common" | "client" | "project", "text": "...", "replaces": "C-1" }
//   { "retire": "P-2", "reason": "..." }
app.post('/projects/:slug/rules', async (c) => {
  const slug = c.req.param('slug');
  const client = await projectClient(slug);
  if (client === null) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{
    scope?: string;
    text?: string;
    replaces?: string;
    retire?: string;
    reason?: string;
  }>();
  const scope =
    body.scope === 'common' || body.scope === 'client' ? body.scope : 'project';
  const changes = await applyRuleChanges(
    { slug, client },
    body.text
      ? [{ scope, text: body.text, replaces: body.replaces?.toUpperCase() ?? null }]
      : [],
    body.retire ? [{ id: body.retire.toUpperCase(), reason: body.reason ?? '' }] : [],
    'user',
  );
  return c.json({ changes });
});

// 承認待ちのルール変更 (振り返りが kobun 共通・クライアントの層を変えようとしたもの)
app.get('/rule-proposals', async (c) => {
  await ensureSchema();
  const status = c.req.query('status') ?? 'pending';
  const res = await pool.query(
    `SELECT id, project_slug AS project, scope, scope_key, kind, target_code, text, reason,
            status, created_at, decided_at, due_at
     FROM rule_proposals WHERE status = $1 ORDER BY id`,
    [status],
  );
  return c.json({ proposals: res.rows });
});

for (const action of ['approve', 'reject'] as const) {
  app.post(`/rule-proposals/:id/${action}`, async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
    const result = await decideProposal(id, action === 'approve');
    if (!result) {
      return c.json({ error: '承認待ちの提案がありません (存在しないか、確定済み)' }, 404);
    }
    return c.json(result);
  });
}

async function projectExists(slug: string): Promise<boolean> {
  await ensureSchema();
  const res = await pool.query('SELECT 1 FROM projects WHERE slug = $1', [slug]);
  return (res.rowCount ?? 0) > 0;
}

// プロジェクトのボード (共有された情報・決定事項・未解決の質問・メンバーの状況)
app.get('/projects/:slug/board', async (c) => {
  const client = await getClient();
  const slug = c.req.param('slug');
  if (!(await projectExists(slug))) return c.json({ error: 'not found' }, 404);
  let now: { role: RoleId; since: number }[] = [];
  try {
    const state = await client.workflow.getHandle(projectWorkflowId(slug)).query(projectStateQuery);
    now = (state.working ?? (state.current ? [state.current] : [])).map((w) => ({
      role: w.role,
      since: w.since,
    }));
  } catch {
    now = [];
  }
  const board = await loadBoard(slug, now);
  return c.json({ ...board, text: renderBoard(board) });
});

// ユーザーがボードに直接書く (チーフを介さずに、チーム全員に確実に伝えたい情報)
//   { "kind": "fact|decision|question|task", "text": "...", "owner": "ロールID か user", "due": "3d" }
app.post('/projects/:slug/board', async (c) => {
  const slug = c.req.param('slug');
  if (!(await projectExists(slug))) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ kind?: string; text?: string; owner?: string; due?: string }>();
  if (!body.text?.trim()) return c.json({ error: 'text is required' }, 400);
  const kind =
    body.kind === 'decision' || body.kind === 'question' || body.kind === 'task' ? body.kind : 'fact';
  // question / task には担当と期限が付く (省くと担当は PjM、期限は既定)
  return c.json({
    ok: true,
    code: await addBoardEntry(slug, kind, 'user', body.text, { owner: body.owner, due: body.due }),
  });
});

app.post('/projects/:slug/board/:code/resolve', async (c) => {
  const slug = c.req.param('slug');
  const body = await c.req.json<{ reason?: string }>().catch(() => ({ reason: '' }));
  const ok = await resolveBoardEntry(slug, c.req.param('code'), 'user', body.reason ?? '');
  return ok ? c.json({ ok: true }) : c.json({ error: '有効な項目がありません' }, 404);
});

// チームの状況: 誰がいて、いま誰が動いていて、誰が何を待っているか
app.get('/projects/:slug/team', async (c) => {
  const client = await getClient();
  const slug = c.req.param('slug');
  if (!(await projectExists(slug))) return c.json({ error: 'not found' }, 404);
  let state: ProjectState | null = null;
  try {
    state = await client.workflow.getHandle(projectWorkflowId(slug)).query(projectStateQuery);
  } catch {
    state = null; // Workflow が停止している
  }
  const stats = await pool.query(
    `SELECT role,
            count(*) FILTER (WHERE error IS NULL)::int AS turns,
            count(*) FILTER (WHERE error IS NOT NULL AND error <> 'routing_violation')::int AS errors,
            max(created_at) AS last_at
     FROM agent_turns WHERE project_slug = $1 GROUP BY role`,
    [slug],
  );
  const last = await pool.query(
    `SELECT DISTINCT ON (role) role, sender, input, output, error, duration_ms, created_at
     FROM agent_turns
     WHERE project_slug = $1 AND (error IS NULL OR error <> 'routing_violation')
     ORDER BY role, created_at DESC`,
    [slug],
  );
  const statOf = new Map(stats.rows.map((r) => [r.role, r]));
  const lastOf = new Map(last.rows.map((r) => [r.role, r]));
  const preview = (s: string, n = 120) => s.replace(/\s+/g, ' ').trim().slice(0, n);
  const members = PROJECT_ROLES.map((role) => {
    const def = ROLES[role];
    const l = lastOf.get(role);
    const parsed = l?.output ? parseOutput(String(l.output)) : null;
    return {
      role,
      title: def.title,
      model: def.tier,
      talksTo: def.talksTo,
      turns: statOf.get(role)?.turns ?? 0,
      errors: statOf.get(role)?.errors ?? 0,
      working:
        (state?.working ?? (state?.current ? [state.current] : [])).find((w) => w.role === role) ??
        null,
      waiting: (state?.queue ?? []).filter((q) => q.to === role).length,
      last: l
        ? {
            at: l.created_at,
            from: l.sender,
            request: preview(String(l.input)),
            durationSec: Math.round(Number(l.duration_ms) / 1000),
            error: l.error,
            sentTo: [...new Set(parsed?.messages.map((m) => m.to) ?? [])],
            artifacts: parsed?.artifacts.map((a) => a.path) ?? [],
            said: preview(parsed?.rest || parsed?.messages[0]?.content || ''),
          }
        : null,
    };
  });
  return c.json({
    project: slug,
    running: state !== null,
    current: state?.current ?? null,
    working: state?.working ?? (state?.current ? [state.current] : []),
    queue: (state?.queue ?? []).map((q) => ({ from: q.from, to: q.to, content: preview(q.content) })),
    members,
  });
});

// プロジェクト内の各ロールの会話状態
app.get('/projects/:slug', async (c) => {
  const client = await getClient();
  const slug = c.req.param('slug');
  if (!(await projectExists(slug))) return c.json({ error: 'not found' }, 404);
  const state = await client.workflow
    .getHandle(projectWorkflowId(slug))
    .query(projectStateQuery);
  return c.json(state);
});

// ---------------------------------------------------------------------------
// プロジェクトのリポジトリ (複数) とデータソース (複数)
// ---------------------------------------------------------------------------

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

app.put('/projects/:slug/repositories/:name', async (c) => {
  const slug = c.req.param('slug');
  const name = c.req.param('name');
  if (!(await projectExists(slug))) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ url?: string; description?: string }>();
  if (!NAME_RE.test(name) || !body.url) {
    return c.json({ error: 'name (英数字と _ . -) と url が必要です' }, 400);
  }
  if (findInlineSecrets({ url: body.url }).length > 0) {
    return c.json({ error: 'url に資格情報を含めないでください' }, 400);
  }
  await pool.query(
    `INSERT INTO repositories (project_slug, name, url, description) VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_slug, name) DO UPDATE
       SET url = EXCLUDED.url, description = EXCLUDED.description`,
    [slug, name, body.url, body.description ?? ''],
  );
  return c.json({ ok: true, name });
});

app.get('/projects/:slug/repositories', async (c) => {
  await ensureSchema();
  const res = await pool.query(
    'SELECT name, url, description FROM repositories WHERE project_slug = $1 ORDER BY name',
    [c.req.param('slug')],
  );
  return c.json({ repositories: res.rows });
});

app.delete('/projects/:slug/repositories/:name', async (c) => {
  await ensureSchema();
  await pool.query(
    'DELETE FROM repositories WHERE project_slug = $1 AND name = $2',
    [c.req.param('slug'), c.req.param('name')],
  );
  return c.json({ ok: true });
});

// データソース (改善や調査に必要な数字の取得方法) を登録・更新する。
//   { "kind": "github|command|http-json|aws|postgres", "description": "...", "config": {...} }
// config に API キーなどの値は書けない。{{secret:名前}} と書き、値はブローカーに直接渡す。
app.put('/projects/:slug/connections/:name', async (c) => {
  const slug = c.req.param('slug');
  const name = c.req.param('name');
  if (!(await projectExists(slug))) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<{ kind?: string; description?: string; config?: unknown }>();
  const kind = body.kind ?? name;
  if (!NAME_RE.test(name) || !COLLECTORS[kind] || !body.config) {
    return c.json(
      { error: 'name (英数字と _ . -)、kind、config が必要です', kinds: Object.keys(COLLECTORS) },
      400,
    );
  }
  if (kind === 'command' && hasSecretRef(body.config)) {
    return c.json({ error: COMMAND_SECRET_ERROR }, 400);
  }
  const inline = findInlineSecrets(body.config);
  if (inline.length > 0) {
    return c.json(
      {
        error: '設定に資格情報の値が直接書かれているため、登録しませんでした',
        fields: inline,
        fix: `値はブローカーに渡し (PUT ${BROKER_PUBLIC_URL}/secrets/${slug}/<名前> に { "value": "..." })、config には {{secret:<名前>}} と書いてください`,
      },
      400,
    );
  }
  await pool.query(
    `INSERT INTO connections (project_slug, name, kind, description, config)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_slug, name) DO UPDATE
       SET kind = EXCLUDED.kind, description = EXCLUDED.description,
           config = EXCLUDED.config, status = 'unverified',
           last_error = NULL, checked_at = NULL`,
    [slug, name, kind, body.description ?? '', JSON.stringify(body.config)],
  );
  return c.json({ ok: true, name, kind, status: 'unverified' });
});

app.get('/projects/:slug/connections', async (c) => {
  await ensureSchema();
  const res = await pool.query(
    `SELECT name, kind, description, config, status, last_error, checked_at
     FROM connections WHERE project_slug = $1 ORDER BY name`,
    [c.req.param('slug')],
  );
  return c.json({
    connections: res.rows.map((r) => ({ ...r, config: maskConfig(r.config) })),
  });
});

app.delete('/projects/:slug/connections/:name', async (c) => {
  await ensureSchema();
  await pool.query(
    'DELETE FROM connections WHERE project_slug = $1 AND name = $2',
    [c.req.param('slug'), c.req.param('name')],
  );
  return c.json({ ok: true });
});

// アウトカムへのフィードバック (1〜5 点)。ビジネスアナリストが振り返りでズレの確認に使う
app.post('/projects/:slug/feedback', async (c) => {
  const slug = c.req.param('slug');
  if (!(await projectExists(slug))) return c.json({ error: 'not found' }, 404);
  const { score, comment } = await c.req.json<{ score: number; comment?: string }>();
  if (!Number.isFinite(score) || score < 1 || score > 5) {
    return c.json({ error: 'score must be 1-5' }, 400);
  }
  await pool.query(
    `INSERT INTO metric_samples (project_slug, key, value, unit, source, detail)
     VALUES ($1, 'outcome_fit_feedback', $2, '点', 'user-feedback', $3)`,
    [slug, score, JSON.stringify({ comment: comment ?? '' })],
  );
  return c.json({ ok: true });
});

// 振り返りに必要な指標の一覧 (誰が・何を・どこから取るか)
app.get('/metrics/catalog', (c) => c.json({ metrics: CATALOG, codeOfConduct: CODE_OF_CONDUCT }));

// 最新の指標と改善アクション
app.get('/projects/:slug/metrics', async (c) => {
  await ensureSchema();
  const slug = c.req.param('slug');
  const metrics = await pool.query(
    `SELECT DISTINCT ON (key) key, value, unit, source, collected_at
     FROM metric_samples
     WHERE project_slug = $1 AND key <> 'outcome_fit_feedback'
     ORDER BY key, collected_at DESC`,
    [slug],
  );
  const improvements = await pool.query(
    `SELECT id, week, owner, action, metric_key, baseline, target, status, result_value
     FROM improvements WHERE project_slug = $1 ORDER BY id DESC LIMIT 50`,
    [slug],
  );
  return c.json({ metrics: metrics.rows, improvements: improvements.rows });
});

// 週次の振り返りを手動で1回回す (通常は Temporal Schedule が月曜 09:00 に起動する)
app.post('/projects/:slug/retro/run', async (c) => {
  const client = await getClient();
  const slug = c.req.param('slug');
  if (!(await projectExists(slug))) return c.json({ error: 'not found' }, 404);
  const handle = await client.workflow.start('retroWorkflow', {
    workflowId: `retro-manual-${slug}-${Date.now()}`,
    taskQueue: TASK_QUEUE,
    args: [slug],
  });
  return c.json({ reportPath: await handle.result() });
});

// インフラチェックを手動で1回回す (通常は Temporal Schedule が毎日 08:00 に起動する)
app.post('/projects/:slug/infra-check/run', async (c) => {
  const client = await getClient();
  const slug = c.req.param('slug');
  if (!(await projectExists(slug))) return c.json({ error: 'not found' }, 404);
  const handle = await client.workflow.start('infraCheckWorkflow', {
    workflowId: `infra-manual-${slug}-${Date.now()}`,
    taskQueue: TASK_QUEUE,
    args: [slug],
  });
  return c.json({ anomalies: await handle.result() });
});

const PORT = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port: PORT });
console.log(`kobun api listening on :${PORT}`);
