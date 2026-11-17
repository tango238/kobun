// Pi Durable の ExecutionEnv を、kobun のサンドボックスデーモン越しに実装する。
//
// Sandbox-as-a-tool: ハーネス (worker) はサンドボックスの外にいて、
// read / write / edit / bash の実体だけがサンドボックス内で実行される。
// env の id が同じなら同じファイルが見える (README: Environment 節) ため、
// セッションごとに id を固定し、実体は単一のサンドボックスコンテナに委譲する。
//
// 注意: メソッドの形は README の Environment 節の記述に基づく。
// 正確な型は @earendil-works/pi-durable/env の型定義と
// test/conformance.test.ts の registerEnvConformance で要確認。

const SANDBOX_URL = process.env.SANDBOX_URL ?? 'http://sandbox:7000';

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export class SandboxExecutionEnv {
  readonly id: string;

  constructor(
    private baseUrl: string = SANDBOX_URL,
    sessionId: string,
  ) {
    this.id = `sandbox-${sessionId}`;
  }

  private async call<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`sandbox ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }

  // argv 配列でプログラムを実行する (シェルを介さないのが本来の形だが、
  // デーモン側が文字列コマンドを受けるため、ここで安全にクォートして渡す)
  async exec(
    argv: string[],
    options: {
      onOutput?: (
        text: string,
        context: unknown,
        meta: { stream: 'stdout' | 'stderr' },
      ) => void;
    } = {},
    context?: unknown,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const cmd = argv.map(shellQuote).join(' ');
    const data = await this.call<{ stdout: string; stderr: string; code: number }>(
      '/exec',
      { cmd },
    );
    if (data.stdout) options.onOutput?.(data.stdout, context, { stream: 'stdout' });
    if (data.stderr) options.onOutput?.(data.stderr, context, { stream: 'stderr' });
    return data;
  }

  async openBinaryReader(path: string) {
    const data = await this.call<{ base64: string }>('/read-base64', { path });
    const buf = Buffer.from(data.base64, 'base64');
    return {
      size: buf.length,
      read: async (offset: number, length: number) =>
        buf.subarray(offset, offset + length),
      close: async () => undefined,
    };
  }

  async openDirReader(path: string) {
    const data = await this.call<{ entries: unknown[] }>('/list', { path });
    return {
      entries: data.entries,
      close: async () => undefined,
    };
  }

  async listFiles(dir: string) {
    const data = await this.call<{ entries: unknown[] }>('/list', {
      path: dir,
      recursive: true,
    });
    return { entries: data.entries, truncated: false };
  }

  async cleanup(): Promise<void> {
    // サンドボックスはコンテナとして常駐するので、後片付けは不要
  }
}
