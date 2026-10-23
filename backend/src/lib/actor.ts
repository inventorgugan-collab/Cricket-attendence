export type Role = 'admin' | 'coach' | 'player' | 'guardian';

export interface Actor {
  userId: string;
  role: Role;
  displayName: string;
  // The profile row for this account: players.id, coaches.id or guardians.id.
  profileId: string | null;
}
