import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localDate } from '../src/lib/time.js';
import { freshApp, World, world } from './helpers.js';

let app: FastifyInstance;
let w: World;
let cats: Record<string, any>;
const thisMonth = localDate().slice(0, 7);
const today = localDate();
// Two hours before now, so the session has already happened.
const past = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

beforeAll(async () => {
  app = await freshApp();
  w = await world(app);
  cats = Object.fromEntries((await w.admin.get('/v1/categories')).map((c: any) => [c.code, c]));
});
afterAll(async () => {
  await app.close();
});

describe('fees and money (admin only)', () => {
  let feeId: string;

  it('raises a fee when a priced package is given', async () => {
    const t = await w.admin.post('/v1/package-templates', {
      name: '12-session pack', kind: 'fixed', validity_days: 90, price: 9000,
      items: [{ categoryId: cats.one_on_one.id, total: 9 }, { categoryId: cats.strength_conditioning.id, total: 3 }],
    });
    expect(t.price_paise).toBe(900000);
    await w.admin.post(`/v1/players/${w.adult}/packages`, { templateId: t.id, starts_on: today });
    const fees = await w.admin.get(`/v1/fees?playerId=${w.adult}`);
    expect(fees).toHaveLength(1);
    expect(fees[0]).toMatchObject({ description: '12-session pack', amount_paise: 900000, balance_paise: 900000, status: 'due' });
    feeId = fees[0].id;
  });

  it('records part and full payments against a fee', async () => {
    await w.admin.post('/v1/payments', { playerId: w.adult, feeId, amount: 5000, method: 'upi', reference: 'UPI 1234' });
    expect((await w.admin.get(`/v1/fees?playerId=${w.adult}`))[0]).toMatchObject({ paid_paise: 500000, balance_paise: 400000, status: 'part_paid' });
    const second = await w.admin.post('/v1/payments', { playerId: w.adult, feeId, amount: 4000, method: 'cash' });
    expect((await w.admin.get(`/v1/fees?playerId=${w.adult}`))[0].status).toBe('paid');
    // A mistake is voided, not deleted.
    await w.admin.post(`/v1/payments/${second.id}/void`, { reason: 'Entered twice' });
    expect((await w.admin.get(`/v1/fees?playerId=${w.adult}`))[0].status).toBe('part_paid');
    await w.admin.post('/v1/payments', { playerId: w.adult, feeId, amount: 4000, method: 'cash' });
  });

  it('works out the month: sessions per coach, money in, paid out and profit', async () => {
    await w.admin.put(`/v1/coaches/${w.coachAId}/rates`, { default: 500, byCategory: [{ categoryId: cats.one_on_one.id, amount: 800 }] });
    await w.admin.put(`/v1/coaches/${w.coachBId}/rates`, { default: 400 });
    await w.admin.post('/v1/sessions', { sessionType: 'one_on_one', coachIds: [w.coachAId], startsAt: past(3), endsAt: past(2), playerIds: [w.adult] });
    await w.admin.post('/v1/sessions', { sessionType: 'group', capacity: 10, coachIds: [w.coachAId], startsAt: past(6), endsAt: past(5) });
    await w.admin.post('/v1/sessions', { sessionType: 'group', capacity: 10, coachIds: [w.coachBId], startsAt: past(9), endsAt: past(8) });
    await w.admin.post('/v1/coach-payouts', { coachId: w.coachAId, amount: 1000, forMonth: thisMonth, method: 'bank' });
    await w.admin.post('/v1/expenses', { category: 'ground', description: 'Ground hire', amount: 2500, method: 'bank' });

    const m = await w.admin.get(`/v1/finance/month?month=${thisMonth}`);
    // Sessions created a few hours ago might fall in last month on the 1st; only check this month's when they're in it.
    if (localDate(new Date(Date.now() - 9 * 3600_000)).startsWith(thisMonth)) {
      expect(m.sessions.held).toBe(3);
      const a = m.coaches.find((c: any) => c.full_name === 'Coach Arun');
      expect(a).toMatchObject({ sessions: 2, earned_paise: 130000, paid_paise: 100000, owed_paise: 30000 });
      expect(m.coaches.find((c: any) => c.full_name === 'Coach Bala')).toMatchObject({ sessions: 1, earned_paise: 40000 });
    }
    expect(m.money).toMatchObject({
      received_paise: 900000,
      coach_payouts_paise: 100000,
      expenses_paise: 250000,
      settled_paise: 350000,
      profit_paise: 550000,
      outstanding_paise: 0,
    });
  });

  it('is hidden from coaches, players and parents', async () => {
    for (const c of [w.coachA, w.player, w.guardian]) {
      expect((await c.raw('GET', `/v1/finance/month?month=${thisMonth}`)).status).toBe(403);
      expect((await c.raw('GET', '/v1/fees')).status).toBe(403);
      expect((await c.raw('POST', '/v1/payments', { playerId: w.adult, amount: 1, method: 'cash' })).status).toBe(403);
    }
  });
});
