// エージェント組織の純粋ロジックのテスト (DB・Temporal・LLM 不要)
import { describe, expect, it } from 'vitest';
import { ROLES, canTalk, isRoleId, type RoleId } from '../src/agents/roles';
import { parseOutput, protocolGuide, safeRelPath } from '../src/agents/protocol';
import {
  detectAnomalies,
  judge,
  renderRetroReport,
} from '../src/metrics/report';
import { CATALOG, missingMetrics, ownerOf, worsenedPct } from '../src/metrics/catalog';
import {
  MissingSecretError,
  findInlineSecrets,
  githubRepo,
  hasSecretRef,
  resolveSecrets,
} from '../src/metrics/collectors';
import { needsApproval } from '../src/rules';
import { maskConfig, pick } from '../src/metrics/collectors';

describe('会話ルーティング表', () => {
  const ids = Object.keys(ROLES) as RoleId[];

  it('ユーザーと直接話せるのはチーフだけ', () => {
    expect(ids.filter((id) => canTalk(id, 'user'))).toEqual(['chief']);
  });

  it('チーフと話せるプロジェクト内ロールは PjM だけ', () => {
    expect(ids.filter((id) => canTalk(id, 'chief'))).toEqual(['pjm']);
  });

  it('ロール間の会話は双方向 (返信が必ず届く)', () => {
    for (const from of ids) {
      for (const to of ROLES[from].talksTo) {
        if (isRoleId(to)) expect(canTalk(to, from), `${to} → ${from}`).toBe(true);
      }
    }
  });

  it('要望どおりの経路になっている', () => {
    expect(canTalk('pjm', 'business-analyst')).toBe(true);
    expect(canTalk('pjm', 'engineer-lead')).toBe(true);
    expect(canTalk('pjm', 'designer')).toBe(true);
    expect(canTalk('pjm', 'engineer-impl')).toBe(false);
    expect(canTalk('engineer-lead', 'engineer-impl')).toBe(true);
    expect(canTalk('designer', 'engineer-lead')).toBe(true);
    expect(canTalk('infra-engineer', 'engineer-lead')).toBe(true);
    expect(canTalk('business-analyst', 'engineer-lead')).toBe(false);
  });

  it('PjM と話すエンジニアは Opus、実装するエンジニアは Sonnet', () => {
    expect(ROLES['engineer-lead'].tier).toBe('opus');
    expect(ROLES['engineer-impl'].tier).toBe('sonnet');
  });
});

describe('出力プロトコル', () => {
  it('タグを構造化し、タグの外は rest に残す', () => {
    const p = parseOutput(
      [
        '了解しました。',
        '<message to="pjm" project="billing">請求の件をお願いします</message>',
        '<project slug="Billing App" name="請求" client="acme" client-name="アクメ商事">月次請求を自動化する</project>',
        '<artifact path="docs/spec.md"># 仕様\n本文</artifact>',
        '<read path="docs/ux-design.md"/>',
        '<improvement owner="engineer-lead" metric="ci_duration_avg_sec" target="300">CI を並列化</improvement>',
        '<rule>PR は 400 行以内</rule>',
        '<rule scope="client" replaces="c-2">請求書は税込表示</rule>',
        '<rule-retire id="K-3">効果なし</rule-retire>',
        '<adr title="キャッシュ">背景…</adr>',
        '<proposal saving="120.5">RDS を縮小</proposal>',
        '<feedback-request>離脱率の目標は妥当ですか</feedback-request>',
      ].join('\n'),
    );
    expect(p.rest).toBe('了解しました。');
    expect(p.messages).toEqual([
      { to: 'pjm', project: 'billing', content: '請求の件をお願いします' },
    ]);
    expect(p.projects[0]).toEqual({
      slug: 'billing-app',
      name: '請求',
      goal: '月次請求を自動化する',
      client: 'acme',
      clientName: 'アクメ商事',
    });
    expect(p.artifacts[0]).toEqual({ path: 'docs/spec.md', content: '# 仕様\n本文' });
    expect(p.reads).toEqual(['docs/ux-design.md']);
    expect(p.improvements[0]).toEqual({
      owner: 'engineer-lead',
      metric: 'ci_duration_avg_sec',
      target: 300,
      action: 'CI を並列化',
    });
    expect(p.rules).toEqual([
      { scope: 'project', replaces: null, text: 'PR は 400 行以内' },
      { scope: 'client', replaces: 'C-2', text: '請求書は税込表示' },
    ]);
    expect(p.ruleRetires).toEqual([{ id: 'K-3', reason: '効果なし' }]);
    expect(p.adrs[0].title).toBe('キャッシュ');
    expect(p.proposals[0].savingUsdMonth).toBe(120.5);
    expect(p.feedbackRequests).toHaveLength(1);
  });

  it('プロジェクトディレクトリの外を指すパスは捨てる', () => {
    expect(safeRelPath('../secrets')).toBeNull();
    expect(safeRelPath('/etc/passwd')).toBeNull();
    expect(safeRelPath('docs/../../x')).toBeNull();
    expect(safeRelPath('./docs//a.md')).toBe('docs/a.md');
    expect(parseOutput('<artifact path="../x">a</artifact>').artifacts).toEqual([]);
  });
});

describe('改善レポート', () => {
  it('達成判定は目標の向きを見る', () => {
    expect(judge(600, 300, 280)).toBe('achieved'); // 下げる目標
    expect(judge(600, 300, 400)).toBe('missed');
    expect(judge(60, 80, 85)).toBe('achieved'); // 上げる目標
    expect(judge(60, 80, 70)).toBe('missed');
    expect(judge(60, 80, null)).toBe('unmeasured');
  });

  it('未達・未計測・取得できなかった数字を隠さずに載せる', () => {
    const md = renderRetroReport({
      project: '請求',
      week: '2026-11-16',
      metrics: [
        { key: 'ci_duration_avg_sec', unit: '秒', source: 'github', current: 400, previous: 600 },
        { key: 'coverage_pct', unit: '%', source: 'command', current: null, previous: 71.5 },
      ],
      past: [
        {
          id: 1,
          owner: 'engineer-lead',
          action: 'CI を並列化',
          metricKey: 'ci_duration_avg_sec',
          baseline: 600,
          target: 300,
          current: 400,
          status: 'missed',
          missStreak: 2,
        },
      ],
      next: [
        { owner: 'designer', action: '登録フォームを1画面に', metricKey: null, baseline: null, target: null },
      ],
      client: 'アクメ商事',
      ruleChanges: [
        { layer: 'プロジェクト', op: '追加', code: 'P-1', text: 'PR は 400 行以内' },
        { layer: 'クライアント', op: '置換 (C-2 を廃止)', code: 'C-3', text: '請求書は税込表示' },
        { layer: 'kobun 共通', op: '承認待ち (廃止 K-3)', code: '提案 #7', text: '廃止の理由: 効果なし', proposalId: 7 },
      ],
      adrs: [],
      proposals: [{ savingUsdMonth: 120.5, content: 'RDS を縮小' }],
      worsened: [
        { key: 'ci_failure_rate_pct', unit: '%', owner: 'engineer-lead', previous: 10, current: 14, worsePct: 40 },
      ],
      gaps: [
        { subject: 'aws', state: '認証切れ', reason: 'ExpiredToken', needed: '再登録' },
      ],
      connectionsOk: 1,
      connectionsTotal: 5,
    });
    expect(md).toContain('| ci_duration_avg_sec | 秒 | 600 | 400 | -33.3% | github |');
    expect(md).toContain('| coverage_pct | % | 71.50 | 未計測 | - | command |');
    expect(md).toContain('1 件中 0 件達成 (2週以上連続で未達 1 件)');
    expect(md).toContain('悪化した指標: 1 件 (うち対応アクションなし 1 件)');
    expect(md).toContain('| ci_failure_rate_pct | engineer-lead | 10 | 14 | 40.0% | なし |');
    expect(md).toContain('未達');
    expect(md).toContain('うち指標・目標値なし 1 件');
    expect(md).toContain('正常な接続: 1 / 5');
    expect(md).toContain('| aws | 認証切れ | ExpiredToken | 再登録 |');
    expect(md).toContain('| 120.5 | RDS を縮小 |');
    expect(md).toContain('クライアント: アクメ商事');
    expect(md).toContain('行動ルールの変更: 3 件 (kobun 共通 1 / クライアント 1 / プロジェクト 1)');
    expect(md).toContain('| クライアント | 置換 (C-2 を廃止) | C-3 | 請求書は税込表示 |');
    expect(md).toContain('うちユーザーの承認待ち (未適用): 1 件');
    expect(md).toContain('| kobun 共通 | 承認待ち (廃止 K-3) | 提案 #7 | 廃止の理由: 効果なし |');
  });
});

describe('指標カタログ', () => {
  it('悪化は指標ごとの良い方向で判定する', () => {
    expect(worsenedPct('ci_duration_avg_sec', 660, 600)).toBeCloseTo(10); // 低いほど良い
    expect(worsenedPct('ci_duration_avg_sec', 540, 600)).toBeNull();
    expect(worsenedPct('coverage_pct', 72, 80)).toBeCloseTo(10); // 高いほど良い
    expect(worsenedPct('coverage_pct', 85, 80)).toBeNull();
    expect(worsenedPct('db_connections', 99, 10)).toBeNull(); // 方向なし
  });

  it('ユーザーが挙げた品質指標をすべて持ち、担当と取得方法が決まっている', () => {
    for (const key of [
      'duplication_pct', // 再利用性
      'complexity_avg', // 複雑度
      'coverage_pct', // テストカバレッジ
      'bug_rate_per_100_prs', // 不具合発生率
      'ci_duration_avg_sec', // CI の実行時間
    ]) {
      expect(ownerOf(key)).toBe('engineer-lead');
    }
    expect(ownerOf('ux_dropoff_pct')).toBe('ux-analyst');
    expect(ownerOf('outcome_fit_score')).toBe('business-analyst');
    expect(ownerOf('cost_usd_7d')).toBe('infra-engineer');
    expect(CATALOG.every((m) => m.how.length > 0)).toBe(true);
    expect(missingMetrics(new Set(CATALOG.map((m) => m.key)))).toEqual([]);
  });
});

describe('ルール変更の承認', () => {
  it('他のプロジェクトにも効く層だけ承認が要る', () => {
    expect(needsApproval('common')).toBe(true);
    expect(needsApproval('client')).toBe(true);
    expect(needsApproval('project')).toBe(false);
  });
});

describe('異常検知', () => {
  it('コストが直近平均より 20% を超えて増えたら異常', () => {
    const a = detectAnomalies([
      { key: 'cost_usd_day', unit: 'USD', values: [10, 10, 10, 13] },
      { key: 'cost_usd_7d', unit: 'USD', values: [70, 70, 70, 80] },
    ]);
    expect(a.map((x) => x.key)).toEqual(['cost_usd_day']);
    expect(a[0].deltaPct).toBeCloseTo(30);
  });

  it('比較対象が3点未満なら判定しない', () => {
    expect(
      detectAnomalies([{ key: 'cost_usd_day', unit: 'USD', values: [10, 10, 99] }]),
    ).toEqual([]);
  });

  it('コスト以外は標準偏差で判定する', () => {
    const base = [50, 52, 48, 51, 49, 50, 52, 48];
    expect(
      detectAnomalies([{ key: 'db_connections', unit: '本', values: [...base, 51] }]),
    ).toEqual([]);
    expect(
      detectAnomalies([{ key: 'db_connections', unit: '本', values: [...base, 120] }]),
    ).toHaveLength(1);
  });
});

describe('シークレット', () => {
  it('設定に直接書かれた資格情報を見つける', () => {
    expect(
      findInlineSecrets({
        token: 'ghp_raw',
        url: 'postgres://user:pass@host/db',
        requests: [{ url: 'https://a.example', headers: { Authorization: 'Bearer raw' } }],
      }),
    ).toEqual(['token', 'url', 'requests[0].headers.Authorization']);
  });

  it('{{secret:名前}} の参照だけなら問題なし', () => {
    expect(
      findInlineSecrets({
        token: '{{secret:GITHUB_TOKEN}}',
        url: 'postgres://user:{{secret:DB_PASSWORD}}@host/db',
        accessKeyId: 'AKIAEXAMPLE',
        requests: [{ headers: { Authorization: 'Bearer {{secret:KEY}}' } }],
        commands: { coverage_pct: { cmd: 'npm test', unit: '%' } },
      }),
    ).toEqual([]);
  });

  it('参照を値に置き換え、未登録の名前はまとめて報告する', () => {
    expect(
      resolveSecrets(
        { url: 'postgres://u:{{secret:PW}}@h/db', headers: { Authorization: 'Bearer {{secret:KEY}}' } },
        { PW: 'p1', KEY: 'k1' },
      ),
    ).toEqual({ url: 'postgres://u:p1@h/db', headers: { Authorization: 'Bearer k1' } });
    try {
      resolveSecrets({ a: '{{secret:A}}', b: ['{{secret:B}}'] }, {});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MissingSecretError);
      expect((err as MissingSecretError).names).toEqual(['A', 'B']);
    }
  });

  it('サンドボックスで実行される command の設定にシークレット参照があれば見つける', () => {
    expect(hasSecretRef({ commands: { x: { cmd: 'curl -H "k: {{secret:KEY}}" https://a' } } })).toBe(true);
    expect(hasSecretRef({ commands: { x: { cmd: 'npm test' } } })).toBe(false);
  });

  it('リポジトリ URL から owner/name を取り出す', () => {
    expect(githubRepo('https://github.com/acme/billing.git')).toBe('acme/billing');
    expect(githubRepo('git@github.com:acme/billing.git')).toBe('acme/billing');
    expect(githubRepo('acme/billing')).toBe('acme/billing');
    expect(githubRepo('https://gitlab.com/acme/billing')).toBeNull();
  });
});

describe('接続情報', () => {
  it('資格情報を伏せる', () => {
    expect(
      maskConfig({
        repo: 'o/r',
        token: 'ghp_x',
        secretAccessKey: 's',
        url: 'postgres://u:p@host:5432/db',
        requests: [{ url: 'https://a.example/x', headers: { Authorization: 'Bearer z' } }],
      }),
    ).toEqual({
      repo: 'o/r',
      token: '***',
      secretAccessKey: '***',
      url: 'postgres://***@host:5432/db',
      requests: [{ url: 'https://a.example/x', headers: { Authorization: '***' } }],
    });
  });

  it('JSON 応答からドット区切りのパスで値を取る', () => {
    expect(pick({ a: { b: [{ c: 4.2 }] } }, 'a.b.0.c')).toBe(4.2);
    expect(pick({ a: null }, 'a.b')).toBeUndefined();
  });
});

describe('リポジトリの読み取り', () => {
  it('読める状態なら、プロジェクトのどのロールにも読み取りのタグが案内される', () => {
    for (const role of Object.values(ROLES).filter((r) => r.scope === 'project')) {
      const guide = protocolGuide({
        recipients: role.talksTo,
        isChief: false,
        inProject: true,
        canReadRepos: true,
      });
      for (const tag of ['<repo-list', '<repo-grep', '<repo-read']) {
        expect(guide, `${role.id} に ${tag} の説明が無い`).toContain(tag);
      }
    }
  });

  it('読めない状態では、読み取りのタグを案内しない', () => {
    const guide = protocolGuide({ recipients: ['pjm'], isChief: false, inProject: true });
    expect(guide).not.toContain('<repo-read');
  });
});
