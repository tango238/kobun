// 巡回と、保留した実装タスクの再開を、Temporal のテストサーバーで通しで検証する。
// DB と LLM は Activity のモックで置き換える (巡回の結果と各ロールの応答は台本)。
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { parseOutput } from '../src/agents/protocol';
import {
  chiefInboxSignal,
  historyQuery,
  projectInboxSignal,
  resumeParkedSignal,
  userMessageSignal,
} from '../src/shared';

let env: TestWorkflowEnvironment;
const workflowsPath = path.resolve(__dirname, '../src/workflows.ts');

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

const until = async (cond: () => boolean, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
};

it('巡回: 催促は担当ロールに、判断待ちの一覧はチーフに届く。届けられない催促はユーザーに知らせる', async () => {
  const calls: { role: string; from: string; content: string }[] = [];
  const feed: { source: string; kind: string; title: string; body: string }[] = [];
  const script: Record<string, string[]> = {
    // チーフは一覧を読み、PjM への指示とユーザーへの連絡をタグで出す (タグの外は誰にも届かない)
    chief: [
      '<message to="pjm" project="patrol">B-12 の担当を変えるか決めてください</message><message to="user">請求: 締め日の質問が止まっています</message>これは届かない',
    ],
  };
  const activities = {
    patrolSweep: async () => ({
      nudges: [
        { slug: 'patrol', to: 'engineer-lead', content: '期限切れ: [B-12] API 仕様の初版を書く' },
        { slug: 'no-such-project', to: 'pjm', content: '期限切れ: [B-99]' },
      ],
      chiefDigest: '巡回の結果です。\n- 請求 (patrol): [B-12] 締め日の例外はあるか',
      surfaced: 1,
      overdue: 3,
    }),
    runRoleTurn: async (input: any) => {
      calls.push({ role: input.role, from: input.from, content: input.content });
      const raw = script[input.role]?.shift() ?? '(対応不要)';
      return { raw, parsed: parseOutput(raw), artifacts: [] };
    },
    notifyUser: async (_p: unknown, source: string, kind: string, title: string, body: string) => {
      feed.push({ source, kind, title, body });
    },
    createProject: async () => true,
    recordViolation: async () => undefined,
  };
  const taskQueue = 'patrol-test';
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath, activities });

  let result: any;
  await worker.runUntil(async () => {
    const chief = await env.client.workflow.start('chiefWorkflow', {
      workflowId: 'chief',
      taskQueue,
      args: [],
    });
    // プロジェクトは、PjM への最初の1通で起動しておく
    const project = await env.client.workflow.signalWithStart('projectWorkflow', {
      workflowId: 'project-patrol',
      taskQueue,
      args: [{ slug: 'patrol', name: '請求', goal: '', client: 'acme', clientName: 'Acme' }],
      signal: projectInboxSignal,
      signalArgs: [{ from: 'chief', to: 'pjm', content: '担当してください' }],
    });
    await until(() => calls.some((c) => c.role === 'pjm'));

    result = await env.client.workflow.execute('patrolWorkflow', {
      workflowId: 'patrol-1',
      taskQueue,
    });
    await until(
      () =>
        calls.some((c) => c.role === 'engineer-lead') &&
        calls.some((c) => c.role === 'chief') &&
        calls.filter((c) => c.role === 'pjm').length >= 2 &&
        feed.some((f) => f.source === 'chief'),
    );
    await project.terminate();
    await chief.terminate();
  });

  expect(result).toEqual({ nudges: 2, undelivered: 1, chief: 'sent', surfaced: 1, overdue: 3 });
  // 催促は、基盤 (system) から担当ロールに届く
  const nudge = calls.find((c) => c.role === 'engineer-lead')!;
  expect(nudge.from).toBe('system');
  expect(nudge.content).toContain('[B-12] API 仕様の初版を書く');
  // 一覧は、基盤からチーフに届く
  const digest = calls.find((c) => c.role === 'chief')!;
  expect(digest.from).toBe('system');
  expect(digest.content).toContain('巡回の結果です');
  // チーフが決めたことは、PjM とユーザーに届く。タグの外の文章 (基盤への返信) は届かない
  expect(calls.filter((c) => c.role === 'pjm').some((c) => c.content.includes('B-12 の担当を変えるか'))).toBe(true);
  expect(feed.filter((f) => f.source === 'chief').map((f) => f.body)).toEqual(['請求: 締め日の質問が止まっています']);
  // 届けられなかった催促は、黙って落とさずユーザーに知らせる
  const alert = feed.find((f) => f.kind === 'alert')!;
  expect(alert.title).toContain('催促を届けられませんでした (1 件)');
  expect(alert.body).toContain('no-such-project');
}, 120_000);

it('巡回: 新しい判断待ちが無ければ LLM を呼ばない。チーフが停止中なら一覧をユーザーに届ける', async () => {
  const feed: { kind: string; title: string; body: string }[] = [];
  let llmCalls = 0;
  let digest: string | null = null;
  const activities = {
    patrolSweep: async () => ({ nudges: [], chiefDigest: digest, surfaced: 0, overdue: 0 }),
    runRoleTurn: async () => {
      llmCalls += 1;
      return { raw: '', parsed: parseOutput(''), artifacts: [] };
    },
    notifyUser: async (_p: unknown, _s: string, kind: string, title: string, body: string) => {
      feed.push({ kind, title, body });
    },
  };
  const taskQueue = 'patrol-quiet-test';
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath, activities });
  const results: any[] = [];
  await worker.runUntil(async () => {
    results.push(await env.client.workflow.execute('patrolWorkflow', { workflowId: 'patrol-quiet', taskQueue }));
    digest = '巡回の結果です。\n- #4 請求書 PDF を生成する';
    results.push(await env.client.workflow.execute('patrolWorkflow', { workflowId: 'patrol-nochief', taskQueue }));
  });
  expect(results[0]).toEqual({ nudges: 0, undelivered: 0, chief: 'none', surfaced: 0, overdue: 0 });
  expect(results[1].chief).toBe('fallback');
  expect(llmCalls).toBe(0);
  expect(feed).toEqual([
    { kind: 'request', title: '巡回: 判断待ちの一覧', body: '巡回の結果です。\n- #4 請求書 PDF を生成する' },
  ]);
}, 120_000);

it('保留からの再開: 質問をやり直さず、保存した質問と後から届いた回答で実装に入る', async () => {
  const steps: string[] = [];
  let grilled = 0;
  const activities = {
    grillQuestions: async () => {
      grilled += 1;
      return ['やり直しの質問'];
    },
    runAgentStep: async (_id: string, messages: { role: string; content: string }[]) => {
      steps.push(messages[messages.length - 1].content);
      return `応答 ${steps.length}`;
    },
    parkTask: async () => undefined,
  };
  const taskQueue = 'resume-test';
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowsPath, activities });
  let history: { role: string; content: string }[] = [];
  await worker.runUntil(async () => {
    // セッションが終了していても再開できるよう、API と同じく signalWithStart で渡す
    const handle = await env.client.workflow.signalWithStart('sessionWorkflow', {
      workflowId: 'session-resume',
      taskQueue,
      args: [[]],
      signal: resumeParkedSignal,
      signalArgs: [
        {
          parkedId: 4,
          request: '請求書 PDF を生成する',
          questions: ['対象は？', '完了条件は？'],
          answer: '月次請求。PDF が保存されること',
        },
      ],
    });
    await until(() => steps.length === 1);
    // 再開のあとも、通常の入力は今までどおり処理される
    await handle.signal(userMessageSignal, 'こんにちは');
    await until(() => steps.length === 2);
    history = await handle.query(historyQuery);
    await handle.terminate();
  });
  expect(grilled).toBe(0);
  expect(steps[0]).toContain('実装依頼: 請求書 PDF を生成する');
  expect(steps[0]).toContain('2. 完了条件は？');
  expect(steps[0]).toContain('依頼者からの回答:\n月次請求。PDF が保存されること');
  expect(steps[1]).toBe('こんにちは');
  expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  expect(history[1].content).toBe('応答 1');
}, 120_000);
