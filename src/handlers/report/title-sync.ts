import type { Client, ThreadChannel } from 'discord.js';
import { createStore } from '../../store.js';
import { createLogger } from '../../logger.js';

const log = createLogger('title-sync');

export type ReportStatus = 'new' | 'waiting-for-dev' | 'waiting-for-user' | 'resolved' | 'closed' | 'snoozed';

export const STATUS_EMOJI: Record<ReportStatus, string> = {
  'new': '🟠',
  'waiting-for-dev': '🔴',
  'waiting-for-user': '🟣',
  'resolved': '🟢',
  'closed': '🔵',
  'snoozed': '💤',
};

const LEGACY_TYPE_EMOJIS = ['🐛', '💬', '✨'];
const KNOWN_TITLE_EMOJIS = [...Object.values(STATUS_EMOJI), ...LEGACY_TYPE_EMOJIS];

const FALLBACK_RETRY_MS = 10 * 60 * 1000;
const NON_RATE_LIMIT_RETRY_MS = 60 * 1000;
const MAX_RATE_LIMIT_RETRIES = 10;
const TITLE_INDEX_KEY = 'pending';

// Stores the desired status, not a frozen title, so the worker recomputes against the
// thread's current name at fire time. `close` persists so a restart still closes in order.
interface PendingEntry {
  status: ReportStatus;
  close?: boolean;
}

const titleStore = createStore<Record<string, PendingEntry>>('title-sync');

const syncing = new Set<string>();
let client: Client | null = null;

// Shared by applyTitle, syncWorker, and close-scheduler's timer so they can't race
// each other's thread renames against the 2-per-10-min sublimit. Hold it per REST
// attempt only, never across a retry sleep, or a rate-limit wait would stall closes.
const threadOps = new Map<string, Promise<unknown>>();

export function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = threadOps.get(threadId) ?? Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  const tail = run.then(() => undefined, () => undefined);
  threadOps.set(threadId, tail);
  void tail.then(() => { if (threadOps.get(threadId) === tail) threadOps.delete(threadId); });
  return run;
}

// Report close is owned by report-actions; it's injected here so the deferred
// worker (and restart recovery) can finalize a close without an import cycle.
let closeHandler: ((thread: ThreadChannel) => Promise<void>) | null = null;

export function setReportCloseHandler(fn: (thread: ThreadChannel) => Promise<void>): void {
  closeHandler = fn;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function stripLeadingEmoji(name: string): string {
  for (const e of KNOWN_TITLE_EMOJIS) {
    if (name.startsWith(e)) return name.slice(e.length);
  }
  return name;
}

export const MAX_TITLE_LEN = 100;

const REPORT_LABELS = ['Bug Report', 'Feedback', 'Feature Request'];
const FIRST_LABEL_SPLIT_RE = new RegExp(`^(.*?(?:${REPORT_LABELS.join('|')}) - )(.*)$`);
const TRAILING_TICKET_ID_RE = /\s*\((\d+)\)\s*$/;

export interface ReportTitleParts {
  prefix: string;
  title: string;
  suffix: string;
}

export function splitReportTitle(currentName: string, ticketId: string): ReportTitleParts {
  const suffix = ` (${ticketId})`;
  const trailingId = currentName.match(TRAILING_TICKET_ID_RE);
  const body = trailingId?.[1] === ticketId ? currentName.slice(0, trailingId.index) : currentName;

  const labelled = body.match(FIRST_LABEL_SPLIT_RE);
  if (labelled) return { prefix: labelled[1], title: labelled[2], suffix };

  const stripped = stripLeadingEmoji(body);
  const emoji = body.slice(0, body.length - stripped.length);
  return { prefix: emoji + (stripped.startsWith(' ') ? ' ' : ''), title: stripped.trimStart(), suffix };
}

export function maxRenameLength(parts: ReportTitleParts): number {
  return Math.max(1, MAX_TITLE_LEN - parts.prefix.length - parts.suffix.length);
}

export function composeReportTitle(parts: ReportTitleParts, newTitle: string): string {
  const trimmed = newTitle.trim();
  const budget = maxRenameLength(parts);
  const title = trimmed.length > budget ? trimmed.slice(0, budget - 1).trimEnd() + '…' : trimmed;
  return `${parts.prefix}${title}${parts.suffix}`;
}

function ticketIdFor(thread: ThreadChannel): string {
  return String(parseInt(thread.id.slice(-7), 10));
}

export function computeStatusTitle(currentName: string, status: ReportStatus, ticketId: string): string {
  let base = stripLeadingEmoji(currentName);
  if (base.startsWith(' ')) base = base.slice(1);
  let title = `${STATUS_EMOJI[status]} ${base}`;
  // Creation omits the (id) suffix to save a rename; add it on the first status change.
  if (!/\(\d+\)\s*$/.test(title)) {
    const suffix = ` (${ticketId})`;
    if (title.length + suffix.length > MAX_TITLE_LEN) {
      title = title.slice(0, MAX_TITLE_LEN - suffix.length - 1).trimEnd() + '…';
    }
    title += suffix;
  }
  return title;
}

// A rate-limit rejection (discord.js RateLimitError) carries `timeToReset` and
// no Discord error `code`; that's the only failure we retry. Everything else
// (missing perms, invalid name, unknown channel, network) is non-retryable.
export function isRateLimit(err: unknown): boolean {
  return err != null && typeof err === 'object'
    && 'timeToReset' in err && typeof (err as { timeToReset?: unknown }).timeToReset === 'number';
}

// Thread-name edits hit a 2-per-10-min sublimit whose true wait is in `retryAfter`
// / `sublimitTimeout`, NOT `timeToReset` (the ~15s general-bucket reset). Honoring
// only timeToReset retries every ~20s and burns MAX_RATE_LIMIT_RETRIES before the
// sublimit clears, abandoning the rename - so take the largest wait Discord gives.
export function retryDelay(err: unknown): number {
  if (err != null && typeof err === 'object') {
    const e = err as { timeToReset?: number; retryAfter?: number; sublimitTimeout?: number };
    const wait = Math.max(e.retryAfter ?? 0, e.sublimitTimeout ?? 0, e.timeToReset ?? 0);
    if (wait > 0) return wait + 1_000;
  }
  return FALLBACK_RETRY_MS;
}

// Serialize read-modify-write on the shared index so concurrent status changes
// on different threads can't lose each other's entry (last-write-wins).
let indexChain: Promise<unknown> = Promise.resolve();

async function readIndex(): Promise<Record<string, PendingEntry>> {
  return (await titleStore.get(TITLE_INDEX_KEY)) ?? {};
}

function mutateIndex<T>(fn: (index: Record<string, PendingEntry>) => T): Promise<T> {
  const run = indexChain.then(async () => {
    const index = await readIndex();
    const result = fn(index);
    await titleStore.set(TITLE_INDEX_KEY, index);
    return result;
  });
  indexChain = run.then(() => undefined, () => undefined);
  return run;
}

function persistEntry(threadId: string, entry: PendingEntry): Promise<void> {
  return mutateIndex(index => { index[threadId] = entry; });
}

function clearEntry(threadId: string): Promise<void> {
  return mutateIndex(index => { delete index[threadId]; });
}

async function readEntry(threadId: string): Promise<PendingEntry | undefined> {
  return (await readIndex())[threadId];
}

async function runClose(thread: ThreadChannel): Promise<void> {
  if (!closeHandler) {
    log.error({ threadId: thread.id }, 'no close handler registered; cannot finalize close');
    return;
  }
  await closeHandler(thread);
}

// Rename before close so a rename never fires on an already-archived thread.
// Returns true when deferred to the background worker (rate-limited).
async function applyTitle(thread: ThreadChannel, status: ReportStatus, close: boolean): Promise<boolean> {
  return withThreadLock(thread.id, async () => {
    const desired = computeStatusTitle(thread.name, status, ticketIdFor(thread));

    if (thread.name !== desired) {
      try {
        await thread.setName(desired);
      } catch (err) {
        if (isRateLimit(err)) {
          await persistEntry(thread.id, { status, close });
          kickWorker(thread);
          return true;
        }
        log.warn({ err, threadId: thread.id }, 'title rename failed (non-rate-limit); leaving title unchanged');
      }
    }

    if (close) {
      try {
        await runClose(thread);
      } catch (err) {
        if (isRateLimit(err)) {
          await persistEntry(thread.id, { status, close: true });
          kickWorker(thread);
          return true;
        }
        log.warn({ err, threadId: thread.id }, 'close failed (non-rate-limit); abandoning');
      }
    }

    await clearEntry(thread.id);
    return false;
  });
}

// Fire-and-forget the worker without ever rejecting: an unhandled rejection
// crashes the whole bot (see process.on('unhandledRejection') in index.ts).
function kickWorker(thread: ThreadChannel): void {
  void syncWorker(thread).catch(err => log.warn({ err, threadId: thread.id }, 'title sync worker crashed'));
}

// On non-rate-limit errors, logs and gives up - once past the first attempt
// there's nothing actionable to surface to the user.
async function syncWorker(thread: ThreadChannel): Promise<void> {
  if (syncing.has(thread.id)) return;
  syncing.add(thread.id);
  try {
    let rateLimitRetries = 0;
    for (;;) {
      const entry = await readEntry(thread.id);
      if (!entry) break;

      // If a pending close already landed (thread archived) but we crashed before
      // clearing it, treat it as done - re-editing would unarchive a closed report.
      if (entry.close && thread.archived) {
        await clearEntry(thread.id);
        break;
      }

      try {
        await withThreadLock(thread.id, async () => {
          const desired = computeStatusTitle(thread.name, entry.status, ticketIdFor(thread));
          if (thread.name !== desired) {
            try {
              await thread.setName(desired);
            } catch (err) {
              if (isRateLimit(err)) throw err;
              log.warn({ err, threadId: thread.id }, 'deferred rename failed (non-rate-limit); closing without it');
            }
          }
          if (entry.close) await runClose(thread);
        });
      } catch (err) {
        if (isRateLimit(err)) {
          if (++rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
            log.warn({ threadId: thread.id, rateLimitRetries }, 'title sync exhausted rate-limit retries; abandoning');
            await clearEntry(thread.id);
            break;
          }
          const wait = retryDelay(err);
          log.warn({ err, threadId: thread.id, waitMs: wait, rateLimitRetries }, 'title sync deferred (rate limit); will retry');
          await sleep(wait);
          continue;
        }
        log.warn({ err, threadId: thread.id }, 'deferred title sync failed (non-rate-limit); abandoning');
        await clearEntry(thread.id);
        break;
      }

      await clearEntry(thread.id);
      break;
    }
  } finally {
    syncing.delete(thread.id);
  }
}

export async function setThreadStatusEmoji(thread: ThreadChannel, status: ReportStatus): Promise<void> {
  await applyTitle(thread, status, false);
}

// Returns true if deferred (rate limited) - caller should tell the user it may take a moment.
export function setThreadStatusAndClose(thread: ThreadChannel, status: ReportStatus): Promise<boolean> {
  return applyTitle(thread, status, true);
}

export async function tryStatusClose(
  thread: ThreadChannel,
  status: ReportStatus,
): Promise<{ done: true } | { done: false; retryMs: number; rateLimited: boolean }> {
  try {
    const desired = computeStatusTitle(thread.name, status, ticketIdFor(thread));
    if (thread.name !== desired) {
      try {
        await thread.setName(desired);
      } catch (err) {
        if (isRateLimit(err)) throw err;
        log.warn({ err, threadId: thread.id }, 'scheduled close rename failed (non-rate-limit); closing without it');
      }
    }
    await runClose(thread);
    return { done: true };
  } catch (err) {
    if (isRateLimit(err)) return { done: false, retryMs: retryDelay(err), rateLimited: true };
    log.warn({ err, threadId: thread.id }, 'scheduled close failed (non-rate-limit); will retry');
    return { done: false, retryMs: NON_RATE_LIMIT_RETRY_MS, rateLimited: false };
  }
}

export function initTitleSync(c: Client): void {
  client = c;
  void recoverPending();
}

async function recoverPending(): Promise<void> {
  if (!client) return;
  const ids = Object.keys(await readIndex());
  if (ids.length === 0) return;
  log.info(`Recovering ${ids.length} pending title change(s)`);
  for (const threadId of ids) {
    try {
      const ch = await client.channels.fetch(threadId).catch(() => null);
      if (ch && ch.isThread()) {
        kickWorker(ch);
      } else {
        await clearEntry(threadId);
      }
    } catch (err) {
      log.warn({ err, threadId }, 'failed to recover pending title');
    }
  }
}
