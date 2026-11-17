import { Connection, Client } from '@temporalio/client';
import { userMessageSignal, historyQuery, TASK_QUEUE } from './shared';

// 動作確認用 CLI:
//   npm run client -- "こんにちは"            新規セッションを開始して発言
//   npm run client -- "bash:ls -la" <sessionId>  既存セッションに発言
async function main(): Promise<void> {
  const [text, sessionIdArg] = process.argv.slice(2);
  const connection = await Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
  });
  const client = new Client({ connection });

  let id = sessionIdArg;
  if (!id) {
    id = `session-${Date.now()}`;
    await client.workflow.start('sessionWorkflow', {
      workflowId: id,
      taskQueue: TASK_QUEUE,
      args: [[]],
    });
    console.log('started session:', id);
  }
  if (text) {
    const handle = client.workflow.getHandle(id);
    await handle.signal(userMessageSignal, text);
    await new Promise((r) => setTimeout(r, 3000));
    console.log(JSON.stringify(await handle.query(historyQuery), null, 2));
  }
  await connection.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
