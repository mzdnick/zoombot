import { describe, expect, it } from 'vitest';
import {
  CATEGORY_ORDER,
  extractTicketId,
  paginateReports,
  PAGE_SIZE,
  reportCategory,
  sortReports,
  type ReportSummary,
} from './my-reports.js';

function summary(overrides: Partial<ReportSummary>): ReportSummary {
  return {
    threadId: '100000000000009',
    threadName: 'Bug: something broke (9)',
    url: 'https://discord.com/channels/1/2/3',
    tagNames: [],
    createdTimestamp: 0,
    archived: false,
    ...overrides,
  };
}

describe('reportCategory', () => {
  it('maps waiting-for-user to Needs your Attention', () => {
    expect(reportCategory(['WAITING FOR USER'], false)).toBe('Needs your Attention');
    expect(reportCategory(['open', 'waiting for user'], false)).toBe('Needs your Attention');
  });

  it('folds OPEN and WAITING FOR DEV into Waiting for Dev', () => {
    expect(reportCategory(['OPEN'], false)).toBe('Waiting for Dev');
    expect(reportCategory(['WAITING FOR DEV'], false)).toBe('Waiting for Dev');
    expect(reportCategory(['BUG', 'OPEN'], false)).toBe('Waiting for Dev');
    expect(reportCategory([], false)).toBe('Waiting for Dev');
  });

  it('closed overrides every other tag', () => {
    expect(reportCategory(['CLOSED', 'WAITING FOR USER'], false)).toBe('Closed');
    expect(reportCategory(['FIXED', 'OPEN'], false)).toBe('Closed');
    expect(reportCategory(['closed'], false)).toBe('Closed');
  });

  it('treats archived without SNOOZED as closed, but a snoozed archive stays snoozed', () => {
    expect(reportCategory(['WAITING FOR USER'], true)).toBe('Closed');
    expect(reportCategory([], true)).toBe('Closed');
    expect(reportCategory(['SNOOZED'], true)).toBe('Snoozed');
    expect(reportCategory(['snoozed', 'OPEN'], false)).toBe('Snoozed');
  });
});

describe('sortReports', () => {
  it('orders categories per CATEGORY_ORDER, newest first within each', () => {
    const waitingUserOld = summary({ tagNames: ['WAITING FOR USER'], createdTimestamp: 1 });
    const waitingUserNew = summary({ tagNames: ['WAITING FOR USER'], createdTimestamp: 5 });
    const open = summary({ tagNames: ['OPEN'], createdTimestamp: 9 });
    const snoozed = summary({ tagNames: ['SNOOZED'], createdTimestamp: 50 });
    const closed = summary({ tagNames: ['CLOSED'], createdTimestamp: 99 });
    const archived = summary({ tagNames: ['OPEN'], createdTimestamp: 999, archived: true });
    expect(sortReports([archived, closed, snoozed, open, waitingUserOld, waitingUserNew])).toEqual([
      waitingUserNew,
      waitingUserOld,
      open,
      snoozed,
      archived,
      closed,
    ]);
  });

  it('does not mutate the input array', () => {
    const input = [summary({ tagNames: ['CLOSED'] }), summary({ tagNames: ['OPEN'] })];
    const sorted = sortReports(input);
    expect(sorted[0].tagNames).toEqual(['OPEN']);
    expect(input[0].tagNames).toEqual(['CLOSED']);
  });
});

describe('extractTicketId', () => {
  it('reads the trailing ticket id from a thread name', () => {
    expect(extractTicketId('Bug: launch lag (12345)', '9')).toBe('12345');
  });

  it('falls back to the numeric thread id tail without leading zeros', () => {
    expect(extractTicketId('No ticket suffix', '12345670000123')).toBe('123');
  });
});

describe('paginateReports', () => {
  it('slices pages and clamps out-of-range requests', () => {
    const reports = Array.from({ length: PAGE_SIZE * 2 + 3 }, (_, i) =>
      summary({ threadId: String(i), createdTimestamp: i }));
    const first = paginateReports(reports, 1);
    expect(first.totalPages).toBe(3);
    expect(first.pageItems).toHaveLength(PAGE_SIZE);
    const clamped = paginateReports(reports, 99);
    expect(clamped.page).toBe(3);
    expect(clamped.pageItems).toHaveLength(3);
    expect(paginateReports(reports, 0).page).toBe(1);
  });

  it('returns a single empty page for no reports', () => {
    const result = paginateReports([], 2);
    expect(result.totalPages).toBe(1);
    expect(result.page).toBe(1);
    expect(result.pageItems).toEqual([]);
  });
});

describe('CATEGORY_ORDER', () => {
  it('puts Needs your Attention first and Closed last', () => {
    expect(CATEGORY_ORDER[0]).toBe('Needs your Attention');
    expect(CATEGORY_ORDER[CATEGORY_ORDER.length - 1]).toBe('Closed');
  });
});
