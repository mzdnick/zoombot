import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getIntegration: vi.fn(),
  threadIdForTask: vi.fn(),
  syncReport: vi.fn(),
  recreateDeletedTask: vi.fn(),
  removeLink: vi.fn(),
  taskTitleForThread: vi.fn(),
  extractDiscordAssignee: vi.fn(),
  canRenameThread: vi.fn(),
  hasStaffRole: vi.fn(),
  renameReportThread: vi.fn(),
  setReportAssignee: vi.fn(),
  getStoredReport: vi.fn(),
  getScheduledClose: vi.fn(),
  getScheduledSnooze: vi.fn(),
  recordHumanReportActivity: vi.fn(),
}));

const state = vi.hoisted(() => ({ inbox: new Map<string, unknown>() }));

vi.mock('../../store.js', () => ({
  createStore: () => ({
    get: async (key: string) => state.inbox.get(key),
    set: async (key: string, value: unknown) => { state.inbox.set(key, value); },
    delete: async (key: string) => { state.inbox.delete(key); return true; },
  }),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../../handlers/report/report-actions.js', () => ({
  canRenameThread: mocks.canRenameThread,
  hasStaffRole: mocks.hasStaffRole,
  renameReportThread: mocks.renameReportThread,
  setReportAssignee: mocks.setReportAssignee,
}));
vi.mock('../../handlers/report/report-store.js', () => ({ StoredReport: { get: mocks.getStoredReport } }));
vi.mock('../../handlers/report/close-scheduler.js', () => ({ getScheduledClose: mocks.getScheduledClose }));
vi.mock('../../handlers/report/snooze-scheduler.js', () => ({ getScheduledSnooze: mocks.getScheduledSnooze }));
vi.mock('../../handlers/report/dormant-scheduler.js', () => ({ recordHumanReportActivity: mocks.recordHumanReportActivity }));
vi.mock('./sync.js', () => ({
  extractDiscordAssignee: mocks.extractDiscordAssignee,
  getVikunjaIntegration: mocks.getIntegration,
  recreateDeletedTask: mocks.recreateDeletedTask,
  removeLink: mocks.removeLink,
  syncReport: mocks.syncReport,
  taskTitleForThread: mocks.taskTitleForThread,
  threadIdForTask: mocks.threadIdForTask,
}));
import {
  MAX_WEBHOOK_ATTEMPTS,
  drainVikunjaWebhooks,
  parseVerifiedWebhook,
  processVikunjaWebhook,
  splitDiscordMessage,
  verifyVikunjaSignature,
} from './webhook.js';

function integration(userMap: Record<string, string> = {}) {
  return {
    botUserId: 99,
    config: { webhookSecret: 'secret', userMap },
    api: { getComment: vi.fn() },
  };
}

function thread() {
  return {
    id: 'discord-thread',
    isThread: () => true,
    guild: { members: { fetch: vi.fn() } },
    send: vi.fn().mockResolvedValue({}),
    fetchStarterMessage: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.inbox.clear();
  mocks.getIntegration.mockReturnValue(integration());
  mocks.threadIdForTask.mockResolvedValue('discord-thread');
  mocks.syncReport.mockResolvedValue(true);
  mocks.recreateDeletedTask.mockResolvedValue(true);
  mocks.removeLink.mockResolvedValue(undefined);
  mocks.getStoredReport.mockResolvedValue({ data: { ticketId: '123', label: 'Bug Report' } });
  mocks.getScheduledClose.mockResolvedValue(undefined);
  mocks.getScheduledSnooze.mockResolvedValue(undefined);
  mocks.canRenameThread.mockReturnValue(false);
  mocks.hasStaffRole.mockReturnValue(false);
  mocks.taskTitleForThread.mockReturnValue('#123 — Existing title');
  mocks.extractDiscordAssignee.mockReturnValue(null);
  mocks.renameReportThread.mockResolvedValue({ noop: false, name: 'renamed' });
  mocks.setReportAssignee.mockResolvedValue(undefined);
  mocks.recordHumanReportActivity.mockResolvedValue(undefined);
});

describe('Vikunja webhook signatures', () => {
  it('accepts Vikunja’s raw-body HMAC-SHA256 hex signature', () => {
    const body = Buffer.from('{"event_name":"task.updated"}');
    const signature = createHmac('sha256', 'secret').update(body).digest('hex');
    expect(verifyVikunjaSignature(body, signature, 'secret')).toBe(true);
    expect(verifyVikunjaSignature(body, 'not-a-signature', 'secret')).toBe(false);
  });

  it('accepts valid signed payloads and rejects invalid or malformed ones', () => {
    const validBody = JSON.stringify({ event_name: 'unused.event', data: { task: { id: 7 }, doer: { id: 1 } } });
    const validSignature = createHmac('sha256', 'secret').update(validBody).digest('hex');
    expect(parseVerifiedWebhook(Buffer.from(validBody), validSignature, 'secret')).toMatchObject({
      event_name: 'unused.event',
      data: { task: { id: 7 } },
    });
    expect(() => parseVerifiedWebhook(Buffer.from(validBody), 'bad', 'secret'))
      .toThrow(/signature/);

    const malformedBody = '{';
    const malformedSignature = createHmac('sha256', 'secret').update(malformedBody).digest('hex');
    expect(() => parseVerifiedWebhook(Buffer.from(malformedBody), malformedSignature, 'secret'))
      .toThrow(/JSON/);
  });

  it('ignores events authored by the authenticated Vikunja bot', async () => {
    await processVikunjaWebhook({ channels: { fetch: vi.fn() } } as never, {
      event_name: 'task.comment.created',
      data: { task: { id: 7 }, doer: { id: 99 }, comment: { id: 3 } },
    });
    expect(mocks.threadIdForTask).not.toHaveBeenCalled();
  });

  it('posts a mapped human web comment once with mentions disabled', async () => {
    const reportThread = thread();
    const client = { channels: { fetch: vi.fn().mockResolvedValue(reportThread) } };
    const current = integration();
    current.api.getComment.mockResolvedValue({
      id: 3,
      comment: 'Please test this.',
      author: { name: 'Ada' },
    });
    mocks.getIntegration.mockReturnValue(current);

    await processVikunjaWebhook(client as never, {
      event_name: 'task.comment.created',
      data: { task: { id: 7 }, doer: { id: 5 }, comment: { id: 3 } },
    });

    expect(reportThread.send).toHaveBeenCalledWith({
      content: '**Web · Ada**\n\nPlease test this.',
      allowedMentions: { parse: [] },
    });
    expect(mocks.recordHumanReportActivity).toHaveBeenCalledWith(reportThread);
  });

  it('treats state/done changes as projection drift and rejects unmapped web mutations', async () => {
    const reportThread = thread();
    const client = { channels: { fetch: vi.fn().mockResolvedValue(reportThread) } };
    mocks.getIntegration.mockReturnValue(integration());

    await processVikunjaWebhook(client as never, {
      event_name: 'task.updated',
      data: {
        task: {
          id: 7,
          title: '#123 — Changed from web',
          description: 'Web-owned description',
          done: true,
          due_date: '2030-01-01T00:00:00Z',
          labels: [{ id: 1, title: 'Closed' }],
        },
        doer: { id: 5 },
      },
    });
    await processVikunjaWebhook(client as never, {
      event_name: 'task.assignee.created',
      data: { task: { id: 7 }, doer: { id: 5 }, assignee: { user_id: 6 } },
    });

    expect(mocks.renameReportThread).not.toHaveBeenCalled();
    expect(mocks.setReportAssignee).not.toHaveBeenCalled();
    expect(mocks.syncReport).toHaveBeenCalledTimes(2);
  });

  it('resurrects deleted task when report is active', async () => {
    const reportThread = thread();
    const client = { channels: { fetch: vi.fn().mockResolvedValue(reportThread) } };
    mocks.getStoredReport.mockResolvedValue({ data: { ticketId: '123', label: 'Bug Report' }, isActive: true });

    await processVikunjaWebhook(client as never, {
      event_name: 'task.deleted',
      data: { task: { id: 7 }, doer: { id: 5 } },
    });

    expect(mocks.recreateDeletedTask).toHaveBeenCalledWith(reportThread, 7);
    expect(mocks.removeLink).not.toHaveBeenCalled();
  });

  it('unlinks task instead of resurrecting when report is closed', async () => {
    const reportThread = thread();
    const client = { channels: { fetch: vi.fn().mockResolvedValue(reportThread) } };
    mocks.getStoredReport.mockResolvedValue({ data: { ticketId: '123', label: 'Bug Report' }, isActive: false });

    await processVikunjaWebhook(client as never, {
      event_name: 'task.deleted',
      data: { task: { id: 7 }, doer: { id: 5 } },
    });

    expect(mocks.removeLink).toHaveBeenCalledWith('discord-thread', 7);
    expect(mocks.recreateDeletedTask).not.toHaveBeenCalled();
  });
});

describe('Vikunja webhook inbox drain', () => {
  const payload = { event_name: 'task.updated', data: { task: { id: 7 }, doer: { id: 5 } } };

  function client() {
    return { channels: { fetch: vi.fn().mockResolvedValue(thread()) } };
  }

  it('dead-letters events that exceeded the attempt cap', async () => {
    mocks.syncReport.mockRejectedValue(new Error('Vikunja unreachable'));
    state.inbox.set('pending', { sig: { payload, attempts: MAX_WEBHOOK_ATTEMPTS } });

    await drainVikunjaWebhooks(client() as never);

    expect(state.inbox.get('pending')).toEqual({});
  });

  it('keeps an entry that is still under the attempt cap', async () => {
    mocks.syncReport.mockRejectedValue(new Error('Vikunja unreachable'));
    state.inbox.set('pending', { sig: { payload, attempts: MAX_WEBHOOK_ATTEMPTS - 1 } });

    await drainVikunjaWebhooks(client() as never);

    expect(state.inbox.get('pending')).toEqual({ sig: { payload, attempts: MAX_WEBHOOK_ATTEMPTS } });
  });

  it('removes entries once they process successfully', async () => {
    state.inbox.set('pending', { sig: { payload, attempts: 3 } });

    await drainVikunjaWebhooks(client() as never);

    expect(state.inbox.get('pending')).toEqual({});
  });
});

describe('splitDiscordMessage', () => {
  it('never cuts a surrogate pair in half', () => {
    const content = `x${'😀'.repeat(1500)}y${'😀'.repeat(1500)}`;
    const chunks = splitDiscordMessage(content, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
      const first = chunk.charCodeAt(0);
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(first >= 0xdc00 && first <= 0xdfff).toBe(false);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});
