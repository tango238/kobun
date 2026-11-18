import {
  proxyActivities,
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
  sleep,
} from '@temporalio/workflow';
import type * as activities from './activities';
import {
  userMessageSignal,
  answerSignal,
  historyQuery,
  pendingQuestionsQuery,
  resumeParkedSignal,
  Message,
  type ParkedResume,
} from './shared';
import { enrichImplRequest } from './followup';

// エージェント組織のワークフロー (チーフ / プロジェクト / 週次振り返り / インフラチェック)
export * from './org-workflows';

const acts = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
});

// ask-a-person の回答期限 (ユーザー指定のルール)
const ANSWER_DEADLINE_MS = 3 * 60 * 60 * 1000; // 3時間

/**
 * Entity Workflow パターン: セッション1つ = Workflow 1つ。
 * Signal は1つずつ順番に処理されるので、複数人が同じセッションを
 * 同時に触っても状態が壊れない (排他制御を構造で担保する)。
 * エージェントの実行そのものは Activity 内の Pi Durable ハーネスが担い、
 * Temporal 側はセッションの受付・直列化・スケジューリングを持つ。
 *
 * 実装タスク ("impl:" で始まる入力) は、着手前に必ず grilling で
 * 要件を詰め、ask-a-person で人の回答を待つ。回答期限は3時間で、
 * 無回答の場合は状態を保存してそのタスクを停止し、次のタスクへ進む。
 * 保留したタスクは、あとから回答が来れば resumeParked の Signal で再開する
 * (質問はやり直さず、保存してあった質問と回答で要件を補強して実装に入る)。
 */
export async function sessionWorkflow(initial: Message[] = []): Promise<void> {
  const sessionId = workflowInfo().workflowId;
  const history: Message[] = [...initial];
  const inbox: string[] = [];
  let pendingQuestions: string[] | null = null;
  let answer: string | null = null;

  setHandler(userMessageSignal, (text: string) => {
    inbox.push(text);
  });
  setHandler(answerSignal, (text: string) => {
    answer = text;
  });
  // 再開の依頼は、通常の入力とは別に受ける。この Signal を受けたことのない実行中のセッションは、
  // これまでと同じ順序でコマンドを出すので、履歴の再生には影響しない (patched は不要)
  const resumes: ParkedResume[] = [];
  setHandler(resumeParkedSignal, (r: ParkedResume) => {
    resumes.push(r);
  });
  setHandler(historyQuery, () => history);
  setHandler(pendingQuestionsQuery, () => pendingQuestions);

  for (;;) {
    await condition(() => inbox.length > 0 || resumes.length > 0);
    if (inbox.length === 0) {
      // 保留からの再開: 保存してあった依頼・質問と、後から届いた回答で実装に入る
      const r = resumes.shift()!;
      history.push({
        role: 'user',
        content: enrichImplRequest(r.request, r.questions, r.answer),
      });
      const reply = await acts.runAgentStep(sessionId, history);
      history.push({ role: 'assistant', content: reply });
      continue;
    }
    const text = inbox.shift()!;
    history.push({ role: 'user', content: text });

    if (text.startsWith('impl:')) {
      const request = text.slice('impl:'.length).trim();
      // 1. grilling: 要件を詰める質問を生成する
      const questions = await acts.grillQuestions(request);
      // 2. ask-a-person: 質問を公開し、回答を最大3時間待つ (durable timer)
      pendingQuestions = questions;
      answer = null;
      const answered = await Promise.race([
        condition(() => answer !== null).then(() => true),
        sleep(ANSWER_DEADLINE_MS).then(() => false),
      ]);
      pendingQuestions = null;
      if (!answered) {
        // 3a. 期限切れ: 現在の状況を保存してこのタスクを停止し、次のタスクへ
        await acts.parkTask(sessionId, request, questions);
        history.push({
          role: 'assistant',
          content:
            '(grilling の回答が3時間なかったため、この実装タスクは状態を保存して停止しました)',
        });
        continue;
      }
      // 3b. 回答あり: 質問と回答で要件を補強してから実装に進む
      const enriched = [
        `実装依頼: ${request}`,
        '',
        '要件確認 (grilling) の質問:',
        ...questions.map((q, i) => `${i + 1}. ${q}`),
        '',
        '依頼者からの回答:',
        answer ?? '',
      ].join('\n');
      const stepHistory = history.slice();
      stepHistory[stepHistory.length - 1] = {
        role: 'user',
        content: enriched,
      };
      const reply = await acts.runAgentStep(sessionId, stepHistory);
      history.push({ role: 'assistant', content: reply });
      continue;
    }

    const reply = await acts.runAgentStep(sessionId, history);
    history.push({ role: 'assistant', content: reply });
    // イベントヒストリの肥大化を防ぐため、定期的に状態だけ引き継いで作り直す
    if (history.length > 200) {
      await continueAsNew<typeof sessionWorkflow>(history.slice(-100));
    }
  }
}

/**
 * Outer Loop: 前日のセッション記録を読み、分析し、レポートを残す。
 * Temporal Schedule から日次で起動される (src/register-schedule.ts)。
 * レポート作成までを実装している。「改善 PR の作成」は次のステップとする。
 */
export async function outerLoopWorkflow(): Promise<string> {
  const fetched = await acts.fetchRecentCheckpoints();
  const report = await acts.analyzeSessions(fetched);
  const path = await acts.writeOuterLoopReport(report);
  return path;
}
