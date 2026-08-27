import { Discord, Slash, Guild } from 'discordx';
import type { CommandInteraction, ForumChannel, Guild as DiscordGuild, ThreadChannel } from 'discord.js';
import { GuildMember, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { createLogger } from '../../logger.js';
import { StoredReport, type StoredReportData } from './report-store.js';
import { getForum } from './route-tracker.js';
import { resolveSubmitterId } from './report-actions.js';
import { extractTicketId } from './my-reports.js';
import { loadConfig } from '../../config.js';

const log = createLogger('backfill');

const LABELS = ['Bug Report', 'Feature Request', 'Feedback'] as const;

export interface BackfillResult {
  scanned: number;
  recorded: number;
  updated: number;
  skipped: number;
}

/** Seeds/reconciles the store from full forum history. */
export async function backfillReports(guild: DiscordGuild, forum: ForumChannel): Promise<BackfillResult> {
  const threads = await enumerateForumThreads(forum);
  const result: BackfillResult = { scanned: threads.length, recorded: 0, updated: 0, skipped: 0 };

  for (let i = 0; i < threads.length; i += 5) {
    const chunk = threads.slice(i, i + 5);
    await Promise.all(chunk.map(async thread => {
      try {
        const existing = await StoredReport.get(thread.id);
        const reporterId = existing?.reporterId || await resolveSubmitterId(thread, guild);
        if (!reporterId) {
          result.skipped++;
          return;
        }
        const data: StoredReportData = {
          threadId: thread.id,
          ticketId: existing?.data.ticketId ?? extractTicketId(thread.name, thread.id),
          reporterId,
          label: existing?.data.label ?? labelFromName(thread.name),
          threadName: thread.name,
          url: thread.url,
          tagNames: tagNamesOf(thread, forum),
          createdTimestamp: thread.createdTimestamp ?? existing?.data.createdTimestamp ?? 0,
          lastActivityAt: Math.max(existing?.data.lastActivityAt ?? 0, thread.createdTimestamp ?? 0),
        };
        await StoredReport.record(data);
        if (existing) result.updated++;
        else result.recorded++;
      } catch (err) {
        log.warn({ err, threadId: thread.id }, 'Backfill: failed to process thread');
        result.skipped++;
      }
    }));
    log.info({ done: Math.min(i + 5, threads.length), total: threads.length }, 'Backfill progress');
  }

  return result;
}

function labelFromName(name: string): string {
  for (const label of LABELS) if (name.includes(label)) return label;
  return name.startsWith('✂️') ? 'Split' : 'Report';
}

function tagNamesOf(thread: ThreadChannel, forum: ForumChannel): string[] {
  const tagNameById = new Map(forum.availableTags.map(t => [t.id, t.name]));
  return (thread.appliedTags as string[]).map(id => tagNameById.get(id) ?? '');
}

// Bots can't use Discord's message search, so enumerate forum threads instead.
async function enumerateForumThreads(forum: ForumChannel): Promise<ThreadChannel[]> {
  const [active, firstArchived] = await Promise.all([
    forum.threads.fetchActive().catch(() => null),
    forum.threads.fetchArchived({ limit: 100 }).catch(() => null),
  ]);

  const threads: ThreadChannel[] = [];
  if (active) threads.push(...active.threads.values());

  let page = firstArchived;
  let guard = 0;
  while (page && guard++ < 100) {
    threads.push(...page.threads.values());
    if (!page.hasMore || page.threads.size === 0) break;
    const earliest = page.threads.reduce((a, t) =>
      (t.archiveTimestamp ?? 0) < (a.archiveTimestamp ?? 0) ? t : a);
    page = await forum.threads.fetchArchived({ limit: 100, before: earliest }).catch(() => null);
  }
  return threads;
}

@Discord()
@Guild(loadConfig().guildId)
export class BackfillCommands {
  @Slash({
    description: 'Backfill the report store from the full report forum history',
    name: 'backfill-reports',
    defaultMemberPermissions: PermissionFlagsBits.ManageThreads,
  })
  async backfill(interaction: CommandInteraction) {
    if (!(interaction.member instanceof GuildMember) ||
        !interaction.member.roles.cache.has(loadConfig().staffRole)) {
      await interaction.reply({ content: 'Only staff can run a backfill.', flags: MessageFlags.Ephemeral });
      return;
    }
    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const forum = await getForum(guild, loadConfig().forumChannelId);
    if (!forum) {
      await interaction.editReply({ content: 'Report forum not found.' });
      return;
    }
    const result = await backfillReports(guild, forum);
    await interaction.editReply({
      content: 'Backfill complete: scanned **' + result.scanned + '** thread(s) - recorded **' +
        result.recorded + '**, updated **' + result.updated + '**, skipped **' + result.skipped + '**.',
    });
  }
}
