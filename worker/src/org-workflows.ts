import {
  ParentClosePolicy,
  condition,
  continueAsNew,
  patched,
  getExternalWorkflowHandle,
  proxyActivities,
  setHandler,
  startChild,
} from '@temporalio/workflow';
import type * as activities from './activities';
import {
  CHIEF_WORKFLOW_ID,
  chiefInboxSignal,
  chiefStateQuery,
  projectInboxSignal,
  projectStateQuery,
  projectWorkflowId,
  type ChiefState,
  type Message,
  type ProjectState,
} from './shared';
import {
  ROLES,
  addrTitle,
  canTalk,
  isRoleId,
  type Envelope,
  type RoleId,
} from './agents/roles';
import type {
  OutAdr,
  OutImprovement,
  OutProposal,
  OutRule,
  OutRuleRetire,
} from './agents/protocol';

const acts = proxyActivities<typeof activities>({
  // 1ターンの中でコードを読んで続きを書く (最大8往復) ので、長めに取る
  startToCloseTimeout: '40 minutes',
  retry: { maximumAttempts: 3 },
});

const THREAD_KEEP = 40;
// 外部からの1通をきっかけにプロジェクト内で回せるターン数の上限 (会話の堂々巡りを止める)
export const TURN_BUDGET = 24;
// チーフが宛先を間違えたときに差し戻す回数の上限
const CHIEF_BOUNCE_LIMIT = 3;
const CONTINUE_AS_NEW_TURNS = 150;

// 同時に発言を作れるロールの数 (LLM の同時呼び出し数の上限)
const MAX_PARALLEL_TURNS = 3;

/**
 * たまっているメッセージを1回の発言で処理できるよう、1通にまとめる。
 * 返信先 (タグの外の文章の宛先) は、基盤以外で最も新しい差出人にする。
 */
export function combineEnvelopes(
  batch: Envelope[],
  labelOf: (e: Envelope) => string,
): { from: Envelope['from']; project?: string; label: string; content: string } {
  const replyTo = [...batch].reverse().find((e) => e.from !== 'system') ?? batch[batch.length - 1];
  if (batch.length === 1) {
    return { from: replyTo.from, project: replyTo.project, label: labelOf(replyTo), content: batch[0].content };
  }
  const labels = [...new Set(batch.map(labelOf))];
  return {
    from: replyTo.from,
    project: replyTo.project,
    label: labels.length === 1 ? labels[0] : `複数 (${labels.join('、')})`,
    content: [
      `未読のメッセージが ${batch.length} 通たまっています (古い順)。1通ずつ返事を書かず、全部を読んでから、いまの状況に対して1回でまとめて対応してください。`,
      '内容が食い違う場合は新しいものを優先します。既に解決済み・行き違いになった話題には返事をしないでください。',
      '差出人が複数いるので、返事は <message to="宛先"> で宛先を明示してください。',
      '',
      ...batch.map((e, i) => `--- ${i + 1}通目 [差出人: ${labelOf(e)}] ---\n${e.content}`),
    ].join('\n'),
  };
}

const NOOP = /^[（(]?\s*対応不要\s*[)）]?[。.]?$/;

function remember(
  thread: Message[],
  label: string,
  content: string,
  reply: string,
): void {
  thread.push({ role: 'user', content: `[差出人: ${label}]\n${content}` });
  // 応答が空でも user/assistant の交互を保つ
  thread.push({ role: 'assistant', content: reply || '(対応不要)' });
  if (thread.length > THREAD_KEEP) thread.splice(0, thread.length - THREAD_KEEP);
}

/**
 * チーフ: 組織に1つだけ存在する Entity Workflow (workflowId = "chief")。
 * ユーザーと直接会話する唯一のエージェントで、プロジェクトを作り、PjM に依頼を渡す。
 */
export async function chiefWorkflow(
  initial: ChiefState = { thread: [], turns: 0 },
): Promise<void> {
  const thread: Message[] = [...initial.thread];
  let turns = initial.turns;
  const inbox: Envelope[] = [];

  setHandler(chiefInboxSignal, (env: Envelope) => {
    inbox.push(env);
  });
  setHandler(chiefStateQuery, () => ({ thread, turns }));

  const toPjm = async (slug: string, content: string): Promise<boolean> => {
    try {
      await getExternalWorkflowHandle(projectWorkflowId(slug)).signal(
        projectInboxSignal,
        { from: 'chief', to: 'pjm', content },
      );
      return true;
    } catch {
      return false;
    }
  };

  for (;;) {
    await condition(() => inbox.length > 0);
    const chiefLabel = (e: Envelope) =>
      e.from === 'pjm' ? `PjM (${e.project})` : addrTitle(e.from);
    // たまっているメッセージ (ユーザーと各 PjM から) は、まとめて1回で処理する。
    // patched: この変更より前から動いているチーフは、切り替え時点から新しい動きになる
    const batch: Envelope[] = patched('chief-batch-v2') ? inbox.splice(0) : [inbox.shift()!];
    const merged = combineEnvelopes(batch, chiefLabel);
    // ユーザーの発言が含まれていれば、タグの外の文章はユーザーへの返事にする
    const hasUser = batch.some((e) => e.from === 'user');
    const batchProjects = [...new Set(batch.filter((e) => e.from === 'pjm').map((e) => e.project))];
    let current: (Envelope & { label?: string }) | null = {
      from: hasUser ? 'user' : merged.from,
      to: 'chief',
      project: hasUser ? undefined : merged.project,
      content: merged.content,
      label: merged.label,
    };
    let bouncesLeft = CHIEF_BOUNCE_LIMIT;

    while (current) {
      const env: Envelope & { label?: string } = current;
      current = null;
      const label = env.label ?? chiefLabel(env);
      const res = await acts.runRoleTurn({
        role: 'chief',
        thread,
        from: env.from,
        fromLabel: label,
        content: env.content,
      });
      turns += 1;
      remember(thread, label, env.content, res.raw);
      if (res.error) {
        // 資格情報不足などで応答できない場合は、黙らずに理由をユーザーへ出す
        await acts.notifyUser(
          env.project ?? null,
          'chief',
          'alert',
          'チーフが応答できませんでした',
          `${res.error}\n\n未処理のメッセージ (差出人: ${label}):\n${env.content}`,
        );
        break;
      }

      const bounces: string[] = [...(res.notes ?? [])];
      const created: string[] = [];
      for (const p of res.parsed.projects) {
        if (!p.client) {
          bounces.push(
            `プロジェクト ${p.slug} は作成されていません。クライアントが未指定です。どのクライアントのプロジェクトかをユーザーに確認してから、client を付けて作り直してください。`,
          );
          continue;
        }
        const isNew = await acts.createProject(p);
        if (!isNew) {
          bounces.push(`プロジェクト ${p.slug} は既に存在します。`);
          continue;
        }
        const child = await startChild('projectWorkflow', {
          workflowId: projectWorkflowId(p.slug),
          args: [p],
          parentClosePolicy: ParentClosePolicy.ABANDON,
        });
        await child.signal(projectInboxSignal, {
          from: 'chief',
          to: 'pjm',
          content: `新規プロジェクト「${p.name}」(クライアント: ${p.clientName || p.client}) を担当してください。\n\n目的・背景:\n${p.goal}`,
        });
        created.push(p.slug);
      }

      const outs = [...res.parsed.messages];
      const rest = res.parsed.rest;
      if (rest && !NOOP.test(rest) && env.from !== 'system') {
        // タグの外の文章は差出人への返信
        outs.push({
          to: env.from,
          project: env.from === 'pjm' ? env.project : undefined,
          content: rest,
        });
      }
      for (const m of outs) {
        if (m.to === 'user') {
          await acts.notifyUser(null, 'chief', 'message', 'チーフ', m.content);
        } else if (m.to === 'pjm') {
          const slug =
            m.project ??
            (created.length === 1
              ? created[0]
              : batchProjects.length === 1
                ? batchProjects[0]
                : undefined);
          if (!slug) {
            bounces.push('PjM 宛のメッセージには project (slug) が必要です。');
          } else if (!(await toPjm(slug, m.content))) {
            bounces.push(`プロジェクト ${slug} の PjM に届きませんでした (存在しないか停止中)。`);
          }
        } else {
          bounces.push(`宛先 ${m.to} には直接送れません。送れる相手: user, pjm。`);
        }
      }
      if (bounces.length > 0) {
        await acts.recordViolation(null, 'chief', bounces);
        if (bouncesLeft > 0) {
          bouncesLeft -= 1;
          current = { from: 'system', to: 'chief', content: bounces.join('\n') };
        }
      }
    }

    if (turns >= CONTINUE_AS_NEW_TURNS && inbox.length === 0) {
      await continueAsNew<typeof chiefWorkflow>({ thread, turns: 0 });
    }
  }
}

/**
 * プロジェクト: プロジェクト1つ = Workflow 1つ (workflowId = "project-<slug>")。
 * PjM と、そのプロジェクトのアナリスト・エンジニア・デザイナー・インフラが属する。
 * メッセージは1通ずつ順番に処理し、宛先は会話ルーティング表 (roles.ts) で強制する。
 */
export async function projectWorkflow(
  input: Pick<ProjectState, 'slug' | 'name' | 'goal' | 'client' | 'clientName'> &
    Partial<ProjectState>,
): Promise<void> {
  const project = {
    slug: input.slug,
    name: input.name,
    goal: input.goal,
    client: input.client,
    clientName: input.clientName,
  };
  const threads: Partial<Record<RoleId, Message[]>> = { ...(input.threads ?? {}) };
  const queue: Envelope[] = [...(input.queue ?? [])];
  let turns = input.turns ?? 0;
  let violations = input.violations ?? 0;
  let budget = TURN_BUDGET;
  let current: ProjectState['current'] = null;
  // ロールごとの未読メッセージと、いま発言を作っているロール (新しい処理方式で使う)
  const mailboxes: Partial<Record<RoleId, Envelope[]>> = {};
  const working: NonNullable<ProjectState['working']> = [];
  const pending = (): Envelope[] => [
    ...queue,
    ...(Object.values(mailboxes) as Envelope[][]).flat(),
  ];

  setHandler(projectInboxSignal, (env: Envelope) => {
    if (!isRoleId(env.to) || ROLES[env.to].scope !== 'project') return;
    queue.push(env);
    budget = TURN_BUDGET;
  });
  setHandler(projectStateQuery, () => ({
    ...project,
    threads,
    queue: pending(),
    turns,
    violations,
    current: working[0] ?? current,
    working: [...working],
  }));

  const toChief = async (content: string): Promise<void> => {
    try {
      await getExternalWorkflowHandle(CHIEF_WORKFLOW_ID).signal(chiefInboxSignal, {
        from: 'pjm',
        to: 'chief',
        project: project.slug,
        content,
      });
    } catch {
      // チーフが停止している場合でも、PjM の報告はユーザーに届ける
      await acts.notifyUser(
        project.slug,
        'pjm',
        'message',
        `PjM (${project.name}) からの報告`,
        content,
      );
    }
  };

  // -------------------------------------------------------------------------
  // 処理方式: ロールごとに未読をまとめて1回で処理し、別々のロールは同時に動く。
  //   - 自分の番が来たロールは、たまっている自分宛のメッセージを全部受け取って1回で答える
  //     (1通ずつ答えると、答えている間に届いた分への返事が古くなり、行き違いが増える)
  //   - 同じロールは同時に1つの発言しか作らない。違うロールは MAX_PARALLEL_TURNS まで同時に動く
  //     (PjM が考えている間も、アナリストやエンジニアは自分の仕事を進められる)
  // -------------------------------------------------------------------------
  const sort = () => {
    for (const env of queue.splice(0)) (mailboxes[env.to] ??= []).push(env);
  };
  const isWorking = (role: RoleId) => working.some((w) => w.role === role);
  const ready = (): RoleId[] =>
    (Object.keys(mailboxes) as RoleId[]).filter(
      (role) => (mailboxes[role]?.length ?? 0) > 0 && !isWorking(role),
    );

  const takeTurn = async (role: RoleId, batch: Envelope[]): Promise<void> => {
    const merged = combineEnvelopes(batch, (e) => addrTitle(e.from));
    const thread = (threads[role] ??= []);
    const res = await acts.runRoleTurn({
      role,
      project,
      thread,
      from: merged.from,
      fromLabel: merged.label,
      content: merged.content,
      teamNow: working.map((w) => ({ role: w.role, since: w.since })),
    });
    remember(thread, merged.label, merged.content, res.raw);
    if (res.error) {
      await acts.notifyUser(
        project.slug,
        role,
        'alert',
        `${project.name}: ${ROLES[role].title} が応答できませんでした`,
        `${res.error}\n\n未処理のメッセージ ${batch.length} 通 (差出人: ${merged.label}):\n${merged.content.slice(0, 2000)}`,
      );
      return;
    }
    const outs = res.parsed.messages.map((m) => ({ to: m.to, content: m.content }));
    const rest = res.parsed.rest;
    if (rest && !NOOP.test(rest) && merged.from !== 'system' && merged.from !== 'user') {
      outs.push({ to: merged.from, content: rest });
    }
    for (const note of res.notes ?? []) {
      (mailboxes[role] ??= []).push({ from: 'system', to: role, content: note });
    }
    const rejected: string[] = [];
    for (const m of outs) {
      if (!canTalk(role, m.to)) {
        rejected.push(m.to);
      } else if (m.to === 'chief') {
        await toChief(m.content);
      } else if (isRoleId(m.to)) {
        (mailboxes[m.to] ??= []).push({ from: role, to: m.to, content: m.content });
      } else {
        rejected.push(m.to);
      }
    }
    if (rejected.length > 0) {
      violations += rejected.length;
      await acts.recordViolation(project.slug, role, rejected);
      (mailboxes[role] ??= []).push({
        from: 'system',
        to: role,
        content: `宛先 ${rejected.join(', ')} には直接送れません (メッセージは配送されていません)。送れる相手: ${ROLES[role].talksTo.join(', ')}。`,
      });
    }
  };

  const runMailboxes = async (): Promise<void> => {
    for (;;) {
      sort();
      await condition(
        () =>
          queue.length > 0 ||
          (ready().length > 0 && working.length < MAX_PARALLEL_TURNS) ||
          (turns >= CONTINUE_AS_NEW_TURNS && working.length === 0 && pending().length === 0),
      );
      sort();

      if (turns >= CONTINUE_AS_NEW_TURNS && working.length === 0 && pending().length === 0) {
        await continueAsNew<typeof projectWorkflow>({
          ...project,
          threads,
          queue: [],
          turns: 0,
          violations,
        });
      }

      if (budget <= 0 && ready().length > 0) {
        const dropped = (Object.keys(mailboxes) as RoleId[]).flatMap(
          (role) => mailboxes[role]?.splice(0) ?? [],
        );
        await acts.notifyUser(
          project.slug,
          'system',
          'alert',
          `${project.name}: チーム内の会話を ${TURN_BUDGET} ターンで打ち切りました`,
          [
            `未処理のまま破棄したメッセージ: ${dropped.length} 件`,
            ...dropped.map((d) => `- ${d.from} → ${d.to}: ${d.content.slice(0, 200)}`),
          ].join('\n'),
        );
        continue;
      }

      for (const role of ready()) {
        if (working.length >= MAX_PARALLEL_TURNS || budget <= 0) break;
        const batch = mailboxes[role]!.splice(0);
        budget -= 1;
        turns += 1;
        const slot = { role, from: batch[batch.length - 1].from, since: Date.now() };
        working.push(slot);
        // 待たずに次のロールも始める。終わったら working から外れ、上の condition が再評価される
        void takeTurn(role, batch)
          .catch((err) =>
            acts.notifyUser(
              project.slug,
              role,
              'alert',
              `${project.name}: ${ROLES[role].title} の発言の処理に失敗しました`,
              String(err),
            ),
          )
          .then(() => {
            working.splice(working.indexOf(slot), 1);
          });
      }
    }
  };

  for (;;) {
    await condition(() => queue.length > 0);

    // patched: この変更より前から動いているプロジェクトは、ここを通った時点から新しい処理方式に切り替わる
    // (たまっていたメッセージもロールごとにまとめられる)。以降の旧方式のコードは、過去の履歴の再生にだけ使われる
    if (patched('project-mailboxes-v2')) {
      await runMailboxes();
    }

    if (budget <= 0) {
      const dropped = queue.splice(0);
      await acts.notifyUser(
        project.slug,
        'system',
        'alert',
        `${project.name}: チーム内の会話を ${TURN_BUDGET} ターンで打ち切りました`,
        [
          `未処理のまま破棄したメッセージ: ${dropped.length} 件`,
          ...dropped.map(
            (d) => `- ${d.from} → ${d.to}: ${d.content.slice(0, 200)}`,
          ),
        ].join('\n'),
      );
      continue;
    }

    const env = queue.shift()!;
    const role = env.to;
    budget -= 1;
    turns += 1;
    const thread = (threads[role] ??= []);
    current = { role, from: env.from, since: Date.now() };
    const res = await acts.runRoleTurn({
      role,
      project,
      thread,
      from: env.from,
      content: env.content,
    });
    current = null;
    remember(thread, addrTitle(env.from), env.content, res.raw);
    if (res.error) {
      await acts.notifyUser(
        project.slug,
        role,
        'alert',
        `${project.name}: ${ROLES[role].title} が応答できませんでした`,
        `${res.error}\n\n未処理のメッセージ (差出人: ${addrTitle(env.from)}):\n${env.content}`,
      );
      continue;
    }

    const outs = res.parsed.messages.map((m) => ({ to: m.to, content: m.content }));
    const rest = res.parsed.rest;
    if (rest && !NOOP.test(rest) && env.from !== 'system' && env.from !== 'user') {
      outs.push({ to: env.from, content: rest });
    }
    const rejected: string[] = [];
    for (const m of outs) {
      if (!canTalk(role, m.to)) {
        rejected.push(m.to);
      } else if (m.to === 'chief') {
        await toChief(m.content);
      } else if (isRoleId(m.to)) {
        queue.push({ from: role, to: m.to, content: m.content });
      } else {
        rejected.push(m.to);
      }
    }
    if (rejected.length > 0) {
      violations += rejected.length;
      await acts.recordViolation(project.slug, role, rejected);
      queue.push({
        from: 'system',
        to: role,
        content: `宛先 ${rejected.join(', ')} には直接送れません (メッセージは配送されていません)。送れる相手: ${ROLES[role].talksTo.join(', ')}。`,
      });
    }

    if (turns >= CONTINUE_AS_NEW_TURNS && queue.length === 0) {
      await continueAsNew<typeof projectWorkflow>({
        ...project,
        threads,
        queue,
        turns: 0,
        violations,
      });
    }
  }
}

/**
 * 巡回 (Temporal Schedule から 9〜21 時の毎時に起動)。止まっている仕事を見つけて動かす。
 * 1. 期限を過ぎた仕事 (ボードの質問・やること) の段階をコードで上げる (担当 → PjM → ユーザー)
 * 2. 催促をプロジェクトのロールに配る
 * 3. 判断が要るものを新しく見つけたときだけ、チーフに一覧を渡す
 *    (PjM に上がった期限切れ、保留が長引いた実装タスク、期限を過ぎた承認待ちの提案)
 * 新しいものが無い回は、LLM を1回も呼ばない。
 */
export async function patrolWorkflow(): Promise<{
  nudges: number;
  undelivered: number;
  chief: 'none' | 'sent' | 'fallback';
  surfaced: number;
  overdue: number;
}> {
  const res = await acts.patrolSweep();
  const undelivered: typeof res.nudges = [];
  for (const n of res.nudges) {
    if (!(await signalProject(n.slug, { from: 'system', to: n.to, content: n.content }))) {
      undelivered.push(n);
    }
  }
  if (undelivered.length > 0) {
    // 催促を届けられなかった場合 (プロジェクトの Workflow が停止中) も、黙って落とさない
    await acts.notifyUser(
      null,
      'system',
      'alert',
      `巡回: 催促を届けられませんでした (${undelivered.length} 件)`,
      undelivered.map((n) => `- ${n.slug} / ${n.to}:\n${n.content}`).join('\n\n'),
    );
  }
  let chief: 'none' | 'sent' | 'fallback' = 'none';
  if (res.chiefDigest) {
    try {
      await getExternalWorkflowHandle(CHIEF_WORKFLOW_ID).signal(chiefInboxSignal, {
        from: 'system',
        to: 'chief',
        content: res.chiefDigest,
      });
      chief = 'sent';
    } catch {
      // チーフが動いていなければ、一覧をそのままユーザーに届ける
      await acts.notifyUser(null, 'system', 'request', '巡回: 判断待ちの一覧', res.chiefDigest);
      chief = 'fallback';
    }
  }
  return {
    nudges: res.nudges.length,
    undelivered: undelivered.length,
    chief,
    surfaced: res.surfaced,
    overdue: res.overdue,
  };
}

async function signalProject(slug: string, env: Envelope): Promise<boolean> {
  try {
    await getExternalWorkflowHandle(projectWorkflowId(slug)).signal(
      projectInboxSignal,
      env,
    );
    return true;
  } catch {
    return false;
  }
}

// 振り返りで改善を提案するロール (PjM は提案を受けて決定する側)
const RETRO_PROPOSERS: RoleId[] = [
  'business-analyst',
  'engineer-lead',
  'designer',
  'ux-analyst',
  'infra-engineer',
];

/**
 * 週次の振り返り (Temporal Schedule から月曜 09:00 に起動)。
 * 1. 接続から数字を自動取得する
 * 2. 各ロールが数字をもとに改善を提案する
 * 3. PjM が今週実行する改善アクションと、行動ルール (共通 / クライアント / プロジェクトの3層) の
 *    追加・置換・廃止、ADR を決める
 * 4. 改善レポートを作ってユーザーに送り、PjM に実行を指示する
 */
export async function retroWorkflow(slug: string): Promise<string> {
  const project = await acts.getProject(slug);
  if (!project) return `project not found: ${slug}`;

  const collected = await acts.collectMetrics(slug);
  const snap = await acts.retroSnapshot(slug, collected);

  const proposals = await Promise.all(
    RETRO_PROPOSERS.map((role) =>
      acts.runRoleTurn({
        role,
        project,
        thread: [],
        from: 'system',
        retro: true,
        content: [
          '週次の振り返りです。あなたの担当領域について、下の数字を根拠に改善を提案してください。',
          '担当領域の数字が「未計測」「未登録」の場合は、計測できるようにすること自体を改善として提案してください。',
          '',
          snap.text,
        ].join('\n'),
      }),
    ),
  );

  const roleErrors: { role: RoleId; error: string }[] = [];
  const pooled: OutImprovement[] = [];
  const pooledRules: OutRule[] = [];
  const pooledRetires: OutRuleRetire[] = [];
  const pooledAdrs: OutAdr[] = [];
  const costProposals: OutProposal[] = [];
  const feedbackRequests: string[] = [];
  const summary: string[] = [];
  proposals.forEach((res, i) => {
    const role = RETRO_PROPOSERS[i];
    if (res.error) {
      roleErrors.push({ role, error: res.error });
      return;
    }
    const p = res.parsed;
    pooled.push(...p.improvements.map((x) => ({ ...x, owner: x.owner || role })));
    pooledRules.push(...p.rules);
    pooledRetires.push(...p.ruleRetires);
    pooledAdrs.push(...p.adrs);
    costProposals.push(...p.proposals);
    feedbackRequests.push(...p.feedbackRequests);
    summary.push(`### ${ROLES[role].title} (${role}) の提案\n${res.raw}`);
  });

  let improvements = pooled;
  let rules = pooledRules;
  let ruleRetires = pooledRetires;
  let adrs = pooledAdrs;
  if (summary.length > 0) {
    const decided = await acts.runRoleTurn({
      role: 'pjm',
      project,
      thread: [],
      from: 'system',
      retro: true,
      content: [
        '週次の振り返りです。チームの提案から、今週実行する改善アクションを1件以上決定してください。',
        '採用するものだけを <improvement> / <rule> / <rule-retire> / <adr> で出力してください (採用しない提案は書かない)。',
        '行動ルールは、どの層 (project / client / common) に置くかを scope で決めてください。',
        '各アクションには、指標キーと来週の目標値を必ず付けてください。',
        '',
        snap.text,
        '',
        ...summary,
      ].join('\n'),
    });
    if (decided.error) {
      roleErrors.push({ role: 'pjm', error: decided.error });
    } else if (decided.parsed.improvements.length > 0) {
      improvements = decided.parsed.improvements.map((x) => ({
        ...x,
        owner: x.owner || 'pjm',
      }));
      rules = decided.parsed.rules;
      ruleRetires = decided.parsed.ruleRetires;
      adrs = decided.parsed.adrs;
      feedbackRequests.push(...decided.parsed.feedbackRequests);
    }
    // PjM が1件も決めなかった場合は、チームの提案をそのまま実行対象にする
  }

  const applied = await acts.applyRetro(project, snap, collected, {
    improvements,
    rules,
    ruleRetires,
    adrs,
    proposals: costProposals,
    feedbackRequests,
    roleErrors,
  });
  if (applied.instruction) {
    await signalProject(slug, {
      from: 'system',
      to: 'pjm',
      content: applied.instruction,
    });
  }
  return applied.reportPath;
}

/**
 * 日次のインフラチェック (Temporal Schedule から毎日 08:00 に起動)。
 * 異常値・コスト増加はユーザーへアラートを送り、遅いクエリはエンジニアに修正を依頼する。
 */
export async function infraCheckWorkflow(slug: string): Promise<number> {
  const project = await acts.getProject(slug);
  if (!project) return 0;
  const res = await acts.infraCheck(project);
  if (res.triage) {
    await signalProject(slug, {
      from: 'system',
      to: 'infra-engineer',
      content: res.triage,
    });
  }
  if (res.slowQueryReport) {
    await signalProject(slug, {
      from: 'infra-engineer',
      to: 'engineer-lead',
      content: res.slowQueryReport,
    });
  }
  return res.anomalies;
}
