import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { config } from '../config.js';
import { AcademyContext, currentAcademy, Db, one, platformPool, pool, schemaFor, tx } from '../db.js';
import { Actor, Role } from '../lib/actor.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound, unauthorized } from '../lib/errors.js';
import { actorOf, parse } from '../lib/http.js';
import { hashPassword, verifyPassword } from '../lib/passwords.js';

const secret = new TextEncoder().encode(config.jwtSecret);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function profileIdFor(db: Db, userId: string, role: Role): Promise<string | null> {
  const table = { admin: null, coach: 'coaches', player: 'players', guardian: 'guardians' }[role];
  if (!table) return null;
  const row = await one(db, `SELECT id FROM ${table} WHERE user_id = $1`, [userId]);
  return row?.id ?? null;
}

async function issueTokens(db: Db, user: { id: string; role: Role; token_version: number }) {
  const accessToken = await new SignJWT({ role: user.role, tv: user.token_version, ac: currentAcademy().code })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
    .sign(secret);
  const refreshToken = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [user.id, sha256(refreshToken), config.refreshTokenTtlDays],
  );
  return { accessToken, refreshToken, expiresIn: config.accessTokenTtlSeconds };
}

// Which academy a request is for: from the signed access token, or, for
// sign-in and token refresh, from the academy code the app sends.
const academyCache = new Map<string, { ctx: AcademyContext | null; at: number }>();

export async function findAcademy(code: string): Promise<AcademyContext | null> {
  const key = code.trim().toLowerCase();
  const hit = academyCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.ctx;
  const row = await one(platformPool, `SELECT code, name FROM academies WHERE code = $1 AND status = 'active'`, [key]);
  const ctx = row ? { code: row.code, name: row.name, schema: schemaFor(row.code) } : null;
  academyCache.set(key, { ctx, at: Date.now() });
  return ctx;
}

export function forgetAcademy(code: string) {
  academyCache.delete(code);
}

export async function resolveAcademy(req: FastifyRequest): Promise<void> {
  req.academy = null;
  req.tokenPayload = null;
  let code: string | undefined;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    let payload;
    try {
      ({ payload } = await jwtVerify(header.slice(7), secret, { algorithms: ['HS256'] }));
    } catch {
      throw unauthorized('Your sign-in has expired');
    }
    req.tokenPayload = payload;
    code = payload.ac as string;
  } else {
    const body = req.body as { academy?: unknown } | undefined;
    const fromBody = body && typeof body === 'object' && typeof body.academy === 'string' ? body.academy : undefined;
    const fromHeader = req.headers['x-academy'];
    code = fromBody ?? (typeof fromHeader === 'string' ? fromHeader : undefined);
  }
  if (!code) return;
  req.academy = await findAcademy(code);
  if (!req.academy) throw notFound('Academy');
}

// Resolves the bearer token on every request. The token version and account
// status are checked against the database each time, so deactivating an
// account or resetting a password takes effect immediately.
export async function authenticate(req: FastifyRequest): Promise<void> {
  req.actor = null;
  const payload = req.tokenPayload;
  if (!payload) return;
  const user = await one(pool, `SELECT id, role, display_name, status, token_version FROM users WHERE id = $1`, [payload.sub]);
  if (!user || user.status !== 'active' || user.token_version !== payload.tv) throw unauthorized('Your sign-in is no longer valid');
  req.actor = {
    userId: user.id,
    role: user.role,
    displayName: user.display_name,
    profileId: await profileIdFor(pool, user.id, user.role),
  } satisfies Actor;
}

export async function authRoutes(app: FastifyInstance) {
  app.post('/v1/auth/login', async (req) => {
    const body = parse(z.object({ academy: z.string().min(1), login: z.string().min(1), password: z.string().min(1) }), req.body);
    const user = await one(pool, `SELECT * FROM users WHERE login = $1`, [body.login.trim().toLowerCase()]);
    // Same message for unknown login and wrong password.
    if (!user || !(await verifyPassword(user.password_hash, body.password))) throw unauthorized('Login or password is incorrect');
    if (user.status !== 'active') throw unauthorized('This account has been deactivated');
    const tokens = await issueTokens(pool, user);
    return { ...tokens, user: await me(user.id) };
  });

  app.post('/v1/auth/refresh', async (req) => {
    const body = parse(z.object({ academy: z.string().min(1), refreshToken: z.string().min(1) }), req.body);
    return tx(async (db) => {
      // Rotate: each refresh token works once.
      const row = await one(
        db,
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
          RETURNING user_id`,
        [sha256(body.refreshToken)],
      );
      if (!row) throw unauthorized('Please sign in again');
      const user = await one(db, `SELECT * FROM users WHERE id = $1`, [row.user_id]);
      if (!user || user.status !== 'active') throw unauthorized('This account has been deactivated');
      return issueTokens(db, user);
    });
  });

  app.post('/v1/auth/logout', async (req) => {
    const body = parse(z.object({ academy: z.string().min(1), refreshToken: z.string().min(1) }), req.body);
    await pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`, [sha256(body.refreshToken)]);
    return { ok: true };
  });

  app.get('/v1/me', async (req) => me(actorOf(req).userId));

  app.post('/v1/auth/change-password', async (req) => {
    const actor = actorOf(req);
    const body = parse(z.object({ currentPassword: z.string(), newPassword: z.string().min(8).max(200) }), req.body);
    return tx(async (db) => {
      const user = await one(db, `SELECT * FROM users WHERE id = $1`, [actor.userId]);
      if (!(await verifyPassword(user.password_hash, body.currentPassword))) throw badRequest('Current password is incorrect');
      const updated = await one(
        db,
        `UPDATE users SET password_hash = $2, must_change_password = false, token_version = token_version + 1
          WHERE id = $1 RETURNING *`,
        [actor.userId, await hashPassword(body.newPassword)],
      );
      await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [actor.userId]);
      await audit(db, actor, 'password_changed', 'user', actor.userId, null, null);
      return issueTokens(db, updated);
    });
  });
}

export async function me(userId: string) {
  const user = await one(pool, `SELECT id, login, role, display_name, must_change_password FROM users WHERE id = $1`, [userId]);
  const profileId = await profileIdFor(pool, user.id, user.role);
  let children: unknown[] = [];
  if (user.role === 'guardian' && profileId) {
    children = (
      await pool.query(
        `SELECT p.id, p.full_name, pg.relationship, pg.can_book FROM player_guardians pg
           JOIN players p ON p.id = pg.player_id WHERE pg.guardian_id = $1 ORDER BY p.full_name`,
        [profileId],
      )
    ).rows;
  }
  const academy = currentAcademy();
  return {
    id: user.id,
    academy: { code: academy.code, name: academy.name },
    login: user.login,
    role: user.role,
    displayName: user.display_name,
    mustChangePassword: user.must_change_password,
    profileId,
    children,
  };
}
