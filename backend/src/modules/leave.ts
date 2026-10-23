import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { Db, many, one, pool, tx } from '../db.js';
import { Actor } from '../lib/actor.js';
import { audit } from '../lib/audit.js';
import { when } from '../lib/coaching.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { actorOf, idParams, isoDate, isoDateTime, parse } from '../lib/http.js';
import { adminUsers, notifyUsers } from '../lib/notify.js';
import { localDate } from '../lib/time.js';

const TZ = config.timeZone;

// Coach leave. Planned time off and same-morning emergencies are both kept on
// record; cancelling leave marks it cancelled rather than deleting it. Leave
// never silently moves sessions: affected sessions are listed for the admin to
// reassign or cancel.

function canManageLeave(actor: Actor, coachId: string) {
  if (actor.role === 'admin') return;
  if (actor.role === 'coach' && actor.profileId === coachId) return;
  throw forbidden('Coaches can only record their own leave');
}

async function affectedSessions(db: Db, coachId: string, startsAt: Date | string, endsAt: Date | string) {
  return many(
    db,
    `SELECT s.id, s.starts_at, s.ends_at, s.title, s.session_type, cat.name AS category_name,
            (SELECT count(*) FROM bookings b WHERE b.session_id = s.id AND b.status IN ('pending', 'confirmed'))::int AS players
       FROM sessions s JOIN session_coaches sc ON sc.session_id = s.id AND sc.active AND sc.coach_id = $1
       JOIN session_categories cat ON cat.id = s.category_id
      WHERE s.status IN ('scheduled', 'in_progress') AND s.ends_at > now() AND s.during && tstzrange($2, $3, '[)')
      ORDER BY s.starts_at`,
    [coachId, startsAt, endsAt],
  );
}

const LEAVE_SELECT = `
  SELECT l.id, l.coach_id, c.full_name AS coach_name, l.starts_at, l.ends_at, l.kind, l.reason, l.status,
         l.created_at, ru.display_name AS recorded_by_name, l.recorded_by, l.cancelled_at, cu.display_name AS cancelled_by_name
    FROM coach_leave l JOIN coaches c ON c.id = l.coach_id JOIN users ru ON ru.id = l.recorded_by
    LEFT JOIN users cu ON cu.id = l.cancelled_by`;

export async function leaveRoutes(app: FastifyInstance) {
  app.post('/v1/coaches/:id/leave', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    canManageLeave(actor, id);
    const body = parse(
      z.object({
        kind: z.enum(['planned', 'emergency']),
        // Either exact times, or whole days from `date` to `untilDate`.
        startsAt: isoDateTime.optional(),
        endsAt: isoDateTime.optional(),
        date: isoDate.optional(),
        untilDate: isoDate.optional(),
        reason: z.string().trim().max(500).optional(),
      }),
      req.body,
    );
    return tx(async (db) => {
      const coach = await one(db, `SELECT * FROM coaches WHERE id = $1`, [id]);
      if (!coach) throw notFound('Coach');
      let range: { s: Date; e: Date };
      if (body.startsAt && body.endsAt) {
        range = { s: new Date(body.startsAt), e: new Date(body.endsAt) };
      } else if (body.date || body.kind === 'emergency') {
        // Whole local days. An emergency with no dates means "from now until the end of today".
        const from = body.date ?? localDate();
        const until = body.untilDate ?? from;
        if (until < from) throw badRequest('The last day must be on or after the first');
        const r = await one(
          db,
          `SELECT ($1::date::timestamp AT TIME ZONE $3) AS s, (($2::date + 1)::timestamp AT TIME ZONE $3) AS e`,
          [from, until, TZ],
        );
        range = { s: !body.date && body.kind === 'emergency' ? new Date() : r.s, e: r.e };
      } else {
        throw badRequest('Give the leave times or the days');
      }
      if (range.e <= range.s) throw badRequest('Leave must end after it starts');
      if (range.e.getTime() - range.s.getTime() > 120 * 86400_000) throw badRequest('Leave can be recorded at most 120 days at a time');
      const leave = await one(
        db,
        `INSERT INTO coach_leave (coach_id, starts_at, ends_at, kind, reason, recorded_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, range.s, range.e, body.kind, body.reason ?? null, actor.userId],
      );
      const affected = await affectedSessions(db, id, range.s, range.e);
      await audit(db, actor, 'coach_leave_recorded', 'coach_leave', leave.id, null, { ...leave, affected: affected.length });
      const period = `${when(range.s)} to ${when(range.e)}`;
      const sessionsLine = affected.length
        ? `${affected.length} session${affected.length === 1 ? ' needs' : 's need'} another coach.`
        : 'No sessions are affected.';
      await notifyUsers(db, (await adminUsers(db)).filter((u) => u !== actor.userId), {
        kind: body.kind === 'emergency' ? 'coach_emergency_leave' : 'coach_leave',
        title: body.kind === 'emergency' ? `Emergency: ${coach.full_name} can't come in` : `${coach.full_name} is on leave`,
        body: `${period}.${body.reason ? ` ${body.reason}.` : ''} ${sessionsLine}`,
        data: { leaveId: leave.id, coachId: id },
      });
      if (actor.role === 'admin' && coach.user_id) {
        await notifyUsers(db, [coach.user_id], { kind: 'coach_leave', title: 'Leave recorded for you', body: period, data: { leaveId: leave.id } });
      }
      return { leave: await one(db, `${LEAVE_SELECT} WHERE l.id = $1`, [leave.id]), affectedSessions: affected };
    });
  });

  app.get('/v1/coaches/:id/leave', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    canManageLeave(actor, id);
    return many(pool, `${LEAVE_SELECT} WHERE l.coach_id = $1 AND l.ends_at > now() - interval '180 days' ORDER BY l.starts_at DESC`, [id]);
  });

  // The leave record for the whole academy, for the admin.
  app.get('/v1/leave', async (req) => {
    const actor = actorOf(req);
    if (actor.role !== 'admin') throw forbidden();
    const q = parse(z.object({ from: isoDateTime.optional(), to: isoDateTime.optional() }), req.query);
    const rows = await many(
      pool,
      `${LEAVE_SELECT} WHERE l.during && tstzrange($1, $2, '[)') ORDER BY l.starts_at DESC LIMIT 500`,
      [q.from ?? new Date(Date.now() - 30 * 86400_000).toISOString(), q.to ?? new Date(Date.now() + 90 * 86400_000).toISOString()],
    );
    const out = [];
    for (const r of rows) {
      out.push({ ...r, affectedSessions: r.status === 'active' ? (await affectedSessions(pool, r.coach_id, r.starts_at, r.ends_at)).length : 0 });
    }
    return out;
  });

  app.post('/v1/leave/:id/cancel', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    return tx(async (db) => {
      const before = await one(db, `SELECT * FROM coach_leave WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('Leave');
      canManageLeave(actor, before.coach_id);
      if (before.status === 'cancelled') throw conflict('already_cancelled', 'This leave is already cancelled');
      await db.query(`UPDATE coach_leave SET status = 'cancelled', cancelled_by = $2, cancelled_at = now() WHERE id = $1`, [id, actor.userId]);
      await audit(db, actor, 'coach_leave_cancelled', 'coach_leave', id, before, { status: 'cancelled' });
      const coach = await one(db, `SELECT full_name FROM coaches WHERE id = $1`, [before.coach_id]);
      await notifyUsers(db, (await adminUsers(db)).filter((u) => u !== actor.userId), {
        kind: 'coach_leave_cancelled',
        title: `${coach.full_name} is available again`,
        body: `Leave from ${when(before.starts_at)} to ${when(before.ends_at)} was cancelled.`,
        data: { leaveId: id, coachId: before.coach_id },
      });
      return one(db, `${LEAVE_SELECT} WHERE l.id = $1`, [id]);
    });
  });
}
