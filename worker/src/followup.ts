// 仕事の期限・所有者と、期限切れの段階的な格上げ (純粋関数。Workflow からも Activity からも読む)。
//
// 対象は、ボードの「未解決の質問」と「やること」。どちらも担当 (owner) と期限 (due) を持つ。
// 期限を過ぎると、巡回 (patrolWorkflow) が段階を1つずつ上げる:
//
//   段階 1  担当ロールに催促する
//   段階 2  PjM に上げ、チーフの判断待ち一覧 (digest) に載せる   … 段階 1 から 24 時間たっても残っている場合
//   段階 3  ユーザーのフィードに出す                           … 段階 2 から 24 時間たっても残っている場合
//
// 段階 3 から先は何もしない (同じ項目を繰り返し通知しない)。期限を引き直すと段階は 0 に戻る。
// 段階を上げるのはコードで、LLM は関わらない。
import { ROLES, isRoleId, type RoleId } from './agents/roles';

/** 期限を付ける種類 */
export type DueKind = 'question' | 'task';

/** 期限を省いたときの既定 (時間)。質問は 2 日、やることは 1 週間 (振り返りの周期に合わせる) */
export const DEFAULT_DUE_HOURS: Record<DueKind, number> = { question: 48, task: 168 };
/** 次の段階へ上げるまでの猶予 */
export const ESCALATION_GRACE_MS = 24 * 3_600_000;
/** 承認待ちのルール提案の期限 (日)。過ぎても自動では適用も却下もしない */
export const PROPOSAL_DUE_DAYS = 7;
/** 保留した実装タスクを、チーフの判断待ち一覧に1回だけ載せるまでの日数 */
export const PARKED_REMIND_DAYS = 3;
export const MAX_ESCALATION = 3;

const HOUR = 3_600_000;
const JST_OFFSET = 9 * HOUR;

export function isDueKind(kind: string): kind is DueKind {
  return kind === 'question' || kind === 'task';
}

/**
 * 期限の指定を時刻 (ms) にする。読めなければ null。
 *   "36h" / "3d" / "1w"   いまからの相対
 *   "2026-11-21"          その日の終わり (日本時間 23:59)
 *   "2026-11-21T15:00"    日本時間のその時刻 (タイムゾーン付きならそれに従う)
 */
export function parseDue(v: string | undefined | null, nowMs: number): number | null {
  const s = (v ?? '').trim().toLowerCase();
  if (!s) return null;
  const rel = /^(\d{1,4})\s*(h|d|w)$/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    if (n <= 0) return null;
    return nowMs + n * (rel[2] === 'h' ? HOUR : rel[2] === 'd' ? 24 * HOUR : 7 * 24 * HOUR);
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (day) {
    const t = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59) - JST_OFFSET;
    return Number.isFinite(t) ? t : null;
  }
  const at = /^(\d{4})-(\d{2})-(\d{2})t(\d{2}):(\d{2})(?::\d{2})?(z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (at) {
    if (at[6]) {
      const t = Date.parse(s.toUpperCase());
      return Number.isFinite(t) ? t : null;
    }
    const t =
      Date.UTC(Number(at[1]), Number(at[2]) - 1, Number(at[3]), Number(at[4]), Number(at[5])) -
      JST_OFFSET;
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** 期限を省いた・読めなかったときも含めて、期限を決める */
export function dueFor(kind: DueKind, v: string | undefined | null, nowMs: number): number {
  return parseDue(v, nowMs) ?? nowMs + DEFAULT_DUE_HOURS[kind] * HOUR;
}

/** 担当になれるのは、プロジェクトのロールとユーザー */
export type Owner = RoleId | 'user';

/**
 * 担当を決める。指定が無い・不正なときは、書いた本人 (プロジェクトのロールの場合)。
 * 本人がプロジェクトのロールでない (チーフ・ユーザー) ときは PjM。
 */
export function ownerFor(v: string | undefined | null, author: string): Owner {
  const s = (v ?? '').trim().toLowerCase();
  if (s === 'user') return 'user';
  if (isRoleId(s) && ROLES[s].scope === 'project') return s;
  return isRoleId(author) && ROLES[author].scope === 'project' ? author : 'pjm';
}

export function ownerTitle(owner: string): string {
  if (owner === 'user') return 'ユーザー';
  return isRoleId(owner) ? ROLES[owner].title : owner;
}

function span(ms: number): string {
  const h = Math.abs(ms) / HOUR;
  if (h < 1) return `${Math.max(1, Math.round(Math.abs(ms) / 60_000))}分`;
  if (h < 48) return `${Math.round(h)}時間`;
  return `${Math.round(h / 24)}日`;
}

/** ボードに出す期限の表示 */
export function dueLabel(dueMs: number, nowMs: number): string {
  return dueMs >= nowMs ? `期限 あと${span(dueMs - nowMs)}` : `期限切れ ${span(nowMs - dueMs)}超過`;
}

export interface DueItem {
  /** B-12 の形 */
  code: string;
  slug: string;
  projectName: string;
  kind: DueKind;
  text: string;
  owner: string;
  dueMs: number;
  /** いまの段階 (0 = まだ何もしていない) */
  level: number;
  /** 最後に段階を上げた時刻 */
  escalatedMs: number | null;
}

export interface EscalationStep {
  level: 1 | 2 | 3;
  /** プロジェクト内のロールへ送る催促 */
  nudge?: { to: RoleId; content: string };
  /** チーフの判断待ち一覧に載せる */
  chief?: boolean;
  /** ユーザーのフィードに出す */
  user?: boolean;
}

const KIND_NAME: Record<DueKind, string> = { question: '未解決の質問', task: 'やること' };

function describe(item: DueItem, nowMs: number): string {
  return `[${item.code}] ${item.text.replace(/\s*\n\s*/g, ' ')} (${KIND_NAME[item.kind]}、担当 ${ownerTitle(item.owner)}、${dueLabel(item.dueMs, nowMs)})`;
}

const HOW_TO_CLOSE = [
  '次のどちらかを、この発言の中で行ってください。',
  '- 片付いた・不要になった: <board-resolve id="B-番号">結果</board-resolve> でボードから下ろす。',
  '- まだ掛かる: <board-due id="B-番号" due="2d">遅れている理由と、次に何をするか</board-due> で期限を引き直す。',
  'どちらもしない場合、24 時間後に次の段階 (PjM → ユーザー) へ上がります。',
].join('\n');

/**
 * 期限を過ぎた項目について、いま上げるべき段階を返す。上げるものが無ければ null。
 * 担当がユーザーの項目は、エージェントを催促しても進まないので、直接ユーザーに出す。
 */
export function nextEscalation(item: DueItem, nowMs: number): EscalationStep | null {
  if (nowMs < item.dueMs || item.level >= MAX_ESCALATION) return null;
  const owner = item.owner;
  if (!isRoleId(owner) || ROLES[owner].scope !== 'project') {
    return { level: 3, user: true };
  }
  if (item.level <= 0) {
    return {
      level: 1,
      nudge: {
        to: owner,
        content: [`あなたが担当の項目が期限を過ぎています。`, describe(item, nowMs), '', HOW_TO_CLOSE].join('\n'),
      },
    };
  }
  if (nowMs - (item.escalatedMs ?? item.dueMs) < ESCALATION_GRACE_MS) return null;
  if (item.level === 1) {
    return {
      level: 2,
      chief: true,
      // 担当が PjM 自身なら、同じ催促を繰り返さない (チーフの一覧にだけ載せる)
      ...(owner === 'pjm'
        ? {}
        : {
            nudge: {
              to: 'pjm' as RoleId,
              content: [
                `担当 (${ownerTitle(owner)}) に催促しましたが、24 時間たっても片付いていません。PjM として、担当を変える・期限を引き直す・不要として下ろす、のどれかを決めてください。`,
                describe(item, nowMs),
                '',
                HOW_TO_CLOSE,
              ].join('\n'),
            },
          }),
    };
  }
  return { level: 3, user: true };
}

export interface ParkedItem {
  id: number;
  sessionId: string;
  request: string;
  /** 保留してからの経過 (ms) */
  ageMs: number;
}
export interface ProposalItem {
  id: number;
  project: string;
  layer: string;
  summary: string;
  /** 期限からの超過 (ms) */
  overdueMs: number;
}

export interface DigestInput {
  escalated: DueItem[];
  parked: ParkedItem[];
  proposals: ProposalItem[];
}

/**
 * チーフに渡す「判断待ちの一覧」。新しく載せるものが無ければ null (チーフを起こさない)。
 * 同じ項目は一度しか載らない (呼び出し側が、載せた印を付ける)。
 */
export function renderChiefDigest(input: DigestInput, nowMs: number): string | null {
  const { escalated, parked, proposals } = input;
  if (escalated.length + parked.length + proposals.length === 0) return null;
  const lines = [
    '巡回の結果です。止まっている仕事のうち、あなたの判断が要るものを新しく見つけました (同じ項目は二度と載りません)。',
    'それぞれについて「PjM に指示する」「ユーザーに判断を仰ぐ」「いまは何もしない」のどれかを決めてください。',
    '- PjM への指示は <message to="pjm" project="slug">…</message>、ユーザーへの連絡は <message to="user">…</message> で書く (この通知への返信は誰にも届きません)。',
    '- ユーザーへは、判断が要るものだけを、まとめて1通で伝える。却下・保留と決まったものを蒸し返さない。',
  ];
  if (escalated.length > 0) {
    lines.push('', '## 期限を過ぎ、担当に催促しても片付かなかった項目 (PjM にも通知済み)');
    for (const e of escalated) lines.push(`- ${e.projectName} (${e.slug}): ${describe(e, nowMs)}`);
  }
  if (parked.length > 0) {
    lines.push(
      '',
      '## 回答が無いまま保留になっている実装タスク',
      'ユーザーが回答すれば再開できる (対話コマンド `/resume <番号> <回答>`)。不要なら `/drop <番号>`。',
    );
    for (const p of parked) {
      lines.push(`- #${p.id} (${span(p.ageMs)}前に保留): ${p.request.replace(/\s*\n\s*/g, ' ').slice(0, 200)}`);
    }
  }
  if (proposals.length > 0) {
    lines.push(
      '',
      '## 承認の期限を過ぎたルール変更の提案 (自動では適用も却下もされない)',
      'ユーザーに `/proposals` で確認し、`/approve <番号>` か `/reject <番号>` で決めてもらう。',
    );
    for (const p of proposals) {
      lines.push(`- #${p.id} [${p.layer}] ${p.summary.slice(0, 200)} (${p.project}、期限から${span(p.overdueMs)})`);
    }
  }
  return lines.join('\n');
}

/** ルールの文面の比較用 (空白と文末の句点の違いを無視する) */
export function normalizeRuleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(/[。.]+$/, '');
}

/** grilling の質問と回答で、実装依頼を補強する (回答が期限内でも、保留からの再開でも同じ形) */
export function enrichImplRequest(request: string, questions: string[], answer: string): string {
  return [
    `実装依頼: ${request}`,
    '',
    '要件確認 (grilling) の質問:',
    ...questions.map((q, i) => `${i + 1}. ${q}`),
    '',
    '依頼者からの回答:',
    answer,
  ].join('\n');
}
