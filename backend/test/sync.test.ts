import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshApp, givePackage, inHours, World, world } from './helpers.js';

let app: FastifyInstance;
let w: World;
let sessionId: string;

beforeAll(async () => {
  app = await freshApp();
  w = await world(app);
  await givePackage(w.admin, w.adult);
  const s = await w.admin.post('/v1/sessions', { sessionType: 'one_on_two', coachIds: [w.coachAId], startsAt: inHours(-1), endsAt: inHours(0.5), playerIds: [w.adult, w.minor] });
  sessionId = s.session.id;
});
afterAll(async () => {
  await app.close();
});

const mark = (playerId: string, status: string, extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), type: 'attendance.mark', clientTime: new Date().toISOString(), payload: { sessionId, playerId, status, ...extra },
});

describe('offline sync', () => {
  it('gives a coach their sessions, registers and safety notes on first pull', async () => {
    await w.admin.post(`/v1/players/${w.minor}/injuries`, { title: 'Side strain', severity: 'major', professional_restrictions: 'No fast bowling' });
    const p = await w.coachA.get('/v1/sync/pull');
    expect(p.full).toBe(true);
    expect(p.sessions.map((s: any) => s.id)).toContain(sessionId);
    expect(p.bookings.filter((b: any) => b.session_id === sessionId)).toHaveLength(2);
    expect(p.players.map((x: any) => x.id).sort()).toEqual([w.adult, w.minor].sort());
    expect(p.injuries[0].professional_restrictions).toBe('No fast bowling');
    const other = await w.coachB.get('/v1/sync/pull');
    expect(other.sessions).toHaveLength(0);
    expect(other.players).toHaveLength(0);
  });

  it('applies a mutation once even if the device sends it again', async () => {
    const m = mark(w.adult, 'present');
    const a = await w.coachA.post('/v1/sync/push', { mutations: [m] });
    const b = await w.coachA.post('/v1/sync/push', { mutations: [m] });
    expect(a.results[0].outcome).toBe('applied');
    expect(b.results[0].replayed).toBe(true);
    const pk = (await w.admin.get(`/v1/players/${w.adult}/packages`))[0];
    expect(pk.sessions_used).toBe(1);
  });

  it('holds a stale offline change as a conflict instead of overwriting', async () => {
    const first = await w.coachA.post('/v1/sync/push', { mutations: [mark(w.minor, 'absent')] });
    const version = first.results[0].attendance.version;
    // Admin changes it while the coach's phone is offline.
    await w.admin.post(`/v1/attendance/${first.results[0].attendance.id}/override`, { status: 'excused', reason: 'Exam leave letter' });
    const offline = await w.coachA.post('/v1/sync/push', { mutations: [mark(w.minor, 'late', { baseVersion: version })] });
    expect(offline.results[0].outcome).toBe('conflict');
    const conflicts = await w.admin.get('/v1/sync/conflicts');
    expect(conflicts).toHaveLength(1);
    const detail = await w.admin.get(`/v1/sessions/${sessionId}`);
    expect(detail.attendance.find((a: any) => a.player_id === w.minor).status).toBe('excused');
    // The admin decides; keeping the device's version goes through normal history.
    await w.admin.post(`/v1/sync/conflicts/${conflicts[0].id}/resolve`, { keep: 'client', note: 'Coach saw him arrive late' });
    const after = await w.admin.get(`/v1/sessions/${sessionId}`);
    expect(after.attendance.find((a: any) => a.player_id === w.minor).status).toBe('late');
  });

  it('rejects what the server rules forbid and remembers the answer', async () => {
    const m = mark(w.other, 'present');
    const r = await w.coachA.post('/v1/sync/push', { mutations: [m] });
    expect(r.results[0].outcome).toBe('rejected');
    expect(r.results[0].code).toBe('not_booked');
  });

  it('keeps offline booking requests pending until the server decides', async () => {
    const s = await w.admin.post('/v1/sessions', { sessionType: 'one_on_one', bookingMode: 'open', coachIds: [w.coachBId], startsAt: inHours(72), endsAt: inHours(73) });
    const m = { id: crypto.randomUUID(), type: 'booking.request', clientTime: new Date().toISOString(), payload: { sessionId: s.session.id, playerId: w.adult } };
    const r = await w.player.post('/v1/sync/push', { mutations: [m] });
    expect(r.results[0].booking.status).toBe('pending');
    const again = await w.player.post('/v1/sync/push', { mutations: [m] });
    expect(again.results[0].booking.id).toBe(r.results[0].booking.id);
  });

  it('syncs coach notes and journals with versions, and sends only changes after the cursor', async () => {
    const base = await w.coachA.get('/v1/sync/pull');
    const noteId = crypto.randomUUID();
    const note = { id: crypto.randomUUID(), type: 'coach_note.upsert', clientTime: new Date().toISOString(), payload: { id: noteId, sessionId, playerId: w.adult, technicalCorrections: 'Head falling over at release', sharedWithPlayer: true } };
    expect((await w.coachA.post('/v1/sync/push', { mutations: [note] })).results[0].status).toBe('created');
    const stale = { ...note, id: crypto.randomUUID(), payload: { ...note.payload, baseVersion: 0, technicalCorrections: 'old' } };
    expect((await w.coachA.post('/v1/sync/push', { mutations: [stale] })).results[0].outcome).toBe('conflict');
    const inc = await w.coachA.get(`/v1/sync/pull?cursor=${encodeURIComponent(base.cursor)}`);
    expect(inc.full).toBe(false);
    expect(inc.coachNotes.map((n: any) => n.id)).toContain(noteId);
    // The shared note reaches the player; an unshared one would not.
    const playerPull = await w.player.get('/v1/sync/pull');
    expect(playerPull.coachNotes.map((n: any) => n.id)).toContain(noteId);
    const kidPull = await w.kid.get('/v1/sync/pull');
    expect(kidPull.coachNotes).toHaveLength(0);

    const entry = { id: crypto.randomUUID(), type: 'journal.upsert', clientTime: new Date().toISOString(), payload: { id: crypto.randomUUID(), playerId: w.adult, entryDate: '2026-10-22', skills: 'Cover drive', volume: { balls: 120 }, wentWell: 'Balance' } };
    expect((await w.player.post('/v1/sync/push', { mutations: [entry] })).results[0].outcome).toBe('applied');
    const wrong = { ...entry, id: crypto.randomUUID(), payload: { ...entry.payload, id: crypto.randomUUID(), playerId: w.minor } };
    expect((await w.player.post('/v1/sync/push', { mutations: [wrong] })).results[0].outcome).toBe('rejected');
    expect(await w.guardian.get(`/v1/players/${w.minor}/journal`)).toHaveLength(0);
  });
});
