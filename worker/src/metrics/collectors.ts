import { Client as PgClient } from 'pg';
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
} from '@aws-sdk/client-cost-explorer';
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';

// 数字の自動取得。ユーザーが登録した接続情報 (connections) ごとにコレクタが1つある。
// コレクタは worker (サンドボックスの外) で動く。資格情報は LLM にもサンドボックスにも渡さない。
//
// 認証切れ (トークン失効・セッション切れ) は AuthError として投げる。
// 呼び出し側は接続を needs_reauth にして、ユーザーに再登録を依頼する。

export interface Sample {
  key: string;
  value: number;
  unit: string;
  detail?: unknown;
}

export class AuthError extends Error {}

/** 設定が参照しているシークレットが、ブローカーに登録されていない */
export class MissingSecretError extends Error {
  constructor(public names: string[]) {
    super(`シークレット ${names.join(', ')} が登録されていません`);
  }
}

export interface Repository {
  name: string;
  url: string;
  description?: string;
}

export interface CollectorContext {
  sandboxUrl: string;
  /** プロジェクトに登録されたリポジトリ */
  repositories: Repository[];
}

// ---------------------------------------------------------------------------
// シークレット参照。設定には {{secret:名前}} とだけ書き、値はブローカーが差し込む。
// ---------------------------------------------------------------------------
const SECRET_REF = /\{\{secret:([A-Za-z0-9_.-]+)\}\}/g;
const SENSITIVE_KEY = /token|secret|password|authorization|api[-_]?key|cookie/i;
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s:]*:([^/@\s]+)@/i;

/** {{secret:名前}} を値に置き換える。未登録の名前があれば MissingSecretError */
export function resolveSecrets(value: unknown, secrets: Record<string, string>): unknown {
  const missing = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    if (typeof v !== 'string') return v;
    return v.replace(SECRET_REF, (_m, name: string) => {
      if (!(name in secrets)) {
        missing.add(name);
        return '';
      }
      return secrets[name];
    });
  };
  const out = walk(value);
  if (missing.size > 0) throw new MissingSecretError([...missing]);
  return out;
}

/** 設定のどこかに {{secret:名前}} の参照があるか */
export function hasSecretRef(value: unknown): boolean {
  return JSON.stringify(value ?? null).search(/\{\{secret:[A-Za-z0-9_.-]+\}\}/) >= 0;
}

/** command はサンドボックスで実行されるので、シークレットを渡せない */
export const COMMAND_SECRET_ERROR =
  'command のデータソースではシークレットを使えません (コマンドはサンドボックスで実行され、値がサンドボックスに渡ってしまうため)';

/**
 * 設定に直接書かれた資格情報らしき値の場所を返す (登録時に拒否するため)。
 * 対象: token / secret / password / authorization / api key / cookie というキーの文字列値と、
 * パスワードを含む URL。{{secret:名前}} だけで構成されていれば問題なし。
 */
export function findInlineSecrets(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => findInlineSecrets(v, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      findInlineSecrets(v, path ? `${path}.${k}` : k),
    );
  }
  if (typeof value !== 'string' || value === '') return [];
  const key = path.split('.').pop() ?? '';
  const stripped = value.replace(SECRET_REF, '');
  if (SENSITIVE_KEY.test(key)) {
    // "Bearer {{secret:X}}" のように、参照以外が認証方式の語だけなら許可する
    return /^(bearer|basic|token)?\s*$/i.test(stripped) ? [] : [path];
  }
  const m = value.match(URL_WITH_PASSWORD);
  if (m && m[1].replace(SECRET_REF, '') !== '') return [path];
  return [];
}

export type Collector = (config: any, ctx: CollectorContext) => Promise<Sample[]>;

function requireFields(config: any, fields: string[]): void {
  const missing = fields.filter((f) => !config?.[f]);
  if (missing.length > 0) {
    throw new Error(`接続情報に ${missing.join(', ')} がありません`);
  }
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

// ---------------------------------------------------------------------------
// github: CI の実行時間・失敗率、マージ数、不具合発生率
// config: { token: "{{secret:GITHUB_TOKEN}}", repos?: ["owner/name"], bugLabel?: "bug" }
// repos を省略すると、プロジェクトに登録された GitHub リポジトリすべてを集計する。
// ---------------------------------------------------------------------------
export function githubRepo(url: string): string | null {
  const m = url
    .trim()
    .replace(/\.git$/, '')
    .match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+\/[\w.-]+)\/?$/);
  return m ? m[1] : null;
}

const github: Collector = async (config, ctx) => {
  requireFields(config, ['token']);
  const explicit: string[] = Array.isArray(config.repos)
    ? config.repos
    : config.repo
      ? [config.repo]
      : ctx.repositories.map((r) => r.url);
  const repos = [...new Set(explicit.map((r) => githubRepo(String(r))).filter(Boolean))] as string[];
  if (repos.length === 0) {
    throw new Error('対象の GitHub リポジトリがありません (プロジェクトにリポジトリを登録してください)');
  }
  const since = isoDaysAgo(7);
  const get = async (path: string): Promise<any> => {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'kobun-metrics',
      },
    });
    if (res.status === 401) {
      throw new AuthError('GitHub トークンが無効か失効しています (401)');
    }
    if (!res.ok) {
      throw new Error(`GitHub ${path.split('?')[0]} が ${res.status} を返しました`);
    }
    return res.json();
  };

  const out: Sample[] = [];
  const search = async (q: string): Promise<number> => {
    const data = await get(`/search/issues?per_page=1&q=${encodeURIComponent(q)}`);
    return Number(data.total_count ?? 0);
  };
  const list: any[] = [];
  let merged = 0;
  let bugs = 0;
  for (const repo of repos) {
    const runs = await get(
      `/repos/${repo}/actions/runs?status=completed&per_page=100&created=${encodeURIComponent(`>=${since}`)}`,
    );
    list.push(...(runs.workflow_runs ?? []));
    merged += await search(`repo:${repo} is:pr is:merged merged:>=${since}`);
    bugs += await search(
      `repo:${repo} is:issue label:${config.bugLabel ?? 'bug'} created:>=${since}`,
    );
  }
  out.push({ key: 'ci_runs_7d', value: list.length, unit: '回' });
  if (list.length > 0) {
    const durations = list
      .map(
        (r) =>
          (new Date(r.updated_at).getTime() -
            new Date(r.run_started_at ?? r.created_at).getTime()) /
          1000,
      )
      .filter((d) => d >= 0)
      .sort((a, b) => a - b);
    const failed = list.filter((r) => r.conclusion === 'failure').length;
    if (durations.length > 0) {
      out.push(
        {
          key: 'ci_duration_avg_sec',
          value: durations.reduce((a, b) => a + b, 0) / durations.length,
          unit: '秒',
        },
        { key: 'ci_duration_p95_sec', value: percentile(durations, 95), unit: '秒' },
      );
    }
    out.push({
      key: 'ci_failure_rate_pct',
      value: (failed / list.length) * 100,
      unit: '%',
    });
  }

  out.push(
    { key: 'prs_merged_7d', value: merged, unit: '件' },
    { key: 'bugs_opened_7d', value: bugs, unit: '件' },
  );
  if (merged > 0) {
    out.push({
      key: 'bug_rate_per_100_prs',
      value: (bugs / merged) * 100,
      unit: '件/100PR',
    });
  }
  return out;
};

// ---------------------------------------------------------------------------
// postgres: プロダクト DB のパフォーマンス
// config: { url: "postgres://...", slowQueryMs?: 500 }
// ---------------------------------------------------------------------------
const postgres: Collector = async (config) => {
  requireFields(config, ['url']);
  const slowMs = Number(config.slowQueryMs ?? 500);
  const client = new PgClient({
    connectionString: config.url,
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
  } catch (err: any) {
    await client.end().catch(() => undefined);
    if (err?.code === '28P01' || err?.code === '28000') {
      throw new AuthError(`DB の認証に失敗しました (${err.code})`);
    }
    throw err;
  }
  try {
    const out: Sample[] = [];
    const conn = await client.query(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database()',
    );
    out.push({ key: 'db_connections', value: conn.rows[0].n, unit: '本' });
    const size = await client.query(
      'SELECT pg_database_size(current_database())::float8 / 1048576 AS mb',
    );
    out.push({ key: 'db_size_mb', value: size.rows[0].mb, unit: 'MB' });
    const hit = await client.query(
      `SELECT (blks_hit::float8 / NULLIF(blks_hit + blks_read, 0)) * 100 AS pct
       FROM pg_stat_database WHERE datname = current_database()`,
    );
    if (hit.rows[0]?.pct !== null && hit.rows[0]?.pct !== undefined) {
      out.push({ key: 'db_cache_hit_pct', value: hit.rows[0].pct, unit: '%' });
    }

    const ext = await client.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'",
    );
    if ((ext.rowCount ?? 0) > 0) {
      const slow = await client.query(
        `SELECT query, calls::float8 AS calls, mean_exec_time::float8 AS mean_ms
         FROM pg_stat_statements
         WHERE mean_exec_time > $1 AND calls >= 5
         ORDER BY mean_exec_time * calls DESC LIMIT 10`,
        [slowMs],
      );
      out.push({
        key: 'db_slow_queries',
        value: slow.rows.length,
        unit: '件',
        detail: {
          source: 'pg_stat_statements',
          thresholdMs: slowMs,
          queries: slow.rows.map((r) => ({
            query: String(r.query),
            meanMs: Number(r.mean_ms),
            calls: Number(r.calls),
          })),
        },
      });
    } else {
      // pg_stat_statements が無い場合は、いま実行中の長いクエリだけが見える
      const running = await client.query(
        `SELECT query, extract(epoch FROM now() - query_start) * 1000 AS ms
         FROM pg_stat_activity
         WHERE state = 'active' AND pid <> pg_backend_pid()
           AND datname = current_database()
           AND now() - query_start > ($1 || ' milliseconds')::interval
         ORDER BY query_start LIMIT 10`,
        [String(slowMs)],
      );
      out.push({
        key: 'db_slow_queries',
        value: running.rows.length,
        unit: '件',
        detail: {
          source: 'pg_stat_activity',
          note: 'pg_stat_statements 拡張が無いため、計測時点で実行中のクエリのみ',
          thresholdMs: slowMs,
          queries: running.rows.map((r) => ({
            query: String(r.query),
            meanMs: Number(r.ms),
            calls: 1,
          })),
        },
      });
    }
    return out;
  } finally {
    await client.end().catch(() => undefined);
  }
};

// ---------------------------------------------------------------------------
// aws: コスト (Cost Explorer) と任意の CloudWatch メトリクス
// config: { accessKeyId, secretAccessKey, sessionToken?, region,
//           cloudwatch?: [{ key, namespace, metricName, dimensions?: {k: v}, stat?, unit? }] }
// ---------------------------------------------------------------------------
const AWS_AUTH_ERRORS = new Set([
  'ExpiredToken',
  'ExpiredTokenException',
  'RequestExpired',
  'UnrecognizedClientException',
  'InvalidClientTokenId',
  'InvalidSignatureException',
  'SignatureDoesNotMatch',
  'AuthFailure',
  'CredentialsProviderError',
]);

function rethrowAws(err: any): never {
  if (AWS_AUTH_ERRORS.has(err?.name) || AWS_AUTH_ERRORS.has(err?.Code)) {
    throw new AuthError(`AWS の認証に失敗しました (${err.name ?? err.Code})`);
  }
  throw err;
}

const aws: Collector = async (config) => {
  requireFields(config, ['accessKeyId', 'secretAccessKey']);
  const credentials = {
    accessKeyId: String(config.accessKeyId),
    secretAccessKey: String(config.secretAccessKey),
    ...(config.sessionToken ? { sessionToken: String(config.sessionToken) } : {}),
  };
  const out: Sample[] = [];

  // Cost Explorer は us-east-1 固定。End は排他なので「今日」を指定すると昨日までが返る
  const ce = new CostExplorerClient({ region: 'us-east-1', credentials });
  try {
    const res = await ce.send(
      new GetCostAndUsageCommand({
        TimePeriod: { Start: isoDaysAgo(14), End: isoDaysAgo(0) },
        Granularity: 'DAILY',
        Metrics: ['UnblendedCost'],
        GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
      }),
    );
    const days = (res.ResultsByTime ?? []).map((d) => {
      const byService: Record<string, number> = {};
      for (const g of d.Groups ?? []) {
        byService[g.Keys?.[0] ?? 'unknown'] = Number(
          g.Metrics?.UnblendedCost?.Amount ?? 0,
        );
      }
      return {
        date: d.TimePeriod?.Start ?? '',
        total: Object.values(byService).reduce((a, b) => a + b, 0),
        byService,
      };
    });
    if (days.length > 0) {
      const last7 = days.slice(-7);
      const prev7 = days.slice(-14, -7);
      const sum = (xs: typeof days) => xs.reduce((a, d) => a + d.total, 0);
      const byService: Record<string, number> = {};
      for (const d of last7) {
        for (const [k, v] of Object.entries(d.byService)) {
          byService[k] = (byService[k] ?? 0) + v;
        }
      }
      const top = Object.entries(byService)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([service, usd]) => ({ service, usd: Number(usd.toFixed(2)) }));
      const latest = days[days.length - 1];
      out.push(
        {
          key: 'cost_usd_day',
          value: latest.total,
          unit: 'USD',
          detail: { date: latest.date },
        },
        {
          key: 'cost_usd_7d',
          value: sum(last7),
          unit: 'USD',
          detail: { byService: top },
        },
      );
      if (prev7.length === 7) {
        out.push({ key: 'cost_usd_prev_7d', value: sum(prev7), unit: 'USD' });
      }
    }
  } catch (err) {
    rethrowAws(err);
  }

  const queries: any[] = Array.isArray(config.cloudwatch) ? config.cloudwatch : [];
  if (queries.length > 0) {
    requireFields(config, ['region']);
    const cw = new CloudWatchClient({ region: String(config.region), credentials });
    try {
      const res = await cw.send(
        new GetMetricDataCommand({
          StartTime: new Date(Date.now() - 86_400_000),
          EndTime: new Date(),
          MetricDataQueries: queries.map((q, i) => ({
            Id: `m${i}`,
            MetricStat: {
              Metric: {
                Namespace: q.namespace,
                MetricName: q.metricName,
                Dimensions: Object.entries(q.dimensions ?? {}).map(
                  ([Name, Value]) => ({ Name, Value: String(Value) }),
                ),
              },
              Period: 3600,
              Stat: q.stat ?? 'Average',
            },
          })),
        }),
      );
      for (const r of res.MetricDataResults ?? []) {
        const q = queries[Number((r.Id ?? 'm0').slice(1))];
        const values = r.Values ?? [];
        if (!q || values.length === 0) continue;
        // 直近24時間 (1時間粒度) の平均を1サンプルにする
        out.push({
          key: String(q.key),
          value: values.reduce((a, b) => a + b, 0) / values.length,
          unit: String(q.unit ?? ''),
          detail: { stat: q.stat ?? 'Average', points: values.length },
        });
      }
    } catch (err) {
      rethrowAws(err);
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// command: サンドボックス内でコマンドを実行し、出力の最後の行を数値として読む
// (テストカバレッジ、複雑度、重複率など、リポジトリから測る指標用)
// config: { commands: { coverage_pct: { cmd: "...", unit: "%" }, ... } }
// ---------------------------------------------------------------------------
const command: Collector = async (config, ctx) => {
  const commands = config?.commands ?? {};
  const keys = Object.keys(commands);
  if (keys.length === 0) throw new Error('接続情報に commands がありません');
  const out: Sample[] = [];
  const failures: string[] = [];
  for (const key of keys) {
    const { cmd, unit } = commands[key] ?? {};
    const res = await fetch(`${ctx.sandboxUrl}/exec`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cmd: String(cmd) }),
    });
    const data = (await res.json()) as { stdout: string; code: number };
    const lastLine = (data.stdout ?? '').trim().split('\n').pop() ?? '';
    const value = Number(lastLine.trim().replace(/%$/, ''));
    if (data.code !== 0 || lastLine.trim() === '' || !Number.isFinite(value)) {
      failures.push(`${key} (exit ${data.code}, 出力 "${lastLine.slice(0, 60)}")`);
      continue;
    }
    out.push({ key, value, unit: String(unit ?? '') });
  }
  if (failures.length > 0 && out.length === 0) {
    throw new Error(`数値を取得できませんでした: ${failures.join(', ')}`);
  }
  if (failures.length > 0) {
    out.push({
      key: 'command_failures',
      value: failures.length,
      unit: '件',
      detail: { failures },
    });
  }
  return out;
};

// ---------------------------------------------------------------------------
// http-json: 任意の HTTP API (プロダクト分析など) の JSON 応答から数値を取り出す
// (どこでユーザーが迷い、どこで離脱するかの計測用)
// config: { requests: [{ url, method?, headers?, body?,
//                        metrics: { signup_dropoff_pct: { path: "result.0.rate", unit: "%" } } }] }
// ---------------------------------------------------------------------------
export function pick(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

const httpJson: Collector = async (config) => {
  const requests: any[] = Array.isArray(config?.requests) ? config.requests : [];
  if (requests.length === 0) throw new Error('接続情報に requests がありません');
  const out: Sample[] = [];
  for (const req of requests) {
    const res = await fetch(String(req.url), {
      method: req.method ?? 'GET',
      headers: req.headers ?? {},
      body:
        req.body === undefined
          ? undefined
          : typeof req.body === 'string'
            ? req.body
            : JSON.stringify(req.body),
    });
    const host = new URL(String(req.url)).host;
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(
        `${host} の認証に失敗しました (${res.status})。トークンかセッションが切れています`,
      );
    }
    if (!res.ok) throw new Error(`${host} が ${res.status} を返しました`);
    const data = await res.json();
    for (const [key, spec] of Object.entries<any>(req.metrics ?? {})) {
      const value = Number(pick(data, String(spec.path)));
      if (Number.isFinite(value)) {
        out.push({ key, value, unit: String(spec.unit ?? '') });
      }
    }
  }
  return out;
};

export const COLLECTORS: Record<string, Collector> = {
  github,
  postgres,
  aws,
  command,
  'http-json': httpJson,
};

/** 接続の種類ごとの用途 (未登録のときにユーザーへ何を依頼するかの説明に使う) */
export const CONNECTION_KINDS: Record<string, { purpose: string; fields: string }> = {
  github: {
    purpose: 'CI の実行時間・失敗率、不具合発生率 (シニアエンジニア)',
    fields: '{ "token": "{{secret:GITHUB_TOKEN}}" } (対象はプロジェクトに登録したリポジトリ)',
  },
  command: {
    purpose: 'テストカバレッジ・複雑度・重複率 (シニアエンジニア)',
    fields: '{ "commands": { "coverage_pct": { "cmd": "...", "unit": "%" } } }',
  },
  'http-json': {
    purpose: 'ユーザーが迷う箇所・離脱箇所、アウトカム指標 (UXアナリスト / ビジネスアナリスト)',
    fields:
      '{ "requests": [{ "url": "...", "headers": { "Authorization": "Bearer {{secret:ANALYTICS_KEY}}" }, "metrics": { "signup_dropoff_pct": { "path": "a.b", "unit": "%" } } }] }',
  },
  aws: {
    purpose: 'インフラのコストとメトリクス (インフラエンジニア)',
    fields:
      '{ "accessKeyId": "AKIA...", "secretAccessKey": "{{secret:AWS_SECRET}}", "sessionToken": "{{secret:AWS_SESSION}}", "region": "ap-northeast-1", "cloudwatch": [...] }',
  },
  postgres: {
    purpose: 'DB のパフォーマンスと遅いクエリ (インフラエンジニア)',
    fields: '{ "url": "postgres://user:{{secret:DB_PASSWORD}}@host:5432/db", "slowQueryMs": 500 }',
  },
};

/** 資格情報らしき値を伏せる (API 応答・ログ用) */
export function maskConfig(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => maskConfig(v));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, maskConfig(v, k)]),
    );
  }
  if (typeof value !== 'string') return value;
  if (/token|secret|password|authorization|api[-_]?key|cookie/i.test(key)) {
    return '***';
  }
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(value)) {
    return value.replace(/:\/\/[^/@\s]*@/, '://***@');
  }
  return value;
}
