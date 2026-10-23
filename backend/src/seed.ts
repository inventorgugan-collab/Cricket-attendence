// Development data: an admin, two coaches, a few players and a parent.
// Run with `npm run seed` against a development database only.
import { randomBytes } from 'node:crypto';
import { closeAllPools, one, platformPool, pool, schemaFor, useAcademyByDefault } from './db.js';
import { hashPassword } from './lib/passwords.js';
import { migrateAcademy, migratePlatform } from './migrate.js';

if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');

// Seeds one academy (code from SEED_ACADEMY, default "cpl"), creating it if needed.
const code = process.env.SEED_ACADEMY ?? 'cpl';
const academyName = process.env.SEED_ACADEMY_NAME ?? 'Cricket Performance Lab';
await migratePlatform();
await migrateAcademy(code);
if (!(await one(platformPool, `SELECT 1 FROM academies WHERE code = $1`, [code]))) {
  await platformPool.query(`INSERT INTO academies (code, name) VALUES ($1, $2)`, [code, academyName]);
}
useAcademyByDefault({ code, name: academyName, schema: schemaFor(code) });
const password = process.env.SEED_PASSWORD ?? randomBytes(6).toString('base64url');
const hash = await hashPassword(password);

async function user(login: string, role: string, name: string) {
  const { rows } = await pool.query(
    `INSERT INTO users (login, password_hash, role, display_name, must_change_password) VALUES ($1, $2, $3, $4, false)
     ON CONFLICT (login) DO UPDATE SET password_hash = EXCLUDED.password_hash RETURNING id`,
    [login, hash, role, name],
  );
  return rows[0].id as string;
}
const insert = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0].id as string;

await user('admin', 'admin', 'Academy Admin');
const coachA = await insert(`INSERT INTO coaches (full_name, user_id) VALUES ('Arun Kumar', $1) RETURNING id`, [await user('arun', 'coach', 'Arun Kumar')]);
const coachB = await insert(`INSERT INTO coaches (full_name, user_id) VALUES ('Bala Murugan', $1) RETURNING id`, [await user('bala', 'coach', 'Bala Murugan')]);
const ravi = await insert(
  `INSERT INTO players (full_name, date_of_birth, primary_role, batting_style, user_id) VALUES ('Ravi S', '2011-03-14', 'batter', 'right_hand', $1) RETURNING id`,
  [await user('ravi', 'player', 'Ravi S')],
);
const priya = await insert(`INSERT INTO players (full_name, date_of_birth, primary_role, bowling_arm, bowling_style) VALUES ('Priya K', '2009-08-02', 'bowler', 'right', 'pace') RETURNING id`, []);
const karthik = await insert(`INSERT INTO players (full_name, date_of_birth, primary_role, user_id) VALUES ('Karthik R', '2001-11-20', 'all_rounder', $1) RETURNING id`, [await user('karthik', 'player', 'Karthik R')]);
const parent = await insert(`INSERT INTO guardians (full_name, phone, user_id) VALUES ('Lakshmi S', '9000000001', $1) RETURNING id`, [await user('lakshmi', 'guardian', 'Lakshmi S')]);
await pool.query(`INSERT INTO player_guardians (player_id, guardian_id, relationship, is_primary) VALUES ($1, $3, 'mother', true), ($2, $3, 'mother', true)`, [ravi, priya, parent]);
await pool.query(`INSERT INTO player_coaches (player_id, coach_id) VALUES ($1, $3), ($2, $3), ($4, $5)`, [ravi, priya, coachA, karthik, coachB]);
const loc = await insert(`INSERT INTO locations (name) VALUES ('Main Ground') RETURNING id`, []);
const net1 = await insert(`INSERT INTO training_areas (location_id, name, kind) VALUES ($1, 'Net 1', 'turf') RETURNING id`, [loc]);
const group = await insert(`INSERT INTO training_groups (name) VALUES ('Under-16 Morning') RETURNING id`, []);
await pool.query(`INSERT INTO group_members (group_id, player_id) VALUES ($1, $2), ($1, $3)`, [group, ravi, priya]);
await pool.query(`INSERT INTO group_coaches (group_id, coach_id) VALUES ($1, $2)`, [group, coachA]);
for (const p of [ravi, priya, karthik]) {
  await pool.query(
    `INSERT INTO packages (player_id, kind, name, starts_on, expires_on, total_sessions, created_by)
     VALUES ($1, 'fixed', 'Monthly 12', date_trunc('month', current_date), date_trunc('month', current_date) + interval '1 month - 1 day', 12,
             (SELECT id FROM users WHERE login = 'admin'))`,
    [p],
  );
}
// Today's sessions: a group session in progress and a one-on-two later.
const s1 = await insert(
  `INSERT INTO sessions (session_type, booking_mode, title, area_id, location_id, starts_at, ends_at, capacity, group_id, created_by)
   VALUES ('group', 'fixed', 'U16 batting', $1, $2, now() - interval '30 minutes', now() + interval '60 minutes', 12, $3, (SELECT id FROM users WHERE login = 'admin')) RETURNING id`,
  [net1, loc, group],
);
await pool.query(`INSERT INTO session_coaches (session_id, coach_id, during) SELECT id, $2, during FROM sessions WHERE id = $1`, [s1, coachA]);
await pool.query(`INSERT INTO bookings (session_id, player_id, status, source, during, requested_by) SELECT $1, unnest($2::uuid[]), 'confirmed', 'roster', during, created_by FROM sessions WHERE id = $1`, [s1, [ravi, priya]]);
const s2 = await insert(
  `INSERT INTO sessions (session_type, booking_mode, title, starts_at, ends_at, capacity, created_by)
   VALUES ('one_on_two', 'open', 'Pace bowling 1:2', now() + interval '1 day', now() + interval '1 day 1 hour', 2, (SELECT id FROM users WHERE login = 'admin')) RETURNING id`,
  [],
);
await pool.query(`INSERT INTO session_coaches (session_id, coach_id, during) SELECT id, $2, during FROM sessions WHERE id = $1`, [s2, coachB]);

console.log(`Seeded academy ${code}. Logins: admin, arun, bala, ravi, karthik, lakshmi. Password: ${password}`);
await closeAllPools();
