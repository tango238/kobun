import { Client } from 'pg';

/**
 * Pi Durable の SQLite コアが要求する SqliteDatabase ファサードを PostgreSQL で実装する。
 * これにより SqliteStorage.open(db, { prefix }) の実体を Postgres に置ける
 * (セッション・チェックポイントの置き場)。
 *
 * README (Storage 節) のアダプタ契約:
 *  - exec / run / get / all / transaction / close はすべて Promise ベース
 *  - run / get / all は SQL + 位置バインディング (? プレースホルダ)
 *  - トランザクション中は無関係な操作をキューに入れる。コールバック内では
 *    必ず tx ハンドル経由で操作する (外側の db を触るとデッドロックする)
 *
 * この実装では「単一コネクション + 直列キュー」でその意味論を満たす。
 * 注意: SQLite 方言の SQL をそのまま Postgres に流すため、SQLite 固有の
 * 構文が混ざると失敗しうる。検証は test/conformance.test.ts の
 * registerStorageConformance で行うこと。
 */
export class PostgresSqliteDatabase {
  private client: Client;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(connectionString: string) {
    this.client = new Client({ connectionString });
  }

  static async open(connectionString: string): Promise<PostgresSqliteDatabase> {
    const db = new PostgresSqliteDatabase(connectionString);
    await db.client.connect();
    return db;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // SQLite の ? プレースホルダを Postgres の $1..$n に変換する
  private convert(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  private normalize(params: unknown[]): unknown[] {
    return params.map((v) =>
      v instanceof Uint8Array ? Buffer.from(v) : v,
    );
  }

  private async query(sql: string, params: unknown[] = []) {
    return this.client.query(this.convert(sql), this.normalize(params) as any[]);
  }

  exec(sql: string, params: unknown[] = []): Promise<void> {
    return this.enqueue(async () => {
      await this.query(sql, params);
    });
  }

  run(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ changes: number; lastInsertRowid: number }> {
    return this.enqueue(async () => {
      const res = await this.query(sql, params);
      return { changes: res.rowCount ?? 0, lastInsertRowid: 0 };
    });
  }

  get(sql: string, params: unknown[] = []): Promise<any> {
    return this.enqueue(async () => {
      const res = await this.query(sql, params);
      return res.rows[0];
    });
  }

  all(sql: string, params: unknown[] = []): Promise<any[]> {
    return this.enqueue(async () => {
      const res = await this.query(sql, params);
      return res.rows;
    });
  }

  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.client.query('BEGIN');
      const tx = {
        exec: async (sql: string, params: unknown[] = []) => {
          await this.query(sql, params);
        },
        run: async (sql: string, params: unknown[] = []) => {
          const res = await this.query(sql, params);
          return { changes: res.rowCount ?? 0, lastInsertRowid: 0 };
        },
        get: async (sql: string, params: unknown[] = []) => {
          const res = await this.query(sql, params);
          return res.rows[0];
        },
        all: async (sql: string, params: unknown[] = []) => {
          const res = await this.query(sql, params);
          return res.rows;
        },
        // ネストした transaction は同じトランザクションとして扱う
        transaction: async (cb: (tx2: any) => Promise<any>) => cb(tx),
      };
      try {
        const result = await callback(tx);
        await this.client.query('COMMIT');
        return result;
      } catch (err) {
        await this.client.query('ROLLBACK');
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    await this.chain.catch(() => undefined);
    await this.client.end();
  }
}
