import { Client, types } from 'pg';

/**
 * Pi Durable の SQLite コアが要求する SqliteDatabase ファサードを PostgreSQL で実装する。
 * これにより SqliteStorage.open(db, { prefix }) の実体を Postgres に置ける
 * (セッション・チェックポイントの置き場)。
 *
 * アダプタ契約 (@earendil-works/pi-durable の storage/sqlite/database.d.ts):
 *  - exec(sql) は束縛なしで複数文を流せる。run / get / all は 1 文と位置束縛 (可変長引数)
 *  - run は何も返さない。get は無ければ undefined。all は行の配列
 *  - transaction のコールバックには tx ハンドルを渡し、中の操作は必ずそれ経由で行う。
 *    無関係な操作と別のトランザクションは、終わるまで待たせる
 *  - コールバックが失敗したらロールバックしてから同じエラーで reject する。
 *    ロールバックも失敗したら、別のエラー (AggregateError) で reject する
 *
 * 実装は「単一コネクション + 直列キュー」。Pi が流す SQL は SQLite 方言なので、
 * 流す前に Postgres 向けに書き換える (translate)。
 *  - 末尾の STRICT を除く
 *  - INTEGER を BIGINT にする (id や時刻は 32 ビットに収まらない)
 *  - CHECK (json_valid(...)) を除く (JSON は Pi が組み立てて入れる)
 *  - INSERT OR IGNORE を INSERT ... ON CONFLICT DO NOTHING にする
 *  - ? を $1..$n にする
 * 結果の BIGINT は number に直す。安全な整数の範囲を超える値は、SQLite のアダプタと同じく拒否する。
 */

/** SQLite 方言の SQL を Postgres 向けに書き換える (文字列リテラルの中は触らない) */
export function translate(sql: string): string {
  // 文字列リテラル ('...' と "...") を退避して、外側だけを書き換える
  const quoted: string[] = [];
  const masked = sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, (m) => {
    quoted.push(m);
    return `\u0000${quoted.length - 1}\u0000`;
  });
  let out = masked
    .replace(/\)\s*STRICT\b/gi, ')')
    .replace(/,?\s*CHECK\s*\(\s*json_valid\s*\(\s*\w+\s*\)\s*\)/gi, '')
    .replace(/\bINTEGER\b/gi, 'BIGINT');
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(out)) {
    out = out.replace(/^(\s*)INSERT\s+OR\s+IGNORE\s+INTO\b/i, '$1INSERT INTO').replace(/\s*;?\s*$/, '') +
      ' ON CONFLICT DO NOTHING';
  }
  let i = 0;
  out = out.replace(/\?/g, () => `$${++i}`);
  // eslint-disable-next-line no-control-regex
  return out.replace(/\u0000(\d+)\u0000/g, (_, n) => quoted[Number(n)]);
}

function parseBigint(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`整数が安全な範囲を超えています: ${value}`);
  }
  return n;
}

const typeParsers = {
  getTypeParser: ((oid: number, format?: any) =>
    oid === 20 ? parseBigint : types.getTypeParser(oid, format)) as typeof types.getTypeParser,
};

type Executor = {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: unknown[]): Promise<void>;
  get(sql: string, ...params: unknown[]): Promise<any>;
  all(sql: string, ...params: unknown[]): Promise<any[]>;
};

export class PostgresSqliteDatabase {
  private client: Client;
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(connectionString: string) {
    this.client = new Client({ connectionString, types: typeParsers as any });
  }

  static async open(connectionString: string): Promise<PostgresSqliteDatabase> {
    const db = new PostgresSqliteDatabase(connectionString);
    await db.client.connect();
    return db;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('database is closed'));
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private normalize(params: unknown[]): unknown[] {
    return params.map((v) => (v instanceof Uint8Array ? Buffer.from(v) : v));
  }

  private async query(sql: string, params: unknown[] = []) {
    const text = translate(sql);
    // 束縛なしなら simple query で流す (複数文を含められる)
    if (params.length === 0) return this.client.query(text);
    return this.client.query(text, this.normalize(params) as any[]);
  }

  private executor(): Executor {
    return {
      exec: async (sql) => {
        await this.query(sql);
      },
      run: async (sql, ...params) => {
        await this.query(sql, params);
      },
      get: async (sql, ...params) => (await this.query(sql, params)).rows[0],
      all: async (sql, ...params) => (await this.query(sql, params)).rows,
    };
  }

  exec(sql: string): Promise<void> {
    return this.enqueue(() => this.executor().exec(sql));
  }

  run(sql: string, ...params: unknown[]): Promise<void> {
    return this.enqueue(() => this.executor().run(sql, ...params));
  }

  get(sql: string, ...params: unknown[]): Promise<any> {
    return this.enqueue(() => this.executor().get(sql, ...params));
  }

  all(sql: string, ...params: unknown[]): Promise<any[]> {
    return this.enqueue(() => this.executor().all(sql, ...params));
  }

  transaction<T>(callback: (tx: Executor) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.client.query('BEGIN');
      const inner = this.executor();
      // コールバックが終わったら、ハンドルは使えなくする
      let live = true;
      const guard =
        <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
        (...a: A): Promise<R> =>
          live ? fn(...a) : Promise.reject(new Error('transaction handle is no longer valid'));
      const tx: Executor = {
        exec: guard(inner.exec),
        run: guard(inner.run),
        get: guard(inner.get),
        all: guard(inner.all),
      };
      try {
        const result = await callback(tx);
        live = false;
        await this.client.query('COMMIT');
        return result;
      } catch (err) {
        live = false;
        try {
          await this.client.query('ROLLBACK');
        } catch (rollbackErr) {
          throw new AggregateError(
            [err, rollbackErr],
            'transaction failed and rollback also failed',
          );
        }
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // 実行中の操作が終わってから閉じる。閉じたあとの操作はすべて reject する
    await this.chain.catch(() => undefined);
    this.closed = true;
    await this.client.end();
  }
}
