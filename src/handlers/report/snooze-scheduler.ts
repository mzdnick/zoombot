import type { Client, ThreadChannel } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { createLogger } from '../../logger.js';
import { COLORS } from '../../util.js';
import { isRateLimit, retryDelay, STATUS_EMOJI } from './title-sync.js';
import { ScheduledTimerIndex } from './scheduled-timer-index.js';

const log = createLogger('snooze-scheduler');

export const SNOOZE_EMOJI = STATUS_EMOJI['snoozed'];

export const SNOOZE_DURATIONS: Record<string, number> = {
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

export const DEFAULT_SNOOZE = '1d';

export function snoozeDurationMs(value: string): number {
  return SNOOZE_DURATIONS[value] ?? SNOOZE_DURATIONS[DEFAULT_SNOOZE];
}

const MAX_NON_RATE_LIMIT_RETRIES = 5;
const NON_RATE_LIMIT_RETRY_MS = 60 * 1000;

const WAKES_PREFIX = '⏰ Wakes ';

interface ScheduledSnooze {
  wakeAt: number;
  snoozeMessageId: string;
  reason?: string;
  snoozedBy: string;
  priorTagIds?: string[];
  priorName?: string;
  attempts?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function wakesField(wakeAt: number): { name: string; value: string } {
  return { name: '​', value: `${WAKES_PREFIX}<t:${Math.floor(wakeAt / 1000)}:R>` };
}

// Rewrites the snooze notice to its terminal state and strips the Reopen Now
// button. `cancelledBy` (set by the manual path) is surfaced as a field.
export async function finalizeSnoozeMessage(
  thread: ThreadChannel,
  messageId: string,
  opts: { title: string; cancelledBy?: string },
): Promise<void> {
  if (!messageId) return;
  const msg = await thread.messages.fetch(messageId).catch(() => null);
  const embed = msg?.embeds[0];
  if (!msg || !embed) return;
  const fields = (embed.fields ?? []).filter(f => !(f.value ?? '').startsWith(WAKES_PREFIX));
  const builder = EmbedBuilder.from(embed).setColor(COLORS.green).setTitle(opts.title).setFields(fields);
  if (opts.cancelledBy) builder.addFields({ name: '​', value: `Cancelled by <@${opts.cancelledBy}>` });
  await msg.edit({ embeds: [builder], components: [] }).catch(err => log.warn({ err }, 'Failed to finalize snooze notice'));
}

class SnoozeScheduler extends ScheduledTimerIndex<ScheduledSnooze> {
  constructor() {
    super('snooze-schedule', 'snooze-scheduler');
  }

  protected wakeAtOf(entry: ScheduledSnooze): number {
    return entry.wakeAt;
  }

  // Overwrites any prior entry for this thread and (re)arms the wake timer.
  // The caller owns the archive/lock state; this only persists the wake
  // intent so a restart can re-mount the timeout.
  async schedule(
    threadId: string,
    wakeAt: number,
    snoozeMessageId: string,
    reason: string | undefined,
    snoozedBy: string,
    priorTagIds: string[] | undefined,
    priorName: string | undefined,
  ): Promise<void> {
    await this.mutate(index => {
      index[threadId] = { wakeAt, snoozeMessageId, reason, snoozedBy, priorTagIds, priorName };
    });
    this.armTimer(threadId, wakeAt);
  }

  // Used by the Reopen Now button: best-effort reopen (interactive, must not
  // hang). Claims (cancels + clears) the pending entry, then unlocks/unarchives
  // and restores tags + title. Returns the entry, or null if none was pending.
  async reopen(thread: ThreadChannel): Promise<ScheduledSnooze | null> {
    const entry = await this.claim(thread.id);
    this.clearTimer(thread.id);
    if (!entry) return null;
    try {
      if (thread.archived) await thread.setArchived(false);
      if (thread.locked) await thread.setLocked(false);
    } catch (err) {
      this.log.warn({ err, threadId: thread.id }, 'failed to unlock/unarchive on manual reopen');
    }
    await this.applyThreadRestore(thread, entry, 0);
    return entry;
  }

  protected async fire(threadId: string): Promise<void> {
    const entry = await this.claim(threadId);
    if (!entry || !this.client) return;
    const ch = await this.client.channels.fetch(threadId).catch(() => null);
    if (!ch?.isThread()) return;

    // Reopen first: a locked/archived thread can't receive the wake edit or
    // bump. Discord rejects any other field patch (including `locked`) while
    // a thread is archived, so unarchive must happen before unlock.
    try {
      if (ch.archived) await ch.setArchived(false);
      if (ch.locked) await ch.setLocked(false);
    } catch (err) {
      return this.reschedule(threadId, entry, err, isRateLimit(err));
    }

    await this.applyThreadRestore(ch, entry, 2);
    await finalizeSnoozeMessage(ch, entry.snoozeMessageId, { title: '⏰ Snooze Over' });
    await this.bump(ch, entry.snoozeMessageId);
  }

  // Restores the pre-snooze tag set (re-adds OPEN, drops SNOOZED) and title.
  // Restoring verbatim avoids re-deriving the status/ticket suffix. Best-effort:
  // a bad tag id or a rename rate-limit never strands the report closed.
  private async applyThreadRestore(thread: ThreadChannel, entry: ScheduledSnooze, nameRetries: number): Promise<void> {
    if (entry.priorTagIds) {
      await thread.setAppliedTags(entry.priorTagIds).catch(err => this.log.warn({ err, threadId: thread.id }, 'failed to restore forum tags'));
    }
    if (!entry.priorName || thread.name === entry.priorName) return;
    for (let i = 0; i <= nameRetries; i++) {
      try {
        await thread.setName(entry.priorName);
        return;
      } catch (err) {
        if (i < nameRetries && isRateLimit(err)) {
          await sleep(retryDelay(err));
          continue;
        }
        this.log.warn({ err, threadId: thread.id }, 'failed to restore thread name');
        return;
      }
    }
  }

  private async bump(thread: ThreadChannel, snoozeMessageId: string): Promise<void> {
    const content = '⏰ Snooze is over — this report is back open.';
    const ref = snoozeMessageId ? await thread.messages.fetch(snoozeMessageId).catch(() => null) : null;
    if (ref) {
      await ref.reply({ content, allowedMentions: { parse: [] } }).catch(err => this.log.warn({ err }, 'Failed to bump snooze message'));
    } else {
      await thread.send({ content }).catch(err => this.log.warn({ err }, 'Failed to post wake bump'));
    }
  }

  private async reschedule(threadId: string, entry: ScheduledSnooze, err: unknown, rateLimited: boolean): Promise<void> {
    const attempts = (entry.attempts ?? 0) + (rateLimited ? 0 : 1);
    if (!rateLimited && attempts > MAX_NON_RATE_LIMIT_RETRIES) {
      this.log.warn({ err, threadId }, 'snooze wake exhausted non-rate-limit retries; abandoning');
      return;
    }
    const wait = rateLimited ? retryDelay(err) : NON_RATE_LIMIT_RETRY_MS;
    const wakeAt = Date.now() + wait;
    this.log.warn({ err, threadId, waitMs: wait, rateLimited, attempts }, 'snooze wake deferred; will retry');
    await this.mutate(index => {
      index[threadId] = { ...entry, wakeAt, attempts };
    });
    this.armTimer(threadId, wakeAt);
  }
}

const scheduler = new SnoozeScheduler();

export async function getScheduledSnooze(threadId: string): Promise<ScheduledSnooze | undefined> {
  return scheduler.get(threadId);
}

export async function scheduleSnooze(
  threadId: string,
  wakeAt: number,
  snoozeMessageId: string,
  reason: string | undefined,
  snoozedBy: string,
  priorTagIds: string[] | undefined,
  priorName: string | undefined,
): Promise<void> {
  return scheduler.schedule(threadId, wakeAt, snoozeMessageId, reason, snoozedBy, priorTagIds, priorName);
}

export async function cancelSnooze(threadId: string): Promise<void> {
  return scheduler.cancel(threadId);
}

export async function reopenSnoozedThread(thread: ThreadChannel): Promise<ScheduledSnooze | null> {
  return scheduler.reopen(thread);
}

export function initSnoozeScheduler(c: Client): void {
  scheduler.init(c);
}
