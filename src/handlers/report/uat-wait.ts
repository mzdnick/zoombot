import type { Client, ForumChannel, ThreadChannel } from 'discord.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createStore } from '../../store.js';
import { getForum } from './route-tracker.js';
import { isFrozen } from './freeze-state.js';
import { onCommit, type CommitTip } from './commit-watcher.js';

const log = createLogger('uat-wait');

// Threads in the ⚪ fix-incoming state, waiting for the next commit on the
// watch branch. One record per thread under a single index key: the KV store
// has no scan API, and the watcher needs to fan an event out to all entries.
export interface CommitWaitEntry {
  msgId: string;
  ticketId: string;
  /** Branch tip sha at wait-start; activation fires when the tip moves off it. */
  baselineSha?: string;
  /** No-baseline fallback (watcher had not polled yet): fire on commits dated after this. */
  thresholdDate: string;
  submitterId: string;
  audience: string;
  staffMessage: string;
  /** Set when a commit fired during a freeze; activation defers to thaw. */
  pendingCommit?: CommitTip;
}

const INDEX_KEY = 'pending';
const waitStore = createStore<Record<string, CommitWaitEntry>>('uat-wait');

let chain: Promise<unknown> = Promise.resolve();

function mutate<T>(fn: (index: Record<string, CommitWaitEntry>) => T): Promise<T> {
  const run = chain.then(async () => {
    const index = (await waitStore.get(INDEX_KEY)) ?? {};
    const result = fn(index);
    await waitStore.set(INDEX_KEY, index);
    return result;
  });
  chain = run.then(() => undefined, () => undefined);
  return run;
}

export async function readCommitWaits(): Promise<Record<string, CommitWaitEntry>> {
  return (await waitStore.get(INDEX_KEY)) ?? {};
}

export function watchCommit(threadId: string, entry: CommitWaitEntry): Promise<void> {
  return mutate(index => { index[threadId] = entry; });
}

export function cancelCommitWatch(threadId: string): Promise<void> {
  return mutate(index => { delete index[threadId]; });
}

export async function hasCommitWatch(threadId: string): Promise<boolean> {
  return !!((await readCommitWaits())[threadId]);
}

export function shouldFireWait(entry: CommitWaitEntry, commit: CommitTip): boolean {
  if (entry.baselineSha !== undefined) return commit.sha !== entry.baselineSha;
  return commit.date > entry.thresholdDate;
}

// Injection instead of an import: the finalizer lives in report-actions, which
// imports this module (same cycle-avoidance as setReportCloseHandler).
export type CommitWaitFinalizer = (
  thread: ThreadChannel,
  forum: ForumChannel,
  entry: CommitWaitEntry,
  commit: CommitTip,
) => Promise<void>;

let finalizer: CommitWaitFinalizer | null = null;

export function setCommitWaitFinalizer(fn: CommitWaitFinalizer): void {
  finalizer = fn;
}

let client: Client | null = null;

export function initCommitWatches(c: Client): void {
  client = c;
  onCommit(commit => {
    void handleCommit(commit).catch(err => log.warn({ err }, 'Commit event handling failed'));
  });
  // A commit that fired during a freeze is stored on the entry; boot covers a
  // crash between thaw and firing.
  void firePendingCommitWaits().catch(err => log.warn({ err }, 'Boot commit-wait recovery failed'));
}

async function activate(threadId: string, entry: CommitWaitEntry, commit: CommitTip): Promise<void> {
  try {
    if (!finalizer || !client) return;
    if (await isFrozen()) {
      await mutate(index => {
        const current = index[threadId];
        if (current) index[threadId] = { ...current, pendingCommit: commit };
      });
      log.info({ threadId, sha: commit.short }, 'Frozen; deferring commit activation to thaw');
      return;
    }

    // Claim first so a concurrent event or re-run can't double-activate.
    const claimed = await mutate(index => {
      const current = index[threadId];
      if (!current) return false;
      delete index[threadId];
      return true;
    });
    if (!claimed) return;

    try {
      const channel = await client.channels.fetch(threadId).catch(() => null);
      const thread = channel?.isThread() ? channel : null;
      // A closed/snoozed thread must never be resurrected by an activation
      // racing its cancellation.
      if (!thread || thread.archived || thread.locked) {
        log.warn({ threadId, archived: thread?.archived, locked: thread?.locked }, 'Watch thread closed or gone; dropping commit watch');
        return;
      }
      const forum = await getForum(thread.guild, loadConfig().forumChannelId);
      if (!forum) {
        log.warn({ threadId }, 'Forum not found; keeping commit watch for retry');
        await watchCommit(threadId, entry);
        return;
      }
      await thread.messages.fetch(entry.msgId).then(m => m.delete()).catch(() => {
        log.warn({ threadId, msgId: entry.msgId }, 'Failed to delete fix-incoming embed (may already be gone)');
      });
      await finalizer(thread, forum, entry, commit);
      log.info({ threadId, sha: commit.short }, 'Commit watch activated');
    } catch (err) {
      log.warn({ err, threadId }, 'Commit watch activation failed; restoring entry for retry');
      // entry still carries pendingCommit, so failed post-thaw retries stay recoverable
      await watchCommit(threadId, entry);
    }
  } catch (err) {
    // Pre-claim failure: stored entry untouched, next event retries
    log.warn({ err, threadId }, 'Commit watch activation failed before claim');
  }
}

async function handleCommit(commit: CommitTip): Promise<void> {
  const index = await readCommitWaits();
  for (const [threadId, entry] of Object.entries(index)) {
    if (shouldFireWait(entry, commit)) {
      await activate(threadId, entry, commit);
    }
  }
}

/** Fires watch entries deferred by a freeze; called on thaw and at boot. */
export async function firePendingCommitWaits(): Promise<void> {
  const index = await readCommitWaits();
  for (const [threadId, entry] of Object.entries(index)) {
    if (entry.pendingCommit) {
      await activate(threadId, entry, entry.pendingCommit);
    }
  }
}
