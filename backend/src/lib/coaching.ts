import { config } from '../config.js';
import { Db, many } from '../db.js';
import { conflict } from './errors.js';
import { Policy } from './settings.js';

const TZ = config.timeZone;

export const when = (d: Date | string) => new Date(d).toLocaleString('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const dayOnly = (d: Date | string) => new Date(d).toLocaleDateString('en-IN', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const atMidnight = (d: Date | string) => new Date(d).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }) === '00:00';

/// "Wed, 4 Nov to Fri, 6 Nov" for whole days of leave, times otherwise.
export function leaveSpan(startsAt: Date | string, endsAt: Date | string): string {
  if (atMidnight(startsAt) && atMidnight(endsAt)) {
    const last = new Date(new Date(endsAt).getTime() - 86400_000);
    const a = dayOnly(startsAt);
    const b = dayOnly(last);
    return a === b ? a : `${a} to ${b}`;
  }
  return `${when(startsAt)} to ${when(endsAt)}`;
}

// Refuse to put a coach on a session while they are on leave.
export async function assertNotOnLeave(db: Db, coachIds: string[], startsAt: Date | string, endsAt: Date | string): Promise<void> {
  if (!coachIds.length) return;
  const rows = await many(
    db,
    `SELECT DISTINCT c.full_name FROM coach_leave l JOIN coaches c ON c.id = l.coach_id
      WHERE l.coach_id = ANY($1) AND l.status = 'active' AND l.during && tstzrange($2, $3, '[)')`,
    [coachIds, startsAt, endsAt],
  );
  if (rows.length) throw conflict('coach_on_leave', `${rows.map((r) => r.full_name).join(', ')} ${rows.length === 1 ? 'is' : 'are'} on leave at this time`);
}

export interface CoachState {
  id: string;
  full_name: string;
  user_id: string | null;
  priority: number | null;
  on_leave: boolean;
  busy: boolean;
  outside_hours: boolean;
}

// Where each coach stands for one time slot: on leave, already teaching, or
// outside their usual hours. Coaches with no weekly hours set are treated as
// working the academy's request hours.
export async function coachStates(
  db: Db,
  opts: { coachIds?: string[]; categoryId?: string | null; startsAt: Date | string; endsAt: Date | string; ignoreSessionId?: string | null; policy: Policy },
): Promise<CoachState[]> {
  return many(
    db,
    `SELECT c.id, c.full_name, c.user_id, cc.priority,
            EXISTS (SELECT 1 FROM coach_leave l WHERE l.coach_id = c.id AND l.status = 'active' AND l.during && tstzrange($2, $3, '[)')) AS on_leave,
            EXISTS (SELECT 1 FROM session_coaches sc WHERE sc.coach_id = c.id AND sc.active AND sc.during && tstzrange($2, $3, '[)')
                     AND sc.session_id IS DISTINCT FROM $5) AS busy,
            CASE WHEN EXISTS (SELECT 1 FROM coach_availability a WHERE a.coach_id = c.id)
              THEN NOT EXISTS (SELECT 1 FROM coach_availability a
                                WHERE a.coach_id = c.id
                                  AND a.weekday = extract(isodow FROM $2::timestamptz AT TIME ZONE $4)
                                  AND a.start_time <= ($2::timestamptz AT TIME ZONE $4)::time
                                  AND a.end_time >= ($3::timestamptz AT TIME ZONE $4)::time
                                  AND ($2::timestamptz AT TIME ZONE $4)::date = ($3::timestamptz AT TIME ZONE $4)::date)
              ELSE ($2::timestamptz AT TIME ZONE $4)::time < $7::time OR ($3::timestamptz AT TIME ZONE $4)::time > $8::time
                   OR ($2::timestamptz AT TIME ZONE $4)::date <> ($3::timestamptz AT TIME ZONE $4)::date
            END AS outside_hours
       FROM coaches c
       LEFT JOIN category_coaches cc ON cc.coach_id = c.id AND cc.category_id = $6
      WHERE c.status = 'active' AND ($1::uuid[] IS NULL OR c.id = ANY($1))
      ORDER BY cc.priority NULLS LAST, c.full_name`,
    [opts.coachIds ?? null, opts.startsAt, opts.endsAt, TZ, opts.ignoreSessionId ?? null, opts.categoryId ?? null, opts.policy.requests.openFrom, opts.policy.requests.openUntil],
  );
}

export const isFree = (c: CoachState) => !c.on_leave && !c.busy && !c.outside_hours;

// The coaches who take a category, in the order they are offered work.
export async function categoryCoachIds(db: Db, categoryId: string): Promise<string[]> {
  const rows = await many(
    db,
    `SELECT cc.coach_id FROM category_coaches cc JOIN coaches c ON c.id = cc.coach_id
      WHERE cc.category_id = $1 AND c.status = 'active' ORDER BY cc.priority`,
    [categoryId],
  );
  return rows.map((r) => r.coach_id);
}
