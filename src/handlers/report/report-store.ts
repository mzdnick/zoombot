import type { ThreadChannel } from 'discord.js';
import { ForumChannel } from 'discord.js';
import { createStore } from '../../store.js';
import { createLogger } from '../../logger.js';
import { reportCategory } from './my-reports.js';

const log = createLogger('report-store');

const reportStore = createStore<StoredReportData>('reports');
const userIndexStore = createStore<string[]>('user-reports');
// No scan API on the KV store, so the global registry is one key holding all ids.
const INDEX_KEY = 'all';
const reportIndexStore = createStore<string[]>('report-index');

export interface StoredReportData {
  threadId: string;
  ticketId: string;
  reporterId: string;
  /** 'Bug Report' | 'Feedback' | 'Feature Request' | 'Split' */
  label: string;
  threadName: string;
  url: string;
  tagNames: string[];
  createdTimestamp: number;
  /** Last known activity (message) in the thread, ms epoch. */
  lastActivityAt: number;
}

// Serializes read-modify-write on the shared index keys across concurrent record() calls.
let indexChain: Promise<unknown> = Promise.resolve();

/** Immutable facts (reporterId, label, createdTimestamp) are set at creation; live fields sync in via hooks. */
export class StoredReport {
  constructor(readonly data: StoredReportData) {}

  get threadId(): string { return this.data.threadId; }
  get reporterId(): string { return this.data.reporterId; }
  get url(): string { return this.data.url; }

  get category(): ReturnType<typeof reportCategory> {
    return reportCategory(this.data.tagNames, isClosedOrArchived(this.data));
  }

  get isActive(): boolean {
    return this.category !== 'Closed';
  }

  toSummary() {
    return {
      threadId: this.data.threadId,
      threadName: this.data.threadName,
      url: this.data.url,
      tagNames: this.data.tagNames,
      createdTimestamp: this.data.createdTimestamp,
      archived: isClosedOrArchived(this.data),
    };
  }

  // ---- Static lookups -------------------------------------------------

  static async get(threadId: string): Promise<StoredReport | null> {
    const data = await reportStore.get(threadId);
    return data ? new StoredReport(data) : null;
  }

  /** All reports a user has ever submitted (unsorted). */
  static async forUser(userId: string): Promise<StoredReport[]> {
    const ids = (await userIndexStore.get(userId)) ?? [];
    const reports: StoredReport[] = [];
    for (const id of ids) {
      const r = await StoredReport.get(id);
      if (r) reports.push(r);
    }
    return reports;
  }

  /** Reports for a user that still count against the active-report limit. */
  static async activeForUser(userId: string): Promise<StoredReport[]> {
    const all = await StoredReport.forUser(userId);
    return all.filter(r => r.isActive && r.category !== 'Snoozed');
  }

  /** All stored reports (unsorted). */
  static async listAll(): Promise<StoredReport[]> {
    const ids = (await reportIndexStore.get(INDEX_KEY)) ?? [];
    const reports: StoredReport[] = [];
    for (const id of ids) {
      const r = await StoredReport.get(id);
      if (r) reports.push(r);
    }
    return reports;
  }

  // ---- Lifecycle hooks --------------------------------------------------

  /** Creation hook. Index writes go through the chain so concurrent calls can't drop ids. */
  static async record(data: StoredReportData): Promise<StoredReport> {
    await reportStore.set(data.threadId, data);
    const run = indexChain.then(async () => {
      const ids = new Set((await userIndexStore.get(data.reporterId)) ?? []);
      ids.add(data.threadId);
      await userIndexStore.set(data.reporterId, [...ids]);
      const all = new Set((await reportIndexStore.get(INDEX_KEY)) ?? []);
      all.add(data.threadId);
      await reportIndexStore.set(INDEX_KEY, [...all]);
    });
    indexChain = run.then(() => undefined, () => undefined);
    await run;
    log.info({ threadId: data.threadId, reporterId: data.reporterId, label: data.label }, 'Report recorded');
    return new StoredReport(data);
  }

  // Per-user mutex spanning the cap check through record(), closing the TOCTOU gap.
  private static creationLocks = new Map<string, Promise<unknown>>();

  static async withCreationLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = StoredReport.creationLocks.get(userId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    StoredReport.creationLocks.set(userId, tail);
    void tail.then(() => {
      if (StoredReport.creationLocks.get(userId) === tail) StoredReport.creationLocks.delete(userId);
    });
    return run;
  }

  /** Refreshes live-derived fields (name, tags) from the thread. */
  static async syncFromThread(thread: ThreadChannel): Promise<StoredReport | null> {
    const existing = await StoredReport.get(thread.id);
    if (!existing) return null;
    const tagNames = await resolveTagNames(thread, existing.data.tagNames);
    const updated: StoredReportData = {
      ...existing.data,
      threadName: thread.name,
      url: thread.url,
      tagNames,
      lastActivityAt: Math.max(existing.data.lastActivityAt, thread.createdTimestamp ?? 0),
    };
    await reportStore.set(thread.id, updated);
    return new StoredReport(updated);
  }

  /** Targeted patch hook for facts the thread object can't provide. */
  static async update(threadId: string, patch: Partial<StoredReportData>): Promise<StoredReport | null> {
    const existing = await StoredReport.get(threadId);
    if (!existing) return null;
    const updated: StoredReportData = { ...existing.data, ...patch };
    await reportStore.set(threadId, updated);
    return new StoredReport(updated);
  }

  /** Close hook: keeps CLOSED in the tag list so `isActive` flips false. */
  static async markClosed(threadId: string): Promise<StoredReport | null> {
    const existing = await StoredReport.get(threadId);
    if (!existing) return null;
    const tagNames = [...new Set([...existing.data.tagNames.filter(t => t !== 'OPEN' && t !== 'WAITING FOR DEV' && t !== 'WAITING FOR USER'), 'CLOSED'])];
    return StoredReport.update(threadId, { tagNames });
  }
}

// parent may be uncached when the thread was fetched by id; stale tags would
// leave a closed report counting against the active cap.
async function resolveTagNames(thread: ThreadChannel, fallback: string[]): Promise<string[]> {
  let forum: unknown = thread.parent;
  if (!(forum instanceof ForumChannel) && thread.parentId) {
    forum = await thread.guild.channels.fetch(thread.parentId).catch(() => null);
  }
  if (!(forum instanceof ForumChannel)) return fallback;
  return (thread.appliedTags as string[]).map(id => forum.availableTags.find(t => t.id === id)?.name ?? '');
}

function isClosedOrArchived(data: StoredReportData): boolean {
  // Tags only: the archived flag would misclassify snoozed threads as closed.
  const tags = new Set(data.tagNames.map(t => t.toUpperCase()));
  return tags.has('CLOSED') || tags.has('FIXED');
}
