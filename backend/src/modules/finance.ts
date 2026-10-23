import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { Db, many, one, pool, tx } from '../db.js';
import { Actor } from '../lib/actor.js';
import { audit } from '../lib/audit.js';
import { requireRole } from '../lib/authz.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { actorOf, idParams, isoDate, parse } from '../lib/http.js';
import { localDate } from '../lib/time.js';

const TZ = config.timeZone;

// Fees, payments, coach pay, expenses and the month-end summary. Every route
// here is for the academy admin only; none of it is ever sent to a coach,
// player or parent, or synced to their phones.

// Amounts come in as rupees (up to 2 decimals) and are kept as whole paise.
const rupees = z.number().positive().max(10_000_000).transform((r) => Math.round(r * 100));
const method = z.enum(['cash', 'upi', 'bank', 'card', 'cheque', 'other']);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const voidBody = z.object({ reason: z.string().trim().min(3).max(500) });

function adminOnly(actor: Actor) {
  requireRole(actor, 'admin');
}

const FEE_SELECT = `
  SELECT f.*, p.full_name AS player_name,
         coalesce((SELECT sum(amount_paise) FROM payments x WHERE x.fee_id = f.id AND x.voided_at IS NULL), 0)::bigint AS paid_paise
    FROM fees f JOIN players p ON p.id = f.player_id`;

function presentFee(f: any) {
  const paid = Number(f.paid_paise);
  const due = Number(f.amount_paise);
  const status = f.waived_at ? 'waived' : paid >= due ? 'paid' : paid > 0 ? 'part_paid' : f.due_on < localDate() ? 'overdue' : 'due';
  return { ...f, amount_paise: due, paid_paise: paid, balance_paise: f.waived_at ? 0 : Math.max(0, due - paid), status };
}

export async function createFee(db: Db, actor: Actor, input: { playerId: string; packageId?: string | null; description: string; amountPaise: number; dueOn: string }) {
  const fee = await one(
    db,
    `INSERT INTO fees (player_id, package_id, description, amount_paise, due_on, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.playerId, input.packageId ?? null, input.description, input.amountPaise, input.dueOn, actor.userId],
  );
  await audit(db, actor, 'fee_created', 'fee', fee.id, null, fee);
  return fee;
}

const monthBounds = (m: string) => {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const start = `${m}-01`;
  const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${String(mo + 1).padStart(2, '0')}-01`;
  return { start, next };
};

export async function monthSummary(db: Db, m: string) {
  const { start, next } = monthBounds(m);
  // Sessions that actually ran: not cancelled, and already over.
  const held = `s.status <> 'cancelled' AND s.ends_at <= now()
                AND (s.starts_at AT TIME ZONE '${TZ}')::date >= $1::date AND (s.starts_at AT TIME ZONE '${TZ}')::date < $2::date`;
  const sessions = await one(
    db,
    `SELECT count(*)::int AS held,
            count(*) FILTER (WHERE s.session_type = 'group')::int AS group_sessions,
            count(*) FILTER (WHERE s.session_type <> 'group')::int AS individual_sessions,
            (SELECT count(*) FROM attendance a JOIN sessions s2 ON s2.id = a.session_id
              WHERE a.status IN ('present', 'late') AND s2.id IN (SELECT s.id FROM sessions s WHERE ${held}))::int AS player_attendances,
            (SELECT count(*) FROM sessions s WHERE s.status = 'cancelled'
              AND (s.starts_at AT TIME ZONE '${TZ}')::date >= $1::date AND (s.starts_at AT TIME ZONE '${TZ}')::date < $2::date)::int AS cancelled
       FROM sessions s WHERE ${held}`,
    [start, next],
  );
  const byCategory = await many(
    db,
    `SELECT cat.name, count(*)::int AS sessions FROM sessions s JOIN session_categories cat ON cat.id = s.category_id
      WHERE ${held} GROUP BY cat.name, cat.sort_order ORDER BY cat.sort_order`,
    [start, next],
  );
  const coaches = await many(
    db,
    `SELECT c.id, c.full_name,
            count(s.id)::int AS sessions,
            coalesce(sum(coalesce(rc.amount_paise, rd.amount_paise, 0)) FILTER (WHERE s.id IS NOT NULL), 0)::bigint AS earned_paise,
            coalesce(bool_or(rc.amount_paise IS NULL AND rd.amount_paise IS NULL) FILTER (WHERE s.id IS NOT NULL), false) AS missing_rate,
            coalesce((SELECT sum(p.amount_paise) FROM coach_payouts p WHERE p.coach_id = c.id AND p.voided_at IS NULL AND p.for_month = $1::date), 0)::bigint AS paid_paise
       FROM coaches c
       LEFT JOIN session_coaches sc ON sc.coach_id = c.id AND sc.active
       LEFT JOIN sessions s ON s.id = sc.session_id AND ${held}
       LEFT JOIN coach_rates rc ON rc.coach_id = c.id AND rc.category_id = s.category_id
       LEFT JOIN coach_rates rd ON rd.coach_id = c.id AND rd.category_id IS NULL
      WHERE c.status = 'active' OR s.id IS NOT NULL
      GROUP BY c.id, c.full_name ORDER BY c.full_name`,
    [start, next],
  );
  const money = await one(
    db,
    `SELECT
       coalesce((SELECT sum(amount_paise) FROM payments WHERE voided_at IS NULL AND paid_on >= $1 AND paid_on < $2), 0)::bigint AS received,
       coalesce((SELECT sum(amount_paise) FROM coach_payouts WHERE voided_at IS NULL AND paid_on >= $1 AND paid_on < $2), 0)::bigint AS coach_payouts,
       coalesce((SELECT sum(amount_paise) FROM expenses WHERE voided_at IS NULL AND spent_on >= $1 AND spent_on < $2), 0)::bigint AS expenses,
       coalesce((SELECT sum(amount_paise) FROM fees WHERE waived_at IS NULL AND due_on >= $1 AND due_on < $2), 0)::bigint AS fees_raised`,
    [start, next],
  );
  const byMethod = await many(
    db,
    `SELECT method, sum(amount_paise)::bigint AS amount_paise FROM payments
      WHERE voided_at IS NULL AND paid_on >= $1 AND paid_on < $2 GROUP BY method ORDER BY 2 DESC`,
    [start, next],
  );
  const expenseByCategory = await many(
    db,
    `SELECT category, sum(amount_paise)::bigint AS amount_paise FROM expenses
      WHERE voided_at IS NULL AND spent_on >= $1 AND spent_on < $2 GROUP BY category ORDER BY 2 DESC`,
    [start, next],
  );
  const outstanding = await one(
    db,
    `SELECT coalesce(sum(greatest(f.amount_paise - coalesce(p.paid, 0), 0)), 0)::bigint AS total,
            count(*) FILTER (WHERE f.amount_paise > coalesce(p.paid, 0))::int AS fees
       FROM fees f LEFT JOIN (SELECT fee_id, sum(amount_paise) AS paid FROM payments WHERE voided_at IS NULL GROUP BY fee_id) p ON p.fee_id = f.id
      WHERE f.waived_at IS NULL`,
  );
  const n = (v: unknown) => Number(v);
  const received = n(money.received);
  const paidOut = n(money.coach_payouts);
  const expenses = n(money.expenses);
  return {
    month: m,
    sessions: { ...sessions, byCategory },
    coaches: coaches.map((c) => ({
      ...c,
      earned_paise: n(c.earned_paise),
      paid_paise: n(c.paid_paise),
      owed_paise: Math.max(0, n(c.earned_paise) - n(c.paid_paise)),
    })),
    money: {
      received_paise: received,
      coach_payouts_paise: paidOut,
      expenses_paise: expenses,
      settled_paise: paidOut + expenses,
      profit_paise: received - paidOut - expenses,
      fees_raised_paise: n(money.fees_raised),
      outstanding_paise: n(outstanding.total),
      outstanding_fees: outstanding.fees,
      byMethod: byMethod.map((r) => ({ ...r, amount_paise: n(r.amount_paise) })),
      expensesByCategory: expenseByCategory.map((r) => ({ ...r, amount_paise: n(r.amount_paise) })),
    },
  };
}

async function voidRow(table: 'payments' | 'coach_payouts' | 'expenses', actor: Actor, id: string, reason: string) {
  return tx(async (db) => {
    const before = await one(db, `SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
    if (!before) throw notFound('Record');
    if (before.voided_at) throw conflict('already_voided', 'This entry is already voided');
    const after = await one(db, `UPDATE ${table} SET voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1 RETURNING *`, [id, actor.userId, reason]);
    await audit(db, actor, `${table}_voided`, table, id, before, { reason });
    return after;
  });
}

export async function financeRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------ fees
  app.get('/v1/fees', async (req) => {
    adminOnly(actorOf(req));
    const q = parse(z.object({ playerId: z.uuid().optional(), open: z.enum(['true', 'false']).optional() }), req.query);
    const rows = await many(pool, `${FEE_SELECT} WHERE ($1::uuid IS NULL OR f.player_id = $1) ORDER BY f.due_on DESC, f.created_at DESC LIMIT 500`, [q.playerId ?? null]);
    const fees = rows.map(presentFee);
    return q.open === 'true' ? fees.filter((f) => f.balance_paise > 0) : fees;
  });

  app.post('/v1/players/:id/fees', async (req) => {
    const actor = actorOf(req);
    adminOnly(actor);
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ description: z.string().trim().min(2).max(200), amount: rupees, dueOn: isoDate, packageId: z.uuid().optional() }), req.body);
    return tx(async (db) => {
      if (!(await one(db, `SELECT 1 FROM players WHERE id = $1`, [id]))) throw notFound('Player');
      const fee = await createFee(db, actor, { playerId: id, packageId: body.packageId, description: body.description, amountPaise: body.amount, dueOn: body.dueOn });
      return presentFee(await one(db, `${FEE_SELECT} WHERE f.id = $1`, [fee.id]));
    });
  });

  app.post('/v1/fees/:id/waive', async (req) => {
    const actor = actorOf(req);
    adminOnly(actor);
    const { id } = parse(idParams, req.params);
    const { reason } = parse(voidBody, req.body);
    return tx(async (db) => {
      const before = await one(db, `SELECT * FROM fees WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('Fee');
      if (before.waived_at) throw conflict('already_waived', 'This fee is already waived');
      await db.query(`UPDATE fees SET waived_at = now(), waived_by = $2, waive_reason = $3 WHERE id = $1`, [id, actor.userId, reason]);
      await audit(db, actor, 'fee_waived', 'fee', id, before, { reason });
      return presentFee(await one(db, `${FEE_SELECT} WHERE f.id = $1`, [id]));
    });
  });

  // ------------------------------------------------------------- payments
  app.get('/v1/payments', async (req) => {
    adminOnly(actorOf(req));
    const q = parse(z.object({ month: month.optional(), playerId: z.uuid().optional() }), req.query);
    const b = q.month ? monthBounds(q.month) : null;
    return many(
      pool,
      `SELECT x.*, p.full_name AS player_name, f.description AS fee_description, u.display_name AS recorded_by_name
         FROM payments x JOIN players p ON p.id = x.player_id LEFT JOIN fees f ON f.id = x.fee_id JOIN users u ON u.id = x.recorded_by
        WHERE ($1::date IS NULL OR (x.paid_on >= $1 AND x.paid_on < $2)) AND ($3::uuid IS NULL OR x.player_id = $3)
        ORDER BY x.paid_on DESC, x.created_at DESC LIMIT 500`,
      [b?.start ?? null, b?.next ?? null, q.playerId ?? null],
    );
  });

  app.post('/v1/payments', async (req) => {
    const actor = actorOf(req);
    adminOnly(actor);
    const body = parse(
      z.object({
        playerId: z.uuid(),
        feeId: z.uuid().optional(),
        amount: rupees,
        paidOn: isoDate.default(() => localDate()),
        method,
        reference: z.string().trim().max(200).optional(),
        note: z.string().trim().max(500).optional(),
      }),
      req.body,
    );
    return tx(async (db) => {
      if (body.feeId) {
        const fee = await one(db, `SELECT * FROM fees WHERE id = $1`, [body.feeId]);
        if (!fee || fee.player_id !== body.playerId) throw badRequest('That fee is not for this player');
      }
      const p = await one(
        db,
        `INSERT INTO payments (player_id, fee_id, amount_paise, paid_on, method, reference, note, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [body.playerId, body.feeId ?? null, body.amount, body.paidOn, body.method, body.reference ?? null, body.note ?? null, actor.userId],
      );
      await audit(db, actor, 'payment_recorded', 'payment', p.id, null, p);
      return p;
    });
  });

  app.post('/v1/payments/:id/void', async (req) => {
    const actor = actorOf(req);
    adminOnly(actor);
    return voidRow('payments', actor, parse(idParams, req.params).id, parse(voidBody, req.body).reason);
  });

  // ------------------------------------------------------------ coach pay
  app.get('/v1/coach-rates', async (req) => {
    adminOnly(actorOf(req));
    return many(
      pool,
      `SELECT c.id AS coach_id, c.full_name,
              (SELECT amount_paise FROM coach_rates r WHERE r.coach_id = c.id AND r.category_id IS NULL) AS default_paise,
              coalesce((SELECT json_agg(json_build_object('categoryId', r.category_id, 'name', cat.name, 'amount_paise', r.amount_paise) ORDER BY cat.sort_order)
                          FROM coach_rates r JOIN session_categories cat ON cat.id = r.category_id WHERE r.coach_id = c.id), '[]') AS by_category
         FROM coaches c WHERE c.status = 'active' ORDER BY c.full_name`,
    );
  });

  app.put('/v1/coaches/:id/rates', async (req) => {
    const actor = actorOf(req);
    adminOnly(actor);
    const { id } = parse(idParams, req.params);
    const amount = z.number().min(0).max(1_000_000).transform((r) => Math.round(r * 100));
    const body = parse(z.object({ default: amount.nullable(), byCategory: z.array(z.object({ categoryId: z.uuid(), amount })).max(20).default([]) }), req.body);
    return tx(async (db) => {
      if (!(await one(db, `SELECT 1 FROM coaches WHERE id = $1`, [id]))) throw notFound('Coach');
      const before = await many(db, `SELECT category_id, amount_paise FROM coach_rates WHERE coach_id = $1`, [id]);
      await db.query(`DELETE FROM coach_rates WHERE coach_id = $1`, [id]);
      if (body.default !== null) {
        await db.query(`INSERT INTO coach_rates (coach_id, category_id, amount_paise, updated_by) VALUES ($1, NULL, $2, $3)`, [id, body.default, actor.userId]);
      }
      for (const r of body.byCategory) {
        await db.query(`INSERT INTO coach_rates (coach_id, category_id, amount_paise, updated_by) VALUES ($1, $2, $3, $4)`, [id, r.categoryId, r.amount, actor.userId]);
      }
      await audit(db, actor, 'coach_rates_changed', 'coach', id, before, body);
      return { ok: true };
    });
  });

  app.get('/v1/coach-payouts', async (req) => {
    adminOnly(actorOf(req));
    const q = parse(z.object({ month: month.optional(), coachId: z.uuid().optional() }), req.query);
    return many(
      pool,
      `SELECT x.*, c.full_name AS coach_name FROM coach_payouts x JOIN coaches c ON c.id = x.coach_id
        WHERE ($1::date IS NULL OR x.for_month = $1::date) AND ($2::uuid IS NULL OR x.coach_id = $2)
        ORDER BY x.paid_on DESC LIMIT 500`,
      [q.month ? `${q.month}-01` : null, q.coachId ?? null],
    );
  });

  app.post('/v1/coach-payouts', async (req) => {
    const actor = actorOf(req);
    adminOnly(actor);
    const body = parse(
      z.object({ coachId: z.uuid(), amount: rupees, forMonth: month, paidOn: isoDate.default(() => localDate()), method, reference: z.string().max(200).optional(), note: z.string().max(500).optional() }),
      req.body,
    );
    return tx(async (db) => {
      const p = await one(
        db,
        `INSERT INTO coach_payouts (coach_id, amount_paise, for_month, paid_on, method, reference, note, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [body.coachId, body.amount, `${body.forMonth}-01`, body.paidOn, body.method, body.reference ?? null, body.note ?? null, actor.userId],
      );
      await audit(db, actor, 'coach_payout_recorded', 'coach_payout', p.id, null, p);
      return p;
    });
  });

  app.post('/v1/coach-payouts/:id/void', async (req) => {
    const actor = actorOf(req);
    adminOnly(actor);
    return voidRow('coach_payouts', actor, parse(idParams, req.params).id, parse(voidBody, req.body).reason);
  });

  // ------------------------------------------------------------- expenses
  app.get('/v1/expenses', async (req) => {
    adminOnly(actorOf(req));
    const q = parse(z.object({ month: month.optional() }), req.query);
    const b = q.month ? monthBounds(q.month) : null;
    return many(
      pool,
      `SELECT * FROM expenses WHERE ($1::date IS NULL OR (spent_on >= $1 AND spent_on < $2)) ORDER BY spent_on DESC, created_at DESC LIMIT 500`,
      [b?.start ?? null, b?.next ?? null],
    );
  });

  app.post('/v1/expenses', async (req) => {
    const actor = actorOf(req);
    adminOnly(actor);
    const body = parse(
      z.object({
        category: z.enum(['ground', 'equipment', 'travel', 'staff', 'utilities', 'other']),
        description: z.string().trim().min(2).max(200),
        amount: rupees,
        spentOn: isoDate.default(() => localDate()),
        method,
        reference: z.string().max(200).optional(),
      }),
      req.body,
    );
    return tx(async (db) => {
      const e = await one(
        db,
        `INSERT INTO expenses (category, description, amount_paise, spent_on, method, reference, recorded_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [body.category, body.description, body.amount, body.spentOn, body.method, body.reference ?? null, actor.userId],
      );
      await audit(db, actor, 'expense_recorded', 'expense', e.id, null, e);
      return e;
    });
  });

  app.post('/v1/expenses/:id/void', async (req) => {
    const actor = actorOf(req);
    adminOnly(actor);
    return voidRow('expenses', actor, parse(idParams, req.params).id, parse(voidBody, req.body).reason);
  });

  // --------------------------------------------------------- month summary
  app.get('/v1/finance/month', async (req) => {
    adminOnly(actorOf(req));
    const q = parse(z.object({ month: month.default(() => localDate().slice(0, 7)) }), req.query);
    return monthSummary(pool, q.month);
  });
}
