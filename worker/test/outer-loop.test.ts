import { describe, expect, it } from 'vitest';
import {
  analysisPrompt,
  classifyError,
  errorExamples,
  extractRuleProposals,
  feedSummary,
  jstDate,
  renderReport,
  summarizeTurns,
  type TurnRow,
} from '../src/outer-loop';

const t = (o: Partial<TurnRow>): TurnRow => ({
  project_slug: 'p1',
  role: 'pjm',
  sender: 'chief',
  input: '依頼',
  output: '返事',
  duration_ms: 10_000,
  error: null,
  created_at: '2026-11-19T01:00:00Z',
  ...o,
});

describe('classifyError', () => {
  it('対処が同じものにまとめる', () => {
    expect(classifyError(null)).toBeNull();
    expect(classifyError("You've hit your 5-hour limit · resets 8pm (UTC)")).toBe('usage_limit');
    expect(classifyError('request timed out after 40 minutes')).toBe('timeout');
    expect(classifyError('routing_violation')).toBe('routing_violation');
    expect(classifyError('401 Unauthorized')).toBe('auth');
    expect(classifyError('something odd')).toBe('other');
  });
});

describe('summarizeTurns', () => {
  const rows: TurnRow[] = [
    t({ role: 'pjm', duration_ms: 20_000 }),
    t({ role: 'pjm', duration_ms: 40_000, input: '同じ依頼です' }),
    t({ role: 'pjm', duration_ms: 5_000, input: '同じ依頼です' }), // 繰り返し
    t({ role: 'engineer-lead', error: "You've hit your 5-hour limit", output: '', duration_ms: 1_000 }),
    t({ role: 'engineer-lead', sender: 'system', error: 'routing_violation', input: 'ux-analyst', duration_ms: 0 }),
    t({ role: 'chief', sender: 'user', project_slug: null, input: '貸出品の\n画面を直したい', output: '了解' }),
    t({ role: 'business-analyst', output: '(対応不要)' }),
  ];
  const s = summarizeTurns(rows, { legacySessions: 2 });

  it('発言と失敗を数える (経路違反は発言に含めず、失敗に含める)', () => {
    expect(s.records).toBe(7);
    expect(s.turns).toBe(6);
    expect(s.failedTurns).toBe(1);
    expect(s.violations).toBe(1);
    expect(s.errors).toBe(2);
    expect(s.errorsByKind.map((k) => [k.kind, k.count]).sort()).toEqual([
      ['routing_violation', 1],
      ['usage_limit', 1],
    ]);
    expect(s.legacySessions).toBe(2);
  });

  it('ロール別の平均・最大の所要時間', () => {
    const pjm = s.roles.find((r) => r.role === 'pjm')!;
    expect(pjm).toMatchObject({ turns: 3, errors: 0, avgSec: 22, maxSec: 40 });
    expect(s.roles.find((r) => r.role === 'engineer-lead')).toMatchObject({ turns: 1, errors: 1 });
  });

  it('同じ依頼の繰り返しと、実質的な応答を数える', () => {
    const p1 = s.projects.find((p) => p.project === 'p1')!;
    expect(p1.repeatedRequests).toBe(1);
    // 失敗・「対応不要」・経路違反を除く
    expect(p1.substantiveTurns).toBe(3);
  });

  it('ユーザーの入力は改行を空白にして残す', () => {
    expect(s.userInputs).toHaveLength(1);
    expect(s.userInputs[0].text).toBe('貸出品の 画面を直したい');
  });

  it('失敗の例は種類ごとに最大2件で、経路違反は含めない', () => {
    const many = Array.from({ length: 5 }, () => t({ error: 'timeout reached', output: '' }));
    const ex = errorExamples([...rows, ...many]);
    expect(ex.filter((e) => e.kind === 'timeout')).toHaveLength(2);
    expect(ex.some((e) => e.kind === 'routing_violation')).toBe(false);
  });
});

describe('レポート', () => {
  const s = summarizeTurns([t({}), t({ error: 'timeout' })]);

  it('記録が無い日は、LLM の結果に関係なく「記録なし」と書く', () => {
    const empty = summarizeTurns([]);
    expect(renderReport('2026-11-19', empty, { ok: true, text: '' })).toContain('記録はありませんでした');
  });

  it('LLM が失敗しても、数字は残り、失敗の理由が書かれる', () => {
    const md = renderReport('2026-11-19', s, { ok: false, error: 'boom' });
    expect(md).toContain('# Outer Loop レポート 2026-11-19');
    expect(md).toContain('発言: 2 回 (うち失敗 1 回');
    expect(md).toContain('LLM による分析は失敗しました');
    expect(md).toContain('boom');
  });

  it('LLM の依頼文は、数字だけを根拠にするよう求め、現在の共通ルールと提案の書式を渡す', () => {
    const p = analysisPrompt(s, [], [{ code: 'K-3', text: '根拠のない断定をしない' }]);
    expect(p).toContain('この数字だけを根拠に');
    expect(p).toContain('発言: 2 回');
    expect(p).toContain('- K-3: 根拠のない断定をしない');
    expect(p).toContain('<rule scope="common">');
    expect(p).toContain('ユーザーの承認を待ってから適用される');
  });

  it('承認待ちになった提案は、レポートに表で載り、除いた提案の理由も載る', () => {
    const md = renderReport(
      '2026-11-19',
      s,
      { ok: true, text: '分析' },
      {
        changes: [{ layer: 'kobun 共通', op: '承認待ち (追加)', code: '提案 #7', text: '上限に達したら再送しない', proposalId: 7 }],
        dropped: ['共通以外の層 (project) の提案: x'],
      },
    );
    expect(md).toContain('## kobun 共通ルールの提案 (承認待ち。承認されるまで適用されない)');
    expect(md).toContain('| 提案 #7 | 承認待ち (追加) | 上限に達したら再送しない |');
    expect(md).toContain('提案から除いた: 共通以外の層 (project) の提案: x');
    // 提案が無ければ節ごと出さない
    expect(renderReport('2026-11-19', s, { ok: true, text: '分析' })).not.toContain('共通ルールの提案');
  });

  it('フィードの要点は数字だけ', () => {
    const f = feedSummary(s, 'reports/outer-loop-2026-11-19.md');
    expect(f).toContain('発言 2 回、うち失敗 1 回。経路違反 0 件');
    expect(f).toContain('タイムアウト: 1 回');
    expect(feedSummary(s, 'p', 2)).toContain('共通ルールの提案: 2 件');
  });

  it('日付は JST', () => {
    expect(jstDate(new Date('2026-11-18T16:30:00Z'))).toBe('2026-11-19');
    expect(jstDate(new Date('2026-11-18T14:59:00Z'))).toBe('2026-11-18');
  });
});

describe('extractRuleProposals', () => {
  it('共通ルールの追加・置換・廃止を取り出し、タグを除いた本文を返す', () => {
    const raw = [
      '## 分析',
      '利用上限による失敗が 3 回。',
      '<rule scope="common">上限に達したロールには、同じ依頼を再送しない。</rule>',
      '<rule scope="common" replaces="k-3">根拠を示せない断定はしない。</rule>',
      '<rule-retire id="K-9">3 週間、該当する失敗が 0 件</rule-retire>',
    ].join('\n');
    const r = extractRuleProposals(raw);
    expect(r.rules).toHaveLength(2);
    expect(r.rules[0]).toMatchObject({ scope: 'common', text: '上限に達したロールには、同じ依頼を再送しない。' });
    expect(r.rules[1].replaces).toBe('K-3');
    expect(r.retires).toEqual([{ id: 'K-9', reason: '3 週間、該当する失敗が 0 件' }]);
    expect(r.text).toContain('利用上限による失敗が 3 回');
    expect(r.text).not.toContain('<rule');
    expect(r.dropped).toEqual([]);
  });

  it('共通以外の層と、共通以外のルール ID は捨てる', () => {
    const r = extractRuleProposals(
      [
        '<rule scope="project">このプロジェクトだけのルール</rule>',
        '<rule scope="client">クライアントのルール</rule>',
        '<rule scope="common" replaces="P-1">プロジェクトのルールを置換</rule>',
        '<rule-retire id="C-2">クライアントのルールを廃止</rule-retire>',
        '<rule scope="common">共通のルール</rule>',
      ].join('\n'),
    );
    expect(r.rules.map((x) => x.text)).toEqual(['共通のルール']);
    expect(r.retires).toEqual([]);
    expect(r.dropped).toHaveLength(4);
  });

  it('1回の提案は最大3件で、超えた分は捨てて理由を残す', () => {
    const raw = Array.from({ length: 5 }, (_, i) => `<rule scope="common">ルール${i}</rule>`).join('\n');
    const r = extractRuleProposals(raw);
    expect(r.rules).toHaveLength(3);
    expect(r.dropped.some((d) => d.includes('上限 (3 件) を超えた提案 2 件'))).toBe(true);
  });

  it('提案が無い出力は、そのまま本文になる', () => {
    const r = extractRuleProposals('提案なし。');
    expect(r).toMatchObject({ text: '提案なし。', rules: [], retires: [], dropped: [] });
  });
});
