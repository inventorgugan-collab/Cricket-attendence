export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Not signed in') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do this') => new AppError(403, 'forbidden', message);
export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);

// Translate database constraint violations into messages a person can act on.
export function fromPgError(err: any): AppError | undefined {
  if (!err || typeof err.code !== 'string') return undefined;
  if (err.code === '23P01') {
    const map: Record<string, [string, string]> = {
      sessions_no_area_overlap: ['area_double_booked', 'That training area is already booked at this time'],
      session_coaches_no_overlap: ['coach_double_booked', 'That coach already has a session at this time'],
      bookings_no_player_overlap: ['player_double_booked', 'The player already has a confirmed session at this time'],
    };
    const hit = map[err.constraint as string];
    if (hit) return conflict(hit[0], hit[1]);
    return conflict('overlap', 'This overlaps with an existing booking');
  }
  if (err.code === 'P0001' && err.hint === 'capacity') return conflict('session_full', 'This session is already full');
  if (err.code === '23505') {
    if (err.constraint === 'bookings_one_live') return conflict('already_booked', 'The player already has a booking for this session');
    if (err.constraint === 'users_login_key') return conflict('login_taken', 'That login is already in use');
    return conflict('duplicate', 'This record already exists');
  }
  if (err.code === '23503') return badRequest('A referenced record does not exist');
  if (err.code === '23514') return badRequest('The values break a data rule', err.constraint);
  if (err.code === '22P02') return badRequest('Invalid identifier or value');
  return undefined;
}
