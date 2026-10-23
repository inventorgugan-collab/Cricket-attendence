import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshApp, givePackage, inHours, World, world } from './helpers.js';

let app: FastifyInstance;
let w: World;

beforeAll(async () => {
  app = await freshApp();
  w = await world(app);
});
afterAll(async () => {
  await app.close();
});

const group = (over: Record<string, unknown> = {}) => ({
  sessionType: 'group', bookingMode: 'open', capacity: 3, startsAt: inHours(48), endsAt: inHours(49.5), ...over,
});

describe('scheduling rules', () => {
  it('refuses to put two sessions on the same net at once', async () => {
    await w.admin.post('/v1/sessions', group({ coachIds: [w.coachAId], areaId: w.areaId, startsAt: inHours(100), endsAt: inHours(101) }));
    const clash = await w.admin.raw('POST', '/v1/sessions', group({ coachIds: [w.coachBId], areaId: w.areaId, startsAt: inHours(100.5), endsAt: inHours(102) }));
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('area_double_booked');
  });

  it('refuses to double-book a coach', async () => {
    const clash = await w.admin.raw('POST', '/v1/sessions', group({ coachIds: [w.coachAId], areaId: w.area2Id, startsAt: inHours(100.5), endsAt: inHours(102) }));
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('coach_double_booked');
  });

  it('fixes one-on-one and one-on-two capacity', async () => {
    const s = await w.admin.post('/v1/sessions', { sessionType: 'one_on_two', coachIds: [w.coachBId], startsAt: inHours(120), endsAt: inHours(121), playerIds: [w.adult, w.minor, w.other] });
    expect(s.session.capacity).toBe(2);
    expect(s.session.bookings).toHaveLength(2);
    expect(s.skippedPlayers).toHaveLength(1);
    expect(s.skippedPlayers[0].reason).toMatch(/full/);
  });

  it('creates a weekly series and reports clashing dates instead of failing', async () => {
    const day = new Date(Date.now() + 7 * 86400_000);
    const start = day.toISOString().slice(0, 10);
    const end = new Date(day.getTime() + 20 * 86400_000).toISOString().slice(0, 10);
    const r = await w.admin.post('/v1/sessions/recurring', {
      sessionType: 'group', capacity: 10, coachIds: [w.coachBId], areaId: w.area2Id,
      weekdays: [1, 2, 3, 4, 5, 6, 7], startDate: start, endDate: end, startTime: '06:00', durationMinutes: 90,
    });
    expect(r.createdSessionIds.length).toBe(21);
    const again = await w.admin.post('/v1/sessions/recurring', {
      sessionType: 'group', capacity: 10, coachIds: [w.coachAId], areaId: w.area2Id,
      weekdays: [1], startDate: start, endDate: end, startTime: '06:30', durationMinutes: 60,
    });
    expect(again.createdSessionIds).toHaveLength(0);
    expect(again.skippedDates.length).toBeGreaterThan(0);
  });

  it('only lets coaches schedule themselves', async () => {
    expect((await w.coachA.raw('POST', '/v1/sessions', group({ coachIds: [w.coachBId], startsAt: inHours(300), endsAt: inHours(301) }))).status).toBe(403);
    await w.coachA.post('/v1/sessions', group({ coachIds: [w.coachAId], startsAt: inHours(300), endsAt: inHours(301) }));
  });

  it('rejects a reschedule that would clash, and keeps the session unchanged', async () => {
    const a = await w.admin.post('/v1/sessions', group({ coachIds: [w.coachAId], startsAt: inHours(400), endsAt: inHours(401) }));
    await w.admin.post('/v1/sessions', group({ coachIds: [w.coachAId], startsAt: inHours(402), endsAt: inHours(403) }));
    const moved = await w.admin.raw('PATCH', `/v1/sessions/${a.session.id}`, { version: a.session.version, startsAt: inHours(402.5), endsAt: inHours(403.5) });
    expect(moved.status).toBe(409);
    const ok = await w.admin.patch(`/v1/sessions/${a.session.id}`, { version: a.session.version, startsAt: inHours(404), endsAt: inHours(405) });
    expect(ok.version).toBe(a.session.version + 1);
  });
});

describe('booking requests', () => {
  it('auto-confirms an eligible group request and distinguishes requests from confirmations', async () => {
    await givePackage(w.admin, w.adult);
    const s = await w.admin.post('/v1/sessions', group({ coachIds: [w.coachBId], startsAt: inHours(30), endsAt: inHours(31) }));
    const b = await w.player.post('/v1/bookings', { sessionId: s.session.id, playerId: w.adult });
    expect(b.status).toBe('confirmed');
    const notes = await w.player.get('/v1/notifications');
    expect(notes[0].kind).toBe('booking_confirmed');
  });

  it('sends a request without credits to staff review', async () => {
    const s = await w.admin.post('/v1/sessions', group({ coachIds: [w.coachBId], startsAt: inHours(34), endsAt: inHours(35) }));
    const b = await w.guardian.post('/v1/bookings', { sessionId: s.session.id, playerId: w.minor });
    expect(b.status).toBe('pending');
    expect(b.approvals_needed).toEqual(['staff']);
    expect(b.review_reasons[0]).toMatch(/package/);
    const approved = await w.coachB.post(`/v1/bookings/${b.id}/approve`);
    expect(approved.status).toBe('confirmed');
  });

  it('asks a parent to approve a minor’s own request, then staff for a one-on-one', async () => {
    await givePackage(w.admin, w.minor);
    const s = await w.admin.post('/v1/sessions', { sessionType: 'one_on_one', bookingMode: 'open', coachIds: [w.coachAId], startsAt: inHours(60), endsAt: inHours(61) });
    const b = await w.kid.post('/v1/bookings', { sessionId: s.session.id, playerId: w.minor });
    expect(b.approvals_needed.sort()).toEqual(['guardian', 'staff']);
    // A coach can't stand in for the parent.
    const afterCoach = await w.coachA.post(`/v1/bookings/${b.id}/approve`);
    expect(afterCoach.status).toBe('pending');
    expect(afterCoach.approvals_needed).toEqual(['guardian']);
    const afterParent = await w.guardian.post(`/v1/bookings/${b.id}/approve`);
    expect(afterParent.status).toBe('confirmed');
  });

  it('confirms only as many simultaneous requests as there are places', async () => {
    const s = await w.admin.post('/v1/sessions', group({ capacity: 1, coachIds: [w.coachBId], startsAt: inHours(70), endsAt: inHours(71) }));
    await w.admin.patch('/v1/settings/policy', { booking: { requireCreditsForAutoConfirm: false } });
    const ids = [w.adult, w.minor, w.other];
    const results = await Promise.all(ids.map((playerId) => w.admin.post('/v1/bookings', { sessionId: s.session.id, playerId, direct: true }).catch((e) => e)));
    const confirmed = results.filter((r) => r.status === 'confirmed');
    expect(confirmed).toHaveLength(1);
    expect(results.filter((r) => r instanceof Error && (r as any).body.error.code === 'session_full')).toHaveLength(2);
    await w.admin.patch('/v1/settings/policy', { booking: { requireCreditsForAutoConfirm: true } });
  });

  it('waitlists when full and promotes the next player on cancellation', async () => {
    await w.admin.patch('/v1/settings/policy', { booking: { requireCreditsForAutoConfirm: false } });
    const s = await w.admin.post('/v1/sessions', group({ capacity: 1, coachIds: [w.coachBId], startsAt: inHours(80), endsAt: inHours(81) }));
    const first = await w.player.post('/v1/bookings', { sessionId: s.session.id, playerId: w.adult });
    const second = await w.guardian.post('/v1/bookings', { sessionId: s.session.id, playerId: w.minor });
    expect(first.status).toBe('confirmed');
    expect(second.status).toBe('waitlisted');
    await w.player.post(`/v1/bookings/${first.id}/cancel`, { reason: 'Exam' });
    const detail = await w.admin.get(`/v1/sessions/${s.session.id}`);
    expect(detail.bookings.find((b: any) => b.player_id === w.minor).status).toBe('confirmed');
    await w.admin.patch('/v1/settings/policy', { booking: { requireCreditsForAutoConfirm: true } });
  });

  it('treats a retried request with the same id as one booking', async () => {
    const s = await w.admin.post('/v1/sessions', group({ coachIds: [w.coachBId], startsAt: inHours(90), endsAt: inHours(91) }));
    const clientRequestId = crypto.randomUUID();
    const a = await w.player.post('/v1/bookings', { sessionId: s.session.id, playerId: w.adult, clientRequestId });
    const b = await w.player.post('/v1/bookings', { sessionId: s.session.id, playerId: w.adult, clientRequestId });
    expect(a.id).toBe(b.id);
  });

  it('stops players requesting fixed sessions or other players’ places', async () => {
    const fixed = await w.admin.post('/v1/sessions', group({ bookingMode: 'fixed', coachIds: [w.coachBId], startsAt: inHours(95), endsAt: inHours(96) }));
    expect((await w.player.raw('POST', '/v1/bookings', { sessionId: fixed.session.id, playerId: w.adult })).status).toBe(409);
    expect((await w.guardian.raw('POST', '/v1/bookings', { sessionId: fixed.session.id, playerId: w.other })).status).toBe(403);
  });

  it('lists only open sessions the player has not already requested', async () => {
    const list = await w.player.get(`/v1/sessions/available?playerId=${w.adult}`);
    expect(list.every((s: any) => s.booking_mode === 'open' && s.status === 'scheduled')).toBe(true);
    expect((await w.guardian.raw('GET', `/v1/sessions/available?playerId=${w.other}`)).status).toBe(403);
  });
});
