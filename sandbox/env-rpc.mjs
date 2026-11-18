// Pi の ExecutionEnv をサンドボックスの中で動かし、HTTP で公開する (worker の SandboxExecutionEnv が使う)。
//
// 実体は Pi の NodeExecutionEnv。ファイル操作・コマンド実行・監視の意味は、Pi の適合性テストが通る実装そのもの。
// このデーモンは、引数と結果を JSON に直して中継するだけ。
//   POST /env/call     1回で終わる操作 (ファイル操作、リーダーを開く)
//   POST /env/handle   開いてあるリーダー (BinaryReader / TextLineReader / DirReader) の操作
//   POST /env/exec     コマンド実行。出力を NDJSON で流す
//   POST /env/watch    ファイル監視。変更を NDJSON で流す
//   POST /env/abort    実行中の exec / watch を止める
//   POST /env/cleanup  あるクライアントの実行中のコマンドをすべて止める
//
// 値の変換: Uint8Array は { __b64: "..." }。失敗は { ok: false, error: { name, code, message, path?, spillPath? } }。
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context';
import { randomUUID } from 'node:crypto';

const DEFAULT_CWD = '/workspace';
const MAX_HANDLES = 256;
const HANDLE_IDLE_MS = 10 * 60_000;

// 1回で終わる操作 (許可するメソッド)。cwd は env ごとに渡される
const CALLS = new Set([
  'absolutePath', 'joinPath', 'readTextFile', 'readTextLines', 'readBinaryFile',
  'writeFile', 'appendFile', 'truncateFile', 'flushFile', 'renameFile',
  'fileInfo', 'listDir', 'canonicalPath', 'exists', 'createDir', 'remove',
  'createTempDir', 'createTempFile',
]);
const OPENERS = new Set(['openBinaryReader', 'openTextLineReader', 'openDirReader']);
const HANDLE_METHODS = new Set(['info', 'read', 'scanLines', 'readLine', 'next', 'close']);

// ---- 値の変換 ----
export function decodeValue(v) {
  if (Array.isArray(v)) return v.map(decodeValue);
  if (v && typeof v === 'object') {
    if (typeof v.__b64 === 'string') return new Uint8Array(Buffer.from(v.__b64, 'base64'));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decodeValue(x)]));
  }
  return v;
}
// 引数の undefined は JSON で null になる。Pi の実装は undefined を前提にしているので戻す
function decodeArgs(args) {
  return decodeValue(args ?? []).map((a) => (a === null ? undefined : a));
}
export function encodeValue(v) {
  if (v instanceof Uint8Array) return { __b64: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(encodeValue);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeValue(x)]));
  }
  return v;
}
export function encodeError(e) {
  return {
    name: e?.name ?? 'Error',
    code: e?.code ?? 'unknown',
    message: String(e?.message ?? e),
    ...(e?.path !== undefined ? { path: e.path } : {}),
    ...(e?.spillPath !== undefined ? { spillPath: e.spillPath } : {}),
  };
}
function encodeResult(r) {
  return r.ok ? { ok: true, value: encodeValue(r.value) } : { ok: false, error: encodeError(r.error) };
}
const invalid = (message) => ({ ok: false, error: { name: 'FileError', code: 'invalid', message } });

// ---- 状態 ----
const handles = new Map(); // id -> { target, kind, lastUsed }
const running = new Map(); // id -> { stop: async () => void, client }

setInterval(() => {
  const now = Date.now();
  for (const [id, h] of handles) {
    if (now - h.lastUsed > HANDLE_IDLE_MS) {
      handles.delete(id);
      h.target.close(BACKGROUND_CONTEXT).catch(() => undefined);
    }
  }
}, 60_000).unref();

const envFor = (cwd) => new NodeExecutionEnv({ cwd: cwd || DEFAULT_CWD });

/** リクエストの接続が切れたら中断する Context */
function connectionContext(req, res) {
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  return { controller, context: withAbortSignal(controller.signal, BACKGROUND_CONTEXT) };
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function startStream(res) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' });
  res.flushHeaders?.();
  return (obj) => {
    if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify(obj)}\n`);
  };
}

// ---- 各エンドポイント ----
async function call(req, res, data) {
  const { context } = connectionContext(req, res);
  const env = envFor(data.cwd);
  const args = decodeArgs(data.args);
  if (CALLS.has(data.method)) {
    const result = await env[data.method](...args, context);
    return sendJson(res, 200, encodeResult(result));
  }
  if (OPENERS.has(data.method)) {
    const result = await env[data.method](...args, context);
    if (!result.ok) return sendJson(res, 200, encodeResult(result));
    if (handles.size >= MAX_HANDLES) {
      await result.value.close(BACKGROUND_CONTEXT).catch(() => undefined);
      return sendJson(res, 200, invalid('開いているリーダーが多すぎます'));
    }
    const id = randomUUID();
    handles.set(id, { target: result.value, lastUsed: Date.now() });
    return sendJson(res, 200, { ok: true, value: { handle: id } });
  }
  return sendJson(res, 400, { error: `unsupported method: ${data.method}` });
}

async function handle(req, res, data) {
  if (!HANDLE_METHODS.has(data.method)) return sendJson(res, 400, { error: 'unsupported' });
  const h = handles.get(data.handle);
  if (data.method === 'close') {
    if (h) {
      handles.delete(data.handle);
      await h.target.close(BACKGROUND_CONTEXT).catch(() => undefined);
    }
    return sendJson(res, 200, { ok: true, value: null });
  }
  // 閉じたリーダーの使用は、Pi の実装と同じく invalid で返す
  if (!h || typeof h.target[data.method] !== 'function') {
    return sendJson(res, 200, invalid('reader is closed'));
  }
  h.lastUsed = Date.now();
  const { context } = connectionContext(req, res);
  const args = decodeArgs(data.args);
  const result = await h.target[data.method](...args, context);
  return sendJson(res, 200, encodeResult(result));
}

async function exec(req, res, data) {
  const write = startStream(res);
  const id = randomUUID();
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
  running.set(id, { stop: async () => controller.abort(), client: data.client ?? '' });
  write({ t: 'start', id });
  try {
    const env = envFor(data.cwd);
    const options = {
      ...(data.options ?? {}),
      onOutput: (text, _ctx, info) => write({ t: 'out', text, info }),
    };
    const result = await env.exec(decodeValue(data.command), options, context);
    write(result.ok ? { t: 'done', result: result.value } : { t: 'error', error: encodeError(result.error) });
  } catch (e) {
    write({ t: 'error', error: encodeError(e) });
  } finally {
    running.delete(id);
    res.end();
  }
}

async function watch(req, res, data) {
  const write = startStream(res);
  const id = randomUUID();
  const controller = new AbortController();
  const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
  let watcher;
  const stop = async () => {
    controller.abort();
    if (watcher) await watcher.close(BACKGROUND_CONTEXT).catch(() => undefined);
    watcher = undefined;
  };
  running.set(id, { stop, client: data.client ?? '' });
  res.on('close', () => {
    stop();
    running.delete(id);
  });
  try {
    const env = envFor(data.cwd);
    const result = await env.watch(
      decodeValue(data.targets),
      (change) => {
        write({
          t: 'change',
          change: change.error ? { error: encodeError(change.error) } : change,
        });
      },
      context,
    );
    if (!result.ok) {
      write({ t: 'error', error: encodeError(result.error) });
      running.delete(id);
      return res.end();
    }
    watcher = result.value;
    write({ t: 'ready', id, mode: watcher.mode });
  } catch (e) {
    write({ t: 'error', error: encodeError(e) });
    running.delete(id);
    res.end();
  }
}

async function abort(_req, res, data) {
  const r = running.get(data.id);
  if (r) {
    running.delete(data.id);
    await r.stop();
  }
  sendJson(res, 200, { ok: true });
}

async function cleanup(_req, res, data) {
  for (const [id, r] of [...running]) {
    if (r.client === data.client) {
      running.delete(id);
      await r.stop();
    }
  }
  sendJson(res, 200, { ok: true });
}

const ROUTES = {
  '/env/call': call,
  '/env/handle': handle,
  '/env/exec': exec,
  '/env/watch': watch,
  '/env/abort': abort,
  '/env/cleanup': cleanup,
};

/** server.mjs から呼ぶ。担当のパスなら true を返す */
export function handleEnvRequest(req, res) {
  const route = ROUTES[req.url ?? ''];
  if (!route || req.method !== 'POST') return false;
  readBody(req)
    .then((data) => route(req, res, data))
    .catch((e) => {
      if (!res.headersSent) sendJson(res, 500, { error: String(e) });
      else res.end();
    });
  return true;
}
