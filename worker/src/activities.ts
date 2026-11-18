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
import { notifyUser } from './org-activities';

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
