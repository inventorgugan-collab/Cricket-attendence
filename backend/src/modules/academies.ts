import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { many, one, platformPool, pool, runInAcademy, schemaFor } from '../db.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { parse } from '../lib/http.js';
import { hashPassword } from '../lib/passwords.js';
import { migrateAcademy } from '../migrate.js';
import { forgetAcademy } from './auth.js';

// Many academies on one server. Each gets its own separate data (its own
// database schema) and its own admin, who then adds coaches and players. Only
// the platform owner, holding PLATFORM_KEY, can add academies.

export const newAcademy = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9]{2,30}$/, 'Use 2 to 30 lowercase letters or digits'),
  name: z.string().trim().min(2).max(200),
  adminLogin: z.string().trim().toLowerCase().min(3).max(100),
  adminName: z.string().trim().min(1).max(200).default('Academy Admin'),
  adminPassword: z.string().min(8).max(200),
});

export async function createAcademy(input: z.infer<typeof newAcademy>) {
  const exists = await one(platformPool, `SELECT 1 FROM academies WHERE code = $1`, [input.code]);
  if (exists) throw conflict('academy_exists', 'That academy code is already taken');
  await migrateAcademy(input.code);
  const ctx = { code: input.code, name: input.name, schema: schemaFor(input.code) };
  await runInAcademy(ctx, async () => {
    await pool.query(
      `INSERT INTO users (login, password_hash, role, display_name, must_change_password) VALUES ($1, $2, 'admin', $3, true)`,
      [input.adminLogin, await hashPassword(input.adminPassword), input.adminName],
    );
  });
  // Listed last, so a half-made academy is never offered at sign-in.
  const row = await one(platformPool, `INSERT INTO academies (code, name) VALUES ($1, $2) RETURNING code, name, status, created_at`, [input.code, input.name]);
  forgetAcademy(input.code);
  return row;
}

function requirePlatformKey(req: FastifyRequest) {
  const given = req.headers['x-platform-key'];
  if (!config.platformKey || typeof given !== 'string') throw forbidden();
  const a = Buffer.from(given);
  const b = Buffer.from(config.platformKey);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw forbidden();
}

export async function academyRoutes(app: FastifyInstance) {
  // The sign-in screen checks the code and shows the academy's name.
  app.get('/v1/academies/:code', async (req) => {
    const { code } = parse(z.object({ code: z.string().trim().toLowerCase().max(30) }), req.params);
    const row = await one(platformPool, `SELECT code, name FROM academies WHERE code = $1 AND status = 'active'`, [code]);
    if (!row) throw notFound('Academy');
    return row;
  });

  app.get('/v1/platform/academies', async (req) => {
    requirePlatformKey(req);
    return many(platformPool, `SELECT code, name, status, created_at FROM academies ORDER BY created_at`);
  });

  app.post('/v1/platform/academies', async (req) => {
    requirePlatformKey(req);
    return createAcademy(parse(newAcademy, req.body));
  });

  app.post('/v1/platform/academies/:code/status', async (req) => {
    requirePlatformKey(req);
    const { code } = parse(z.object({ code: z.string() }), req.params);
    const { status } = parse(z.object({ status: z.enum(['active', 'suspended']) }), req.body);
    const row = await one(platformPool, `UPDATE academies SET status = $2 WHERE code = $1 RETURNING code, name, status`, [code, status]);
    if (!row) throw notFound('Academy');
    forgetAcademy(code);
    return row;
  });
}
