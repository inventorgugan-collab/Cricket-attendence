import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db.js';
import { freshApp, login, World, world } from './helpers.js';

let app: FastifyInstance;
let w: World;

beforeAll(async () => {
  app = await freshApp();
  w = await world(app);
});
afterAll(async () => {
  await app.close();
});

describe('authentication', () => {
  it('rejects a wrong password with a generic message', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { academy: 'test', login: 'admin', password: 'nope' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Login or password is incorrect');
  });

  it('rotates refresh tokens so each one works once', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { academy: 'test', login: 'coach.b', password: 'Password123!' } });
    const { refreshToken } = res.json();
    const first = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { academy: 'test', refreshToken } });
    expect(first.statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { academy: 'test', refreshToken } });
    expect(again.statusCode).toBe(401);
  });

  it('signs a deactivated account out immediately', async () => {
    const kid = await login(app, 'kid');
    await w.admin.post(`/v1/accounts/${kid.userId}/status`, { status: 'deactivated' });
    expect((await kid.raw('GET', '/v1/me')).status).toBe(401);
    await w.admin.post(`/v1/accounts/${kid.userId}/status`, { status: 'active' });
    w.kid = await login(app, 'kid');
  });

  it('lets an admin create a linked account through the API', async () => {
    const g = await w.admin.post('/v1/guardians', { full_name: 'Second Parent' });
    await w.admin.post('/v1/accounts', { role: 'guardian', login: 'Parent.Two', temporaryPassword: 'Temp12345', displayName: 'Second Parent', profileId: g.id });
    const p2 = await login(app, 'parent.two', 'Temp12345');
    const me = await p2.get('/v1/me');
    expect(me.mustChangePassword).toBe(true);
    expect(me.profileId).toBe(g.id);
  });
});

describe('player access', () => {
  it('shows a coach only their players, without home address', async () => {
    const list = await w.coachA.get('/v1/players');
    expect(list.map((p: any) => p.id).sort()).toEqual([w.adult, w.minor].sort());
    expect(list[0]).not.toHaveProperty('address');
    expect((await w.coachB.raw('GET', `/v1/players/${w.minor}`)).status).toBe(403);
  });

  it('lets a parent see their linked child but not other children', async () => {
    const me = await w.guardian.get('/v1/me');
    expect(me.children.map((c: any) => c.id)).toEqual([w.minor]);
    expect((await w.guardian.get(`/v1/players/${w.minor}`)).address).toBe('2 Main Road');
    expect((await w.guardian.raw('GET', `/v1/players/${w.other}`)).status).toBe(403);
  });

  it('limits which profile fields each role can change', async () => {
    await w.kid.patch(`/v1/players/${w.minor}`, { city: 'Chennai' });
    const denied = await w.kid.raw('PATCH', `/v1/players/${w.minor}`, { primary_role: 'batter' });
    expect(denied.status).toBe(403);
    await w.guardian.patch(`/v1/players/${w.minor}`, { emergency_phone: '9111111111' });
    expect((await w.guardian.raw('PATCH', `/v1/players/${w.minor}`, { full_name: 'Changed' })).status).toBe(403);
  });

  it('rejects an edit based on a stale version', async () => {
    const p = await w.admin.get(`/v1/players/${w.adult}`);
    await w.admin.patch(`/v1/players/${w.adult}`, { playing_level: 'district', version: p.version });
    const stale = await w.admin.raw('PATCH', `/v1/players/${w.adult}`, { playing_level: 'state', version: p.version });
    expect(stale.status).toBe(409);
  });
});

describe('injuries and consent', () => {
  it('gives coaches safety details only, and hides old minor injuries', async () => {
    await w.admin.post(`/v1/players/${w.minor}/injuries`, { title: 'Sore shoulder', severity: 'minor', is_current: true, professional_restrictions: 'No bowling for 2 weeks', injury_date: '2026-10-01' });
    await w.admin.post(`/v1/players/${w.minor}/injuries`, { title: 'Old sprain', severity: 'minor', is_current: false });
    const coachView = await w.coachA.get(`/v1/players/${w.minor}/injuries`);
    expect(coachView).toHaveLength(1);
    expect(coachView[0].professional_restrictions).toBe('No bowling for 2 weeks');
    expect(coachView[0]).not.toHaveProperty('injury_date');
    expect(await w.guardian.get(`/v1/players/${w.minor}/injuries`)).toHaveLength(2);
    expect((await w.coachB.raw('GET', `/v1/players/${w.minor}/injuries`)).status).toBe(403);
  });

  it('lets a player report discomfort but not write coach observations', async () => {
    const r = await w.kid.post(`/v1/players/${w.minor}/injuries`, { title: 'Knee discomfort', severity: 'minor', coach_observations: 'should be dropped' });
    expect(r.coach_observations).toBeNull();
  });

  it('requires a guardian for a minor’s consent and records history', async () => {
    expect((await w.kid.raw('POST', `/v1/players/${w.minor}/consents`, { consentType: 'video_recording', granted: true })).status).toBe(403);
    await w.guardian.post(`/v1/players/${w.minor}/consents`, { consentType: 'video_recording', granted: true });
    await w.guardian.post(`/v1/players/${w.minor}/consents`, { consentType: 'video_recording', granted: false });
    const c = await w.guardian.get(`/v1/players/${w.minor}/consents`);
    expect(c.current.find((x: any) => x.consent_type === 'video_recording').granted).toBe(false);
    expect(c.history).toHaveLength(2);
    expect((await w.admin.raw('POST', `/v1/players/${w.minor}/consents`, { consentType: 'data_processing', granted: true })).status).toBe(400);
    await w.player.post(`/v1/players/${w.adult}/consents`, { consentType: 'data_processing', granted: true });
  });

  it('writes an audit trail', async () => {
    const { rows } = await pool.query(`SELECT action FROM audit_log WHERE entity = 'player' AND entity_id = $1`, [w.minor]);
    expect(rows.map((r) => r.action)).toContain('consent_granted');
  });
});
