import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { Db, many, one, pool, tx } from '../db.js';
import { Actor } from '../lib/actor.js';
import { audit } from '../lib/audit.js';
import { requireRole } from '../lib/authz.js';
import { forbidden } from '../lib/errors.js';
import { actorOf, isoDate, parse } from '../lib/http.js';
import { notifyUsers } from '../lib/notify.js';
import { getPolicy, mergePolicy } from '../lib/settings.js';
import { localDate } from '../lib/time.js';
import { packageSummary } from './credits.js';
import { sessionsNeedingCover } from './sessions.js';

const TZ = config.timeZone;

// Sessions in a local-date range, with expected-versus-present counts.
async function sessionCounts(db: Db, from: string, to: string, coachId: string | null) {
  return many(
    db,
    `SELECT s.id, s.starts_at, s.ends_at, s.session_type, s.title, s.status, s.capacity,
            cat.name AS category_name, cat.code AS category_code,
            coalesce((SELECT json_agg(c.full_name) FROM session_coaches sc JOIN coaches c ON c.id = sc.coach_id WHERE sc.session_id = s.id AND sc.active), '[]') AS coaches,
            (SELECT count(*) FROM bookings b WHERE b.session_id = s.id AND b.status IN ('confirmed', 'completed'))::int AS expected,
            (SELECT count(*) FROM attendance a WHERE a.session_id = s.id AND a.status = 'present')::int AS present,
            (SELECT count(*) FROM attendance a WHERE a.session_id = s.id AND a.status = 'late')::int AS late,
            (SELECT count(*) FROM attendance a WHERE a.session_id = s.id AND a.status = 'absent')::int AS absent,
            (SELECT count(*) FROM attendance a WHERE a.session_id = s.id AND a.status = 'excused')::int AS excused,
            (SELECT count(*) FROM bookings b WHERE b.session_id = s.id AND b.status IN ('confirmed', 'completed')
               AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = s.id AND a.player_id = b.player_id))::int AS not_recorded
       FROM sessions s JOIN session_categories cat ON cat.id = s.category_id
      WHERE (s.starts_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
        AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM session_coaches sc WHERE sc.session_id = s.id AND sc.active AND sc.coach_id = $4))
      ORDER BY s.starts_at`,
    [from, to, TZ, coachId],
  );
}

async function missingAttendance(db: Db, coachId: string | null) {
  return many(
    db,
    `SELECT s.id, s.starts_at, s.ends_at, s.title, s.session_type,
            coalesce((SELECT json_agg(c.full_name) FROM session_coaches sc JOIN coaches c ON c.id = sc.coach_id WHERE sc.session_id = s.id AND sc.active), '[]') AS coaches,
            count(b.id)::int AS players_missing
       FROM sessions s JOIN bookings b ON b.session_id = s.id AND b.status IN ('confirmed', 'completed')
      WHERE s.ends_at < now() AND s.ends_at > now() - interval '60 days' AND s.status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = s.id AND a.player_id = b.player_id)
        AND ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM session_coaches sc WHERE sc.session_id = s.id AND sc.active AND sc.coach_id = $1))
      GROUP BY s.id ORDER BY s.starts_at DESC`,
    [coachId],
  );
}

async function inactivePlayers(db: Db, days: number) {
  return many(
    db,
    `SELECT p.id, p.full_name, max(s.starts_at) AS last_attended
       FROM players p
       LEFT JOIN attendance a ON a.player_id = p.id AND a.status IN ('present', 'late')
       LEFT JOIN sessions s ON s.id = a.session_id
      WHERE p.status = 'active'
      GROUP BY p.id
     HAVING max(s.starts_at) IS NULL OR max(s.starts_at) < now() - make_interval(days => $1)
      ORDER BY last_attended NULLS FIRST`,
    [days],
  );
}

async function reviewsDue(db: Db, days: number, coachId: string | null) {
  return many(
    db,
    `SELECT p.id, p.full_name, max(n.created_at) AS last_review
       FROM players p LEFT JOIN coach_notes n ON n.player_id = p.id AND NOT n.deleted
      WHERE p.status = 'active'
        AND ($2::uuid IS NULL OR p.id IN (SELECT player_id FROM player_coaches WHERE coach_id = $2))
      GROUP BY p.id
     HAVING max(n.created_at) IS NULL OR max(n.created_at) < now() - make_interval(days => $1)
      ORDER BY last_review NULLS FIRST`,
    [days, coachId],
  );
}

export async function adminRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- settings
  app.get('/v1/settings/policy', async (req) => {
    actorOf(req);
    return getPolicy(pool);
  });

  app.patch('/v1/settings/policy', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    return tx(async (db) => {
      const before = await getPolicy(db);
      const next = mergePolicy(before, req.body);
      await db.query(
        `INSERT INTO academy_settings (key, value, updated_by) VALUES ('policy', $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [next, actor.userId],
      );
      await audit(db, actor, 'policy_updated', 'settings', null, before, next);
      return next;
    });
  });

  // ------------------------------------------------------------------- audit
  app.get('/v1/audit', async (req) => {
    requireRole(actorOf(req), 'admin');
    const q = parse(z.object({ entity: z.string().max(50).optional(), entityId: z.uuid().optional(), actorId: z.uuid().optional(), before: z.coerce.number().int().optional() }), req.query);
    return many(
      pool,
      `SELECT l.*, u.display_name AS actor_name FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
        WHERE ($1::text IS NULL OR l.entity = $1) AND ($2::uuid IS NULL OR l.entity_id = $2)
          AND ($3::uuid IS NULL OR l.actor_id = $3) AND ($4::bigint IS NULL OR l.id < $4)
        ORDER BY l.id DESC LIMIT 200`,
      [q.entity ?? null, q.entityId ?? null, q.actorId ?? null, q.before ?? null],
    );
  });

  // ----------------------------------------------------------- notifications
  app.get('/v1/notifications', async (req) => {
    const actor = actorOf(req);
    return many(pool, `SELECT id, kind, title, body, data, read_at, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [actor.userId]);
  });

  app.post('/v1/notifications/read', async (req) => {
    const actor = actorOf(req);
    const body = parse(z.object({ ids: z.array(z.uuid()).max(200).optional() }), req.body ?? {});
    await pool.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2))`, [actor.userId, body.ids ?? null]);
    return { ok: true };
  });

  app.post('/v1/push-tokens', async (req) => {
    const actor = actorOf(req);
    const body = parse(z.object({ token: z.string().min(10).max(4096), platform: z.enum(['android', 'ios']) }), req.body);
    await pool.query(
      `INSERT INTO push_tokens (token, user_id, platform) VALUES ($1, $2, $3)
       ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = now()`,
      [body.token, actor.userId, body.platform],
    );
    return { ok: true };
  });

  app.get('/v1/announcements', async (req) => {
    const actor = actorOf(req);
    return many(pool, `SELECT id, title, body, audience, created_at FROM announcements WHERE $1 = ANY(audience) OR $2 ORDER BY created_at DESC LIMIT 50`, [actor.role, actor.role === 'admin']);
  });

  app.post('/v1/announcements', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const body = parse(
      z.object({ title: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(4000), audience: z.array(z.enum(['admin', 'coach', 'player', 'guardian'])).min(1) }),
      req.body,
    );
    return tx(async (db) => {
      const row = await one(db, `INSERT INTO announcements (title, body, audience, created_by) VALUES ($1, $2, $3, $4) RETURNING *`, [body.title, body.body, body.audience, actor.userId]);
      const users = await many(db, `SELECT id FROM users WHERE status = 'active' AND role = ANY($1)`, [body.audience]);
      await notifyUsers(db, users.map((u) => u.id), { kind: 'announcement', title: body.title, body: body.body.slice(0, 300), data: { announcementId: row.id } });
      await audit(db, actor, 'announcement_sent', 'announcement', row.id, null, body);
      return row;
    });
  });

  // ----------------------------------------------------------------- reports
  const range = z.object({ from: isoDate, to: isoDate });

  app.get('/v1/reports/daily', async (req) => {
    const actor = actorOf(req);
    if (actor.role !== 'admin' && actor.role !== 'coach') throw forbidden();
    const q = parse(z.object({ date: isoDate.optional() }), req.query);
    const date = q.date ?? localDate();
    const sessions = await sessionCounts(pool, date, date, actor.role === 'coach' ? actor.profileId : null);
    const live = sessions.filter((s) => s.status !== 'cancelled');
    const sum = (k: string) => live.reduce((acc, s) => acc + s[k], 0);
    return {
      date,
      totals: { sessions: live.length, cancelled: sessions.length - live.length, expected: sum('expected'), present: sum('present'), late: sum('late'), absent: sum('absent'), excused: sum('excused'), notRecorded: sum('not_recorded') },
      sessions,
    };
  });

  app.get('/v1/reports/monthly', async (req) => {
    requireRole(actorOf(req), 'admin');
    const q = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }), req.query);
    const from = `${q.month}-01`;
    const players = await many(
      pool,
      `WITH m AS (SELECT $1::date AS f, ($1::date + interval '1 month')::date AS t)
       SELECT p.id, p.full_name,
              count(*) FILTER (WHERE s.status <> 'cancelled')::int AS expected,
              count(*) FILTER (WHERE a.status = 'present')::int AS present,
              count(*) FILTER (WHERE a.status = 'late')::int AS late,
              count(*) FILTER (WHERE a.status = 'absent')::int AS absent,
              count(*) FILTER (WHERE a.status = 'excused')::int AS excused,
              count(*) FILTER (WHERE s.status = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE s.status <> 'cancelled' AND a.id IS NULL AND s.ends_at < now())::int AS not_recorded
         FROM m, bookings b
         JOIN sessions s ON s.id = b.session_id
         JOIN players p ON p.id = b.player_id
         LEFT JOIN attendance a ON a.session_id = b.session_id AND a.player_id = b.player_id
        WHERE (s.starts_at AT TIME ZONE $2)::date >= m.f AND (s.starts_at AT TIME ZONE $2)::date < m.t
          AND (b.status IN ('confirmed', 'completed') OR (b.status = 'cancelled' AND s.status = 'cancelled'))
        GROUP BY p.id ORDER BY p.full_name`,
      [from, TZ],
    );
    const groups = await many(
      pool,
      `WITH m AS (SELECT $1::date AS f, ($1::date + interval '1 month')::date AS t)
       SELECT g.id, g.name, count(DISTINCT s.id)::int AS sessions,
              count(b.id) FILTER (WHERE b.status IN ('confirmed', 'completed'))::int AS expected,
              count(a.id) FILTER (WHERE a.status IN ('present', 'late'))::int AS attended
         FROM m, training_groups g
         JOIN sessions s ON s.group_id = g.id AND s.status <> 'cancelled'
         LEFT JOIN bookings b ON b.session_id = s.id
         LEFT JOIN attendance a ON a.session_id = s.id AND a.player_id = b.player_id
        WHERE (s.starts_at AT TIME ZONE $2)::date >= m.f AND (s.starts_at AT TIME ZONE $2)::date < m.t
        GROUP BY g.id ORDER BY g.name`,
      [from, TZ],
    );
    return { month: q.month, players, groups };
  });

  app.get('/v1/reports/coach-completion', async (req) => {
    requireRole(actorOf(req), 'admin');
    const q = parse(range, req.query);
    return many(
      pool,
      `SELECT c.id, c.full_name,
              count(*)::int AS assigned,
              count(*) FILTER (WHERE s.status = 'completed')::int AS completed,
              count(*) FILTER (WHERE s.status = 'cancelled')::int AS cancelled,
              count(*) FILTER (WHERE s.status = 'interrupted')::int AS interrupted,
              count(*) FILTER (WHERE ca.status IN ('present', 'late'))::int AS coach_present,
              count(*) FILTER (WHERE s.ends_at < now() AND s.status <> 'cancelled' AND EXISTS (
                 SELECT 1 FROM bookings b WHERE b.session_id = s.id AND b.status IN ('confirmed', 'completed')
                   AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = s.id AND a.player_id = b.player_id)))::int AS missing_attendance
         FROM coaches c
         JOIN session_coaches sc ON sc.coach_id = c.id
         JOIN sessions s ON s.id = sc.session_id
         LEFT JOIN coach_attendance ca ON ca.session_id = s.id AND ca.coach_id = c.id
        WHERE (sc.active OR s.status = 'cancelled') AND (s.starts_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
        GROUP BY c.id ORDER BY c.full_name`,
      [q.from, q.to, TZ],
    );
  });

  app.get('/v1/reports/missing-attendance', async (req) => {
    const actor = actorOf(req);
    if (actor.role !== 'admin' && actor.role !== 'coach') throw forbidden();
    return missingAttendance(pool, actor.role === 'coach' ? actor.profileId : null);
  });

  app.get('/v1/reports/inactive-players', async (req) => {
    requireRole(actorOf(req), 'admin');
    const policy = await getPolicy(pool);
    const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).optional() }), req.query);
    return inactivePlayers(pool, q.days ?? policy.reports.inactiveAfterDays);
  });

  app.get('/v1/reports/package-usage', async (req) => {
    requireRole(actorOf(req), 'admin');
    const rows = await many(pool, `SELECT pk.*, p.full_name AS player_name FROM packages pk JOIN players p ON p.id = pk.player_id WHERE pk.status = 'active' AND pk.expires_on >= current_date ORDER BY p.full_name`);
    const out = [];
    for (const r of rows) out.push(await packageSummary(pool, r));
    return out;
  });

  // -------------------------------------------------------------- dashboards
  app.get('/v1/dashboard', async (req) => {
    const actor = actorOf(req);
    const policy = await getPolicy(pool);
    const today = localDate();
    if (actor.role === 'admin') return adminDashboard(actor, today, policy.reports);
    if (actor.role === 'coach') {
      const sessions = await sessionCounts(pool, today, today, actor.profileId);
      return {
        today,
        sessions,
        missingAttendance: await missingAttendance(pool, actor.profileId),
        pendingApprovals: (
          await one(
            pool,
            `SELECT count(*)::int AS n FROM bookings b JOIN session_coaches sc ON sc.session_id = b.session_id AND sc.active
              WHERE sc.coach_id = $1 AND b.status = 'pending' AND 'staff' = ANY(b.approvals_needed)`,
            [actor.profileId],
          )
        ).n,
        followUps: await many(
          pool,
          `SELECT i.id, i.player_id, p.full_name, i.title, i.follow_up_date FROM injuries i JOIN players p ON p.id = i.player_id
            WHERE i.is_current AND i.follow_up_date <= current_date + 7
              AND p.id IN (SELECT player_id FROM player_coaches WHERE coach_id = $1) ORDER BY i.follow_up_date`,
          [actor.profileId],
        ),
        reviewsDue: await reviewsDue(pool, policy.reports.developmentReviewEveryDays, actor.profileId),
      };
    }
    throw forbidden('Dashboards are for staff; players and parents use their home screen');
  });

  async function adminDashboard(_actor: Actor, today: string, reports: { inactiveAfterDays: number; developmentReviewEveryDays: number }) {
    const sessions = await sessionCounts(pool, today, today, null);
    const live = sessions.filter((s) => s.status !== 'cancelled');
    const [pending, coaches, upcoming, conflicts] = await Promise.all([
      one(pool, `SELECT count(*)::int AS n FROM bookings WHERE status = 'pending' AND 'staff' = ANY(approvals_needed)`),
      one(
        pool,
        `SELECT count(DISTINCT sc.coach_id)::int AS n FROM session_coaches sc JOIN sessions s ON s.id = sc.session_id
          WHERE sc.active AND s.status <> 'cancelled' AND (s.starts_at AT TIME ZONE $1)::date = $2::date`,
        [TZ, today],
      ),
      many(pool, `SELECT id, starts_at, title, session_type, status FROM sessions WHERE starts_at > now() AND status = 'scheduled' ORDER BY starts_at LIMIT 10`),
      one(pool, `SELECT count(*)::int AS n FROM sync_conflicts WHERE status = 'open'`),
    ]);
    return {
      today,
      expectedToday: live.reduce((a, s) => a + s.expected, 0),
      presentToday: live.reduce((a, s) => a + s.present + s.late, 0),
      coachesScheduledToday: coaches.n,
      cancellationsToday: sessions.length - live.length,
      bookingRequestsAwaitingApproval: pending.n,
      openSyncConflicts: conflicts.n,
      sessionsToday: sessions,
      upcomingSessions: upcoming,
      sessionsAwaitingAttendance: await missingAttendance(pool, null),
      inactivePlayers: await inactivePlayers(pool, reports.inactiveAfterDays),
      reviewsDue: await reviewsDue(pool, reports.developmentReviewEveryDays, null),
      sessionsNeedingCover: await sessionsNeedingCover(pool),
      coachesOnLeaveToday: await many(
        pool,
        `SELECT l.id, l.coach_id, c.full_name AS coach_name, l.kind, l.reason, l.starts_at, l.ends_at
           FROM coach_leave l JOIN coaches c ON c.id = l.coach_id
          WHERE l.status = 'active' AND l.during && tstzrange(($1::date::timestamp AT TIME ZONE $2), (($1::date + 1)::timestamp AT TIME ZONE $2), '[)')
          ORDER BY l.kind DESC, c.full_name`,
        [today, TZ],
      ),
    };
  }
}
