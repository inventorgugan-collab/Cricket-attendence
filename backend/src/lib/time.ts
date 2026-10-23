import { config } from '../config.js';

// 'YYYY-MM-DD' for an instant, in the academy's time zone.
export function localDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

export function ageOn(dateOfBirth: string, on: string = localDate()): number {
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [y, m, d] = on.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

export const ADULT_AGE = 18;
