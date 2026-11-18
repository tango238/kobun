import { pool, ensureSchema } from './db';
import { ROLES, isRoleId, type RoleId } from './agents/roles';
import {
  parseOutput,
  type OutBoard,
  type OutBoardDue,
  type OutBoardResolve,
} from './agents/protocol';
import { dueFor, dueLabel, isDueKind, ownerFor, ownerTitle, parseDue } from './followup';

// プロジェクトのボード: チーム全員が毎回の発言の前に読む、共有の掲示板。
//
//   共有された情報 (fact)   ユーザーから得た事実・前提・資料の場所
//   決定事項 (decision)     決まったこと (誰が決めたか)
//   未解決の質問 (question) 誰かの回答・判断を待っていること (担当と期限を持つ)
//   やること (task)         誰かが引き受けた仕事 (担当と期限を持つ)
//   メンバーの状況          いま何をしているか / 直前に何をしたか
//
// 行き違いを防ぐための決まり: ボードにあることは問い合わせない。ボードと食い違う話は、ボードを直す。
// 「メンバーの状況」のうち、対応中かどうかと直近の動きは、エージェントの申告ではなく実際の記録から作る。

export type BoardKind = 'fact' | 'decision' | 'question' | 'task';

export const KIND_LABEL: Record<BoardKind, string> = {
  fact: '共有された情報',
  decision: '決定事項',
  question: '未解決の質問',
  task: 'やること',
};
const KINDS: BoardKind[] = ['fact', 'decision', 'question', 'task'];

export interface BoardEntry {
  code: string;
  kind: BoardKind;
  author: string;
  text: string;
  createdAt: string;
  /** 担当と期限 (question / task のみ) */
  owner?: string | null;
  dueAt?: string | null;
}
export interface MemberStatus {
  role: RoleId;
  title: string;
  /** いま発言を作っている最中なら、その開始時刻 (ms) */
  workingSince: number | null;
  /** 本人が書いた「いま取り組んでいること / 次にやること」 */
  note: string;
  noteAt: string | null;
  /** 直前の発言の記録 */
  last: { at: string; from: string; sentTo: string[]; artifacts: string[]; error: boolean } | null;
}
export interface BoardData {
  project: string;
  entries: BoardEntry[];
  members: MemberStatus[];
  activity: { at: string; role: string; from: string; sentTo: string[]; artifacts: string[]; error: boolean }[];
}
export interface TeamNow {
  role: RoleId;
  since: number;
}

const MAX_PER_KIND = 40;
const MAX_ACTIVITY = 12;

function authorTitle(a: string): string {
  if (a === 'user') return 'ユーザー';
  return isRoleId(a) ? ROLES[a].title : a;
}

export async function addBoardEntry(
  slug: string,
  kind: BoardKind,
  author: string,
  text: string,
  opts: { owner?: string; due?: string; nowMs?: number } = {},
): Promise<string> {
  await ensureSchema();
  // 質問とやることには、必ず担当と期限が付く (指定が無ければ既定を入れる)
  const nowMs = opts.nowMs ?? Date.now();
  const owner = isDueKind(kind) ? ownerFor(opts.owner, author) : null;
  const dueAt = isDueKind(kind) ? new Date(dueFor(kind, opts.due, nowMs)) : null;
  const res = await pool.query(
    `INSERT INTO board (project_slug, kind, author, text, owner, due_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [slug, kind, author, text.trim(), owner, dueAt],
  );
  return `B-${res.rows[0].id}`;
}

/**
 * 期限を引き直す (段階は 0 に戻る)。理由は項目の本文に書き足す。
 * 対象が無い・期限が読めない・理由が無いときは、その説明を返す。成功なら null。
 */
export async function setBoardDue(
  slug: string,
  code: string,
  due: string,
  by: string,
  reason: string,
  nowMs: number = Date.now(),
): Promise<string | null> {
  await ensureSchema();
  const id = Number(code.trim().toUpperCase().replace(/^B-/, ''));
  const dueMs = parseDue(due, nowMs);
  if (!Number.isInteger(id)) return `${code} という項目はありません。`;
  if (dueMs === null) return `${code} の期限 "${due}" を読めませんでした ("36h" / "3d" / "2026-11-21" の形で書く)。`;
  if (!reason.trim()) return `${code} の期限は変えていません。遅れている理由と次にやることを書いてください。`;
  // 理由は項目そのものに書き足す (なぜ延びたかが、ボードを読む全員に見える)
  const stamp = new Date(dueMs + 9 * 3_600_000).toISOString().slice(5, 16).replace('T', ' ');
  const note = ` / 期限を ${stamp} に変更 (${by}): ${reason.trim().replace(/\s*\n\s*/g, ' ').slice(0, 200)}`;
  const res = await pool.query(
    `UPDATE board SET due_at = $3, escalation = 0, escalated_at = NULL, text = text || $4
     WHERE project_slug = $1 AND id = $2 AND status = 'active' AND kind IN ('question', 'task')`,
    [slug, id, new Date(dueMs), note],
  );
  if ((res.rowCount ?? 0) === 0) return `ボードに ${code} という期限つきの有効な項目はありません。`;
  return null;
}

/** 解決済み・古くなった項目をボードから下ろす (履歴は残る)。対象が無ければ false */
export async function resolveBoardEntry(
  slug: string,
  code: string,
  by: string,
  reason: string,
): Promise<boolean> {
  await ensureSchema();
  const id = Number(code.trim().toUpperCase().replace(/^B-/, ''));
  if (!Number.isInteger(id)) return false;
  const res = await pool.query(
    `UPDATE board SET status = 'resolved', resolved_by = $3, resolved_reason = $4, resolved_at = now()
     WHERE project_slug = $1 AND id = $2 AND status = 'active' AND kind <> 'status'`,
    [slug, id, by, reason],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function setMemberStatus(slug: string, role: RoleId, text: string): Promise<void> {
  await ensureSchema();
  await pool.query(
    `DELETE FROM board WHERE project_slug = $1 AND kind = 'status' AND author = $2`,
    [slug, role],
  );
  await pool.query(
    `INSERT INTO board (project_slug, kind, author, text) VALUES ($1, 'status', $2, $3)`,
    [slug, role, text.trim().replace(/\s*\n\s*/g, ' ').slice(0, 400)],
  );
}

/** エージェントの出力にあったボード操作を適用する。適用できなかったものの説明を返す */
export async function applyBoardOps(
  slug: string,
  author: string,
  adds: OutBoard[],
  resolves: OutBoardResolve[],
  status: string | null,
  dues: OutBoardDue[] = [],
): Promise<string[]> {
  const notes: string[] = [];
  for (const a of adds) {
    await addBoardEntry(slug, a.kind, author, a.text, { owner: a.owner, due: a.due });
  }
  for (const d of dues) {
    const problem = await setBoardDue(slug, d.id, d.due, author, d.reason);
    if (problem) notes.push(problem);
  }
  for (const r of resolves) {
    if (!(await resolveBoardEntry(slug, r.id, author, r.reason))) {
      notes.push(`ボードに ${r.id} という有効な項目はありません (解決済みにできませんでした)。`);
    }
  }
  if (status && isRoleId(author)) await setMemberStatus(slug, author, status);
  return notes;
}

function summarize(row: { output: string | null }): { sentTo: string[]; artifacts: string[] } {
  const parsed = row.output ? parseOutput(String(row.output)) : null;
  return {
    sentTo: [...new Set(parsed?.messages.map((m) => m.to) ?? [])],
    artifacts: parsed?.artifacts.map((a) => a.path) ?? [],
  };
}

export async function loadBoard(slug: string, now: TeamNow[] = []): Promise<BoardData> {
  await ensureSchema();
  const rows = await pool.query(
    `SELECT id, kind, author, text, created_at, owner, due_at FROM board
     WHERE project_slug = $1 AND status = 'active' ORDER BY id`,
    [slug],
  );
  const turns = await pool.query(
    `SELECT role, sender, output, error, created_at FROM agent_turns
     WHERE project_slug = $1 AND (error IS NULL OR error <> 'routing_violation')
     ORDER BY created_at DESC LIMIT 60`,
    [slug],
  );
  const entries: BoardEntry[] = [];
  const notes = new Map<string, { text: string; at: string }>();
  for (const r of rows.rows) {
    if (r.kind === 'status') {
      notes.set(r.author, { text: r.text, at: new Date(r.created_at).toISOString() });
    } else {
      entries.push({
        code: `B-${r.id}`,
        kind: r.kind,
        author: r.author,
        text: r.text,
        createdAt: new Date(r.created_at).toISOString(),
        owner: r.owner ?? null,
        dueAt: r.due_at ? new Date(r.due_at).toISOString() : null,
      });
    }
  }
  const activity = turns.rows.map((t) => ({
    at: new Date(t.created_at).toISOString(),
    role: String(t.role),
    from: String(t.sender),
    error: t.error !== null,
    ...summarize(t),
  }));
  const members: MemberStatus[] = (Object.keys(ROLES) as RoleId[])
    .filter((id) => ROLES[id].scope === 'project')
    .map((role) => {
      const last = activity.find((a) => a.role === role) ?? null;
      return {
        role,
        title: ROLES[role].title,
        workingSince: now.find((n) => n.role === role)?.since ?? null,
        note: notes.get(role)?.text ?? '',
        noteAt: notes.get(role)?.at ?? null,
        last: last && {
          at: last.at,
          from: last.from,
          sentTo: last.sentTo,
          artifacts: last.artifacts,
          error: last.error,
        },
      };
    });
  return { project: slug, entries, members, activity: activity.slice(0, MAX_ACTIVITY) };
}

function ago(iso: string | number, nowMs: number): string {
  const sec = Math.max(0, Math.round((nowMs - new Date(iso).getTime()) / 1000));
  if (sec < 90) return `${sec}秒前`;
  if (sec < 5400) return `${Math.round(sec / 60)}分前`;
  if (sec < 172800) return `${Math.round(sec / 3600)}時間前`;
  return `${Math.round(sec / 86400)}日前`;
}

/** 担当と期限の表示 (質問とやることだけ) */
function followup(e: BoardEntry, nowMs: number): string {
  const parts = [
    e.owner ? `担当 ${ownerTitle(e.owner)}` : '',
    e.dueAt ? dueLabel(new Date(e.dueAt).getTime(), nowMs) : '',
  ].filter(Boolean);
  return parts.length > 0 ? ` 〔${parts.join('、')}〕` : '';
}

function did(x: { sentTo: string[]; artifacts: string[]; error: boolean }): string {
  if (x.error) return '応答できず';
  const parts = [
    x.sentTo.length > 0 ? `${x.sentTo.join('、')} に送信` : '',
    x.artifacts.length > 0 ? `${x.artifacts.join('、')} を更新` : '',
  ].filter(Boolean);
  return parts.join(' / ') || '送信なし';
}

/**
 * ボードを文章にする (プロンプトと /board の両方で使う。純粋関数)。
 * compact: チーフ向けの短い形 (直近の動きを省く)
 */
export function renderBoard(
  b: BoardData,
  opts: { nowMs?: number; compact?: boolean } = {},
): string {
  const nowMs = opts.nowMs ?? Date.now();
  const lines: string[] = [];
  for (const kind of KINDS) {
    const all = b.entries.filter((e) => e.kind === kind);
    const shown = all.slice(-MAX_PER_KIND);
    lines.push(`### ${KIND_LABEL[kind]} (${all.length} 件)`);
    if (all.length > shown.length) lines.push(`(古い ${all.length - shown.length} 件は省略)`);
    lines.push(
      shown.length === 0
        ? '(なし)'
        : shown
            .map(
              (e) =>
                `- [${e.code}] ${e.text.replace(/\s*\n\s*/g, ' ')}${followup(e, nowMs)} (${authorTitle(e.author)}、${ago(e.createdAt, nowMs)})`,
            )
            .join('\n'),
      '',
    );
  }
  lines.push('### メンバーの状況');
  for (const m of b.members) {
    const state =
      m.workingSince !== null
        ? `対応中 (${ago(m.workingSince, nowMs)}から)`
        : m.last
          ? `待機 (最後の発言 ${ago(m.last.at, nowMs)}: ${did(m.last)})`
          : 'まだ出番なし';
    lines.push(`- ${m.title} (${m.role}): ${state}${m.note ? ` — 本人のメモ: ${m.note}` : ''}`);
  }
  if (!opts.compact) {
    lines.push('', '### 直近の動き (新しい順)');
    lines.push(
      b.activity.length === 0
        ? '(なし)'
        : b.activity
            .map((a) => `- ${ago(a.at, nowMs)} ${a.role} (${a.from} からの依頼): ${did(a)}`)
            .join('\n'),
    );
  }
  return lines.join('\n');
}
