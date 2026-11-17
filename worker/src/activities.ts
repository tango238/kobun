import { Pool } from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Message } from './shared';
import { runPiTurn } from './pi/harness';

const execFileAsync = promisify(execFile);

const pool = new Pool({
  connectionString:
    process.env.CHECKPOINT_DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/checkpoints',
});
const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://sandbox:7000';

let tableReady: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  tableReady ??= pool
    .query(
      `CREATE TABLE IF NOT EXISTS checkpoints (
         id BIGSERIAL PRIMARY KEY,
         messages JSONB NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    )
    .then(() => undefined);
  return tableReady;
}

// セッション履歴の平文ログ。Pi 側の内部テーブルとは別に、人が読める形で残す。
// Outer Loop の分析材料はここから取る。
async function checkpoint(messages: Message[]): Promise<void> {
  await ensureTable();
  await pool.query('INSERT INTO checkpoints (messages) VALUES ($1)', [
    JSON.stringify(messages),
  ]);
}

// サンドボックスデーモンの /exec を叩き、生の結果を返す
async function sandboxExec(
  cmd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const res = await fetch(`${SANDBOX_URL}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
  return (await res.json()) as {
    stdout: string;
    stderr: string;
    code: number;
  };
}

// Sandbox-as-a-tool: bash の実行だけをサンドボックス内のデーモンに委譲する。
async function callSandbox(cmd: string): Promise<string> {
  const data = await sandboxExec(cmd);
  return `$ ${cmd}\n${data.stdout}${data.stderr}(exit ${data.code})`;
}

// ---------------------------------------------------------------------------
// LLM バックエンド (LLM_BACKEND で切り替え可能)
// - pi:        Pi Durable のエージェントループ。ANTHROPIC_API_KEY が必須。
// - claude-cli: 公式 Claude Code を `claude -p` で呼ぶ。
//              CLAUDE_CODE_OAUTH_TOKEN (Claude Max) か ANTHROPIC_API_KEY
//              のどちらかが必要。
// 単発のテキスト生成 (grilling / Outer Loop) も選択中バックエンドの
// 資格情報を使う (pi の場合は Anthropic API を直接呼ぶ)。
// ---------------------------------------------------------------------------

type AgentBackend = 'claude-cli' | 'pi' | 'dummy';

function agentBackend(): AgentBackend {
  const b = (process.env.LLM_BACKEND ?? '').toLowerCase();
  if (b === 'pi' || b === 'pi-durable') return 'pi';
  if (
    b === 'claude-cli' ||
    b === 'claude' ||
    b === 'claude-code' ||
    b === 'claude-p'
  ) {
    return 'claude-cli';
  }
  // 未指定時の既定は claude-cli (どちらかの資格情報があれば使える)
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
    return 'claude-cli';
  }
  return 'dummy';
}

function hasAnthropicApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function hasClaudeCliCredentials(): boolean {
  return Boolean(
    process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
  );
}

function formatTranscript(messages: Message[]): string {
  return messages
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}:\n${m.content}`)
    .join('\n\n');
}

async function callClaudeCli(messages: Message[]): Promise<string> {
  const args = ['-p', '--output-format', 'json'];
  if (process.env.CLAUDE_MODEL) args.push('--model', process.env.CLAUDE_MODEL);
  args.push(
    'Answer the latest user request in the transcript provided on stdin. ' +
      'Do not call tools. Respond with text only, in the language of the latest user message.',
  );
  // 資格情報 (OAuth トークン / API キー) の優先順位は Claude Code 側の仕様に任せる
  const { stdout } = await execFileAsync('claude', args, {
    input: formatTranscript(messages),
    env: { ...process.env },
    cwd: '/tmp',
    timeout: 10 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const text = stdout.toString().trim();
  try {
    const parsed = JSON.parse(text) as any;
    if (parsed?.is_error) {
      throw new Error(String(parsed.result ?? 'claude -p failed'));
    }
    if (typeof parsed?.result === 'string') return parsed.result;
  } catch (err) {
    if (err instanceof SyntaxError) return text;
    throw err;
  }
  return text;
}

async function callAnthropicApi(messages: Message[]): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is not set (required for LLM_BACKEND=pi)');
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.PI_MODEL_ID ?? 'claude-sonnet-4-5',
      max_tokens: 4096,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
  });
  const data = (await res.json()) as any;
  return data?.content?.[0]?.text ?? JSON.stringify(data);
}

// 単発のテキスト生成 (grilling の質問生成、Outer Loop の分析、CLI バックエンドの応答)
async function callLLM(messages: Message[]): Promise<string> {
  const backend = agentBackend();
  if (backend === 'pi') return callAnthropicApi(messages);
  if (backend === 'claude-cli') {
    if (!hasClaudeCliCredentials()) {
      throw new Error(
        'claude-cli backend requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY',
      );
    }
    return callClaudeCli(messages);
  }
  throw new Error(
    'LLM is not configured: set LLM_BACKEND and the required credential in .env',
  );
}

/**
 * エージェントループの1ステップ。
 * 1. 現在の履歴を平文チェックポイントに保存 (Outer Loop の材料)
 * 2. "bash:" で始まれば直接サンドボックスで実行 (動作確認用ショートカット)
 * 3. LLM_BACKEND に応じて応答を生成する
 *    - pi:        Pi Durable ハーネスで1ターンを回す (ANTHROPIC_API_KEY 必須)
 *    - claude-cli: 公式 Claude Code を `claude -p` で呼ぶ
 *                  (CLAUDE_CODE_OAUTH_TOKEN か ANTHROPIC_API_KEY が必要)
 */
export async function runAgentStep(
  sessionId: string,
  messages: Message[],
): Promise<string> {
  await checkpoint(messages);
  const last = messages[messages.length - 1];
  if (last?.role === 'user' && last.content.startsWith('bash:')) {
    return callSandbox(last.content.slice('bash:'.length).trim());
  }
  const backend = agentBackend();
  if (backend === 'pi') {
    if (!hasAnthropicApiKey()) {
      return '(LLM_BACKEND=pi には ANTHROPIC_API_KEY が必要です)';
    }
    try {
      return await runPiTurn(
        sessionId,
        last.content,
        `${sessionId}-${messages.length}`,
      );
    } catch (err) {
      return `(Pi Durable でエラーが発生しました: ${String(err)})`;
    }
  }
  if (backend === 'claude-cli') {
    if (!hasClaudeCliCredentials()) {
      return '(LLM_BACKEND=claude-cli には CLAUDE_CODE_OAUTH_TOKEN か ANTHROPIC_API_KEY が必要です)';
    }
    try {
      return await callLLM(messages);
    } catch (err) {
      return `(LLM 呼び出しでエラーが発生しました: ${String(err)})`;
    }
  }
  return '(LLM 未設定のためダミー応答です) メッセージを受け取りました。.env で LLM_BACKEND と資格情報を設定してください。';
}

// ---------------------------------------------------------------------------
// grilling / ask-a-person: 実装着手前の要件確認
// ---------------------------------------------------------------------------

const GRILLING_FALLBACK: string[] = [
  'この実装の目的は何で、何ができたら完了と言えますか？',
  '対象範囲はどこまでですか？ 触ってはいけないものはありますか？',
  '既存の何と連携しますか？ 入出力の形式はどうなっていますか？',
  'エラー時や想定外の入力のとき、どう振る舞うべきですか？',
  '性能・セキュリティ・運用上の制約はありますか？',
];

// grilling: 実装依頼から、要件を詰めるための質問を生成する
export async function grillQuestions(request: string): Promise<string[]> {
  try {
    const text = await callLLM([
      {
        role: 'user',
        content: [
          '次の実装依頼について、着手前に要件を詰めるための鋭い質問を5つ挙げてください。',
          '日本語で、1行に1問、番号や記号は付けずに質問文だけを返してください。',
          '',
          `実装依頼: ${request}`,
        ].join('\n'),
      },
    ]);
    const questions = text
      .split('\n')
      .map((s) => s.replace(/^[0-9]+[.、)）]\s*/, '').trim())
      .filter((s) => s.length > 0)
      .slice(0, 7);
    return questions.length > 0 ? questions : GRILLING_FALLBACK;
  } catch {
    return GRILLING_FALLBACK;
  }
}

// 回答期限切れのタスクを、再開できる形で保存して停止する
export async function parkTask(
  sessionId: string,
  request: string,
  questions: string[],
): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS parked_tasks (
       id BIGSERIAL PRIMARY KEY,
       session_id TEXT NOT NULL,
       request TEXT NOT NULL,
       questions JSONB NOT NULL,
       status TEXT NOT NULL DEFAULT 'timeout_parked',
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  await pool.query(
    'INSERT INTO parked_tasks (session_id, request, questions) VALUES ($1, $2, $3)',
    [sessionId, request, JSON.stringify(questions)],
  );
}

// ---------------------------------------------------------------------------
// Outer Loop: 前日のセッション記録を分析し、改善レポートを作る
// ---------------------------------------------------------------------------

export async function fetchRecentCheckpoints(): Promise<{
  count: number;
  digest: string;
}> {
  await ensureTable();
  const res = await pool.query(
    `SELECT messages, created_at FROM checkpoints
     WHERE created_at > now() - interval '24 hours'
     ORDER BY created_at`,
  );
  const lines = res.rows.map((r) => {
    const msgs = r.messages as Message[];
    const tail = msgs.slice(-4);
    const text = tail
      .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
      .join('\n');
    return `--- ${new Date(r.created_at).toISOString()} ---\n${text}`;
  });
  return { count: res.rows.length, digest: lines.join('\n') };
}

export async function analyzeSessions(input: {
  count: number;
  digest: string;
}): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  if (input.count === 0) {
    return `# Outer Loop レポート ${date}\n\n過去24時間のセッション記録はありませんでした。\n`;
  }
  try {
    const analysis = await callLLM([
      {
        role: 'user',
        content: [
          '以下は過去24時間のエージェントセッション記録です。',
          'エージェントがつまずいた点、人間が指摘・修正した点を探し、',
          'ハーネスやスキルの改善提案を Markdown でまとめてください。',
          '',
          input.digest.slice(0, 20000),
        ].join('\n'),
      },
    ]);
    return `# Outer Loop レポート ${date}\n\n${analysis}\n`;
  } catch (err) {
    return [
      `# Outer Loop レポート ${date}`,
      '',
      `チェックポイント件数: ${input.count} (LLM 分析に失敗したため要約のみ: ${String(err)})`,
      '',
      '```',
      input.digest.slice(0, 4000),
      '```',
    ].join('\n');
  }
}

export async function writeOuterLoopReport(
  markdown: string,
): Promise<string> {
  const date = new Date().toISOString().slice(0, 10);
  const path = `reports/outer-loop-${date}.md`;
  const res = await fetch(`${SANDBOX_URL}/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content: markdown }),
  });
  if (!res.ok) throw new Error(`sandbox write failed: ${res.status}`);
  return path;
}

// ---------------------------------------------------------------------------
// Outer Loop の改善 PR: 分析から変更案を作り、sandbox 経由で Draft PR を開く
//
// ガードレール (運用ルールとして合意したもの):
//  - PR は Draft で作る。マージは人間が行う
//  - 1回の実行で PR は最大1本、変更は最大5ファイルまで
//  - egress/addon.py と docker-compose.yml (セキュリティ境界) は変更禁止
//  - .env の作成・変更は禁止 (.env.example は可)
//  - ブランチは outer-loop/<日付>。既にあれば作らない (日次で冪等)
// sandbox 内には実トークンを置かない: git のリモート URL には
// プレースホルダーを入れ、egress が通信時に本物へ差し替える。
// PR 作成の API 呼び出しも同様にプレースホルダーを Authorization に入れる。
// ---------------------------------------------------------------------------

const IMPROVEMENT_REPO = 'owner/repo';
const IMPROVEMENT_REPO_URL = 'https://github.com/owner/repo.git';
const IMPROVEMENT_REMOTE_URL =
  'https://x-access-token:dummy-placeholder@github.com/owner/repo.git';
const IMPROVEMENT_FORBIDDEN = new Set(['egress/addon.py', 'docker-compose.yml']);
const IMPROVEMENT_MAX_FILES = 5;

export interface ImprovementPrResult {
  status: 'created' | 'skipped' | 'failed';
  prUrl?: string;
  reason?: string;
}

interface ImprovementPlan {
  title: string;
  summary: string;
  changes: { path: string; content: string }[];
}

// LLM に現在のリポジトリ内容と分析レポートを渡し、変更案 (ファイル全文) を作らせる
async function generateImprovementPlan(
  report: string,
  digest: string,
  files: { path: string; content: string }[],
): Promise<ImprovementPlan | null> {
  const filesSection = files
    .map((f) => `--- ${f.path} ---\n${f.content}`)
    .join('\n\n');
  const text = await callLLM([
    {
      role: 'user',
      content: [
        'あなたは kobun (エージェント基盤の学習用プロジェクト) の改善担当です。',
        'Outer Loop の分析レポートと現在のリポジトリ内容を読み、最も価値のある「小さな改善」を1つだけ選んでください。',
        '出力は JSON のみで、形式は {"title": "PRタイトル", "summary": "変更の要約", "changes": [{"path": "相対パス", "content": "変更後のファイル全文"}]} としてください。',
        '制約: 変更は最大5ファイル。egress/addon.py と docker-compose.yml は変更禁止。.env の作成・変更も禁止。既存ファイルは差分ではなく全文を返すこと。',
        '小さく安全な改善が無い場合は {"title": "", "summary": "", "changes": []} を返してください。',
        '',
        '## 分析レポート',
        report.slice(0, 6000),
        '',
        '## セッション要約',
        digest.slice(0, 4000),
        '',
        '## 現在のリポジトリ',
        filesSection,
      ].join('\n'),
    },
  ]);
  let parsed: any;
  try {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || !Array.isArray(parsed.changes)) return null;
  const changes: { path: string; content: string }[] = [];
  const seen = new Set<string>();
  for (const ch of parsed.changes) {
    if (typeof ch?.path !== 'string' || typeof ch?.content !== 'string') {
      return null;
    }
    const p = ch.path.replace(/^\.\//, '');
    if (
      p.startsWith('/') ||
      p.includes('..') ||
      p.startsWith('.git/') ||
      IMPROVEMENT_FORBIDDEN.has(p) ||
      (p.startsWith('.env') && p !== '.env.example')
    ) {
      return null;
    }
    if (seen.has(p)) return null;
    seen.add(p);
    changes.push({ path: p, content: ch.content });
  }
  if (changes.length === 0 || changes.length > IMPROVEMENT_MAX_FILES) {
    return null;
  }
  return {
    title: String(parsed.title ?? 'Outer Loop: improvement').slice(0, 80),
    summary: String(parsed.summary ?? ''),
    changes,
  };
}

async function sandboxWrite(path: string, content: string): Promise<boolean> {
  const res = await fetch(`${SANDBOX_URL}/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, content }),
  });
  return res.ok;
}

export async function createImprovementPr(
  report: string,
  digest: string,
  count: number,
): Promise<ImprovementPrResult> {
  if (count === 0) {
    return { status: 'skipped', reason: '対象セッションがありません' };
  }
  const date = new Date().toISOString().slice(0, 10);
  const branch = `outer-loop/${date}`;
  try {
    // リポジトリを用意する (初回は clone、以降は main を最新化)
    let r = await sandboxExec(
      `test -d kobun/.git || git clone ${IMPROVEMENT_REPO_URL} kobun`,
    );
    if (r.code !== 0) {
      return { status: 'failed', reason: `clone に失敗: ${r.stderr.slice(0, 300)}` };
    }
    r = await sandboxExec(
      'cd kobun && git config user.name "kobun-outer-loop" ' +
        '&& git config user.email "outer-loop@kobun.local" ' +
        `&& git remote set-url origin ${IMPROVEMENT_REMOTE_URL} ` +
        '&& git checkout main && git pull --ff-only',
    );
    if (r.code !== 0) {
      return {
        status: 'failed',
        reason: `リポジトリ更新に失敗: ${r.stderr.slice(0, 300)}`,
      };
    }
    // 日次で冪等に: 同日のブランチが既にあれば作らない
    const exists = await sandboxExec(
      `cd kobun && git ls-remote --exit-code --heads origin ${branch}`,
    );
    if (exists.code === 0) {
      return { status: 'skipped', reason: `ブランチ ${branch} は作成済みです` };
    }
    // 現在のファイル内容を読む (LLM が全文差し替えを作るための材料)
    const listRes = await sandboxExec('cd kobun && git ls-files');
    const repoPaths = listRes.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const files: { path: string; content: string }[] = [];
    let total = 0;
    for (const p of repoPaths) {
      if (total > 80000) break;
      try {
        const fr = await fetch(`${SANDBOX_URL}/read`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: `kobun/${p}` }),
        });
        if (!fr.ok) continue;
        const fd = (await fr.json()) as { content: string };
        if (fd.content.length > 20000) continue;
        files.push({ path: p, content: fd.content });
        total += fd.content.length;
      } catch {
        // 読めないファイル (バイナリ等) は読み飛ばす
      }
    }
    const plan = await generateImprovementPlan(report, digest, files);
    if (!plan) {
      return {
        status: 'skipped',
        reason: '制約内に収まる改善案が得られませんでした',
      };
    }
    // ブランチを切って変更を書き込む
    r = await sandboxExec(`cd kobun && git checkout -b ${branch}`);
    if (r.code !== 0) {
      return { status: 'failed', reason: `ブランチ作成に失敗: ${r.stderr.slice(0, 300)}` };
    }
    for (const ch of plan.changes) {
      const ok = await sandboxWrite(`kobun/${ch.path}`, ch.content);
      if (!ok) {
        return { status: 'failed', reason: `ファイル書き込みに失敗: ${ch.path}` };
      }
    }
    // commit (メッセージはファイル経由で渡し、引用符の問題を避ける)
    await sandboxWrite(
      'outer-loop-commit-msg.txt',
      `${plan.title}\n\n${plan.summary}\n`,
    );
    const addPaths = plan.changes.map((c) => `'${c.path}'`).join(' ');
    r = await sandboxExec(
      `cd kobun && git add -- ${addPaths} && git commit -F ../outer-loop-commit-msg.txt`,
    );
    if (r.code !== 0) {
      return { status: 'failed', reason: `commit に失敗: ${r.stderr.slice(0, 300)}` };
    }
    r = await sandboxExec(`cd kobun && git push origin ${branch}`);
    if (r.code !== 0) {
      return {
        status: 'failed',
        reason:
          'push に失敗しました (.env の GITHUB_TOKEN が egress に設定されているか確認してください): ' +
          r.stderr.slice(0, 300),
      };
    }
    // Draft PR を作成する (Authorization のプレースホルダーは egress が差し替える)
    const prBody = {
      title: plan.title,
      body: [
        '## Outer Loop による自動改善 PR (Draft)',
        '',
        plan.summary,
        '',
        'この PR は Outer Loop が前日のセッション分析から自動生成しました。内容を確認してからマージしてください。',
        '',
        '<details><summary>分析レポート抜粋</summary>',
        '',
        report.slice(0, 3000),
        '',
        '</details>',
      ].join('\n'),
      head: branch,
      base: 'main',
      draft: true,
    };
    await sandboxWrite('outer-loop-pr.json', JSON.stringify(prBody));
    r = await sandboxExec(
      `curl -s -X POST https://api.github.com/repos/${IMPROVEMENT_REPO}/pulls ` +
        '-H "Authorization: Bearer dummy-placeholder" ' +
        '-H "Accept: application/vnd.github+json" ' +
        '--data @outer-loop-pr.json',
    );
    let prUrl: string | undefined;
    try {
      prUrl = JSON.parse(r.stdout)?.html_url;
    } catch {
      // 失敗として下で扱う
    }
    await sandboxExec('rm -f outer-loop-commit-msg.txt outer-loop-pr.json');
    if (!prUrl) {
      return {
        status: 'failed',
        reason: `PR 作成に失敗: ${r.stdout.slice(0, 300)}`,
      };
    }
    return { status: 'created', prUrl };
  } catch (err) {
    return { status: 'failed', reason: String(err).slice(0, 500) };
  }
}
