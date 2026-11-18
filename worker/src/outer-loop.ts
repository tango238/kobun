// Outer Loop: 直近 24 時間のエージェントの動きを集計し、つまずきを洗い出す (純粋関数)。
//
// 材料は agent_turns (チーフ・PjM・各ロールの発言の記録)。旧来のセッション (checkpoints) があれば足す。
// 数字はここでコードが集計する。LLM に任せるのは、その数字を根拠にした解釈と改善案だけ。
// LLM が失敗しても、数字のレポートは必ず残る。

import { parseOutput, type OutRule, type OutRuleRetire } from './agents/protocol';
import type { RuleChange } from './metrics/report';

/** 共通ルールの提案を、1回の実行で出せる最大数 */
export const MAX_RULE_PROPOSALS = 3;

export interface TurnRow {
  project_slug: string | null;
  role: string;
  sender: string;
  input: string;
  output: string;
  duration_ms: number;
  error: string | null;
  created_at: Date | string;
}

/** 失敗の種類 (エラー文を、対処が同じものにまとめる) */
export type ErrorKind =
  | 'usage_limit'
  | 'timeout'
  | 'routing_violation'
  | 'auth'
  | 'empty_output'
  | 'other';

export const ERROR_KIND_LABEL: Record<ErrorKind, string> = {
  usage_limit: '利用上限',
  timeout: 'タイムアウト',
  routing_violation: '会話経路の違反',
  auth: '認証',
  empty_output: '空の応答',
  other: 'その他',
};

export function classifyError(error: string | null): ErrorKind | null {
  if (!error) return null;
  const e = error.toLowerCase();
  if (e === 'routing_violation') return 'routing_violation';
  if (/usage limit|5-hour limit|rate.?limit|quota|overloaded|429/.test(e)) return 'usage_limit';
  if (/timed? ?out|timeout|etimedout|deadline/.test(e)) return 'timeout';
  if (/unauthori[sz]ed|authentication|credential|oauth|401|403|api key/.test(e)) return 'auth';
  if (/empty|no output|空/.test(e)) return 'empty_output';
  return 'other';
}

export interface RoleStat {
  role: string;
  turns: number;
  errors: number;
  avgSec: number;
  maxSec: number;
}

export interface ProjectStat {
  project: string;
  turns: number;
  errors: number;
  /** 同じ宛先・同じ書き出しの依頼が繰り返された件数 (2回目以降) */
  repeatedRequests: number;
  /** 空に近い応答 (対応不要) を除いた、実質的な応答の数 */
  substantiveTurns: number;
}

export interface UserInput {
  at: string;
  project: string | null;
  text: string;
}

export interface OuterLoopStats {
  windowHours: number;
  /** 記録の総数 (発言と、経路違反などの記録) */
  records: number;
  turns: number;
  /** 発言のうち失敗したもの */
  failedTurns: number;
  /** 会話経路の違反 (発言には含めない) */
  violations: number;
  /** 失敗の合計 (failedTurns + violations) */
  errors: number;
  errorsByKind: { kind: ErrorKind; label: string; count: number }[];
  roles: RoleStat[];
  projects: ProjectStat[];
  /** 長くかかった発言の上位 */
  slowest: { role: string; project: string | null; sec: number; at: string }[];
  /** ユーザーがチーフに入力したもの (人間の指摘・修正の候補) */
  userInputs: UserInput[];
  legacySessions: number;
}

const toIso = (d: Date | string): string => new Date(d).toISOString();

/** 依頼の書き出し (繰り返しの判定用)。空白をそろえて先頭 60 文字 */
function requestKey(r: TurnRow): string {
  return `${r.project_slug ?? '-'}|${r.role}|${r.input.replace(/\s+/g, ' ').trim().slice(0, 60)}`;
}

const NOOP_OUTPUT = /^\s*(\(?対応不要\)?)?\s*$/;

export function summarizeTurns(
  rows: TurnRow[],
  opts: { windowHours?: number; legacySessions?: number; maxUserInputs?: number } = {},
): OuterLoopStats {
  const windowHours = opts.windowHours ?? 24;
  const errors = rows.filter((r) => r.error);

  const kinds = new Map<ErrorKind, number>();
  for (const r of errors) {
    const k = classifyError(r.error) ?? 'other';
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }

  // 発言として数えるのは、ロールが実際に動いた記録 (経路違反の記録は含めない)
  const turns = rows.filter((r) => r.error !== 'routing_violation');

  const byRole = new Map<string, TurnRow[]>();
  for (const r of turns) byRole.set(r.role, [...(byRole.get(r.role) ?? []), r]);
  const roles: RoleStat[] = [...byRole.entries()]
    .map(([role, rs]) => {
      const secs = rs.map((r) => r.duration_ms / 1000);
      return {
        role,
        turns: rs.length,
        errors: rs.filter((r) => r.error).length,
        avgSec: Math.round(secs.reduce((a, b) => a + b, 0) / Math.max(1, secs.length)),
        maxSec: Math.round(Math.max(0, ...secs)),
      };
    })
    .sort((a, b) => b.turns - a.turns);

  const byProject = new Map<string, TurnRow[]>();
  for (const r of rows) {
    const p = r.project_slug ?? '(チーフ)';
    byProject.set(p, [...(byProject.get(p) ?? []), r]);
  }
  const projects: ProjectStat[] = [...byProject.entries()]
    .map(([project, rs]) => {
      const seen = new Set<string>();
      let repeated = 0;
      for (const r of rs.filter((x) => x.error !== 'routing_violation' && x.sender !== 'system')) {
        const key = requestKey(r);
        if (seen.has(key)) repeated++;
        else seen.add(key);
      }
      const ts = rs.filter((r) => r.error !== 'routing_violation');
      return {
        project,
        turns: ts.length,
        errors: rs.filter((r) => r.error).length,
        repeatedRequests: repeated,
        substantiveTurns: ts.filter((r) => !r.error && !NOOP_OUTPUT.test(r.output)).length,
      };
    })
    .sort((a, b) => b.turns - a.turns);

  const slowest = [...turns]
    .sort((a, b) => b.duration_ms - a.duration_ms)
    .slice(0, 5)
    .filter((r) => r.duration_ms > 0)
    .map((r) => ({
      role: r.role,
      project: r.project_slug,
      sec: Math.round(r.duration_ms / 1000),
      at: toIso(r.created_at),
    }));

  const userInputs = rows
    .filter((r) => r.role === 'chief' && r.sender === 'user')
    .slice(-(opts.maxUserInputs ?? 30))
    .map((r) => ({
      at: toIso(r.created_at),
      project: r.project_slug,
      text: r.input.replace(/\s+/g, ' ').trim().slice(0, 300),
    }));

  return {
    windowHours,
    records: rows.length,
    turns: turns.length,
    failedTurns: turns.filter((r) => r.error).length,
    violations: rows.filter((r) => r.error === 'routing_violation').length,
    errors: errors.length,
    errorsByKind: [...kinds.entries()]
      .map(([kind, count]) => ({ kind, label: ERROR_KIND_LABEL[kind], count }))
      .sort((a, b) => b.count - a.count),
    roles,
    projects,
    slowest,
    userInputs,
    legacySessions: opts.legacySessions ?? 0,
  };
}

/** 失敗した発言の例 (種類ごとに最大 2 件)。LLM に原因の推測の材料として渡す */
export function errorExamples(rows: TurnRow[]): { kind: ErrorKind; role: string; error: string }[] {
  const out: { kind: ErrorKind; role: string; error: string }[] = [];
  const count = new Map<ErrorKind, number>();
  for (const r of rows) {
    const k = classifyError(r.error);
    if (!k || k === 'routing_violation') continue;
    if ((count.get(k) ?? 0) >= 2) continue;
    count.set(k, (count.get(k) ?? 0) + 1);
    out.push({ kind: k, role: r.role, error: String(r.error).replace(/\s+/g, ' ').slice(0, 200) });
  }
  return out;
}

const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`);

/** 数字だけのレポート本文 (LLM を使わない部分) */
export function renderStats(s: OuterLoopStats): string {
  const lines: string[] = [
    `## 数字 (直近 ${s.windowHours} 時間)`,
    '',
    `- 発言: ${s.turns} 回 (うち失敗 ${s.failedTurns} 回、失敗率 ${pct(s.failedTurns, s.turns)})`,
    `- 会話経路の違反: ${s.violations} 件 (発言には含めない)`,
  ];
  if (s.legacySessions > 0) lines.push(`- 旧来のセッション (checkpoints) の記録: ${s.legacySessions} 件`);
  if (s.errorsByKind.length > 0) {
    lines.push('', '### 失敗の内訳', '', '| 種類 | 件数 |', '| --- | --- |');
    for (const k of s.errorsByKind) lines.push(`| ${k.label} | ${k.count} |`);
  }
  if (s.roles.length > 0) {
    lines.push('', '### ロール別', '', '| ロール | 発言 | 失敗 | 平均(秒) | 最大(秒) |', '| --- | --- | --- | --- | --- |');
    for (const r of s.roles) lines.push(`| ${r.role} | ${r.turns} | ${r.errors} | ${r.avgSec} | ${r.maxSec} |`);
  }
  if (s.projects.length > 0) {
    lines.push(
      '',
      '### プロジェクト別',
      '',
      '| プロジェクト | 発言 | 実質的な応答 | 失敗 | 繰り返された依頼 |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const p of s.projects) {
      lines.push(`| ${p.project} | ${p.turns} | ${p.substantiveTurns} | ${p.errors} | ${p.repeatedRequests} |`);
    }
  }
  if (s.slowest.length > 0) {
    lines.push('', '### 時間がかかった発言 (上位)', '');
    for (const w of s.slowest) lines.push(`- ${w.role} (${w.project ?? 'チーフ'}): ${w.sec} 秒 — ${w.at}`);
  }
  if (s.userInputs.length > 0) {
    lines.push('', `### ユーザーの入力 (${s.userInputs.length} 件。人間の指摘・修正の候補)`, '');
    for (const u of s.userInputs) lines.push(`- ${u.at.slice(0, 16).replace('T', ' ')} ${u.text}`);
  }
  return lines.join('\n');
}

export interface CommonRule {
  code: string;
  text: string;
}

/** LLM に渡す依頼文。数字を根拠にした提案だけを求める */
export function analysisPrompt(
  s: OuterLoopStats,
  examples: ReturnType<typeof errorExamples>,
  commonRules: CommonRule[] = [],
): string {
  return [
    'あなたは、AI エージェントの組織 (チーフ・PjM・各ロール) の運用を見直す担当です。',
    `以下は直近 ${s.windowHours} 時間の集計です。この数字だけを根拠に、次を Markdown で簡潔に書いてください。`,
    '',
    '1. つまずいた点 (数字を引用する。例: 「利用上限による失敗が 4 回」)',
    '2. 人間が指摘・修正した点 (「ユーザーの入力」から読み取れるものだけ。無ければ「なし」)',
    '3. ハーネス・プロンプトへの改善案 (1 件ずつ: 何を変えるか / どの数字が改善するはずか。これはコードの変更なので人が行う)',
    '4. kobun 共通の行動ルールの提案 (下記の書式。無ければ書かない)',
    '',
    '## kobun 共通ルールの提案の書式',
    '全プロジェクトのすべてのロールが今後従う、1 文の行動ルールにできるものだけを、次のタグで書く。',
    '- <rule scope="common">新しいルール (1 文)</rule>',
    '- <rule scope="common" replaces="K-番号">現在のルールを書き直した 1 文</rule>',
    '- <rule-retire id="K-番号">廃止する理由 (数字つき)</rule-retire>',
    `提案は最大 ${MAX_RULE_PROPOSALS} 件。提案はユーザーの承認を待ってから適用される。`,
    '次のものは提案しない: 特定のプロジェクトやクライアントだけに当てはまること、コードやプロンプトの修正で直すべきこと、',
    '数字の根拠がないこと、すでに下の現在のルールで言えていること。',
    '',
    '## 現在の kobun 共通ルール',
    commonRules.length ? commonRules.map((r) => `- ${r.code}: ${r.text}`).join('\n') : '(なし)',
    '',
    '数字にないことは推測で書かない。根拠がないものは「不明」と書く。定性的な感想は書かない。',
    '',
    renderStats(s),
    '',
    examples.length ? '### 失敗の例' : '',
    ...examples.map((e) => `- [${ERROR_KIND_LABEL[e.kind]}] ${e.role}: ${e.error}`),
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

export interface RuleProposals {
  /** タグを除いた、レポートに載せる分析本文 */
  text: string;
  rules: OutRule[];
  retires: OutRuleRetire[];
  /** 捨てた提案の数と理由 */
  dropped: string[];
}

/**
 * 分析の出力から、共通ルールの提案だけを取り出す。
 * 共通層以外 (クライアント・プロジェクト)、K 以外のルール ID、上限 (MAX_RULE_PROPOSALS) を超えた分は捨てる。
 * Outer Loop は全プロジェクトを横断して見るので、一部の層だけに効く変更は提案させない。
 */
export function extractRuleProposals(raw: string): RuleProposals {
  const parsed = parseOutput(raw);
  const dropped: string[] = [];
  const rules: OutRule[] = [];
  for (const r of parsed.rules) {
    if (r.scope !== 'common') {
      dropped.push(`共通以外の層 (${r.scope}) の提案: ${r.text.slice(0, 60)}`);
    } else if (r.replaces && !/^K-\d+$/i.test(r.replaces.trim())) {
      dropped.push(`共通ルール以外の置換 (${r.replaces}): ${r.text.slice(0, 60)}`);
    } else if (!r.text.trim()) {
      dropped.push('空のルール');
    } else {
      rules.push({ ...r, replaces: r.replaces ? r.replaces.trim().toUpperCase() : null });
    }
  }
  const retires: OutRuleRetire[] = [];
  for (const x of parsed.ruleRetires) {
    if (!/^K-\d+$/i.test(x.id.trim())) dropped.push(`共通ルール以外の廃止 (${x.id})`);
    else retires.push({ ...x, id: x.id.trim().toUpperCase() });
  }
  let room = MAX_RULE_PROPOSALS;
  const keptRules = rules.slice(0, room);
  room -= keptRules.length;
  const keptRetires = retires.slice(0, Math.max(0, room));
  const over = rules.length + retires.length - keptRules.length - keptRetires.length;
  if (over > 0) dropped.push(`上限 (${MAX_RULE_PROPOSALS} 件) を超えた提案 ${over} 件`);
  return { text: parsed.rest, rules: keptRules, retires: keptRetires, dropped };
}

/** JST の日付 (YYYY-MM-DD) */
export function jstDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function renderReport(
  date: string,
  s: OuterLoopStats,
  analysis: { ok: true; text: string } | { ok: false; error: string },
  proposal: { changes: RuleChange[]; dropped: string[] } = { changes: [], dropped: [] },
): string {
  const head = `# Outer Loop レポート ${date}`;
  if (s.turns === 0 && s.errors === 0 && s.legacySessions === 0) {
    return `${head}\n\n直近 ${s.windowHours} 時間のエージェントの記録はありませんでした。\n`;
  }
  const lines = [
    head,
    '',
    renderStats(s),
    '',
    '## 分析',
    '',
    analysis.ok
      ? analysis.text.trim()
      : `LLM による分析は失敗しました (数字は上のとおり): ${analysis.error.slice(0, 300)}`,
    '',
  ];
  if (proposal.changes.length > 0 || proposal.dropped.length > 0) {
    lines.push('## kobun 共通ルールの提案 (承認待ち。承認されるまで適用されない)', '');
    if (proposal.changes.length > 0) {
      lines.push('| 提案 | 操作 | 内容 |', '| --- | --- | --- |');
      for (const c of proposal.changes) {
        lines.push(`| ${c.code} | ${c.op} | ${c.text.replace(/\|/g, '\\|')} |`);
      }
    }
    for (const d of proposal.dropped) lines.push(`- 提案から除いた: ${d}`);
    lines.push('');
  }
  return lines.join('\n');
}

/** ユーザーのフィードに出す要点 (数字だけ) */
export function feedSummary(s: OuterLoopStats, path: string, proposals = 0): string {
  const lines = [
    `発言 ${s.turns} 回、うち失敗 ${s.failedTurns} 回。経路違反 ${s.violations} 件。レポート: ${path}`,
    ...s.errorsByKind.map((k) => `- ${k.label}: ${k.count} 回`),
  ];
  const repeated = s.projects.reduce((a, p) => a + p.repeatedRequests, 0);
  if (repeated > 0) lines.push(`- 繰り返された依頼: ${repeated} 件`);
  if (proposals > 0) lines.push(`- 共通ルールの提案: ${proposals} 件 (承認待ち。別の依頼で届く)`);
  return lines.join('\n');
}
