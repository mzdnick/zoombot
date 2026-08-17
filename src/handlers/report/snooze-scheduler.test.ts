import { describe, expect, it, vi } from 'vitest';

// snooze-scheduler imports title-sync (→ sqlite store + pino logger); stub both.
vi.mock('../../store.js', () => ({
  createStore: () => ({ get: async () => undefined, set: async () => {}, delete: async () => {} }),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));

import { wakesField, snoozeDurationMs, SNOOZE_DURATIONS, DEFAULT_SNOOZE, SNOOZE_EMOJI } from './snooze-scheduler.js';

describe('SNOOZE_EMOJI', () => {
  it('is the snoozed status emoji (a single leading-title marker)', () => {
    expect(typeof SNOOZE_EMOJI).toBe('string');
    expect(SNOOZE_EMOJI.length).toBeGreaterThan(0);
  });
});

describe('wakesField', () => {
  it('renders a relative Discord timestamp in seconds for the wake time', () => {
    expect(wakesField(1782112020000).value).toBe('⏰ Wakes <t:1782112020:R>');
  });
});

describe('snoozeDurationMs', () => {
  it('returns the configured ms for known durations', () => {
    expect(snoozeDurationMs('1d')).toBe(SNOOZE_DURATIONS['1d']);
    expect(snoozeDurationMs('3d')).toBe(SNOOZE_DURATIONS['3d']);
    expect(snoozeDurationMs('1w')).toBe(SNOOZE_DURATIONS['1w']);
  });

  it('falls back to the default for unknown values', () => {
    expect(snoozeDurationMs('nope')).toBe(SNOOZE_DURATIONS[DEFAULT_SNOOZE]);
    expect(snoozeDurationMs('')).toBe(SNOOZE_DURATIONS[DEFAULT_SNOOZE]);
  });

  it('uses sane day/week multiples', () => {
    expect(SNOOZE_DURATIONS['1d']).toBe(24 * 60 * 60 * 1000);
    expect(SNOOZE_DURATIONS['3d']).toBe(3 * 24 * 60 * 60 * 1000);
    expect(SNOOZE_DURATIONS['1w']).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
