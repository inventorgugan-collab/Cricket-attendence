import { Db, one } from '../db.js';
import { Actor, Role } from './actor.js';
import { forbidden } from './errors.js';

// All permission checks run on the server. The app hides controls too, but
// that is a convenience, never the protection.

export function requireRole(actor: Actor, ...roles: Role[]): void {
  if (!roles.includes(actor.role)) throw forbidden();
}

export async function isGuardianOf(db: Db, actor: Actor, playerId: string, opts: { canBook?: boolean } = {}): Promise<boolean> {
  if (actor.role !== 'guardian' || !actor.profileId) return false;
  const row = await one(
    db,
    `SELECT can_book FROM player_guardians WHERE guardian_id = $1 AND player_id = $2`,
    [actor.profileId, playerId],
  );
  return !!row && (!opts.canBook || row.can_book);
}

// A coach can see a player they are assigned to, who is in a group they coach,
// or who is booked into one of their sessions (recent or upcoming).
export async function coachCanSeePlayer(db: Db, coachId: string, playerId: string): Promise<boolean> {
  const row = await one(
    db,
    `SELECT EXISTS (SELECT 1 FROM player_coaches WHERE coach_id = $1 AND player_id = $2)
         OR EXISTS (SELECT 1 FROM group_coaches gc JOIN group_members gm ON gm.group_id = gc.group_id
                     WHERE gc.coach_id = $1 AND gm.player_id = $2)
         OR EXISTS (SELECT 1 FROM bookings b JOIN session_coaches sc ON sc.session_id = b.session_id
                     WHERE sc.coach_id = $1 AND sc.active AND b.player_id = $2
                       AND upper(b.during) > now() - interval '90 days') AS ok`,
    [coachId, playerId],
  );
  return !!row?.ok;
}

export type PlayerAccess = 'full' | 'self' | 'guardian' | 'coach';

export async function playerAccess(db: Db, actor: Actor, playerId: string): Promise<PlayerAccess | null> {
  switch (actor.role) {
    case 'admin':
      return 'full';
    case 'player':
      return actor.profileId === playerId ? 'self' : null;
    case 'guardian':
      return (await isGuardianOf(db, actor, playerId)) ? 'guardian' : null;
    case 'coach':
      return actor.profileId && (await coachCanSeePlayer(db, actor.profileId, playerId)) ? 'coach' : null;
  }
}

export async function requirePlayerAccess(db: Db, actor: Actor, playerId: string): Promise<PlayerAccess> {
  const access = await playerAccess(db, actor, playerId);
  if (!access) throw forbidden('You do not have access to this player');
  return access;
}

export async function isSessionCoach(db: Db, actor: Actor, sessionId: string): Promise<boolean> {
  if (actor.role !== 'coach' || !actor.profileId) return false;
  const row = await one(db, `SELECT 1 FROM session_coaches WHERE session_id = $1 AND coach_id = $2 AND active`, [sessionId, actor.profileId]);
  return !!row;
}

export async function requireSessionStaff(db: Db, actor: Actor, sessionId: string): Promise<void> {
  if (actor.role === 'admin') return;
  if (!(await isSessionCoach(db, actor, sessionId))) throw forbidden('Only the session coach or an admin can do this');
}
