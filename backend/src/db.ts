import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { config } from './config.js';

// Return DATE columns as 'YYYY-MM-DD' strings instead of shifting them through JS Dates.
pg.types.setTypeParser(1082, (v) => v);
// bigint change numbers fit comfortably in a JS number for the life of the app.
pg.types.setTypeParser(20, (v) => Number(v));

export type Db = pg.Pool | pg.PoolClient;

// ---------------------------------------------------------------------------
// Academies. Each academy's data lives in its own Postgres schema, so one
// academy can never read another's rows: every connection in an academy's
// pool has its search_path fixed to that schema. Shared extensions live in
// `public`; the list of academies lives in `platform`.
// ---------------------------------------------------------------------------

export interface AcademyContext {
  code: string;
  schema: string;
  name: string;
}

const store = new AsyncLocalStorage<AcademyContext>();
const pools = new Map<string, pg.Pool>();
let fallback: AcademyContext | null = null;

export const schemaFor = (code: string) => `academy_${code}`;

export function poolFor(schema: string): pg.Pool {
  let p = pools.get(schema);
  if (!p) {
    if (!/^academy_[a-z0-9_]+$/.test(schema)) throw new Error(`Bad academy schema ${schema}`);
    p = new pg.Pool({ connectionString: config.databaseUrl, max: 10, options: `-c search_path=${schema},public` });
    pools.set(schema, p);
  }
  return p;
}

// Platform-level queries (the academies list); never academy data.
export const platformPool = new pg.Pool({ connectionString: config.databaseUrl, max: 4, options: '-c search_path=platform,public' });

export function currentAcademy(): AcademyContext {
  const ctx = store.getStore() ?? fallback;
  if (!ctx) throw new Error('No academy selected for this request');
  return ctx;
}

export const runInAcademy = <T>(ctx: AcademyContext, fn: () => T): T => store.run(ctx, fn);

// Scripts and tests that work on one academy outside a request.
export function useAcademyByDefault(ctx: AcademyContext | null) {
  fallback = ctx;
}

// `pool` always means "the current academy's pool", so the rest of the code
// doesn't need to know academies exist.
export const pool: pg.Pool = new Proxy({} as pg.Pool, {
  get(_t, prop) {
    const p = poolFor(currentAcademy().schema) as any;
    const v = p[prop];
    return typeof v === 'function' ? v.bind(p) : v;
  },
});

export async function closeAllPools() {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
  await platformPool.end();
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function one<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const { rows } = await db.query(sql, params);
  return rows[0] as T | undefined;
}

export async function many<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const { rows } = await db.query(sql, params);
  return rows as T[];
}
