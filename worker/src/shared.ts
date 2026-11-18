import { defineSignal, defineQuery } from '@temporalio/workflow';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// セッションへの入力 (非同期・一方通行)
export const userMessageSignal = defineSignal<[string]>('userMessage');
// grilling の質問への回答 (ask-a-person の応答)
export const answerSignal = defineSignal<[string]>('answer');
// 保留した実装タスクの再開 (回答が期限の後に来たとき)。grilling をやり直さず、実装から始める
export interface ParkedResume {
  parkedId: number;
  request: string;
  questions: string[];
  answer: string;
}
export const resumeParkedSignal = defineSignal<[ParkedResume]>('resumeParked');
// セッション状態の読み取り (同期的・状態を変えない)
export const historyQuery = defineQuery<Message[]>('history');
// 回答待ちの grilling 質問 (無ければ null)
export const pendingQuestionsQuery = defineQuery<string[] | null>(
  'pendingQuestions',
);

export const TASK_QUEUE = 'kobun-sessions';

// ---------------------------------------------------------------------------
// エージェント組織 (チーフ / プロジェクト)
// ---------------------------------------------------------------------------
import type { Addr, Envelope, RoleId } from './agents/roles';

export const CHIEF_WORKFLOW_ID = 'chief';
export const projectWorkflowId = (slug: string): string => `project-${slug}`;

// チーフ宛のメッセージ (ユーザーまたは PjM から)
export const chiefInboxSignal = defineSignal<[Envelope]>('chiefInbox');
// プロジェクト内のロール宛のメッセージ (チーフ、振り返り、インフラチェックから)
export const projectInboxSignal = defineSignal<[Envelope]>('projectInbox');

export interface ChiefState {
  thread: Message[];
  turns: number;
}
export interface ProjectState {
  slug: string;
  name: string;
  goal: string;
  client: string;
  clientName: string;
  threads: Partial<Record<RoleId, Message[]>>;
  queue: Envelope[];
  turns: number;
  violations: number;
  /** いま発言を作っているロール (誰からのメッセージに、いつから取り組んでいるか)。誰も動いていなければ null */
  current?: { role: RoleId; from: Addr; since: number } | null;
  /** いま発言を作っているロール全員 (別々のロールは同時に動く) */
  working?: { role: RoleId; from: Addr; since: number }[];
}
export const chiefStateQuery = defineQuery<ChiefState>('chiefState');
export const projectStateQuery = defineQuery<ProjectState>('projectState');
