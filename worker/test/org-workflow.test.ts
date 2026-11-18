// チーフ ⇄ PjM ⇄ チームの会話ルーティングを、Temporal のテストサーバーで通しで検証する。
// LLM と DB は Activity のモックで置き換える (各ロールの応答は台本)。
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { parseOutput } from '../src/agents/protocol';
import { chiefInboxSignal, projectInboxSignal, projectStateQuery } from '../src/shared';

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

it('チーフがプロジェクトを作り、PjM がチームと会話して、報告がユーザーに届く', async () => {
  const script: Record<string, string[]> = {
    chief: [
      // クライアント未指定のプロジェクトは作られず、チーフに差し戻される
      '<project slug="billing" name="請求">月次請求を自動化する</project>',
      '<message to="user">どのクライアントのプロジェクトですか？</message>',
      '<project slug="billing" name="請求" client="acme" client-name="アクメ商事">月次請求を自動化する</project><message to="user">請求プロジェクトを作りました</message>',
      '<message to="user">PjM からの報告: 業務フロー案ができました</message>',
    ],
    pjm: [
      // 実装担当へは直接話せない (差し戻される)
      '<message to="business-analyst">業務フローを整理してください</message><message to="engineer-impl">実装して</message>',
      // 差し戻しとアナリストの返信は、たまっていれば1回の発言でまとめて受け取る
      '<message to="chief">業務フロー案ができました</message>',
    ],
    'business-analyst': ['<artifact path="docs/business-requirements.md"># 業務フロー</artifact>業務フロー案です'],
  };
  const calls: { role: string; from: string; content: string }[] = [];
  const feed: { source: string; kind: string; body: string }[] = [];
  const violations: string[][] = [];
  const created: any[] = [];

  const activities = {
    runRoleTurn: async (input: any) => {
      calls.push({ role: input.role, from: input.from, content: input.content });
      const raw = script[input.role]?.shift() ?? '(対応不要)';
      const parsed = parseOutput(raw);
      return { raw, parsed, artifacts: parsed.artifacts.map((a) => a.path) };
    },
    notifyUser: async (_p: unknown, source: string, kind: string, _t: string, body: string) => {
      feed.push({ source, kind, body });
    },
    createProject: async (p: any) => {
      created.push(p);
      return true;
    },
    recordViolation: async (_p: unknown, _r: unknown, targets: string[]) => {
      violations.push(targets);
    },
  };

  const taskQueue = 'org-test';
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: path.resolve(__dirname, '../src/workflows.ts'),
    activities,
  });

  await worker.runUntil(async () => {
    await env.client.workflow.signalWithStart('chiefWorkflow', {
      workflowId: 'chief',
      taskQueue,
      args: [],
      signal: chiefInboxSignal,
      signalArgs: [{ from: 'user', to: 'chief', content: '請求を自動化したい' }],
    });
    const wait = async (n: number) => {
      const deadline = Date.now() + 60_000;
      while (feed.length < n && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    await wait(1);
    expect(created).toEqual([]);
    await env.client.workflow.getHandle('chief').signal(chiefInboxSignal, {
      from: 'user',
      to: 'chief',
      content: 'アクメ商事です',
    });
    await wait(3);
    const state = await env.client.workflow
      .getHandle('project-billing')
      .query(projectStateQuery);
    expect(state.violations).toBe(1);
    expect(state.client).toBe('acme');
    expect(state.queue).toEqual([]);
    await env.client.workflow.getHandle('project-billing').terminate();
    await env.client.workflow.getHandle('chief').terminate();
  });

  // ユーザーに届くのはチーフの発言だけ
  expect(created.map((p) => [p.slug, p.client, p.clientName])).toEqual([
    ['billing', 'acme', 'アクメ商事'],
  ]);
  expect(feed).toEqual([
    { source: 'chief', kind: 'message', body: 'どのクライアントのプロジェクトですか？' },
    { source: 'chief', kind: 'message', body: '請求プロジェクトを作りました' },
    { source: 'chief', kind: 'message', body: 'PjM からの報告: 業務フロー案ができました' },
  ]);
  // 会話の順序: chief → pjm → BA → pjm (差し戻し) → pjm (BA の返信) → chief
  const order = calls.map((c) => `${c.from}>${c.role}`);
  expect(order.slice(0, 5)).toEqual([
    'user>chief',
    'system>chief',
    'user>chief',
    'chief>pjm',
    'pjm>business-analyst',
  ]);
  expect(order[order.length - 1]).toBe('pjm>chief');
  // 実装担当には届かず、違反として記録される
  expect(violations[violations.length - 1]).toEqual(['engineer-impl']);
  expect(calls.some((c) => c.role === 'engineer-impl')).toBe(false);
  // タグの外の文章は差出人 (PjM) への返信になる
  const pjmTurns = calls.filter((c) => c.role === 'pjm').slice(1);
  expect(pjmTurns.some((c) => c.content.includes('業務フロー案です'))).toBe(true);
  // 差し戻しも PjM に届いている
  expect(pjmTurns.some((c) => c.content.includes('engineer-impl には直接送れません'))).toBe(true);
}, 120_000);

it('たまったメッセージは、次の発言でまとめて1回で処理される', async () => {
  const calls: { role: string; from: string; label: string; content: string }[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const activities = {
    runRoleTurn: async (input: any) => {
      calls.push({ role: input.role, from: input.from, label: input.fromLabel, content: input.content });
      // 1回目の PjM の発言を止めておき、その間にメッセージをためる
      if (calls.length === 1) await gate;
      const raw = '(対応不要)';
      return { raw, parsed: parseOutput(raw), artifacts: [] };
    },
    notifyUser: async () => undefined,
    createProject: async () => true,
    recordViolation: async () => undefined,
  };
  const taskQueue = 'org-batch-test';
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: path.resolve(__dirname, '../src/workflows.ts'),
    activities,
  });
  await worker.runUntil(async () => {
    const send = (from: string, content: string) => ({ from, to: 'pjm', content });
    const handle = await env.client.workflow.signalWithStart('projectWorkflow', {
      workflowId: 'project-batch',
      taskQueue,
      args: [{ slug: 'batch', name: 'B', goal: '', client: 'acme', clientName: 'Acme' }],
      signal: projectInboxSignal,
      signalArgs: [send('chief', '1通目')],
    });
    const until = async (cond: () => boolean) => {
      const deadline = Date.now() + 30_000;
      while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    };
    await until(() => calls.length === 1);
    await handle.signal(projectInboxSignal, send('chief', '2通目'));
    await handle.signal(projectInboxSignal, send('business-analyst', '3通目'));
    await handle.signal(projectInboxSignal, send('chief', '4通目 (最新)'));
    const busy = await handle.query(projectStateQuery);
    expect(busy.working?.map((w) => w.role)).toEqual(['pjm']);
    expect(busy.queue).toHaveLength(3);
    release();
    await until(() => calls.length === 2);
    await new Promise((r) => setTimeout(r, 500));
    await handle.terminate();
  });

  // PjM の発言は 4 回ではなく 2 回。2回目に、たまった3通をまとめて受け取る
  expect(calls).toHaveLength(2);
  expect(calls[0].content).toBe('1通目');
  expect(calls[1].content).toContain('未読のメッセージが 3 通');
  expect(calls[1].content).toMatch(/1通目 \[差出人: .*チーフ.*\] ---\n2通目/);
  expect(calls[1].content).toContain('3通目');
  expect(calls[1].content).toContain('4通目 (最新)');
  // 返信先は、基盤以外で最も新しい差出人
  expect(calls[1].from).toBe('chief');
  expect(calls[1].label).toContain('複数');
}, 120_000);
