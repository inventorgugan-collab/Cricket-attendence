import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Db, many, one, pool, tx } from '../db.js';
import { Actor } from '../lib/actor.js';
import { audit } from '../lib/audit.js';
import { PlayerAccess, requirePlayerAccess, requireRole } from '../lib/authz.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { actorOf, idParams, isoDate, parse } from '../lib/http.js';
import { hashPassword } from '../lib/passwords.js';
import { ADULT_AGE, ageOn } from '../lib/time.js';

// ---------------------------------------------------------------------------
// Player profile shape and field-level permissions
// ---------------------------------------------------------------------------

const PERSONAL = ['full_name', 'date_of_birth', 'gender', 'city', 'address', 'phone', 'alt_phone'] as const;
const FAMILY = ['father_name', 'father_phone', 'mother_name', 'mother_phone', 'emergency_name', 'emergency_phone', 'emergency_relationship'] as const;
const CRICKET = [
  'primary_role', 'batting_style', 'batting_position', 'bowling_arm', 'bowling_style',
  'previous_teams', 'playing_level', 'experience', 'development_goals',
] as const;

// Who may change which fields. Admin may change everything in the schema.
const EDITABLE: Record<Exclude<PlayerAccess, 'full'>, readonly string[]> = {
  self: ['phone', 'alt_phone', 'city', 'development_goals'],
  guardian: ['city', 'address', 'phone', 'alt_phone', ...FAMILY],
  coach: [],
};

const optionalText = z.string().trim().max(500).nullable().optional();

const playerFields = z.object({
  full_name: z.string().trim().min(1).max(200),
  date_of_birth: isoDate,
  gender: optionalText,
  city: optionalText,
  address: optionalText,
  phone: optionalText,
  alt_phone: optionalText,
  father_name: optionalText,
  father_phone: optionalText,
  mother_name: optionalText,
  mother_phone: optionalText,
  emergency_name: optionalText,
  emergency_phone: optionalText,
  emergency_relationship: optionalText,
  registration_date: isoDate.optional(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  primary_role: z.enum(['batter', 'bowler', 'all_rounder', 'wicketkeeper', 'other']).nullable().optional(),
  batting_style: z.enum(['right_hand', 'left_hand']).nullable().optional(),
  batting_position: optionalText,
  bowling_arm: z.enum(['right', 'left']).nullable().optional(),
  bowling_style: optionalText,
  previous_teams: optionalText,
  playing_level: optionalText,
  experience: optionalText,
  development_goals: z.string().trim().max(4000).nullable().optional(),
});

export function presentPlayer(row: any, access: PlayerAccess) {
  const age = ageOn(row.date_of_birth);
  const base: Record<string, unknown> = {
    id: row.id,
    full_name: row.full_name,
    age,
    is_minor: age < ADULT_AGE,
    status: row.status,
    version: row.version,
  };
  for (const f of CRICKET) base[f] = row[f];
  // Coaches get contact and emergency details for safety, not the home address.
  for (const f of [...FAMILY, 'phone', 'alt_phone', 'city']) base[f] = row[f];
  if (access !== 'coach') {
    for (const f of PERSONAL) base[f] = row[f];
    base.registration_date = row.registration_date;
    base.has_account = !!row.user_id;
  }
  return base;
}

async function visiblePlayers(db: Db, actor: Actor, q?: string, status?: string) {
  const filters: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    filters.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (q) add(`p.full_name ILIKE ?`, `%${q}%`);
  if (status) add(`p.status = ?`, status);
  switch (actor.role) {
    case 'admin':
      break;
    case 'player':
      add(`p.id = ?`, actor.profileId);
      break;
    case 'guardian':
      add(`p.id IN (SELECT player_id FROM player_guardians WHERE guardian_id = ?)`, actor.profileId);
      break;
    case 'coach':
      add(
        `p.id IN (SELECT player_id FROM player_coaches WHERE coach_id = ?1
                   UNION SELECT gm.player_id FROM group_coaches gc JOIN group_members gm ON gm.group_id = gc.group_id WHERE gc.coach_id = ?1
                   UNION SELECT b.player_id FROM bookings b JOIN session_coaches sc ON sc.session_id = b.session_id
                          WHERE sc.coach_id = ?1 AND sc.active AND upper(b.during) > now() - interval '90 days')`.replaceAll('?1', '?'),
        actor.profileId,
      );
      break;
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return many(db, `SELECT p.* FROM players p ${where} ORDER BY p.full_name LIMIT 500`, params);
}

async function playerRelations(db: Db, playerId: string) {
  const [guardians, coaches, groups] = await Promise.all([
    many(db, `SELECT g.id, g.full_name, g.phone, g.email, pg.relationship, pg.is_primary, pg.can_book, pg.can_consent
                FROM player_guardians pg JOIN guardians g ON g.id = pg.guardian_id WHERE pg.player_id = $1`, [playerId]),
    many(db, `SELECT c.id, c.full_name FROM player_coaches pc JOIN coaches c ON c.id = pc.coach_id WHERE pc.player_id = $1`, [playerId]),
    many(db, `SELECT g.id, g.name FROM group_members gm JOIN training_groups g ON g.id = gm.group_id WHERE gm.player_id = $1`, [playerId]),
  ]);
  return { guardians, coaches, groups };
}

export async function currentConsents(db: Db, playerId: string) {
  return many(
    db,
    `SELECT DISTINCT ON (consent_type) consent_type, granted, given_by_guardian_id, created_at
       FROM consents WHERE player_id = $1 ORDER BY consent_type, created_at DESC`,
    [playerId],
  );
}

// ---------------------------------------------------------------------------
// Injury visibility: coaches see current or major injuries (safety information);
// players, guardians and admins see the full record.
// ---------------------------------------------------------------------------

function presentInjury(row: any, access: PlayerAccess) {
  const safety = {
    id: row.id,
    title: row.title,
    severity: row.severity,
    is_current: row.is_current,
    recovery_status: row.recovery_status,
    professional_restrictions: row.professional_restrictions,
    coach_observations: row.coach_observations,
    follow_up_date: row.follow_up_date,
    version: row.change_seq,
  };
  if (access === 'coach') return safety;
  return { ...safety, injury_date: row.injury_date, source: row.source, created_at: row.created_at, updated_at: row.updated_at };
}

export async function peopleRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- accounts
  app.post('/v1/accounts', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const body = parse(
      z.object({
        role: z.enum(['admin', 'coach', 'player', 'guardian']),
        login: z.string().trim().min(3).max(120),
        temporaryPassword: z.string().min(8).max(200),
        displayName: z.string().trim().min(1).max(200),
        profileId: z.uuid().optional(),
      }),
      req.body,
    );
    if (body.role !== 'admin' && !body.profileId) throw badRequest('profileId is required for this role');
    return tx(async (db) => {
      const user = await one(
        db,
        `INSERT INTO users (login, password_hash, role, display_name) VALUES ($1, $2, $3, $4)
         RETURNING id, login, role, display_name, status`,
        [body.login.toLowerCase(), await hashPassword(body.temporaryPassword), body.role, body.displayName],
      );
      if (body.role !== 'admin') {
        const table = { coach: 'coaches', player: 'players', guardian: 'guardians' }[body.role];
        const linked = await one(db, `UPDATE ${table} SET user_id = $1 WHERE id = $2 AND user_id IS NULL RETURNING id`, [user.id, body.profileId]);
        if (!linked) throw conflict('profile_unavailable', 'That profile does not exist or already has an account');
      }
      await audit(db, actor, 'account_created', 'user', user.id, null, { role: body.role, login: user.login, profileId: body.profileId });
      return user;
    });
  });

  app.post('/v1/accounts/:id/status', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ status: z.enum(['active', 'deactivated']) }), req.body);
    if (id === actor.userId) throw badRequest('You cannot change your own account status');
    return tx(async (db) => {
      const before = await one(db, `SELECT status FROM users WHERE id = $1`, [id]);
      if (!before) throw notFound('Account');
      // Bumping the token version signs the account out everywhere at once.
      const user = await one(db, `UPDATE users SET status = $2, token_version = token_version + 1 WHERE id = $1 RETURNING id, status`, [id, body.status]);
      await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      await audit(db, actor, 'account_status_changed', 'user', id, before, { status: body.status });
      return user;
    });
  });

  app.post('/v1/accounts/:id/reset-password', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ temporaryPassword: z.string().min(8).max(200) }), req.body);
    return tx(async (db) => {
      const user = await one(
        db,
        `UPDATE users SET password_hash = $2, must_change_password = true, token_version = token_version + 1 WHERE id = $1 RETURNING id`,
        [id, await hashPassword(body.temporaryPassword)],
      );
      if (!user) throw notFound('Account');
      await db.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      await audit(db, actor, 'password_reset', 'user', id, null, null);
      return { ok: true };
    });
  });

  // ----------------------------------------------------------------- players
  app.get('/v1/players', async (req) => {
    const actor = actorOf(req);
    const query = parse(z.object({ q: z.string().max(100).optional(), status: z.enum(['active', 'inactive', 'archived']).optional() }), req.query);
    const rows = await visiblePlayers(pool, actor, query.q, query.status);
    const access: PlayerAccess = actor.role === 'admin' ? 'full' : actor.role === 'coach' ? 'coach' : actor.role === 'guardian' ? 'guardian' : 'self';
    return rows.map((r) => presentPlayer(r, access));
  });

  app.post('/v1/players', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const body = parse(playerFields, req.body);
    return tx(async (db) => {
      const cols = Object.keys(body);
      const row = await one(
        db,
        `INSERT INTO players (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
        cols.map((c) => (body as any)[c]),
      );
      await audit(db, actor, 'player_created', 'player', row.id, null, row);
      return presentPlayer(row, 'full');
    });
  });

  app.get('/v1/players/:id', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const access = await requirePlayerAccess(pool, actor, id);
    const row = await one(pool, `SELECT * FROM players WHERE id = $1`, [id]);
    if (!row) throw notFound('Player');
    return {
      ...presentPlayer(row, access),
      ...(await playerRelations(pool, id)),
      consents: access === 'coach' ? undefined : await currentConsents(pool, id),
    };
  });

  app.patch('/v1/players/:id', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const body = parse(playerFields.partial().extend({ version: z.number().int().optional() }), req.body);
    const { version, ...changes } = body;
    return tx(async (db) => {
      const access = await requirePlayerAccess(db, actor, id);
      if (access !== 'full') {
        const allowed = EDITABLE[access];
        const blocked = Object.keys(changes).filter((k) => !allowed.includes(k));
        if (blocked.length) throw forbidden(`You cannot change: ${blocked.join(', ')}`);
      }
      const before = await one(db, `SELECT * FROM players WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('Player');
      if (version !== undefined && version !== before.version) {
        throw conflict('stale_version', 'Someone else changed this profile. Reload and try again.', presentPlayer(before, access));
      }
      const cols = Object.keys(changes);
      if (cols.length === 0) return presentPlayer(before, access);
      const row = await one(
        db,
        `UPDATE players SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, version = version + 1 WHERE id = $1 RETURNING *`,
        [id, ...cols.map((c) => (changes as any)[c])],
      );
      await audit(db, actor, 'player_updated', 'player', id, Object.fromEntries(cols.map((c) => [c, before[c]])), changes);
      return presentPlayer(row, access);
    });
  });

  app.put('/v1/players/:id/coaches', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ coachIds: z.array(z.uuid()).max(20) }), req.body);
    return tx(async (db) => {
      await db.query(`DELETE FROM player_coaches WHERE player_id = $1`, [id]);
      await db.query(`INSERT INTO player_coaches (player_id, coach_id) SELECT $1, unnest($2::uuid[])`, [id, body.coachIds]);
      await audit(db, actor, 'player_coaches_set', 'player', id, null, body);
      return { ok: true };
    });
  });

  // --------------------------------------------------------------- guardians
  app.post('/v1/guardians', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const body = parse(z.object({ full_name: z.string().trim().min(1).max(200), phone: optionalText, email: optionalText }), req.body);
    return tx(async (db) => {
      const row = await one(db, `INSERT INTO guardians (full_name, phone, email) VALUES ($1, $2, $3) RETURNING *`, [body.full_name, body.phone, body.email]);
      await audit(db, actor, 'guardian_created', 'guardian', row.id, null, row);
      return row;
    });
  });

  app.get('/v1/guardians', async (req) => {
    requireRole(actorOf(req), 'admin');
    return many(pool, `SELECT g.*, (g.user_id IS NOT NULL) AS has_account FROM guardians g ORDER BY full_name`);
  });

  app.patch('/v1/guardians/:id', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    if (!(actor.role === 'admin' || (actor.role === 'guardian' && actor.profileId === id))) throw forbidden();
    const body = parse(z.object({ full_name: z.string().trim().min(1).max(200).optional(), phone: optionalText, email: optionalText }), req.body);
    return tx(async (db) => {
      const before = await one(db, `SELECT * FROM guardians WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('Guardian');
      const cols = Object.keys(body);
      if (!cols.length) return before;
      const row = await one(db, `UPDATE guardians SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...cols.map((c) => (body as any)[c])]);
      await audit(db, actor, 'guardian_updated', 'guardian', id, before, row);
      return row;
    });
  });

  app.post('/v1/players/:id/guardians', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        guardianId: z.uuid(),
        relationship: z.string().trim().min(1).max(50),
        isPrimary: z.boolean().default(false),
        canBook: z.boolean().default(true),
        canConsent: z.boolean().default(true),
      }),
      req.body,
    );
    return tx(async (db) => {
      await db.query(
        `INSERT INTO player_guardians (player_id, guardian_id, relationship, is_primary, can_book, can_consent)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (player_id, guardian_id) DO UPDATE
           SET relationship = EXCLUDED.relationship, is_primary = EXCLUDED.is_primary,
               can_book = EXCLUDED.can_book, can_consent = EXCLUDED.can_consent`,
        [id, body.guardianId, body.relationship, body.isPrimary, body.canBook, body.canConsent],
      );
      await audit(db, actor, 'guardian_linked', 'player', id, null, body);
      return { ok: true };
    });
  });

  app.delete('/v1/players/:id/guardians/:guardianId', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id, guardianId } = parse(z.object({ id: z.uuid(), guardianId: z.uuid() }), req.params);
    await tx(async (db) => {
      await db.query(`DELETE FROM player_guardians WHERE player_id = $1 AND guardian_id = $2`, [id, guardianId]);
      await audit(db, actor, 'guardian_unlinked', 'player', id, { guardianId }, null);
    });
    return { ok: true };
  });

  // ---------------------------------------------------------------- consents
  app.get('/v1/players/:id/consents', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const access = await requirePlayerAccess(pool, actor, id);
    if (access === 'coach') throw forbidden();
    return {
      current: await currentConsents(pool, id),
      history: await many(pool, `SELECT * FROM consents WHERE player_id = $1 ORDER BY created_at DESC`, [id]),
    };
  });

  app.post('/v1/players/:id/consents', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({
        consentType: z.enum(['data_processing', 'injury_information', 'video_recording', 'video_sharing']),
        granted: z.boolean(),
        // Admins record consent collected on paper, on behalf of a named guardian.
        onBehalfOfGuardianId: z.uuid().optional(),
        note: z.string().max(1000).optional(),
      }),
      req.body,
    );
    return tx(async (db) => {
      const player = await one(db, `SELECT date_of_birth FROM players WHERE id = $1`, [id]);
      if (!player) throw notFound('Player');
      const minor = ageOn(player.date_of_birth) < ADULT_AGE;
      let guardianId: string | null = null;
      if (actor.role === 'guardian') {
        const link = await one(db, `SELECT can_consent FROM player_guardians WHERE guardian_id = $1 AND player_id = $2`, [actor.profileId, id]);
        if (!link?.can_consent) throw forbidden('You are not authorised to give consent for this player');
        guardianId = actor.profileId;
      } else if (actor.role === 'admin') {
        guardianId = body.onBehalfOfGuardianId ?? null;
        if (minor && !guardianId) throw badRequest('Consent for a minor must name the guardian who gave it');
      } else if (actor.role === 'player' && actor.profileId === id) {
        // Minors can't consent for themselves; their guardian has to.
        if (minor) throw forbidden('A parent or guardian must give consent for players under 18');
      } else {
        throw forbidden();
      }
      const row = await one(
        db,
        `INSERT INTO consents (player_id, consent_type, granted, given_by_guardian_id, given_by_user_id, note)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, body.consentType, body.granted, guardianId, actor.userId, body.note ?? null],
      );
      await audit(db, actor, body.granted ? 'consent_granted' : 'consent_withdrawn', 'player', id, null, row);
      return row;
    });
  });

  // ---------------------------------------------------------------- injuries
  app.get('/v1/players/:id/injuries', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const access = await requirePlayerAccess(pool, actor, id);
    const rows = await many(
      pool,
      `SELECT * FROM injuries WHERE player_id = $1 ${access === 'coach' ? `AND (is_current OR severity = 'major')` : ''}
        ORDER BY is_current DESC, coalesce(injury_date, created_at::date) DESC`,
      [id],
    );
    return rows.map((r) => presentInjury(r, access));
  });

  const injuryFields = z.object({
    title: z.string().trim().min(1).max(200),
    severity: z.enum(['minor', 'major']),
    is_current: z.boolean().optional(),
    injury_date: isoDate.nullable().optional(),
    recovery_status: optionalText,
    professional_restrictions: z.string().max(2000).nullable().optional(),
    coach_observations: z.string().max(2000).nullable().optional(),
    follow_up_date: isoDate.nullable().optional(),
  });

  app.post('/v1/players/:id/injuries', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const body = parse(injuryFields, req.body);
    return tx(async (db) => {
      const access = await requirePlayerAccess(db, actor, id);
      const source = { full: 'admin', coach: 'coach', self: 'player_report', guardian: 'guardian_report' }[access];
      // Players and guardians report; only staff record observations and follow-ups.
      if (access === 'self' || access === 'guardian') {
        body.coach_observations = undefined;
        body.follow_up_date = undefined;
      }
      const cols = Object.keys(body).filter((k) => (body as any)[k] !== undefined);
      const row = await one(
        db,
        `INSERT INTO injuries (player_id, reported_by, source, ${cols.join(', ')})
         VALUES ($1, $2, $3, ${cols.map((_, i) => `$${i + 4}`).join(', ')}) RETURNING *`,
        [id, actor.userId, source, ...cols.map((c) => (body as any)[c])],
      );
      await audit(db, actor, 'injury_recorded', 'injury', row.id, null, { player_id: id, title: row.title, severity: row.severity });
      return presentInjury(row, access);
    });
  });

  app.patch('/v1/injuries/:id', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    const body = parse(injuryFields.partial(), req.body);
    return tx(async (db) => {
      const before = await one(db, `SELECT * FROM injuries WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('Injury');
      const access = await requirePlayerAccess(db, actor, before.player_id);
      const allowed =
        access === 'full'
          ? Object.keys(injuryFields.shape)
          : access === 'coach'
            ? ['coach_observations', 'follow_up_date', 'recovery_status', 'is_current']
            : [];
      const blocked = Object.keys(body).filter((k) => !allowed.includes(k));
      if (blocked.length) throw forbidden(`You cannot change: ${blocked.join(', ')}`);
      const cols = Object.keys(body);
      if (!cols.length) return presentInjury(before, access);
      const row = await one(db, `UPDATE injuries SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...cols.map((c) => (body as any)[c])]);
      await audit(db, actor, 'injury_updated', 'injury', id, Object.fromEntries(cols.map((c) => [c, before[c]])), body);
      return presentInjury(row, access);
    });
  });

  // ----------------------------------------------------------------- coaches
  const coachFields = z.object({
    full_name: z.string().trim().min(1).max(200),
    phone: optionalText,
    specialisations: optionalText,
    requires_booking_approval: z.boolean().optional(),
    status: z.enum(['active', 'inactive', 'archived']).optional(),
  });

  app.get('/v1/coaches', async (req) => {
    const actor = actorOf(req);
    const rows = await many(pool, `SELECT * FROM coaches WHERE status = 'active' OR $1 ORDER BY full_name`, [actor.role === 'admin']);
    return rows.map((c) =>
      actor.role === 'admin' || actor.role === 'coach'
        ? c
        : { id: c.id, full_name: c.full_name, specialisations: c.specialisations },
    );
  });

  app.post('/v1/coaches', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const body = parse(coachFields, req.body);
    return tx(async (db) => {
      const cols = Object.keys(body);
      const row = await one(db, `INSERT INTO coaches (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, cols.map((c) => (body as any)[c]));
      await audit(db, actor, 'coach_created', 'coach', row.id, null, row);
      return row;
    });
  });

  app.patch('/v1/coaches/:id', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(coachFields.partial(), req.body);
    return tx(async (db) => {
      const before = await one(db, `SELECT * FROM coaches WHERE id = $1 FOR UPDATE`, [id]);
      if (!before) throw notFound('Coach');
      const cols = Object.keys(body);
      if (!cols.length) return before;
      const row = await one(db, `UPDATE coaches SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [id, ...cols.map((c) => (body as any)[c])]);
      await audit(db, actor, 'coach_updated', 'coach', id, before, row);
      return row;
    });
  });

  app.put('/v1/coaches/:id/availability', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    if (!(actor.role === 'admin' || (actor.role === 'coach' && actor.profileId === id))) throw forbidden();
    const time = z.string().regex(/^\d{2}:\d{2}$/);
    const body = parse(z.object({ slots: z.array(z.object({ weekday: z.number().int().min(1).max(7), start: time, end: time })).max(50) }), req.body);
    if (body.slots.some((s) => s.end <= s.start)) throw badRequest('Each slot must end after it starts');
    await tx(async (db) => {
      await db.query(`DELETE FROM coach_availability WHERE coach_id = $1`, [id]);
      for (const s of body.slots) {
        await db.query(`INSERT INTO coach_availability (coach_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4)`, [id, s.weekday, s.start, s.end]);
      }
      await audit(db, actor, 'availability_set', 'coach', id, null, body);
    });
    return { ok: true };
  });

  app.get('/v1/coaches/:id/availability', async (req) => {
    actorOf(req);
    const { id } = parse(idParams, req.params);
    return many(pool, `SELECT weekday, to_char(start_time, 'HH24:MI') AS start, to_char(end_time, 'HH24:MI') AS end FROM coach_availability WHERE coach_id = $1 ORDER BY weekday, start_time`, [id]);
  });

  // -------------------------------------------------------------- facilities
  app.get('/v1/locations', async (req) => {
    actorOf(req);
    const locations = await many(pool, `SELECT * FROM locations WHERE active ORDER BY name`);
    const areas = await many(pool, `SELECT * FROM training_areas WHERE active ORDER BY name`);
    return locations.map((l) => ({ ...l, areas: areas.filter((a) => a.location_id === l.id) }));
  });

  app.post('/v1/locations', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const body = parse(z.object({ name: z.string().trim().min(1).max(200), address: optionalText }), req.body);
    return one(pool, `INSERT INTO locations (name, address) VALUES ($1, $2) RETURNING *`, [body.name, body.address ?? null]);
  });

  app.post('/v1/locations/:id/areas', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ name: z.string().trim().min(1).max(200), kind: optionalText }), req.body);
    return one(pool, `INSERT INTO training_areas (location_id, name, kind) VALUES ($1, $2, $3) RETURNING *`, [id, body.name, body.kind ?? null]);
  });

  // ------------------------------------------------------------------ groups
  app.get('/v1/groups', async (req) => {
    const actor = actorOf(req);
    if (actor.role !== 'admin' && actor.role !== 'coach') throw forbidden();
    return many(
      pool,
      `SELECT g.*,
              coalesce((SELECT json_agg(json_build_object('id', p.id, 'full_name', p.full_name) ORDER BY p.full_name)
                          FROM group_members gm JOIN players p ON p.id = gm.player_id WHERE gm.group_id = g.id), '[]') AS players,
              coalesce((SELECT json_agg(json_build_object('id', c.id, 'full_name', c.full_name))
                          FROM group_coaches gc JOIN coaches c ON c.id = gc.coach_id WHERE gc.group_id = g.id), '[]') AS coaches
         FROM training_groups g
        WHERE g.active AND ($1 OR EXISTS (SELECT 1 FROM group_coaches gc WHERE gc.group_id = g.id AND gc.coach_id = $2))
        ORDER BY g.name`,
      [actor.role === 'admin', actor.profileId],
    );
  });

  app.post('/v1/groups', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(200),
        description: optionalText,
        playerIds: z.array(z.uuid()).max(200).default([]),
        coachIds: z.array(z.uuid()).max(20).default([]),
      }),
      req.body,
    );
    return tx(async (db) => {
      const group = await one(db, `INSERT INTO training_groups (name, description) VALUES ($1, $2) RETURNING *`, [body.name, body.description ?? null]);
      await setGroupMembers(db, group.id, body.playerIds, body.coachIds);
      await audit(db, actor, 'group_created', 'group', group.id, null, body);
      return group;
    });
  });

  app.put('/v1/groups/:id/members', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const { id } = parse(idParams, req.params);
    const body = parse(z.object({ playerIds: z.array(z.uuid()).max(200), coachIds: z.array(z.uuid()).max(20) }), req.body);
    await tx(async (db) => {
      await setGroupMembers(db, id, body.playerIds, body.coachIds);
      await audit(db, actor, 'group_members_set', 'group', id, null, body);
    });
    return { ok: true };
  });
}

async function setGroupMembers(db: Db, groupId: string, playerIds: string[], coachIds: string[]) {
  await db.query(`DELETE FROM group_members WHERE group_id = $1`, [groupId]);
  await db.query(`DELETE FROM group_coaches WHERE group_id = $1`, [groupId]);
  await db.query(`INSERT INTO group_members (group_id, player_id) SELECT $1, unnest($2::uuid[])`, [groupId, playerIds]);
  await db.query(`INSERT INTO group_coaches (group_id, coach_id) SELECT $1, unnest($2::uuid[])`, [groupId, coachIds]);
}

