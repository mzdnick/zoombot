import { describe, expect, it, vi } from 'vitest';

// title-sync opens the sqlite store + pino logger at import; stub both.
vi.mock('../../store.js', () => ({
  createStore: () => ({ get: async () => undefined, set: async () => {}, delete: async () => {} }),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));

import {
  computeStatusTitle,
  isRateLimit,
  retryDelay,
  splitReportTitle,
  composeReportTitle,
  maxRenameLength,
} from './title-sync.js';

const FALLBACK_RETRY_MS = 10 * 60 * 1000;

describe('retryDelay', () => {
  it('prefers retryAfter/sublimitTimeout over the shorter timeToReset', () => {
    expect(retryDelay({ timeToReset: 15_100, retryAfter: 323_050, sublimitTimeout: 323_050 }))
      .toBe(323_050 + 1_000);
  });

  it('falls back to timeToReset when no sublimit wait is present', () => {
    expect(retryDelay({ timeToReset: 15_100 })).toBe(15_100 + 1_000);
  });

  it('uses the fallback when no rate-limit timing is present', () => {
    expect(retryDelay({})).toBe(FALLBACK_RETRY_MS);
    expect(retryDelay(new Error('boom'))).toBe(FALLBACK_RETRY_MS);
  });
});

describe('isRateLimit', () => {
  it('is true only for objects carrying a numeric timeToReset', () => {
    expect(isRateLimit({ timeToReset: 5 })).toBe(true);
    expect(isRateLimit({})).toBe(false);
    expect(isRateLimit(new Error('nope'))).toBe(false);
    expect(isRateLimit(null)).toBe(false);
  });
});

describe('computeStatusTitle', () => {
  it('swaps the status emoji and adds the ticket id when absent', () => {
    expect(computeStatusTitle('🟠 Bug - Map Glitch', 'waiting-for-dev', '123'))
      .toBe('🔴 Bug - Map Glitch (123)');
  });

  it('does not duplicate the ticket id when already present', () => {
    expect(computeStatusTitle('🔴 Bug - Map Glitch (123)', 'waiting-for-user', '123'))
      .toBe('🟣 Bug - Map Glitch (123)');
  });

  it('truncates so the title stays within Discord\'s 100-char limit', () => {
    const long = '🟠 Bug - ' + 'x'.repeat(120);
    const out = computeStatusTitle(long, 'closed', '999');
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith(' (999)')).toBe(true);
    expect(out.startsWith('🔵 ')).toBe(true);
  });
});

describe('splitReportTitle', () => {
  it('locks the emoji, label and ticket id, leaving the title editable', () => {
    expect(splitReportTitle('🔴 Bug Report - Aggressive Accel (1234567)', '1234567')).toEqual({
      prefix: '🔴 Bug Report - ',
      title: 'Aggressive Accel',
      suffix: ' (1234567)',
    });
  });

  it('synthesizes the ticket id suffix when the name has none yet', () => {
    expect(splitReportTitle('🟠 Feature Request - Add Dark Mode', '42')).toEqual({
      prefix: '🟠 Feature Request - ',
      title: 'Add Dark Mode',
      suffix: ' (42)',
    });
  });

  it('keeps every leading segment of a split thread out of the editable title', () => {
    expect(splitReportTitle('✂️ Split - 🟠 Bug Report - Foo (99)', '99')).toEqual({
      prefix: '✂️ Split - 🟠 Bug Report - ',
      title: 'Foo',
      suffix: ' (99)',
    });
  });

  it('falls back to the leading emoji for unlabeled legacy names', () => {
    expect(splitReportTitle('🟠 Some old title (99)', '99')).toEqual({
      prefix: '🟠 ',
      title: 'Some old title',
      suffix: ' (99)',
    });
  });

  it('never invents an emoji that is not already there', () => {
    expect(splitReportTitle('Plain name', '7')).toEqual({
      prefix: '',
      title: 'Plain name',
      suffix: ' (7)',
    });
  });

  it('locks only the first label when the title itself contains one', () => {
    expect(splitReportTitle('🔴 Bug Report - Bug Report - button is broken (123)', '123')).toEqual({
      prefix: '🔴 Bug Report - ',
      title: 'Bug Report - button is broken',
      suffix: ' (123)',
    });
  });

  it('keeps trailing parenthesized digits that are not the ticket id', () => {
    expect(splitReportTitle('🟠 Bug Report - Save corruption on build (2024)', '555')).toEqual({
      prefix: '🟠 Bug Report - ',
      title: 'Save corruption on build (2024)',
      suffix: ' (555)',
    });
  });

  it('round-trips a name through split and compose unchanged', () => {
    for (const name of [
      '🔴 Bug Report - Aggressive Accel (1234567)',
      '✂️ Split - 🟠 Bug Report - Foo (99)',
      '🟣 Feedback - Bug Report - nested label (42)',
      '🟠 Some old title (99)',
      'Plain name (7)',
    ]) {
      const ticketId = name.match(/\((\d+)\)\s*$/)![1];
      const parts = splitReportTitle(name, ticketId);
      expect(composeReportTitle(parts, parts.title)).toBe(name);
    }
  });
});

describe('maxRenameLength', () => {
  it('is what remains of the 100-char budget after the locked parts', () => {
    const parts = splitReportTitle('🔴 Bug Report - Aggressive Accel (1234567)', '1234567');
    expect(maxRenameLength(parts)).toBe(100 - parts.prefix.length - parts.suffix.length);
  });

  it('never drops below 1', () => {
    const parts = { prefix: 'x'.repeat(120), title: '', suffix: ' (1)' };
    expect(maxRenameLength(parts)).toBe(1);
  });
});

describe('composeReportTitle', () => {
  it('reassembles around the locked prefix and suffix', () => {
    const parts = splitReportTitle('🔴 Bug Report - Aggressive Accel (1234567)', '1234567');
    expect(composeReportTitle(parts, '  Lead Braking Too Late  '))
      .toBe('🔴 Bug Report - Lead Braking Too Late (1234567)');
  });

  it('truncates an over-long title while keeping the ticket id', () => {
    const parts = splitReportTitle('🔴 Bug Report - Short (1234567)', '1234567');
    const out = composeReportTitle(parts, 'y'.repeat(200));
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.startsWith('🔴 Bug Report - ')).toBe(true);
    expect(out.endsWith('… (1234567)')).toBe(true);
  });
});
