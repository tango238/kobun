// リポジトリの読み取り (一覧・検索・ファイル読み取り)。
//
// ホストのディレクトリが /repos に読み取り専用でマウントされている (docker-compose の REPOS_DIR)。
// エージェントはここを通してだけコードを読む。次を守る:
//   - /repos の外には出ない (.. とシンボリックリンクを解決してから確かめる)
//   - 資格情報が入っていそうなファイルは読ませない (.env、秘密鍵、.git の中身 など)
//   - 1回に返す量に上限を付ける
import { execFile } from 'node:child_process';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const REPOS_ROOT = '/repos';

const MAX_LIST = 300;
const MAX_READ_LINES = 400;
const MAX_READ_BYTES = 40_000;
const MAX_FILE_BYTES = 2_000_000;
const MAX_GREP_LINES = 120;
const MAX_LINE_CHARS = 300;

// 一覧と検索から外すディレクトリ (巨大か、読む意味が無いもの)
export const SKIP_DIRS = [
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'target',
  '.venv',
  '__pycache__',
  '.gradle',
  'Pods',
];

// 中に資格情報があることが多いディレクトリ (読み取りも拒否する)
const SECRET_DIRS = new Set(['.git', '.ssh', '.aws', '.gnupg', '.kube', '.docker']);
const ENV_EXAMPLE = /^\.env\.(example|sample|template|dist|defaults)$/i;
const SECRET_FILES = [
  /^\.env($|\.)/i,
  /^\.envrc$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.(npmrc|netrc|pypirc|htpasswd)$/i,
  /^(credentials|secrets?)(\.|$)/i,
  /service[-_]?account.*\.json$/i,
  /^terraform\.tfstate/i,
  /\.tfvars$/i,
];

/** 資格情報が入っていそうなパスか (リポジトリのルートからの相対パス) */
export function isSecretPath(rel) {
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((p) => SECRET_DIRS.has(p))) return true;
  const base = parts[parts.length - 1] ?? '';
  if (ENV_EXAMPLE.test(base)) return false;
  return SECRET_FILES.some((re) => re.test(base));
}

class RepoError extends Error {}

/** root (リポジトリのルート) と相対パスから、/repos の中にある実パスを得る */
async function resolveInside(root, rel = '.') {
  const base = path.resolve(root);
  if (base !== REPOS_ROOT && !base.startsWith(`${REPOS_ROOT}/`)) {
    throw new RepoError('このリポジトリは読み取り用にマウントされていません');
  }
  let realBase;
  try {
    realBase = await realpath(base);
  } catch {
    throw new RepoError('リポジトリのディレクトリが見つかりません (マウントの範囲外か、パスが違います)');
  }
  const target = path.resolve(realBase, rel);
  if (target !== realBase && !target.startsWith(`${realBase}/`)) {
    throw new RepoError('リポジトリの外は読めません');
  }
  let real;
  try {
    real = await realpath(target);
  } catch {
    throw new RepoError(`見つかりません: ${rel}`);
  }
  // シンボリックリンクの先がリポジトリの外なら拒否する
  if (real !== realBase && !real.startsWith(`${realBase}/`)) {
    throw new RepoError('リポジトリの外を指すリンクは読めません');
  }
  const inside = path.relative(realBase, real);
  if (isSecretPath(inside)) {
    throw new RepoError(`読み取りを拒否しました (資格情報を含みうるファイル): ${rel}`);
  }
  return { realBase, real, inside };
}

async function list(root, rel) {
  const { realBase, real } = await resolveInside(root, rel);
  const st = await stat(real);
  if (!st.isDirectory()) throw new RepoError(`ディレクトリではありません: ${rel}`);
  const out = [];
  let truncated = false;
  // 幅優先で2階層まで
  const queue = [{ dir: real, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    const items = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const item of items) {
      const full = path.join(dir, item.name);
      const inside = path.relative(realBase, full);
      if (isSecretPath(inside)) continue;
      if (out.length >= MAX_LIST) {
        truncated = true;
        break;
      }
      if (item.isDirectory()) {
        const skipped = SKIP_DIRS.includes(item.name);
        out.push(`${inside}/${skipped ? '  (中身は省略)' : ''}`);
        if (!skipped && depth < 1) queue.push({ dir: full, depth: depth + 1 });
      } else if (item.isFile()) {
        out.push(inside);
      }
    }
    if (truncated) break;
  }
  return { text: out.sort().join('\n') || '(空です)', truncated };
}

async function read(root, rel, from, lines) {
  const { real } = await resolveInside(root, rel);
  const st = await stat(real);
  if (!st.isFile()) throw new RepoError(`ファイルではありません: ${rel}`);
  if (st.size > MAX_FILE_BYTES) {
    throw new RepoError(`大きすぎます (${st.size} バイト)。検索で場所を絞ってください`);
  }
  const buf = await readFile(real);
  if (buf.subarray(0, 8000).includes(0)) throw new RepoError(`バイナリファイルです: ${rel}`);
  const all = buf.toString('utf8').split('\n');
  const start = Math.max(1, Number(from) || 1);
  const count = Math.min(MAX_READ_LINES, Math.max(1, Number(lines) || MAX_READ_LINES));
  const picked = [];
  let bytes = 0;
  let i = start - 1;
  for (; i < all.length && picked.length < count; i++) {
    const line = `${String(i + 1).padStart(5)}  ${all[i]}`;
    bytes += line.length + 1;
    if (bytes > MAX_READ_BYTES) break;
    picked.push(line);
  }
  return {
    text: picked.join('\n'),
    totalLines: all.length,
    from: start,
    to: start + picked.length - 1,
    truncated: i < all.length,
  };
}

function grep(root, rel, pattern) {
  return resolveInside(root, rel).then(
    ({ realBase, real }) =>
      new Promise((resolve, reject) => {
        const args = [
          '-rnIE',
          '--max-count=20',
          ...SKIP_DIRS.map((d) => `--exclude-dir=${d}`),
          '--exclude=*.min.js',
          '--exclude=*.map',
          '--exclude=*.lock',
          '--exclude=package-lock.json',
          '-e',
          String(pattern),
          '--',
          real,
        ];
        execFile(
          'grep',
          args,
          { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout) => {
            // grep は一致なしで終了コード 1 を返す
            if (err && err.code !== 1 && !stdout) {
              reject(new RepoError(`検索に失敗しました: ${String(err.message).slice(0, 200)}`));
              return;
            }
            const lines = [];
            let truncated = false;
            for (const raw of stdout.split('\n')) {
              if (!raw) continue;
              const line = raw.startsWith(`${realBase}/`) ? raw.slice(realBase.length + 1) : raw;
              const file = line.split(':')[0];
              if (isSecretPath(file)) continue;
              if (lines.length >= MAX_GREP_LINES) {
                truncated = true;
                break;
              }
              lines.push(line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line);
            }
            resolve({ text: lines.join('\n') || '(一致なし)', matches: lines.length, truncated });
          },
        );
      }),
  );
}

/** デーモンから呼ぶ入口。失敗は { error } で返す (例外にしない) */
export async function repoOp(req) {
  try {
    if (req.op === 'list') return await list(req.root, req.path ?? '.');
    if (req.op === 'read') return await read(req.root, req.path ?? '', req.from, req.lines);
    if (req.op === 'grep') {
      if (!req.pattern) throw new RepoError('pattern が必要です');
      return await grep(req.root, req.path ?? '.', req.pattern);
    }
    if (req.op === 'check') {
      await resolveInside(req.root, '.');
      return { ok: true };
    }
    throw new RepoError(`未対応の操作です: ${req.op}`);
  } catch (err) {
    if (err instanceof RepoError) return { error: err.message };
    return { error: `読み取りに失敗しました: ${String(err?.message ?? err).slice(0, 200)}` };
  }
}
