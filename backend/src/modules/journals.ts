import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Db, many, one, pool, tx } from '../db.js';
import { Actor } from '../lib/actor.js';
import { audit } from '../lib/audit.js';
import { coachCanSeePlayer, isSessionCoach, requirePlayerAccess } from '../lib/authz.js';
import { forbidden, notFound } from '../lib/errors.js';
import { actorOf, idParams, isoDate, parse } from '../lib/http.js';
import { notifyUsers, playerAudience } from '../lib/notify.js';

// Journals and coach notes are written offline, so the device chooses the id
// and every edit carries the version it was based on. A stale edit is never
// applied over a newer one; it comes back as a conflict instead.

const text = z.string().trim().max(4000).nullable().optional();

export const journalInput = z.object({
  id: z.uuid(),
  baseVersion: z.number().int().optional(),
  playerId: z.uuid(),
  sessionId: z.uuid().nullable().optional(),
  entryDate: isoDate,
  skills: text,
  drills: text,
  volume: z.object({ reps: z.number().int().min(0).optional(), sets: z.number().int().min(0).optional(), balls: z.number().int().min(0).optional(), overs: z.number().min(0).optional() }).default({}),
  wentWell: text,
  toImprove: text,
  reflections: text,
  goals: text,
  difficulties: text,
  deleted: z.boolean().optional(),
});

export const coachNoteInput = z.object({
  id: z.uuid(),
  baseVersion: z.number().int().optional(),
  sessionId: z.uuid().nullable().optional(),
  playerId: z.uuid().nullable().optional(),
  objectives: text,
  drillsCompleted: text,
  technicalCorrections: text,
  tacticalAwareness: text,
  matchSimulation: text,
  mentalSkills: text,
  fitness: text,
  followUpDrills: text,
  nextTargets: text,
  sharedWithPlayer: z.boolean().default(false),
  deleted: z.boolean().optional(),
});

const JOURNAL_COLS: Record<string, string> = {
  sessionId: 'session_id', entryDate: 'entry_date', skills: 'skills', drills: 'drills', volume: 'volume',
  wentWell: 'went_well', toImprove: 'to_improve', reflections: 'reflections', goals: 'goals', difficulties: 'difficulties', deleted: 'deleted',
};
const NOTE_COLS: Record<string, string> = {
  objectives: 'objectives', drillsCompleted: 'drills_completed', technicalCorrections: 'technical_corrections',
  tacticalAwareness: 'tactical_awareness', matchSimulation: 'match_simulation', mentalSkills: 'mental_skills', fitness: 'fitness',
  followUpDrills: 'follow_up_drills', nextTargets: 'next_targets', sharedWithPlayer: 'shared_with_player', deleted: 'deleted',
};

export type UpsertResult = { outcome: 'created' | 'updated' | 'unchanged'; record: any } | { outcome: 'conflict'; reason: string; record: any };

async function upsert(db: PoolClient, actor: Actor, table: string, entity: string, cols: Record<string, string>, input: any, insertExtra: Record<string, unknown>): Promise<UpsertResult> {
  const existing = await one(db, `SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [input.id]);
  const fields = Object.entries(cols).filter(([k]) => input[k] !== undefined);
  if (!existing) {
    const all: [string, unknown][] = [...Object.entries(insertExtra), ...fields.map(([k, c]) => [c, input[k]] as [string, unknown])];
    const row = await one(
      db,
      `INSERT INTO ${table} (id, created_by, updated_by, ${all.map(([c]) => c).join(', ')})
       VALUES ($1, $2, $2, ${all.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING *`,
      [input.id, actor.userId, ...all.map(([, v]) => v)],
    );
    await audit(db, actor, `${entity}_created`, entity, row.id, null, null);
    return { outcome: 'created', record: row };
  }
  if (input.baseVersion === undefined || input.baseVersion !== existing.version) {
    return { outcome: 'conflict', reason: 'This entry was edited elsewhere after your copy was taken', record: existing };
  }
  if (fields.every(([k, c]) => JSON.stringify(existing[c] ?? null) === JSON.stringify(input[k] ?? null))) return { outcome: 'unchanged', record: existing };
  // Keep the previous version in full before changing it.
  await db.query(`INSERT INTO record_revisions (entity, entity_id, version, data, edited_by) VALUES ($1, $2, $3, $4, $5)`, [entity, existing.id, existing.version, existing, actor.userId]);
  const row = await one(
    db,
    `UPDATE ${table} SET ${fields.map(([, c], i) => `${c} = $${i + 3}`).join(', ')}, updated_by = $2, version = version + 1 WHERE id = $1 RETURNING *`,
    [input.id, actor.userId, ...fields.map(([k]) => input[k])],
  );
  await audit(db, actor, `${entity}_updated`, entity, row.id, null, null);
  return { outcome: 'updated', record: row };
}

export async function upsertJournal(db: PoolClient, actor: Actor, input: z.infer<typeof journalInput>): Promise<UpsertResult> {
  // Only the player writes their own journal.
  if (!(actor.role === 'player' && actor.profileId === input.playerId)) throw forbidden('Only the player can write in their journal');
  const existing = await one(db, `SELECT player_id FROM player_journal_entries WHERE id = $1`, [input.id]);
  if (existing && existing.player_id !== input.playerId) throw forbidden();
  return upsert(db, actor, 'player_journal_entries', 'journal_entry', JOURNAL_COLS, input, { player_id: input.playerId });
}

export async function upsertCoachNote(db: PoolClient, actor: Actor, input: z.infer<typeof coachNoteInput>): Promise<UpsertResult> {
  if (actor.role !== 'coach' && actor.role !== 'admin') throw forbidden();
  if (!input.sessionId && !input.playerId) throw forbidden('A note must belong to a session or a player');
  const existing = await one(db, `SELECT * FROM coach_notes WHERE id = $1`, [input.id]);
  if (existing) {
    // Coaches edit their own notes; admins can edit any.
    if (actor.role === 'coach' && existing.coach_id !== actor.profileId) throw forbidden('You can only edit your own notes');
  } else if (actor.role === 'coach') {
    const ok =
      (input.sessionId && (await isSessionCoach(db, actor, input.sessionId))) ||
      (!input.sessionId && input.playerId && (await coachCanSeePlayer(db, actor.profileId!, input.playerId)));
    if (!ok) throw forbidden('You are not coaching this session or player');
  }
  let coachId = existing?.coach_id ?? actor.profileId;
  if (!coachId) {
    // An admin writing a note is recorded against the session's first coach.
    const c = input.sessionId ? await one(db, `SELECT coach_id FROM session_coaches WHERE session_id = $1 AND active LIMIT 1`, [input.sessionId]) : null;
    if (!c) throw forbidden('Choose a session with a coach for this note');
    coachId = c.coach_id;
  }
  const result = await upsert(db, actor, 'coach_notes', 'coach_note', NOTE_COLS, input, {
    session_id: input.sessionId ?? null,
    player_id: input.playerId ?? null,
    coach_id: coachId,
  });
  const becameShared = result.outcome !== 'conflict' && result.record.shared_with_player && !(existing?.shared_with_player);
  if (becameShared && result.record.player_id) {
    await notifyUsers(db, await playerAudience(db, [result.record.player_id]), {
      kind: 'coach_feedback', title: 'New feedback from your coach', body: 'Your coach has shared feedback and drills.', data: { noteId: result.record.id },
    });
  }
  return result;
}

export function presentJournal(r: any) {
  return {
    id: r.id, playerId: r.player_id, sessionId: r.session_id, entryDate: r.entry_date, skills: r.skills, drills: r.drills,
    volume: r.volume, wentWell: r.went_well, toImprove: r.to_improve, reflections: r.reflections, goals: r.goals,
    difficulties: r.difficulties, version: r.version, deleted: r.deleted, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function presentCoachNote(r: any) {
  return {
    id: r.id, sessionId: r.session_id, playerId: r.player_id, coachId: r.coach_id, coachName: r.coach_name,
    objectives: r.objectives, drillsCompleted: r.drills_completed, technicalCorrections: r.technical_corrections,
    tacticalAwareness: r.tactical_awareness, matchSimulation: r.match_simulation, mentalSkills: r.mental_skills,
    fitness: r.fitness, followUpDrills: r.follow_up_drills, nextTargets: r.next_targets, sharedWithPlayer: r.shared_with_player,
    version: r.version, deleted: r.deleted, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

async function notesForPlayer(db: Db, actor: Actor, playerId: string) {
  const access = await requirePlayerAccess(db, actor, playerId);
  // Players and guardians see only what the coach chose to share.
  const sharedOnly = access === 'self' || access === 'guardian';
  return many(
    db,
    `SELECT n.*, c.full_name AS coach_name FROM coach_notes n JOIN coaches c ON c.id = n.coach_id
      WHERE NOT n.deleted AND (n.player_id = $1 OR (n.player_id IS NULL AND n.session_id IN
              (SELECT session_id FROM bookings WHERE player_id = $1 AND status IN ('confirmed', 'completed'))))
        AND (NOT $2 OR n.shared_with_player)
      ORDER BY n.created_at DESC LIMIT 300`,
    [playerId, sharedOnly],
  );
}

export async function journalRoutes(app: FastifyInstance) {
  app.put('/v1/journal-entries/:id', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const body = parse(journalInput, { ...(req.body as object), id });
    const r = await tx((db) => upsertJournal(db, actor, body));
    return { ...r, record: presentJournal(r.record) };
  });

  app.get('/v1/players/:id/journal', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    await requirePlayerAccess(pool, actor, id);
    const rows = await many(pool, `SELECT * FROM player_journal_entries WHERE player_id = $1 AND NOT deleted ORDER BY entry_date DESC, created_at DESC LIMIT 300`, [id]);
    return rows.map(presentJournal);
  });

  app.put('/v1/coach-notes/:id', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const body = parse(coachNoteInput, { ...(req.body as object), id });
    const r = await tx((db) => upsertCoachNote(db, actor, body));
    return { ...r, record: presentCoachNote(r.record) };
  });

  app.get('/v1/players/:id/coach-notes', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    return (await notesForPlayer(pool, actor, id)).map(presentCoachNote);
  });

  app.get('/v1/sessions/:id/coach-notes', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    if (actor.role !== 'admin' && !(await isSessionCoach(pool, actor, id))) throw forbidden();
    const rows = await many(pool, `SELECT n.*, c.full_name AS coach_name FROM coach_notes n JOIN coaches c ON c.id = n.coach_id WHERE n.session_id = $1 AND NOT n.deleted ORDER BY n.created_at`, [id]);
    return rows.map(presentCoachNote);
  });

  app.get('/v1/revisions/:entity/:id', async (req) => {
    const actor = actorOf(req);
    const { entity, id } = parse(z.object({ entity: z.enum(['journal_entry', 'coach_note']), id: z.uuid() }), req.params);
    const table = entity === 'journal_entry' ? 'player_journal_entries' : 'coach_notes';
    const rec = await one(pool, `SELECT * FROM ${table} WHERE id = $1`, [id]);
    if (!rec) throw notFound('Record');
    if (actor.role !== 'admin' && rec.created_by !== actor.userId) throw forbidden();
    return many(pool, `SELECT r.version, r.data, r.created_at, u.display_name AS edited_by FROM record_revisions r JOIN users u ON u.id = r.edited_by WHERE entity = $1 AND entity_id = $2 ORDER BY version`, [entity, id]);
  });
}
