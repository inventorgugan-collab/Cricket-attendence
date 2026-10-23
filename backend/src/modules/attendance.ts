import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { many, one, pool, tx } from '../db.js';
import { Actor } from '../lib/actor.js';
import { audit } from '../lib/audit.js';
import { requirePlayerAccess, requireRole, requireSessionStaff } from '../lib/authz.js';
import { AppError, badRequest, conflict, forbidden, fromPgError, notFound } from '../lib/errors.js';
import { actorOf, idParams, isoDate, isoDateTime, parse } from '../lib/http.js';
import { getPolicy } from '../lib/settings.js';
import { requestBooking } from './bookings.js';
import { reconcileAttendanceCredit } from './credits.js';

export const attendanceStatus = z.enum(['present', 'absent', 'late', 'excused']);

export const markInput = z.object({
  playerId: z.uuid(),
  status: attendanceStatus,
  note: z.string().trim().max(500).nullable().optional(),
  // When the coach actually marked it; offline marks arrive later than this.
  recordedAt: isoDateTime.optional(),
  // The attendance version the device last saw. If the server has moved on
  // because someone else changed it, the change is held as a conflict.
  baseVersion: z.number().int().optional(),
  walkIn: z.boolean().default(false),
  reason: z.string().trim().max(500).optional(),
});
export type MarkInput = z.infer<typeof markInput>;

export type MarkResult =
  | { outcome: 'created' | 'updated' | 'unchanged'; attendance: any }
  | { outcome: 'conflict'; reason: string; attendance: any };

export async function markAttendance(db: PoolClient, actor: Actor, sessionId: string, input: MarkInput): Promise<MarkResult> {
  await requireSessionStaff(db, actor, sessionId);
  const session = await one(db, `SELECT * FROM sessions WHERE id = $1`, [sessionId]);
  if (!session) throw notFound('Session');
  if (session.status === 'cancelled') throw conflict('session_cancelled', 'This session was cancelled; attendance does not apply');
  const policy = await getPolicy(db);
  const recordedAt = input.recordedAt ? new Date(input.recordedAt) : new Date();
  const earliest = new Date(session.starts_at).getTime() - policy.attendance.markEarlyMinutes * 60_000;
  if (Math.max(recordedAt.getTime(), Date.now()) < earliest) throw conflict('too_early', 'Attendance can only be marked once the session is about to start');

  let booking = await one(
    db,
    `SELECT * FROM bookings WHERE session_id = $1 AND player_id = $2 AND status IN ('confirmed', 'completed')`,
    [sessionId, input.playerId],
  );
  if (!booking) {
    if (!input.walkIn) throw conflict('not_booked', 'This player is not booked into the session. Add them as a walk-in if they attended.');
    booking = await requestBooking(db, actor, { sessionId, playerId: input.playerId, walkIn: true, direct: false, isMakeup: false });
  }

  const existing = await one(db, `SELECT * FROM attendance WHERE session_id = $1 AND player_id = $2 FOR UPDATE`, [sessionId, input.playerId]);
  if (!existing) {
    const created = await one(
      db,
      `INSERT INTO attendance (session_id, player_id, booking_id, status, original_status, note, recorded_by, recorded_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7)
       ON CONFLICT (session_id, player_id) DO NOTHING RETURNING *`,
      [sessionId, input.playerId, booking.id, input.status, input.note ?? null, actor.userId, recordedAt],
    );
    if (!created) {
      // Another device marked the same player a moment earlier: treat as a correction.
      return markAttendance(db, actor, sessionId, input);
    }
    await db.query(
      `INSERT INTO attendance_events (attendance_id, kind, previous_status, new_status, reason, changed_by, changed_by_role, occurred_at)
       VALUES ($1, 'initial', NULL, $2, $3, $4, $5, $6)`,
      [created.id, input.status, input.note ?? null, actor.userId, actor.role, recordedAt],
    );
    await reconcileAttendanceCredit(db, actor, created.id, policy);
    await audit(db, actor, 'attendance_marked', 'attendance', created.id, null, { status: input.status, playerId: input.playerId, sessionId });
    return { outcome: 'created', attendance: created };
  }

  if (existing.status === input.status && (input.note ?? null) === (existing.note ?? null)) return { outcome: 'unchanged', attendance: existing };

  if (actor.role !== 'admin') {
    if (existing.admin_locked) return { outcome: 'conflict', reason: 'An admin has overridden this record', attendance: existing };
    if (input.baseVersion !== undefined && input.baseVersion < existing.version) {
      const lastBy = await one(db, `SELECT changed_by FROM attendance_events WHERE attendance_id = $1 ORDER BY received_at DESC LIMIT 1`, [existing.id]);
      if (lastBy?.changed_by !== actor.userId) {
        return { outcome: 'conflict', reason: 'Someone else changed this record after your device last synced', attendance: existing };
      }
    }
    const windowEnds = new Date(session.ends_at).getTime() + policy.attendance.coachCorrectionWindowHours * 3600_000;
    if (recordedAt.getTime() > windowEnds) {
      throw forbidden(`Coaches can correct attendance up to ${policy.attendance.coachCorrectionWindowHours} hours after the session. Ask an admin.`);
    }
  }
  return applyChange(db, actor, existing, input.status, input.note ?? existing.note, actor.role === 'admin' ? 'override' : 'correction', input.reason ?? null, recordedAt);
}

async function applyChange(db: PoolClient, actor: Actor, existing: any, status: string, note: string | null, kind: 'correction' | 'override', reason: string | null, occurredAt: Date): Promise<MarkResult> {
  const updated = await one(
    db,
    `UPDATE attendance SET status = $2, note = $3, version = version + 1, admin_locked = admin_locked OR $4 WHERE id = $1 RETURNING *`,
    [existing.id, status, note, kind === 'override'],
  );
  await db.query(
    `INSERT INTO attendance_events (attendance_id, kind, previous_status, new_status, reason, changed_by, changed_by_role, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [existing.id, kind, existing.status, status, reason, actor.userId, actor.role, occurredAt],
  );
  await reconcileAttendanceCredit(db, actor, existing.id, await getPolicy(db));
  await audit(db, actor, `attendance_${kind}`, 'attendance', existing.id, { status: existing.status }, { status, reason });
  return { outcome: 'updated', attendance: updated };
}

export async function attendanceRoutes(app: FastifyInstance) {
  // Mark or correct a batch of players in one go. Each record succeeds or fails
  // on its own so one problem doesn't block the rest of the register.
  app.put('/v1/sessions/:id/attendance', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ records: z.array(markInput).min(1).max(200) }), req.body);
    return tx(async (db) => {
      await requireSessionStaff(db, actor, id);
      const results = [];
      for (const record of body.records) {
        await db.query('SAVEPOINT mark');
        try {
          const r = await markAttendance(db, actor, id, record);
          await db.query('RELEASE SAVEPOINT mark');
          results.push({ playerId: record.playerId, ...r });
        } catch (err) {
          await db.query('ROLLBACK TO SAVEPOINT mark');
          const e = err instanceof AppError ? err : fromPgError(err);
          if (!e) throw err;
          results.push({ playerId: record.playerId, outcome: 'rejected', code: e.code, message: e.message });
        }
      }
      return { results };
    });
  });

  app.post('/v1/attendance/:id/override', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ status: attendanceStatus, reason: z.string().trim().min(3).max(500), note: z.string().max(500).optional() }), req.body);
    return tx(async (db) => {
      const existing = await one(db, `SELECT * FROM attendance WHERE id = $1 FOR UPDATE`, [id]);
      if (!existing) throw notFound('Attendance record');
      const session = await one(db, `SELECT status FROM sessions WHERE id = $1`, [existing.session_id]);
      if (session.status === 'cancelled') throw conflict('session_cancelled', 'This session was cancelled');
      return applyChange(db, actor, existing, body.status, body.note ?? existing.note, 'override', body.reason, new Date());
    });
  });

  // Admin can lift a lock so the coach can correct again.
  app.post('/v1/attendance/:id/unlock', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const row = await one(pool, `UPDATE attendance SET admin_locked = false WHERE id = $1 RETURNING *`, [id]);
    if (!row) throw notFound('Attendance record');
    await audit(pool, actor, 'attendance_unlocked', 'attendance', id, null, null);
    return row;
  });

  app.get('/v1/attendance/:id/history', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const record = await one(pool, `SELECT * FROM attendance WHERE id = $1`, [id]);
    if (!record) throw notFound('Attendance record');
    if (actor.role !== 'admin') await requireSessionStaff(pool, actor, record.session_id);
    const events = await many(
      pool,
      `SELECT e.*, u.display_name AS changed_by_name FROM attendance_events e JOIN users u ON u.id = e.changed_by
        WHERE e.attendance_id = $1 ORDER BY e.received_at`,
      [id],
    );
    return { record, events };
  });

  app.put('/v1/sessions/:id/coach-attendance', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ coachId: z.uuid(), status: attendanceStatus, note: z.string().max(500).optional(), recordedAt: isoDateTime.optional() }), req.body);
    if (!(actor.role === 'admin' || (actor.role === 'coach' && actor.profileId === body.coachId))) throw forbidden();
    return tx(async (db) => {
      const assigned = await one(db, `SELECT 1 FROM session_coaches WHERE session_id = $1 AND coach_id = $2`, [id, body.coachId]);
      if (!assigned) throw badRequest('That coach is not assigned to this session');
      const row = await one(
        db,
        `INSERT INTO coach_attendance (session_id, coach_id, status, recorded_by, recorded_at, note) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (session_id, coach_id) DO UPDATE SET status = EXCLUDED.status, recorded_by = EXCLUDED.recorded_by,
           recorded_at = EXCLUDED.recorded_at, note = EXCLUDED.note
         RETURNING *`,
        [id, body.coachId, body.status, actor.userId, body.recordedAt ?? new Date().toISOString(), body.note ?? null],
      );
      await audit(db, actor, 'coach_attendance_marked', 'session', id, null, row);
      return row;
    });
  });

  app.get('/v1/players/:id/attendance', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const q = parse(z.object({ from: isoDate.optional(), to: isoDate.optional() }), req.query);
    await requirePlayerAccess(pool, actor, id);
    const rows = await many(
      pool,
      `SELECT s.id AS session_id, s.starts_at, s.ends_at, s.session_type, s.title, s.status AS session_status,
              b.status AS booking_status, a.id AS attendance_id, a.status, a.original_status, a.note, a.recorded_at,
              (a.status IS DISTINCT FROM a.original_status) AS corrected
         FROM bookings b JOIN sessions s ON s.id = b.session_id
         LEFT JOIN attendance a ON a.session_id = b.session_id AND a.player_id = b.player_id
        WHERE b.player_id = $1 AND b.status IN ('confirmed', 'completed', 'cancelled')
          AND s.starts_at <= now() + interval '1 hour'
          AND ($2::date IS NULL OR s.starts_at >= $2::date) AND ($3::date IS NULL OR s.starts_at < $3::date + 1)
          AND (b.status <> 'cancelled' OR s.status = 'cancelled')
        ORDER BY s.starts_at DESC LIMIT 500`,
      [id, q.from ?? null, q.to ?? null],
    );
    const summary = { present: 0, late: 0, absent: 0, excused: 0, not_applicable: 0, not_recorded: 0 };
    for (const r of rows) {
      if (r.session_status === 'cancelled') summary.not_applicable++;
      else if (!r.status) summary.not_recorded++;
      else summary[r.status as keyof typeof summary]++;
    }
    return { summary, records: rows };
  });
}
