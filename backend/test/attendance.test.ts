import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshApp, givePackage, inHours, World, world } from './helpers.js';

let app: FastifyInstance;
let w: World;
let pkgAdult: any;

beforeAll(async () => {
  app = await freshApp();
  w = await world(app);
  pkgAdult = await givePackage(w.admin, w.adult, 8);
  await givePackage(w.admin, w.minor, 4);
});
afterAll(async () => {
  await app.close();
});

const remaining = async (playerId: string) => (await w.admin.get(`/v1/players/${playerId}/packages`))[0].remaining;

async function oneOnTwo(startOffsetHours = -1) {
  const s = await w.admin.post('/v1/sessions', {
    sessionType: 'one_on_two', coachIds: [w.coachAId], startsAt: inHours(startOffsetHours), endsAt: inHours(startOffsetHours + 1), playerIds: [w.adult, w.minor],
  });
  return s.session.id as string;
}

describe('attendance', () => {
  it('records each player in a one-on-two session separately in one shared session', async () => {
    const sessionId = await oneOnTwo(-2);
    const r = await w.coachA.put(`/v1/sessions/${sessionId}/attendance`, {
      records: [{ playerId: w.adult, status: 'present' }, { playerId: w.minor, status: 'absent' }],
    });
    expect(r.results.map((x: any) => x.outcome)).toEqual(['created', 'created']);
    const detail = await w.admin.get(`/v1/sessions/${sessionId}`);
    expect(detail.attendance).toHaveLength(2);
    expect(detail.present_count).toBe(1);
    // Present deducts; a no-show doesn't under the default policy.
    expect(await remaining(w.adult)).toBe(7);
    expect(await remaining(w.minor)).toBe(4);
  });

  it('never creates duplicate records or double deductions on repeat marks', async () => {
    const sessionId = await oneOnTwo(-4);
    for (let i = 0; i < 3; i++) await w.coachA.put(`/v1/sessions/${sessionId}/attendance`, { records: [{ playerId: w.adult, status: 'present' }] });
    const detail = await w.admin.get(`/v1/sessions/${sessionId}`);
    expect(detail.attendance).toHaveLength(1);
    expect(await remaining(w.adult)).toBe(6);
  });

  it('returns the credit when a coach corrects present to excused, keeping history', async () => {
    const sessionId = await oneOnTwo(-6);
    await w.coachA.put(`/v1/sessions/${sessionId}/attendance`, { records: [{ playerId: w.adult, status: 'present' }] });
    expect(await remaining(w.adult)).toBe(5);
    const r = await w.coachA.put(`/v1/sessions/${sessionId}/attendance`, { records: [{ playerId: w.adult, status: 'excused', reason: 'Was unwell, left early' }] });
    expect(r.results[0].outcome).toBe('updated');
    expect(await remaining(w.adult)).toBe(6);
    const history = await w.admin.get(`/v1/attendance/${r.results[0].attendance.id}/history`);
    expect(history.events.map((e: any) => e.kind)).toEqual(['initial', 'correction']);
    expect(history.record.original_status).toBe('present');
  });

  it('lets an admin override, locks the record, and holds a later coach change as a conflict', async () => {
    const sessionId = await oneOnTwo(-8);
    const first = await w.coachA.put(`/v1/sessions/${sessionId}/attendance`, { records: [{ playerId: w.minor, status: 'absent' }] });
    const id = first.results[0].attendance.id;
    await w.admin.post(`/v1/attendance/${id}/override`, { status: 'late', reason: 'Parent confirmed arrival at 6:20' });
    const coach = await w.coachA.put(`/v1/sessions/${sessionId}/attendance`, { records: [{ playerId: w.minor, status: 'absent' }] });
    expect(coach.results[0].outcome).toBe('conflict');
    const history = await w.admin.get(`/v1/attendance/${id}/history`);
    expect(history.events.map((e: any) => [e.kind, e.new_status])).toEqual([['initial', 'absent'], ['override', 'late']]);
    expect(history.record.status).toBe('late');
  });

  it('stops other coaches and players from marking attendance', async () => {
    const sessionId = await oneOnTwo(-10);
    expect((await w.coachB.raw('PUT', `/v1/sessions/${sessionId}/attendance`, { records: [{ playerId: w.adult, status: 'present' }] })).status).toBe(403);
    expect((await w.player.raw('PUT', `/v1/sessions/${sessionId}/attendance`, { records: [{ playerId: w.adult, status: 'present' }] })).status).toBe(403);
  });

  it('refuses unbooked players unless added as walk-ins', async () => {
    const s = await w.admin.post('/v1/sessions', { sessionType: 'group', capacity: 5, coachIds: [w.coachAId], startsAt: inHours(-12), endsAt: inHours(-11), playerIds: [w.adult] });
    const r = await w.coachA.put(`/v1/sessions/${s.session.id}/attendance`, { records: [{ playerId: w.other, status: 'present' }, { playerId: w.minor, status: 'present', walkIn: true }] });
    expect(r.results[0].outcome).toBe('rejected');
    expect(r.results[0].code).toBe('not_booked');
    expect(r.results[1].outcome).toBe('created');
  });

  it('turns a cancelled session into not-applicable, never an absence, and refunds credits', async () => {
    const sessionId = await oneOnTwo(-14);
    await w.coachA.put(`/v1/sessions/${sessionId}/attendance`, { records: [{ playerId: w.adult, status: 'present' }] });
    const before = await remaining(w.adult);
    await w.admin.post(`/v1/sessions/${sessionId}/cancel`, { reason: 'Rain stopped play' });
    expect(await remaining(w.adult)).toBe(before + 1);
    const hist = await w.player.get(`/v1/players/${w.adult}/attendance`);
    const rec = hist.records.find((r: any) => r.session_id === sessionId);
    expect(rec.status).toBe('not_applicable');
    expect(hist.summary.absent).toBe(0);
  });

  it('applies the interrupted-session rule from policy', async () => {
    const sessionId = await oneOnTwo(-16);
    await w.coachA.put(`/v1/sessions/${sessionId}/attendance`, { records: [{ playerId: w.adult, status: 'present' }] });
    const before = await remaining(w.adult);
    await w.coachA.post(`/v1/sessions/${sessionId}/status`, { status: 'interrupted' });
    expect(await remaining(w.adult)).toBe(before + 1);
    await w.admin.patch('/v1/settings/policy', { credits: { interruptedSessionsDeduct: true } });
    await w.admin.post(`/v1/sessions/${sessionId}/status`, { status: 'completed' });
    expect(await remaining(w.adult)).toBe(before);
  });

  it('keeps an auditable ledger and allows explained admin adjustments', async () => {
    await w.admin.post(`/v1/packages/${pkgAdult.id}/adjust`, { delta: 2, kind: 'makeup_grant', note: 'Two make-up sessions for coach absence' });
    const ledger = await w.admin.get(`/v1/packages/${pkgAdult.id}/ledger`);
    const sum = ledger.entries.reduce((a: number, e: any) => a + e.delta, 0);
    expect(ledger.package.remaining).toBe(8 + sum);
    expect((await w.coachA.raw('GET', `/v1/packages/${pkgAdult.id}/ledger`)).status).toBe(403);
  });

  it('reports expected versus present for the day and flags missing registers', async () => {
    await oneOnTwo(-0.5);
    const daily = await w.admin.get('/v1/reports/daily');
    expect(daily.totals.expected).toBeGreaterThan(0);
    const missing = await w.coachA.get('/v1/reports/missing-attendance');
    expect(missing.length).toBeGreaterThan(0);
    const dash = await w.admin.get('/v1/dashboard');
    expect(dash).toHaveProperty('bookingRequestsAwaitingApproval');
  });
});
