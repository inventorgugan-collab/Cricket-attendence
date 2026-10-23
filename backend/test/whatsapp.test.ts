import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { localDate } from '../src/lib/time.js';
import { normalisePhone } from '../src/lib/whatsapp.js';
import { deliverQueued } from '../src/modules/whatsapp.js';
import { freshApp, World, world } from './helpers.js';

let app: FastifyInstance;
let w: World;
const tomorrow = localDate(new Date(Date.now() + 86400_000));
const at = (time: string) => `${tomorrow}T${time}:00+05:30`;

beforeAll(async () => {
  app = await freshApp();
  w = await world(app);
});
afterAll(async () => {
  await app.close();
});

describe('WhatsApp', () => {
  it('reads Indian numbers however they are typed', () => {
    expect(normalisePhone('98400 12345')).toBe('919840012345');
    expect(normalisePhone('+91-98400-12345')).toBe('919840012345');
    expect(normalisePhone('098400 12345')).toBe('919840012345');
    expect(normalisePhone('12345')).toBeNull();
  });

  it('only messages people who agreed, and previews until WhatsApp is connected', async () => {
    await pool.query(`UPDATE coaches SET phone = '98400 11111' WHERE id = $1`, [w.coachBId]);
    await w.admin.put(`/v1/users/${w.coachB.userId}/whatsapp`, { optIn: true });
    const s = await w.admin.post('/v1/sessions', { sessionType: 'one_on_one', coachIds: [w.coachAId], startsAt: at('10:00'), endsAt: at('11:00'), playerIds: [w.adult] });
    await w.admin.put(`/v1/sessions/${s.session.id}/coaches`, { coachIds: [w.coachBId] });
    await deliverQueued();
    const msgs = await w.admin.get('/v1/whatsapp/messages');
    const toB = msgs.find((m: any) => m.to_name === 'coach.b' && m.kind === 'session_assigned');
    expect(toB).toMatchObject({ to_phone: '919840011111', status: 'preview' });
    expect(toB.body).toContain('New session on your schedule');
    // Coach A never agreed, so their copy is only logged.
    expect(msgs.find((m: any) => m.to_name === 'coach.a' && m.kind === 'session_unassigned').status).toBe('skipped');
  });

  it('sends through the official API once connected, without ever showing the token', async () => {
    const settings = await w.admin.put('/v1/whatsapp/settings', { phoneNumberId: '1234567890', accessToken: 'EAAG-test-token-0123456789' });
    expect(settings).toMatchObject({ connected: true, hasAccessToken: true });
    expect(JSON.stringify(settings)).not.toContain('EAAG');
    await pool.query(`UPDATE whatsapp_messages SET status = 'queued' WHERE status = 'preview'`);
    const calls: any[] = [];
    const fake = (async (url: string, init: any) => {
      calls.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await deliverQueued(fake);
    expect(r.sent).toBeGreaterThan(0);
    expect(calls[0].url).toBe('https://graph.facebook.com/v23.0/1234567890/messages');
    expect(calls[0].auth).toBe('Bearer EAAG-test-token-0123456789');
    expect(calls[0].body).toMatchObject({ to: '919840011111', type: 'template', template: { name: 'academy_update' } });
    expect(calls[0].body.template.components[0].parameters[1].text).not.toContain('\n');
  });

  it("builds the coaches' end-of-day summary", async () => {
    await w.coachA.post(`/v1/coaches/${w.coachAId}/leave`, { kind: 'emergency', reason: 'Fever', startsAt: new Date().toISOString(), endsAt: at('23:00') });
    const r = await w.admin.post('/v1/whatsapp/digest', { send: false });
    expect(r.text).toContain("Coaches' update");
    expect(r.text).toContain('Coach Arun: emergency leave');
    expect(r.text).toContain('Covered by another coach:');
    expect(r.text).toContain('now Coach Bala');
    expect(r.text).toMatch(/Tomorrow: \d+ session/);
  });

  it('lists who has agreed to messages', async () => {
    const people = await w.admin.get('/v1/whatsapp/people');
    expect(people.find((p: any) => p.id === w.coachB.userId)).toMatchObject({ whatsapp_opt_in: true, phone: '919840011111' });
    expect(people.find((p: any) => p.display_name === 'coach.a')?.whatsapp_opt_in).toBe(false);
  });

  it('is for admins only', async () => {
    expect((await w.coachA.raw('GET', '/v1/whatsapp/settings')).status).toBe(403);
    expect((await w.coachA.raw('GET', '/v1/whatsapp/messages')).status).toBe(403);
    expect((await w.coachA.raw('GET', '/v1/whatsapp/people')).status).toBe(403);
  });
});
