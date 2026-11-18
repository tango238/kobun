import readline from 'node:readline';
import { LineEditor, TERMINAL_DISABLE } from './line-editor';

// チーフとの対話コマンド。
//   cd worker && npm run chief
// 入力した行をチーフに送り、フィードに届いたもの (チーフの発言・アラート・改善レポート・依頼) を
// 届いた順に表示する。接続先は KOBUN_API (既定 http://localhost:3000)。

const API = (process.env.KOBUN_API ?? 'http://localhost:3000').replace(/\/$/, '');
const POLL_MS = 2000;
// 標準入力がパイプのとき、入力が尽きてから返事を待つ秒数
const PIPE_WAIT_SEC = Number(process.env.KOBUN_WAIT ?? 90);

interface FeedItem {
  id: string;
  project: string | null;
  source: string;
  kind: string;
  title: string;
  body: string;
}

const tty = Boolean(process.stdout.isTTY);
const paint = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => paint('2', s);
const bold = (s: string) => paint('1', s);

const KIND_LABEL: Record<string, string> = {
  alert: 'アラート',
  report: '改善レポート',
  request: '依頼',
  message: 'メッセージ',
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init);
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error ?? `HTTP ${res.status}`);
  }
  return data as T;
}

const post = <T>(path: string, body?: unknown) =>
  api<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function feedAfter(id: number): Promise<FeedItem[]> {
  const out: FeedItem[] = [];
  for (let after = id; ; ) {
    const { items } = await api<{ items: FeedItem[] }>(`/feed?after=${after}`);
    out.push(...items);
    if (items.length < 200) return out;
    after = Number(items[items.length - 1].id);
  }
}

function format(item: FeedItem): string {
  if (item.source === 'chief' && item.kind === 'message') {
    return `${bold('チーフ>')} ${item.body}`;
  }
  const where = item.project ? ` / ${item.project}` : '';
  const head = `[${KIND_LABEL[item.kind] ?? item.kind}${where}] ${item.title} ${dim(`(${item.source})`)}`;
  return `${bold(head)}\n${item.body}`;
}

interface Team {
  project: string;
  running: boolean;
  current: { role: string; from: string; since: number } | null;
  working?: { role: string; from: string; since: number }[];
  queue: { from: string; to: string; content: string }[];
  members: {
    role: string;
    title: string;
    model: string;
    turns: number;
    errors: number;
    working: { from: string; since: number } | null;
    waiting: number;
    last: {
      at: string;
      from: string;
      request: string;
      durationSec: number;
      error: string | null;
      sentTo: string[];
      artifacts: string[];
      said: string;
    } | null;
  }[];
}

function ago(ms: number): string {
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 90) return `${sec} 秒`;
  if (sec < 5400) return `${Math.round(sec / 60)} 分`;
  if (sec < 172800) return `${Math.round(sec / 3600)} 時間`;
  return `${Math.round(sec / 86400)} 日`;
}

function formatTeam(t: Team): string {
  const lines: string[] = [bold(`チーム: ${t.project}`)];
  if (!t.running) {
    lines.push('プロジェクトの Workflow が動いていません (停止中)。');
  } else if ((t.working ?? []).length > 0) {
    lines.push(
      `いま動いているのは ${t.working!.map((w) => `${bold(w.role)} (${ago(w.since)}前から)`).join('、')}。未読のメッセージ ${t.queue.length} 件。`,
    );
  } else {
    lines.push(
      t.queue.length === 0
        ? 'いま動いているメンバーはいません (全員、次のメッセージ待ち)。'
        : `未読のメッセージ ${t.queue.length} 件。`,
    );
  }
  lines.push('');
  for (const m of t.members) {
    const state = m.working
      ? paint('32', `● 対応中 (${ago(m.working.since)})`)
      : m.waiting > 0
        ? paint('33', `◐ 未読 ${m.waiting} 件`)
        : m.turns === 0
          ? dim('○ まだ出番なし')
          : dim('○ 待機');
    lines.push(
      `${bold(m.title)} ${dim(`[${m.role} / ${m.model}]`)}  ${state}  発言 ${m.turns} 回${m.errors > 0 ? ` / 失敗 ${m.errors} 回` : ''}`,
    );
    if (m.last) {
      const when = `${ago(new Date(m.last.at).getTime())}前`;
      lines.push(dim(`    最後の依頼 (${when}、${m.last.from} から): ${m.last.request}`));
      if (m.last.error) {
        lines.push(`    応答できず: ${m.last.error.slice(0, 160)}`);
      } else {
        const did = [
          m.last.sentTo.length > 0 ? `${m.last.sentTo.join('、')} に送信` : '',
          m.last.artifacts.length > 0 ? `成果物 ${m.last.artifacts.join('、')}` : '',
        ]
          .filter(Boolean)
          .join(' / ');
        lines.push(dim(`    結果 (${m.last.durationSec} 秒): ${did || '送信なし'}${m.last.said ? ` — ${m.last.said}` : ''}`));
      }
    }
  }
  if (t.queue.length > 0) {
    lines.push('', bold('未読のメッセージ (次の発言でまとめて処理される)'));
    for (const q of t.queue) lines.push(`  ${q.from} → ${q.to}: ${q.content}`);
  }
  return lines.join('\n');
}

const HELP = [
  '入力した行はチーフに送られます。返事は届き次第ここに表示されます。',
  '  /projects        プロジェクトの一覧',
  '  /board [プロジェクト]                         ボード (共有された情報・決定事項・未解決の質問・メンバーの状況)',
  '  /note <プロジェクト> <内容>                   ボードに情報を直接書く (チーム全員が次の発言から読む)',
  '  /done <プロジェクト> <B-番号> [理由]          ボードの項目を解決済みにして下ろす',
  '  /team [プロジェクト]                          チームのメンバーと、いま何をしているか',
  '  /repos <プロジェクト>                         登録済みのリポジトリ',
  '  /repo <プロジェクト> <名前> <URLかパス> [説明]   リポジトリを登録する (同じ名前は上書き)',
  '  /pending         判断待ちの一覧 (期限を過ぎた仕事・保留中の実装タスク・承認待ちのルール変更)',
  '  /parked          保留中の実装タスク (質問への回答が 3 時間なかったもの)',
  '  /resume <番号> <回答>   保留中の実装タスクに回答して、実装から再開する',
  '  /drop <番号> [理由]     保留中の実装タスクを取り下げる',
  '  /patrol          巡回を今すぐ1回回す (期限切れの催促と、チーフへの判断待ち一覧)',
  '  /proposals       承認待ちのルール変更',
  '  /approve <番号>  ルール変更を承認して適用する',
  '  /reject <番号>   ルール変更を却下する',
  '  /history         これまでにフィードへ届いたものを全部表示する',
  '  /help            この説明',
  '  /quit            終了 (入力欄が空のとき Ctrl-C / Ctrl-D でも可)',
  '',
  'Enter で送信。Shift+Enter (または Alt+Enter、Ctrl+J) で改行。貼り付けた文章は送信されず入力欄に入ります。',
].join('\n');

interface Parked {
  id: number;
  request: string;
  questions: string[];
  createdAt: string;
}

/** 期限までの残り / 超過 */
function dueText(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const h = Math.abs(ms) / 3_600_000;
  const span = h < 48 ? `${Math.max(1, Math.round(h))}時間` : `${Math.round(h / 24)}日`;
  return ms >= 0 ? `期限 あと${span}` : `期限切れ ${span}超過`;
}

function formatParked(p: Parked): string {
  return [
    `- #${p.id} ${p.request.replace(/\s+/g, ' ').slice(0, 160)} ${dim(`(${new Date(p.createdAt).toLocaleString('ja-JP')} に保留)`)}`,
    ...p.questions.map((q, i) => dim(`    ${i + 1}. ${q}`)),
  ].join('\n');
}

async function command(line: string): Promise<string> {
  const [cmd, arg, ...rest] = line.split(/\s+/);
  switch (cmd) {
    case '/help':
      return HELP;
    case '/projects': {
      const { projects } = await api<{
        projects: { slug: string; name: string; client: string }[];
      }>('/projects');
      return projects.length === 0
        ? '(プロジェクトはまだありません)'
        : projects.map((p) => `- ${p.slug}: ${p.name} (クライアント ${p.client || '未設定'})`).join('\n');
    }
    case '/board': {
      let slug = arg;
      if (!slug) {
        const { projects } = await api<{ projects: { slug: string; name: string }[] }>('/projects');
        if (projects.length === 0) return '(プロジェクトはまだありません)';
        if (projects.length > 1) {
          return `プロジェクトを指定してください: /board <slug>\n${projects.map((p) => `- ${p.slug}: ${p.name}`).join('\n')}`;
        }
        slug = projects[0].slug;
      }
      const b = await api<{ text: string }>(`/projects/${encodeURIComponent(slug)}/board`);
      return `${bold(`ボード: ${slug}`)}\n${b.text}`;
    }
    case '/note': {
      // 内容は改行を含んでよいので、行全体から取り出す
      const text = line.replace(/^\/note\s+\S+\s*/, '');
      if (!arg || !text.trim()) return '使い方: /note <プロジェクトの slug> <内容>';
      const r = await post<{ code: string }>(`/projects/${encodeURIComponent(arg)}/board`, {
        kind: 'fact',
        text,
      });
      return `${arg} のボードに ${r.code} として書きました。チームは次の発言から読みます。`;
    }
    case '/done': {
      const [code, ...why] = rest;
      if (!arg || !code) return '使い方: /done <プロジェクトの slug> <B-番号> [理由]';
      await post(`/projects/${encodeURIComponent(arg)}/board/${encodeURIComponent(code)}/resolve`, {
        reason: why.join(' '),
      });
      return `${code} を解決済みにしました。`;
    }
    case '/team': {
      let slug = arg;
      if (!slug) {
        const { projects } = await api<{ projects: { slug: string; name: string }[] }>('/projects');
        if (projects.length === 0) return '(プロジェクトはまだありません)';
        if (projects.length > 1) {
          return `プロジェクトを指定してください: /team <slug>\n${projects.map((p) => `- ${p.slug}: ${p.name}`).join('\n')}`;
        }
        slug = projects[0].slug;
      }
      return formatTeam(await api<Team>(`/projects/${encodeURIComponent(slug)}/team`));
    }
    case '/repos': {
      if (!arg) return '使い方: /repos <プロジェクトの slug>';
      const { repositories } = await api<{
        repositories: { name: string; url: string; description: string }[];
      }>(`/projects/${encodeURIComponent(arg)}/repositories`);
      return repositories.length === 0
        ? `(${arg} にリポジトリは登録されていません)`
        : repositories
            .map((r) => `- ${r.name}: ${r.url}${r.description ? ` — ${r.description}` : ''}`)
            .join('\n');
    }
    case '/repo': {
      const [name, url, ...desc] = rest;
      if (!arg || !name || !url) {
        return '使い方: /repo <プロジェクトの slug> <名前> <URL かパス> [説明]\n例: /repo billing backend https://github.com/owner/repo API サーバー';
      }
      await api(`/projects/${encodeURIComponent(arg)}/repositories/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, description: desc.join(' ') }),
      });
      return `${arg} にリポジトリ ${name} (${url}) を登録しました。チーフに「登録した」と伝えてください。`;
    }
    case '/proposals': {
      const { proposals } = await api<{
        proposals: {
          id: string;
          project: string;
          scope: string;
          kind: string;
          target_code: string | null;
          text: string;
          reason: string;
          due_at?: string;
        }[];
      }>('/rule-proposals');
      return proposals.length === 0
        ? '(承認待ちのルール変更はありません)'
        : proposals
            .map(
              (p) =>
                `- #${p.id} [${p.scope} / ${p.kind}${p.target_code ? ` ${p.target_code}` : ''}] ${p.text || `廃止の理由: ${p.reason || '記載なし'}`} ${dim(`(${p.project}${p.due_at ? `、${dueText(p.due_at)}` : ''})`)}`,
            )
            .join('\n');
    }
    case '/approve':
    case '/reject': {
      if (!arg || !/^\d+$/.test(arg)) return `使い方: ${cmd} <番号>`;
      const r = await post<{
        status: string;
        change: { layer: string; op: string; code: string; text: string } | null;
      }>(`/rule-proposals/${arg}/${cmd.slice(1)}`);
      return r.change
        ? `#${arg} を承認しました: ${r.change.layer} / ${r.change.op} / ${r.change.code} — ${r.change.text}`
        : `#${arg} を却下しました (何も適用していません)`;
    }
    case '/parked': {
      const { parked } = await api<{ parked: Parked[] }>('/parked');
      return parked.length === 0 ? '(保留中の実装タスクはありません)' : parked.map(formatParked).join('\n');
    }
    case '/resume': {
      const text = line.replace(/^\/resume\s+\S+\s*/, '');
      if (!arg || !/^\d+$/.test(arg) || !text.trim()) return '使い方: /resume <番号> <回答>';
      await post(`/parked/${arg}/answer`, { text });
      return `#${arg} を再開しました。質問はやり直さず、実装から始めます。`;
    }
    case '/drop': {
      if (!arg || !/^\d+$/.test(arg)) return '使い方: /drop <番号> [理由]';
      await post(`/parked/${arg}/drop`, { reason: rest.join(' ') });
      return `#${arg} を取り下げました。`;
    }
    case '/pending': {
      const p = await api<{
        overdue: { project: string; code: string; kind: string; text: string; owner: string; dueAt: string; escalation: number }[];
        parked: Parked[];
        proposals: { id: number; project: string; scope: string; kind: string; targetCode: string | null; text: string; reason: string; dueAt: string }[];
      }>('/pending');
      const stage = ['催促前', '担当に催促済み', 'PjM とチーフに通知済み', 'ユーザーに通知済み'];
      return [
        bold(`期限を過ぎた仕事 (${p.overdue.length} 件)`),
        ...(p.overdue.length === 0
          ? ['(なし)']
          : p.overdue.map(
              (o) =>
                `- ${o.project} ${o.code} [${o.kind === 'task' ? 'やること' : '質問'}] ${o.text.replace(/\s+/g, ' ').slice(0, 120)} ${dim(`(担当 ${o.owner || '-'}、${dueText(o.dueAt)}、${stage[o.escalation] ?? ''})`)}`,
            )),
        '',
        bold(`保留中の実装タスク (${p.parked.length} 件)`),
        ...(p.parked.length === 0 ? ['(なし)'] : p.parked.map(formatParked)),
        '',
        bold(`承認待ちのルール変更 (${p.proposals.length} 件)`),
        ...(p.proposals.length === 0
          ? ['(なし)']
          : p.proposals.map(
              (x) =>
                `- #${x.id} [${x.scope} / ${x.kind}${x.targetCode ? ` ${x.targetCode}` : ''}] ${(x.text || `廃止の理由: ${x.reason || '記載なし'}`).slice(0, 120)} ${dim(`(${x.project}、${dueText(x.dueAt)})`)}`,
            )),
      ].join('\n');
    }
    case '/patrol': {
      const r = await post<{ nudges: number; undelivered: number; chief: string; surfaced: number; overdue: number }>(
        '/patrol/run',
      );
      return `巡回しました: 期限切れ ${r.overdue} 件 / 催促 ${r.nudges} 件${r.undelivered ? ` (うち未達 ${r.undelivered} 件)` : ''} / ユーザーへの通知 ${r.surfaced} 件 / チーフへの一覧 ${r.chief === 'none' ? 'なし (新しい判断待ちはありません)' : r.chief === 'sent' ? '送信' : 'チーフ停止中のためフィードに掲載'}`;
    }
    default:
      return `知らないコマンドです: ${cmd} (/help で一覧)`;
  }
}

async function main(): Promise<void> {
  let lastId = 0;
  try {
    const existing = await feedAfter(0);
    if (existing.length > 0) lastId = Number(existing[existing.length - 1].id);
    console.log(
      dim(
        `kobun に接続しました (${API})。${existing.length > 0 ? `これまでの ${existing.length} 件は /history で見られます。` : ''}/help で使い方。`,
      ),
    );
  } catch (err) {
    console.error(
      `kobun の API (${API}) に接続できません: ${err instanceof Error ? err.message : err}\n` +
        '`docker compose up -d` で起動しているか確認してください。接続先は KOBUN_API で変えられます。',
    );
    process.exit(1);
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let finish: () => void = () => undefined;

  // 端末では複数行エディタを使う (貼り付けは送信されず、Shift+Enter で改行できる)。
  // パイプ入力のときは、1行 = 1メッセージとして readline で読む
  const editor = interactive
    ? new LineEditor({
        input: process.stdin,
        output: process.stdout,
        decorate: bold,
        onSubmit: (text) => {
          queue = queue.then(() => handle(text));
        },
        onExit: () => finish(),
      })
    : null;
  const rl = interactive
    ? null
    : readline.createInterface({ input: process.stdin, terminal: false });

  // 入力途中の内容を壊さずに、届いたものを表示する
  const show = (text: string) => {
    if (editor) editor.print(text);
    else console.log(`${text}\n`);
  };

  let waiting = 0; // チーフに送って、まだ何も届いていないメッセージの数
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const items = await feedAfter(lastId);
      for (const item of items) {
        lastId = Number(item.id);
        show(format(item));
      }
      if (items.length > 0) waiting = 0;
    } catch {
      // 一時的に届かないだけなら、次の周期で取り直す
    } finally {
      polling = false;
    }
  };
  const timer = setInterval(poll, POLL_MS);

  // 入力は1行ずつ順に処理する (パイプで複数行が一度に来ても順序を保つ)
  let queue: Promise<void> = Promise.resolve();
  const handle = async (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    if (line === '/quit' || line === '/exit') {
      finish();
      return;
    }
    try {
      if (line === '/history') {
        const all = await feedAfter(0);
        show(all.length === 0 ? '(まだ何も届いていません)' : all.map(format).join('\n\n'));
      } else if (line.startsWith('/')) {
        show(await command(line));
      } else {
        await post('/chief/messages', { text: line });
        waiting += 1;
        show(dim('(送信しました。チーフの返事を待っています…)'));
      }
    } catch (err) {
      show(`エラー: ${err instanceof Error ? err.message : err}`);
    }
  };
  finish = () => {
    clearInterval(timer);
    editor?.stop();
    process.exit(0);
  };

  if (editor) {
    console.log(dim('Enter で送信 / Shift+Enter (または Alt+Enter、Ctrl+J) で改行 / 貼り付けは送信されません'));
    // 異常終了しても端末の設定を元に戻す
    process.on('exit', () => process.stdout.write(TERMINAL_DISABLE));
    editor.start();
    return;
  }

  rl!.on('line', (raw) => {
    queue = queue.then(() => handle(raw));
  });
  rl!.on('close', async () => {
    await queue;
    // パイプ入力のときは、送った分の返事が届くまで待ってから終わる
    if (waiting > 0) {
      const deadline = Date.now() + PIPE_WAIT_SEC * 1000;
      while (waiting > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        await poll();
      }
      if (waiting > 0) {
        console.log(dim(`(${PIPE_WAIT_SEC} 秒待ちましたが、返事は届いていません)`));
      }
    }
    finish();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
