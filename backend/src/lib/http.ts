import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { JWTPayload } from 'jose';
import type { AcademyContext } from '../db.js';
import { Actor } from './actor.js';
import { badRequest, unauthorized } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
    academy: AcademyContext | null;
    tokenPayload: JWTPayload | null;
  }
}

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw badRequest('Invalid request', result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return result.data;
}

export function actorOf(req: FastifyRequest): Actor {
  if (!req.actor) throw unauthorized();
  return req.actor;
}

export const uuid = z.uuid();
export const idParams = z.object({ id: z.uuid() });
export const isoDate = z.iso.date();
export const isoDateTime = z.iso.datetime({ offset: true });
