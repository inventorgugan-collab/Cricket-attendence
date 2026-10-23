import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Db, many, one, pool, tx } from '../db.js';
import { Actor } from '../lib/actor.js';
import { audit } from '../lib/audit.js';
import { requireRole, requireSessionStaff } from '../lib/authz.js';
import { AppError, badRequest, fromPgError, notFound } from '../lib/errors.js';
import { actorOf, idParams, isoDateTime, parse } from '../lib/http.js';
import { markAttendance, markInput } from './attendance.js';
import { bookingInput, requestBooking } from './bookings.js';
import { coachNoteInput, journalInput, presentCoachNote, presentJournal, upsertCoachNote, upsertJournal } from './journals.js';
import { presentPlayer } from './people.js';
import { presentSession, setSessionStatus } from './sessions.js';

// ---------------------------------------------------------------------------
// Push: the device sends its queued changes. Each mutation carries an id the
// device generated, and is applied at most once: a retry gets the stored result.
// The server re-checks every rule; nothing is trusted because the device said so.
// ---------------------------------------------------------------------------

const mutation = z.discriminatedUnion('type', [
  z.object({ id: z.uuid(), type: z.literal('attendance.mark'), clientTime: isoDateTime, payload: markInput.extend({ sessionId: z.uuid() }) }),
  z.object({ id: z.uuid(), type: z.literal('session.status'), clientTime: isoDateTime, payload: z.object({ sessionId: z.uuid(), status: z.enum(['in_progress', 'completed', 'interrupted']) }) }),
  z.object({ id: z.uuid(), type: z.literal('coach_note.upsert'), clientTime: isoDateTime, payload: coachNoteInput }),
  z.object({ id: z.uuid(), type: z.literal('journal.upsert'), clientTime: isoDateTime, payload: journalInput }),
  // Offline booking requests are only requests: the server decides them on arrival.
  z.object({ id: z.uuid(), type: z.literal('booking.request'), clientTime: isoDateTime, payload: bookingInput.pick({ sessionId: true, playerId: true }) }),
]);
type Mutation = z.infer<typeof mutation>;

type Outcome = { outcome: 'applied' | 'rejected' | 'conflict'; result: Record<string, unknown> };

async function apply(db: PoolClient, actor: Actor, m: Mutation): Promise<Outcome> {
  switch (m.type) {
    case 'attendance.mark': {
      const { sessionId, ...input } = m.payload;
      const r = await markAttendance(db, actor, sessionId, { ...input, recordedAt: input.recordedAt ?? m.clientTime });
      if (r.outcome === 'conflict') return { outcome: 'conflict', result: { reason: r.reason, server: r.attendance, entity: 'attendance', entityId: r.attendance.id } };
      return { outcome: 'applied', result: { status: r.outcome, attendance: r.attendance } };
    }
    case 'session.status': {
      await requireSessionStaff(db, actor, m.payload.sessionId);
      const r = await setSessionStatus(db, actor, m.payload.sessionId, m.payload.status);
      return { outcome: 'applied', result: r };
    }
    case 'coach_note.upsert': {
      const r = await upsertCoachNote(db, actor, m.payload);
      if (r.outcome === 'conflict') return { outcome: 'conflict', result: { reason: r.reason, server: presentCoachNote(r.record), entity: 'coach_note', entityId: r.record.id } };
      return { outcome: 'applied', result: { status: r.outcome, record: presentCoachNote(r.record) } };
    }
    case 'journal.upsert': {
      const r = await upsertJournal(db, actor, m.payload);
      if (r.outcome === 'conflict') return { outcome: 'conflict', result: { reason: r.reason, server: presentJournal(r.record), entity: 'journal_entry', entityId: r.record.id } };
      return { outcome: 'applied', result: { status: r.outcome, record: presentJournal(r.record) } };
    }
    case 'booking.request': {
      const b = await requestBooking(db, actor, { ...m.payload, clientRequestId: m.id, direct: false, walkIn: false, isMakeup: false });
      return { outcome: 'applied', result: { booking: b } };
    }
  }
}

async function processMutation(actor: Actor, m: Mutation) {
  return tx(async (db) => {
    // Serialise retries of the same mutation id.
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [m.id]);
    const seen = await one(db, `SELECT outcome, result FROM sync_mutations WHERE id = $1`, [m.id]);
    if (seen) return { id: m.id, outcome: seen.outcome, ...seen.result, replayed: true };

    let out: Outcome;
    await db.query('SAVEPOINT m');
    try {
      out = await apply(db, actor, m);
      await db.query('RELEASE SAVEPOINT m');
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT m');
      const e = err instanceof AppError ? err : fromPgError(err);
      if (!e) throw err;
      out = { outcome: 'rejected', result: { code: e.code, message: e.message } };
    }
    await db.query(
      `INSERT INTO sync_mutations (id, user_id, type, outcome, result, client_time) VALUES ($1, $2, $3, $4, $5, $6)`,
      [m.id, actor.userId, m.type, out.outcome, out.result, m.clientTime],
    );
    if (out.outcome === 'conflict') {
      await db.query(
        `INSERT INTO sync_conflicts (mutation_id, user_id, entity, entity_id, reason, client_data, server_data) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [m.id, actor.userId, out.result.entity, out.result.entityId, out.result.reason, m.payload, out.result.server],
      );
    }
    return { id: m.id, outcome: out.outcome, ...out.result };
  });
}

// ---------------------------------------------------------------------------
// Pull: everything in the user's offline scope that changed since the cursor.
// The cursor carries a change number and a time; rows touched shortly before
// that time are sent again, which covers transactions that committed late.
// Re-sent rows are harmless because the device upserts by id.
// ---------------------------------------------------------------------------

const OVERLAP_MS = 5 * 60_000;

function decodeCursor(c?: string): { seq: number; at: Date } | null {
  if (!c) return null;
  const [seq, at] = c.split('.');
  if (!seq || !at || Number.isNaN(Number(seq)) || Number.isNaN(Number(at))) throw badRequest('Invalid sync cursor');
  return { seq: Number(seq), at: new Date(Number(at) - OVERLAP_MS) };
}

async function scopeSessionIds(db: Db, actor: Actor): Promise<string[]> {
  if (actor.role === 'admin') {
    return (await many(db, `SELECT id FROM sessions WHERE starts_at BETWEEN now() - interval '14 days' AND now() + interval '30 days'`)).map((r) => r.id);
  }
  if (actor.role === 'coach') {
    return (
      await many(
        db,
        `SELECT s.id FROM sessions s JOIN session_coaches sc ON sc.session_id = s.id
          WHERE sc.coach_id = $1 AND sc.active AND s.starts_at BETWEEN now() - interval '14 days' AND now() + interval '30 days'`,
        [actor.profileId],
      )
    ).map((r) => r.id);
  }
  return (
    await many(
      db,
      `SELECT DISTINCT b.session_id AS id FROM bookings b JOIN sessions s ON s.id = b.session_id
        WHERE b.player_id = ANY($1) AND s.starts_at BETWEEN now() - interval '30 days' AND now() + interval '60 days'`,
      [await ownPlayers(db, actor)],
    )
  ).map((r) => r.id);
}

async function ownPlayers(db: Db, actor: Actor): Promise<string[]> {
  if (actor.role === 'player') return [actor.profileId!];
  if (actor.role === 'guardian') return (await many(db, `SELECT player_id FROM player_guardians WHERE guardian_id = $1`, [actor.profileId])).map((r) => r.player_id);
  return [];
}

async function pull(db: Db, actor: Actor, cursorStr?: string) {
  const cursor = decodeCursor(cursorStr);
  const head = await one(db, `SELECT last_value AS seq, now() AS at FROM change_seq`);
  const since = cursor?.seq ?? 0;
  const sinceAt = cursor?.at ?? new Date(0);
  const changed = (alias: string) => `(${alias}.change_seq > $2 OR ${alias}.updated_at > $3)`;

  const sessionIds = await scopeSessionIds(db, actor);
  const staff = actor.role === 'admin' || actor.role === 'coach';
  const mine = await ownPlayers(db, actor);
  // Sessions whose coach assignment changed are re-sent whole, so a newly
  // assigned coach gets the full register even for rows older than the cursor.
  const reassigned = new Set(
    (
      await many(
        db,
        `SELECT session_id FROM session_coaches sc WHERE sc.session_id = ANY($1) AND ${changed('sc')}`,
        [sessionIds, since, sinceAt],
      )
    ).map((r) => r.session_id),
  );
  const fresh = cursor === null;

  const sessions = await many(
    db,
    `SELECT s.*, coalesce((SELECT json_agg(json_build_object('id', c.id, 'full_name', c.full_name))
                             FROM session_coaches sc JOIN coaches c ON c.id = sc.coach_id WHERE sc.session_id = s.id AND sc.active), '[]') AS coaches,
            l.name AS location_name, a.name AS area_name, cat.name AS category_name, cat.code AS category_code
       FROM sessions s LEFT JOIN locations l ON l.id = s.location_id LEFT JOIN training_areas a ON a.id = s.area_id
       JOIN session_categories cat ON cat.id = s.category_id
      WHERE s.id = ANY($1) AND ($4 OR s.id = ANY($5) OR ${changed('s')})`,
    [sessionIds, since, sinceAt, fresh, [...reassigned]],
  );
  const bookings = await many(
    db,
    `SELECT b.id, b.session_id, b.player_id, b.status, b.source, b.is_makeup, b.approvals_needed, b.waitlist_position, b.updated_at
       FROM bookings b
      WHERE b.session_id = ANY($1) AND ($4 OR b.session_id = ANY($5) OR ${changed('b')})
        AND ($6 OR b.player_id = ANY($7))`,
    [sessionIds, since, sinceAt, fresh, [...reassigned], staff, mine],
  );
  const attendance = await many(
    db,
    `SELECT a.id, a.session_id, a.player_id, a.status, a.original_status, a.note, a.recorded_at, a.admin_locked, a.version, a.updated_at
       FROM attendance a
      WHERE a.session_id = ANY($1) AND ($4 OR a.session_id = ANY($5) OR ${changed('a')})
        AND ($6 OR a.player_id = ANY($7))`,
    [sessionIds, since, sinceAt, fresh, [...reassigned], staff, mine],
  );
  // Player profiles for everyone on the coach's registers; for families, their own.
  const playerRows = await many(
    db,
    `SELECT p.* FROM players p
      WHERE (p.id = ANY($4) OR ($5 AND p.id IN (SELECT player_id FROM bookings WHERE session_id = ANY($1) AND status IN ('confirmed', 'completed', 'pending', 'waitlisted'))))
        AND ($6 OR ${changed('p')} OR p.id IN (SELECT player_id FROM bookings WHERE session_id = ANY($7)))`,
    [sessionIds, since, sinceAt, mine, staff, fresh, [...reassigned]],
  );
  const access = actor.role === 'admin' ? 'full' : actor.role === 'coach' ? 'coach' : actor.role === 'guardian' ? 'guardian' : 'self';
  const players = playerRows.map((p) => presentPlayer(p, access));
  const playerIds = playerRows.map((p) => p.id);

  // Safety information a coach needs at the nets, even without a connection.
  const injuries = staff
    ? await many(
        db,
        `SELECT id, player_id, title, severity, is_current, recovery_status, professional_restrictions, follow_up_date, updated_at
           FROM injuries WHERE player_id = ANY($1) AND (is_current OR severity = 'major') AND ($4 OR ${changed('injuries')})`,
        [playerIds, since, sinceAt, fresh],
      )
    : [];
  const coachNotes = await many(
    db,
    `SELECT n.*, c.full_name AS coach_name FROM coach_notes n JOIN coaches c ON c.id = n.coach_id
      WHERE ($4 OR ${changed('n')})
        AND CASE WHEN $5 = 'coach' THEN n.coach_id = $6 AND (n.session_id = ANY($1) OR n.player_id = ANY($7))
                 WHEN $5 = 'admin' THEN n.session_id = ANY($1)
                 ELSE n.shared_with_player AND n.player_id = ANY($8) END`,
    [sessionIds, since, sinceAt, fresh, actor.role, actor.profileId, playerIds, mine],
  );
  const journal = actor.role === 'player' || actor.role === 'guardian'
    ? await many(db, `SELECT * FROM player_journal_entries j WHERE j.player_id = ANY($1) AND ($4 OR ${changed('j')}) ORDER BY entry_date DESC LIMIT 500`, [mine, since, sinceAt, fresh])
    : [];
  const removed =
    actor.role === 'coach'
      ? (await many(db, `SELECT session_id FROM session_coaches sc WHERE sc.coach_id = $1 AND NOT sc.active AND ${changed('sc')}`, [actor.profileId, since, sinceAt])).map((r) => r.session_id)
      : [];

  return {
    cursor: `${head.seq}.${new Date(head.at).getTime()}`,
    serverTime: head.at,
    full: fresh,
    sessions: sessions.map(presentSession),
    bookings,
    attendance,
    players,
    injuries,
    coachNotes: coachNotes.map(presentCoachNote),
    journal: journal.map(presentJournal),
    removedSessionIds: removed,
  };
}

export async function syncRoutes(app: FastifyInstance) {
  app.post('/v1/sync/push', async (req) => {
    const actor = actorOf(req);
    const body = parse(z.object({ mutations: z.array(mutation).max(200) }), req.body);
    const results = [];
    // In order, one transaction each: a later change can depend on an earlier one.
    for (const m of body.mutations) results.push(await processMutation(actor, m));
    return { results };
  });

  app.get('/v1/sync/pull', async (req) => {
    const actor = actorOf(req);
    const q = parse(z.object({ cursor: z.string().max(100).optional() }), req.query);
    return pull(pool, actor, q.cursor);
  });

  app.get('/v1/sync/conflicts', async (req) => {
    const actor = actorOf(req);
    const q = parse(z.object({ status: z.enum(['open', 'resolved', 'dismissed']).default('open') }), req.query);
    return many(
      pool,
      `SELECT c.*, u.display_name AS user_name, m.type AS mutation_type, m.client_time
         FROM sync_conflicts c JOIN users u ON u.id = c.user_id JOIN sync_mutations m ON m.id = c.mutation_id
        WHERE c.status = $1 AND ($2 OR c.user_id = $3) ORDER BY c.created_at DESC LIMIT 200`,
      [q.status, actor.role === 'admin', actor.userId],
    );
  });

  // An admin decides which version stands. Choosing the device's version
  // re-applies it as an admin change, so it goes through the normal history.
  app.post('/v1/sync/conflicts/:id/resolve', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ keep: z.enum(['server', 'client']), note: z.string().max(500).optional() }), req.body);
    return tx(async (db) => {
      const c = await one(db, `SELECT c.*, m.type FROM sync_conflicts c JOIN sync_mutations m ON m.id = c.mutation_id WHERE c.id = $1 FOR UPDATE OF c`, [id]);
      if (!c) throw notFound('Conflict');
      if (c.status !== 'open') throw badRequest('This conflict is already closed');
      if (body.keep === 'client') {
        const p = c.client_data;
        if (c.type === 'attendance.mark') {
          const r = await markAttendance(db, actor, p.sessionId, { ...p, baseVersion: undefined, reason: body.note ?? 'Sync conflict resolved in favour of the device' });
          if (r.outcome === 'conflict') throw badRequest(r.reason);
        } else if (c.type === 'coach_note.upsert') {
          // Re-save the device's content on top of the current version.
          const current = await one(db, `SELECT version FROM coach_notes WHERE id = $1`, [c.entity_id]);
          await upsertCoachNote(db, actor, { ...p, baseVersion: current.version });
        } else if (c.type === 'journal.upsert') {
          throw badRequest('Only the player can change their journal; ask them to save it again');
        }
      }
      await db.query(`UPDATE sync_conflicts SET status = 'resolved', resolved_by = $2, resolution = $3, resolved_at = now() WHERE id = $1`, [id, actor.userId, body.keep]);
      await audit(db, actor, 'sync_conflict_resolved', 'sync_conflict', id, null, body);
      return { ok: true };
    });
  });
}
