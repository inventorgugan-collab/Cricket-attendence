import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { config } from '../config.js';
import { Db, many, one, pool, tx } from '../db.js';
import { Actor } from '../lib/actor.js';
import { audit } from '../lib/audit.js';
import { isGuardianOf, isSessionCoach, requireRole, requireSessionStaff } from '../lib/authz.js';
import { AppError, badRequest, conflict, forbidden, fromPgError, notFound } from '../lib/errors.js';
import { actorOf, idParams, isoDate, isoDateTime, parse } from '../lib/http.js';
import { notifyUsers, playerAudience, sessionCoachUsers } from '../lib/notify.js';
import { assertNotOnLeave, coachStates, isFree, when } from '../lib/coaching.js';
import { getPolicy } from '../lib/settings.js';
import { reconcileAttendanceCredit } from './credits.js';

const TZ = config.timeZone;

const sessionFields = z.object({
  sessionType: z.enum(['group', 'one_on_one', 'one_on_two']),
  // What kind of training this is (e.g. strength & conditioning); packages count
  // sessions per category. Defaults to the category matching the format.
  categoryId: z.uuid().nullable().optional(),
  bookingMode: z.enum(['fixed', 'open']).default('fixed'),
  title: z.string().trim().max(200).nullable().optional(),
  trainingFocus: z.string().trim().max(1000).nullable().optional(),
  locationId: z.uuid().nullable().optional(),
  areaId: z.uuid().nullable().optional(),
  capacity: z.number().int().min(1).max(200).optional(),
  coachIds: z.array(z.uuid()).min(1).max(10),
  groupId: z.uuid().nullable().optional(),
  // Players booked straight in (confirmed). For a group session with a groupId
  // and no list, the group's members are used.
  playerIds: z.array(z.uuid()).max(200).optional(),
});

function capacityFor(type: string, requested?: number): number {
  if (type === 'one_on_one') return 1;
  if (type === 'one_on_two') return 2;
  if (!requested) throw badRequest('Group sessions need a capacity');
  return requested;
}

// Run one statement inside a savepoint so a single rejected row (a clash, a full
// session) doesn't abort the whole transaction.
export async function attempt<T>(db: PoolClient, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: AppError }> {
  await db.query('SAVEPOINT attempt');
  try {
    const value = await fn();
    await db.query('RELEASE SAVEPOINT attempt');
    return { ok: true, value };
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT attempt');
    const mapped = err instanceof AppError ? err : fromPgError(err);
    if (!mapped) throw err;
    return { ok: false, error: mapped };
  }
}

async function coachAvailabilityWarnings(db: Db, coachIds: string[], startsAt: string, endsAt: string): Promise<string[]> {
  const rows = await many(
    db,
    `SELECT c.full_name FROM coaches c
      WHERE c.id = ANY($1)
        AND EXISTS (SELECT 1 FROM coach_availability a WHERE a.coach_id = c.id)
        AND NOT EXISTS (
          SELECT 1 FROM coach_availability a
           WHERE a.coach_id = c.id
             AND a.weekday = extract(isodow FROM $2::timestamptz AT TIME ZONE $4)
             AND a.start_time <= ($2::timestamptz AT TIME ZONE $4)::time
             AND a.end_time >= ($3::timestamptz AT TIME ZONE $4)::time)`,
    [coachIds, startsAt, endsAt, TZ],
  );
  return rows.map((r) => `${r.full_name} is not normally available at this time`);
}

export interface CreateInput extends z.infer<typeof sessionFields> {
  startsAt: string;
  endsAt: string;
  recurrenceId?: string | null;
  origin?: 'scheduled' | 'request';
}

export async function insertSession(db: PoolClient, actor: Actor, input: CreateInput) {
  const capacity = capacityFor(input.sessionType, input.capacity);
  if (input.categoryId) {
    const cat = await one(db, `SELECT session_type FROM session_categories WHERE id = $1 AND active`, [input.categoryId]);
    if (!cat) throw badRequest('Unknown session category');
    if (cat.session_type !== input.sessionType) throw badRequest(`That category is for ${cat.session_type.replaceAll('_', ' ')} sessions`);
  }
  await assertNotOnLeave(db, input.coachIds, input.startsAt, input.endsAt);
  const session = await one(
    db,
    `INSERT INTO sessions (session_type, booking_mode, title, training_focus, location_id, area_id, starts_at, ends_at,
                           capacity, group_id, recurrence_id, created_by, category_id, origin)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [
      input.sessionType, input.bookingMode, input.title ?? null, input.trainingFocus ?? null, input.locationId ?? null,
      input.areaId ?? null, input.startsAt, input.endsAt, capacity, input.groupId ?? null, input.recurrenceId ?? null, actor.userId,
      input.categoryId ?? null, input.origin ?? 'scheduled',
    ],
  );
  for (const coachId of input.coachIds) {
    await db.query(`INSERT INTO session_coaches (session_id, coach_id, during) VALUES ($1, $2, $3)`, [session.id, coachId, session.during]);
  }
  return session;
}

async function rosterBookings(db: PoolClient, actor: Actor, session: any, playerIds: string[]) {
  const skipped: { playerId: string; reason: string }[] = [];
  for (const playerId of playerIds) {
    const r = await attempt(db, () =>
      db.query(
        `INSERT INTO bookings (session_id, player_id, status, source, during, requested_by, decided_by, decided_at)
         VALUES ($1, $2, 'confirmed', 'roster', $3, $4, $4, now())`,
        [session.id, playerId, session.during, actor.userId],
      ),
    );
    if (!r.ok) skipped.push({ playerId, reason: r.error.message });
  }
  return skipped;
}

async function canCreateSessions(db: Db, actor: Actor, coachIds: string[]) {
  if (actor.role === 'admin') return;
  if (actor.role !== 'coach') throw forbidden();
  const policy = await getPolicy(db);
  if (!policy.sessions.coachesCanCreate) throw forbidden('Only admins can create sessions');
  // Coaches can only put themselves on a session they create.
  if (coachIds.some((c) => c !== actor.profileId)) throw forbidden('Coaches can only schedule themselves');
}

async function initialPlayers(db: Db, input: z.infer<typeof sessionFields>): Promise<string[]> {
  if (input.playerIds) return input.playerIds;
  if (input.groupId && input.bookingMode === 'fixed') {
    const rows = await many(db, `SELECT player_id FROM group_members gm JOIN players p ON p.id = gm.player_id WHERE group_id = $1 AND p.status = 'active'`, [input.groupId]);
    return rows.map((r) => r.player_id);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Reading sessions
// ---------------------------------------------------------------------------

const SESSION_SELECT = `
  SELECT s.*, l.name AS location_name, a.name AS area_name, cat.name AS category_name, cat.code AS category_code,
         coalesce((SELECT json_agg(json_build_object('id', c.id, 'full_name', c.full_name) ORDER BY c.full_name)
                     FROM session_coaches sc JOIN coaches c ON c.id = sc.coach_id
                    WHERE sc.session_id = s.id AND sc.active), '[]') AS coaches,
         (SELECT count(*) FROM bookings b WHERE b.session_id = s.id AND b.status IN ('confirmed', 'completed'))::int AS confirmed_count,
         (SELECT count(*) FROM bookings b WHERE b.session_id = s.id AND b.status = 'pending')::int AS pending_count,
         (SELECT count(*) FROM bookings b WHERE b.session_id = s.id AND b.status = 'waitlisted')::int AS waitlist_count,
         (SELECT count(*) FROM attendance at WHERE at.session_id = s.id)::int AS attendance_count,
         (SELECT count(*) FROM attendance at WHERE at.session_id = s.id AND at.status IN ('present', 'late'))::int AS present_count
    FROM sessions s
    LEFT JOIN locations l ON l.id = s.location_id
    LEFT JOIN training_areas a ON a.id = s.area_id
    JOIN session_categories cat ON cat.id = s.category_id`;

export function presentSession(s: any) {
  const { during, ...rest } = s;
  return rest;
}

export async function sessionDetail(db: Db, actor: Actor, id: string) {
  const session = await one(db, `${SESSION_SELECT} WHERE s.id = $1`, [id]);
  if (!session) throw notFound('Session');
  const staff = actor.role === 'admin' || (await isSessionCoach(db, actor, id));
  let playerFilter: string[] | null = null;
  if (!staff) {
    if (actor.role === 'player') playerFilter = [actor.profileId!];
    else if (actor.role === 'guardian') {
      playerFilter = (await many(db, `SELECT player_id FROM player_guardians WHERE guardian_id = $1`, [actor.profileId])).map((r) => r.player_id);
    } else if (actor.role === 'coach') {
      // Other coaches may look at the timetable but not the participant list.
      playerFilter = [];
    }
    const mine = await one(db, `SELECT 1 FROM bookings WHERE session_id = $1 AND player_id = ANY($2) LIMIT 1`, [id, playerFilter]);
    if (!mine && !(session.booking_mode === 'open' && session.status === 'scheduled') && actor.role !== 'coach') throw forbidden();
  }
  const bookings = await many(
    db,
    `SELECT b.id, b.player_id, p.full_name AS player_name, b.status, b.source, b.is_makeup, b.approvals_needed,
            b.review_reasons, b.waitlist_position, b.created_at, b.decided_at, b.decision_reason
       FROM bookings b JOIN players p ON p.id = b.player_id
      WHERE b.session_id = $1 AND ($2::uuid[] IS NULL OR b.player_id = ANY($2))
      ORDER BY b.status, p.full_name`,
    [id, playerFilter],
  );
  const attendance = await many(
    db,
    `SELECT a.id, a.player_id, a.status, a.original_status, a.note, a.recorded_at, a.admin_locked, a.version,
            u.display_name AS recorded_by_name
       FROM attendance a JOIN users u ON u.id = a.recorded_by
      WHERE a.session_id = $1 AND ($2::uuid[] IS NULL OR a.player_id = ANY($2))`,
    [id, playerFilter],
  );
  const coachAttendance = staff ? await many(db, `SELECT * FROM coach_attendance WHERE session_id = $1`, [id]) : [];
  return { ...presentSession(session), bookings, attendance, coachAttendance, canManage: staff };
}

// ---------------------------------------------------------------------------
// Cancelling: bookings are cancelled, existing attendance becomes not
// applicable (never an absence), and any credits taken are returned.
// ---------------------------------------------------------------------------

export async function cancelSession(db: PoolClient, actor: Actor, sessionId: string, reason: string) {
  const before = await one(db, `SELECT * FROM sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
  if (!before) throw notFound('Session');
  if (before.status === 'cancelled') return before;
  if (before.status === 'completed') throw conflict('session_completed', 'A completed session cannot be cancelled');
  const session = await one(
    db,
    `UPDATE sessions SET status = 'cancelled', cancellation_reason = $2, version = version + 1 WHERE id = $1 RETURNING *`,
    [sessionId, reason],
  );
  const affected = await many(
    db,
    `UPDATE bookings SET status = 'cancelled', decision_reason = 'Session cancelled', decided_by = $2, decided_at = now()
      WHERE session_id = $1 AND status IN ('pending', 'waitlisted', 'confirmed') RETURNING player_id`,
    [sessionId, actor.userId],
  );
  const policy = await getPolicy(db);
  const marked = await many(db, `SELECT * FROM attendance WHERE session_id = $1 AND status <> 'not_applicable'`, [sessionId]);
  for (const a of marked) {
    await db.query(`UPDATE attendance SET status = 'not_applicable', version = version + 1 WHERE id = $1`, [a.id]);
    await db.query(
      `INSERT INTO attendance_events (attendance_id, kind, previous_status, new_status, reason, changed_by, changed_by_role, occurred_at)
       VALUES ($1, 'session_cancelled', $2, 'not_applicable', $3, $4, $5, now())`,
      [a.id, a.status, reason, actor.userId, actor.role],
    );
  }
  for (const a of await many(db, `SELECT id FROM attendance WHERE session_id = $1`, [sessionId])) {
    await reconcileAttendanceCredit(db, actor, a.id, policy);
  }
  await audit(db, actor, 'session_cancelled', 'session', sessionId, { status: before.status }, { status: 'cancelled', reason });
  const playerIds = [...new Set(affected.map((r) => r.player_id))];
  const when = new Date(before.starts_at).toLocaleString('en-IN', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
  await notifyUsers(db, [...(await playerAudience(db, playerIds)), ...(await sessionCoachUsers(db, sessionId))], {
    kind: 'session_cancelled',
    title: 'Session cancelled',
    body: `The session on ${when} has been cancelled. ${reason}`,
    data: { sessionId },
  });
  return session;
}

export async function sessionRoutes(app: FastifyInstance) {
  app.post('/v1/sessions', async (req) => {
    const actor = actorOf(req);
    const body = parse(sessionFields.extend({ startsAt: isoDateTime, endsAt: isoDateTime }), req.body);
    if (new Date(body.endsAt) <= new Date(body.startsAt)) throw badRequest('The session must end after it starts');
    await canCreateSessions(pool, actor, body.coachIds);
    return tx(async (db) => {
      const session = await insertSession(db, actor, body);
      const skipped = await rosterBookings(db, actor, session, await initialPlayers(db, body));
      await audit(db, actor, 'session_created', 'session', session.id, null, presentSession(session));
      await notifyUsers(db, await sessionCoachUsers(db, session.id), {
        kind: 'session_assigned',
        title: 'New session on your schedule',
        body: `${body.title ?? body.sessionType.replaceAll('_', ' ')} on ${new Date(body.startsAt).toLocaleString('en-IN', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' })}`,
        data: { sessionId: session.id },
      });
      return {
        session: await sessionDetail(db, actor, session.id),
        skippedPlayers: skipped,
        warnings: await coachAvailabilityWarnings(db, body.coachIds, body.startsAt, body.endsAt),
      };
    });
  });

  // Weekly recurring sessions. Each date is created on its own; dates that clash
  // are reported back instead of failing the whole series.
  app.post('/v1/sessions/recurring', async (req) => {
    const actor = actorOf(req);
    const body = parse(
      sessionFields.extend({
        weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
        startDate: isoDate,
        endDate: isoDate,
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        durationMinutes: z.number().int().min(15).max(480),
      }),
      req.body,
    );
    await canCreateSessions(pool, actor, body.coachIds);
    return tx(async (db) => {
      const dates = await many(
        db,
        `SELECT d::date AS day,
                ((d::date + $3::time) AT TIME ZONE $5) AS starts_at,
                ((d::date + $3::time) AT TIME ZONE $5) + make_interval(mins => $4) AS ends_at
           FROM generate_series($1::date, $2::date, interval '1 day') d
          WHERE extract(isodow FROM d) = ANY($6)
          ORDER BY d`,
        [body.startDate, body.endDate, body.startTime, body.durationMinutes, TZ, body.weekdays],
      );
      if (dates.length === 0) throw badRequest('No dates match those weekdays in the range');
      if (dates.length > 120) throw badRequest('A series can have at most 120 sessions');
      const recurrence = await one(
        db,
        `INSERT INTO recurrences (weekdays, start_date, end_date, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [body.weekdays, body.startDate, body.endDate, actor.userId],
      );
      const players = await initialPlayers(db, body);
      const created: string[] = [];
      const skippedDates: { date: string; reason: string }[] = [];
      const skippedPlayers: { date: string; playerId: string; reason: string }[] = [];
      for (const d of dates) {
        const r = await attempt(db, () =>
          insertSession(db, actor, { ...body, startsAt: d.starts_at.toISOString(), endsAt: d.ends_at.toISOString(), recurrenceId: recurrence.id }),
        );
        if (!r.ok) {
          skippedDates.push({ date: d.day, reason: r.error.message });
          continue;
        }
        created.push(r.value.id);
        for (const s of await rosterBookings(db, actor, r.value, players)) skippedPlayers.push({ date: d.day, ...s });
      }
      await audit(db, actor, 'recurring_sessions_created', 'recurrence', recurrence.id, null, { created: created.length, skippedDates });
      return { recurrenceId: recurrence.id, createdSessionIds: created, skippedDates, skippedPlayers };
    });
  });

  app.get('/v1/sessions', async (req) => {
    const actor = actorOf(req);
    const q = parse(
      z.object({
        from: isoDateTime.optional(),
        to: isoDateTime.optional(),
        coachId: z.uuid().optional(),
        playerId: z.uuid().optional(),
        status: z.enum(['scheduled', 'in_progress', 'completed', 'cancelled', 'interrupted']).optional(),
      }),
      req.query,
    );
    const from = q.from ?? new Date(Date.now() - 7 * 86400_000).toISOString();
    const to = q.to ?? new Date(Date.now() + 30 * 86400_000).toISOString();
    const params: unknown[] = [from, to];
    const where = [`s.starts_at < $2`, `s.ends_at > $1`];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll('?', `$${params.length}`));
    };
    if (q.status) add(`s.status = ?`, q.status);
    if (actor.role === 'admin') {
      if (q.coachId) add(`EXISTS (SELECT 1 FROM session_coaches sc WHERE sc.session_id = s.id AND sc.active AND sc.coach_id = ?)`, q.coachId);
      if (q.playerId) add(`EXISTS (SELECT 1 FROM bookings b WHERE b.session_id = s.id AND b.player_id = ?)`, q.playerId);
    } else if (actor.role === 'coach') {
      add(`EXISTS (SELECT 1 FROM session_coaches sc WHERE sc.session_id = s.id AND sc.active AND sc.coach_id = ?)`, actor.profileId);
    } else {
      let players: string[];
      if (actor.role === 'player') players = [actor.profileId!];
      else {
        players = (await many(pool, `SELECT player_id FROM player_guardians WHERE guardian_id = $1`, [actor.profileId])).map((r) => r.player_id);
        if (q.playerId) players = players.filter((p) => p === q.playerId);
      }
      add(`EXISTS (SELECT 1 FROM bookings b WHERE b.session_id = s.id AND b.player_id = ANY(?))`, players);
    }
    const rows = await many(pool, `${SESSION_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.starts_at LIMIT 1000`, params);
    if (actor.role === 'player' || actor.role === 'guardian') {
      // Attach each player's own booking so the app can show request vs confirmed clearly.
      const mine = await many(
        pool,
        `SELECT b.session_id, b.id, b.player_id, b.status, b.approvals_needed, b.waitlist_position
           FROM bookings b WHERE b.session_id = ANY($1) AND b.player_id = ANY($2)`,
        [rows.map((r) => r.id), actor.role === 'player' ? [actor.profileId] : (await many(pool, `SELECT player_id FROM player_guardians WHERE guardian_id = $1`, [actor.profileId])).map((r) => r.player_id)],
      );
      return rows.map((r) => ({ ...presentSession(r), myBookings: mine.filter((m) => m.session_id === r.id) }));
    }
    return rows.map(presentSession);
  });

  // Open sessions a player could request.
  app.get('/v1/sessions/available', async (req) => {
    const actor = actorOf(req);
    const q = parse(z.object({ playerId: z.uuid(), from: isoDateTime.optional(), to: isoDateTime.optional() }), req.query);
    if (!(actor.role === 'admin' || actor.role === 'coach' || (actor.role === 'player' && actor.profileId === q.playerId) || (await isGuardianOf(pool, actor, q.playerId)))) {
      throw forbidden();
    }
    const policy = await getPolicy(pool);
    const rows = await many(
      pool,
      `${SESSION_SELECT}
        WHERE s.booking_mode = 'open' AND s.status = 'scheduled'
          AND s.starts_at > now() + make_interval(hours => $3)
          AND s.starts_at < least($2::timestamptz, now() + make_interval(days => $4))
          AND s.starts_at >= $1
          AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.session_id = s.id AND b.player_id = $5
                           AND b.status IN ('pending', 'waitlisted', 'confirmed'))
        ORDER BY s.starts_at LIMIT 200`,
      [q.from ?? new Date().toISOString(), q.to ?? new Date(Date.now() + 60 * 86400_000).toISOString(), policy.booking.minNoticeHours, policy.booking.maxAdvanceDays, q.playerId],
    );
    return rows.map((r) => ({
      ...presentSession(r),
      places_left: Math.max(0, r.capacity - r.confirmed_count),
      waitlist_available: r.confirmed_count >= r.capacity && policy.booking.waitlistEnabled,
    }));
  });

  app.get('/v1/sessions/:id', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    return sessionDetail(pool, actor, id);
  });

  // Reschedule or edit. Clashes are rejected by the database constraints.
  app.patch('/v1/sessions/:id', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        version: z.number().int(),
        startsAt: isoDateTime.optional(),
        endsAt: isoDateTime.optional(),
        title: z.string().trim().max(200).nullable().optional(),
        trainingFocus: z.string().trim().max(1000).nullable().optional(),
        locationId: z.uuid().nullable().optional(),
        areaId: z.uuid().nullable().optional(),
        capacity: z.number().int().min(1).max(200).optional(),
        bookingMode: z.enum(['fixed', 'open']).optional(),
      }),
      req.body,
    );
    return tx(async (db) => {
      await requireSessionStaff(db, actor, id);
      const before = await one(db, `SELECT * FROM sessions WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('Session');
      if (before.version !== body.version) throw conflict('stale_version', 'This session was changed by someone else. Reload and try again.');
      if (['cancelled', 'completed'].includes(before.status)) throw conflict('session_closed', `A ${before.status} session cannot be edited`);
      const startsAt = body.startsAt ?? before.starts_at.toISOString();
      const endsAt = body.endsAt ?? before.ends_at.toISOString();
      if (new Date(endsAt) <= new Date(startsAt)) throw badRequest('The session must end after it starts');
      if (body.capacity !== undefined) {
        if (before.session_type !== 'group') throw badRequest('Only group sessions have an adjustable capacity');
        const taken = await one(db, `SELECT count(*)::int AS n FROM bookings WHERE session_id = $1 AND status IN ('confirmed', 'completed')`, [id]);
        if (body.capacity < taken.n) throw conflict('capacity_below_bookings', `${taken.n} players are already confirmed`);
      }
      const map: Record<string, string> = {
        startsAt: 'starts_at', endsAt: 'ends_at', title: 'title', trainingFocus: 'training_focus',
        locationId: 'location_id', areaId: 'area_id', capacity: 'capacity', bookingMode: 'booking_mode',
      };
      const changes = Object.entries(body).filter(([k]) => k !== 'version' && k in map);
      if (!changes.length) return sessionDetail(db, actor, id);
      const session = await one(
        db,
        `UPDATE sessions SET ${changes.map(([k], i) => `${map[k]} = $${i + 2}`).join(', ')}, version = version + 1 WHERE id = $1 RETURNING *`,
        [id, ...changes.map(([, v]) => v)],
      );
      await audit(db, actor, 'session_updated', 'session', id, presentSession(before), presentSession(session));
      const timeChanged = session.starts_at.getTime() !== before.starts_at.getTime() || session.ends_at.getTime() !== before.ends_at.getTime();
      if (timeChanged || body.areaId !== undefined || body.locationId !== undefined) {
        const players = (await many(db, `SELECT player_id FROM bookings WHERE session_id = $1 AND status IN ('pending', 'waitlisted', 'confirmed')`, [id])).map((r) => r.player_id);
        await notifyUsers(db, [...(await playerAudience(db, players)), ...(await sessionCoachUsers(db, id))], {
          kind: 'schedule_changed',
          title: 'Session changed',
          body: `A session has moved to ${new Date(session.starts_at).toLocaleString('en-IN', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' })}`,
          data: { sessionId: id },
        });
      }
      return sessionDetail(db, actor, id);
    });
  });

  // Coach reassignment. Removed coaches are deactivated, not deleted, so the
  // record of who was assigned survives. Everyone affected is told.
  app.put('/v1/sessions/:id/coaches', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ coachIds: z.array(z.uuid()).min(1).max(10), reason: z.string().trim().max(500).optional() }), req.body);
    return tx(async (db) => {
      const session = await one(db, `${SESSION_SELECT} WHERE s.id = $1`, [id]);
      if (!session) throw notFound('Session');
      await db.query(`SELECT 1 FROM sessions WHERE id = $1 FOR UPDATE`, [id]);
      if (['cancelled', 'completed'].includes(session.status)) throw conflict('session_closed', `A ${session.status} session cannot be changed`);
      const before = (await many(db, `SELECT coach_id FROM session_coaches WHERE session_id = $1 AND active`, [id])).map((r) => r.coach_id);
      const added = body.coachIds.filter((c) => !before.includes(c));
      const removed = before.filter((c) => !body.coachIds.includes(c));
      await assertNotOnLeave(db, added, session.starts_at, session.ends_at);
      const removedUsers = await coachUsers(db, removed);
      await db.query(`UPDATE session_coaches SET active = false WHERE session_id = $1 AND NOT (coach_id = ANY($2))`, [id, body.coachIds]);
      for (const coachId of body.coachIds) {
        await db.query(
          `INSERT INTO session_coaches (session_id, coach_id, during) VALUES ($1, $2, $3)
           ON CONFLICT (session_id, coach_id) DO UPDATE SET active = true`,
          [id, coachId, session.during],
        );
      }
      await db.query(`UPDATE sessions SET version = version + 1 WHERE id = $1`, [id]);
      await audit(db, actor, 'session_coaches_changed', 'session', id, { coachIds: before }, body);
      if (added.length || removed.length) {
        const label = `${session.title ?? session.category_name} on ${when(session.starts_at)}`;
        const names = (await many(db, `SELECT full_name FROM coaches WHERE id = ANY($1) ORDER BY full_name`, [body.coachIds])).map((r) => r.full_name).join(', ');
        const data = { sessionId: id };
        await notifyUsers(db, removedUsers, { kind: 'session_unassigned', title: 'Taken off a session', body: `${label} is now with ${names}.${body.reason ? ` ${body.reason}` : ''}`, data });
        await notifyUsers(db, await coachUsers(db, added), { kind: 'session_assigned', title: 'New session on your schedule', body: label, data });
        const players = (await many(db, `SELECT player_id FROM bookings WHERE session_id = $1 AND status IN ('pending', 'waitlisted', 'confirmed')`, [id])).map((r) => r.player_id);
        await notifyUsers(db, await playerAudience(db, players), { kind: 'coach_changed', title: 'Your coach has changed', body: `${label} will now be with ${names}.`, data });
      }
      return sessionDetail(db, actor, id);
    });
  });

  // Every active coach, best choice first: the category's priority order, then
  // the rest. Each shows whether they are free, on leave or already teaching.
  app.get('/v1/sessions/:id/available-coaches', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const session = await one(pool, `SELECT * FROM sessions WHERE id = $1`, [id]);
    if (!session) throw notFound('Session');
    const current = (await many(pool, `SELECT coach_id FROM session_coaches WHERE session_id = $1 AND active`, [id])).map((r) => r.coach_id);
    const states = await coachStates(pool, {
      categoryId: session.category_id, startsAt: session.starts_at, endsAt: session.ends_at, ignoreSessionId: id, policy: await getPolicy(pool),
    });
    return states.map(({ user_id, ...c }) => ({ ...c, current: current.includes(c.id), free: isFree({ user_id, ...c }) }));
  });

  // Upcoming sessions where an assigned coach is on leave.
  app.get('/v1/sessions/needing-cover', async (req) => {
    requireRole(actorOf(req), 'admin');
    return sessionsNeedingCover(pool);
  });

  app.post('/v1/sessions/:id/cancel', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
    return tx(async (db) => {
      await requireSessionStaff(db, actor, id);
      await cancelSession(db, actor, id, body.reason);
      return sessionDetail(db, actor, id);
    });
  });

  app.post('/v1/sessions/:id/status', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ status: z.enum(['in_progress', 'completed', 'interrupted']), note: z.string().max(500).optional() }), req.body);
    return tx(async (db) => {
      await requireSessionStaff(db, actor, id);
      const result = await setSessionStatus(db, actor, id, body.status);
      return { ...(await sessionDetail(db, actor, id)), missingAttendance: result.missingAttendance };
    });
  });
}

const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  scheduled: ['in_progress', 'completed', 'interrupted'],
  in_progress: ['completed', 'interrupted'],
  interrupted: ['completed'],
  completed: ['interrupted'],
  cancelled: [],
};

export async function setSessionStatus(db: PoolClient, actor: Actor, id: string, status: 'in_progress' | 'completed' | 'interrupted') {
  const before = await one(db, `SELECT * FROM sessions WHERE id = $1 FOR UPDATE`, [id]);
  if (!before) throw notFound('Session');
  if (before.status === status) return { missingAttendance: 0 };
  if (!ALLOWED_TRANSITIONS[before.status]!.includes(status)) throw conflict('invalid_transition', `A ${before.status} session cannot become ${status}`);
  if (status !== 'in_progress' && actor.role !== 'admin' && before.status === 'completed') throw forbidden('Only an admin can reopen a completed session');
  await db.query(`UPDATE sessions SET status = $2, version = version + 1 WHERE id = $1`, [id, status]);
  if (status === 'completed') {
    await db.query(`UPDATE bookings SET status = 'completed' WHERE session_id = $1 AND status = 'confirmed'`, [id]);
  } else if (status === 'interrupted' && before.status === 'completed') {
    await db.query(`UPDATE bookings SET status = 'confirmed' WHERE session_id = $1 AND status = 'completed'`, [id]);
  }
  // Interrupted sessions may change whether credits are used.
  const policy = await getPolicy(db);
  for (const a of await many(db, `SELECT id FROM attendance WHERE session_id = $1`, [id])) await reconcileAttendanceCredit(db, actor, a.id, policy);
  await audit(db, actor, 'session_status_changed', 'session', id, { status: before.status }, { status });
  const missing = await one(
    db,
    `SELECT count(*)::int AS n FROM bookings b WHERE b.session_id = $1 AND b.status IN ('confirmed', 'completed')
       AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = b.session_id AND a.player_id = b.player_id)`,
    [id],
  );
  return { missingAttendance: missing.n };
}

async function coachUsers(db: Db, coachIds: string[]): Promise<string[]> {
  if (!coachIds.length) return [];
  return (await many(db, `SELECT user_id FROM coaches WHERE id = ANY($1) AND user_id IS NOT NULL`, [coachIds])).map((r) => r.user_id);
}

export async function sessionsNeedingCover(db: Db) {
  return many(
    db,
    `SELECT s.id, s.starts_at, s.ends_at, s.title, s.session_type, s.status, s.origin, cat.name AS category_name,
            c.id AS coach_id, c.full_name AS coach_name, l.kind AS leave_kind, l.reason AS leave_reason,
            (SELECT count(*) FROM bookings b WHERE b.session_id = s.id AND b.status IN ('pending', 'confirmed'))::int AS players
       FROM sessions s
       JOIN session_categories cat ON cat.id = s.category_id
       JOIN session_coaches sc ON sc.session_id = s.id AND sc.active
       JOIN coaches c ON c.id = sc.coach_id
       JOIN LATERAL (SELECT * FROM coach_leave l WHERE l.coach_id = sc.coach_id AND l.status = 'active' AND l.during && s.during
                     ORDER BY l.created_at DESC LIMIT 1) l ON true
      WHERE s.status IN ('scheduled', 'in_progress') AND s.ends_at > now()
      ORDER BY s.starts_at`,
  );
}
