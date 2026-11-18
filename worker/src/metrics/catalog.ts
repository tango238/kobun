import type { RoleId } from '../agents/roles';

// 振り返りに必要なデータのカタログ (純粋なデータ)。
// 「誰が・何の数字を・どこから・どうやって取るか」をここで決める。
// 振り返りでは、ここにある指標が取れていなければ指標単位で「未計測」と報告し、
// 取得方法 (how) をユーザーに示す。

export type Better = 'lower' | 'higher' | 'none';

export interface MetricDef {
  key: string;
  label: string;
  unit: string;
  /** この数字に責任を持つロール */
  owner: RoleId;
  /** 取得元 (接続の種類。kobun / user-feedback は接続不要) */
  source: 'github' | 'command' | 'http-json' | 'aws' | 'postgres' | 'kobun' | 'user-feedback';
  /** 良い方向。悪化の判定に使う */
  better: Better;
  /** 取得方法 (未計測のときにユーザーへ示す) */
  how: string;
}

const GITHUB = 'github 接続を登録すると自動取得 (GitHub API、直近7日)';
const COMMAND = (key: string, example: string) =>
  `command 接続の commands.${key} に、数値を最後の行に出力するコマンドを登録 (例: ${example})`;
const HTTP = (key: string, what: string) =>
  `http-json 接続の metrics.${key} に、${what}を返す分析 API の URL と JSON パスを登録`;

export const CATALOG: MetricDef[] = [
  // --- シニアエンジニア: ソースコードの品質 ---
  { key: 'duplication_pct', label: 'コード重複率 (再利用性)', unit: '%', owner: 'engineer-lead', source: 'command', better: 'lower', how: COMMAND('duplication_pct', 'jscpd の重複率') },
  { key: 'complexity_avg', label: '循環的複雑度の平均', unit: '', owner: 'engineer-lead', source: 'command', better: 'lower', how: COMMAND('complexity_avg', 'lizard / eslint complexity の平均') },
  { key: 'coverage_pct', label: 'テストカバレッジ', unit: '%', owner: 'engineer-lead', source: 'command', better: 'higher', how: COMMAND('coverage_pct', 'coverage-summary.json の lines.pct') },
  { key: 'bug_rate_per_100_prs', label: '不具合発生率 (マージ100件あたりの bug issue)', unit: '件/100PR', owner: 'engineer-lead', source: 'github', better: 'lower', how: GITHUB },
  { key: 'ci_duration_avg_sec', label: 'CI の平均実行時間', unit: '秒', owner: 'engineer-lead', source: 'github', better: 'lower', how: GITHUB },
  { key: 'ci_duration_p95_sec', label: 'CI の実行時間 (95パーセンタイル)', unit: '秒', owner: 'engineer-lead', source: 'github', better: 'lower', how: GITHUB },
  { key: 'ci_failure_rate_pct', label: 'CI の失敗率', unit: '%', owner: 'engineer-lead', source: 'github', better: 'lower', how: GITHUB },
  // --- UXアナリスト / シニアデザイナー: 迷いと離脱 ---
  { key: 'ux_dropoff_pct', label: '主要フローの離脱率', unit: '%', owner: 'ux-analyst', source: 'http-json', better: 'lower', how: HTTP('ux_dropoff_pct', '主要フロー (ファネル) の離脱率') },
  { key: 'ux_task_time_sec', label: '主要タスクの所要時間 (迷いの指標)', unit: '秒', owner: 'ux-analyst', source: 'http-json', better: 'lower', how: HTTP('ux_task_time_sec', '主要タスクの完了までの中央値') },
  { key: 'ux_error_rate_pct', label: '入力エラー・操作やり直しの発生率', unit: '%', owner: 'ux-analyst', source: 'http-json', better: 'lower', how: HTTP('ux_error_rate_pct', 'エラー表示・やり直しが起きたセッションの割合') },
  // --- シニアビジネスアナリスト: アウトカムのズレ ---
  { key: 'outcome_fit_score', label: 'アウトカム適合スコア (ユーザー評価 1〜5 の直近28日平均)', unit: '点', owner: 'business-analyst', source: 'user-feedback', better: 'higher', how: 'POST /projects/<slug>/feedback に { "score": 1〜5, "comment": "..." } を送る' },
  { key: 'outcome_feedback_28d', label: 'フィードバック件数 (直近28日)', unit: '件', owner: 'business-analyst', source: 'user-feedback', better: 'higher', how: 'POST /projects/<slug>/feedback で増える' },
  { key: 'ops_workaround_7d', label: '運用でカバーしたイレギュラーの件数', unit: '件', owner: 'business-analyst', source: 'http-json', better: 'lower', how: HTTP('ops_workaround_7d', '手作業での対応・例外処理の件数') },
  // --- インフラエンジニア: パフォーマンスとコスト ---
  { key: 'cost_usd_7d', label: 'インフラコスト (直近7日)', unit: 'USD', owner: 'infra-engineer', source: 'aws', better: 'lower', how: 'aws 接続を登録すると自動取得 (Cost Explorer)' },
  { key: 'cost_usd_day', label: 'インフラコスト (前日)', unit: 'USD', owner: 'infra-engineer', source: 'aws', better: 'lower', how: 'aws 接続を登録すると自動取得 (Cost Explorer)' },
  { key: 'db_slow_queries', label: '遅いクエリの件数', unit: '件', owner: 'infra-engineer', source: 'postgres', better: 'lower', how: 'postgres 接続を登録すると自動取得 (pg_stat_statements 拡張を推奨)' },
  { key: 'db_cache_hit_pct', label: 'DB キャッシュヒット率', unit: '%', owner: 'infra-engineer', source: 'postgres', better: 'higher', how: 'postgres 接続を登録すると自動取得' },
  { key: 'db_connections', label: 'DB 接続数', unit: '本', owner: 'infra-engineer', source: 'postgres', better: 'none', how: 'postgres 接続を登録すると自動取得' },
  { key: 'db_size_mb', label: 'DB サイズ', unit: 'MB', owner: 'infra-engineer', source: 'postgres', better: 'none', how: 'postgres 接続を登録すると自動取得' },
  // --- PjM: チームと改善サイクルの稼働 (kobun が常に計測) ---
  { key: 'improvements_achieved_pct', label: '改善アクションの達成率 (累計)', unit: '%', owner: 'pjm', source: 'kobun', better: 'higher', how: '改善アクションが1件以上判定されると自動計測' },
  { key: 'improvements_open', label: '実行中の改善アクション', unit: '件', owner: 'pjm', source: 'kobun', better: 'none', how: '自動計測' },
  { key: 'agent_errors_7d', label: 'エージェントの応答失敗', unit: '回', owner: 'pjm', source: 'kobun', better: 'lower', how: '自動計測' },
  { key: 'agent_routing_violations_7d', label: '会話経路の違反', unit: '回', owner: 'pjm', source: 'kobun', better: 'lower', how: '自動計測' },
  { key: 'agent_turns_7d', label: 'エージェントの発言数', unit: '回', owner: 'pjm', source: 'kobun', better: 'none', how: '自動計測' },
  { key: 'board_overdue', label: '期限を過ぎたまま残っている仕事 (ボードの質問・やること)', unit: '件', owner: 'pjm', source: 'kobun', better: 'lower', how: '自動計測' },
  { key: 'rule_proposals_overdue', label: '承認の期限を過ぎたルール提案', unit: '件', owner: 'pjm', source: 'kobun', better: 'lower', how: '自動計測' },
  { key: 'agent_turn_avg_sec', label: '1発言あたりの所要時間', unit: '秒', owner: 'pjm', source: 'kobun', better: 'none', how: '自動計測' },
];

const BY_KEY = new Map(CATALOG.map((m) => [m.key, m]));

export function metricDef(key: string): MetricDef | undefined {
  return BY_KEY.get(key);
}

/** 指標の担当ロール。カタログ外の outcome_* はビジネスアナリスト、ux_* は UXアナリストが持つ */
export function ownerOf(key: string): RoleId | null {
  const def = BY_KEY.get(key);
  if (def) return def.owner;
  if (key.startsWith('outcome_') || key.startsWith('ops_')) return 'business-analyst';
  if (key.startsWith('ux_')) return 'ux-analyst';
  if (key.startsWith('cost_') || key.startsWith('db_')) return 'infra-engineer';
  return null;
}

/** 前週より悪化した割合 (%)。良い方向が決まっていない指標や比較できない指標は null */
export function worsenedPct(
  key: string,
  current: number | null,
  previous: number | null,
): number | null {
  const better = BY_KEY.get(key)?.better ?? 'none';
  if (better === 'none' || current === null || previous === null || previous === 0) {
    return null;
  }
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  const worse = better === 'lower' ? pct : -pct;
  return worse > 0 ? worse : null;
}

/** 悪化とみなす閾値 (%)。これを超えた指標には、対応アクションか理由が要る */
export const WORSENED_THRESHOLD_PCT = 5;

/** 必要なのに取れていない指標 */
export function missingMetrics(measured: Set<string>): MetricDef[] {
  return CATALOG.filter((m) => !measured.has(m.key));
}

// ---------------------------------------------------------------------------
// 改善の行動規範。kobun 共通の行動ルールとして初期登録され (db.ts)、
// 以後は他のルールと同じく振り返りで置換・廃止できる。
// 守られているかは、改善レポートの数字 (悪化指標の未対応件数・連続未達・指標なしアクション) で確認する。
// ---------------------------------------------------------------------------
export const CODE_OF_CONDUCT: string[] = [
  '報告・提案は数字で説明する。数字が無い主張は「未計測」と明記し、推測の数字を作らない。',
  '都合の悪い事実 (失敗・未達・未計測・悪化) を隠さない。ユーザーへの報告から削らない。',
  '振り返りは「前回アクションの結果確認 → 悪化した指標の確認 → 原因の特定 → 次のアクション → ルール化」の順に行う。結果確認を飛ばして新しいアクションを決めない。',
  '改善アクションは1件につき、担当1ロール・指標1つ・現在値・来週の目標値を持つ。1週間で結果が測れる大きさに切る。',
  '指標を計測できない領域では、最初の改善アクションを「その指標を計測できるようにする」にする。計測なしに施策を打たない。',
  '前週より 5% を超えて悪化した指標には、担当ロールが対応アクションを出すか、許容する理由を数字で示す。放置しない。',
  '未達だったアクションは、原因を1つ特定してからやり方を変える。同じアクションをそのまま繰り返さない。2週連続で未達なら、アクションではなくルールか ADR (仕組み) で対処する。',
  '同じ問題が2回起きたらルールにする。「気をつける」「徹底する」のような人の注意力に頼る対策は改善アクションとして認めない。',
  'ルールは最も狭い層 (プロジェクト → クライアント → kobun 共通) に置く。他のプロジェクトにも当てはまる数字の根拠があるときだけ上の層に上げる。',
  'ルールは増やし続けない。4週間、関連する指標の改善が確認できないルールは廃止を提案する。',
  '1回の振り返りで決める改善アクションは、担当ロールごとに最大2件。前回のアクションが未完了なら新規を増やさない。',
  '必要な数字が取れないときは、ユーザーに接続情報を依頼する。取れるようになるまで、その数字は「未計測」として報告し続ける。',
];
