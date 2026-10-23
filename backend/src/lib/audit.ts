import { Db } from '../db.js';
import { Actor } from './actor.js';

export async function audit(
  db: Db,
  actor: Actor | null,
  action: string,
  entity: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
  mutationId: string | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id, before, after, mutation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actor?.userId ?? null, actor?.role ?? null, action, entity, entityId, before ?? null, after ?? null, mutationId],
  );
}
