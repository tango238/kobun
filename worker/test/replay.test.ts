// 動いている Temporal から実際の履歴を取り、いまのコードで再生できるかを確かめる。
// Workflow のコードを変えたあと、動いている会話が壊れない (非決定性エラーにならない) ことの確認。
// 実行: REPLAY_TEMPORAL=localhost:7233 npx vitest run test/replay.test.ts
import path from 'node:path';
import { expect, it } from 'vitest';
import { Client, Connection } from '@temporalio/client';
import { Worker } from '@temporalio/worker';

const address = process.env.REPLAY_TEMPORAL;

it.skipIf(!address)('動いているチーフ・プロジェクト・セッションの履歴を、いまのコードで再生できる', async () => {
  const connection = await Connection.connect({ address });
  const client = new Client({ connection });
  const ids: string[] = [];
  for await (const wf of client.workflow.list({
    query: "ExecutionStatus = 'Running' AND (WorkflowType = 'chiefWorkflow' OR WorkflowType = 'projectWorkflow' OR WorkflowType = 'sessionWorkflow')",
  })) {
    ids.push(wf.workflowId);
  }
  expect(ids.length).toBeGreaterThan(0);
  const results: string[] = [];
  for (const id of ids) {
    const history = await client.workflow.getHandle(id).fetchHistory();
    try {
      await Worker.runReplayHistory(
        { workflowsPath: path.resolve(__dirname, '../src/workflows.ts') },
        history,
        id,
      );
      results.push(`${id}: OK (${history.events?.length} events)`);
    } catch (err) {
      results.push(`${id}: FAILED ${String(err).slice(0, 300)}`);
    }
  }
  console.log(`REPLAY\n${results.join('\n')}`);
  await connection.close();
  expect(results.filter((r) => r.includes('FAILED'))).toEqual([]);
}, 180_000);
