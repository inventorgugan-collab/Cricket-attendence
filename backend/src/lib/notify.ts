import { Db, many } from '../db.js';
import { queueWhatsApp } from './whatsapp.js';

export interface NotificationInput {
  kind: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// Notifications are stored first; push delivery is a best-effort extra on top,
// so nothing critical depends on a push arriving.
export async function notifyUsers(db: Db, userIds: Iterable<string>, n: NotificationInput): Promise<void> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  await db.query(
    `INSERT INTO notifications (user_id, kind, title, body, data)
     SELECT u, $2, $3, $4, $5 FROM unnest($1::uuid[]) AS u`,
    [ids, n.kind, n.title, n.body, n.data ?? {}],
  );
  await queueWhatsApp(db, ids, n);
}

// The player's own account plus every linked guardian with an account.
export async function playerAudience(db: Db, playerIds: string[]): Promise<string[]> {
  const rows = await many<{ user_id: string }>(
    db,
    `SELECT user_id FROM players WHERE id = ANY($1) AND user_id IS NOT NULL
     UNION
     SELECT g.user_id FROM player_guardians pg JOIN guardians g ON g.id = pg.guardian_id
      WHERE pg.player_id = ANY($1) AND g.user_id IS NOT NULL`,
    [playerIds],
  );
  return rows.map((r) => r.user_id);
}

export async function guardianUsers(db: Db, playerId: string): Promise<string[]> {
  const rows = await many<{ user_id: string }>(
    db,
    `SELECT g.user_id FROM player_guardians pg JOIN guardians g ON g.id = pg.guardian_id
      WHERE pg.player_id = $1 AND g.user_id IS NOT NULL`,
    [playerId],
  );
  return rows.map((r) => r.user_id);
}

export async function sessionCoachUsers(db: Db, sessionId: string): Promise<string[]> {
  const rows = await many<{ user_id: string }>(
    db,
    `SELECT c.user_id FROM session_coaches sc JOIN coaches c ON c.id = sc.coach_id
      WHERE sc.session_id = $1 AND sc.active AND c.user_id IS NOT NULL`,
    [sessionId],
  );
  return rows.map((r) => r.user_id);
}

export async function adminUsers(db: Db): Promise<string[]> {
  const rows = await many<{ id: string }>(db, `SELECT id FROM users WHERE role = 'admin' AND status = 'active'`);
  return rows.map((r) => r.id);
}
