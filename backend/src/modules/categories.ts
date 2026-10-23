import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one, pool, tx } from '../db.js';
import { audit } from '../lib/audit.js';
import { requireRole } from '../lib/authz.js';
import { badRequest, notFound } from '../lib/errors.js';
import { actorOf, idParams, parse } from '../lib/http.js';

// Kinds of training session (one-on-one, strength & conditioning, ...). The
// admin decides which can be requested at a chosen time, and which coaches
// take them in what order: a request goes to the first coach in the list who
// is free, then the next.

const CATEGORY_SELECT = `
  SELECT c.*,
         coalesce((SELECT json_agg(json_build_object('id', co.id, 'full_name', co.full_name, 'priority', cc.priority) ORDER BY cc.priority)
                     FROM category_coaches cc JOIN coaches co ON co.id = cc.coach_id
                    WHERE cc.category_id = c.id AND co.status = 'active'), '[]') AS coaches
    FROM session_categories c`;

export async function categoryRoutes(app: FastifyInstance) {
  app.get('/v1/categories', async (req) => {
    const actor = actorOf(req);
    const rows = await many(pool, `${CATEGORY_SELECT} ${actor.role === 'admin' ? '' : 'WHERE c.active'} ORDER BY c.sort_order, c.name`);
    // Players and parents see coach names (to choose one) but not the order.
    if (actor.role === 'player' || actor.role === 'guardian') {
      return rows.map((r) => ({ ...r, coaches: [...r.coaches].sort((a: any, b: any) => a.full_name.localeCompare(b.full_name)).map((c: any) => ({ id: c.id, full_name: c.full_name })) }));
    }
    return rows;
  });

  const fields = z.object({
    name: z.string().trim().min(1).max(100),
    sessionType: z.enum(['group', 'one_on_one', 'one_on_two']),
    defaultMinutes: z.number().int().min(15).max(480).default(60),
    requestable: z.boolean().default(false),
    active: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(1000).default(100),
  });

  app.post('/v1/categories', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const body = parse(fields, req.body);
    const code = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'category';
    return tx(async (db) => {
      const taken = await one(db, `SELECT count(*)::int AS n FROM session_categories WHERE code LIKE $1`, [`${code}%`]);
      const c = await one(
        db,
        `INSERT INTO session_categories (code, name, session_type, default_minutes, requestable, active, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [taken.n ? `${code}_${taken.n + 1}` : code, body.name, body.sessionType, body.defaultMinutes, body.requestable, body.active, body.sortOrder],
      );
      await audit(db, actor, 'category_created', 'session_category', c.id, null, c);
      return one(db, `${CATEGORY_SELECT} WHERE c.id = $1`, [c.id]);
    });
  });

  app.patch('/v1/categories/:id', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    // The format can't change once sessions use the category.
    const body = parse(fields.omit({ sessionType: true }).partial(), req.body);
    return tx(async (db) => {
      const before = await one(db, `SELECT * FROM session_categories WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('Category');
      const map: Record<string, string> = { name: 'name', defaultMinutes: 'default_minutes', requestable: 'requestable', active: 'active', sortOrder: 'sort_order' };
      const changes = Object.entries(body).filter(([k, v]) => k in map && v !== undefined);
      if (!changes.length) return one(db, `${CATEGORY_SELECT} WHERE c.id = $1`, [id]);
      const after = await one(
        db,
        `UPDATE session_categories SET ${changes.map(([k], i) => `${map[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
        [id, ...changes.map(([, v]) => v)],
      );
      await audit(db, actor, 'category_updated', 'session_category', id, before, after);
      return one(db, `${CATEGORY_SELECT} WHERE c.id = $1`, [id]);
    });
  });

  // The coaches who take this kind of session, first choice first.
  app.put('/v1/categories/:id/coaches', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ coachIds: z.array(z.uuid()).max(50) }), req.body);
    if (new Set(body.coachIds).size !== body.coachIds.length) throw badRequest('A coach can appear only once');
    return tx(async (db) => {
      const cat = await one(db, `SELECT * FROM session_categories WHERE id = $1 FOR UPDATE`, [id]);
      if (!cat) throw notFound('Category');
      const before = (await many(db, `SELECT coach_id FROM category_coaches WHERE category_id = $1 ORDER BY priority`, [id])).map((r) => r.coach_id);
      await db.query(`DELETE FROM category_coaches WHERE category_id = $1`, [id]);
      for (const [i, coachId] of body.coachIds.entries()) {
        await db.query(`INSERT INTO category_coaches (category_id, coach_id, priority) VALUES ($1, $2, $3)`, [id, coachId, i + 1]);
      }
      await audit(db, actor, 'category_coaches_changed', 'session_category', id, { coachIds: before }, body);
      return one(db, `${CATEGORY_SELECT} WHERE c.id = $1`, [id]);
    });
  });
}
