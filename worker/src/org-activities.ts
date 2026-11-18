import { Context } from '@temporalio/activity';
import { Client, Connection } from '@temporalio/client';
import { pool, ensureSchema } from './db';
import { agentBackend, generate, modelFor } from './llm';
import { TASK_QUEUE, type Message } from './shared';
import {
  ROLES,
  addrTitle,
  isRoleId,
  type Addr,
  type RoleId,
} from './agents/roles';
import {
  RETRO_GUIDE,
  parseOutput,
  protocolGuide,
  slugify,
  type OutAdr,
  type OutImprovement,
  type OutProposal,
  type OutRule,
  type OutRuleRetire,
  type RepoOp,
  type ParsedOutput,
} from './agents/protocol';
import { activeRules, applyRuleChanges, renderRules } from './rules';
import { applyBoardOps, loadBoard, renderBoard, type TeamNow } from './board';
import { PROPOSAL_DUE_DAYS } from './followup';
import { CONNECTION_KINDS, type Sample } from './metrics/collectors';
import {
  WORSENED_THRESHOLD_PCT,
  metricDef,
  missingMetrics,
  ownerOf,
  worsenedPct,
} from './metrics/catalog';
import {
  type WorsenedMetric,
  deltaPct,
  detectAnomalies,
  fmt,
  judge,
  renderInfraAlert,
  renderRetroReport,
  renderSlowQueries,
  type DataGap,
  type MetricRow,
  type NewImprovement,
  type RuleChange,
  type PastImprovement,
  type Series,
  type SlowQuery,
} from './metrics/report';

const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://sandbox:7000';
const BROKER_URL = process.env.BROKER_URL ?? 'http://broker:3100';
// エージェントに読ませるリポジトリの親ディレクトリ (ホストのパス)。サンドボックスの /repos に対応する
const REPOS_HOST_DIR = (process.env.REPOS_HOST_DIR ?? '').replace(/\/+$/, '');
// ユーザーに案内するブローカーの URL (ホストから見えるアドレス)
const BROKER_PUBLIC_URL = process.env.BROKER_PUBLIC_URL ?? 'http://localhost:3100';

// ---------------------------------------------------------------------------
// サンドボックス上のプロジェクトファイル (成果物・ルール・ADR・レポート)
// ---------------------------------------------------------------------------

function projectPath(slug: string, rel: string): string {
  return `projects/${slug}/${rel}`;
}

async function sandbox<T>(path: string, body: unknown): Promise<T | null> {
  const res = await fetch(`${SANDBOX_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

async function readProjectFile(slug: string, rel: string): Promise<string | null> {
  const data = await sandbox<{ content: string }>('/read', {
    path: projectPath(slug, rel),
  });
  return data?.content ?? null;
}

async function writeProjectFile(
  slug: string,
  rel: string,
  content: string,
): Promise<void> {
  const data = await sandbox('/write', { path: projectPath(slug, rel), content });
  if (data === null) throw new Error(`sandbox write failed: ${rel}`);
}

async function listProjectFiles(slug: string): Promise<string[]> {
  const data = await sandbox<{ entries: { path: string; isDirectory: boolean }[] }>(
    '/list',
    { path: `projects/${slug}`, recursive: true },
  );
  const prefix = `projects/${slug}/`;
  return (data?.entries ?? [])
    .filter((e) => !e.isDirectory && e.path.startsWith(prefix))
    .map((e) => e.path.slice(prefix.length))
    .sort();
}

// ---------------------------------------------------------------------------
// ユーザーへの通知 (チーフの発言・アラート・改善レポート・提案・依頼)
// ---------------------------------------------------------------------------

export type FeedKind = 'message' | 'alert' | 'report' | 'request';

export async function notifyUser(
  projectSlug: string | null,
  source: string,
  kind: FeedKind,
  title: string,
  body: string,
): Promise<void> {
  await ensureSchema();
  await pool.query(
    'INSERT INTO user_feed (project_slug, source, kind, title, body) VALUES ($1, $2, $3, $4, $5)',
    [projectSlug, source, kind, title, body],
  );
}

/** 承認待ちになったルール変更があれば、ユーザーに承認を依頼する (振り返りと Outer Loop が使う) */
export async function notifyPendingProposals(
  projectSlug: string | null,
  source: string,
  titlePrefix: string,
  changes: RuleChange[],
): Promise<number> {
  const pending = changes.filter((c) => c.proposalId !== undefined);
  if (pending.length === 0) return 0;
  await notifyUser(
    projectSlug,
    source,
    'request',
    `${titlePrefix} ${pending.length} 件の承認をお願いします`,
    [
      'kobun 共通・クライアントの層の変更は、承認されるまで適用されません。',
      '',
      '| 提案 | 層 | 操作 | 内容 |',
      '| --- | --- | --- | --- |',
      ...pending.map(
        (c) =>
          `| #${c.proposalId} | ${c.layer} | ${c.op.replace('承認待ち ', '')} | ${c.text.replace(/\|/g, '\\|')} |`,
      ),
      '',
      '承認: 対話コマンドで `/approve <番号>` (API: `POST /rule-proposals/<番号>/approve`) / 却下: `/reject <番号>`',
      `期限は ${PROPOSAL_DUE_DAYS} 日です。過ぎても自動では適用も却下もされず、チーフが1回だけ確認します。却下した提案は、同じ内容では二度と出ません。`,
    ].join('\n'),
  );
  return pending.length;
}

// ---------------------------------------------------------------------------
// プロジェクト
// ---------------------------------------------------------------------------

export interface ProjectInfo {
  slug: string;
  name: string;
  goal: string;
  /** クライアントの slug と表示名 */
  client: string;
  clientName: string;
}

export async function getProject(slug: string): Promise<ProjectInfo | null> {
  await ensureSchema();
  const res = await pool.query(
    `SELECT p.slug, p.name, p.goal, p.client_slug AS client,
            coalesce(c.name, p.client_slug) AS "clientName"
     FROM projects p LEFT JOIN clients c ON c.slug = p.client_slug
     WHERE p.slug = $1`,
    [slug],
  );
  return (res.rows[0] as ProjectInfo | undefined) ?? null;
}

let temporalClient: Promise<Client> | null = null;
function temporal(): Promise<Client> {
  temporalClient ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  }).then((connection) => new Client({ connection }));
  return temporalClient;
}

async function ensureSchedule(
  scheduleId: string,
  cron: string,
  workflowType: string,
  slug: string,
): Promise<void> {
  const client = await temporal();
  try {
    await client.schedule.create({
      scheduleId,
      spec: { cronExpressions: [cron], timezone: 'Asia/Tokyo' },
      action: {
        type: 'startWorkflow',
        workflowType,
        taskQueue: TASK_QUEUE,
        workflowId: scheduleId,
        args: [slug],
      },
    });
  } catch (err: any) {
    if (err?.name !== 'ScheduleAlreadyRunning') throw err;
  }
}

/**
 * プロジェクトを作る。既に存在する場合は false。
 * 週次の振り返り (月曜 09:00) と日次のインフラチェック (毎日 08:00) を登録し、
 * 数字の自動取得に必要な接続情報の登録をユーザーに依頼する。
 */
export async function createProject(p: ProjectInfo): Promise<boolean> {
  await ensureSchema();
  if (!p.client) throw new Error('プロジェクトにはクライアントが必要です');
  await pool.query(
    'INSERT INTO clients (slug, name) VALUES ($1, $2) ON CONFLICT (slug) DO NOTHING',
    [p.client, p.clientName || p.client],
  );
  const res = await pool.query(
    'INSERT INTO projects (slug, name, goal, client_slug) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING',
    [p.slug, p.name, p.goal, p.client],
  );
  await ensureSchedule(`retro-weekly-${p.slug}`, '0 9 * * 1', 'retroWorkflow', p.slug);
  await ensureSchedule(`infra-daily-${p.slug}`, '0 8 * * *', 'infraCheckWorkflow', p.slug);
  if ((res.rowCount ?? 0) === 0) return false;
  await writeProjectFile(
    p.slug,
    'project.md',
    `# ${p.name}\n\nクライアント: ${p.clientName || p.client}\n\n${p.goal}\n`,
  ).catch(() => undefined);
  await notifyUser(
    p.slug,
    'system',
    'request',
    `プロジェクト ${p.name}: リポジトリとデータソースを登録してください`,
    [
      '週次の改善レポートとインフラ監視は、登録されたデータソースから数字を自動取得します。',
      '取れていない指標は、レポートに指標単位で「未計測」と表示されます。',
      '',
      `1. リポジトリ (複数可): \`PUT /projects/${p.slug}/repositories/<名前>\` に \`{ "url": "https://github.com/owner/repo", "description": "..." }\``,
      `2. データソース (複数可): \`PUT /projects/${p.slug}/connections/<名前>\` に \`{ "kind": "<種類>", "description": "...", "config": {...} }\``,
      `3. API キーなどのシークレット: ブローカーに直接 \`PUT ${BROKER_PUBLIC_URL}/secrets/${p.slug}/<シークレット名>\` に \`{ "value": "..." }\``,
      '   設定 (config) には値を書かず `{{secret:シークレット名}}` と書きます。値はエージェントからも api からも読めません。',
      '',
      '| 種類 | 取得する数字 | config |',
      '| --- | --- | --- |',
      ...Object.entries(CONNECTION_KINDS).map(
        ([kind, c]) => `| ${kind} | ${c.purpose} | \`${c.fields}\` |`,
      ),
    ].join('\n'),
  );
  return true;
}

// ---------------------------------------------------------------------------
// ロールの1ターン
// ---------------------------------------------------------------------------

export interface RoleTurnInput {
  role: RoleId;
  project?: ProjectInfo;
  thread: Message[];
  from: Addr;
  /** 差出人の表示名を上書きする (例: "PjM (billing)") */
  fromLabel?: string;
  content: string;
  /** 振り返り用の出力タグを使わせる */
  retro?: boolean;
  /** いま発言を作っているロール (ボードの「メンバーの状況」に出す) */
  teamNow?: TeamNow[];
}

export interface RoleTurnResult {
  raw: string;
  parsed: ParsedOutput;
  /** 保存した成果物のパス */
  artifacts: string[];
  /** LLM を呼べなかった場合の理由 (資格情報不足など) */
  error?: string;
  /** 適用できなかった操作の説明 (本人に差し戻す) */
  notes?: string[];
}

const EMPTY: ParsedOutput = parseOutput('');
const THREAD_WINDOW = 30;
// 1ターンの中で「読んで続きを書く」を繰り返せる回数 (コードの調査で使う)
const MAX_READ_ROUNDS = 8;

function mergeParsed(a: ParsedOutput, b: ParsedOutput): ParsedOutput {
  return {
    messages: [...a.messages, ...b.messages],
    artifacts: [...a.artifacts, ...b.artifacts],
    reads: b.reads,
    fetches: b.fetches,
    repoOps: b.repoOps,
    board: [...a.board, ...b.board],
    boardResolves: [...a.boardResolves, ...b.boardResolves],
    boardDues: [...a.boardDues, ...b.boardDues],
    status: b.status ?? a.status,
    projects: [...a.projects, ...b.projects],
    improvements: [...a.improvements, ...b.improvements],
    rules: [...a.rules, ...b.rules],
    ruleRetires: [...a.ruleRetires, ...b.ruleRetires],
    adrs: [...a.adrs, ...b.adrs],
    proposals: [...a.proposals, ...b.proposals],
    feedbackRequests: [...a.feedbackRequests, ...b.feedbackRequests],
    rest: [a.rest, b.rest].filter(Boolean).join('\n\n'),
  };
}

// チーフがユーザーに操作を案内できるように、ユーザー側でできる操作を教えておく
const USER_OPERATIONS = [
  '## ユーザーができる操作 (聞かれたら、この手順をそのまま案内する)',
  'ユーザーは対話コマンド (`npm run chief`) であなたと話している。次の操作はユーザー自身が行う (あなたにはできない)。',
  '- リポジトリの登録: 対話コマンドで `/repo <プロジェクトのslug> <名前> <ローカルの絶対パスかURL> [説明]`。確認は `/repos <プロジェクトのslug>`。',
  `  エージェントがコードを読めるのは、ローカルのパスが ${REPOS_HOST_DIR || '(未設定の REPOS_DIR)'} の下にあるリポジトリだけ。${REPOS_HOST_DIR ? '' : '読ませるには .env に REPOS_DIR を設定して起動し直す。'}`,
  '  登録したリポジトリのうち「読める」ものは、PjM・エンジニア (リード・実装)・デザイナーなど全ロールが最初から読める。ロール毎の設定は無い。「エンジニアが読めない」という報告は、古い発言か環境の問題なので、ユーザーに設定を頼む前に、各プロジェクトの「リポジトリ」欄の状態を確かめる。',
  '  (API なら `PUT /projects/<slug>/repositories/<名前>` に `{ "url": "...", "description": "..." }`)',
  '- データソース (数字の取得方法) の登録: `PUT /projects/<slug>/connections/<名前>` に `{ "kind": "github|command|http-json|aws|postgres", "config": {...} }`。',
  `- API キーなどのシークレット: クレデンシャルブローカーに直接 \`PUT ${BROKER_PUBLIC_URL}/secrets/<slug>/<名前>\` に \`{ "value": "..." }\`。あなたとの会話には書かせない。`,
  '- アウトカムへのフィードバック: `POST /projects/<slug>/feedback` に `{ "score": 1〜5, "comment": "..." }`。',
  '- 行動ルールの承認: 対話コマンドで `/proposals`、`/approve <番号>`、`/reject <番号>`。承認待ちには期限 (7 日) があるが、過ぎても自動では適用も却下もされない。',
  '- 判断待ちの一覧 (期限切れの仕事・保留中の実装タスク・承認待ちの提案): 対話コマンドで `/pending`。',
  '- 保留になった実装タスクの再開: 対話コマンドで `/parked` で一覧、`/resume <番号> <回答>` で再開、`/drop <番号>` で取り下げ。',
  '- ボードの質問・やることの期限切れは、ユーザーが `/done <プロジェクトのslug> <B-番号> [理由]` で下ろせる。',
  '- プロジェクトの一覧: 対話コマンドで `/projects`。',
  '詳しい手順は kobun の README.md にある。ここに無い操作を聞かれたら、推測で案内せず「README を確認してください」と答える。',
].join('\n');

// ---------------------------------------------------------------------------
// リポジトリの読み取り
// ホストの REPOS_DIR がサンドボックスの /repos に読み取り専用でマウントされている。
// 登録されたリポジトリの場所が REPOS_DIR の下にあれば、エージェントが読める。
// ---------------------------------------------------------------------------

/** リポジトリの場所 (ホストのパス) を、サンドボックス内のパスに変換する。読めなければ null */
export function repoContainerPath(url: string, hostDir: string = REPOS_HOST_DIR): string | null {
  const u = url.trim().replace(/\/+$/, '');
  if (!hostDir || !u.startsWith('/')) return null;
  if (u === hostDir) return '/repos';
  if (!u.startsWith(`${hostDir}/`)) return null;
  const rel = u.slice(hostDir.length + 1);
  if (rel.split('/').some((p) => p === '..' || p === '.' || p === '')) return null;
  return `/repos/${rel}`;
}

function unreadableReason(url: string): string {
  if (!REPOS_HOST_DIR) return '読めない: REPOS_DIR が未設定';
  if (!url.trim().startsWith('/')) return '読めない: ローカルのパスではない';
  return `読めない: ${REPOS_HOST_DIR} の外にある`;
}

async function projectRepositories(
  slug: string,
): Promise<{ name: string; url: string; description: string; root: string | null }[]> {
  const res = await pool.query(
    'SELECT name, url, description FROM repositories WHERE project_slug = $1 ORDER BY name',
    [slug],
  );
  return res.rows.map((r) => ({ ...r, root: repoContainerPath(String(r.url)) }));
}

async function describeRepositories(slug: string): Promise<{ text: string; readable: boolean }> {
  const repos = await projectRepositories(slug);
  if (repos.length === 0) {
    return {
      text: '(未登録。コードを読む必要があるなら、PjM → チーフ経由でユーザーに登録を依頼する)',
      readable: false,
    };
  }
  const readable = repos.some((r) => r.root !== null);
  const lines = repos.map(
    (r) =>
      `- ${r.name}: ${r.url} [${r.root ? '読める' : unreadableReason(r.url)}]${r.description ? ` — ${r.description}` : ''}`,
  );
  if (readable) {
    lines.push(
      '「読める」リポジトリは、あなたを含むこのプロジェクトの全ロールが、下のタグで自分で読める。「読めない」と答える前に、まず一覧 (<repo-list>) を試す。読むためにユーザーへ設定や貼り付けを頼まない。',
    );
  }
  if (repos.some((r) => r.root === null)) {
    lines.push(
      '「読めない」リポジトリのコードは直接読めない。必要なファイルや箇所を具体的に挙げて、PjM → チーフ経由でユーザーに貼り付けてもらう。',
    );
  }
  return { text: lines.join('\n'), readable };
}

const MAX_REPO_OPS_PER_ROUND = 8;

/** エージェントの要求 (一覧・検索・読み取り) をサンドボックスで実行し、渡す文章にする */
async function runRepoOp(slug: string, op: RepoOp): Promise<string> {
  const head =
    op.op === 'grep'
      ? `### ${op.repo}: 検索 /${op.pattern}/ (${op.path})`
      : `### ${op.repo}: ${op.op === 'list' ? '一覧' : '読み取り'} ${op.path}`;
  const repo = (await projectRepositories(slug)).find((r) => r.name === op.repo);
  if (!repo) return `${head}\n(その名前のリポジトリは登録されていません)`;
  if (!repo.root) return `${head}\n(${unreadableReason(repo.url)})`;
  const res = await sandbox<{
    error?: string;
    text?: string;
    truncated?: boolean;
    totalLines?: number;
    from?: number;
    to?: number;
  }>('/repo', { ...op, root: repo.root });
  if (!res) return `${head}\n(サンドボックスに接続できませんでした)`;
  if (res.error) return `${head}\n(${res.error})`;
  const note =
    op.op === 'read'
      ? `(${res.from}〜${res.to} 行目 / 全 ${res.totalLines} 行${res.truncated ? '。続きは from を指定して読む' : ''})`
      : res.truncated
        ? '(件数が多いため途中まで。path や pattern で絞る)'
        : '';
  return [head, '```', res.text ?? '', '```', note].filter(Boolean).join('\n');
}

// 設定 (config) はプロンプトに入れない。エージェントに見せるのは名前・種類・説明・状態だけ
async function describeSources(slug: string): Promise<string> {
  const res = await pool.query(
    'SELECT name, kind, description, status FROM connections WHERE project_slug = $1 ORDER BY name',
    [slug],
  );
  return res.rows.length === 0
    ? '(未登録)'
    : res.rows
        .map((r) => `- ${r.name} (${r.kind}, 状態 ${r.status})${r.description ? `: ${r.description}` : ''}`)
        .join('\n');
}

/** 調査用: データソースから最新の数字を取り寄せ、エージェントに渡す文章にする */
async function fetchSource(slug: string, name: string): Promise<string> {
  const [r] = await brokerCollect(slug, { names: [name] });
  if (!r) return `### ${name}\n(その名前のデータソースはありません)`;
  if (!r.ok) return `### ${name}\n取得できませんでした: ${r.error}`;
  await insertSamples(slug, r.kind, r.samples);
  return [
    `### ${name} (${r.kind})`,
    ...r.samples.map(
      (s) =>
        `- ${s.key}: ${fmt(s.value)} ${s.unit}${s.detail ? ` — ${JSON.stringify(s.detail).slice(0, 1500)}` : ''}`,
    ),
  ].join('\n');
}

export async function buildSystemPrompt(input: RoleTurnInput): Promise<string> {
  const def = ROLES[input.role];
  const recipients = def.talksTo.map((a) => `${a} (${addrTitle(a)})`);
  const parts = [
    `あなたは「${def.title}」です。`,
    def.prompt,
    protocolGuide({
      recipients,
      isChief: input.role === 'chief',
      inProject: Boolean(input.project),
    }),
  ];
  if (input.retro) parts.push(RETRO_GUIDE);
  if (input.role === 'chief') {
    parts.push(USER_OPERATIONS);
    const clients = await pool.query('SELECT slug, name FROM clients ORDER BY created_at');
    parts.push(
      '## 登録済みのクライアント',
      clients.rows.length === 0
        ? '(まだありません)'
        : clients.rows.map((r) => `- ${r.slug}: ${r.name}`).join('\n'),
    );
    const res = await pool.query(
      'SELECT slug, name, goal, client_slug FROM projects ORDER BY created_at',
    );
    parts.push(
      '## 進行中のプロジェクト',
      res.rows.length === 0
        ? '(まだありません)'
        : res.rows
            .map((r) => `- ${r.slug} (クライアント ${r.client_slug || '未設定'}): ${r.name} — ${String(r.goal).slice(0, 200)}`)
            .join('\n'),
    );
    // 各プロジェクトのボードを見せる (既に共有済みのことを、ユーザーや PjM に聞き直さないため)
    for (const r of res.rows.slice(-8)) {
      // リポジトリの状態も見せる (読める状態なのに「読めるようにする設定」をユーザーに頼まないため)
      const repos = await projectRepositories(String(r.slug));
      parts.push(
        `## リポジトリ: ${r.name} (${r.slug})`,
        repos.length === 0
          ? '(未登録)'
          : [
              ...repos.map((x) => `- ${x.name}: ${x.url} [${x.root ? '読める' : unreadableReason(x.url)}]`),
              repos.some((x) => x.root)
                ? '「読める」ものは、PjM・エンジニアを含む全ロールが自分で読める。ユーザーに読み取りの設定を頼まない。'
                : '',
            ]
              .filter(Boolean)
              .join('\n'),
      );
      parts.push(
        `## ボード: ${r.name} (${r.slug})`,
        renderBoard(await loadBoard(String(r.slug)), { compact: true }),
      );
    }
  }
  if (input.project) {
    const { slug, name, goal, client, clientName } = input.project;
    const repos = await describeRepositories(slug);
    parts[2] = protocolGuide({
      recipients,
      isChief: false,
      inProject: true,
      canReadRepos: repos.readable,
    });
    const rules = renderRules(await activeRules({ slug, client }));
    const files = await listProjectFiles(slug);
    parts.push(
      `## プロジェクト: ${name} (${slug})`,
      `クライアント: ${clientName || client || '未設定'}`,
      goal,
      rules,
      '## ボード (チームの共有掲示板。ここにあることは問い合わせない)',
      renderBoard(await loadBoard(slug, input.teamNow ?? [])),
      '## リポジトリ',
      repos.text,
      '## データソース (<fetch source="名前"/> で最新の数字を取り寄せられる)',
      await describeSources(slug),
      '## 成果物一覧 (<read path="..."/> で読める)',
      files.length > 0 ? files.map((f) => `- ${f}`).join('\n') : '(まだありません)',
    );
  }
  return parts.join('\n\n');
}

async function logTurn(
  input: RoleTurnInput,
  output: string,
  model: string,
  durationMs: number,
  error: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO agent_turns (project_slug, role, sender, input, output, model, duration_ms, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.project?.slug ?? null,
      input.role,
      input.from,
      input.content,
      output,
      model,
      Math.round(durationMs),
      error,
    ],
  );
}

/** 出力にあったボードへの書き込みを適用する。チーフは project でプロジェクトを指定する */
async function applyBoard(input: RoleTurnInput, parsed: ParsedOutput): Promise<string[]> {
  if (
    parsed.board.length === 0 &&
    parsed.boardResolves.length === 0 &&
    parsed.boardDues.length === 0 &&
    !parsed.status
  ) {
    return [];
  }
  if (input.project) {
    return applyBoardOps(
      input.project.slug,
      input.role,
      parsed.board,
      parsed.boardResolves,
      parsed.status,
      parsed.boardDues,
    );
  }
  const res = await pool.query('SELECT slug FROM projects');
  const known = new Set(res.rows.map((r) => String(r.slug)));
  const only = known.size === 1 ? [...known][0] : undefined;
  const notes: string[] = [];
  const bySlug = new Map<
    string,
    { adds: typeof parsed.board; resolves: typeof parsed.boardResolves; dues: typeof parsed.boardDues }
  >();
  const bucket = (project: string | undefined, what: string) => {
    const slug = project ?? only;
    if (!slug || !known.has(slug)) {
      notes.push(
        `ボードへの書き込みを適用できませんでした (${what})。project にプロジェクトの slug を指定してください: ${[...known].join(', ') || '(プロジェクトなし)'}`,
      );
      return null;
    }
    if (!bySlug.has(slug)) bySlug.set(slug, { adds: [], resolves: [], dues: [] });
    return bySlug.get(slug)!;
  };
  for (const b of parsed.board) bucket(b.project, b.text.slice(0, 40))?.adds.push(b);
  for (const r of parsed.boardResolves) bucket(r.project, r.id)?.resolves.push(r);
  for (const d of parsed.boardDues) bucket(d.project, d.id)?.dues.push(d);
  for (const [slug, ops] of bySlug) {
    notes.push(...(await applyBoardOps(slug, input.role, ops.adds, ops.resolves, null, ops.dues)));
  }
  return notes;
}

/**
 * ロールに1通のメッセージを渡し、応答を構造化して返す。
 * 成果物 (<artifact>) はここでサンドボックスに保存する。
 * LLM を呼べない場合は例外にせず error を返す (Temporal のリトライで資格情報は増えないため)。
 */
export async function runRoleTurn(input: RoleTurnInput): Promise<RoleTurnResult> {
  await ensureSchema();
  const def = ROLES[input.role];
  const model = modelFor(def.tier);
  const started = Date.now();
  const label = input.fromLabel ?? addrTitle(input.from);
  const messages: Message[] = [
    ...input.thread.slice(-THREAD_WINDOW),
    { role: 'user', content: `[差出人: ${label}]\n${input.content}` },
  ];
  const slug = input.project?.slug;

  try {
    const system = await buildSystemPrompt(input);
    let parsed = EMPTY;
    const raws: string[] = [];
    for (let round = 0; ; round++) {
      let raw: string;
      if (agentBackend() === 'pi' && input.role === 'engineer-impl' && slug) {
        // 実装担当だけはツール (read/write/edit/bash) が要るので Pi Durable で回す
        const { runPiTurn } = await import('./pi/harness');
        const info = Context.current().info;
        raw = await runPiTurn(
          `${slug}-engineer-impl`,
          `${system}\n\n${messages[messages.length - 1].content}`,
          `${info.workflowExecution?.runId ?? 'local'}-${info.activityId}-${round}`,
        );
      } else {
        raw = await generate({ system, messages, model });
      }
      raws.push(raw);
      parsed = mergeParsed(parsed, parseOutput(raw));
      if (
        !slug ||
        (parsed.reads.length === 0 &&
          parsed.fetches.length === 0 &&
          parsed.repoOps.length === 0) ||
        round >= MAX_READ_ROUNDS
      ) {
        break;
      }
      const repoResults = await Promise.all(
        parsed.repoOps.slice(0, MAX_REPO_OPS_PER_ROUND).map((op) =>
          runRepoOp(slug, op).catch(
            (err) => `### ${op.repo}: ${op.path}\n取得できませんでした: ${String(err)}`,
          ),
        ),
      );
      if (parsed.repoOps.length > MAX_REPO_OPS_PER_ROUND) {
        repoResults.push(
          `(1回に実行できるのは ${MAX_REPO_OPS_PER_ROUND} 件まで。残りの ${parsed.repoOps.length - MAX_REPO_OPS_PER_ROUND} 件は実行していません)`,
        );
      }
      const fetched = await Promise.all(
        parsed.fetches.map((name) =>
          fetchSource(slug, name).catch(
            (err) => `### ${name}\n取得できませんでした: ${String(err)}`,
          ),
        ),
      );
      const contents = await Promise.all(
        parsed.reads.map(async (p) => {
          const c = await readProjectFile(slug, p);
          return `### ${p}\n${c ?? '(ファイルがありません)'}`;
        }),
      );
      messages.push(
        { role: 'assistant', content: raw },
        {
          role: 'user',
          content: `[差出人: ${addrTitle('system')}]\n読み取り結果:\n\n${[...contents, ...fetched, ...repoResults].join('\n\n')}${round + 1 >= MAX_READ_ROUNDS ? '\n\n(これが最後の読み取りです。ここまでに分かったことで出力をまとめてください)' : ''}`,
        },
      );
    }
    const saved: string[] = [];
    if (slug) {
      for (const a of parsed.artifacts) {
        await writeProjectFile(slug, a.path, a.content);
        saved.push(a.path);
      }
    }
    const raw = raws.join('\n\n');
    await logTurn(input, raw, model, Date.now() - started, null);
    const notes = await applyBoard(input, parsed);
    return { raw, parsed, artifacts: saved, notes };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await logTurn(input, '', model, Date.now() - started, error).catch(() => undefined);
    return { raw: '', parsed: EMPTY, artifacts: [], error };
  }
}

/** 会話ルーティング表に無い宛先へ送ろうとした回数を記録する (振り返りの指標になる) */
export async function recordViolation(
  slug: string | null,
  role: RoleId,
  targets: string[],
): Promise<void> {
  await ensureSchema();
  await pool.query(
    `INSERT INTO agent_turns (project_slug, role, sender, input, error)
     VALUES ($1, $2, 'system', $3, 'routing_violation')`,
    [slug, role, targets.join(', ')],
  );
}

// ---------------------------------------------------------------------------
// 数字の自動取得
// ---------------------------------------------------------------------------

async function insertSamples(
  slug: string,
  source: string,
  samples: Sample[],
): Promise<void> {
  for (const s of samples) {
    if (!Number.isFinite(s.value)) continue;
    await pool.query(
      `INSERT INTO metric_samples (project_slug, key, value, unit, source, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [slug, s.key, s.value, s.unit, source, s.detail ? JSON.stringify(s.detail) : null],
    );
  }
}

/** kobun 自身が持っている数字 (エージェントの稼働と改善アクションの消化) */
export async function internalSamples(slug: string): Promise<Sample[]> {
  const t = await pool.query(
    `SELECT count(*) FILTER (WHERE error IS NULL)::int AS turns,
            coalesce(avg(duration_ms) FILTER (WHERE error IS NULL), 0)::float8 / 1000 AS avg_sec,
            count(*) FILTER (WHERE error IS NOT NULL AND error <> 'routing_violation')::int AS errors,
            count(*) FILTER (WHERE error = 'routing_violation')::int AS violations
     FROM agent_turns
     WHERE project_slug = $1 AND created_at > now() - interval '7 days'`,
    [slug],
  );
  const i = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'open')::int AS open,
            count(*) FILTER (WHERE status = 'achieved')::int AS achieved,
            count(*) FILTER (WHERE status IN ('achieved', 'missed'))::int AS judged
     FROM improvements WHERE project_slug = $1`,
    [slug],
  );
  const out: Sample[] = [
    { key: 'agent_turns_7d', value: t.rows[0].turns, unit: '回' },
    { key: 'agent_turn_avg_sec', value: t.rows[0].avg_sec, unit: '秒' },
    { key: 'agent_errors_7d', value: t.rows[0].errors, unit: '回' },
    { key: 'agent_routing_violations_7d', value: t.rows[0].violations, unit: '回' },
    { key: 'improvements_open', value: i.rows[0].open, unit: '件' },
  ];
  // 期限を過ぎたまま残っている仕事 (ボードの質問・やること) と、承認の期限を過ぎたルール提案
  const o = await pool.query(
    `SELECT (SELECT count(*) FROM board
             WHERE project_slug = $1 AND status = 'active' AND kind IN ('question', 'task')
               AND due_at < now())::int AS board,
            (SELECT count(*) FROM rule_proposals
             WHERE project_slug = $1 AND status = 'pending' AND due_at < now())::int AS proposals`,
    [slug],
  );
  out.push(
    { key: 'board_overdue', value: o.rows[0].board, unit: '件' },
    { key: 'rule_proposals_overdue', value: o.rows[0].proposals, unit: '件' },
  );
  const f = await pool.query(
    `SELECT count(*)::int AS n, avg(value)::float8 AS avg
     FROM metric_samples
     WHERE project_slug = $1 AND key = 'outcome_fit_feedback'
       AND collected_at > now() - interval '28 days'`,
    [slug],
  );
  out.push({ key: 'outcome_feedback_28d', value: f.rows[0].n, unit: '件' });
  if (f.rows[0].n > 0) {
    out.push({ key: 'outcome_fit_score', value: f.rows[0].avg, unit: '点' });
  }
  if (i.rows[0].judged > 0) {
    out.push({
      key: 'improvements_achieved_pct',
      value: (i.rows[0].achieved / i.rows[0].judged) * 100,
      unit: '%',
    });
  }
  return out;
}

export interface CollectResult {
  samples: number;
  connectionsOk: number;
  connectionsTotal: number;
  gaps: DataGap[];
}

interface BrokerOutcome {
  name: string;
  kind: string;
  ok: boolean;
  samples: Sample[];
  failure?: 'auth' | 'secret' | 'error';
  error?: string;
}

/**
 * データソースからの取得はクレデンシャルブローカーに依頼する。
 * worker はシークレットの値を持たず、受け取るのは数字だけ。
 */
async function brokerCollect(
  slug: string,
  filter: { names?: string[]; kinds?: string[] },
): Promise<BrokerOutcome[]> {
  const res = await fetch(`${BROKER_URL}/collect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: slug, ...filter }),
  });
  if (!res.ok) throw new Error(`broker /collect failed: ${res.status}`);
  return ((await res.json()) as { results: BrokerOutcome[] }).results;
}

const FAILURE = {
  auth: {
    status: 'needs_reauth',
    state: '認証切れ',
    fix: (slug: string) =>
      `ブローカーに新しいシークレットを登録: PUT ${BROKER_PUBLIC_URL}/secrets/${slug}/<名前>`,
  },
  secret: {
    status: 'needs_secret',
    state: 'シークレット未登録',
    fix: (slug: string) =>
      `ブローカーにシークレットを登録: PUT ${BROKER_PUBLIC_URL}/secrets/${slug}/<名前> に { "value": "..." }`,
  },
  error: {
    status: 'error',
    state: 'エラー',
    fix: () => 'データソースの設定と接続先の状態を確認',
  },
} as const;

/**
 * 登録済みのデータソースから数字を取得して保存する。
 * 認証切れ・シークレット未登録を検知したら、ユーザーに (ブローカーへの) 登録を依頼する。
 * kinds を指定すると、その種類のデータソースだけを対象にする (インフラチェック用)。
 */
export async function collectMetrics(
  slug: string,
  kinds?: string[],
): Promise<CollectResult> {
  await ensureSchema();
  const before = await pool.query(
    'SELECT name, kind, status FROM connections WHERE project_slug = $1',
    [slug],
  );
  const prevStatus = new Map(before.rows.map((r) => [String(r.name), String(r.status)]));
  const wanted = (kind: string) => !kinds || kinds.includes(kind);
  const gaps: DataGap[] = [];
  let samples = 0;

  const results = await brokerCollect(slug, kinds ? { kinds } : {});
  for (const r of results) {
    const setStatus = (status: string, error: string | null) =>
      pool.query(
        `UPDATE connections SET status = $3, last_error = $4, checked_at = now()
         WHERE project_slug = $1 AND name = $2`,
        [slug, r.name, status, error],
      );
    if (r.ok) {
      await insertSamples(slug, r.kind, r.samples);
      await setStatus('ok', null);
      samples += r.samples.length;
      continue;
    }
    const f = FAILURE[r.failure ?? 'error'];
    const reason = r.error ?? '不明なエラー';
    await setStatus(f.status, reason);
    gaps.push({
      subject: `${r.name} (${r.kind})`,
      state: f.state,
      reason,
      needed: f.fix(slug),
    });
    // セッション切れ・キー未登録は、状態が変わったときに1回だけユーザーへ依頼する
    if (r.failure !== 'error' && prevStatus.get(r.name) !== f.status) {
      await notifyUser(
        slug,
        'system',
        'request',
        `データソース ${r.name}: ${f.state}`,
        [
          `理由: ${reason}`,
          `影響: ${CONNECTION_KINDS[r.kind]?.purpose ?? r.kind} の数字を取得できません。`,
          `対応: ${f.fix(slug)}`,
          'シークレットの値はブローカーにだけ渡してください (チーフとの会話や api には書かない)。',
        ].join('\n'),
      );
    }
  }

  const registered = new Set(before.rows.map((r) => String(r.kind)));
  const expected = Object.keys(CONNECTION_KINDS).filter(wanted);
  for (const kind of expected) {
    if (registered.has(kind)) continue;
    gaps.push({
      subject: kind,
      state: '未登録',
      reason: `${CONNECTION_KINDS[kind].purpose} を取得するデータソースがありません`,
      needed: `PUT /projects/${slug}/connections/<名前> で登録`,
    });
  }

  if (!kinds) {
    const internal = await internalSamples(slug);
    for (const s of internal) {
      await insertSamples(slug, metricDef(s.key)?.source ?? 'kobun', [s]);
    }
    samples += internal.length;
  }
  const kindsOk = new Set(results.filter((r) => r.ok).map((r) => r.kind));
  return {
    samples,
    connectionsOk: expected.filter((k) => kindsOk.has(k)).length,
    connectionsTotal: expected.length,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// 週次の振り返り
// ---------------------------------------------------------------------------

export interface RetroSnapshot {
  week: string;
  metrics: MetricRow[];
  past: PastImprovement[];
  worsened: WorsenedMetric[];
  /** 必要なのに取れていない指標 (指標単位) */
  missing: DataGap[];
  /** ロールに渡す要約 */
  text: string;
}

function todayJst(): string {
  return new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export async function retroSnapshot(
  slug: string,
  collected: CollectResult,
): Promise<RetroSnapshot> {
  await ensureSchema();
  const latest = (where: string) =>
    pool.query(
      `SELECT DISTINCT ON (key) key, unit, source, value
       FROM metric_samples
       WHERE project_slug = $1 AND key <> 'outcome_fit_feedback' AND ${where}
       ORDER BY key, collected_at DESC`,
      [slug],
    );
  const cur = await latest("collected_at > now() - interval '36 hours'");
  const prev = await latest("collected_at < now() - interval '6 days'");
  const rows = new Map<string, MetricRow>();
  for (const r of prev.rows) {
    rows.set(r.key, {
      key: r.key,
      unit: r.unit,
      source: r.source,
      current: null,
      previous: Number(r.value),
    });
  }
  for (const r of cur.rows) {
    const existing = rows.get(r.key);
    rows.set(r.key, {
      key: r.key,
      unit: r.unit,
      source: r.source,
      current: Number(r.value),
      previous: existing?.previous ?? null,
    });
  }
  const metrics = [...rows.values()].sort(
    (a, b) => a.source.localeCompare(b.source) || a.key.localeCompare(b.key),
  );

  const open = await pool.query(
    `SELECT id, owner, action, metric_key, baseline, target
     FROM improvements WHERE project_slug = $1 AND status = 'open' ORDER BY id`,
    [slug],
  );
  // 同じ指標で直前まで何回連続して未達だったか
  const history = await pool.query(
    `SELECT metric_key, status FROM improvements
     WHERE project_slug = $1 AND status <> 'open' AND metric_key IS NOT NULL
     ORDER BY id DESC`,
    [slug],
  );
  const priorMisses = (key: string | null): number => {
    if (!key) return 0;
    let n = 0;
    for (const h of history.rows) {
      if (h.metric_key !== key) continue;
      if (h.status !== 'missed') break;
      n += 1;
    }
    return n;
  };
  const past: PastImprovement[] = open.rows.map((r) => {
    const current = r.metric_key ? (rows.get(r.metric_key)?.current ?? null) : null;
    const status = judge(r.baseline, r.target, current);
    return {
      missStreak: status === 'missed' ? priorMisses(r.metric_key) + 1 : 0,
      id: Number(r.id),
      owner: r.owner,
      action: r.action,
      metricKey: r.metric_key,
      baseline: r.baseline,
      target: r.target,
      current,
      status,
    };
  });

  const worsened: WorsenedMetric[] = [];
  for (const m of metrics) {
    const w = worsenedPct(m.key, m.current, m.previous);
    if (w !== null && w > WORSENED_THRESHOLD_PCT) {
      worsened.push({
        key: m.key,
        unit: m.unit,
        owner: ownerOf(m.key) ?? '-',
        previous: m.previous as number,
        current: m.current as number,
        worsePct: w,
      });
    }
  }
  const measured = new Set(metrics.filter((m) => m.current !== null).map((m) => m.key));
  const missing: DataGap[] = missingMetrics(measured).map((m) => ({
    subject: `${m.key} (${m.label})`,
    state: `未計測 / 担当 ${m.owner}`,
    reason: `取得元 ${m.source} から数字が届いていません`,
    needed: m.how.replace('<slug>', slug),
  }));
  const comments = await pool.query(
    `SELECT value, detail->>'comment' AS comment FROM metric_samples
     WHERE project_slug = $1 AND key = 'outcome_fit_feedback'
       AND collected_at > now() - interval '7 days'
     ORDER BY collected_at DESC LIMIT 20`,
    [slug],
  );

  // 未登録の接続は、指標単位の「未計測」で報告する (どの数字が欠けているかが分かるように)
  const issues = collected.gaps.filter((g) => g.state !== '未登録');
  const d = (m: MetricRow) => {
    const v = deltaPct(m.current, m.previous);
    return v === null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
  };
  const text = [
    '## 指標 (前週 → 今週)',
    '| キー | 意味 | 担当 | 単位 | 前週 | 今週 | 増減 |',
    '| --- | --- | --- | --- | ---: | ---: | ---: |',
    ...metrics.map(
      (m) =>
        `| ${m.key} | ${metricDef(m.key)?.label ?? '-'} | ${ownerOf(m.key) ?? '-'} | ${m.unit || '-'} | ${fmt(m.previous)} | ${fmt(m.current)} | ${d(m)} |`,
    ),
    '',
    '## 前週の改善アクションの結果',
    past.length === 0
      ? '(なし)'
      : past
          .map(
            (p) =>
              `- [${p.status}] ${p.owner}: ${p.action} (${p.metricKey ?? '指標なし'}: ${fmt(p.baseline)} → 目標 ${fmt(p.target)}, 実績 ${fmt(p.current)}, 連続未達 ${p.missStreak} 回)`,
          )
          .join('\n'),
    '',
    `## 前週より ${WORSENED_THRESHOLD_PCT}% を超えて悪化した指標 (担当は対応アクションか許容理由が必要)`,
    worsened.length === 0
      ? '(なし)'
      : worsened
          .map(
            (w) =>
              `- ${w.key} (担当 ${w.owner}): ${fmt(w.previous)} → ${fmt(w.current)} (${w.worsePct.toFixed(1)}% 悪化)`,
          )
          .join('\n'),
    '',
    '## 未計測の必要指標 (担当は計測できるようにするアクションを優先する)',
    missing.length === 0
      ? '(なし)'
      : missing.map((g) => `- ${g.subject}: ${g.state}。取得方法: ${g.needed}`).join('\n'),
    '',
    '## 接続の問題',
    issues.length === 0
      ? '(なし)'
      : issues.map((g) => `- ${g.subject}: ${g.state} (${g.reason})`).join('\n'),
    '',
    '## 直近7日のユーザーフィードバック (評価 1〜5 とコメント)',
    comments.rows.length === 0
      ? '(なし)'
      : comments.rows
          .map((c) => `- ${fmt(Number(c.value))} 点: ${String(c.comment ?? '').slice(0, 300)}`)
          .join('\n'),
  ].join('\n');

  return { week: todayJst(), metrics, past, worsened, missing, text };
}

export interface RetroDecision {
  improvements: OutImprovement[];
  rules: OutRule[];
  ruleRetires: OutRuleRetire[];
  adrs: OutAdr[];
  proposals: OutProposal[];
  feedbackRequests: string[];
  /** 提案を出せなかったロールと理由 */
  roleErrors: { role: RoleId; error: string }[];
}

export interface RetroApplied {
  reportPath: string;
  improvements: number;
  /** PjM に渡す実行指示 (改善アクションが無ければ空) */
  instruction: string;
}

/**
 * 振り返りの結果を確定する: 前週アクションの判定、今週アクションの登録、
 * ルールと ADR の追加、改善レポートの作成とユーザーへの送付。
 */
export async function applyRetro(
  project: ProjectInfo,
  snap: RetroSnapshot,
  collected: CollectResult,
  decision: RetroDecision,
): Promise<RetroApplied> {
  await ensureSchema();
  const slug = project.slug;
  const byKey = new Map(snap.metrics.map((m) => [m.key, m]));

  for (const p of snap.past) {
    await pool.query(
      `UPDATE improvements SET status = $2, result_value = $3, closed_at = now()
       WHERE id = $1 AND status = 'open'`,
      [p.id, p.status, p.current],
    );
  }

  const next: NewImprovement[] = decision.improvements.map((i) => ({
    owner: isRoleId(i.owner) ? i.owner : 'pjm',
    action: i.action,
    metricKey: i.metric,
    baseline: i.metric ? (byKey.get(i.metric)?.current ?? null) : null,
    target: i.target,
  }));
  for (const n of next) {
    await pool.query(
      `INSERT INTO improvements (project_slug, week, owner, action, metric_key, baseline, target)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [slug, snap.week, n.owner, n.action, n.metricKey, n.baseline, n.target],
    );
  }

  const ruleChanges = await applyRuleChanges(
    { slug, client: project.client },
    decision.rules,
    decision.ruleRetires,
    `retro:${slug}:${snap.week}`,
    // kobun 共通とクライアントの層は他のプロジェクトにも効くので、ユーザーの承認を待つ
    { requireApproval: true },
  );
  await notifyPendingProposals(slug, 'pjm', `${project.name}: 行動ルールの変更`, ruleChanges);

  const adrTitles: string[] = [];
  if (decision.adrs.length > 0) {
    const files = await listProjectFiles(slug);
    let n = files.filter((f) => /^adr\/\d{4}/.test(f)).length;
    for (const adr of decision.adrs) {
      n += 1;
      const id = String(n).padStart(4, '0');
      const name = slugify(adr.title) || 'adr';
      await writeProjectFile(
        slug,
        `adr/${id}-${name}.md`,
        `# ADR-${id}: ${adr.title}\n\n日付: ${snap.week}\n\n${adr.content}\n`,
      );
      adrTitles.push(`ADR-${id}: ${adr.title}`);
    }
  }

  const gaps: DataGap[] = [
    ...collected.gaps.filter((g) => g.state !== '未登録'),
    ...snap.missing,
    ...decision.roleErrors.map((e) => ({
      subject: ROLES[e.role].title,
      state: '提案なし',
      reason: e.error,
      needed: 'LLM の資格情報と稼働状況を確認',
    })),
  ];
  const report = renderRetroReport({
    project: project.name,
    week: snap.week,
    metrics: snap.metrics,
    past: snap.past,
    next,
    client: project.clientName || project.client,
    ruleChanges,
    worsened: snap.worsened,
    adrs: adrTitles,
    proposals: decision.proposals,
    gaps,
    connectionsOk: collected.connectionsOk,
    connectionsTotal: collected.connectionsTotal,
  });
  const reportPath = `reports/retro-${snap.week}.md`;
  await writeProjectFile(slug, reportPath, report);
  await notifyUser(
    slug,
    'pjm',
    'report',
    `改善レポート ${project.name} (${snap.week} 週)`,
    report,
  );
  for (const q of decision.feedbackRequests) {
    await notifyUser(
      slug,
      'business-analyst',
      'request',
      `${project.name}: フィードバックのお願い`,
      q,
    );
  }

  const instruction =
    next.length === 0
      ? ''
      : [
          `週次の振り返り (${snap.week}) で次の改善アクションが決まりました。担当ロールに指示して実行させてください。`,
          '結果は来週の振り返りで、指標の計測値によって自動判定されます。',
          '',
          ...next.map(
            (n) =>
              `- 担当 ${n.owner}: ${n.action} (指標 ${n.metricKey ?? 'なし'}: 現在 ${fmt(n.baseline)} → 目標 ${fmt(n.target)})`,
          ),
        ].join('\n');
  return {
    reportPath: projectPath(slug, reportPath),
    improvements: next.length,
    instruction,
  };
}

// ---------------------------------------------------------------------------
// インフラチェック (日次)
// ---------------------------------------------------------------------------

const INFRA_KINDS = ['aws', 'postgres'];

export interface InfraCheckResult {
  anomalies: number;
  /** インフラエンジニアに渡す、原因切り分けの依頼 (異常が無ければ空) */
  triage: string;
  /** エンジニア (リード) に渡す、遅いクエリの修正依頼 (新規が無ければ空) */
  slowQueryReport: string;
}

/**
 * インフラの数字を取得し、異常値・コスト増加・新しい遅いクエリを検出する。
 * 検出は閾値による機械判定で、検出したら必ずユーザーにアラートを送る。
 */
export async function infraCheck(project: ProjectInfo): Promise<InfraCheckResult> {
  const slug = project.slug;
  await collectMetrics(slug, INFRA_KINDS);

  const res = await pool.query(
    `SELECT key, unit, value FROM (
       SELECT key, unit, value, collected_at,
              row_number() OVER (PARTITION BY key ORDER BY collected_at DESC) AS rn
       FROM metric_samples
       WHERE project_slug = $1 AND source = ANY($2) AND key <> 'cost_usd_prev_7d'
     ) t WHERE rn <= 15 ORDER BY key, collected_at`,
    [slug, INFRA_KINDS],
  );
  const map = new Map<string, Series>();
  for (const r of res.rows) {
    const s: Series = map.get(r.key) ?? { key: r.key, unit: r.unit, values: [] };
    s.values.push(Number(r.value));
    map.set(r.key, s);
  }
  const anomalies = detectAnomalies([...map.values()]);

  // 遅いクエリ: 前回の計測に無かったものだけを新規として報告する
  const sq = await pool.query(
    `SELECT detail FROM metric_samples
     WHERE project_slug = $1 AND key = 'db_slow_queries'
     ORDER BY collected_at DESC LIMIT 2`,
    [slug],
  );
  const queriesOf = (row: any): SlowQuery[] => row?.detail?.queries ?? [];
  const seen = new Set(queriesOf(sq.rows[1]).map((q) => q.query));
  const fresh = queriesOf(sq.rows[0]).filter((q) => !seen.has(q.query));

  if (anomalies.length === 0 && fresh.length === 0) {
    return { anomalies: 0, triage: '', slowQueryReport: '' };
  }
  const alert = renderInfraAlert(project.name, anomalies, fresh);
  await notifyUser(
    slug,
    'infra-engineer',
    'alert',
    `インフラアラート ${project.name}: 異常値 ${anomalies.length} 件 / 新規の遅いクエリ ${fresh.length} 件`,
    alert,
  );
  return {
    anomalies: anomalies.length,
    triage:
      anomalies.length === 0
        ? ''
        : `次の異常値を検知し、ユーザーにアラートを送りました。原因の切り分けと対処案をまとめてください。\n\n${alert}`,
    slowQueryReport:
      fresh.length === 0
        ? ''
        : [
            '遅いクエリを検出しました。修正をお願いします。',
            '',
            ...renderSlowQueries(fresh),
          ].join('\n'),
  };
}
