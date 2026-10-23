import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { Db, many, one, pool, tx } from '../db.js';
import { Actor } from '../lib/actor.js';
import { audit } from '../lib/audit.js';
import { isGuardianOf, isSessionCoach, requireSessionStaff } from '../lib/authz.js';
import { conflict, forbidden, fromPgError, notFound } from '../lib/errors.js';
import { actorOf, idParams, parse } from '../lib/http.js';
import { adminUsers, guardianUsers, notifyUsers, playerAudience, sessionCoachUsers } from '../lib/notify.js';
import { getPolicy, Policy } from '../lib/settings.js';
import { ADULT_AGE, ageOn } from '../lib/time.js';
import { packageForSession, packageSummary, partFor } from './credits.js';

const when = (d: Date) => new Date(d).toLocaleString('en-IN', { timeZone: config.timeZone, dateStyle: 'medium', timeStyle: 'short' });

export const bookingInput = z.object({
  sessionId: z.uuid(),
  playerId: z.uuid(),
  // Lets a device retry the same request (e.g. after going offline) without duplicating it.
  clientRequestId: z.uuid().optional(),
  // Staff only: book straight in, skipping approval rules (capacity and clashes still apply).
  direct: z.boolean().default(false),
  walkIn: z.boolean().default(false),
  isMakeup: z.boolean().default(false),
  note: z.string().max(500).optional(),
});
export type BookingInput = z.infer<typeof bookingInput>;

interface Evaluation {
  reject?: string;
  approvalsNeeded: string[];
  reviewReasons: string[];
}

// The auto-confirm rules. A request is confirmed automatically only when no
// rule asks for a person to look at it.
async function evaluate(db: Db, actor: Actor, session: any, player: any, policy: Policy, input: BookingInput): Promise<Evaluation> {
  const approvalsNeeded: string[] = [];
  const reviewReasons: string[] = [];
  const now = Date.now();
  const starts = new Date(session.starts_at).getTime();

  if (session.status !== 'scheduled') return { reject: 'This session is not open for booking', approvalsNeeded, reviewReasons };
  if (player.status !== 'active') return { reject: 'This player is not active', approvalsNeeded, reviewReasons };
  const staff = actor.role === 'admin' || actor.role === 'coach';
  if (!staff) {
    if (session.booking_mode !== 'open') return { reject: 'This session is not open for requests', approvalsNeeded, reviewReasons };
    if (starts < now + policy.booking.minNoticeHours * 3600_000) {
      return { reject: `Requests must be made at least ${policy.booking.minNoticeHours} hours before the session`, approvalsNeeded, reviewReasons };
    }
    if (starts > now + policy.booking.maxAdvanceDays * 86400_000) {
      return { reject: `Sessions can be requested up to ${policy.booking.maxAdvanceDays} days ahead`, approvalsNeeded, reviewReasons };
    }
  } else if (!input.walkIn && starts < now - 3600_000) {
    return { reject: 'This session has already started', approvalsNeeded, reviewReasons };
  }
  const clash = await one(
    db,
    `SELECT 1 FROM bookings WHERE player_id = $1 AND status = 'confirmed' AND during && $2 AND session_id <> $3`,
    [player.id, session.during, session.id],
  );
  if (clash) return { reject: 'The player already has a confirmed session at this time', approvalsNeeded, reviewReasons };

  if (input.direct || input.walkIn) return { approvalsNeeded, reviewReasons };

  if (actor.role === 'player' && ageOn(player.date_of_birth) < ADULT_AGE && policy.booking.guardianApprovalForMinorRequests) {
    approvalsNeeded.push('guardian');
  }
  if (policy.booking.approvalRequired[session.session_type as keyof Policy['booking']['approvalRequired']]) {
    const label = { group: 'Group', one_on_one: 'One-on-one', one_on_two: 'One-on-two' }[session.session_type as string];
    reviewReasons.push(`${label} sessions need approval`);
  }
  const strictCoach = await one(
    db,
    `SELECT c.full_name FROM session_coaches sc JOIN coaches c ON c.id = sc.coach_id
      WHERE sc.session_id = $1 AND sc.active AND c.requires_booking_approval LIMIT 1`,
    [session.id],
  );
  if (strictCoach) reviewReasons.push(`${strictCoach.full_name} reviews their bookings`);
  if (policy.booking.requireCreditsForAutoConfirm && !input.isMakeup) {
    const pkg = await packageForSession(db, player.id, session.starts_at, null, session.category_id);
    if (!pkg) reviewReasons.push('No active training package covers this session');
    else if (pkg.kind === 'fixed') {
      const summary = await packageSummary(db, pkg);
      const part = partFor(summary, session.category_id);
      if (((part ? part.available_to_book : summary.available_to_book) ?? 0) <= 0) {
        reviewReasons.push(part ? `No unreserved ${part.category_name} sessions left in the package` : 'No unreserved sessions left in the package');
      }
    }
  }
  if (reviewReasons.length) approvalsNeeded.push('staff');
  return { approvalsNeeded, reviewReasons };
}

async function placeOrWaitlist(db: PoolClient, bookingId: string, session: any, policy: Policy) {
  const taken = await one(db, `SELECT count(*)::int AS n FROM bookings WHERE session_id = $1 AND status IN ('confirmed', 'completed')`, [session.id]);
  if (taken.n < session.capacity) {
    return one(db, `UPDATE bookings SET status = 'confirmed', waitlist_position = NULL, decided_at = now() WHERE id = $1 RETURNING *`, [bookingId]);
  }
  if (!policy.booking.waitlistEnabled) {
    return one(db, `UPDATE bookings SET status = 'rejected', decision_reason = 'Session is full', decided_at = now() WHERE id = $1 RETURNING *`, [bookingId]);
  }
  const pos = await one(db, `SELECT coalesce(max(waitlist_position), 0) + 1 AS p FROM bookings WHERE session_id = $1 AND status = 'waitlisted'`, [session.id]);
  return one(db, `UPDATE bookings SET status = 'waitlisted', waitlist_position = $2 WHERE id = $1 RETURNING *`, [bookingId, pos.p]);
}

async function notifyOutcome(db: Db, booking: any, session: any) {
  const audience = await playerAudience(db, [booking.player_id]);
  const label = `${session.title ?? session.session_type.replaceAll('_', ' ')} on ${when(session.starts_at)}`;
  if (booking.status === 'confirmed') {
    await notifyUsers(db, audience, { kind: 'booking_confirmed', title: 'Booking confirmed', body: label, data: { bookingId: booking.id, sessionId: session.id } });
    if (session.origin === 'request') {
      // A requested time is only real once confirmed: the coach and the academy hear too.
      const player = await one(db, `SELECT full_name FROM players WHERE id = $1`, [booking.player_id]);
      await notifyUsers(db, [...(await sessionCoachUsers(db, session.id)), ...(await adminUsers(db))], {
        kind: 'booking_confirmed', title: 'Requested session confirmed', body: `${player.full_name}: ${label}`, data: { bookingId: booking.id, sessionId: session.id },
      });
    }
  } else if (booking.status === 'waitlisted') {
    await notifyUsers(db, audience, { kind: 'booking_waitlisted', title: 'Added to waitlist', body: `${label}. You are number ${booking.waitlist_position}.`, data: { bookingId: booking.id } });
  } else if (booking.status === 'rejected') {
    await notifyUsers(db, audience, { kind: 'booking_rejected', title: 'Booking not accepted', body: `${label}. ${booking.decision_reason ?? ''}`.trim(), data: { bookingId: booking.id } });
  } else if (booking.status === 'pending') {
    if (booking.approvals_needed.includes('guardian')) {
      await notifyUsers(db, await guardianUsers(db, booking.player_id), { kind: 'booking_needs_guardian', title: 'Booking request needs your approval', body: label, data: { bookingId: booking.id } });
    } else if (booking.approvals_needed.includes('staff')) {
      await notifyUsers(db, [...(await sessionCoachUsers(db, session.id)), ...(await adminUsers(db))], {
        kind: 'booking_needs_review', title: 'Booking request awaiting approval', body: `${label}: ${booking.review_reasons.join('; ')}`, data: { bookingId: booking.id },
      });
    }
  }
}

// Used by the API and by offline sync. Offline requests come through here too,
// so they are validated against the live state only when they reach the server.
export async function requestBooking(db: PoolClient, actor: Actor, input: BookingInput) {
  if (input.clientRequestId) {
    const existing = await one(db, `SELECT * FROM bookings WHERE client_request_id = $1`, [input.clientRequestId]);
    if (existing) return existing;
  }
  const staff = actor.role === 'admin' || (await isSessionCoach(db, actor, input.sessionId));
  if (input.direct || input.walkIn || input.isMakeup) {
    if (!staff) throw forbidden('Only the session coach or an admin can book players in directly');
  } else if (!(actor.role === 'player' && actor.profileId === input.playerId) && !(await isGuardianOf(db, actor, input.playerId, { canBook: true })) && !staff) {
    throw forbidden('You cannot request bookings for this player');
  }
  // Lock the session so concurrent requests for the last place are decided one at a time.
  const session = await one(db, `SELECT * FROM sessions WHERE id = $1 FOR UPDATE`, [input.sessionId]);
  if (!session) throw notFound('Session');
  const player = await one(db, `SELECT * FROM players WHERE id = $1`, [input.playerId]);
  if (!player) throw notFound('Player');
  const policy = await getPolicy(db);
  if (input.walkIn && !policy.attendance.allowWalkIns) throw forbidden('Walk-ins are turned off');
  const ev = await evaluate(db, actor, session, player, policy, input);
  if (ev.reject) throw conflict('booking_not_allowed', ev.reject);

  const source = input.walkIn ? 'walk_in' : input.isMakeup ? 'makeup' : input.direct ? 'direct' : 'request';
  let booking;
  try {
    booking = await one(
      db,
      `INSERT INTO bookings (session_id, player_id, status, source, approvals_needed, review_reasons, is_makeup, during, requested_by, client_request_id)
       VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [session.id, player.id, source, ev.approvalsNeeded, ev.reviewReasons, input.isMakeup, session.during, actor.userId, input.clientRequestId ?? null],
    );
  } catch (err) {
    throw fromPgError(err) ?? err;
  }
  if (ev.approvalsNeeded.length === 0) {
    if (input.direct || input.walkIn || input.isMakeup) {
      // Staff bookings never go to the waitlist: either there's room or it fails.
      try {
        booking = await one(db, `UPDATE bookings SET status = 'confirmed', decided_by = $2, decided_at = now() WHERE id = $1 RETURNING *`, [booking.id, actor.userId]);
      } catch (err) {
        throw fromPgError(err) ?? err;
      }
    } else {
      booking = await placeOrWaitlist(db, booking.id, session, policy);
    }
  }
  await audit(db, actor, 'booking_created', 'booking', booking.id, null, { status: booking.status, source, approvals: ev.approvalsNeeded, reasons: ev.reviewReasons });
  await notifyOutcome(db, booking, session);
  return booking;
}

// A session that only existed because someone asked for it goes away (as
// cancelled, so the coach's time is free again) once its request is gone.
async function closeRequestedSession(db: PoolClient, session: any, reason: string) {
  if (session.origin !== 'request' || session.status !== 'scheduled') return;
  const live = await one(db, `SELECT 1 FROM bookings WHERE session_id = $1 AND status IN ('pending', 'waitlisted', 'confirmed') LIMIT 1`, [session.id]);
  if (live) return;
  await db.query(`UPDATE sessions SET status = 'cancelled', cancellation_reason = $2, version = version + 1 WHERE id = $1`, [session.id, reason]);
}

async function promoteWaitlist(db: PoolClient, actor: Actor, sessionId: string) {
  const session = await one(db, `SELECT * FROM sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
  if (!session || session.status !== 'scheduled') return;
  const policy = await getPolicy(db);
  for (;;) {
    const taken = await one(db, `SELECT count(*)::int AS n FROM bookings WHERE session_id = $1 AND status IN ('confirmed', 'completed')`, [sessionId]);
    if (taken.n >= session.capacity) return;
    const next = await one(db, `SELECT * FROM bookings WHERE session_id = $1 AND status = 'waitlisted' ORDER BY waitlist_position, created_at LIMIT 1`, [sessionId]);
    if (!next) return;
    const clash = await one(db, `SELECT 1 FROM bookings WHERE player_id = $1 AND status = 'confirmed' AND during && $2`, [next.player_id, next.during]);
    const updated = clash
      ? await one(db, `UPDATE bookings SET status = 'rejected', decision_reason = 'Player now has another session at this time', decided_at = now() WHERE id = $1 RETURNING *`, [next.id])
      : await placeOrWaitlist(db, next.id, session, policy);
    await audit(db, actor, 'waitlist_promoted', 'booking', next.id, { status: 'waitlisted' }, { status: updated.status });
    await notifyOutcome(db, updated, session);
  }
}

export async function bookingRoutes(app: FastifyInstance) {
  app.post('/v1/bookings', async (req) => {
    const actor = actorOf(req);
    const body = parse(bookingInput, req.body);
    return tx((db) => requestBooking(db, actor, body));
  });

  app.get('/v1/bookings', async (req) => {
    const actor = actorOf(req);
    const q = parse(z.object({ status: z.enum(['pending', 'waitlisted', 'confirmed', 'rejected', 'cancelled', 'completed']).optional(), playerId: z.uuid().optional() }), req.query);
    const params: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    if (q.status) add('b.status = ?', q.status);
    if (q.playerId) add('b.player_id = ?', q.playerId);
    if (actor.role === 'coach') add(`EXISTS (SELECT 1 FROM session_coaches sc WHERE sc.session_id = b.session_id AND sc.active AND sc.coach_id = ?)`, actor.profileId);
    if (actor.role === 'player') add('b.player_id = ?', actor.profileId);
    if (actor.role === 'guardian') add('b.player_id IN (SELECT player_id FROM player_guardians WHERE guardian_id = ?)', actor.profileId);
    return many(
      pool,
      `SELECT b.id, b.session_id, b.player_id, p.full_name AS player_name, b.status, b.source, b.approvals_needed, b.review_reasons,
              b.waitlist_position, b.is_makeup, b.created_at, b.decision_reason, s.starts_at, s.ends_at, s.session_type, s.title,
              s.origin, s.training_focus, cat.name AS category_name,
              coalesce((SELECT json_agg(json_build_object('id', c.id, 'full_name', c.full_name)) FROM session_coaches sc JOIN coaches c ON c.id = sc.coach_id
                         WHERE sc.session_id = s.id AND sc.active), '[]') AS coaches
         FROM bookings b JOIN players p ON p.id = b.player_id JOIN sessions s ON s.id = b.session_id
         JOIN session_categories cat ON cat.id = s.category_id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY s.starts_at DESC LIMIT 500`,
      params,
    );
  });

  app.post('/v1/bookings/:id/approve', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    return tx(async (db) => {
      const booking = await one(db, `SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [id]);
      if (!booking) throw notFound('Booking');
      let role: 'staff' | 'guardian';
      if (actor.role === 'guardian') {
        if (!(await isGuardianOf(db, actor, booking.player_id, { canBook: true }))) throw forbidden();
        role = 'guardian';
      } else {
        await requireSessionStaff(db, actor, booking.session_id);
        role = 'staff';
      }
      if (booking.status !== 'pending') throw conflict('not_pending', `This booking is already ${booking.status}`);
      // Each party clears only its own step: staff approval never stands in for a parent's.
      const remaining = booking.approvals_needed.filter((a: string) => a !== role);
      if (remaining.length === booking.approvals_needed.length) throw conflict('nothing_to_approve', 'This booking is not waiting for your approval');
      let updated = await one(db, `UPDATE bookings SET approvals_needed = $2, decided_by = $3 WHERE id = $1 RETURNING *`, [id, remaining, actor.userId]);
      const session = await one(db, `SELECT * FROM sessions WHERE id = $1 FOR UPDATE`, [booking.session_id]);
      if (remaining.length === 0) {
        if (session.status !== 'scheduled') throw conflict('session_closed', 'This session is no longer open');
        try {
          updated = await placeOrWaitlist(db, id, session, await getPolicy(db));
        } catch (err) {
          throw fromPgError(err) ?? err;
        }
      }
      await audit(db, actor, `booking_approved_${role}`, 'booking', id, { status: booking.status, approvals: booking.approvals_needed }, { status: updated.status, approvals: remaining });
      await notifyOutcome(db, updated, session);
      return updated;
    });
  });

  app.post('/v1/bookings/:id/reject', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ reason: z.string().trim().min(2).max(500) }), req.body);
    return tx(async (db) => {
      const booking = await one(db, `SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [id]);
      if (!booking) throw notFound('Booking');
      if (actor.role === 'guardian') {
        if (!(await isGuardianOf(db, actor, booking.player_id, { canBook: true }))) throw forbidden();
      } else {
        await requireSessionStaff(db, actor, booking.session_id);
      }
      if (!['pending', 'waitlisted'].includes(booking.status)) throw conflict('not_pending', `This booking is already ${booking.status}`);
      const updated = await one(
        db,
        `UPDATE bookings SET status = 'rejected', decision_reason = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING *`,
        [id, body.reason, actor.userId],
      );
      await audit(db, actor, 'booking_rejected', 'booking', id, { status: booking.status }, { status: 'rejected', reason: body.reason });
      const session = await one(db, `SELECT * FROM sessions WHERE id = $1`, [booking.session_id]);
      if (actor.role === 'guardian' && session.origin === 'request') {
        await notifyUsers(db, await sessionCoachUsers(db, session.id), { kind: 'booking_cancelled', title: 'Request declined by parent', body: `${session.title ?? 'Session'} on ${when(session.starts_at)}`, data: { bookingId: id } });
      }
      await closeRequestedSession(db, session, 'Request declined');
      await notifyOutcome(db, updated, session);
      return updated;
    });
  });

  app.post('/v1/bookings/:id/cancel', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
    return tx(async (db) => {
      const booking = await one(db, `SELECT * FROM bookings WHERE id = $1 FOR UPDATE`, [id]);
      if (!booking) throw notFound('Booking');
      const session = await one(db, `SELECT * FROM sessions WHERE id = $1`, [booking.session_id]);
      const staff = actor.role === 'admin' || (await isSessionCoach(db, actor, booking.session_id));
      const own = (actor.role === 'player' && actor.profileId === booking.player_id) || (await isGuardianOf(db, actor, booking.player_id, { canBook: true }));
      if (!staff && !own) throw forbidden();
      if (!['pending', 'waitlisted', 'confirmed'].includes(booking.status)) throw conflict('not_cancellable', `This booking is already ${booking.status}`);
      if (!staff && booking.status === 'confirmed') {
        const policy = await getPolicy(db);
        const cutoff = new Date(session.starts_at).getTime() - policy.booking.selfCancelCutoffHours * 3600_000;
        if (Date.now() > cutoff) throw conflict('too_late', `Confirmed bookings can be cancelled up to ${policy.booking.selfCancelCutoffHours} hours before. Please contact the academy.`);
      }
      const hasAttendance = await one(db, `SELECT 1 FROM attendance WHERE session_id = $1 AND player_id = $2`, [booking.session_id, booking.player_id]);
      if (hasAttendance) throw conflict('attendance_recorded', 'Attendance is already recorded for this booking; correct the attendance instead');
      const updated = await one(
        db,
        `UPDATE bookings SET status = 'cancelled', decision_reason = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING *`,
        [id, body.reason ?? null, actor.userId],
      );
      await audit(db, actor, 'booking_cancelled', 'booking', id, { status: booking.status }, { status: 'cancelled', reason: body.reason });
      await notifyUsers(db, [...(await playerAudience(db, [booking.player_id])), ...(await sessionCoachUsers(db, booking.session_id))], {
        kind: 'booking_cancelled', title: 'Booking cancelled', body: `${session.title ?? 'Session'} on ${when(session.starts_at)}`, data: { bookingId: id },
      });
      if (booking.status === 'confirmed') await promoteWaitlist(db, actor, booking.session_id);
      await closeRequestedSession(db, session, 'Request withdrawn');
      return updated;
    });
  });
}

