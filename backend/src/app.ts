import cors from '@fastify/cors';
import Fastify from 'fastify';
import { AppError, fromPgError } from './lib/errors.js';
import { adminRoutes } from './modules/admin.js';
import { attendanceRoutes } from './modules/attendance.js';
import { authenticate, authRoutes, resolveAcademy } from './modules/auth.js';
import { academyRoutes } from './modules/academies.js';
import { runInAcademy } from './db.js';
import { bookingRoutes } from './modules/bookings.js';
import { categoryRoutes } from './modules/categories.js';
import { creditRoutes } from './modules/credits.js';
import { financeRoutes } from './modules/finance.js';
import { whatsappRoutes } from './modules/whatsapp.js';
import { journalRoutes } from './modules/journals.js';
import { leaveRoutes } from './modules/leave.js';
import { peopleRoutes } from './modules/people.js';
import { requestRoutes } from './modules/requests.js';
import { sessionRoutes } from './modules/sessions.js';
import { syncRoutes } from './modules/sync.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  // Browser builds (web preview, a future admin console) need their origin allowed explicitly.
  await app.register(cors, { origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : false });

  app.decorateRequest('actor', null);
  app.decorateRequest('academy', null);
  app.decorateRequest('tokenPayload', null);
  // Work out the academy, then run the rest of the request inside it, so every
  // query goes to that academy's own data.
  app.addHook('preHandler', resolveAcademy);
  app.addHook('preHandler', (req, _reply, done) => (req.academy ? runInAcademy(req.academy, done) : done()));
  app.addHook('preHandler', authenticate);

  app.setErrorHandler((err, req, reply) => {
    const e = err instanceof AppError ? err : fromPgError(err);
    if (e) return reply.status(e.statusCode).send({ error: { code: e.code, message: e.message, details: e.details } });
    if ((err as any).validation || (err as any).statusCode === 400) {
      return reply.status(400).send({ error: { code: 'bad_request', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  app.get('/health', async () => ({ ok: true }));

  for (const routes of [authRoutes, peopleRoutes, creditRoutes, sessionRoutes, bookingRoutes, attendanceRoutes, journalRoutes, adminRoutes, syncRoutes, categoryRoutes, leaveRoutes, requestRoutes, academyRoutes, financeRoutes, whatsappRoutes]) {
    await app.register(routes);
  }
  return app;
}
