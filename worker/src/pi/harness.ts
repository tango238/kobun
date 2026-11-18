import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { AssistantEntry } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { PostgresSqliteDatabase } from './postgres-database';
import { SandboxExecutionEnv } from './sandbox-env';

// Pi Durable ハーネスのセッションごとの管理。
// 保存先は Postgres (SqliteDatabase ファサード経由)、ツール実行先はサンドボックス。
// ハーネスはメモリ上にキャッシュするだけにし、正は常にストレージ側に置く。
//
// 認証: Pi バックエンド (LLM_BACKEND=pi) では ANTHROPIC_API_KEY が必須。
// pi-ai の anthropicProvider が環境変数から読み取る。
// CLAUDE_CODE_OAUTH_TOKEN は `claude -p` 側の資格情報で、Pi は読まない。
const harnesses = new Map<string, Harness>();

async function getHarness(sessionId: string): Promise<Harness> {
  const existing = harnesses.get(sessionId);
  if (existing) return existing;

  const db = await PostgresSqliteDatabase.open(
    process.env.CHECKPOINT_DATABASE_URL ??
      'postgres://postgres:postgres@localhost:5432/checkpoints',
  );
  const storage = await SqliteStorage.open(db, {
    prefix: `pi_${sessionId.replace(/[^a-zA-Z0-9]/g, '_')}`,
  });

  const models = createModels();
  models.setProvider(anthropicProvider());

  const registry = createRegistry();
  registry.install(CodingTools);

  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: ({ cwd }: { cwd?: string }) =>
        new SandboxExecutionEnv(
          process.env.SANDBOX_URL ?? 'http://sandbox:7000',
          sessionId,
          cwd ?? '/workspace',
        ),
    },
    BACKGROUND_CONTEXT,
  );
  await harness.resume(BACKGROUND_CONTEXT);
  harnesses.set(sessionId, harness);
  return harness;
}

// 1ターン分の実行: 入力を投入し、settled になるまで待ち、回答エントリを読む
export async function runPiTurn(
  sessionId: string,
  text: string,
  requestId: string,
): Promise<string> {
  const harness = await getHarness(sessionId);
  const modelId = process.env.PI_MODEL_ID ?? 'claude-sonnet-4-5';
  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: 'anthropic', modelId }, cwd: '/workspace' },
  });
  const submission = await root.submit(
    { type: 'input', content: text, requestId },
    BACKGROUND_CONTEXT,
  );
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  if (settled.status !== 'done' || settled.answer === undefined) {
    return '(Pi Durable: 回答が確定しませんでした)';
  }
  const answerId = settled.answer;
  const textOut = await root.commit((tx) => {
    const entry = tx.entry(AssistantEntry, answerId);
    const blocks = (entry as any)?.content ?? [];
    return blocks
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text as string)
      .join('\n');
  }, BACKGROUND_CONTEXT);
  return textOut || '(Pi Durable: 空の応答)';
}
