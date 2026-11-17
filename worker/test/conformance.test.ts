// Pi Durable のカスタムバックエンド / カスタム環境の適合性テスト。
// 公式の conformance suite で検証する (README: Storage / Environment 節)。
// 実行には Postgres (と env 用にサンドボックス) が必要:
//   docker compose up -d postgres sandbox egress
//   docker compose exec worker npm test
import { describe, expect, it } from 'vitest';
import {
  registerEnvConformance,
  registerStorageConformance,
} from '@earendil-works/pi-durable/testing';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { PostgresSqliteDatabase } from '../src/pi/postgres-database';
import { SandboxExecutionEnv } from '../src/pi/sandbox-env';

const DB_URL =
  process.env.CHECKPOINT_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/checkpoints';
const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://localhost:7000';

registerStorageConformance(
  { describe, expect, it },
  'PostgresSqliteDatabase',
  async (use) => {
    const db = await PostgresSqliteDatabase.open(DB_URL);
    const storage = await SqliteStorage.open(db, {
      prefix: `test_${Date.now()}_`,
    });
    try {
      await use(storage);
    } finally {
      await db.close();
    }
  },
);

registerEnvConformance({ describe, expect, it }, 'SandboxExecutionEnv', async (use) => {
  const env = new SandboxExecutionEnv(SANDBOX_URL, 'conformance');
  await use(env as any);
});
