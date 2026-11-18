// プロジェクトのボード: タグの解釈と表示
import { describe, expect, it } from 'vitest';
import { parseOutput } from '../src/agents/protocol';
import { renderBoard, type BoardData } from '../src/board';

describe('ボードのタグ', () => {
  it('情報・決定・質問・解決・自分の状況を解釈する', () => {
    const p = parseOutput(
      [
        '<board kind="fact">本番ブランチは main</board>',
        '<board kind="decision" project="Billing">締め日は顧客ごとに設定する (ユーザー決定)</board>',
        '<board kind="question">モバイルアプリのリポジトリはあるか (ユーザーに確認中)</board>',
        '<board>種類を省くと情報として扱う</board>',
        '<board-resolve id="b-3">ユーザーから回答あり: 無い</board-resolve>',
        '<status>仕様書の3章を執筆中 / 次は API 設計 / デザイナーの回答待ち</status>',
      ].join('\n'),
    );
    expect(p.board).toEqual([
      { kind: 'fact', text: '本番ブランチは main' },
      { kind: 'decision', project: 'billing', text: '締め日は顧客ごとに設定する (ユーザー決定)' },
      { kind: 'question', text: 'モバイルアプリのリポジトリはあるか (ユーザーに確認中)' },
      { kind: 'fact', text: '種類を省くと情報として扱う' },
    ]);
    expect(p.boardResolves).toEqual([{ id: 'B-3', reason: 'ユーザーから回答あり: 無い' }]);
    expect(p.status).toBe('仕様書の3章を執筆中 / 次は API 設計 / デザイナーの回答待ち');
    expect(p.rest).toBe('');
  });
});

describe('ボードの表示', () => {
  const now = Date.parse('2026-11-19T03:00:00Z');
  const board: BoardData = {
    project: 'billing',
    entries: [
      { code: 'B-1', kind: 'fact', author: 'user', text: '本番ブランチは main', createdAt: '2026-11-19T02:00:00Z' },
      { code: 'B-2', kind: 'decision', author: 'pjm', text: '締め日は顧客ごと', createdAt: '2026-11-19T02:30:00Z' },
    ],
    members: [
      {
        role: 'pjm',
        title: 'プロジェクトマネージャー (PjM)',
        workingSince: now - 40_000,
        note: '仕様書のレビュー中',
        noteAt: '2026-11-19T02:50:00Z',
        last: null,
      },
      {
        role: 'engineer-lead',
        title: 'シニアエンジニア (リード)',
        workingSince: null,
        note: '',
        noteAt: null,
        last: { at: '2026-11-19T02:55:00Z', from: 'pjm', sentTo: ['pjm'], artifacts: ['docs/spec.md'], error: false },
      },
      { role: 'designer', title: 'シニアデザイナー', workingSince: null, note: '', noteAt: null, last: null },
    ],
    activity: [
      { at: '2026-11-19T02:55:00Z', role: 'engineer-lead', from: 'pjm', sentTo: ['pjm'], artifacts: ['docs/spec.md'], error: false },
    ],
  };

  it('誰が書いたか・いつかと、メンバーの状況 (実際の記録) が出る', () => {
    const text = renderBoard(board, { nowMs: now });
    expect(text).toContain('### 共有された情報 (1 件)');
    expect(text).toContain('- [B-1] 本番ブランチは main (ユーザー、60分前)');
    expect(text).toContain('- [B-2] 締め日は顧客ごと (プロジェクトマネージャー (PjM)、30分前)');
    expect(text).toContain('### 未解決の質問 (0 件)\n(なし)');
    expect(text).toContain('(pjm): 対応中 (40秒前から) — 本人のメモ: 仕様書のレビュー中');
    expect(text).toContain('(engineer-lead): 待機 (最後の発言 5分前: pjm に送信 / docs/spec.md を更新)');
    expect(text).toContain('(designer): まだ出番なし');
    expect(text).toContain('- 5分前 engineer-lead (pjm からの依頼): pjm に送信 / docs/spec.md を更新');
  });

  it('チーフ向けの短い形では、直近の動きを省く', () => {
    expect(renderBoard(board, { nowMs: now, compact: true })).not.toContain('直近の動き');
  });
});
