import { pool, ensureSchema } from './db';
import type { OutRule, OutRuleRetire, RuleScope } from './agents/protocol';
import type { RuleChange } from './metrics/report';
import { PROPOSAL_DUE_DAYS, normalizeRuleText } from './followup';

// 行動ルールの3層 (kobun 共通 → クライアント → プロジェクト)。
// 下の層が上の層を上書きする。すべての層が振り返りで追加・置換・廃止される。

export const LAYER_LABEL: Record<RuleScope, string> = {
  common: 'kobun 共通',
  client: 'クライアント',
  project: 'プロジェクト',
};
const PREFIX: Record<RuleScope, string> = { common: 'K', client: 'C', project: 'P' };

export interface RuleRow {
  code: string;
  text: string;
}
export interface RuleLayers {
  common: RuleRow[];
  client: RuleRow[];
  project: RuleRow[];
}
export interface RuleTarget {
  /** プロジェクトの slug */
  slug: string;
  /** クライアントの slug */
  client: string;
}

function scopeKey(scope: RuleScope, t: RuleTarget): string {
  return scope === 'common' ? '' : scope === 'client' ? t.client : t.slug;
}

function scopeOfCode(code: string): RuleScope | null {
  const p = code.trim().toUpperCase()[0];
  return p === 'K' ? 'common' : p === 'C' ? 'client' : p === 'P' ? 'project' : null;
}

export async function activeRules(t: RuleTarget): Promise<RuleLayers> {
  await ensureSchema();
  const res = await pool.query(
    `SELECT scope, code, text FROM rules
     WHERE status = 'active' AND (
       (scope = 'common' AND scope_key = '') OR
       (scope = 'client' AND scope_key = $1) OR
       (scope = 'project' AND scope_key = $2))
     ORDER BY id`,
    [t.client, t.slug],
  );
  const layers: RuleLayers = { common: [], client: [], project: [] };
  for (const r of res.rows) {
    layers[r.scope as RuleScope].push({ code: r.code, text: r.text });
  }
  return layers;
}

/** ロールのプロンプトに入れる形 */
export function renderRules(layers: RuleLayers): string {
  const section = (scope: RuleScope) =>
    [
      `### ${LAYER_LABEL[scope]}のルール`,
      layers[scope].length === 0
        ? '(なし)'
        : layers[scope].map((r) => `- [${r.code}] ${r.text}`).join('\n'),
    ].join('\n');
  return [
    '## 行動ルール (必ず従う)',
    '3層ある。矛盾する場合は プロジェクト > クライアント > kobun 共通 の順に優先する (下の層が上書きする)。',
    section('common'),
    section('client'),
    section('project'),
  ].join('\n\n');
}

async function addRule(
  scope: RuleScope,
  key: string,
  text: string,
  source: string,
): Promise<string> {
  // ID は層ごとの通し番号。廃止したルールの番号は再利用しない
  const res = await pool.query(
    `INSERT INTO rules (scope, scope_key, code, text, source)
     SELECT $1, $2, $3 || '-' || (count(*) + 1), $4, $5
     FROM rules WHERE scope = $1 AND scope_key = $2
     RETURNING code`,
    [scope, key, PREFIX[scope], text, source],
  );
  return res.rows[0].code as string;
}

async function retireRule(
  scope: RuleScope,
  key: string,
  code: string,
  reason: string,
): Promise<string | null> {
  const res = await pool.query(
    `UPDATE rules SET status = 'retired', retired_at = now(), retired_reason = $4
     WHERE scope = $1 AND scope_key = $2 AND code = $3 AND status = 'active'
     RETURNING text`,
    [scope, key, code, reason],
  );
  return (res.rows[0]?.text as string | undefined) ?? null;
}

/** 承認が要る層 (他のプロジェクトにも効く層) */
export function needsApproval(scope: RuleScope): boolean {
  return scope === 'common' || scope === 'client';
}

const KIND_LABEL: Record<string, string> = { add: '追加', replace: '置換', retire: '廃止' };

async function propose(
  t: RuleTarget,
  scope: RuleScope,
  kind: 'add' | 'replace' | 'retire',
  targetCode: string | null,
  text: string,
  reason: string,
  source: string,
): Promise<RuleChange> {
  // すでに有効な同じ文面のルールがあれば、提案しない (承認済みの提案を、もう一度出さないため)
  if (kind === 'add' || kind === 'replace') {
    const active = await pool.query(
      `SELECT code, text FROM rules WHERE status = 'active' AND scope = $1 AND scope_key = $2`,
      [scope, scopeKey(scope, t)],
    );
    const dup = active.rows.find((r) => normalizeRuleText(String(r.text)) === normalizeRuleText(text));
    if (dup) {
      return {
        layer: LAYER_LABEL[scope],
        op: `提案せず (同じルールが ${dup.code} として有効)`,
        code: '-',
        text,
      };
    }
  }
  // 同じ提案が承認待ちなら重ねない。ユーザーが却下した提案は蒸し返さない。
  // 「同じ」の判定: 層・対象・操作が同じで、文面が同じ (廃止は対象のルールが同じ)
  const prior = await pool.query(
    `SELECT id, status, text FROM rule_proposals
     WHERE scope = $1 AND scope_key = $2 AND kind = $3 AND coalesce(target_code, '') = $4
       AND status IN ('pending', 'rejected')
     ORDER BY id DESC`,
    [scope, scopeKey(scope, t), kind, targetCode ?? ''],
  );
  const same = prior.rows.find(
    (r) => kind === 'retire' || normalizeRuleText(String(r.text)) === normalizeRuleText(text),
  );
  if (same) {
    return {
      layer: LAYER_LABEL[scope],
      op:
        same.status === 'rejected'
          ? `提案せず (過去に却下済み #${same.id})`
          : `提案せず (承認待ち #${same.id} と同じ)`,
      code: '-',
      text: kind === 'retire' ? `${targetCode} の廃止: ${reason || '記載なし'}` : text,
    };
  }
  const res = await pool.query(
    `INSERT INTO rule_proposals (project_slug, scope, scope_key, kind, target_code, text, reason, source, due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' days')::interval) RETURNING id`,
    [t.slug, scope, scopeKey(scope, t), kind, targetCode, text, reason, source, String(PROPOSAL_DUE_DAYS)],
  );
  const id = Number(res.rows[0].id);
  return {
    layer: LAYER_LABEL[scope],
    op: `承認待ち (${KIND_LABEL[kind]}${targetCode ? ` ${targetCode}` : ''})`,
    code: `提案 #${id}`,
    text: kind === 'retire' ? `廃止の理由: ${reason || '記載なし'}` : text,
    proposalId: id,
  };
}

/**
 * ルールの追加・置換・廃止を適用し、何が変わったかを返す (改善レポートに載る)。
 * 置換・廃止の対象層はルール ID の接頭辞 (K / C / P) で決まる。
 *
 * requireApproval が true のとき (振り返りからの変更)、kobun 共通とクライアントの層は
 * 適用せずに承認待ちとして記録する。プロジェクトの層は即時に適用する。
 */
export async function applyRuleChanges(
  t: RuleTarget,
  rules: OutRule[],
  retires: OutRuleRetire[],
  source: string,
  opts: { requireApproval?: boolean } = {},
): Promise<RuleChange[]> {
  await ensureSchema();
  const changes: RuleChange[] = [];
  for (const r of rules) {
    const replacedScope = r.replaces ? scopeOfCode(r.replaces) : null;
    const scope = replacedScope ?? r.scope;
    const key = scopeKey(scope, t);
    if (scope === 'client' && !key) {
      changes.push({
        layer: LAYER_LABEL[scope],
        op: '適用できず',
        code: '-',
        text: `${r.text} (プロジェクトにクライアントが設定されていない)`,
      });
      continue;
    }
    const replaces = r.replaces && replacedScope ? r.replaces : null;
    if (opts.requireApproval && needsApproval(scope)) {
      changes.push(
        await propose(t, scope, replaces ? 'replace' : 'add', replaces, r.text, '', source),
      );
      continue;
    }
    changes.push(await applyOne(scope, key, replaces, r.text, source));
  }
  for (const x of retires) {
    const scope = scopeOfCode(x.id);
    if (scope && opts.requireApproval && needsApproval(scope)) {
      changes.push(await propose(t, scope, 'retire', x.id, '', x.reason, source));
      continue;
    }
    changes.push(await retireOne(scope, scope ? scopeKey(scope, t) : '', x.id, x.reason));
  }
  return changes;
}

async function applyOne(
  scope: RuleScope,
  key: string,
  replaces: string | null,
  text: string,
  source: string,
): Promise<RuleChange> {
  let op = '追加';
  if (replaces) {
    const old = await retireRule(scope, key, replaces, '置換');
    op = old === null ? `追加 (置換対象 ${replaces} は存在しない)` : `置換 (${replaces} を廃止)`;
  }
  const code = await addRule(scope, key, text, source);
  return { layer: LAYER_LABEL[scope], op, code, text };
}

async function retireOne(
  scope: RuleScope | null,
  key: string,
  code: string,
  reason: string,
): Promise<RuleChange> {
  const old = scope ? await retireRule(scope, key, code, reason) : null;
  return {
    layer: scope ? LAYER_LABEL[scope] : '-',
    op: old === null ? '廃止できず (ID が存在しない)' : '廃止',
    code,
    text: old === null ? reason : `${old} (理由: ${reason || '記載なし'})`,
  };
}

/**
 * 承認待ちのルール変更を、ユーザーの判断で確定する。
 * 承認なら適用して変更内容を返す。却下なら何も適用しない。既に確定済みなら null。
 */
export async function decideProposal(
  id: number,
  approve: boolean,
): Promise<{ status: 'approved' | 'rejected'; change: RuleChange | null } | null> {
  await ensureSchema();
  const status = approve ? 'approved' : 'rejected';
  // 二重に適用されないよう、pending のものだけを確定する
  const res = await pool.query(
    `UPDATE rule_proposals SET status = $2, decided_at = now()
     WHERE id = $1 AND status = 'pending'
     RETURNING scope, scope_key, kind, target_code, text, reason, source`,
    [id, status],
  );
  const p = res.rows[0];
  if (!p) return null;
  if (!approve) return { status, change: null };
  const scope = p.scope as RuleScope;
  const change =
    p.kind === 'retire'
      ? await retireOne(scope, p.scope_key, p.target_code, p.reason)
      : await applyOne(scope, p.scope_key, p.target_code, p.text, `${p.source}:承認 #${id}`);
  return { status, change };
}
