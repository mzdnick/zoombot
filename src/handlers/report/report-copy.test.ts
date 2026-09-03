import { describe, expect, it, vi } from 'vitest';

// labelForThread hits the sqlite store; stub it per-namespace.
const h = vi.hoisted(() => {
  const make = () => {
    const m = new Map<string, unknown>();
    return { get: async (k: string) => m.get(k), set: async (k: string, v: unknown) => { m.set(k, v); }, delete: async (k: string) => m.delete(k), clear: () => m.clear() };
  };
  return { ns: { reports: make(), 'user-reports': make(), 'report-index': make() }, make };
});
vi.mock('../../store.js', () => ({
  createStore: (name: string) => h.ns[name] ?? h.make(),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));

import { fixedButtonLabel, fixedModalTitle, labelForThread, reportNoun } from './report-copy.js';
import { StoredReport } from './report-store.js';

describe('report-copy', () => {
  it('reportNoun phrases each label for sentences', () => {
    expect(reportNoun('Bug Report')).toBe('bug report');
    expect(reportNoun('Feature Request')).toBe('feature request');
    expect(reportNoun('Feedback')).toBe('feedback');
    expect(reportNoun('Split')).toBe('report');
  });

  it('fixedButtonLabel matches the report type', () => {
    expect(fixedButtonLabel('Bug Report')).toBe('My Issue is Fixed');
    expect(fixedButtonLabel('Feature Request')).toBe('My Request is Fulfilled');
    expect(fixedButtonLabel('Feedback')).toBe('My Feedback is Addressed');
    expect(fixedButtonLabel('Report')).toBe('My Report is Resolved');
  });

  it('fixedModalTitle matches the report type', () => {
    expect(fixedModalTitle('Bug Report')).toBe('Confirm - Issue Resolved?');
    expect(fixedModalTitle('Feature Request')).toBe('Confirm - Request Fulfilled?');
    expect(fixedModalTitle('Feedback')).toBe('Confirm - Feedback Addressed?');
  });

  it('labelForThread prefers the store, falls back to the title', async () => {
    await StoredReport.record({
      threadId: 't1', ticketId: '1', reporterId: 'u', label: 'Feature Request',
      threadName: 'x', url: 'u', tagNames: [], createdTimestamp: 0, lastActivityAt: 0,
    });
    expect(await labelForThread('t1')).toBe('Feature Request');
    // Unstored thread whose title still carries the label prefix.
    expect(await labelForThread('t2', '🟣 Feature Request - thing (2)')).toBe('Feature Request');
    expect(await labelForThread('t3', 'no label here')).toBe('Report');
  });
});
