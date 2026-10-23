import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { Db, many, one, pool, tx } from '../db.js';
import { Actor } from '../lib/actor.js';
import { audit } from '../lib/audit.js';
import { isGuardianOf, requireSessionStaff } from '../lib/authz.js';
import { categoryCoachIds, coachStates, isFree, when } from '../lib/coaching.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { actorOf, idParams, isoDate, isoDateTime, parse } from '../lib/http.js';
import { adminUsers, guardianUsers, notifyUsers, playerAudience } from '../lib/notify.js';
import { getPolicy, Policy } from '../lib/settings.js';
import { ADULT_AGE, ageOn } from '../lib/time.js';
import { packageForSession, packageSummary, partFor } from './credits.js';
import { attempt, insertSession } from './sessions.js';

const TZ = config.timeZone;

// Sessions a player or parent asks for at a time of their choosing (mostly
// one-on-ones). The request goes to the first free coach in the category's
// priority order; that coach or an admin confirms it. If the coach can't take
// it they pass it on to the next free coach in line.

async function canRequestFor(db: Db, actor: Actor, playerId: string) {
  if (actor.role === 'admin' || actor.role === 'coach') return;
  if (actor.role === 'player' && actor.profileId === playerId) return;
  if (await isGuardianOf(db, actor, playerId, { canBook: true })) return;
  throw forbidden('You cannot request sessions for this player');
}

async function requestableCategory(db: Db, id: string) {
  const cat = await one(db, `SELECT * FROM session_categories WHERE id = $1 AND active`, [id]);
  if (!cat) throw notFound('Category');
  if (!cat.requestable) throw badRequest(`${cat.name} sessions can't be requested at a chosen time`);
  return cat;
}

function checkTiming(actor: Actor, policy: Policy, startsAt: Date) {
  const staff = actor.role === 'admin' || actor.role === 'coach';
  const now = Date.now();
  if (startsAt.getTime() <= now) throw badRequest('That time has already passed');
  if (staff) return;
  if (startsAt.getTime() < now + policy.booking.minNoticeHours * 3600_000) {
    throw conflict('booking_not_allowed', `Requests must be made at least ${policy.booking.minNoticeHours} hours ahead`);
  }
  if (startsAt.getTime() > now + policy.booking.maxAdvanceDays * 86400_000) {
    throw conflict('booking_not_allowed', `Sessions can be requested up to ${policy.booking.maxAdvanceDays} days ahead`);
  }
}

// Free coaches for a slot, in priority order, skipping any who passed it on.
async function freeCoaches(db: Db, cat: any, startsAt: Date, endsAt: Date, policy: Policy, skip: string[] = [], ignoreSessionId: string | null = null) {
  const ids = (await categoryCoachIds(db, cat.id)).filter((c) => !skip.includes(c));
  if (!ids.length) return [];
  const states = await coachStates(db, { coachIds: ids, categoryId: cat.id, startsAt, endsAt, ignoreSessionId, policy });
  return states.filter(isFree);
}

async function playerBusy(db: Db, playerId: string, startsAt: Date, endsAt: Date) {
  return !!(await one(
    db,
    `SELECT 1 FROM bookings WHERE player_id = $1 AND status IN ('pending', 'confirmed') AND during && tstzrange($2, $3, '[)') LIMIT 1`,
    [playerId, startsAt, endsAt],
  ));
}

async function creditReason(db: Db, playerId: string, startsAt: Date, cat: any): Promise<string | null> {
  const pkg = await packageForSession(db, playerId, startsAt, null, cat.id);
  if (!pkg) return `No active package covers ${cat.name} sessions on this date`;
  if (pkg.kind !== 'fixed') return null;
  const summary = await packageSummary(db, pkg);
  const part = partFor(summary, cat.id);
  const available = part ? part.available_to_book : summary.available_to_book;
  return available > 0 ? null : `No ${cat.name} sessions left in the package`;
}

export async function requestRoutes(app: FastifyInstance) {
  // Times on one day when at least one coach for the category is free.
  app.get('/v1/session-requests/slots', async (req) => {
    const actor = actorOf(req);
    const q = parse(z.object({ playerId: z.uuid(), categoryId: z.uuid(), date: isoDate }), req.query);
    await canRequestFor(pool, actor, q.playerId);
    const cat = await requestableCategory(pool, q.categoryId);
    const policy = await getPolicy(pool);
    const coachIds = await categoryCoachIds(pool, cat.id);
    if (!coachIds.length) return { slots: [], message: `No coaches are set up for ${cat.name} sessions yet` };
    // The earliest and latest hours any of these coaches work that weekday.
    const bounds = await one(
      pool,
      `SELECT least($2::time, min(a.start_time)) AS first, greatest($3::time, max(a.end_time)) AS last
         FROM coach_availability a WHERE a.coach_id = ANY($1) AND a.weekday = extract(isodow FROM $4::date)`,
      [coachIds, policy.requests.openFrom, policy.requests.openUntil, q.date],
    );
    const starts = await many(
      pool,
      `SELECT g AS starts_at, g + make_interval(mins => $4) AS ends_at
         FROM generate_series(($1::date + $2::time) AT TIME ZONE $6, ($1::date + $3::time) AT TIME ZONE $6 - make_interval(mins => $4),
                              make_interval(mins => $5)) g`,
      [q.date, bounds.first, bounds.last, cat.default_minutes, policy.requests.slotStepMinutes, TZ],
    );
    const staff = actor.role === 'admin' || actor.role === 'coach';
    const earliest = Date.now() + (staff ? 0 : policy.booking.minNoticeHours * 3600_000);
    const latest = staff ? Infinity : Date.now() + policy.booking.maxAdvanceDays * 86400_000;
    const slots = [];
    for (const s of starts) {
      const t = s.starts_at.getTime();
      if (t < earliest || t > latest) continue;
      if (await playerBusy(pool, q.playerId, s.starts_at, s.ends_at)) continue;
      const free = await freeCoaches(pool, cat, s.starts_at, s.ends_at, policy);
      if (free.length) slots.push({ startsAt: s.starts_at, endsAt: s.ends_at, coaches: free.map((c) => ({ id: c.id, full_name: c.full_name })) });
    }
    return { slots, minutes: cat.default_minutes };
  });

  app.post('/v1/session-requests', async (req) => {
    const actor = actorOf(req);
    const body = parse(
      z.object({
        playerId: z.uuid(),
        categoryId: z.uuid(),
        startsAt: isoDateTime,
        // A coach the family would like; otherwise the first free coach in line.
        coachId: z.uuid().optional(),
        note: z.string().trim().max(500).optional(),
        clientRequestId: z.uuid().optional(),
      }),
      req.body,
    );
    return tx(async (db) => {
      if (body.clientRequestId) {
        const existing = await one(db, `SELECT * FROM bookings WHERE client_request_id = $1`, [body.clientRequestId]);
        if (existing) return { booking: existing, session: await one(db, `SELECT * FROM sessions WHERE id = $1`, [existing.session_id]) };
      }
      await canRequestFor(db, actor, body.playerId);
      const cat = await requestableCategory(db, body.categoryId);
      const player = await one(db, `SELECT * FROM players WHERE id = $1`, [body.playerId]);
      if (!player || player.status !== 'active') throw notFound('Player');
      const policy = await getPolicy(db);
      const startsAt = new Date(body.startsAt);
      const endsAt = new Date(startsAt.getTime() + cat.default_minutes * 60_000);
      checkTiming(actor, policy, startsAt);
      if (await playerBusy(db, player.id, startsAt, endsAt)) throw conflict('player_double_booked', `${player.full_name} already has a session or request at this time`);

      let candidates = await freeCoaches(db, cat, startsAt, endsAt, policy);
      if (body.coachId) {
        candidates = candidates.filter((c) => c.id === body.coachId);
        if (!candidates.length) throw conflict('coach_not_free', "That coach isn't free at this time. Pick another time or let the academy choose.");
      }
      if (!candidates.length) throw conflict('no_coach_free', `No ${cat.name} coach is free at this time`);
      // Two families can ask for the same coach at once; if the database refuses
      // the first choice, the next coach in line gets it.
      let session: any = null;
      let coach: any = null;
      for (const c of candidates) {
        const r = await attempt(db as PoolClient, () =>
          insertSession(db, actor, {
            sessionType: cat.session_type, categoryId: cat.id, bookingMode: 'fixed', title: cat.name, coachIds: [c.id],
            startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), origin: 'request',
            trainingFocus: body.note ?? null, capacity: undefined,
          }),
        );
        if (r.ok) {
          session = r.value;
          coach = c;
          break;
        }
        if (r.error.code !== 'coach_double_booked') throw r.error;
      }
      if (!session) throw conflict('no_coach_free', `No ${cat.name} coach is free at this time`);

      const approvals = ['staff'];
      if (actor.role === 'player' && ageOn(player.date_of_birth) < ADULT_AGE && policy.booking.guardianApprovalForMinorRequests) approvals.unshift('guardian');
      const reasons = [`Requested time with ${coach.full_name}: needs confirming`];
      const credit = await creditReason(db, player.id, startsAt, cat);
      if (credit) reasons.push(credit);
      const booking = await one(
        db,
        `INSERT INTO bookings (session_id, player_id, status, source, approvals_needed, review_reasons, during, requested_by, client_request_id)
         VALUES ($1, $2, 'pending', 'request', $3, $4, $5, $6, $7) RETURNING *`,
        [session.id, player.id, approvals, reasons, session.during, actor.userId, body.clientRequestId ?? null],
      );
      await audit(db, actor, 'session_requested', 'booking', booking.id, null, { sessionId: session.id, coachId: coach.id, category: cat.code, startsAt });
      const label = `${cat.name} for ${player.full_name}, ${when(startsAt)}`;
      const data = { bookingId: booking.id, sessionId: session.id };
      await notifyUsers(db, [...(coach.user_id ? [coach.user_id] : []), ...(await adminUsers(db))].filter((u) => u !== actor.userId), {
        kind: 'session_request', title: `New request: ${cat.name}`, body: `${label} with ${coach.full_name}.${credit ? ` ${credit}.` : ''}`, data,
      });
      if (approvals.includes('guardian')) {
        await notifyUsers(db, await guardianUsers(db, player.id), { kind: 'booking_needs_guardian', title: 'Session request needs your approval', body: label, data });
      }
      await notifyUsers(db, (await playerAudience(db, [player.id])).filter((u) => u !== actor.userId), {
        kind: 'session_request_sent', title: 'Session requested', body: `${label} with ${coach.full_name}. Waiting for confirmation.`, data,
      });
      return { booking, session, coach: { id: coach.id, full_name: coach.full_name } };
    });
  });

  // The assigned coach can't take it: offer it to the next free coach in line.
  // If nobody is free, the request is declined and the family is told.
  app.post('/v1/session-requests/:id/pass', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
    return tx(async (db) => {
      const booking = await one(db, `SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [id]);
      if (!booking) throw notFound('Request');
      await requireSessionStaff(db, actor, booking.session_id);
      const session = await one(db, `SELECT * FROM sessions WHERE id = $1 FOR UPDATE`, [booking.session_id]);
      if (session.origin !== 'request' || booking.status !== 'pending') throw conflict('not_pending', 'Only a pending requested session can be passed on');
      const current = (await many(db, `SELECT coach_id FROM session_coaches WHERE session_id = $1 AND active`, [session.id])).map((r) => r.coach_id);
      const skip = [...new Set([...session.passed_coach_ids, ...current])];
      const cat = await one(db, `SELECT * FROM session_categories WHERE id = $1`, [session.category_id]);
      const player = await one(db, `SELECT full_name FROM players WHERE id = $1`, [booking.player_id]);
      const label = `${cat.name} for ${player.full_name}, ${when(session.starts_at)}`;
      const next = (await freeCoaches(db, cat, session.starts_at, session.ends_at, await getPolicy(db), skip, session.id))[0];
      await db.query(`UPDATE sessions SET passed_coach_ids = $2, version = version + 1 WHERE id = $1`, [session.id, skip]);
      await db.query(`UPDATE session_coaches SET active = false WHERE session_id = $1`, [session.id]);
      const family = await playerAudience(db, [booking.player_id]);
      const data = { bookingId: id, sessionId: session.id };
      if (!next) {
        const updated = await one(
          db,
          `UPDATE bookings SET status = 'rejected', decision_reason = 'No coach is free at that time', decided_by = $2, decided_at = now() WHERE id = $1 RETURNING *`,
          [id, actor.userId],
        );
        await db.query(`UPDATE sessions SET status = 'cancelled', cancellation_reason = 'No coach free for the request' WHERE id = $1`, [session.id]);
        await audit(db, actor, 'session_request_passed', 'booking', id, { coachIds: current }, { outcome: 'no_coach', reason: body.reason });
        await notifyUsers(db, family, { kind: 'booking_rejected', title: 'Request not accepted', body: `${label}. No coach is free at that time; please pick another time.`, data });
        await notifyUsers(db, (await adminUsers(db)).filter((u) => u !== actor.userId), { kind: 'session_request', title: 'Request declined: no coach free', body: label, data });
        return { booking: updated, coach: null };
      }
      await db.query(
        `INSERT INTO session_coaches (session_id, coach_id, during) VALUES ($1, $2, $3)
         ON CONFLICT (session_id, coach_id) DO UPDATE SET active = true`,
        [session.id, next.id, session.during],
      );
      const reasons = booking.review_reasons.map((r: string) => (r.startsWith('Requested time with') ? `Requested time with ${next.full_name}: needs confirming` : r));
      const updated = await one(db, `UPDATE bookings SET review_reasons = $2 WHERE id = $1 RETURNING *`, [id, reasons]);
      await audit(db, actor, 'session_request_passed', 'booking', id, { coachIds: current }, { coachId: next.id, reason: body.reason });
      await notifyUsers(db, [...(next.user_id ? [next.user_id] : []), ...(await adminUsers(db))].filter((u) => u !== actor.userId), {
        kind: 'session_request', title: `Request passed to ${next.full_name}`, body: label, data,
      });
      await notifyUsers(db, family, { kind: 'coach_changed', title: 'Your request moved to another coach', body: `${label} is now with ${next.full_name}. Still waiting for confirmation.`, data });
      return { booking: updated, coach: { id: next.id, full_name: next.full_name } };
    });
  });
}
