import { pool, ensureSchema } from './db';
import type { RoleId } from './agents/roles';
import { LAYER_LABEL } from './rules';
import type { RuleScope } from './agents/protocol';
import {
  PARKED_REMIND_DAYS,
  isDueKind,
  nextEscalation,
  ownerTitle,
  renderChiefDigest,
  dueLabel,
  type DueItem,
  type ParkedItem,
  type ProposalItem,
} from './followup';

// 巡回 (patrolWorkflow) と、保留した実装タスクの再開。
// 止まっている仕事を見つけて段階を上げるのはコードで、LLM は関わらない。
// チーフ (LLM) を起こすのは、判断が要るものを新しく見つけたときだけ。

// ---------------------------------------------------------------------------
// 巡回
// ---------------------------------------------------------------------------

export interface PatrolNudge {
  slug: string;
  to: RoleId;
  content: string;
}
export interface PatrolResult {
  /** プロジェクト内のロールへ送る催促 (Workflow が配送する) */
  nudges: PatrolNudge[];
  /** チーフに渡す判断待ちの一覧。新しく載せるものが無ければ null */
  chiefDigest: string | null;
  /** 今回ユーザーのフィードに出した件数 */
  surfaced: number;
  /** 期限を過ぎて残っている項目の総数 (段階を上げなかったものも含む) */
  overdue: number;
}

const KIND_NAME = { question: '未解決の質問', task: 'やること' } as const;

/**
 * 全プロジェクトを走査し、期限を過ぎた仕事の段階を上げる。
 * 段階の更新・ユーザーへの通知・「一覧に載せた」印は、1つのトランザクションで確定する
 * (途中で失敗してリトライされても、同じ項目を二重に通知しない)。
 */
export async function patrolSweep(nowMs: number = Date.now()): Promise<PatrolResult> {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query(
      `SELECT b.id, b.project_slug, b.kind, b.text, b.owner, b.due_at, b.escalation, b.escalated_at,
              p.name AS project_name
       FROM board b JOIN projects p ON p.slug = b.project_slug
       WHERE b.status = 'active' AND b.kind IN ('question', 'task')
         AND b.due_at IS NOT NULL AND b.due_at < $1
       ORDER BY b.id
       FOR UPDATE OF b`,
      [new Date(nowMs)],
    );
    const nudges: PatrolNudge[] = [];
    const escalated: DueItem[] = [];
    let surfaced = 0;
    for (const r of rows.rows) {
      if (!isDueKind(String(r.kind))) continue;
      const item: DueItem = {
        code: `B-${r.id}`,
        slug: String(r.project_slug),
        projectName: String(r.project_name),
        kind: r.kind,
        text: String(r.text),
        owner: String(r.owner ?? 'pjm'),
        dueMs: new Date(r.due_at).getTime(),
        level: Number(r.escalation),
        escalatedMs: r.escalated_at ? new Date(r.escalated_at).getTime() : null,
      };
      const step = nextEscalation(item, nowMs);
      if (!step) continue;
      await client.query('UPDATE board SET escalation = $2, escalated_at = $3 WHERE id = $1', [
        r.id,
        step.level,
        new Date(nowMs),
      ]);
      if (step.nudge) nudges.push({ slug: item.slug, to: step.nudge.to, content: step.nudge.content });
      if (step.chief) escalated.push({ ...item, level: step.level });
      if (step.user) {
        surfaced += 1;
        await client.query(
          `INSERT INTO user_feed (project_slug, source, kind, title, body)
           VALUES ($1, 'system', 'request', $2, $3)`,
          [
            item.slug,
            `${item.projectName}: 期限を過ぎた${KIND_NAME[item.kind]} ${item.code}`,
            [
              item.text,
              '',
              `担当: ${ownerTitle(item.owner)} / ${dueLabel(item.dueMs, nowMs)}`,
              item.owner === 'user'
                ? 'あなたの回答・判断を待っています。チーフに伝えるか、ボードに直接書いてください。'
                : '担当と PjM に催促しましたが、片付いていません。',
              `不要なら下ろせます: \`/done ${item.slug} ${item.code} <理由>\``,
              'この項目について、これ以上の通知は出ません。',
            ].join('\n'),
          ],
        );
      }
    }

    // 保留になって PARKED_REMIND_DAYS 日たった実装タスク (一覧に載せるのは1回だけ)
    const parkedRows = await client.query(
      `UPDATE parked_tasks SET reminded_at = $1::timestamptz
       WHERE status = 'timeout_parked' AND reminded_at IS NULL
         AND created_at < $1::timestamptz - ($2 || ' days')::interval
       RETURNING id, session_id, request, created_at`,
      [new Date(nowMs), String(PARKED_REMIND_DAYS)],
    );
    const parked: ParkedItem[] = parkedRows.rows
      .map((r) => ({
        id: Number(r.id),
        sessionId: String(r.session_id),
        request: String(r.request),
        ageMs: nowMs - new Date(r.created_at).getTime(),
      }))
      .sort((a, b) => a.id - b.id);

    // 承認の期限を過ぎたルール提案 (一覧に載せるのは1回だけ。自動では適用も却下もしない)
    const proposalRows = await client.query(
      `UPDATE rule_proposals SET reminded_at = $1
       WHERE status = 'pending' AND reminded_at IS NULL AND due_at < $1
       RETURNING id, project_slug, scope, kind, target_code, text, reason, due_at`,
      [new Date(nowMs)],
    );
    const proposals: ProposalItem[] = proposalRows.rows
      .map((r) => ({
        id: Number(r.id),
        project: String(r.project_slug),
        layer: LAYER_LABEL[r.scope as RuleScope] ?? String(r.scope),
        summary:
          r.kind === 'retire'
            ? `${r.target_code} を廃止 (理由: ${r.reason || '記載なし'})`
            : `${r.kind === 'replace' ? `${r.target_code} を置換: ` : '追加: '}${r.text}`,
        overdueMs: nowMs - new Date(r.due_at).getTime(),
      }))
      .sort((a, b) => a.id - b.id);

    await client.query('COMMIT');
    return {
      nudges,
      chiefDigest: renderChiefDigest({ escalated, parked, proposals }, nowMs),
      surfaced,
      overdue: rows.rows.length,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// 判断待ちの一覧 (ユーザーが /pending で見る。巡回と違い、何度見ても同じものが出る)
// ---------------------------------------------------------------------------

export interface PendingOverview {
  overdue: {
    project: string;
    code: string;
    kind: string;
    text: string;
    owner: string;
    dueAt: string;
    escalation: number;
  }[];
  parked: { id: number; sessionId: string; request: string; questions: string[]; createdAt: string }[];
  proposals: {
    id: number;
    project: string;
    scope: string;
    kind: string;
    targetCode: string | null;
    text: string;
    reason: string;
    dueAt: string;
    overdue: boolean;
  }[];
}

export async function pendingOverview(nowMs: number = Date.now()): Promise<PendingOverview> {
  await ensureSchema();
  const overdue = await pool.query(
    `SELECT project_slug, id, kind, text, owner, due_at, escalation FROM board
     WHERE status = 'active' AND kind IN ('question', 'task') AND due_at < $1
     ORDER BY due_at`,
    [new Date(nowMs)],
  );
  const parked = await listParked();
  const proposals = await pool.query(
    `SELECT id, project_slug, scope, kind, target_code, text, reason, due_at
     FROM rule_proposals WHERE status = 'pending' ORDER BY id`,
  );
  return {
    overdue: overdue.rows.map((r) => ({
      project: String(r.project_slug),
      code: `B-${r.id}`,
      kind: String(r.kind),
      text: String(r.text),
      owner: String(r.owner ?? ''),
      dueAt: new Date(r.due_at).toISOString(),
      escalation: Number(r.escalation),
    })),
    parked,
    proposals: proposals.rows.map((r) => ({
      id: Number(r.id),
      project: String(r.project_slug),
      scope: String(r.scope),
      kind: String(r.kind),
      targetCode: r.target_code ?? null,
      text: String(r.text),
      reason: String(r.reason),
      dueAt: new Date(r.due_at).toISOString(),
      overdue: new Date(r.due_at).getTime() < nowMs,
    })),
  };
}

// ---------------------------------------------------------------------------
// 保留した実装タスク (ask-a-person の回答期限切れ) の再開
// ---------------------------------------------------------------------------

export interface ParkedTask {
  id: number;
  sessionId: string;
  request: string;
  questions: string[];
  createdAt: string;
}

function toParked(r: any): ParkedTask {
  return {
    id: Number(r.id),
    sessionId: String(r.session_id),
    request: String(r.request),
    questions: Array.isArray(r.questions) ? r.questions.map(String) : [],
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/** 保留中の実装タスク (古い順) */
export async function listParked(): Promise<ParkedTask[]> {
  await ensureSchema();
  const res = await pool.query(
    `SELECT id, session_id, request, questions, created_at FROM parked_tasks
     WHERE status = 'timeout_parked' ORDER BY id`,
  );
  return res.rows.map(toParked);
}

/** そのセッションで最後に保留になったタスク (無ければ null) */
export async function latestParkedFor(sessionId: string): Promise<ParkedTask | null> {
  await ensureSchema();
  const res = await pool.query(
    `SELECT id, session_id, request, questions, created_at FROM parked_tasks
     WHERE status = 'timeout_parked' AND session_id = $1 ORDER BY id DESC LIMIT 1`,
    [sessionId],
  );
  return res.rows[0] ? toParked(res.rows[0]) : null;
}

/**
 * 再開のために、保留中のタスクを1つ確保する。二重に再開されないよう、保留中のものだけを取る。
 * 取れなければ null (存在しない・再開済み・取り下げ済み)。
 */
export async function claimParked(id: number): Promise<ParkedTask | null> {
  await ensureSchema();
  const res = await pool.query(
    `UPDATE parked_tasks SET status = 'resuming'
     WHERE id = $1 AND status = 'timeout_parked'
     RETURNING id, session_id, request, questions, created_at`,
    [id],
  );
  return res.rows[0] ? toParked(res.rows[0]) : null;
}

/** 再開をセッションに渡せたら確定する。渡せなかったら保留中に戻す */
export async function settleParked(id: number, answer: string | null): Promise<void> {
  if (answer === null) {
    await pool.query(
      `UPDATE parked_tasks SET status = 'timeout_parked' WHERE id = $1 AND status = 'resuming'`,
      [id],
    );
    return;
  }
  await pool.query(
    `UPDATE parked_tasks SET status = 'resumed', answer = $2, closed_at = now()
     WHERE id = $1 AND status = 'resuming'`,
    [id, answer],
  );
}

/** 不要になったタスクを取り下げる (以後、巡回の一覧に載らない)。対象が無ければ false */
export async function dropParked(id: number, reason: string): Promise<boolean> {
  await ensureSchema();
  const res = await pool.query(
    `UPDATE parked_tasks SET status = 'dropped', answer = $2, closed_at = now()
     WHERE id = $1 AND status = 'timeout_parked'`,
    [id, reason ? `(取り下げ) ${reason}` : '(取り下げ)'],
  );
  return (res.rowCount ?? 0) > 0;
}
