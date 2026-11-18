// エージェントの出力プロトコル (純粋関数)。
// LLM の応答に含まれるタグを構造化データに変換する。長い Markdown を含むため、
// JSON ではなくタグで囲む形式にしている。

export interface OutMessage {
  to: string;
  project?: string;
  content: string;
}
export interface OutArtifact {
  path: string;
  content: string;
}
export interface RepoOp {
  op: 'list' | 'read' | 'grep';
  repo: string;
  path: string;
  pattern?: string;
  from?: number;
  lines?: number;
}
export interface OutBoard {
  kind: 'fact' | 'decision' | 'question' | 'task';
  /** チーフが書くときの対象プロジェクト */
  project?: string;
  /** 担当 (question / task のみ)。省くと書いた本人 */
  owner?: string;
  /** 期限の指定 (question / task のみ)。"36h" / "3d" / "2026-11-21"。省くと既定の期限 */
  due?: string;
  text: string;
}
/** 期限の引き直し */
export interface OutBoardDue {
  id: string;
  project?: string;
  due: string;
  reason: string;
}
export interface OutBoardResolve {
  id: string;
  project?: string;
  reason: string;
}
export interface OutProject {
  slug: string;
  name: string;
  goal: string;
  /** クライアントの slug。未指定なら空 (プロジェクトは作られず差し戻される) */
  client: string;
  clientName: string;
}
export type RuleScope = 'common' | 'client' | 'project';
export interface OutRule {
  scope: RuleScope;
  /** 置き換える既存ルールの ID (例: "C-3")。新規追加なら null */
  replaces: string | null;
  text: string;
}
export interface OutRuleRetire {
  id: string;
  reason: string;
}
export interface OutImprovement {
  owner: string;
  metric: string | null;
  target: number | null;
  action: string;
}
export interface OutAdr {
  title: string;
  content: string;
}
export interface OutProposal {
  /** 月額の削減見込み (USD)。数字が無い提案は null */
  savingUsdMonth: number | null;
  content: string;
}

export interface ParsedOutput {
  messages: OutMessage[];
  artifacts: OutArtifact[];
  reads: string[];
  /** 数字を取り寄せたいデータソースの名前 */
  fetches: string[];
  /** リポジトリの一覧・検索・読み取りの要求 */
  repoOps: RepoOp[];
  /** ボードへの書き込みと、解決済みにする項目 */
  board: OutBoard[];
  boardResolves: OutBoardResolve[];
  /** 期限の引き直し */
  boardDues: OutBoardDue[];
  /** 自分の状況のメモ (いま取り組んでいること / 次にやること) */
  status: string | null;
  projects: OutProject[];
  improvements: OutImprovement[];
  rules: OutRule[];
  ruleRetires: OutRuleRetire[];
  adrs: OutAdr[];
  proposals: OutProposal[];
  feedbackRequests: string[];
  /** タグの外に書かれたテキスト (差出人への返信として扱う) */
  rest: string;
}

const TAGS =
  'message|artifact|board-resolve|board-due|board|status|repo-list|repo-read|repo-grep|read|fetch|project|improvement|rule-retire|rule|adr|proposal|feedback-request';
const TAG_RE = new RegExp(
  `<(${TAGS})\\b([^>]*?)(?:/>|>([\\s\\S]*?)</\\1>)`,
  'g',
);
const ATTR_RE = /([\w-]+)="([^"]*)"/g;

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) out[m[1]] = m[2];
  return out;
}

function unescapeAttr(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function ruleScope(v: string | undefined): RuleScope {
  return v === 'common' || v === 'client' ? v : 'project';
}

function num(v: string | undefined): number | null {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 成果物パスの正規化。プロジェクトディレクトリの外を指すものは null */
export function safeRelPath(p: string): string | null {
  const parts = p.trim().replace(/\\/g, '/').split('/');
  if (p.trim().startsWith('/')) return null;
  const clean: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    clean.push(part);
  }
  return clean.length > 0 ? clean.join('/') : null;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

export function parseOutput(text: string): ParsedOutput {
  const out: ParsedOutput = {
    messages: [],
    artifacts: [],
    reads: [],
    fetches: [],
    repoOps: [],
    board: [],
    boardResolves: [],
    boardDues: [],
    status: null,
    projects: [],
    improvements: [],
    rules: [],
    ruleRetires: [],
    adrs: [],
    proposals: [],
    feedbackRequests: [],
    rest: '',
  };
  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[1];
    const a = attrs(m[2] ?? '');
    const body = (m[3] ?? '').trim();
    switch (tag) {
      case 'message':
        if (a.to && body) {
          out.messages.push({ to: a.to, project: a.project, content: body });
        }
        break;
      case 'artifact': {
        const p = safeRelPath(a.path ?? '');
        if (p && body) out.artifacts.push({ path: p, content: body });
        break;
      }
      case 'read': {
        const p = safeRelPath(a.path ?? '');
        if (p) out.reads.push(p);
        break;
      }
      case 'board':
        if (body) {
          out.board.push({
            kind:
              a.kind === 'decision' || a.kind === 'question' || a.kind === 'task' ? a.kind : 'fact',
            ...(a.project ? { project: slugify(a.project) } : {}),
            ...(a.owner ? { owner: a.owner.trim().toLowerCase() } : {}),
            ...(a.due ? { due: a.due.trim() } : {}),
            text: body,
          });
        }
        break;
      case 'board-resolve':
        if (a.id) {
          out.boardResolves.push({
            id: a.id.trim().toUpperCase(),
            ...(a.project ? { project: slugify(a.project) } : {}),
            reason: body,
          });
        }
        break;
      case 'board-due':
        if (a.id && a.due) {
          out.boardDues.push({
            id: a.id.trim().toUpperCase(),
            ...(a.project ? { project: slugify(a.project) } : {}),
            due: a.due.trim(),
            reason: body,
          });
        }
        break;
      case 'status':
        if (body) out.status = body;
        break;
      case 'repo-list':
      case 'repo-read':
      case 'repo-grep': {
        const op = tag.slice('repo-'.length) as RepoOp['op'];
        const p = a.path ? safeRelPath(a.path) : '.';
        if (!a.repo || p === null) break;
        if (op === 'read' && p === '.') break;
        if (op === 'grep' && !a.pattern) break;
        out.repoOps.push({
          op,
          repo: a.repo.trim(),
          path: p,
          ...(a.pattern ? { pattern: unescapeAttr(a.pattern) } : {}),
          ...(num(a.from) !== null ? { from: num(a.from) as number } : {}),
          ...(num(a.lines) !== null ? { lines: num(a.lines) as number } : {}),
        });
        break;
      }
      case 'fetch':
        if (a.source) out.fetches.push(a.source.trim());
        break;
      case 'project': {
        const slug = slugify(a.slug ?? a.name ?? '');
        if (slug) {
          const client = slugify(a.client ?? '');
          out.projects.push({
            slug,
            name: a.name ?? slug,
            goal: body,
            client,
            clientName: a['client-name'] ?? a.client ?? '',
          });
        }
        break;
      }
      case 'improvement':
        if (body) {
          out.improvements.push({
            owner: a.owner ?? '',
            metric: a.metric ? a.metric : null,
            target: num(a.target),
            action: body,
          });
        }
        break;
      case 'rule':
        if (body) {
          out.rules.push({
            scope: ruleScope(a.scope),
            replaces: a.replaces ? a.replaces.trim().toUpperCase() : null,
            text: body.replace(/\s*\n\s*/g, ' '),
          });
        }
        break;
      case 'rule-retire':
        if (a.id) {
          out.ruleRetires.push({ id: a.id.trim().toUpperCase(), reason: body });
        }
        break;
      case 'adr':
        if (body) out.adrs.push({ title: a.title ?? '無題', content: body });
        break;
      case 'proposal':
        if (body) {
          out.proposals.push({ savingUsdMonth: num(a.saving), content: body });
        }
        break;
      case 'feedback-request':
        if (body) out.feedbackRequests.push(body);
        break;
    }
  }
  out.rest = text.replace(TAG_RE, '').trim();
  return out;
}

/** ロールに渡す出力プロトコルの説明 */
export function protocolGuide(opts: {
  recipients: string[];
  isChief: boolean;
  inProject: boolean;
  /** 読めるリポジトリが1つ以上あるか */
  canReadRepos?: boolean;
}): string {
  const lines = [
    '## 出力プロトコル',
    '出力は次のタグで構成する。タグの外に書いた文章は、今回の差出人への返信として扱われる。',
    `- <message to="宛先">本文</message> … 宛先は ${opts.recipients.join(' / ')} のいずれか。複数書いてよい。`,
  ];
  if (opts.isChief) {
    lines.push(
      '- <message to="pjm" project="slug">本文</message> … PjM 宛は project (プロジェクトの slug) が必須。',
      '- <project slug="英小文字とハイフン" name="表示名" client="クライアントのslug" client-name="クライアントの表示名">プロジェクトの目的・背景</project>',
      '  … 新規プロジェクトを作る。client は必須 (ユーザーに確認済みのもの)。既存クライアントなら一覧にある slug を使う。',
      '  作成と同時に目的が PjM に渡る。',
    );
  }
  if (opts.inProject) {
    lines.push(
      '- <artifact path="docs/xxx.md">Markdown 全文</artifact> … 成果物をプロジェクトに保存する (同じ path は上書き)。',
      '- <read path="docs/xxx.md"/> … 成果物の内容を読む (内容が返ってきてから続きを書ける)。',
      '- <fetch source="データソース名"/> … 調査のために、データソースから最新の数字を取り寄せる。',
      '  API キーなどの資格情報はあなたには見えない。必要なデータソースやキーが無いときは、ユーザーに登録を依頼する (PjM → チーフ経由)。',
    );
  }
  if (opts.inProject || opts.isChief) {
    const p = opts.isChief ? ' project="slug"' : '';
    lines.push(
      '- ボード (プロジェクトの共有掲示板。全員が毎回の発言の前に読む) に書く:',
      `  <board kind="fact"${p}>ユーザーから共有された情報・前提・資料の場所</board>`,
      `  <board kind="decision"${p}>決まったこと (誰が決めたか)</board>`,
      `  <board kind="question"${p} owner="回答する担当" due="2d">誰かの回答・判断を待っていること</board>`,
      `  <board kind="task"${p} owner="担当" due="3d">やること (誰かが引き受けた仕事。1件につき担当は1人)</board>`,
      '  question と task には担当と期限が付く。owner はロール ID か user (ユーザーの回答待ち)。省くと自分が担当になる。',
      '  due は "36h" / "3d" / "2026-11-21" の形。省くと question は 2 日、task は 7 日。守れる期限を自分で決めて書く。',
      '  期限を過ぎると基盤が担当に催促し、片付かなければ PjM、チーフ、ユーザーの順に上がる。',
      `  <board-resolve id="B-12"${p}>解決した内容 / 古くなった理由</board-resolve> … 解決した質問、終わった仕事、古くなった項目をボードから下ろす。`,
      `  <board-due id="B-12"${p} due="2d">遅れている理由と、次に何をするか</board-due> … 期限を引き直す (理由が必須)。`,
      '  決まり: ユーザーから得た情報と決定は、聞いたその発言の中でボードに書く (メッセージで伝えるだけにしない)。',
      '  ボードにあることは、誰にも問い合わせない・繰り返し伝えない。ボードと食い違う話を聞いたら、古い項目を下ろして新しい項目を書く。',
      '  回答をもらった質問と、終わった仕事は、その発言の中で下ろす。',
    );
  }
  if (opts.inProject) {
    lines.push(
      '- <status>いま取り組んでいること / 次にやること / 待っているもの</status> … 発言の最後に1行で必ず書く (ボードの「メンバーの状況」に載る)。',
    );
  }
  if (opts.canReadRepos) {
    lines.push(
      '- リポジトリを読む (結果が返ってきてから続きを書ける。1回の出力に複数書いてよい):',
      '  <repo-list repo="リポジトリ名" path="src"/> … ディレクトリの一覧 (2階層まで)。path を省くとルート。',
      '  <repo-grep repo="リポジトリ名" pattern="正規表現" path="src"/> … 検索 (grep -E)。path は省略可。',
      '  <repo-read repo="リポジトリ名" path="src/x.ts" from="1" lines="200"/> … ファイルを読む (1回 400 行まで。from で続きを読む)。',
      '  まず一覧と検索で場所を絞ってから読む。推測でコードの内容を語らない。読んでいない箇所は「未確認」と書く。',
      '  読んだ内容は次のターンには残らない。分かったこと (ファイル名と行番号つき) は <artifact> に書き残す。',
    );
  }
  lines.push(
    '誰にも何も送る必要が無いときは、何も出力しないか「(対応不要)」とだけ書く。',
    'お礼・了解・受領の確認だけのメッセージは送らない (相手の1ターンを消費し、行き違いの元になる)。相手に判断か作業が要るときだけ送る。',
    '同じことを繰り返し伝えない。相手の成果物 (docs/ 以下) で確認できることは、問い合わせずに読んで確かめる。',
  );
  return lines.join('\n');
}

/** 振り返りで使う追加タグの説明 */
export const RETRO_GUIDE = [
  '## 振り返りの手順 (この順に考える)',
  '1. 前回の改善アクションの結果を確認する (達成 / 未達 / 判定不能)。',
  '2. 未達のものは原因を1つ特定する。連続未達が2回以上なら、アクションではなくルールか ADR で対処する。',
  '3. 悪化した指標を確認し、担当分には対応アクションを出す (許容するなら理由を数字で書く)。',
  '4. 未計測の必要指標があれば、計測できるようにするアクションを最優先で出す。',
  '5. 次のアクションを決める (担当ロールごとに最大2件、1週間で結果が測れる大きさ)。',
  '6. 再発防止が要るものをルールにする。効果が確認できないルールは廃止する。',
  '## 振り返りの出力',
  '- <improvement owner="担当ロールID" metric="指標キー" target="目標値">実行する改善アクション</improvement>',
  '  metric は上の指標表にあるキーを使う。target は来週の計測値の目標 (数値のみ)。',
  '- <rule scope="project|client|common">行動ルール (その層の全ロールが今後従う1文)</rule>',
  '  scope: project = このプロジェクトだけ / client = このクライアントの全プロジェクト / common = kobun の全プロジェクト。',
  '  このプロジェクトの性質に固有の事情は project に、クライアントの事情は client に書く。',
  '  common と client は他のプロジェクトにも効くので、数字の根拠がこのプロジェクトに限られない場合だけ使う。',
  '  common と client の変更 (追加・置換・廃止) は、ユーザーが承認するまで適用されない。project は即時に適用される。',
  '- <rule scope="..." replaces="ルールID">書き直したルール</rule> … 既存ルールを置き換える。',
  '- <rule-retire id="ルールID">廃止する理由</rule-retire> … 役に立っていない、または害のあるルールを廃止する。',
  '- <adr title="タイトル">背景 / 決定 / 影響</adr>',
  '- <proposal saving="月額削減見込みUSD">コスト削減提案 (ユーザーに届く)</proposal>',
  '- <feedback-request>ユーザーに確認したいこと (ユーザーに届く)</feedback-request>',
  '定性的な感想は書かない。根拠は指標表の数字で示す。',
].join('\n');
