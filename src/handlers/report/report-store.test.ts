import { beforeEach, describe, expect, it, vi } from 'vitest';

// report-store persists through the sqlite-backed store; stub it with
// per-namespace Maps (and expose them for assertions).
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

import { StoredReport, type StoredReportData } from './report-store.js';

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

describe('StoredReport', () => {
  beforeEach(() => {
    for (const ns of Object.values(h.namespaces)) ns.clear();
  });

  it('records and looks up by thread id and user id', async () => {
    await StoredReport.record(data({}));
    expect((await StoredReport.get('100000000000001'))?.reporterId).toBe('user-1');
    const mine = await StoredReport.forUser('user-1');
    expect(mine.map(r => r.threadId)).toEqual(['100000000000001']);
    expect(await StoredReport.forUser('user-2')).toEqual([]);
  });

  it('counts open and waiting-for-user reports as active, closed ones not', async () => {
    await StoredReport.record(data({ threadId: 'a', tagNames: ['OPEN'] }));
    await StoredReport.record(data({ threadId: 'b', tagNames: ['WAITING FOR USER'] }));
    await StoredReport.record(data({ threadId: 'c', tagNames: ['CLOSED'] }));
    await StoredReport.record(data({ threadId: 'd', tagNames: ['FIXED'] }));
    const active = await StoredReport.activeForUser('user-1');
    expect(active.map(r => r.threadId).sort()).toEqual(['a', 'b']);
  });

  it('excludes snoozed reports from the active count (they reopen later)', async () => {
    await StoredReport.record(data({ threadId: 's', tagNames: ['SNOOZED'] }));
    expect(await StoredReport.activeForUser('user-1')).toEqual([]);
  });

  it('markClosed drops open-state tags and adds CLOSED', async () => {
    await StoredReport.record(data({ tagNames: ['OPEN', 'BUG', 'WAITING FOR DEV'] }));
    const closed = await StoredReport.markClosed('100000000000001');
    expect(closed?.data.tagNames).toEqual(['BUG', 'CLOSED']);
    expect(closed?.isActive).toBe(false);
  });

  it('markClosed is idempotent on an already-closed report', async () => {
    await StoredReport.record(data({ tagNames: ['CLOSED'] }));
    const again = await StoredReport.markClosed('100000000000001');
    expect(again?.data.tagNames).toEqual(['CLOSED']);
  });

  it('syncFromThread refreshes live-derived fields without touching immutable facts', async () => {
    await StoredReport.record(data({}));
    const thread = {
      id: '100000000000001',
      name: '🟢 Bug Report - renamed (1)',
      url: 'https://discord.com/channels/1/2/3x',
      appliedTags: [],
      createdTimestamp: 2000,
      parent: null,
    } as unknown as import('discord.js').ThreadChannel;
    const synced = await StoredReport.syncFromThread(thread);
    expect(synced?.data.threadName).toBe('🟢 Bug Report - renamed (1)');
    expect(synced?.reporterId).toBe('user-1');
    expect(synced?.data.createdTimestamp).toBe(1000);
  });

  it('syncFromThread on an unknown thread is a no-op', async () => {
    const thread = { id: 'nope', name: 'x', url: 'u', appliedTags: [], createdTimestamp: 0, parent: null } as unknown as import('discord.js').ThreadChannel;
    expect(await StoredReport.syncFromThread(thread)).toBeNull();
  });

  it('listAll returns every recorded report across users', async () => {
    await StoredReport.record(data({ threadId: 'x', reporterId: 'u1' }));
    await StoredReport.record(data({ threadId: 'y', reporterId: 'u2' }));
    const all = await StoredReport.listAll();
    expect(all.map(r => r.threadId).sort()).toEqual(['x', 'y']);
  });

  // Regression: backfill records 5-at-a-time; concurrent record() calls used to
  // read the shared index before any write landed and drop ids (last write wins).
  it('keeps every thread id under concurrent record() calls', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        StoredReport.record(data({ threadId: 't' + i, reporterId: 'u' + (i % 3) }))),
    );
    const all = await StoredReport.listAll();
    expect(all.length).toBe(12);
    for (const user of ['u0', 'u1', 'u2']) {
      expect((await StoredReport.forUser(user)).length).toBe(4);
    }
  });

  // Regression: two submissions racing through the cap check both passed.
  it('withCreationLock serializes concurrent submissions per user', async () => {
    const order: string[] = [];
    const job = (name: string) => async () => {
      order.push('start:' + name);
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push('end:' + name);
    };
    await Promise.all([
      StoredReport.withCreationLock('u', job('a')),
      StoredReport.withCreationLock('u', job('b')),
    ]);
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('withCreationLock does not serialize different users', async () => {
    const order: string[] = [];
    const job = (name: string) => async () => {
      order.push('start:' + name);
      await new Promise(resolve => setTimeout(resolve, 5));
      order.push('end:' + name);
    };
    await Promise.all([
      StoredReport.withCreationLock('u1', job('a')),
      StoredReport.withCreationLock('u2', job('b')),
    ]);
    expect(order[0]).toBe('start:a');
    expect(order[1]).toBe('start:b');
  });
});
