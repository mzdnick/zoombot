import { describe, expect, it } from 'vitest';
import {
  PRIORITY_EMOJIS,
  PRIORITY_TAG_NAMES,
  priorityFromTags,
  priorityFromTitle,
  setPriorityInTitle,
  stripPriorityEmoji,
} from './priority.js';
import { splitReportTitle, truncateTitle } from './title-sync.js';

describe('priorityFromTags', () => {
  it('reads the priority tag', () => {
    expect(priorityFromTags(['Priority 2', 'BUG'])).toBe(2);
  });

  it('ignores lookalike tags — anchored regex plus level membership', () => {
    expect(priorityFromTags(['Assignee Priority 3', 'BUG'])).toBeNull();
    expect(priorityFromTags(['Priority 9'])).toBeNull();
    expect(priorityFromTags(['Priority 3 - urgent'])).toBeNull();
  });

  it('returns null without priority tags', () => {
    expect(priorityFromTags(['BUG', 'OPEN'])).toBeNull();
  });
});

describe('truncateTitle', () => {
  it('never splits a surrogate pair', () => {
    const long = '🟠 3️⃣ aaaa…😀'.repeat(20);
    const out = truncateTitle(long, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('…')).toBe(true);
    const beforeEllipsis = out.charCodeAt(out.length - 2);
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
  });

  it('leaves short strings untouched', () => {
    expect(truncateTitle('short', 100)).toBe('short');
  });
});

describe('priorityFromTitle', () => {
  it('reads the emoji after the status emoji', () => {
    expect(priorityFromTitle('🟠 3️⃣ Bug Report - Crash (123)')).toBe(3);
    expect(priorityFromTitle('🔴 0️⃣ Bug Report - Crash')).toBe(0);
    expect(priorityFromTitle('🟠 5️⃣ Bug Report - Crash')).toBe(5);
  });

  it('returns null for unprioritized or bare titles', () => {
    expect(priorityFromTitle('🟠 Bug Report - Crash')).toBeNull();
    expect(priorityFromTitle('Plain title')).toBeNull();
  });
});

describe('stripPriorityEmoji', () => {
  it('removes the priority token and keeps the rest', () => {
    expect(stripPriorityEmoji('🟠 3️⃣ Bug Report - Crash (1)')).toBe('🟠 Bug Report - Crash (1)');
    expect(stripPriorityEmoji('🟠 3️⃣')).toBe('🟠');
  });

  it('leaves titles without priority untouched', () => {
    expect(stripPriorityEmoji('🟠 Bug Report - Crash')).toBe('🟠 Bug Report - Crash');
  });
});

describe('setPriorityInTitle', () => {
  it('inserts the priority emoji right of the status emoji', () => {
    expect(setPriorityInTitle('🟠 Bug Report - Crash', 3)).toBe('🟠 3️⃣ Bug Report - Crash');
  });

  it('replaces an existing priority', () => {
    expect(setPriorityInTitle('🟠 3️⃣ Bug Report - Crash', 0)).toBe('🟠 0️⃣ Bug Report - Crash');
  });

  it('removes the priority with null', () => {
    expect(setPriorityInTitle('🟠 3️⃣ Bug Report - Crash (42)', null)).toBe('🟠 Bug Report - Crash (42)');
    expect(setPriorityInTitle('🟠 Bug Report - Crash', null)).toBe('🟠 Bug Report - Crash');
  });

  it('round-trips for every level', () => {
    for (const p of [0, 1, 2, 3, 4, 5]) {
      const named = setPriorityInTitle('🔴 Bug Report - X', p);
      expect(named).toBe(`🔴 ${PRIORITY_EMOJIS[p]} Bug Report - X`);
      expect(priorityFromTitle(named)).toBe(p);
    }
  });
});

describe('splitReportTitle with priority', () => {
  it('keeps the priority emoji in the prefix', () => {
    expect(splitReportTitle('🟠 3️⃣ Bug Report - Crash (123)', '123')).toEqual({
      prefix: '🟠 3️⃣ Bug Report - ',
      title: 'Crash',
      suffix: ' (123)',
    });
  });

  it('keeps the priority emoji in the prefix without a label', () => {
    expect(splitReportTitle('🟠 1️⃣ Old title (99)', '99')).toEqual({
      prefix: '🟠 1️⃣ ',
      title: 'Old title',
      suffix: ' (99)',
    });
  });
});

describe('PRIORITY_TAG_NAMES', () => {
  it('covers levels 0-5', () => {
    expect(PRIORITY_TAG_NAMES).toEqual(['Priority 0', 'Priority 1', 'Priority 2', 'Priority 3', 'Priority 4', 'Priority 5']);
  });
});
