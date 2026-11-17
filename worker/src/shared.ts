import { defineSignal, defineQuery } from '@temporalio/workflow';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// セッションへの入力 (非同期・一方通行)
export const userMessageSignal = defineSignal<[string]>('userMessage');
// grilling の質問への回答 (ask-a-person の応答)
export const answerSignal = defineSignal<[string]>('answer');
// セッション状態の読み取り (同期的・状態を変えない)
export const historyQuery = defineQuery<Message[]>('history');
// 回答待ちの grilling 質問 (無ければ null)
export const pendingQuestionsQuery = defineQuery<string[] | null>(
  'pendingQuestions',
);

export const TASK_QUEUE = 'kobun-sessions';
