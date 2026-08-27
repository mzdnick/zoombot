import type { Client, ThreadChannel } from 'discord.js';
import { EmbedBuilder, Events } from 'discord.js';
import { Discord, On, ArgsOf } from 'discordx';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { COLORS } from '../../util.js';
import { StoredReport } from './report-store.js';
import { reportNoun } from './report-copy.js';
import { getForum } from './route-tracker.js';
import { swapForumTags } from './report-service.js';
import { scheduleClose, cancelScheduledClose, getScheduledClose, nextCloseAt, closingNoticeField } from './close-scheduler.js';
import { getScheduledSnooze } from './snooze-scheduler.js';
import { isFrozen } from './freeze-state.js';

const log = createLogger('dormant-scheduler');

const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
// Caps notices + rename-sublimit load; the rest wait for the next sweep.
const MAX_CLOSES_PER_SWEEP = 10;

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

export function initDormantScheduler(client: Client): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => { void sweep(client); }, SWEEP_INTERVAL_MS);
  setTimeout(() => { void sweep(client); }, 60_000).unref();
}

export async function sweep(client: Client): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    if (await isFrozen()) return;
    const config = loadConfig();
    const guild = client.guilds.cache.get(config.guildId) ?? await client.guilds.fetch(config.guildId).catch(() => null);
    if (!guild) return;
    const forum = await getForum(guild, config.forumChannelId);
    if (!forum) return;

    const dormantAfterMs = config.dormantCloseDays * 24 * 60 * 60 * 1000;
    const reports = await StoredReport.listAll();
    let closed = 0;
    let reconciled = 0;
    let deferred = 0;

    // Most dormant first so the per-sweep cap spends itself on the stalest.
    // Only waiting-for-user reports: the ball is in the user's court, so a long
    // silence means they've lost interest. Dev-waiting reports are never auto-closed.
    const active = reports
      .filter(r => r.category === 'Needs your Attention')
      .sort((a, b) => a.data.lastActivityAt - b.data.lastActivityAt);

    for (const report of active) {
      if (closed >= MAX_CLOSES_PER_SWEEP) {
        deferred += active.length - active.indexOf(report);
        break;
      }
      const thread = await client.channels.fetch(report.threadId).catch(() => null);
      if (!thread?.isThread()) continue;
      const snoozed = report.category === 'Snoozed' || await getScheduledSnooze(thread.id).catch(() => undefined);
      if (snoozed) continue;
      const dormant = await isDormant(thread, report.data.lastActivityAt, dormantAfterMs);
      if (!dormant) continue;
      const did = await beginDormantClose(thread, config.dormantCloseDays, reportNoun(report.data.label));
      if (did) closed++;
    }

    for (const report of reports) {
      if (report.isActive) continue;
      const thread = await client.channels.fetch(report.threadId).catch(() => null);
      if (!thread?.isThread()) continue;
      const fixed = await reconcileClosedTags(thread, forum);
      if (fixed) reconciled++;
    }

    if (closed > 0 || reconciled > 0 || deferred > 0) {
      log.info({ closed, reconciled, deferred, total: reports.length }, 'Dormant sweep complete');
    }
  } catch (err) {
    log.warn({ err }, 'Dormant sweep failed');
  } finally {
    sweeping = false;
  }
}

async function isDormant(thread: ThreadChannel, storedActivity: number, thresholdMs: number): Promise<boolean> {
  let last = storedActivity;
  try {
    const messages = await thread.messages.fetch({ limit: 1 });
    const newest = messages.last();
    if (newest) last = Math.max(last, newest.createdTimestamp ?? 0);
  } catch (err) {
    // Stored activity can be stale (backfill only knew createdTimestamp).
    log.warn({ err, threadId: thread.id }, 'Failed to read last message for dormancy check; skipping');
    return false;
  }
  if (last > 0 && Date.now() - last < thresholdMs) {
    // Write the fresher activity back so the next sweep can skip the fetch.
    if (last > storedActivity) await StoredReport.update(thread.id, { lastActivityAt: last });
    return false;
  }
  return true;
}

async function beginDormantClose(thread: ThreadChannel, dormantDays: number, noun: string): Promise<boolean> {
  const closeAt = nextCloseAt();
  const notice = new EmbedBuilder()
    .setColor(COLORS.amber)
    .setTitle('💤 Dormant Report')
    .setDescription(`No activity for ${dormantDays} days - this ${noun} will close automatically. Reply here before it closes to keep it open.`)
    .addFields(closingNoticeField(closeAt))
    .setTimestamp();
  const noticeMsg = await thread.send({ embeds: [notice] }).catch(err => {
    log.warn({ err, threadId: thread.id }, 'Failed to post dormant-close notice');
    return null;
  });
  const scheduled = await scheduleClose(thread, 'closed', closeAt, noticeMsg?.id ?? '', 'dormant');
  if (!scheduled) {
    await noticeMsg?.delete().catch(() => {});
    return false;
  }
  log.info({ threadId: thread.id }, 'Scheduled dormant close');
  return true;
}

// Only dormant-origin closes are cancelled; staff/user closes stay authoritative.
async function cancelDormantCloseOnActivity(thread: ThreadChannel): Promise<void> {
  const entry = await getScheduledClose(thread.id);
  if (!entry || entry.origin !== 'dormant') return;
  const claimed = await cancelScheduledClose(thread.id);
  if (!claimed) return;
  await StoredReport.update(thread.id, { lastActivityAt: Date.now() });
  if (!claimed.noticeMessageId) return;
  const msg = await thread.messages.fetch(claimed.noticeMessageId).catch(() => null);
  const embed = msg?.embeds[0];
  if (!msg || !embed) return;
  const fields = (embed.fields ?? []).filter(f => !f.value.startsWith('⏳ Closing '));
  await msg.edit({
    embeds: [EmbedBuilder.from(embed).setColor(COLORS.green).setTitle('🔓 Close Cancelled').setFields(fields)],
  }).catch(err => log.warn({ err, threadId: thread.id }, 'Failed to finalize cancelled dormant-close notice'));
  log.info({ threadId: thread.id }, 'Dormant close cancelled by new activity');
}

// Fixes tag drift on already-closed threads without touching lock state.
async function reconcileClosedTags(thread: ThreadChannel, forum: import('discord.js').ForumChannel): Promise<boolean> {
  const tagNameById = new Map(forum.availableTags.map(t => [t.id, t.name.toUpperCase()]));
  const live = (thread.appliedTags as string[]).map(id => tagNameById.get(id) ?? '');
  const hasClosed = live.includes('CLOSED') || live.includes('FIXED');
  const needsFix =
    !hasClosed ||
    live.includes('OPEN') || live.includes('WAITING FOR DEV') || live.includes('WAITING FOR USER');
  if (!needsFix) return false;
  // Discord rejects applied_tags edits on archived threads (50083), so unarchive
  // for the swap and restore the archived state after.
  const wasArchived = thread.archived;
  if (wasArchived) await thread.setArchived(false).catch(() => {});
  await swapForumTags(thread, forum, { remove: ['OPEN', 'WAITING FOR DEV', 'WAITING FOR USER'], add: ['CLOSED'] });
  if (wasArchived) await thread.setArchived(true).catch(() => {});
  await StoredReport.syncFromThread(thread);
  return true;
}

@Discord()
export class DormantCloseCancelHandler {
  @On({ event: Events.MessageCreate })
  async cancelOnReply([message]: ArgsOf<Events.MessageCreate>) {
    if (message.author.bot) return;
    const channel = message.channel;
    if (!channel.isThread()) return;
    if (!channel.parentId) return;
    if (channel.parentId !== loadConfig().forumChannelId) return;
    await cancelDormantCloseOnActivity(channel).catch(err =>
      log.warn({ err, threadId: channel.id }, 'Dormant-close cancel failed'));
  }
}
