// 仕事の期限と所有者、期限切れの段階上げ、チーフへの判断待ち一覧 (純粋関数)
import { describe, expect, it } from 'vitest';
import { parseOutput } from '../src/agents/protocol';
import { renderBoard, type BoardData } from '../src/board';
import { CATALOG } from '../src/metrics/catalog';
import {
  ESCALATION_GRACE_MS,
  dueFor,
  dueLabel,
  enrichImplRequest,
  nextEscalation,
  normalizeRuleText,
  ownerFor,
  parseDue,
  renderChiefDigest,
  type DueItem,
} from '../src/followup';

const HOUR = 3_600_000;
const now = Date.parse('2026-11-19T03:00:00Z'); // 日本時間 11/19 12:00

describe('期限の指定', () => {
  it('相対 (時間・日・週) を読む', () => {
    expect(parseDue('36h', now)).toBe(now + 36 * HOUR);
    expect(parseDue('3d', now)).toBe(now + 72 * HOUR);
    expect(parseDue('1W', now)).toBe(now + 168 * HOUR);
  });

  it('日付だけなら、日本時間のその日の終わり', () => {
    expect(new Date(parseDue('2026-11-21', now)!).toISOString()).toBe('2026-11-21T14:59:00.000Z');
  });

  it('時刻つきは日本時間として読む (タイムゾーン付きならそれに従う)', () => {
    expect(new Date(parseDue('2026-11-21T15:00', now)!).toISOString()).toBe('2026-11-21T06:00:00.000Z');
    expect(new Date(parseDue('2026-11-21T15:00Z', now)!).toISOString()).toBe('2026-11-21T15:00:00.000Z');
  });

  it('読めない指定は null。その場合は種類ごとの既定になる (質問 2 日、やること 7 日)', () => {
    expect(parseDue('そのうち', now)).toBeNull();
    expect(parseDue('0d', now)).toBeNull();
    expect(parseDue(undefined, now)).toBeNull();
    expect(dueFor('question', 'そのうち', now)).toBe(now + 48 * HOUR);
    expect(dueFor('task', undefined, now)).toBe(now + 168 * HOUR);
    expect(dueFor('task', '12h', now)).toBe(now + 12 * HOUR);
  });

  it('残りと超過を表示する', () => {
    expect(dueLabel(now + 5 * HOUR, now)).toBe('期限 あと5時間');
    expect(dueLabel(now - 3 * 24 * HOUR, now)).toBe('期限切れ 3日超過');
  });
});

describe('担当', () => {
  it('指定があればそれを使う。プロジェクトのロールとユーザーだけが担当になれる', () => {
    expect(ownerFor('engineer-lead', 'pjm')).toBe('engineer-lead');
    expect(ownerFor('USER', 'pjm')).toBe('user');
    // チーフはプロジェクトのロールではないので担当にしない
    expect(ownerFor('chief', 'designer')).toBe('designer');
    expect(ownerFor('だれか', 'designer')).toBe('designer');
  });

  it('省いたら書いた本人。本人がチーフ・ユーザーなら PjM', () => {
    expect(ownerFor(undefined, 'business-analyst')).toBe('business-analyst');
    expect(ownerFor(undefined, 'chief')).toBe('pjm');
    expect(ownerFor(undefined, 'user')).toBe('pjm');
  });
});

describe('ボードのタグ (担当と期限)', () => {
  it('question / task の担当と期限、期限の引き直しを解釈する', () => {
    const p = parseOutput(
      [
        '<board kind="question" owner="User" due="2d">締め日の例外はあるか</board>',
        '<board kind="task" owner="engineer-lead" due="2026-11-21">API 仕様の初版を書く</board>',
        '<board kind="task">担当と期限を省いた仕事</board>',
        '<board-due id="b-7" due="3d">デザイナーの回答待ち。届き次第レビューする</board-due>',
        '<board-due id="B-8">期限の指定が無いものは捨てる</board-due>',
      ].join('\n'),
    );
    expect(p.board).toEqual([
      { kind: 'question', owner: 'user', due: '2d', text: '締め日の例外はあるか' },
      { kind: 'task', owner: 'engineer-lead', due: '2026-11-21', text: 'API 仕様の初版を書く' },
      { kind: 'task', text: '担当と期限を省いた仕事' },
    ]);
    expect(p.boardDues).toEqual([
      { id: 'B-7', due: '3d', reason: 'デザイナーの回答待ち。届き次第レビューする' },
    ]);
    expect(p.rest).toBe('');
  });

  it('ボードに担当と期限が出る', () => {
    const board: BoardData = {
      project: 'billing',
      entries: [
        { code: 'B-1', kind: 'fact', author: 'user', text: '本番ブランチは main', createdAt: '2026-11-19T02:00:00Z' },
        {
          code: 'B-2',
          kind: 'question',
          author: 'pjm',
          text: '締め日の例外はあるか',
          createdAt: '2026-11-18T03:00:00Z',
          owner: 'user',
          dueAt: '2026-11-19T01:00:00Z',
        },
        {
          code: 'B-3',
          kind: 'task',
          author: 'pjm',
          text: 'API 仕様の初版を書く',
          createdAt: '2026-11-19T02:00:00Z',
          owner: 'engineer-lead',
          dueAt: '2026-11-21T03:00:00Z',
        },
      ],
      members: [],
      activity: [],
    };
    const text = renderBoard(board, { nowMs: now });
    expect(text).toContain('- [B-1] 本番ブランチは main (ユーザー、60分前)');
    expect(text).toContain('- [B-2] 締め日の例外はあるか 〔担当 ユーザー、期限切れ 2時間超過〕');
    expect(text).toContain('### やること (1 件)');
    expect(text).toContain('- [B-3] API 仕様の初版を書く 〔担当 シニアエンジニア (リード)、期限 あと2日〕');
  });
});

describe('期限切れの段階上げ', () => {
  const item = (over: Partial<DueItem> = {}): DueItem => ({
    code: 'B-12',
    slug: 'billing',
    projectName: '請求',
    kind: 'task',
    text: 'API 仕様の初版を書く',
    owner: 'engineer-lead',
    dueMs: now - HOUR,
    level: 0,
    escalatedMs: null,
    ...over,
  });

  it('期限の前は何もしない', () => {
    expect(nextEscalation(item({ dueMs: now + HOUR }), now)).toBeNull();
  });

  it('段階 1: 担当に催促する (片付けるか、理由つきで期限を引き直すよう求める)', () => {
    const step = nextEscalation(item(), now)!;
    expect(step.level).toBe(1);
    expect(step.nudge?.to).toBe('engineer-lead');
    expect(step.nudge?.content).toContain('[B-12] API 仕様の初版を書く');
    expect(step.nudge?.content).toContain('<board-resolve');
    expect(step.nudge?.content).toContain('<board-due');
    expect(step.chief).toBeUndefined();
    expect(step.user).toBeUndefined();
  });

  it('催促から 24 時間は次の段階へ上げない', () => {
    const waiting = item({ level: 1, escalatedMs: now - ESCALATION_GRACE_MS + 1 });
    expect(nextEscalation(waiting, now)).toBeNull();
  });

  it('段階 2: PjM に上げ、チーフの一覧に載せる', () => {
    const step = nextEscalation(item({ level: 1, escalatedMs: now - ESCALATION_GRACE_MS }), now)!;
    expect(step.level).toBe(2);
    expect(step.nudge?.to).toBe('pjm');
    expect(step.chief).toBe(true);
    expect(step.user).toBeUndefined();
  });

  it('担当が PjM なら、段階 2 で PjM に同じ催促を繰り返さない', () => {
    const step = nextEscalation(
      item({ owner: 'pjm', level: 1, escalatedMs: now - ESCALATION_GRACE_MS }),
      now,
    )!;
    expect(step).toEqual({ level: 2, chief: true });
  });

  it('段階 3: ユーザーに出す。そこから先は何もしない', () => {
    const step = nextEscalation(item({ level: 2, escalatedMs: now - ESCALATION_GRACE_MS }), now)!;
    expect(step).toEqual({ level: 3, user: true });
    expect(nextEscalation(item({ level: 3, escalatedMs: now - 10 * ESCALATION_GRACE_MS }), now)).toBeNull();
  });

  it('担当がユーザーの項目は、エージェントを催促せず、直接ユーザーに出す', () => {
    expect(nextEscalation(item({ owner: 'user' }), now)).toEqual({ level: 3, user: true });
  });
});

describe('チーフに渡す判断待ちの一覧', () => {
  it('新しく載せるものが無ければ null (チーフを起こさない)', () => {
    expect(renderChiefDigest({ escalated: [], parked: [], proposals: [] }, now)).toBeNull();
  });

  it('期限切れ・保留中の実装タスク・期限を過ぎた提案を、対応の仕方つきで載せる', () => {
    const text = renderChiefDigest(
      {
        escalated: [
          {
            code: 'B-12',
            slug: 'billing',
            projectName: '請求',
            kind: 'question',
            text: '締め日の例外はあるか',
            owner: 'business-analyst',
            dueMs: now - 30 * HOUR,
            level: 2,
            escalatedMs: now,
          },
        ],
        parked: [{ id: 4, sessionId: 'session-x', request: '請求書 PDF を生成する', ageMs: 4 * 24 * HOUR }],
        proposals: [
          { id: 9, project: 'billing', layer: 'クライアント', summary: '追加: 金額は税込で表示する', overdueMs: 2 * HOUR },
        ],
      },
      now,
    )!;
    expect(text).toContain('<message to="pjm" project="slug">');
    expect(text).toContain('- 請求 (billing): [B-12] 締め日の例外はあるか');
    expect(text).toContain('期限切れ 30時間超過');
    expect(text).toContain('- #4 (4日前に保留): 請求書 PDF を生成する');
    expect(text).toContain('/resume <番号> <回答>');
    expect(text).toContain('- #9 [クライアント] 追加: 金額は税込で表示する');
    expect(text).toContain('自動では適用も却下もされない');
  });

  it('該当が無い節は出さない', () => {
    const text = renderChiefDigest(
      { escalated: [], parked: [{ id: 1, sessionId: 's', request: 'x', ageMs: 72 * HOUR }], proposals: [] },
      now,
    )!;
    expect(text).not.toContain('期限を過ぎ、担当に催促しても');
    expect(text).not.toContain('承認の期限を過ぎた');
  });
});

describe('却下した提案を蒸し返さない', () => {
  it('文面は、空白と文末の句点の違いを無視して比べる', () => {
    expect(normalizeRuleText(' 金額は税込で\n 表示する。')).toBe(normalizeRuleText('金額は税込で 表示する'));
    expect(normalizeRuleText('金額は税込で表示する')).not.toBe(normalizeRuleText('金額は税抜で表示する'));
  });
});

describe('保留からの再開', () => {
  it('保存してあった依頼・質問と、後から届いた回答で要件を補強する', () => {
    expect(enrichImplRequest('請求書 PDF を生成する', ['対象は？', '完了条件は？'], '月次請求。PDF が保存されること')).toBe(
      [
        '実装依頼: 請求書 PDF を生成する',
        '',
        '要件確認 (grilling) の質問:',
        '1. 対象は？',
        '2. 完了条件は？',
        '',
        '依頼者からの回答:',
        '月次請求。PDF が保存されること',
      ].join('\n'),
    );
  });
});

describe('指標カタログ', () => {
  it('期限切れの件数を、PjM が担当する指標として持つ', () => {
    for (const key of ['board_overdue', 'rule_proposals_overdue']) {
      const def = CATALOG.find((m) => m.key === key);
      expect(def?.owner).toBe('pjm');
      expect(def?.source).toBe('kobun');
      expect(def?.better).toBe('lower');
    }
  });
});
