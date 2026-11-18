// Pi Durable の ExecutionEnv を、kobun のサンドボックスデーモン越しに実装する。
//
// Sandbox-as-a-tool: ハーネス (worker) はサンドボックスの外にいて、
// read / write / edit / bash の実体だけがサンドボックス内で実行される。
//
// 実体は、サンドボックスの中で動く Pi の NodeExecutionEnv (sandbox/env-rpc.mjs)。
// ここは引数と結果を HTTP で中継するだけなので、ファイル操作・コマンド実行・監視の意味は
// Pi の適合性テスト (test/conformance.test.ts) が通る実装と同じになる。
//   - 1回で終わる操作は /env/call
//   - 開いたリーダーはサンドボックス側のハンドルで持ち、/env/handle で操作する
//   - exec と watch は NDJSON で流す。中断は /env/abort で伝える
//
// 型: Pi のパッケージは ESM のみで、このプロジェクトの tsc では型が解決できない (pi/ 全体の既知の問題)。
// そのため型はここで最小限に宣言し、Pi のエラー型は実行時に読み込む。
import { randomUUID } from 'node:crypto';

const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://sandbox:7000';
const PI_ENV_MODULE = '@earendil-works/pi-durable/env';

interface Context {
  readonly abortSignal: AbortSignal | undefined;
}
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
type AnyError = Error & { code: string; path?: string; spillPath?: string };

interface PiEnvModule {
  FileError: new (code: string, message: string, path?: string, cause?: Error) => AnyError;
  ExecutionError: new (code: string, message: string, cause?: Error) => AnyError;
}
let piModule: Promise<PiEnvModule> | undefined;
const loadPi = (): Promise<PiEnvModule> => (piModule ??= import(PI_ENV_MODULE));

// ---- 値の変換 (sandbox/env-rpc.mjs と対) ----
function encodeValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return { __b64: Buffer.from(v).toString('base64') };
  if (Array.isArray(v)) return v.map(encodeValue);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encodeValue(x)]));
  }
  return v;
}
function decodeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeValue);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.__b64 === 'string') return new Uint8Array(Buffer.from(o.__b64, 'base64'));
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, decodeValue(x)]));
  }
  return v;
}

interface WireError {
  name: string;
  code: string;
  message: string;
  path?: string;
  spillPath?: string;
}

function makeError(pi: PiEnvModule, e: WireError): AnyError {
  if (e.name === 'ExecutionError') {
    const err = new pi.ExecutionError(e.code, e.message);
    if (e.spillPath !== undefined) err.spillPath = e.spillPath;
    return err;
  }
  return new pi.FileError(e.code, e.message, e.path);
}

const fail = (pi: PiEnvModule, code: string, message: string) => ({
  ok: false as const,
  error: new pi.FileError(code, message),
});

/** NDJSON のレスポンスを1行ずつ読む */
async function* ndjson(res: Response): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body as any) {
    buffer += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield JSON.parse(buffer);
}

/** 中断を伝えたあと、結果の行が来なければ諦めるまでの時間 */
const ABORT_GRACE_MS = 15_000;

export class SandboxExecutionEnv {
  /** 同じ id なら同じファイルが見える。サンドボックスは1コンテナなので、接続先で決まる */
  readonly id: string;
  cwd: string;
  private readonly clientId = randomUUID();

  constructor(
    private baseUrl: string = SANDBOX_URL,
    _sessionId: string = 'default',
    cwd: string = '/workspace',
  ) {
    this.id = `sandbox:${baseUrl.replace(/\/+$/, '')}`;
    this.cwd = cwd;
  }

  private post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  }

  /** サンドボックスの Result を、Pi のエラー型の Result にする */
  private async decode(json: any): Promise<Result<any, AnyError>> {
    const pi = await loadPi();
    return json.ok
      ? { ok: true, value: decodeValue(json.value) }
      : { ok: false, error: makeError(pi, json.error as WireError) };
  }

  private async rpc(
    path: '/env/call' | '/env/handle',
    body: Record<string, unknown>,
    args: unknown[],
    context: Context,
  ): Promise<Result<any, AnyError>> {
    const pi = await loadPi();
    if (context.abortSignal?.aborted) return fail(pi, 'aborted', 'aborted');
    try {
      const res = await this.post(
        path,
        { ...body, cwd: this.cwd, args: encodeValue(args) },
        context.abortSignal,
      );
      const json: any = await res.json();
      if (!res.ok) return fail(pi, 'unknown', json?.error ?? `sandbox ${path} failed: ${res.status}`);
      return await this.decode(json);
    } catch (e) {
      if (context.abortSignal?.aborted) return fail(pi, 'aborted', 'aborted');
      return fail(pi, 'unknown', `sandbox ${path} failed: ${String((e as Error)?.message ?? e)}`);
    }
  }

  private call(method: string, args: unknown[], context: Context) {
    return this.rpc('/env/call', { method }, args, context);
  }

  // ---- リーダー ----
  private async open(method: string, args: unknown[], context: Context): Promise<Result<string, AnyError>> {
    const r = await this.call(method, args, context);
    return r.ok ? { ok: true, value: (r.value as { handle: string }).handle } : r;
  }

  private reader(handle: string, methods: string[]) {
    let closed = false;
    const obj: Record<string, (...a: any[]) => Promise<any>> = {};
    for (const m of methods) {
      obj[m] = (...a: any[]) => {
        const context = a[a.length - 1] as Context;
        return this.rpc('/env/handle', { handle, method: m }, a.slice(0, -1), context);
      };
    }
    obj.close = async () => {
      if (closed) return;
      closed = true;
      await this.post('/env/handle', { handle, method: 'close' }).then(
        (r) => r.arrayBuffer(),
        () => undefined,
      );
    };
    return obj;
  }

  async openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, context: Context) {
    const h = await this.open('openBinaryReader', [path, options], context);
    return h.ok ? { ok: true as const, value: this.reader(h.value, ['info', 'read', 'scanLines']) } : h;
  }
  async openTextLineReader(path: string, context: Context) {
    const h = await this.open('openTextLineReader', [path], context);
    return h.ok ? { ok: true as const, value: this.reader(h.value, ['readLine']) } : h;
  }
  async openDirReader(path: string, context: Context) {
    const h = await this.open('openDirReader', [path], context);
    return h.ok ? { ok: true as const, value: this.reader(h.value, ['next']) } : h;
  }

  // ---- ファイル操作 (1回で終わるもの) ----
  absolutePath(path: string, context: Context) { return this.call('absolutePath', [path], context); }
  joinPath(parts: string[], context: Context) { return this.call('joinPath', [parts], context); }
  readTextFile(path: string, context: Context) { return this.call('readTextFile', [path], context); }
  readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context) {
    return this.call('readTextLines', [path, options], context);
  }
  readBinaryFile(path: string, context: Context) { return this.call('readBinaryFile', [path], context); }
  writeFile(path: string, content: string | Uint8Array, context: Context) {
    return this.call('writeFile', [path, content], context);
  }
  appendFile(path: string, content: string | Uint8Array, context: Context) {
    return this.call('appendFile', [path, content], context);
  }
  truncateFile(path: string, size: number, context: Context) { return this.call('truncateFile', [path, size], context); }
  flushFile(path: string, context: Context) { return this.call('flushFile', [path], context); }
  renameFile(from: string, to: string, context: Context) { return this.call('renameFile', [from, to], context); }
  fileInfo(path: string, context: Context) { return this.call('fileInfo', [path], context); }
  listDir(path: string, context: Context) { return this.call('listDir', [path], context); }
  canonicalPath(path: string, context: Context) { return this.call('canonicalPath', [path], context); }
  exists(path: string, context: Context) { return this.call('exists', [path], context); }
  createDir(path: string, options: { recursive?: boolean } | undefined, context: Context) {
    return this.call('createDir', [path, options], context);
  }
  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context) {
    return this.call('remove', [path, options], context);
  }
  createTempDir(prefix: string | undefined, context: Context) { return this.call('createTempDir', [prefix], context); }
  createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context) {
    return this.call('createTempFile', [options], context);
  }

  // ---- コマンド実行 ----
  async exec(
    command: string | readonly string[],
    options: Record<string, any> | undefined,
    context: Context,
  ): Promise<Result<any, AnyError>> {
    const pi = await loadPi();
    const failExec = (code: string, message: string, cause?: Error) => ({
      ok: false as const,
      error: new pi.ExecutionError(code, message, cause),
    });
    if (context.abortSignal?.aborted) return failExec('aborted', 'aborted');

    const { onOutput, ...rest } = options ?? {};
    const controller = new AbortController();
    let execId: string | undefined;
    let abortRequested = false;
    let giveUp: NodeJS.Timeout | undefined;
    let callbackError: Error | undefined;

    const sendAbort = () => {
      if (execId) this.post('/env/abort', { id: execId }).then((r) => r.arrayBuffer(), () => undefined);
    };
    const requestAbort = () => {
      if (abortRequested) return;
      abortRequested = true;
      sendAbort();
      // 結果の行が来ない (接続が切れた等) ときは、一定時間で諦める
      giveUp = setTimeout(() => controller.abort(), ABORT_GRACE_MS);
    };
    context.abortSignal?.addEventListener('abort', requestAbort, { once: true });

    let final: Result<any, AnyError> | undefined;
    try {
      const res = await this.post(
        '/env/exec',
        { cwd: this.cwd, client: this.clientId, command: encodeValue(command), options: rest },
        controller.signal,
      );
      if (!res.ok || !res.body) {
        final = failExec('unknown', `sandbox /env/exec failed: ${res.status}`);
      } else {
        for await (const line of ndjson(res)) {
          if (line.t === 'start') {
            execId = line.id;
            if (abortRequested) sendAbort();
          } else if (line.t === 'out') {
            if (callbackError === undefined && onOutput) {
              try {
                onOutput(line.text, context, line.info);
              } catch (e) {
                callbackError = e as Error;
                requestAbort();
              }
            }
          } else if (line.t === 'done') {
            final = { ok: true, value: line.result };
          } else if (line.t === 'error') {
            final = { ok: false, error: makeError(pi, line.error as WireError) };
          }
        }
        final ??= failExec(abortRequested ? 'aborted' : 'unknown', 'sandbox exec ended without a result');
      }
    } catch (e) {
      final = failExec(abortRequested ? 'aborted' : 'unknown', String((e as Error)?.message ?? e));
    } finally {
      context.abortSignal?.removeEventListener('abort', requestAbort);
      if (giveUp) clearTimeout(giveUp);
    }
    if (callbackError !== undefined) {
      return failExec('callback_error', String(callbackError.message ?? callbackError), callbackError);
    }
    return final;
  }

  // ---- ファイル監視 ----
  async watch(
    targets: readonly unknown[],
    onChange: (change: any) => void,
    context: Context,
  ): Promise<Result<any, AnyError>> {
    const pi = await loadPi();
    if (context.abortSignal?.aborted) return fail(pi, 'aborted', 'aborted');
    const controller = new AbortController();
    let closed = false;
    let res: Response;
    try {
      res = await this.post(
        '/env/watch',
        { cwd: this.cwd, client: this.clientId, targets: encodeValue(targets) },
        controller.signal,
      );
    } catch (e) {
      return fail(pi, 'unknown', `sandbox /env/watch failed: ${String((e as Error)?.message ?? e)}`);
    }
    if (!res.ok || !res.body) return fail(pi, 'unknown', `sandbox /env/watch failed: ${res.status}`);

    const lines = ndjson(res);
    let first: IteratorResult<any>;
    try {
      first = await lines.next();
    } catch (e) {
      return fail(pi, 'unknown', String((e as Error)?.message ?? e));
    }
    const head = first.done ? undefined : first.value;
    if (!head || head.t === 'error') {
      controller.abort();
      return head
        ? { ok: false, error: makeError(pi, head.error as WireError) }
        : fail(pi, 'unknown', 'sandbox watch ended before it was ready');
    }

    const id: string = head.id;
    // 準備ができたあとの変更を、閉じるまで流す
    void (async () => {
      try {
        for await (const line of lines) {
          if (closed) return;
          if (line.t !== 'change') continue;
          const c = line.change;
          onChange(c.error ? { error: makeError(pi, c.error as WireError) } : c);
        }
      } catch {
        // 接続が切れた (下で通知する)
      }
      if (!closed) onChange({ error: new pi.FileError('unknown', 'sandbox watch connection lost') });
    })();

    return {
      ok: true,
      value: {
        mode: head.mode,
        close: async () => {
          if (closed) return;
          closed = true;
          await this.post('/env/abort', { id }).then(
            (r) => r.arrayBuffer(),
            () => undefined,
          );
          controller.abort();
        },
      },
    };
  }

  /** このクライアントが実行中のコマンドと監視を、すべて止める */
  async cleanup(_context?: Context): Promise<void> {
    await this.post('/env/cleanup', { client: this.clientId }).then(
      (r) => r.arrayBuffer(),
      () => undefined,
    );
  }
}
