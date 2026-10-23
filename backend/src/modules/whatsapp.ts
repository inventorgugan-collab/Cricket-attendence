import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { currentAcademy, Db, many, one, platformPool, pool, runInAcademy, schemaFor } from '../db.js';
import { audit } from '../lib/audit.js';
import { requireRole } from '../lib/authz.js';
import { leaveSpan, when } from '../lib/coaching.js';
import { badRequest, notFound } from '../lib/errors.js';
import { actorOf, idParams, parse } from '../lib/http.js';
import { localDate } from '../lib/time.js';
import { normalisePhone, queueWhatsApp } from '../lib/whatsapp.js';
import { sessionsNeedingCover } from './sessions.js';

const TZ = config.timeZone;

// WhatsApp delivery through Meta's official WhatsApp Business Platform (Cloud
// API). In-app notifications stay the record; WhatsApp is an extra copy for
// the alerts people most need to see quickly, plus an end-of-day summary for
// coaches. Until an academy connects its WhatsApp Business number, every
// message is stored as a preview so the admin can see exactly what would go.

const key = () => createHash('sha256').update(config.messagingKey ?? '').digest();

function encrypt(text: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(blob: string): string {
  const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64')) as [Buffer, Buffer, Buffer];
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

// Template parameters can't contain line breaks, so lines are joined.
const oneLine = (s: string) => s.replace(/\s*\n+\s*/g, ' · ').replace(/\s{4,}/g, '   ').slice(0, 1000);

type Fetch = typeof fetch;

async function settings(db: Db) {
  return (await one(db, `SELECT * FROM whatsapp_settings`))!;
}

const isConnected = (s: any) => !!(s.phone_number_id && s.access_token_enc);

// Send whatever is queued for the current academy.
export async function deliverQueued(fetchImpl: Fetch = fetch): Promise<{ sent: number; failed: number; previewed: number }> {
  const s = await settings(pool);
  const out = { sent: 0, failed: 0, previewed: 0 };
  if (!isConnected(s)) {
    const r = await pool.query(`UPDATE whatsapp_messages SET status = 'preview', status_reason = 'WhatsApp is not connected yet' WHERE status = 'queued'`);
    out.previewed = r.rowCount ?? 0;
    return out;
  }
  const token = decrypt(s.access_token_enc);
  const academy = currentAcademy().name;
  const queued = await many(pool, `SELECT * FROM whatsapp_messages WHERE status = 'queued' ORDER BY created_at LIMIT 50`);
  for (const m of queued) {
    const payload = {
      messaging_product: 'whatsapp',
      ...(m.to_group ? { recipient_type: 'group', to: m.to_group } : { recipient_type: 'individual', to: m.to_phone }),
      type: 'template',
      template: {
        name: s.template_name,
        language: { code: s.template_language },
        components: [{ type: 'body', parameters: [{ type: 'text', text: academy }, { type: 'text', text: oneLine(m.body) }] }],
      },
    };
    try {
      const res = await fetchImpl(`${config.whatsappApiBase}/${s.phone_number_id}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body: any = await res.json().catch(() => ({}));
      if (res.ok) {
        await pool.query(`UPDATE whatsapp_messages SET status = 'sent', sent_at = now(), attempts = attempts + 1, provider_message_id = $2 WHERE id = $1`, [m.id, body?.messages?.[0]?.id ?? null]);
        out.sent++;
      } else {
        // Give up after three tries; the in-app notification is still there.
        const reason = body?.error?.message ?? `HTTP ${res.status}`;
        await pool.query(
          `UPDATE whatsapp_messages SET attempts = attempts + 1, status_reason = $2, status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'queued' END WHERE id = $1`,
          [m.id, reason],
        );
        out.failed++;
      }
    } catch (err) {
      await pool.query(
        `UPDATE whatsapp_messages SET attempts = attempts + 1, status_reason = $2, status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE 'queued' END WHERE id = $1`,
        [m.id, (err as Error).message],
      );
      out.failed++;
    }
  }
  return out;
}

// --------------------------------------------------------- daily summary

const dayRange = `(($1::date)::timestamp AT TIME ZONE '${TZ}')`;
const nextDayRange = `((($1::date) + 1)::timestamp AT TIME ZONE '${TZ}')`;

// What coaches should know at the end of the day: who was off, which sessions
// moved to another coach, what was cancelled, what still needs a coach, and
// tomorrow's count. Returns null on a quiet day.
// When someone is back: "Sun, 25 Oct" for whole-day leave, a time otherwise.
const atMidnightLabel = (d: Date | string) => {
  const s = when(d);
  return s.endsWith('12:00 am') ? s.replace(/, 12:00 am$/, '') : s;
};

export async function buildDailyDigest(db: Db, day: string = localDate()): Promise<string | null> {
  const leave = await many(
    db,
    `SELECT c.full_name, l.kind, l.reason, l.starts_at, l.ends_at,
            l.during && tstzrange(${dayRange}, ${nextDayRange}) AS away_today
       FROM coach_leave l JOIN coaches c ON c.id = l.coach_id
      WHERE l.status = 'active' AND (l.during && tstzrange(${dayRange}, ${nextDayRange}) OR (l.created_at >= ${dayRange} AND l.created_at < ${nextDayRange}))
      ORDER BY l.kind DESC, c.full_name`,
    [day],
  );
  const moved = await many(
    db,
    `SELECT DISTINCT ON (a.entity_id) s.title, cat.name AS category_name, s.starts_at,
            (SELECT string_agg(c.full_name, ', ') FROM coaches c WHERE c.id::text IN (SELECT jsonb_array_elements_text(a.after->'coachIds'))) AS now_with
       FROM audit_log a JOIN sessions s ON s.id = a.entity_id JOIN session_categories cat ON cat.id = s.category_id
      WHERE a.action = 'session_coaches_changed' AND a.created_at >= ${dayRange} AND a.created_at < ${nextDayRange}
      ORDER BY a.entity_id, a.created_at DESC`,
    [day],
  );
  const cancelled = await many(
    db,
    `SELECT s.title, cat.name AS category_name, s.starts_at, s.cancellation_reason FROM audit_log a
       JOIN sessions s ON s.id = a.entity_id JOIN session_categories cat ON cat.id = s.category_id
      WHERE a.action = 'session_cancelled' AND a.created_at >= ${dayRange} AND a.created_at < ${nextDayRange}`,
    [day],
  );
  const uncovered = await sessionsNeedingCover(db);
  const tomorrow = await one(
    db,
    `SELECT count(*)::int AS n FROM sessions WHERE status = 'scheduled'
      AND starts_at >= ${nextDayRange} AND starts_at < ((($1::date) + 2)::timestamp AT TIME ZONE '${TZ}')`,
    [day],
  );
  if (!leave.length && !moved.length && !cancelled.length && !uncovered.length) return null;
  const label = (s: any) => `${s.title ?? s.category_name}, ${when(s.starts_at)}`;
  const lines = [`Coaches' update for ${new Date(`${day}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}`];
  const away = leave.filter((l) => l.away_today);
  const booked = leave.filter((l) => !l.away_today);
  if (away.length) {
    lines.push('Away:');
    for (const l of away) lines.push(`- ${l.full_name}: ${l.kind === 'emergency' ? 'emergency leave' : 'leave'}, back ${atMidnightLabel(l.ends_at)}${l.reason ? ` (${l.reason})` : ''}`);
  }
  if (booked.length) {
    lines.push('Leave booked today:');
    for (const l of booked) lines.push(`- ${l.full_name}: off ${leaveSpan(l.starts_at, l.ends_at)}${l.reason ? ` (${l.reason})` : ''}`);
  }
  if (moved.length) {
    lines.push('Covered by another coach:');
    for (const m of moved) lines.push(`- ${label(m)}: now ${m.now_with}`);
  }
  if (uncovered.length) {
    lines.push('Still needs a coach:');
    for (const u of uncovered) lines.push(`- ${label(u)} (${u.coach_name} away)`);
  }
  if (cancelled.length) {
    lines.push('Cancelled:');
    for (const c of cancelled) lines.push(`- ${label(c)}${c.cancellation_reason ? ` (${c.cancellation_reason})` : ''}`);
  }
  lines.push(`Tomorrow: ${tomorrow.n} session${tomorrow.n === 1 ? '' : 's'} scheduled.`);
  return lines.join('\n');
}

// Post the summary to the coaches' WhatsApp group if there is one, otherwise
// to each coach who has agreed to WhatsApp messages. Also kept in-app.
export async function sendDailyDigest(db: Db, day: string = localDate()): Promise<{ text: string | null; messages: number }> {
  const text = await buildDailyDigest(db, day);
  await db.query(`UPDATE whatsapp_settings SET last_digest_on = $1`, [day]);
  if (!text) return { text, messages: 0 };
  const s = await settings(db);
  const coaches = await many(db, `SELECT u.id FROM users u JOIN coaches c ON c.user_id = u.id WHERE u.status = 'active' AND c.status = 'active'`);
  await db.query(
    `INSERT INTO notifications (user_id, kind, title, body, data) SELECT u, 'coach_digest', 'Coaches'' update', $2, '{}' FROM unnest($1::uuid[]) AS u`,
    [coaches.map((c) => c.id), text],
  );
  if (s.coach_group_id) {
    await db.query(`INSERT INTO whatsapp_messages (kind, to_group, body) VALUES ('coach_digest', $1, $2)`, [s.coach_group_id, text]);
    return { text, messages: 1 };
  }
  const queued = await queueWhatsApp(db, coaches.map((c) => c.id), { kind: 'coach_digest', title: "Coaches' update", body: text.split('\n').slice(1).join('\n') }, { always: true });
  return { text, messages: queued };
}

// Runs every minute on the server, for every academy: sends queued messages,
// and the end-of-day summary once the academy's chosen hour has passed.
export async function whatsappTick(fetchImpl: Fetch = fetch) {
  const academies = await many(platformPool, `SELECT code, name FROM academies WHERE status = 'active'`);
  for (const a of academies) {
    await runInAcademy({ code: a.code, name: a.name, schema: schemaFor(a.code) }, async () => {
      try {
        const s = await settings(pool);
        const today = localDate();
        const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
        if (s.digest_enabled && hour >= s.digest_hour && (!s.last_digest_on || s.last_digest_on < today)) await sendDailyDigest(pool, today);
        await deliverQueued(fetchImpl);
      } catch (err) {
        console.error(`WhatsApp tick failed for ${a.code}:`, (err as Error).message);
      }
    });
  }
}

// ------------------------------------------------------------------ routes

export async function whatsappRoutes(app: FastifyInstance) {
  const present = (s: any) => ({
    connected: isConnected(s),
    phoneNumberId: s.phone_number_id,
    hasAccessToken: !!s.access_token_enc,
    templateName: s.template_name,
    templateLanguage: s.template_language,
    coachGroupId: s.coach_group_id,
    digestHour: s.digest_hour,
    digestEnabled: s.digest_enabled,
    lastDigestOn: s.last_digest_on,
  });

  app.get('/v1/whatsapp/settings', async (req) => {
    requireRole(actorOf(req), 'admin');
    return present(await settings(pool));
  });

  app.put('/v1/whatsapp/settings', async (req) => {
    const actor = actorOf(req);
    requireRole(actor, 'admin');
    const body = parse(
      z.object({
        phoneNumberId: z.string().trim().regex(/^\d{5,30}$/).nullable().optional(),
        accessToken: z.string().trim().min(20).max(1000).nullable().optional(),
        templateName: z.string().trim().regex(/^[a-z0-9_]{1,512}$/).optional(),
        templateLanguage: z.string().trim().min(2).max(10).optional(),
        coachGroupId: z.string().trim().max(200).nullable().optional(),
        digestHour: z.number().int().min(0).max(23).optional(),
        digestEnabled: z.boolean().optional(),
      }),
      req.body,
    );
    const map: Record<string, [string, (v: any) => unknown]> = {
      phoneNumberId: ['phone_number_id', (v) => v],
      accessToken: ['access_token_enc', (v) => (v ? encrypt(v) : null)],
      templateName: ['template_name', (v) => v],
      templateLanguage: ['template_language', (v) => v],
      coachGroupId: ['coach_group_id', (v) => v || null],
      digestHour: ['digest_hour', (v) => v],
      digestEnabled: ['digest_enabled', (v) => v],
    };
    const changes = Object.entries(body).filter(([k, v]) => v !== undefined && k in map);
    if (changes.length) {
      await pool.query(
        `UPDATE whatsapp_settings SET ${changes.map(([k], i) => `${map[k]![0]} = $${i + 1}`).join(', ')}, updated_at = now()`,
        changes.map(([k, v]) => map[k]![1](v)),
      );
    }
    // Never write the token itself into the audit log.
    await audit(pool, actor, 'whatsapp_settings_changed', 'whatsapp_settings', null, null, { fields: changes.map(([k]) => k) });
    return present(await settings(pool));
  });

  app.get('/v1/whatsapp/messages', async (req) => {
    requireRole(actorOf(req), 'admin');
    return many(
      pool,
      `SELECT m.id, m.kind, m.to_phone, m.to_group, m.body, m.status, m.status_reason, m.created_at, m.sent_at, u.display_name AS to_name
         FROM whatsapp_messages m LEFT JOIN users u ON u.id = m.to_user_id ORDER BY m.created_at DESC LIMIT 200`,
    );
  });

  // Everyone with an account, whether they've agreed to WhatsApp messages, and
  // the number messages would go to.
  app.get('/v1/whatsapp/people', async (req) => {
    requireRole(actorOf(req), 'admin');
    const rows = await many(
      pool,
      `SELECT u.id, u.display_name, u.role, u.whatsapp_opt_in, u.whatsapp_phone,
              coalesce(u.whatsapp_phone, c.phone, g.phone, p.phone) AS phone
         FROM users u
         LEFT JOIN coaches c ON c.user_id = u.id LEFT JOIN guardians g ON g.user_id = u.id LEFT JOIN players p ON p.user_id = u.id
        WHERE u.status = 'active'
        ORDER BY array_position(ARRAY['admin', 'coach', 'guardian', 'player']::text[], u.role::text), u.display_name`,
    );
    return rows.map((r) => ({ ...r, phone: normalisePhone(r.phone) }));
  });

  // See today's coaches' summary, and optionally send it now.
  app.post('/v1/whatsapp/digest', async (req) => {
    requireRole(actorOf(req), 'admin');
    const body = parse(z.object({ send: z.boolean().default(false) }), req.body ?? {});
    if (!body.send) return { text: await buildDailyDigest(pool) };
    const r = await sendDailyDigest(pool);
    await deliverQueued();
    return r;
  });

  // Who gets WhatsApp messages. People must agree first (WhatsApp's rules).
  app.put('/v1/users/:id/whatsapp', async (req) => {
    const actor = actorOf(req);
    const { id } = parse(idParams, req.params);
    if (actor.role !== 'admin' && actor.userId !== id) requireRole(actor, 'admin');
    const body = parse(z.object({ optIn: z.boolean(), phone: z.string().trim().max(20).nullable().optional() }), req.body);
    if (body.phone && !normalisePhone(body.phone)) throw badRequest('That does not look like a mobile number');
    const row = await one(
      pool,
      `UPDATE users SET whatsapp_opt_in = $2, whatsapp_phone = CASE WHEN $3::boolean THEN $4 ELSE whatsapp_phone END WHERE id = $1
       RETURNING id, whatsapp_opt_in, whatsapp_phone`,
      [id, body.optIn, body.phone !== undefined, body.phone ?? null],
    );
    if (!row) throw notFound('User');
    await audit(pool, actor, 'whatsapp_preference_changed', 'user', id, null, row);
    return row;
  });
}
