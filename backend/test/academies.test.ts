import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { freshApp, login, World, world } from './helpers.js';

let app: FastifyInstance;
let w: World;
const KEY = 'platform-key-for-tests';

beforeAll(async () => {
  config.platformKey = KEY;
  app = await freshApp();
  w = await world(app);
});
afterAll(async () => {
  await app.close();
});

const platform = (method: 'GET' | 'POST', url: string, payload?: unknown, key = KEY) =>
  app.inject({ method, url, payload: payload as any, headers: { 'x-platform-key': key } });

describe('many academies', () => {
  it('only lets the platform owner add an academy', async () => {
    const r = await platform('POST', '/v1/platform/academies', { code: 'kings', name: 'Kings XI Academy', adminLogin: 'owner', adminPassword: 'Temporary1!' }, 'wrong');
    expect(r.statusCode).toBe(403);
  });

  it('creates a separate academy with its own admin', async () => {
    const r = await platform('POST', '/v1/platform/academies', { code: 'kings', name: 'Kings XI Academy', adminLogin: 'owner', adminPassword: 'Temporary1!' });
    expect(r.statusCode).toBe(200);
    const lookup = await app.inject({ method: 'GET', url: '/v1/academies/kings' });
    expect(lookup.json().name).toBe('Kings XI Academy');
    const kings = await login(app, 'owner', 'Temporary1!', 'kings');
    const me = await kings.get('/v1/me');
    expect(me.academy).toEqual({ code: 'kings', name: 'Kings XI Academy' });
    expect(me.mustChangePassword).toBe(true);
  });

  it("keeps each academy's data apart", async () => {
    const kings = await login(app, 'owner', 'Temporary1!', 'kings');
    expect(await kings.get('/v1/players')).toEqual([]);
    const solo = await kings.post('/v1/coaches', { full_name: 'Solo Coach' });
    expect((await kings.get('/v1/coaches')).map((c: any) => c.full_name)).toEqual(['Solo Coach']);
    // The first academy still sees only its own coaches and players.
    expect((await w.admin.get('/v1/coaches')).map((c: any) => c.full_name)).not.toContain('Solo Coach');
    expect((await w.admin.get('/v1/players')).length).toBe(3);
    // Another academy's ids simply don't exist here.
    const r = await w.admin.raw('POST', `/v1/coaches/${solo.id}/leave`, { kind: 'planned', date: '2030-01-01' });
    expect(r.status).toBe(404);
  });

  it('signs in only with the right academy code', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { academy: 'kings', login: 'admin', password: 'Password123!' } });
    expect(wrong.statusCode).toBe(401);
    const unknown = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { academy: 'nowhere', login: 'admin', password: 'Password123!' } });
    expect(unknown.statusCode).toBe(404);
  });

  it('stops a suspended academy signing in', async () => {
    await platform('POST', '/v1/platform/academies/kings/status', { status: 'suspended' });
    const r = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { academy: 'kings', login: 'owner', password: 'Temporary1!' } });
    expect(r.statusCode).toBe(404);
  });
});
