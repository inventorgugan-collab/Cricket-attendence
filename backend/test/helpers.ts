import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { many, platformPool, pool, schemaFor, useAcademyByDefault } from '../src/db.js';
import { hashPassword } from '../src/lib/passwords.js';
import { migrateAcademy, migratePlatform } from '../src/migrate.js';

export const PASSWORD = 'Password123!';
let passwordHash: string;

export const ACADEMY = 'test';

// A clean database with one academy ("test"). Direct queries in tests go to it.
export async function freshApp(): Promise<FastifyInstance> {
  for (const r of await many(platformPool, `SELECT nspname FROM pg_namespace WHERE nspname = 'platform' OR nspname LIKE 'academy\\_%'`)) {
    await platformPool.query(`DROP SCHEMA ${r.nspname} CASCADE`);
  }
  await migratePlatform();
  await addAcademy(ACADEMY, 'Test Academy');
  useAcademyByDefault({ code: ACADEMY, name: 'Test Academy', schema: schemaFor(ACADEMY) });
  passwordHash ??= await hashPassword(PASSWORD);
  return buildApp();
}

export async function addAcademy(code: string, name: string) {
  await migrateAcademy(code);
  await platformPool.query(`INSERT INTO academies (code, name) VALUES ($1, $2)`, [code, name]);
}

export interface Client {
  token: string;
  userId: string;
  profileId: string | null;
  get: (url: string) => Promise<any>;
  post: (url: string, body?: unknown) => Promise<any>;
  put: (url: string, body?: unknown) => Promise<any>;
  patch: (url: string, body?: unknown) => Promise<any>;
  raw: (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
}

export async function login(app: FastifyInstance, loginName: string, password = PASSWORD, academy = ACADEMY): Promise<Client> {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { academy, login: loginName, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const body = res.json();
  const raw = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${body.accessToken}` } });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
  const ok = (method: string) => async (url: string, payload?: unknown) => {
    const r = await raw(method, url, payload);
    if (r.status >= 300) throw Object.assign(new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`), { status: r.status, body: r.body });
    return r.body;
  };
  return { token: body.accessToken, userId: body.user.id, profileId: body.user.profileId, get: ok('GET'), post: ok('POST'), put: ok('PUT'), patch: ok('PATCH'), raw };
}

// Create users directly (the account API itself is covered in its own tests).
export async function makeUser(loginName: string, role: string, profileTable?: string, profileId?: string) {
  const { rows } = await pool.query(
    `INSERT INTO users (login, password_hash, role, display_name, must_change_password) VALUES ($1, $2, $3, $1, false) RETURNING id`,
    [loginName, passwordHash, role],
  );
  if (profileTable) await pool.query(`UPDATE ${profileTable} SET user_id = $1 WHERE id = $2`, [rows[0].id, profileId]);
  return rows[0].id as string;
}

export const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

export interface World {
  admin: Client;
  coachA: Client;
  coachB: Client;
  coachAId: string;
  coachBId: string;
  adult: string; // adult player id
  minor: string; // minor player id
  other: string; // another minor, not linked to the guardian
  guardianId: string;
  player: Client; // the adult player's account
  kid: Client; // the minor's own account
  guardian: Client;
  areaId: string;
  area2Id: string;
}

// A small academy: two coaches, three players (one adult, two minors), one parent.
export async function world(app: FastifyInstance): Promise<World> {
  await makeUser('admin', 'admin');
  const admin = await login(app, 'admin');
  const coachAId = (await admin.post('/v1/coaches', { full_name: 'Coach Arun' })).id;
  const coachBId = (await admin.post('/v1/coaches', { full_name: 'Coach Bala' })).id;
  const adult = (await admin.post('/v1/players', { full_name: 'Adult Player', date_of_birth: '2000-01-01', primary_role: 'batter', address: '1 Main Road' })).id;
  const minor = (await admin.post('/v1/players', { full_name: 'Minor Player', date_of_birth: '2013-05-05', primary_role: 'bowler', address: '2 Main Road' })).id;
  const other = (await admin.post('/v1/players', { full_name: 'Other Kid', date_of_birth: '2012-02-02' })).id;
  const guardianId = (await admin.post('/v1/guardians', { full_name: 'Parent One', phone: '9000000000' })).id;
  await admin.post(`/v1/players/${minor}/guardians`, { guardianId, relationship: 'mother', isPrimary: true });
  await admin.put(`/v1/players/${minor}/coaches`, { coachIds: [coachAId] });
  await admin.put(`/v1/players/${adult}/coaches`, { coachIds: [coachAId] });
  const loc = await admin.post('/v1/locations', { name: 'Main Ground' });
  const areaId = (await admin.post(`/v1/locations/${loc.id}/areas`, { name: 'Net 1' })).id;
  const area2Id = (await admin.post(`/v1/locations/${loc.id}/areas`, { name: 'Net 2' })).id;
  await makeUser('coach.a', 'coach', 'coaches', coachAId);
  await makeUser('coach.b', 'coach', 'coaches', coachBId);
  await makeUser('adult', 'player', 'players', adult);
  await makeUser('kid', 'player', 'players', minor);
  await makeUser('parent', 'guardian', 'guardians', guardianId);
  return {
    admin,
    coachA: await login(app, 'coach.a'),
    coachB: await login(app, 'coach.b'),
    coachAId,
    coachBId,
    adult,
    minor,
    other,
    guardianId,
    player: await login(app, 'adult'),
    kid: await login(app, 'kid'),
    guardian: await login(app, 'parent'),
    areaId,
    area2Id,
  };
}

export async function givePackage(admin: Client, playerId: string, total = 8) {
  const later = new Date(Date.now() + 60 * 86400_000).toISOString().slice(0, 10);
  const earlier = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  return admin.post(`/v1/players/${playerId}/packages`, { kind: 'fixed', name: 'Monthly 8', starts_on: earlier, expires_on: later, total_sessions: total });
}
