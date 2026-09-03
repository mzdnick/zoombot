import { readConfigKey, writeConfigKey, deleteConfigKey } from '../../runtime-config.js';

const FREEZE_KEY = 'freeze';

export interface FreezeRecord {
  startedAt: number;
  expiresAt: number | null;
  message: string;
  initiatedBy: string;
  /** @everyone SendMessages (create posts) before the freeze: true=allow, false=deny, null=neutral. */
  priorSendMessages?: boolean | null;
  /** @everyone SendMessagesInThreads (send messages in posts) before the freeze: true=allow, false=deny, null=neutral. */
  priorSendMessagesInThreads?: boolean | null;
  /** Distinguishes "not captured yet" from a captured null (neutral). */
  overwriteCaptured?: boolean;
  /** Set before the first revert step; boot resumes an interrupted thaw. */
  thawing?: boolean;
  bannerMessageId: string | null;
  steps: { overwrite: boolean; buttons: boolean; locks: boolean; banner: boolean };
}

export const DEFAULT_FREEZE_MESSAGE = 'No new reports for developer rest. Come back later.';

export async function getFreeze(): Promise<FreezeRecord | null> {
  return (await readConfigKey<FreezeRecord>(FREEZE_KEY)) ?? null;
}

export async function isFrozen(): Promise<boolean> {
  return (await getFreeze()) !== null;
}

export async function saveFreeze(record: FreezeRecord): Promise<void> {
  await writeConfigKey(FREEZE_KEY, record);
}

export async function patchFreeze(patch: Partial<FreezeRecord>): Promise<FreezeRecord | null> {
  const current = await getFreeze();
  if (!current) return null;
  const next = { ...current, ...patch };
  await saveFreeze(next);
  return next;
}

export async function clearFreeze(): Promise<void> {
  await deleteConfigKey(FREEZE_KEY);
}

// Freeze time doesn't count toward dormancy, capped at one dormancy window.
export function dormantBumpedAt(lastActivityAt: number, freeze: { startedAt: number; endedAt: number }, dormantMs: number): number {
  const bump = Math.min(freeze.endedAt - freeze.startedAt, dormantMs);
  return Math.min(Date.now(), lastActivityAt + bump);
}

// Preserves the snooze's remaining time, capped at its original duration.
export function snoozeAdjustedWake(wakeAt: number, scheduledAt: number | undefined, freeze: { startedAt: number; endedAt: number }): number {
  const duration = scheduledAt !== undefined ? wakeAt - scheduledAt : Math.max(0, wakeAt - freeze.startedAt);
  const bump = Math.min(freeze.endedAt - freeze.startedAt, Math.max(0, duration));
  return wakeAt + bump;
}
