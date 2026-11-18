import type { Message } from './shared';
import { pool, ensureSchema } from './db';
import {
  agentBackend,
  generate,
  hasAnthropicApiKey,
  hasClaudeCliCredentials,
} from './llm';

// エージェント組織 (チーフ / PjM / 各ロール)、数字の自動取得、振り返りの Activity
export * from './org-activities';
// 巡回 (期限切れの段階上げ) と、保留した実装タスクの再開
export * from './followup-activities';
import { notifyPendingProposals, notifyUser } from './org-activities';
import { activeRules, applyRuleChanges } from './rules';
import type { RuleChange } from './metrics/report';
import {
  analysisPrompt,
  errorExamples,
  extractRuleProposals,
  feedSummary,
  jstDate,
  renderReport,
  summarizeTurns,
  type OuterLoopStats,
  type TurnRow,
} from './outer-loop';

const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://sandbox:7000';

const ensureTable = ensureSchema;

// セッション履歴の平文ログ。Pi 側の内部テーブルとは別に、人が読める形で残す。
// Outer Loop の分析材料はここから取る。
async function checkpoint(messages: Message[]): Promise<void> {
  await ensureTable();
  await pool.query('INSERT INTO checkpoints (messages) VALUES ($1)', [
    JSON.stringify(messages),
  ]);
}

// Sandbox-as-a-tool: bash の実行だけをサンドボックス内のデーモンに委譲する。
async function callSandbox(cmd: string): Promise<string> {
  const res = await fetch(`${SANDBOX_URL}/exec`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd }),
  });
  const data = (await res.json()) as {
    stdout: string;
    stderr: string;
    code: number;
  };
  return `$ ${cmd}\n${data.stdout}${data.stderr}(exit ${data.code})`;
}

// 単発のテキスト生成 (grilling の質問生成、Outer Loop の分析、CLI バックエンドの応答)
// LLM バックエンドの実体は ./llm にある。
function callLLM(messages: Message[]): Promise<string> {
  return generate({ messages });
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
      const { runPiTurn } = await import('./pi/harness');
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

// 回答期限切れのタスクを、再開できる形で保存して停止する。
// 保留したことと再開の方法を、その場でユーザーに知らせる (黙って止めない)。
export async function parkTask(
  sessionId: string,
  request: string,
  questions: string[],
): Promise<void> {
  await ensureTable();
  const res = await pool.query(
    'INSERT INTO parked_tasks (session_id, request, questions) VALUES ($1, $2, $3) RETURNING id',
    [sessionId, request, JSON.stringify(questions)],
  );
  const id = res.rows[0].id;
  await notifyUser(
    null,
    'system',
    'request',
    `実装タスク #${id} を保留しました (質問への回答が 3 時間ありませんでした)`,
    [
      `依頼: ${request}`,
      '',
      '回答待ちの質問:',
      ...questions.map((q, i) => `${i + 1}. ${q}`),
      '',
      `回答すれば、質問をやり直さずに実装から再開します: 対話コマンドで \`/resume ${id} <回答>\` (API は \`POST /parked/${id}/answer\` に \`{ "text": "..." }\`)`,
      `不要なら取り下げられます: \`/drop ${id}\``,
    ].join('\n'),
  );
}

// ---------------------------------------------------------------------------
// Outer Loop: 直近 24 時間のエージェントの動きを集計し、改善レポートを作る
// 材料は agent_turns (チーフ・PjM・各ロールの発言の記録)。旧来のセッション (checkpoints) があれば件数を足す。
// 集計は outer-loop.ts (コード)、LLM は数字を根拠にした解釈と改善案だけを書く。
// ---------------------------------------------------------------------------

const OUTER_LOOP_WINDOW_HOURS = 24;

export interface OuterLoopInput {
  date: string;
  stats: OuterLoopStats;
  examples: ReturnType<typeof errorExamples>;
}

export type OuterLoopAnalysis = { ok: true; text: string } | { ok: false; error: string };

/** 共通ルールの提案を、承認待ちに載せた結果 */
export interface OuterLoopProposals {
  changes: RuleChange[];
  dropped: string[];
}

export async function collectOuterLoopInput(): Promise<OuterLoopInput> {
  await ensureTable();
  const turns = await pool.query<TurnRow>(
    `SELECT project_slug, role, sender, input, output, duration_ms, error, created_at
     FROM agent_turns
     WHERE created_at > now() - make_interval(hours => $1)
     ORDER BY created_at`,
    [OUTER_LOOP_WINDOW_HOURS],
  );
  const legacy = await pool.query(
    `SELECT count(*)::int AS n FROM checkpoints WHERE created_at > now() - make_interval(hours => $1)`,
    [OUTER_LOOP_WINDOW_HOURS],
  );
  return {
    date: jstDate(new Date()),
    stats: summarizeTurns(turns.rows, {
      windowHours: OUTER_LOOP_WINDOW_HOURS,
      legacySessions: legacy.rows[0].n,
    }),
    examples: errorExamples(turns.rows),
  };
}

export async function analyzeOuterLoop(input: OuterLoopInput): Promise<OuterLoopAnalysis> {
  // 記録が無いなら LLM を呼ばない
  if (input.stats.records === 0 && input.stats.legacySessions === 0) return { ok: true, text: '' };
  try {
    const rules = await activeRules({ slug: '', client: '' });
    const text = await callLLM([
      {
        role: 'user',
        content: analysisPrompt(input.stats, input.examples, rules.common).slice(0, 20000),
      },
    ]);
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) };
  }
}

/**
 * 分析にあった共通ルールの提案を、承認待ちに載せる。ルールは変わらない (承認はユーザー)。
 * 返す分析本文はタグを除いたもの。
 */
export async function proposeOuterLoopRules(
  input: OuterLoopInput,
  analysis: OuterLoopAnalysis,
): Promise<{ analysis: OuterLoopAnalysis; proposals: OuterLoopProposals }> {
  if (!analysis.ok) return { analysis, proposals: { changes: [], dropped: [] } };
  const extracted = extractRuleProposals(analysis.text);
  // 提案は、承認待ちの仕組みを通す。同じ提案は重ねず、却下された提案は蒸し返さない
  const changes = await applyRuleChanges(
    { slug: 'outer-loop', client: '' },
    extracted.rules,
    extracted.retires,
    `outer-loop:${input.date}`,
    { requireApproval: true },
  );
  await notifyPendingProposals(null, 'outer-loop', `Outer Loop ${input.date}: kobun 共通ルールの変更`, changes);
  return {
    analysis: { ok: true, text: extracted.text },
    proposals: { changes, dropped: extracted.dropped },
  };
}

export async function writeOuterLoopReport(
  input: OuterLoopInput,
  analysis: OuterLoopAnalysis,
  proposals: OuterLoopProposals = { changes: [], dropped: [] },
): Promise<string> {
  const path = `reports/outer-loop-${input.date}.md`;
  const res = await fetch(`${SANDBOX_URL}/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path,
      content: renderReport(input.date, input.stats, analysis, proposals),
    }),
  });
  if (!res.ok) throw new Error(`sandbox write failed: ${res.status}`);
  // 動きがあった日だけ、要点 (数字) をユーザーのフィードに出す
  if (input.stats.records > 0) {
    const pending = proposals.changes.filter((c) => c.proposalId !== undefined).length;
    await notifyUser(
      null,
      'outer-loop',
      input.stats.errors > 0 ? 'alert' : 'report',
      `Outer Loop ${input.date}`,
      feedSummary(input.stats, path, pending),
    );
  }
  return path;
}
