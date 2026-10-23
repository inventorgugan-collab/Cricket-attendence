import { z } from 'zod';
import { Db, one } from '../db.js';

// Academy policy. Every rule the brief marks as "configurable" lives here, with
// conservative defaults until the academy confirms its real policy.
export const policySchema = z.object({
  booking: z.object({
    // Session types whose requests always need coach/admin review.
    approvalRequired: z.object({ group: z.boolean(), one_on_one: z.boolean(), one_on_two: z.boolean() }),
    minNoticeHours: z.number().min(0),
    maxAdvanceDays: z.number().int().min(1),
    // Auto-confirm only if the player has an active package with unreserved credits.
    requireCreditsForAutoConfirm: z.boolean(),
    // A booking a minor requests for themself waits for a linked guardian.
    guardianApprovalForMinorRequests: z.boolean(),
    waitlistEnabled: z.boolean(),
    // Players/guardians can cancel a confirmed booking up to this many hours before start.
    selfCancelCutoffHours: z.number().min(0),
  }),
  attendance: z.object({
    // How long after a session ends a coach may still correct their own marks.
    coachCorrectionWindowHours: z.number().min(0),
    // How early before the start a coach may begin marking.
    markEarlyMinutes: z.number().min(0),
    allowWalkIns: z.boolean(),
  }),
  credits: z.object({
    deductOn: z.object({ present: z.boolean(), late: z.boolean(), absent: z.boolean(), excused: z.boolean() }),
    makeupSessionsDeduct: z.boolean(),
    interruptedSessionsDeduct: z.boolean(),
    // Coaches and admins are told when a package part gets down to this many sessions.
    lowBalanceThreshold: z.number().int().min(0),
  }),
  // Sessions players and parents ask for at a time of their choosing.
  requests: z.object({
    // Hours used for coaches who have no weekly availability set.
    openFrom: z.string().regex(/^\d{2}:\d{2}$/),
    openUntil: z.string().regex(/^\d{2}:\d{2}$/),
    slotStepMinutes: z.number().int().min(15).max(120),
  }),
  sessions: z.object({ coachesCanCreate: z.boolean() }),
  reports: z.object({ inactiveAfterDays: z.number().int().min(1), developmentReviewEveryDays: z.number().int().min(1) }),
});

export type Policy = z.infer<typeof policySchema>;

export const defaultPolicy: Policy = {
  booking: {
    approvalRequired: { group: false, one_on_one: true, one_on_two: true },
    minNoticeHours: 2,
    maxAdvanceDays: 30,
    requireCreditsForAutoConfirm: true,
    guardianApprovalForMinorRequests: true,
    waitlistEnabled: true,
    selfCancelCutoffHours: 6,
  },
  attendance: { coachCorrectionWindowHours: 48, markEarlyMinutes: 30, allowWalkIns: true },
  credits: {
    deductOn: { present: true, late: true, absent: false, excused: false },
    makeupSessionsDeduct: false,
    interruptedSessionsDeduct: false,
    lowBalanceThreshold: 2,
  },
  requests: { openFrom: '06:00', openUntil: '20:00', slotStepMinutes: 30 },
  sessions: { coachesCanCreate: true },
  reports: { inactiveAfterDays: 14, developmentReviewEveryDays: 60 },
};

function merge(base: any, patch: any): any {
  if (typeof base !== 'object' || base === null || typeof patch !== 'object' || patch === null) return patch ?? base;
  const out: any = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

export async function getPolicy(db: Db): Promise<Policy> {
  const row = await one(db, "SELECT value FROM academy_settings WHERE key = 'policy'");
  return policySchema.parse(merge(defaultPolicy, row?.value ?? {}));
}

export function mergePolicy(current: Policy, patch: unknown): Policy {
  return policySchema.parse(merge(current, patch));
}
