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

import type { Client, Events } from 'discord.js';
import type { ArgsOf } from 'discordx';
import { StoredReport, type StoredReportData } from './report-store.js';
import { ReportHealth, runHealthCheck } from './report-health.js';

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

function fakeClient(fetch: (id: string) => Promise<unknown>): Client {
  return { channels: { fetch } } as unknown as Client;
}

beforeEach(() => {
  for (const ns of Object.values(h.namespaces)) ns.clear();
});

describe('runHealthCheck', () => {
  it('forgets reports whose threads no longer exist and keeps the rest', async () => {
    await StoredReport.record(data({ threadId: 'ghost' }));
    await StoredReport.record(data({ threadId: 'live' }));
    const client = fakeClient(id => id === 'ghost' ? Promise.reject({ status: 404, code: 10003 }) : Promise.resolve({}));
    expect(await runHealthCheck(client)).toBe(1);
    expect((await StoredReport.listAll()).map(r => r.threadId)).toEqual(['live']);
  });

  it('keeps reports on permission or transient failures', async () => {
    await StoredReport.record(data({ threadId: 'hidden' }));
    await StoredReport.record(data({ threadId: 'flaky' }));
    const client = fakeClient(id => Promise.reject(id === 'hidden' ? { status: 403, code: 50001 } : { status: 500 }));
    expect(await runHealthCheck(client)).toBe(0);
    expect((await StoredReport.listAll()).map(r => r.threadId).sort()).toEqual(['flaky', 'hidden']);
  });
});

describe('ThreadDelete handler', () => {
  it('forgets the report when its thread is deleted', async () => {
    await StoredReport.record(data({ threadId: 'gone' }));
    await StoredReport.record(data({ threadId: 'kept' }));
    await new ReportHealth().onThreadDelete([{ id: 'gone' }] as unknown as ArgsOf<Events.ThreadDelete>);
    expect(await StoredReport.get('gone')).toBeNull();
    expect(await StoredReport.get('kept')).not.toBeNull();
  });
});
