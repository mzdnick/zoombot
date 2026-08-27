import type { Client, ThreadChannel } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import { tryStatusClose, withThreadLock, type ReportStatus } from './title-sync.js';
import { ScheduledTimerIndex } from './scheduled-timer-index.js';

export const CLOSE_DELAY_MS = 5 * 60 * 1000;

const MAX_NON_RATE_LIMIT_RETRIES = 5;

const CLOSING_PREFIX = '⏳ Closing ';

export interface ScheduledClose {
  status: ReportStatus;
  closeAt: number;
  noticeMessageId: string;
  /** Why the close was scheduled. 'dormant' closes are cancelled by new activity; staff/user ones are not. */
  origin?: 'dormant' | 'manual';
  attempts?: number;
}

export function nextCloseAt(): number {
  return Date.now() + CLOSE_DELAY_MS;
}

export function closingNoticeField(closeAt: number): { name: string; value: string } {
  return { name: '​', value: `${CLOSING_PREFIX}<t:${Math.floor(closeAt / 1000)}:R>` };
}

class CloseScheduler extends ScheduledTimerIndex<ScheduledClose> {
  constructor() {
    super('close-schedule', 'close-scheduler');
  }

  protected wakeAtOf(entry: ScheduledClose): number {
    return entry.closeAt;
  }

  async schedule(
    thread: ThreadChannel,
    status: ReportStatus,
    closeAt: number,
    noticeMessageId: string,
    origin?: 'dormant' | 'manual',
  ): Promise<boolean> {
    let scheduled = false;
    await this.mutate(index => {
      if (index[thread.id]) return;
      index[thread.id] = { status, closeAt, noticeMessageId, origin };
      scheduled = true;
    });
    if (scheduled) this.armTimer(thread.id, closeAt);
    return scheduled;
  }

  // Atomic cancel: racing cancellations can't both act on the same entry.
  async claimClose(threadId: string): Promise<ScheduledClose | undefined> {
    const entry = await this.claim(threadId);
    this.clearTimer(threadId);
    return entry;
  }

  protected async fire(threadId: string): Promise<void> {
    const entry = (await this.readIndex())[threadId];
    if (!entry || !this.client) return;
    const ch = await this.client.channels.fetch(threadId).catch(() => null);
    if (!ch?.isThread()) {
      await this.mutate(index => { delete index[threadId]; });
      return;
    }
    await this.stripClosingNotice(ch, entry.noticeMessageId);
    const result = await withThreadLock(threadId, () => tryStatusClose(ch, entry.status));
    if (!result.done) {
      const attempts = (entry.attempts ?? 0) + (result.rateLimited ? 0 : 1);
      if (attempts > MAX_NON_RATE_LIMIT_RETRIES) {
        this.log.warn({ threadId }, 'scheduled close exhausted non-rate-limit retries; abandoning');
        await this.mutate(index => { delete index[threadId]; });
        return;
      }
      const closeAt = Date.now() + result.retryMs;
      await this.mutate(index => {
        if (index[threadId]) {
          index[threadId].closeAt = closeAt;
          index[threadId].attempts = attempts;
        }
      });
      await this.stripClosingNotice(ch, entry.noticeMessageId, closeAt);
      this.armTimer(threadId, closeAt);
      return;
    }
    await this.mutate(index => { delete index[threadId]; });
  }

  private async stripClosingNotice(thread: ThreadChannel, messageId: string, replaceWith?: number): Promise<void> {
    if (!messageId) return;
    const msg = await thread.messages.fetch(messageId).catch(() => null);
    const embed = msg?.embeds[0];
    if (!msg || !embed) return;
    const fields = (embed.fields ?? []).filter(f => !f.value.startsWith(CLOSING_PREFIX));
    if (replaceWith !== undefined) fields.push(closingNoticeField(replaceWith));
    await msg.edit({ embeds: [EmbedBuilder.from(embed).setFields(fields)] }).catch(err => this.log.warn({ err }, 'Failed to edit closing notice'));
  }
}

const scheduler = new CloseScheduler();

export async function getScheduledClose(threadId: string): Promise<ScheduledClose | undefined> {
  return scheduler.get(threadId);
}

export async function scheduleClose(
  thread: ThreadChannel,
  status: ReportStatus,
  closeAt: number,
  noticeMessageId: string,
  origin?: 'dormant' | 'manual',
): Promise<boolean> {
  return scheduler.schedule(thread, status, closeAt, noticeMessageId, origin);
}

export async function cancelScheduledClose(threadId: string): Promise<ScheduledClose | undefined> {
  return scheduler.claimClose(threadId);
}

export function initCloseScheduler(c: Client): void {
  scheduler.init(c);
}
