import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pool, ensureSchema } from './db';
import {
  AuthError,
  COLLECTORS,
  COMMAND_SECRET_ERROR,
  MissingSecretError,
  hasSecretRef,
  resolveSecrets,
  type Sample,
} from './metrics/collectors';

// クレデンシャルブローカー: API キーなどのシークレットを預かり、データ取得を代行する別サービス。
//
// - ユーザーはシークレットをこのサービスに直接渡す (チーフや api を経由しない)。
// - 値を返す API は無い。登録・一覧 (名前のみ)・削除だけができる。
// - データソースの設定にある {{secret:名前}} を取得の瞬間に差し込み、コレクタを実行して、
//   数字だけを worker に返す。worker (エージェント)・api・サンドボックスはシークレットの値に触れない。
// - 値はこのサービスだけが持つ鍵で暗号化して保存する (worker が DB を読んでも復号できない)。
//
// egress がサンドボックスに対してやっていること (プレースホルダーを通信の瞬間に本物へ差し替える)
// と同じ考え方を、数字の取得に適用したもの。

const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://sandbox:7000';
const DATA_DIR = process.env.BROKER_DATA_DIR ?? '/data';

function loadKey(): Buffer {
  if (process.env.BROKER_KEY) {
    return crypto.createHash('sha256').update(process.env.BROKER_KEY).digest();
  }
  const file = path.join(DATA_DIR, 'broker.key');
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  mkdirSync(DATA_DIR, { recursive: true });
  const key = crypto.randomBytes(32);
  writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}
const KEY = loadKey();

export function encrypt(plain: string, key: Buffer = KEY): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload: string, key: Buffer = KEY): string {
  const [iv, tag, body] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

async function loadSecrets(project: string): Promise<Record<string, string>> {
  const res = await pool.query(
    'SELECT name, ciphertext FROM secrets WHERE project_slug = $1',
    [project],
  );
  const out: Record<string, string> = {};
  for (const r of res.rows) out[r.name] = decrypt(r.ciphertext);
  return out;
}

export interface CollectOutcome {
  name: string;
  kind: string;
  ok: boolean;
  samples: Sample[];
  /** auth: 認証切れ / secret: シークレット未登録 / error: その他 */
  failure?: 'auth' | 'secret' | 'error';
  error?: string;
}

/** エラーメッセージにシークレットの値が混ざっていたら伏せる */
function scrub(message: string, secrets: Record<string, string>): string {
  let out = message;
  for (const v of Object.values(secrets)) {
    if (v.length >= 4) out = out.split(v).join('***');
  }
  return out;
}

async function collect(
  project: string,
  filter: { names?: string[]; kinds?: string[] },
): Promise<CollectOutcome[]> {
  await ensureSchema();
  const conns = await pool.query(
    'SELECT name, kind, config FROM connections WHERE project_slug = $1 ORDER BY name',
    [project],
  );
  const repos = await pool.query(
    'SELECT name, url, description FROM repositories WHERE project_slug = $1 ORDER BY name',
    [project],
  );
  const secrets = await loadSecrets(project);
  const out: CollectOutcome[] = [];
  for (const row of conns.rows) {
    if (filter.names && !filter.names.includes(row.name)) continue;
    if (filter.kinds && !filter.kinds.includes(row.kind)) continue;
    const base = { name: String(row.name), kind: String(row.kind) };
    const collector = COLLECTORS[row.kind];
    if (!collector) {
      out.push({ ...base, ok: false, samples: [], failure: 'error', error: `未対応の種類です: ${row.kind}` });
      continue;
    }
    try {
      // サンドボックスで実行される command には、シークレットを差し込まない
      if (row.kind === 'command' && hasSecretRef(row.config)) {
        throw new Error(COMMAND_SECRET_ERROR);
      }
      const config = resolveSecrets(row.config, secrets);
      const samples = await collector(config, {
        sandboxUrl: SANDBOX_URL,
        repositories: repos.rows,
      });
      out.push({ ...base, ok: true, samples });
    } catch (err) {
      const failure =
        err instanceof MissingSecretError ? 'secret' : err instanceof AuthError ? 'auth' : 'error';
      out.push({
        ...base,
        ok: false,
        samples: [],
        failure,
        error: scrub(err instanceof Error ? err.message : String(err), secrets),
      });
    }
  }
  return out;
}

const app = new Hono();

// シークレットを登録・更新する (ユーザーが外部から直接呼ぶ)。値は二度と読み出せない
app.put('/secrets/:project/:name', async (c) => {
  await ensureSchema();
  const name = c.req.param('name');
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
    return c.json({ error: 'name は英数字と _ . - のみ' }, 400);
  }
  const body = await c.req.json<{ value?: string }>().catch(() => ({ value: undefined }));
  if (typeof body.value !== 'string' || body.value === '') {
    return c.json({ error: 'value is required' }, 400);
  }
  await pool.query(
    `INSERT INTO secrets (project_slug, name, ciphertext) VALUES ($1, $2, $3)
     ON CONFLICT (project_slug, name) DO UPDATE
       SET ciphertext = EXCLUDED.ciphertext, updated_at = now()`,
    [c.req.param('project'), name, encrypt(body.value)],
  );
  // このシークレット待ち・認証切れだったデータソースを、次の取得で再試行させる
  await pool.query(
    `UPDATE connections SET status = 'unverified', last_error = NULL
     WHERE project_slug = $1 AND status IN ('needs_secret', 'needs_reauth')`,
    [c.req.param('project')],
  );
  return c.json({ ok: true, name });
});

// 登録済みシークレットの名前と更新日時 (値は返さない)
app.get('/secrets/:project', async (c) => {
  await ensureSchema();
  const res = await pool.query(
    'SELECT name, updated_at FROM secrets WHERE project_slug = $1 ORDER BY name',
    [c.req.param('project')],
  );
  return c.json({ secrets: res.rows });
});

app.delete('/secrets/:project/:name', async (c) => {
  await ensureSchema();
  await pool.query('DELETE FROM secrets WHERE project_slug = $1 AND name = $2', [
    c.req.param('project'),
    c.req.param('name'),
  ]);
  return c.json({ ok: true });
});

// データソースから数字を取得する (worker が呼ぶ)。返すのは数字とエラーの種類だけ
app.post('/collect', async (c) => {
  const body = await c.req.json<{ project: string; names?: string[]; kinds?: string[] }>();
  if (!body.project) return c.json({ error: 'project is required' }, 400);
  return c.json({ results: await collect(body.project, body) });
});

app.get('/health', (c) => c.json({ ok: true }));

if (require.main === module) {
  serve({ fetch: app.fetch, port: 3100 });
  console.log('kobun credential broker listening on :3100');
}
