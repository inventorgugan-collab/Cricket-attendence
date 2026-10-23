import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Db, many, one, pool, tx } from '../db.js';
import { Actor } from '../lib/actor.js';
import { audit } from '../lib/audit.js';
import { requirePlayerAccess, requireRole } from '../lib/authz.js';
import { badRequest, notFound } from '../lib/errors.js';
import { actorOf, idParams, isoDate, parse } from '../lib/http.js';
import { adminUsers, notifyUsers, playerAudience } from '../lib/notify.js';
import { Policy } from '../lib/settings.js';
import { config } from '../config.js';
import { createFee } from './finance.js';

// Training entitlements. A package can carry a price; giving a priced package
// raises a fee for it (see finance.ts), which only the admin ever sees.

const addDays = (isoDay: string, days: number) => new Date(Date.parse(`${isoDay}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);

// A package is either one shared pool of sessions, or made of parts, one per
// session category (e.g. 9 one-on-one + 3 strength & conditioning). A session
// only uses a part of its own category.
export async function packageItems(db: Db, packageId: string) {
  return many(
    db,
    `SELECT pi.category_id, pi.total_sessions, c.code AS category_code, c.name AS category_name
       FROM package_items pi JOIN session_categories c ON c.id = pi.category_id
      WHERE pi.package_id = $1 ORDER BY c.sort_order, c.name`,
    [packageId],
  );
}

export async function packageSummary(db: Db, pkg: any) {
  const totals = await one(
    db,
    `SELECT coalesce(sum(delta) FILTER (WHERE reason IN ('attendance', 'attendance_reversal')), 0)::int AS attendance_net,
            coalesce(sum(delta) FILTER (WHERE reason IN ('adjustment', 'makeup_grant')), 0)::int AS adjustments
       FROM credit_ledger WHERE package_id = $1`,
    [pkg.id],
  );
  const attended = await one(
    db,
    `SELECT count(*)::int AS n FROM attendance a JOIN sessions s ON s.id = a.session_id
      WHERE a.player_id = $1 AND a.status IN ('present', 'late')
        AND (s.starts_at AT TIME ZONE $4)::date BETWEEN $2 AND $3`,
    [pkg.player_id, pkg.starts_on, pkg.expires_on, config.timeZone],
  );
  // Upcoming confirmed bookings inside the package period: not deducted, only reserved.
  const reservedRows = await many(
    db,
    `SELECT s.category_id, count(*)::int AS n FROM bookings b JOIN sessions s ON s.id = b.session_id
      WHERE b.player_id = $1 AND b.status = 'confirmed' AND s.starts_at > now() AND s.status = 'scheduled'
        AND NOT b.is_makeup AND (s.starts_at AT TIME ZONE $4)::date BETWEEN $2 AND $3
      GROUP BY s.category_id`,
    [pkg.player_id, pkg.starts_on, pkg.expires_on, config.timeZone],
  );
  const items = await packageItems(db, pkg.id);
  let parts: any[] = [];
  let reserved = reservedRows.reduce((a, r) => a + r.n, 0);
  if (items.length) {
    const byCategory = await many(
      db,
      `SELECT category_id,
              coalesce(sum(delta) FILTER (WHERE reason IN ('attendance', 'attendance_reversal')), 0)::int AS attendance_net,
              coalesce(sum(delta) FILTER (WHERE reason IN ('adjustment', 'makeup_grant')), 0)::int AS adjustments
         FROM credit_ledger WHERE package_id = $1 AND category_id IS NOT NULL GROUP BY category_id`,
      [pkg.id],
    );
    parts = items.map((it) => {
      const l = byCategory.find((r) => r.category_id === it.category_id) ?? { attendance_net: 0, adjustments: 0 };
      const res = reservedRows.find((r) => r.category_id === it.category_id)?.n ?? 0;
      const remaining = it.total_sessions + l.attendance_net + l.adjustments;
      return { ...it, used: -l.attendance_net, adjustments: l.adjustments, remaining, reserved_by_bookings: res, available_to_book: remaining - res };
    });
    // Only sessions of the package's own categories are held against it.
    reserved = parts.reduce((a, p) => a + p.reserved_by_bookings, 0);
  }
  const used = -totals.attendance_net;
  const remaining = pkg.kind === 'fixed' ? pkg.total_sessions + totals.attendance_net + totals.adjustments : null;
  return {
    ...pkg,
    sessions_used: pkg.kind === 'fixed' ? used : attended.n,
    adjustments: totals.adjustments,
    remaining,
    reserved_by_bookings: reserved,
    available_to_book: remaining === null ? null : remaining - reserved,
    parts,
  };
}

// The part of a package a session of this category counts against, if any.
export function partFor(summary: any, categoryId: string | null) {
  return summary.parts.find((p: any) => p.category_id === categoryId) ?? null;
}

// Choose which package an attended session counts against. A package made of
// parts only covers its own categories; a single-pool package covers anything.
export async function packageForSession(db: Db, playerId: string, sessionStartsAt: Date, preferredId: string | null, categoryId: string | null = null) {
  if (preferredId) return one(db, `SELECT * FROM packages WHERE id = $1`, [preferredId]);
  return one(
    db,
    `SELECT p.* FROM packages p
       LEFT JOIN package_items pi ON pi.package_id = p.id AND pi.category_id = $4
      WHERE p.player_id = $1 AND p.status = 'active'
        AND ($2::timestamptz AT TIME ZONE $3)::date BETWEEN p.starts_on AND p.expires_on
        AND (pi.id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM package_items x WHERE x.package_id = p.id))
      ORDER BY (p.kind = 'fixed') DESC,
               (p.kind = 'fixed' AND CASE WHEN pi.id IS NOT NULL
                  THEN pi.total_sessions + coalesce((SELECT sum(delta) FROM credit_ledger l WHERE l.package_id = p.id AND l.category_id = $4), 0)
                  ELSE p.total_sessions + coalesce((SELECT sum(delta) FROM credit_ledger l WHERE l.package_id = p.id), 0) END > 0) DESC,
               (pi.id IS NOT NULL) DESC,
               p.expires_on ASC
      LIMIT 1`,
    [playerId, sessionStartsAt, config.timeZone, categoryId],
  );
}

export function attendanceShouldDeduct(policy: Policy, attendanceStatus: string, sessionStatus: string, isMakeup: boolean): boolean {
  if (sessionStatus === 'cancelled' || attendanceStatus === 'not_applicable') return false;
  if (sessionStatus === 'interrupted' && !policy.credits.interruptedSessionsDeduct) return false;
  if (isMakeup && !policy.credits.makeupSessionsDeduct) return false;
  return policy.credits.deductOn[attendanceStatus as keyof Policy['credits']['deductOn']] ?? false;
}

// Bring the ledger in line with an attendance record. Safe to call any number
// of times: it only ever writes the difference, so re-syncs never double-deduct.
export async function reconcileAttendanceCredit(db: Db, actor: Actor, attendanceId: string, policy: Policy): Promise<void> {
  const row = await one(
    db,
    `SELECT a.id, a.player_id, a.status, a.session_id, s.status AS session_status, s.starts_at, s.category_id,
            coalesce(b.is_makeup, false) AS is_makeup, b.package_id
       FROM attendance a JOIN sessions s ON s.id = a.session_id LEFT JOIN bookings b ON b.id = a.booking_id
      WHERE a.id = $1`,
    [attendanceId],
  );
  if (!row) return;
  const want = attendanceShouldDeduct(policy, row.status, row.session_status, row.is_makeup) ? -1 : 0;
  const current = await many(
    db,
    `SELECT package_id, category_id, sum(delta)::int AS net FROM credit_ledger
      WHERE attendance_id = $1 AND reason IN ('attendance', 'attendance_reversal')
      GROUP BY package_id, category_id HAVING sum(delta) <> 0`,
    [attendanceId],
  );
  const net = current.reduce((acc, r) => acc + r.net, 0);
  if (net === want) return;
  if (net < want) {
    // Reverse what was taken, against the same package(s) and part(s).
    for (const r of current) {
      await db.query(
        `INSERT INTO credit_ledger (package_id, player_id, delta, reason, session_id, attendance_id, created_by, note, category_id)
         VALUES ($1, $2, $3, 'attendance_reversal', $4, $5, $6, $7, $8)`,
        [r.package_id, row.player_id, -r.net, row.session_id, attendanceId, actor.userId, `Attendance now ${row.status} (session ${row.session_status})`, r.category_id],
      );
    }
    return;
  }
  const pkg = await packageForSession(db, row.player_id, row.starts_at, row.package_id, row.category_id);
  // Flexible packages track usage through attendance; nothing to deduct.
  if (!pkg || pkg.kind !== 'fixed') return;
  const hasPart = await one(db, `SELECT 1 FROM package_items WHERE package_id = $1 AND category_id = $2`, [pkg.id, row.category_id]);
  await db.query(
    `INSERT INTO credit_ledger (package_id, player_id, delta, reason, session_id, attendance_id, created_by, note, category_id)
     VALUES ($1, $2, -1, 'attendance', $3, $4, $5, $6, $7)`,
    [pkg.id, row.player_id, row.session_id, attendanceId, actor.userId, `Attendance ${row.status}`, hasPart ? row.category_id : null],
  );
  await notifyPackageUse(db, pkg, hasPart ? row.category_id : null, policy);
}

// After a session is taken from a package: the player and parents hear what is
// left; coaches and admins hear when a part is running low or used up.
async function notifyPackageUse(db: Db, pkg: any, categoryId: string | null, policy: Policy) {
  const summary = await packageSummary(db, pkg);
  const part = partFor(summary, categoryId);
  const left = part ? part.remaining : summary.remaining;
  const total = part ? part.total_sessions : summary.total_sessions;
  const label = part ? `${part.category_name} sessions` : 'sessions';
  const player = await one(db, `SELECT full_name FROM players WHERE id = $1`, [pkg.player_id]);
  const data = { packageId: pkg.id, playerId: pkg.player_id, categoryId };
  await notifyUsers(db, await playerAudience(db, [pkg.player_id]), {
    kind: 'package_used',
    title: `${left} of ${total} ${label} left`,
    body: `${player.full_name}: one session was used from "${pkg.name}".${part ? ` ${packageLine(summary)}` : ''}`,
    data,
  });
  const threshold = policy.credits.lowBalanceThreshold;
  if (left === 0 || left === threshold) {
    const coaches = await many(db, `SELECT c.user_id FROM player_coaches pc JOIN coaches c ON c.id = pc.coach_id WHERE pc.player_id = $1 AND c.user_id IS NOT NULL`, [pkg.player_id]);
    await notifyUsers(db, [...(await adminUsers(db)), ...coaches.map((c) => c.user_id)], {
      kind: left === 0 ? 'package_used_up' : 'package_low',
      title: left === 0 ? `${player.full_name} has no ${label} left` : `${player.full_name} has ${left} ${label} left`,
      body: `Package "${pkg.name}". ${packageLine(summary)}`,
      data,
    });
  }
}

// "One-on-one: 6 of 9 left · Strength & conditioning: 2 of 3 left"
export function packageLine(summary: any): string {
  if (!summary.parts.length) return summary.remaining === null ? 'Flexible package' : `${summary.remaining} of ${summary.total_sessions} left`;
  return summary.parts.map((p: any) => `${p.category_name}: ${p.remaining} of ${p.total_sessions} left`).join(' · ');
}

export async function creditRoutes(app: FastifyInstance) {
  app.get('/v1/players/:id/packages', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const access = await requirePlayerAccess(pool, actor, id);
    const rows = await many(pool, `SELECT * FROM packages WHERE player_id = $1 ORDER BY starts_on DESC`, [id]);
    const out = [];
    for (const r of rows) out.push(await packageSummary(pool, r));
    // Coaches only need to know whether a player is covered, not the history.
    return access === 'coach' ? out.filter((p) => p.status === 'active') : out;
  });

  const itemsSchema = z.array(z.object({ categoryId: z.uuid(), total: z.number().int().min(0).max(500) })).max(10);
  const packageBody = z.object({
    // Start from a template the admin set up; anything given here overrides it.
    templateId: z.uuid().optional(),
    kind: z.enum(['fixed', 'flexible']).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    starts_on: isoDate,
    expires_on: isoDate.optional(),
    total_sessions: z.number().int().min(0).max(500).nullable().optional(),
    // Parts, e.g. [{ one-on-one, 9 }, { strength & conditioning, 3 }].
    items: itemsSchema.optional(),
    notes: z.string().max(2000).nullable().optional(),
    // Fee in rupees. Defaults to the template's price; a fee is raised for it.
    price: z.number().min(0).max(10_000_000).optional(),
  });

  async function checkItems(db: Db, items: z.infer<typeof itemsSchema>) {
    if (new Set(items.map((i) => i.categoryId)).size !== items.length) throw badRequest('Each kind of session can appear only once in a package');
    const found = await many(db, `SELECT id FROM session_categories WHERE id = ANY($1)`, [items.map((i) => i.categoryId)]);
    if (found.length !== items.length) throw badRequest('Unknown session category');
  }

  async function createPackage(db: Db, actor: Actor, playerId: string, body: z.infer<typeof packageBody>) {
    let tpl: any = null;
    if (body.templateId) {
      tpl = await one(db, `SELECT * FROM package_templates WHERE id = $1 AND active`, [body.templateId]);
      if (!tpl) throw notFound('Package template');
    }
    const kind = body.kind ?? tpl?.kind;
    const name = body.name ?? tpl?.name;
    const items = body.items ?? tpl?.items ?? [];
    if (!kind || !name) throw badRequest('A package needs a kind and a name');
    const expires = body.expires_on ?? (tpl ? addDays(body.starts_on, tpl.validity_days - 1) : null);
    if (!expires) throw badRequest('A package needs an expiry date');
    if (expires < body.starts_on) throw badRequest('Expiry must be on or after the start date');
    if (items.length && kind !== 'fixed') throw badRequest('Only fixed packages can be split into parts');
    await checkItems(db, items);
    const total = items.length ? items.reduce((a: number, i: any) => a + i.total, 0) : body.total_sessions;
    if (kind === 'fixed' && total == null) throw badRequest('A fixed package needs a number of sessions');
    const price = body.price !== undefined ? Math.round(body.price * 100) : tpl?.price_paise != null ? Number(tpl.price_paise) : null;
    const pkg = await one(
      db,
      `INSERT INTO packages (player_id, kind, name, starts_on, expires_on, total_sessions, notes, created_by, price_paise)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [playerId, kind, name, body.starts_on, expires, kind === 'fixed' ? total : null, body.notes ?? null, actor.userId, price],
    );
    if (price) await createFee(db, actor, { playerId, packageId: pkg.id, description: name, amountPaise: price, dueOn: body.starts_on });
    for (const it of items) {
      await db.query(`INSERT INTO package_items (package_id, category_id, total_sessions) VALUES ($1, $2, $3)`, [pkg.id, it.categoryId, it.total]);
    }
    return pkg;
  }

  app.post('/v1/players/:id/packages', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(packageBody, req.body);
    return tx(async (db) => {
      const pkg = await createPackage(db, actor, id, body);
      await audit(db, actor, 'package_created', 'package', pkg.id, null, { ...pkg, items: body.items });
      return packageSummary(db, pkg);
    });
  });

  // Renewal or replacement: the old package stays in history, marked replaced.
  app.post('/v1/packages/:id/replace', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(packageBody, req.body);
    return tx(async (db) => {
      const old = await one(db, `SELECT * FROM packages WHERE id = $1 FOR UPDATE`, [id]);
      if (!old) throw notFound('Package');
      const pkg = await createPackage(db, actor, old.player_id, body);
      await db.query(`UPDATE packages SET status = 'replaced', replaced_by = $2 WHERE id = $1`, [id, pkg.id]);
      await audit(db, actor, 'package_replaced', 'package', id, old, { replaced_by: pkg.id });
      return packageSummary(db, pkg);
    });
  });

  app.post('/v1/packages/:id/adjust', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        delta: z.number().int().min(-50).max(50).refine((d) => d !== 0),
        kind: z.enum(['adjustment', 'makeup_grant']).default('adjustment'),
        note: z.string().trim().min(3).max(1000),
        // Which part to adjust, for a package made of parts.
        categoryId: z.uuid().optional(),
      }),
      req.body,
    );
    return tx(async (db) => {
      const pkg = await one(db, `SELECT * FROM packages WHERE id = $1 FOR UPDATE`, [id]);
      if (!pkg) throw notFound('Package');
      if (pkg.kind !== 'fixed') throw badRequest('Flexible packages have no session allowance to adjust');
      const items = await packageItems(db, id);
      let categoryId: string | null = null;
      if (items.length) {
        categoryId = body.categoryId ?? (items.length === 1 ? items[0]!.category_id : null);
        if (!categoryId) throw badRequest('Choose which part of the package to adjust');
        if (!items.some((i) => i.category_id === categoryId)) throw badRequest('This package has no part of that kind');
      }
      const entry = await one(
        db,
        `INSERT INTO credit_ledger (package_id, player_id, delta, reason, note, created_by, category_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, pkg.player_id, body.delta, body.kind, body.note, actor.userId, categoryId],
      );
      await audit(db, actor, 'package_adjusted', 'package', id, null, entry);
      return packageSummary(db, pkg);
    });
  });

  // ------------------------------------------------------------ templates
  const templateFields = z.object({
    name: z.string().trim().min(1).max(200),
    kind: z.enum(['fixed', 'flexible']),
    validity_days: z.number().int().min(1).max(730),
    items: itemsSchema,
    active: z.boolean(),
    // Price in rupees, used to raise a fee when the package is given.
    price: z.number().min(0).max(10_000_000).nullable(),
  });
  const templateBody = templateFields.extend({
    items: itemsSchema.default([]),
    active: z.boolean().default(true),
    price: z.number().min(0).max(10_000_000).nullable().default(null),
  });

  app.get('/v1/package-templates', async (req) => {
    requireRole(actorOf(req), 'admin');
    const rows = await many(pool, `SELECT * FROM package_templates ORDER BY active DESC, name`);
    const cats = await many(pool, `SELECT id, name FROM session_categories`);
    return rows.map((t) => ({
      ...t,
      total_sessions: t.items.reduce((a: number, i: any) => a + i.total, 0),
      items: t.items.map((i: any) => ({ ...i, categoryName: cats.find((c) => c.id === i.categoryId)?.name })),
    }));
  });

  app.post('/v1/package-templates', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const body = parse(templateBody, req.body);
    if (body.kind === 'fixed' && body.items.length === 0) throw badRequest('A fixed package template needs at least one part');
    if (body.kind === 'flexible' && body.items.length) throw badRequest('Only fixed packages can be split into parts');
    return tx(async (db) => {
      await checkItems(db, body.items);
      const t = await one(
        db,
        `INSERT INTO package_templates (name, kind, validity_days, items, active, created_by, price_paise) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [body.name, body.kind, body.validity_days, JSON.stringify(body.items), body.active, actor.userId, body.price === null ? null : Math.round(body.price * 100)],
      );
      await audit(db, actor, 'package_template_created', 'package_template', t.id, null, t);
      return t;
    });
  });

  // Changing a template never changes packages already given out.
  app.patch('/v1/package-templates/:id', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(templateFields.partial(), req.body);
    return tx(async (db) => {
      const before = await one(db, `SELECT * FROM package_templates WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('Package template');
      const next = { ...before, ...body, price_paise: body.price === undefined ? before.price_paise : body.price === null ? null : Math.round(body.price * 100) };
      if (next.kind === 'fixed' && next.items.length === 0) throw badRequest('A fixed package template needs at least one part');
      if (body.items) await checkItems(db, body.items);
      const t = await one(
        db,
        `UPDATE package_templates SET name = $2, kind = $3, validity_days = $4, items = $5, active = $6, price_paise = $7 WHERE id = $1 RETURNING *`,
        [id, next.name, next.kind, next.validity_days, JSON.stringify(next.items), next.active, next.price_paise],
      );
      await audit(db, actor, 'package_template_updated', 'package_template', id, before, t);
      return t;
    });
  });

  app.get('/v1/packages/:id/ledger', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const pkg = await one(pool, `SELECT * FROM packages WHERE id = $1`, [id]);
    if (!pkg) throw notFound('Package');
    const access = await requirePlayerAccess(pool, actor, pkg.player_id);
    if (access === 'coach') requireRole(actor, 'admin');
    return {
      package: await packageSummary(pool, pkg),
      entries: await many(
        pool,
        `SELECT l.*, s.starts_at AS session_starts_at, u.display_name AS created_by_name
           FROM credit_ledger l LEFT JOIN sessions s ON s.id = l.session_id JOIN users u ON u.id = l.created_by
          WHERE l.package_id = $1 ORDER BY l.created_at`,
        [id],
      ),
    };
  });
}
