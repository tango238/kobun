import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { Connection, Client } from '@temporalio/client';
import {
  userMessageSignal,
  answerSignal,
  historyQuery,
  pendingQuestionsQuery,
  TASK_QUEUE,
} from './shared';

// Web/Bot 層のローカル版: REST でセッションを開始し、Signal で発言し、Query で履歴を読む
const app = new Hono();

let clientPromise: Promise<Client> | null = null;
function getClient(): Promise<Client> {
  clientPromise ??= (async () => {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    });
    return new Client({ connection });
  })();
  return clientPromise;
}

app.post('/sessions', async (c) => {
  const client = await getClient();
  const id = `session-${crypto.randomUUID()}`;
  await client.workflow.start('sessionWorkflow', {
    workflowId: id,
    taskQueue: TASK_QUEUE,
    args: [[]],
  });
  return c.json({ sessionId: id });
});

app.post('/sessions/:id/messages', async (c) => {
  const client = await getClient();
  const { text } = await c.req.json<{ text: string }>();
  const handle = client.workflow.getHandle(c.req.param('id'));
  await handle.signal(userMessageSignal, text);
  return c.json({ ok: true });
});

app.get('/sessions/:id', async (c) => {
  const client = await getClient();
  const handle = client.workflow.getHandle(c.req.param('id'));
  const history = await handle.query(historyQuery);
  return c.json({ history });
});

// grilling の回答待ち質問を取得する (ask-a-person の提示側)
app.get('/sessions/:id/questions', async (c) => {
  const client = await getClient();
  const handle = client.workflow.getHandle(c.req.param('id'));
  const questions = await handle.query(pendingQuestionsQuery);
  return c.json({ questions });
});

// grilling の質問に回答する (期限は3時間。それを過ぎるとタスクは保存されて停止する)
app.post('/sessions/:id/answer', async (c) => {
  const client = await getClient();
  const { text } = await c.req.json<{ text: string }>();
  const handle = client.workflow.getHandle(c.req.param('id'));
  await handle.signal(answerSignal, text);
  return c.json({ ok: true });
});

// Outer Loop を手動で1回回す (通常は Temporal Schedule が日次で起動する)
app.post('/outer-loop/run', async (c) => {
  const client = await getClient();
  const handle = await client.workflow.start('outerLoopWorkflow', {
    workflowId: `outer-loop-manual-${Date.now()}`,
    taskQueue: TASK_QUEUE,
  });
  const reportPath = await handle.result();
  return c.json({ reportPath });
});

serve({ fetch: app.fetch, port: 3000 });
console.log('kobun api listening on :3000');
