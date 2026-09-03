import { describe, it, expect, vi, beforeEach } from 'vitest';

const backing = new Map<string, unknown>();

vi.mock('../../store.js', () => ({
  createStore: () => ({
    get: vi.fn(async (key: string) => backing.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      backing.set(key, value);
      return true;
    }),
    delete: vi.fn(async (key: string) => backing.delete(key)),
  }),
}));

import { dormantBumpedAt, snoozeAdjustedWake, getFreeze, saveFreeze, patchFreeze, clearFreeze, type FreezeRecord } from './freeze-state.js';

const DAY = 24 * 60 * 60 * 1000;
const DORMANT_MS = 14 * DAY;

describe('freeze record helpers', () => {
  const record: FreezeRecord = {
    startedAt: 1,
    expiresAt: null,
    message: 'msg',
    initiatedBy: 'admin',
    priorSendMessages: null,
    priorSendMessagesInThreads: null,
    overwriteCaptured: false,
    bannerMessageId: null,
    steps: { overwrite: false, buttons: false, locks: false, banner: false },
  };

  beforeEach(() => backing.clear());

  it('round-trips a saved record', async () => {
    await saveFreeze(record);
    expect(await getFreeze()).toEqual(record);
  });

  it('patches fields without dropping the rest', async () => {
    await saveFreeze(record);
    const patched = await patchFreeze({ bannerMessageId: 'm1', steps: { ...record.steps, banner: true } });
    expect(patched?.bannerMessageId).toBe('m1');
    expect(patched?.steps.banner).toBe(true);
    expect(patched?.message).toBe('msg');
  });

  it('patch is a no-op with no stored record', async () => {
    expect(await patchFreeze({ message: 'x' })).toBeNull();
  });

  it('clears the record', async () => {
    await saveFreeze(record);
    await clearFreeze();
    expect(await getFreeze()).toBeNull();
  });
});

describe('dormantBumpedAt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-06-15T00:00:00Z').getTime());
  });

  it('shifts activity by the freeze duration', () => {
    const freeze = { startedAt: Date.now() - 2 * DAY, endedAt: Date.now() };
    expect(dormantBumpedAt(Date.now() - 10 * DAY, freeze, DORMANT_MS)).toBe(Date.now() - 8 * DAY);
  });

  it('caps the bump at one dormancy window', () => {
    const freeze = { startedAt: Date.now() - 30 * DAY, endedAt: Date.now() };
    expect(dormantBumpedAt(Date.now() - 20 * DAY, freeze, DORMANT_MS)).toBe(Date.now() - 6 * DAY);
  });

  it('never bumps activity into the future', () => {
    const freeze = { startedAt: Date.now() - DAY, endedAt: Date.now() };
    expect(dormantBumpedAt(Date.now() - DAY / 2, freeze, DORMANT_MS)).toBeLessThanOrEqual(Date.now());
  });
});

describe('snoozeAdjustedWake', () => {
  it('preserves remaining snooze time across the freeze', () => {
    const scheduledAt = 0;
    const wakeAt = 5 * DAY;
    const freeze = { startedAt: 3 * DAY, endedAt: 6 * DAY };
    // 2d remained at freeze start; 3d freeze -> wake 2d after thaw.
    expect(snoozeAdjustedWake(wakeAt, scheduledAt, freeze)).toBe(8 * DAY);
  });

  it('caps the extension at the original snooze duration', () => {
    const scheduledAt = 0;
    const wakeAt = 2 * DAY; // 1d snooze
    const freeze = { startedAt: 1 * DAY, endedAt: 10 * DAY };
    expect(snoozeAdjustedWake(wakeAt, scheduledAt, freeze)).toBe(4 * DAY);
  });

  it('falls back to remaining time when scheduledAt is unknown', () => {
    const wakeAt = 5 * DAY;
    const freeze = { startedAt: 3 * DAY, endedAt: 6 * DAY };
    expect(snoozeAdjustedWake(wakeAt, undefined, freeze)).toBe(7 * DAY);
  });
});
