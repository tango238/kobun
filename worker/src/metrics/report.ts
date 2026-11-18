// 改善レポートと異常検知 (純粋関数)。
// レポートは LLM に書かせず、取得した数字からここで組み立てる。
// 取得できなかった数字・未達のアクションも必ず載せる。

import { WORSENED_THRESHOLD_PCT } from './catalog';

export interface MetricRow {
  key: string;
  unit: string;
  source: string;
  current: number | null;
  previous: number | null;
}

export interface PastImprovement {
  id: number;
  owner: string;
  action: string;
  metricKey: string | null;
  baseline: number | null;
  target: number | null;
  current: number | null;
  status: 'achieved' | 'missed' | 'unmeasured';
  /** 同じ指標で連続して未達になった回数 (今回を含む) */
  missStreak: number;
}

export interface WorsenedMetric {
  key: string;
  unit: string;
  owner: string;
  previous: number;
  current: number;
  /** 悪化した割合 (%)。常に正 */
  worsePct: number;
}

export interface NewImprovement {
  owner: string;
  action: string;
  metricKey: string | null;
  baseline: number | null;
  target: number | null;
}

export interface DataGap {
  /** 接続の種類、またはロール名 */
  subject: string;
  state: string;
  reason: string;
  /** ユーザーに必要な対応 */
  needed: string;
}

export interface RuleChange {
  /** kobun 共通 / クライアント / プロジェクト */
  layer: string;
  /** 追加 / 置換 / 廃止 */
  op: string;
  code: string;
  text: string;
  /** ユーザーの承認待ちなら、その提案の番号 */
  proposalId?: number;
}

export interface RetroReportInput {
  project: string;
  week: string;
  metrics: MetricRow[];
  past: PastImprovement[];
  next: NewImprovement[];
  /** クライアント名 (プロジェクトの所属) */
  client: string;
  ruleChanges: RuleChange[];
  adrs: string[];
  proposals: { savingUsdMonth: number | null; content: string }[];
  gaps: DataGap[];
  worsened: WorsenedMetric[];
  connectionsOk: number;
  connectionsTotal: number;
}

export function fmt(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '未計測';
  if (Number.isInteger(n)) return String(n);
  return Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2);
}

export function deltaPct(
  current: number | null,
  previous: number | null,
): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

function fmtDelta(current: number | null, previous: number | null): string {
  const d = deltaPct(current, previous);
  if (d === null) return '-';
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
}

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

/** 目標に対する達成判定。target が baseline より小さければ「下げる」目標とみなす */
export function judge(
  baseline: number | null,
  target: number | null,
  current: number | null,
): 'achieved' | 'missed' | 'unmeasured' {
  if (target === null || current === null) return 'unmeasured';
  const lowerIsBetter = baseline !== null ? target < baseline : false;
  if (lowerIsBetter) return current <= target ? 'achieved' : 'missed';
  return current >= target ? 'achieved' : 'missed';
}

const STATUS_LABEL = {
  achieved: '達成',
  missed: '未達',
  unmeasured: '判定不能 (未計測)',
} as const;

export function renderRetroReport(r: RetroReportInput): string {
  const measured = r.metrics.filter((m) => m.current !== null).length;
  const achieved = r.past.filter((p) => p.status === 'achieved').length;
  const noMetric = r.next.filter(
    (n) => n.metricKey === null || n.target === null,
  ).length;
  const layerCount = (layer: string) =>
    r.ruleChanges.filter((c) => c.layer === layer).length;
  const hasAction = (key: string) => r.next.some((n) => n.metricKey === key);
  const unhandled = r.worsened.filter((w) => !hasAction(w.key)).length;
  const streak2 = r.past.filter((p) => p.missStreak >= 2).length;
  const lines: string[] = [
    `# 改善レポート ${r.project} (${r.week} 週)`,
    '',
    `クライアント: ${r.client || '未設定'}`,
    '',
    '## サマリー',
    '',
    `- 取得できた指標: ${measured} 件`,
    `- 正常な接続: ${r.connectionsOk} / ${r.connectionsTotal}`,
    `- 前週の改善アクション: ${r.past.length} 件中 ${achieved} 件達成 (2週以上連続で未達 ${streak2} 件)`,
    `- 前週より ${WORSENED_THRESHOLD_PCT}% を超えて悪化した指標: ${r.worsened.length} 件 (うち対応アクションなし ${unhandled} 件)`,
    `- 今週実行する改善アクション: ${r.next.length} 件 (うち指標・目標値なし ${noMetric} 件)`,
    `- 行動ルールの変更: ${r.ruleChanges.length} 件 (kobun 共通 ${layerCount('kobun 共通')} / クライアント ${layerCount('クライアント')} / プロジェクト ${layerCount('プロジェクト')})`,
    `- うちユーザーの承認待ち (未適用): ${r.ruleChanges.filter((c) => c.proposalId !== undefined).length} 件`,
    `- 追加した ADR: ${r.adrs.length} 件`,
    `- 取得できなかった数字: ${r.gaps.length} 件`,
    '',
    '## 指標',
    '',
  ];
  if (r.metrics.length === 0) {
    lines.push('取得できた指標は 0 件です。');
  } else {
    lines.push(
      '| 指標 | 単位 | 前週 | 今週 | 増減 | 取得元 |',
      '| --- | --- | ---: | ---: | ---: | --- |',
      ...r.metrics.map(
        (m) =>
          `| ${m.key} | ${m.unit || '-'} | ${fmt(m.previous)} | ${fmt(m.current)} | ${fmtDelta(m.current, m.previous)} | ${m.source} |`,
      ),
    );
  }
  lines.push('', '## 前週の改善アクションの結果', '');
  if (r.past.length === 0) {
    lines.push('前週の改善アクションは 0 件です。');
  } else {
    lines.push(
      '| 担当 | アクション | 指標 | 実行前 | 目標 | 実績 | 判定 | 連続未達 |',
      '| --- | --- | --- | ---: | ---: | ---: | --- | ---: |',
      ...r.past.map(
        (p) =>
          `| ${p.owner} | ${cell(p.action)} | ${p.metricKey ?? '指標なし'} | ${fmt(p.baseline)} | ${fmt(p.target)} | ${fmt(p.current)} | ${STATUS_LABEL[p.status]} | ${p.missStreak} |`,
      ),
    );
  }
  lines.push('', '## 悪化した指標', '');
  if (r.worsened.length === 0) {
    lines.push(`前週より ${WORSENED_THRESHOLD_PCT}% を超えて悪化した指標は 0 件です。`);
  } else {
    lines.push(
      '| 指標 | 担当 | 前週 | 今週 | 悪化 | 対応アクション |',
      '| --- | --- | ---: | ---: | ---: | --- |',
      ...r.worsened.map(
        (w) =>
          `| ${w.key} | ${w.owner} | ${fmt(w.previous)} | ${fmt(w.current)} | ${w.worsePct.toFixed(1)}% | ${hasAction(w.key) ? 'あり' : 'なし'} |`,
      ),
    );
  }
  lines.push('', '## 今週実行する改善アクション', '');
  if (r.next.length === 0) {
    lines.push('今週の改善アクションは 0 件です (チームから提案が出ませんでした)。');
  } else {
    lines.push(
      '| 担当 | アクション | 指標 | 現在値 | 目標 |',
      '| --- | --- | --- | ---: | ---: |',
      ...r.next.map(
        (n) =>
          `| ${n.owner} | ${cell(n.action)} | ${n.metricKey ?? '指標なし'} | ${fmt(n.baseline)} | ${fmt(n.target)} |`,
      ),
    );
  }
  lines.push('', '## 行動ルールの変更', '');
  if (r.ruleChanges.length === 0) {
    lines.push('変更は 0 件です。');
  } else {
    lines.push(
      '| 層 | 操作 | ID | ルール |',
      '| --- | --- | --- | --- |',
      ...r.ruleChanges.map(
        (c) => `| ${c.layer} | ${c.op} | ${c.code} | ${cell(c.text)} |`,
      ),
    );
  }
  if (r.adrs.length > 0) {
    lines.push('', '## 追加した ADR', '');
    lines.push(...r.adrs.map((x) => `- ${cell(x)}`));
  }
  if (r.proposals.length > 0) {
    lines.push(
      '',
      '## コスト削減提案',
      '',
      '| 削減見込み (USD/月) | 提案 |',
      '| ---: | --- |',
      ...r.proposals.map(
        (p) => `| ${fmt(p.savingUsdMonth)} | ${cell(p.content)} |`,
      ),
    );
  }
  lines.push('', '## 取得できなかった数字', '');
  if (r.gaps.length === 0) {
    lines.push('ありません。');
  } else {
    lines.push(
      '| 対象 | 状態 | 理由 | 必要な対応 |',
      '| --- | --- | --- | --- |',
      ...r.gaps.map(
        (g) =>
          `| ${g.subject} | ${g.state} | ${cell(g.reason)} | ${cell(g.needed)} |`,
      ),
    );
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// 異常検知
// ---------------------------------------------------------------------------

export interface Anomaly {
  key: string;
  unit: string;
  latest: number;
  baseline: number;
  deltaPct: number;
  rule: string;
}

export interface Series {
  key: string;
  unit: string;
  /** 古い順。最後が最新値 */
  values: number[];
}

export interface AnomalyThresholds {
  /** コスト系 (cost_ で始まるキー) が直近平均をこの割合超えたら異常 */
  costIncreasePct: number;
  /** それ以外の指標は、直近平均からこの標準偏差の倍数ぶん外れたら異常 */
  zScore: number;
}

export const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  costIncreasePct: 20,
  zScore: 3,
};

export function detectAnomalies(
  series: Series[],
  t: AnomalyThresholds = DEFAULT_THRESHOLDS,
): Anomaly[] {
  const out: Anomaly[] = [];
  for (const s of series) {
    if (s.values.length < 4) continue; // 比較対象が3点未満なら判定しない
    const latest = s.values[s.values.length - 1];
    const hist = s.values.slice(0, -1).slice(-14);
    const mean = hist.reduce((a, b) => a + b, 0) / hist.length;
    const pct = mean === 0 ? null : ((latest - mean) / Math.abs(mean)) * 100;
    if (s.key.startsWith('cost_')) {
      if (pct !== null && pct > t.costIncreasePct) {
        out.push({
          key: s.key,
          unit: s.unit,
          latest,
          baseline: mean,
          deltaPct: pct,
          rule: `直近 ${hist.length} 回の平均より ${t.costIncreasePct}% 超の増加`,
        });
      }
      continue;
    }
    if (hist.length < 7) continue;
    const sd = Math.sqrt(
      hist.reduce((a, b) => a + (b - mean) ** 2, 0) / hist.length,
    );
    if (sd === 0) continue;
    const z = (latest - mean) / sd;
    if (Math.abs(z) > t.zScore) {
      out.push({
        key: s.key,
        unit: s.unit,
        latest,
        baseline: mean,
        deltaPct: pct ?? 0,
        rule: `直近 ${hist.length} 回の平均から標準偏差の ${z.toFixed(1)} 倍`,
      });
    }
  }
  return out;
}

export interface SlowQuery {
  query: string;
  meanMs: number;
  calls: number;
}

export function renderInfraAlert(
  project: string,
  anomalies: Anomaly[],
  slow: SlowQuery[],
): string {
  const lines: string[] = [`# インフラアラート ${project}`, ''];
  if (anomalies.length > 0) {
    lines.push(
      '| 指標 | 単位 | 最新値 | 直近平均 | 増減 | 判定ルール |',
      '| --- | --- | ---: | ---: | ---: | --- |',
      ...anomalies.map(
        (a) =>
          `| ${a.key} | ${a.unit || '-'} | ${fmt(a.latest)} | ${fmt(a.baseline)} | ${a.deltaPct >= 0 ? '+' : ''}${a.deltaPct.toFixed(1)}% | ${a.rule} |`,
      ),
      '',
    );
  }
  if (slow.length > 0) {
    lines.push(
      `新たに検出した遅いクエリ: ${slow.length} 件 (エンジニアに修正を依頼済み)`,
      '',
      ...renderSlowQueries(slow),
    );
  }
  return lines.join('\n') + '\n';
}

export function renderSlowQueries(slow: SlowQuery[]): string[] {
  return [
    '| 平均実行時間 (ms) | 呼び出し回数 | クエリ |',
    '| ---: | ---: | --- |',
    ...slow.map(
      (q) => `| ${fmt(q.meanMs)} | ${q.calls} | \`${cell(q.query).slice(0, 300)}\` |`,
    ),
  ];
}
