import { Db, many } from '../db.js';

// Notification kinds that also go out on WhatsApp straight away.
const IMMEDIATE = new Set([
  'booking_confirmed', 'booking_rejected', 'booking_needs_guardian', 'session_cancelled', 'schedule_changed',
  'coach_changed', 'session_assigned', 'session_unassigned', 'session_request', 'coach_emergency_leave',
  'package_used', 'package_low', 'package_used_up',
]);

// Indian numbers are stored however people type them; WhatsApp wants 91XXXXXXXXXX.
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

// Queues a WhatsApp copy of a notification for each person who has a number
// and has agreed to WhatsApp messages; the rest are logged as skipped. A
// background job sends the queue. Returns how many were queued to send.
export async function queueWhatsApp(db: Db, userIds: string[], n: { kind: string; title: string; body: string }, opts: { always?: boolean } = {}): Promise<number> {
  if ((!opts.always && !IMMEDIATE.has(n.kind)) || userIds.length === 0) return 0;
  const people = await many(
    db,
    `SELECT u.id, u.whatsapp_opt_in,
            coalesce(u.whatsapp_phone, c.phone, g.phone, p.phone) AS phone
       FROM users u
       LEFT JOIN coaches c ON c.user_id = u.id LEFT JOIN guardians g ON g.user_id = u.id LEFT JOIN players p ON p.user_id = u.id
      WHERE u.id = ANY($1) AND u.status = 'active'`,
    [userIds],
  );
  let queued = 0;
  for (const person of people) {
    const phone = normalisePhone(person.phone);
    const skip = !person.whatsapp_opt_in ? 'Has not agreed to WhatsApp messages' : !phone ? 'No mobile number on file' : null;
    await db.query(
      `INSERT INTO whatsapp_messages (kind, to_user_id, to_phone, body, status, status_reason) VALUES ($1, $2, $3, $4, $5, $6)`,
      [n.kind, person.id, phone, `${n.title}\n${n.body}`, skip ? 'skipped' : 'queued', skip],
    );
    if (!skip) queued++;
  }
  return queued;
}
