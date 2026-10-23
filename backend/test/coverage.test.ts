import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDate } from '../src/lib/time.js';
import { Client, freshApp, inHours, login, makeUser, World, world } from './helpers.js';

let app: FastifyInstance;
let w: World;
let cats: Record<string, any>;

beforeAll(async () => {
  app = await freshApp();
  w = await world(app);
  cats = Object.fromEntries((await w.admin.get('/v1/categories')).map((c: any) => [c.code, c]));
});
afterAll(async () => {
  await app.close();
});

const dayAhead = (n: number) => localDate(new Date(Date.now() + n * 86400_000));
const at = (date: string, time: string) => `${date}T${time}:00+05:30`;
const latest = async (c: { get: (u: string) => Promise<any> }) => (await c.get('/v1/notifications'))[0];
const titles = async (c: { get: (u: string) => Promise<any> }) => (await c.get('/v1/notifications')).map((n: any) => n.title);

describe('coach leave and reassignment', () => {
  let sessionId: string;
  const tomorrow = dayAhead(1);

  it('records same-day emergency leave and flags the sessions that need another coach', async () => {
    const s = await w.admin.post('/v1/sessions', { sessionType: 'one_on_one', coachIds: [w.coachAId], startsAt: at(tomorrow, '10:00'), endsAt: at(tomorrow, '11:00'), playerIds: [w.adult] });
    sessionId = s.session.id;
    const r = await w.coachA.post(`/v1/coaches/${w.coachAId}/leave`, { kind: 'emergency', reason: 'Fever', startsAt: new Date().toISOString(), endsAt: at(tomorrow, '23:00') });
    expect(r.leave.kind).toBe('emergency');
    expect(r.leave.recorded_by_name).toBe('coach.a');
    expect(r.affectedSessions.map((x: any) => x.id)).toContain(sessionId);
    expect((await latest(w.admin)).title).toBe("Emergency: Coach Arun can't come in");
    const dash = await w.admin.get('/v1/dashboard');
    expect(dash.sessionsNeedingCover.map((x: any) => x.id)).toContain(sessionId);
    expect(dash.coachesOnLeaveToday[0].coach_name).toBe('Coach Arun');
  });

  it("doesn't let a coach record leave for someone else", async () => {
    const r = await w.coachB.raw('POST', `/v1/coaches/${w.coachAId}/leave`, { kind: 'planned', date: dayAhead(3) });
    expect(r.status).toBe(403);
  });

  it('refuses to assign a coach who is on leave', async () => {
    const r = await w.admin.raw('POST', '/v1/sessions', { sessionType: 'one_on_one', coachIds: [w.coachAId], startsAt: at(tomorrow, '12:00'), endsAt: at(tomorrow, '13:00') });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('coach_on_leave');
  });

  it('lists coaches for cover in priority order with who is free, and reassigns', async () => {
    await w.admin.put(`/v1/categories/${cats.one_on_one.id}/coaches`, { coachIds: [w.coachBId, w.coachAId] });
    const list = await w.admin.get(`/v1/sessions/${sessionId}/available-coaches`);
    expect(list.map((c: any) => [c.full_name, c.priority, c.free, c.on_leave, c.current])).toEqual([
      ['Coach Bala', 1, true, false, false],
      ['Coach Arun', 2, false, true, true],
    ]);
    await w.admin.put(`/v1/sessions/${sessionId}/coaches`, { coachIds: [w.coachBId], reason: 'Arun is unwell' });
    expect((await w.admin.get('/v1/sessions/needing-cover')).map((x: any) => x.id)).not.toContain(sessionId);
    expect((await latest(w.coachB)).title).toBe('New session on your schedule');
    expect((await latest(w.coachA)).title).toBe('Taken off a session');
    expect((await latest(w.player)).title).toBe('Your coach has changed');
  });

  it('keeps cancelled leave on record and frees the coach again', async () => {
    const mine = await w.coachA.get(`/v1/coaches/${w.coachAId}/leave`);
    const cancelled = await w.coachA.post(`/v1/leave/${mine[0].id}/cancel`);
    expect(cancelled.status).toBe('cancelled');
    expect((await w.admin.get('/v1/leave')).find((l: any) => l.id === mine[0].id).status).toBe('cancelled');
    const ok = await w.admin.post('/v1/sessions', { sessionType: 'one_on_one', coachIds: [w.coachAId], startsAt: at(tomorrow, '14:00'), endsAt: at(tomorrow, '15:00') });
    expect(ok.session.id).toBeTruthy();
  });

  it('treats emergency leave with no times as the rest of today', async () => {
    const r = await w.coachB.post(`/v1/coaches/${w.coachBId}/leave`, { kind: 'emergency' });
    expect(localDate(new Date(new Date(r.leave.ends_at).getTime() - 1))).toBe(localDate());
    await w.coachB.post(`/v1/leave/${r.leave.id}/cancel`);
  });

  it('records planned leave for whole days', async () => {
    const r = await w.admin.post(`/v1/coaches/${w.coachBId}/leave`, { kind: 'planned', date: dayAhead(10), untilDate: dayAhead(11), reason: 'Family wedding' });
    expect(new Date(r.leave.ends_at).getTime() - new Date(r.leave.starts_at).getTime()).toBe(2 * 86400_000);
    expect((await latest(w.coachB)).title).toBe('Leave recorded for you');
  });
});

describe('requested one-on-ones with coach priority', () => {
  const day = dayAhead(2);

  beforeAll(async () => {
    await w.admin.put(`/v1/categories/${cats.one_on_one.id}/coaches`, { coachIds: [w.coachAId, w.coachBId] });
  });

  it('offers times when a coach in the list is free', async () => {
    const r = await w.player.get(`/v1/session-requests/slots?playerId=${w.adult}&categoryId=${cats.one_on_one.id}&date=${day}`);
    const ten = r.slots.find((s: any) => new Date(s.startsAt).getTime() === new Date(at(day, '10:00')).getTime());
    expect(ten.coaches.map((c: any) => c.full_name)).toEqual(['Coach Arun', 'Coach Bala']);
  });

  let first: any;
  it('gives the request to the first coach, then the next when the first is taken', async () => {
    first = await w.player.post('/v1/session-requests', { playerId: w.adult, categoryId: cats.one_on_one.id, startsAt: at(day, '10:00') });
    expect(first.coach.full_name).toBe('Coach Arun');
    expect(first.booking.status).toBe('pending');
    expect(first.booking.approvals_needed).toEqual(['staff']);
    expect((await latest(w.coachA)).title).toBe('New request: One-on-one');
    expect(await titles(w.admin)).toContain('New request: One-on-one');

    const second = await w.guardian.post('/v1/session-requests', { playerId: w.minor, categoryId: cats.one_on_one.id, startsAt: at(day, '10:00') });
    expect(second.coach.full_name).toBe('Coach Bala');

    const third = await w.admin.raw('POST', '/v1/session-requests', { playerId: w.other, categoryId: cats.one_on_one.id, startsAt: at(day, '10:00') });
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('no_coach_free');
  });

  it('lets the assigned coach confirm, and tells the family, coach and admin', async () => {
    const b = await w.coachA.post(`/v1/bookings/${first.booking.id}/approve`);
    expect(b.status).toBe('confirmed');
    expect((await latest(w.player)).title).toBe('Booking confirmed');
    expect(await titles(w.admin)).toContain('Requested session confirmed');
  });

  it('passes a request on to the next free coach, or declines it when nobody is free', async () => {
    const r = await w.player.post('/v1/session-requests', { playerId: w.adult, categoryId: cats.one_on_one.id, startsAt: at(day, '15:00') });
    expect(r.coach.full_name).toBe('Coach Arun');
    const passed = await w.coachA.post(`/v1/session-requests/${r.booking.id}/pass`, { reason: 'Away that afternoon' });
    expect(passed.coach.full_name).toBe('Coach Bala');
    expect((await latest(w.player)).title).toBe('Your request moved to another coach');
    // Coach A no longer runs it, so can't confirm it; coach B can pass it again.
    expect((await w.coachA.raw('POST', `/v1/bookings/${r.booking.id}/approve`)).status).toBe(403);
    const none = await w.coachB.post(`/v1/session-requests/${r.booking.id}/pass`);
    expect(none.coach).toBeNull();
    expect(none.booking.status).toBe('rejected');
    const session = await w.admin.get(`/v1/sessions/${r.session.id}`);
    expect(session.status).toBe('cancelled');
  });

  it('needs a parent and the academy when a minor asks for themself', async () => {
    const r = await w.kid.post('/v1/session-requests', { playerId: w.minor, categoryId: cats.one_on_one.id, startsAt: at(day, '17:00') });
    expect(r.booking.approvals_needed).toEqual(['guardian', 'staff']);
    expect((await latest(w.guardian)).title).toBe('Session request needs your approval');
    // The parent declining frees the coach's time.
    await w.guardian.post(`/v1/bookings/${r.booking.id}/reject`, { reason: 'Exams that week' });
    expect((await w.admin.get(`/v1/sessions/${r.session.id}`)).status).toBe('cancelled');
  });

  it("won't take requests for categories the academy hasn't opened", async () => {
    const r = await w.player.raw('POST', '/v1/session-requests', { playerId: w.adult, categoryId: cats.group.id, startsAt: at(day, '11:00') });
    expect(r.status).toBe(400);
  });
});

describe('packages made of parts', () => {
  let pkg: any;
  let kid2: Client;

  beforeAll(async () => {
    await makeUser('other.kid', 'player', 'players', w.other);
    kid2 = await login(app, 'other.kid');
  });

  it('creates a package from a template: 9 one-on-one + 3 strength & conditioning', async () => {
    const t = await w.admin.post('/v1/package-templates', {
      name: '12-session pack', kind: 'fixed', validity_days: 90,
      items: [{ categoryId: cats.one_on_one.id, total: 9 }, { categoryId: cats.strength_conditioning.id, total: 3 }],
    });
    pkg = await w.admin.post(`/v1/players/${w.other}/packages`, { templateId: t.id, starts_on: dayAhead(-5) });
    expect(pkg.total_sessions).toBe(12);
    expect(pkg.expires_on).toBe(dayAhead(84));
    expect(pkg.parts.map((p: any) => [p.category_code, p.total_sessions, p.remaining])).toEqual([
      ['one_on_one', 9, 9],
      ['strength_conditioning', 3, 3],
    ]);
  });

  const part = async (code: string) => (await w.admin.get(`/v1/players/${w.other}/packages`))[0].parts.find((p: any) => p.category_code === code);

  it('takes an S&C session only from the S&C part and tells everyone what is left', async () => {
    const s = await w.admin.post('/v1/sessions', {
      sessionType: 'one_on_one', categoryId: cats.strength_conditioning.id, coachIds: [w.coachBId], startsAt: inHours(-30), endsAt: inHours(-29), playerIds: [w.other],
    });
    await w.coachB.put(`/v1/sessions/${s.session.id}/attendance`, { records: [{ playerId: w.other, status: 'present' }] });
    expect((await part('strength_conditioning')).remaining).toBe(2);
    expect((await part('strength_conditioning')).used).toBe(1);
    expect((await part('one_on_one')).remaining).toBe(9);
    expect((await latest(kid2)).title).toBe('2 of 3 Strength & conditioning sessions left');
    // Down to the low-balance mark (2): the admin hears about it.
    expect(await titles(w.admin)).toContain('Other Kid has 2 Strength & conditioning sessions left');
  });

  it('returns the session to the same part when attendance is corrected', async () => {
    const sessions = await w.admin.get(`/v1/sessions?playerId=${w.other}&from=${inHours(-48)}&to=${inHours(0)}`);
    await w.coachB.put(`/v1/sessions/${sessions[0].id}/attendance`, { records: [{ playerId: w.other, status: 'excused', reason: 'Injured in warm-up' }] });
    expect((await part('strength_conditioning')).remaining).toBe(3);
  });

  it("doesn't take sessions of other kinds from a package made of parts", async () => {
    const s = await w.admin.post('/v1/sessions', {
      sessionType: 'group', capacity: 6, coachIds: [w.coachBId], startsAt: inHours(-20), endsAt: inHours(-19), playerIds: [w.other],
    });
    await w.coachB.put(`/v1/sessions/${s.session.id}/attendance`, { records: [{ playerId: w.other, status: 'present' }] });
    const p = (await w.admin.get(`/v1/players/${w.other}/packages`))[0];
    expect(p.remaining).toBe(12);
  });

  it('adjusts one part at a time', async () => {
    const bad = await w.admin.raw('POST', `/v1/packages/${pkg.id}/adjust`, { delta: 1, note: 'Goodwill session' });
    expect(bad.status).toBe(400);
    const p = await w.admin.post(`/v1/packages/${pkg.id}/adjust`, { delta: 1, note: 'Goodwill session', categoryId: cats.one_on_one.id });
    expect(p.parts.find((x: any) => x.category_code === 'one_on_one').remaining).toBe(10);
  });
});

