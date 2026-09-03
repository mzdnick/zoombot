import type { ForumChannel, ModalSubmitInteraction, ButtonInteraction, ThreadChannel } from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { loadConfig, type BotConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { getIndex } from '../../wiki/wiki.js';
import { searchWiki, formatWikiResults } from '../../wiki/searcher.js';
import { getForum, createRouteTrackerThread, addAdditionalRoutesToTracker, encodeConfirmCustomId, buildConfirmRows, TRACKER_FIELD_PREFIX } from './route-tracker.js';
import { StoredReport } from './report-store.js';
import { isFrozen } from './freeze-state.js';
import { STATUS_EMOJI, isRateLimit } from './title-sync.js';
import type { ExtractedRoute, RouteValidation } from '../../comma.js';

const log = createLogger('report-service');

let shareRouteCommandId: string | null = null;
let shareRouteResolved = false;

async function getShareRouteCommandId(guild: import('discord.js').Guild): Promise<string | null> {
  if (!shareRouteResolved) {
    try {
      const cmds = await guild.commands.fetch();
      shareRouteCommandId = cmds.find(c => c.name === 'share-route')?.id ?? null;
      shareRouteResolved = true;
    } catch (err) {
      log.warn({ err }, 'Failed to fetch guild commands for share-route link');
    }
  }
  return shareRouteCommandId;
}

export function resolveTagIds(forum: ForumChannel, names: string[]): string[] {
  return names
    .map(name => forum.availableTags.find(t => t.name === name)?.id)
    .filter((id): id is string => id != null);
}

export function buildActionRow(ticketId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`additional_report_${ticketId}`)
      .setLabel('Additional Report')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji('📝'),
    new ButtonBuilder()
      .setCustomId(`staff_actions_${ticketId}`)
      .setLabel('Staff Actions')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('🛠️'),
  );
}

export function buildDonateRow(config: BotConfig, guildId: string): ActionRowBuilder<ButtonBuilder> | null {
  if (!config.donateChannelId) return null;
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setLabel('Donate')
      .setEmoji('💜')
      .setURL(`https://discord.com/channels/${guildId}/${config.donateChannelId}`),
  );
}

export function donateField(config: BotConfig): { name: string; value: string } | null {
  if (!config.donateChannelId) return null;
  return {
    name: '​',
    value: `-# 💜 StarPilot is free - if it has helped you, consider supporting it in <#${config.donateChannelId}>`,
  };
}

export async function swapForumTags(
  thread: ThreadChannel,
  forum: ForumChannel,
  opts: { add?: string[]; remove?: string[] },
): Promise<void> {
  const removeNames = new Set(opts.remove ?? []);
  const keep = (thread.appliedTags as string[]).filter(id => {
    const tag = forum.availableTags.find(t => t.id === id);
    return !tag || !removeNames.has(tag.name);
  });
  const addIds = opts.add ? resolveTagIds(forum, opts.add) : [];
  await thread.setAppliedTags([...new Set([...keep, ...addIds])]).catch((err: unknown) => {
    // Rate-limits must propagate so close paths can defer + retry (see closeThread).
    if (isRateLimit(err)) throw err;
    log.warn({ err }, 'Failed to swap forum tags');
  });
}

export function formatThreadTitle(emoji: string, label: string, title: string | null, ticketId: string | null): string {
  const MAX = 100;
  const suffix = ticketId ? ` (${ticketId})` : '';
  if (title) {
    const raw = `${emoji} ${label} - ${title}${suffix}`;
    if (raw.length <= MAX) return raw;
    const overhead = `${emoji} ${label} - ${suffix}`.length;
    const maxTitleLen = MAX - overhead;
    if (maxTitleLen <= 1) return ticketId ? `${emoji} ${label} - ${ticketId}` : `${emoji} ${label}`;
    const truncated = title.slice(0, maxTitleLen - 1) + '\u2026';
    return `${emoji} ${label} - ${truncated}${suffix}`;
  }
  return ticketId ? `${emoji} ${label} - ${ticketId}` : `${emoji} ${label}`;
}

async function addWikiSuggestions(embed: EmbedBuilder, query: string): Promise<void> {
  try {
    const wikiIndex = getIndex();
    if (wikiIndex) {
      const wikiResults = await searchWiki(wikiIndex, query);
      if (wikiResults.length > 0) {
        embed.addFields({ name: '📖 Potentially Related Wiki Articles', value: formatWikiResults(wikiResults) });
      }
    }
  } catch (err) {
    log.error({ err }, 'Failed to fetch wiki suggestions');
  }
}

export async function submitReport(
  interaction: ModalSubmitInteraction | ButtonInteraction,
  params: {
    embed: EmbedBuilder;
    title: Promise<string | null>;
    wikiQuery: string;
    dedicatedRoute?: ExtractedRoute & RouteValidation;
    additionalRoutes: Array<ExtractedRoute & RouteValidation>;
    label: string;
    tagNames: string[];
    primaryNonPublicRoute?: ExtractedRoute;
    footerNote?: string;
    reporterId: string;
  },
): Promise<void> {
  const config = loadConfig();
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: 'Could not resolve guild.' });
    return;
  }

  const forum = await getForum(guild, config.forumChannelId);
  if (!forum) {
    await interaction.editReply({ content: 'Forum channel not found. Contact an admin.' });
    return;
  }

  // Freezes block everyone, staff on behalf of included.
  if (await isFrozen()) {
    await interaction.editReply({ content: 'Reports are currently frozen - new submissions are paused.', components: [] });
    return;
  }

  // The cap throttles end users; staff acting on a user's behalf bypasses it.
  const limit = config.maxActiveReports;
  const onBehalfOf = params.reporterId !== interaction.user.id;
  const gated = limit > 0 && !onBehalfOf;

  // One closure so the gated path can hold the creation lock across check→create→record.
  const createThread = async (): Promise<{ thread: ThreadChannel; ticketId: string } | null> => {
    if (gated) {
      const active = await StoredReport.activeForUser(params.reporterId);
      if (active.length >= limit) {
        const lines = active.map(r => `- [${r.data.threadName}](${r.url})`).join('\n');
        await interaction.editReply({
          content: `You can only have **${limit}** active report thread(s) at a time. Please wait until one of yours is resolved, or add to an existing thread instead:\n${lines}`,
          components: [],
        });
        return null;
      }
    }

    const generatedTitle = await params.title.catch(() => null);
    const tagIds = params.tagNames.length > 0 ? resolveTagIds(forum, params.tagNames) : undefined;

    let thread;
    try {
      thread = await forum.threads.create({
        // Ticket id omitted here: adding it would need a post-create rename, spending
        // one of the 2-per-10-min title edits. title-sync folds it in on first status change.
        name: formatThreadTitle(STATUS_EMOJI['new'], params.label, generatedTitle, null),
        message: { content: `<@${params.reporterId}>`, embeds: [params.embed] },
        appliedTags: tagIds,
      });
    } catch (err) {
      log.error({ err }, 'Failed to create thread');
      await interaction.editReply({ content: 'Failed to create thread. Contact an admin.' });
      return null;
    }

    const ticketId = String(parseInt(thread.id.slice(-7), 10));

    await StoredReport.record({
      threadId: thread.id,
      ticketId,
      reporterId: params.reporterId,
      label: params.label,
      threadName: thread.name,
      url: thread.url,
      tagNames: params.tagNames,
      createdTimestamp: thread.createdTimestamp ?? Date.now(),
      lastActivityAt: Date.now(),
    });

    return { thread, ticketId };
  };

  const created = await (gated
    ? StoredReport.withCreationLock(params.reporterId, createThread)
    : createThread());
  if (!created) return;
  const { thread, ticketId } = created;

  params.embed.setTitle(`${params.label} ${ticketId}`);

  const dedicatedPublic = params.dedicatedRoute?.valid && params.dedicatedRoute.public ? params.dedicatedRoute : undefined;
  const additionalPublic = params.additionalRoutes.filter(r => r.valid && r.public);
  if (dedicatedPublic || additionalPublic.length > 0) {
    const tracker = await createRouteTrackerThread(
      guild, config, dedicatedPublic, thread.url, thread.name,
    );
    if (tracker) {
      params.embed.addFields({ name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${tracker.url})` });
      if (additionalPublic.length > 0) {
        await addAdditionalRoutesToTracker(guild, tracker.threadId, additionalPublic);
      }
    }
  }

  const nonPublic = params.additionalRoutes.filter(r => r.valid && !r.public);
  if (params.primaryNonPublicRoute) {
    const btn = new ButtonBuilder()
      .setCustomId(encodeConfirmCustomId(
        ticketId,
        params.reporterId,
        params.primaryNonPublicRoute.dongleId,
        params.primaryNonPublicRoute.routeName,
        params.primaryNonPublicRoute.provider ?? 'comma',
        params.primaryNonPublicRoute.iteration,
      ))
      .setLabel('Confirm Route')
      .setStyle(ButtonStyle.Primary)
      .setEmoji('📍');
    await thread.send({
      content: `<@${params.reporterId}> Your route is valid but not yet public. Once you've made it public, click the button below to link it to this report.\n\nNeed help? Follow [these instructions](<https://wiki.firestar.link/faq/#how-do-i-upload-logs-for-troubleshooting>).`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn)],
    }).catch(err => log.error({ err }, 'Failed to send primary confirm button'));
  }

  const remainingNonPublic = params.primaryNonPublicRoute
    ? nonPublic.filter(r => r.dongleId !== params.primaryNonPublicRoute!.dongleId || r.routeName !== params.primaryNonPublicRoute!.routeName)
    : nonPublic;
  if (remainingNonPublic.length > 0) {
    const confirmRows = buildConfirmRows(remainingNonPublic, ticketId, params.reporterId);
    await thread.send({
      content: `<@${params.reporterId}> Some additional routes are not yet public. Once you've made them public, click the button below to link them to this report.`,
      components: confirmRows,
    }).catch(err => log.error({ err }, 'Failed to send additional confirm buttons'));
  }

  await addWikiSuggestions(params.embed, params.wikiQuery);
  const donate = donateField(config);
  if (donate) params.embed.addFields(donate);
  const starter = await thread.fetchStarterMessage();
  if (starter) {
    const actionRow = buildActionRow(ticketId);
    await starter.edit({ embeds: [params.embed], components: [actionRow] }).catch(err => {
      log.error({ err }, 'Failed to edit starter message');
    });
    await starter.pin().catch(err => {
      log.error({ err }, 'Failed to pin starter message');
    });
  }

  const shareRouteId = await getShareRouteCommandId(guild);
  await thread.send(
    `Please do not send raw route URLs or route IDs in this thread. To share a new route, use the **Additional Report** button${shareRouteId ? ` or </share-route:${shareRouteId}>` : ' or the `/share-route` command'} instead.`,
  ).catch(err => {
    log.error({ err }, 'Failed to send route-sharing notice');
  });

  await interaction.editReply({
    content: `${params.label} **${ticketId}** submitted! [View thread](${thread.url})`,
    components: [],
  });
}
