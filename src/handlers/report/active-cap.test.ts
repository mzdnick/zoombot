import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const make = () => {
    const m = new Map<string, unknown>();
    return { get: async (k: string) => m.get(k), set: async (k: string, v: unknown) => { m.set(k, v); }, delete: async (k: string) => m.delete(k), clear: () => m.clear() };
  };
  const namespaces: Record<string, ReturnType<typeof make>> = {
    reports: make(),
    'user-reports': make(),
    'report-index': make(),
  };
  return { namespaces, make };
});
vi.mock('../../store.js', () => ({
  createStore: (name: string) => h.namespaces[name] ?? h.make(),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));
const conf = vi.hoisted(() => ({ maxActiveReports: 2 }));
vi.mock('../../config.js', () => ({ loadConfig: () => conf }));

import { StoredReport, type StoredReportData } from './report-store.js';
import { checkActiveCap } from './active-cap.js';

function data(overrides: Partial<StoredReportData>): StoredReportData {
  return {
    threadId: '100000000000001',
    ticketId: '1',
    reporterId: 'user-1',
    label: 'Bug Report',
    threadName: '🟠 Bug Report - thing (1)',
    url: 'https://discord.com/channels/1/2/3',
    tagNames: ['OPEN', 'BUG'],
    createdTimestamp: 1000,
    lastActivityAt: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  for (const ns of Object.values(h.namespaces)) ns.clear();
  conf.maxActiveReports = 2;
});

describe('checkActiveCap', () => {
  it('allows submissions while under the limit', async () => {
    await StoredReport.record(data({}));
    const verdict = await checkActiveCap('user-1');
    expect(verdict.allowed).toBe(true);
  });

  it('blocks at the limit and lists the active reports', async () => {
    await StoredReport.record(data({ threadId: 'a', tagNames: ['OPEN'] }));
    await StoredReport.record(data({ threadId: 'b', tagNames: ['WAITING FOR USER'] }));
    const verdict = await checkActiveCap('user-1');
    expect(verdict.allowed).toBe(false);
    expect(verdict.active.map(r => r.threadId).sort()).toEqual(['a', 'b']);
  });

  it('frees the cap once a deleted thread is forgotten', async () => {
    await StoredReport.record(data({ threadId: 'ghost', tagNames: ['OPEN'] }));
    await StoredReport.record(data({ threadId: 'live', tagNames: ['WAITING FOR USER'] }));
    await StoredReport.forget('ghost');
    const verdict = await checkActiveCap('user-1');
    expect(verdict.allowed).toBe(true);
    expect(verdict.active.map(r => r.threadId)).toEqual(['live']);
  });

  it('a limit of 0 disables the cap entirely', async () => {
    conf.maxActiveReports = 0;
    await StoredReport.record(data({ threadId: 'a', tagNames: ['OPEN'] }));
    await StoredReport.record(data({ threadId: 'b', tagNames: ['OPEN'] }));
    expect((await checkActiveCap('user-1')).allowed).toBe(true);
  });
});
