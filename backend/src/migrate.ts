import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closeAllPools, many, platformPool, poolFor, schemaFor } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// The platform schema: the list of academies. Extensions are shared by every
// academy schema, so they are installed once, in `public`.
export async function migratePlatform(): Promise<void> {
  await platformPool.query(`
    CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA public;
    CREATE EXTENSION IF NOT EXISTS pgcrypto SCHEMA public;
    CREATE SCHEMA IF NOT EXISTS platform;
    CREATE TABLE IF NOT EXISTS platform.academies (
      id          uuid PRIMARY KEY DEFAULT public.gen_random_uuid(),
      code        text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]{2,30}$'),
      name        text NOT NULL,
      status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
      created_at  timestamptz NOT NULL DEFAULT now()
    );`);
}

// Bring one academy's schema up to date.
export async function migrateAcademy(code: string): Promise<string[]> {
  const schema = schemaFor(code);
  const db = poolFor(schema);
  await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed for ${code}: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

export async function migrateAll(): Promise<Record<string, string[]>> {
  await migratePlatform();
  const out: Record<string, string[]> = {};
  for (const a of await many(platformPool, `SELECT code FROM academies ORDER BY code`)) out[a.code] = await migrateAcademy(a.code);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrateAll()
    .then((r) => console.log(Object.entries(r).map(([k, v]) => `${k}: ${v.length ? v.join(', ') : 'up to date'}`).join('\n') || 'No academies yet'))
    .finally(() => closeAllPools());
}
