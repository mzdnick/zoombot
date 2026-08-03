import { Discord, Slash, SlashOption, ButtonComponent, Guild } from 'discordx';
import type { CommandInteraction, ButtonInteraction, ThreadChannel } from 'discord.js';
import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { createStore } from '../store.js';
import { COLORS } from '../util.js';
import {
  parseRouteComponents,
  validateRoute,
  computeRouteLogIssues,
  type ExtractedRoute,
  type RouteValidation,
} from '../comma.js';
import {
  routeLinkMarkdown,
  getForum,
  postRouteMetadata,
  STATUS_LEGEND,
  buildRefreshRow,
} from './report/route-tracker.js';
import { submitAdditionalReport, findOpenReadyPrompt } from './report/report-actions.js';

const log = createLogger('share-route');

interface PendingShareRoute {
  routeIdInput: string;
  userId: string;
}

const PENDING_SHARE_TTL_MS = 15 * 60 * 1000;
const pendingStore = createStore<PendingShareRoute>('pending-share-routes', { ttl: PENDING_SHARE_TTL_MS });

function extractChannelAndDisplayName(
  interaction: CommandInteraction | ButtonInteraction,
): { sourceChannelName: string | undefined; displayName: string } {
  const sourceChannelName = interaction.channel && 'name' in interaction.channel
    ? (interaction.channel as { name: string }).name
    : undefined;
  const displayName = interaction.member && 'displayName' in interaction.member
    ? (interaction.member as import('discord.js').GuildMember).displayName
    : interaction.user.username;
  return { sourceChannelName, displayName };
}

function buildThreadTitle(
  routeCount: number,
  sourceChannelName: string | undefined,
  displayName: string,
  ticketId: string,
): string {
  const MAX = 100;
  const routeWord = routeCount > 1 ? 'Routes' : 'Route';
  const base = `📤 Shared ${routeWord}`;
  const idPart = `(${ticketId})`;

  const displayPart = ` by ${displayName}`;
  const channelPart = sourceChannelName ? ` (in ${sourceChannelName})` : '';

  let title = `${base}${channelPart}${displayPart} ${idPart}`;

  if (title.length <= MAX) return title;

  if (sourceChannelName) {
    const overhead = `${base} (in )${displayPart} ${idPart}`.length;
    const maxCh = MAX - overhead;
    if (maxCh >= 1) {
      const truncated = sourceChannelName.length > maxCh
        ? sourceChannelName.slice(0, maxCh - 1) + '…'
        : sourceChannelName;
      title = `${base} (in ${truncated})${displayPart} ${idPart}`;
    } else {
      title = `${base}${displayPart} ${idPart}`;
    }
  }

  if (title.length <= MAX) return title;

  const noChannelBase = `${base}${displayPart} ${idPart}`;
  if (noChannelBase.length <= MAX) return noChannelBase;

  const overhead = `${base} by  ${idPart}`.length;
  const maxName = MAX - overhead;
  if (maxName >= 1) {
    const truncated = displayName.length > maxName
      ? displayName.slice(0, maxName - 1) + '…'
      : displayName;
    return `${base} by ${truncated} ${idPart}`;
  }

  return `${base} ${idPart}`;
}

async function createSharedRouteThread(
  guild: import('discord.js').Guild,
  config: ReturnType<typeof loadConfig>,
  routes: Array<ExtractedRoute & RouteValidation>,
  sharedByUserId: string,
  interaction: CommandInteraction | ButtonInteraction,
  ticketId: string,
): Promise<{ url: string; threadId: string } | null> {
  const routesForum = await getForum(guild, config.routesChannelId);
  if (!routesForum) return null;

  const routeWord = routes.length > 1 ? 'Shared Routes' : 'Shared Route';
  const routeLinks = routes.map(r => routeLinkMarkdown(r)).join('\n');

  const { sourceChannelName, displayName } = extractChannelAndDisplayName(interaction);

  const threadTitle = buildThreadTitle(
    routes.length,
    sourceChannelName,
    displayName,
    ticketId,
  );

  const embed = new EmbedBuilder()
    .setColor(COLORS.amber)
    .setDescription(`**${routeWord}**\n${routeLinks}`)
    .addFields({ name: 'Shared by', value: `<@${sharedByUserId}>`, inline: true })
    .setFooter({ text: STATUS_LEGEND })
    .setTimestamp();

  let thread;
  try {
    thread = await routesForum.threads.create({
      name: threadTitle,
      message: { embeds: [embed] },
    });
  } catch (err) {
    log.error({ err }, 'Failed to create shared route thread');
    return null;
  }

  const postedMeta = new Set<string>();
  for (const r of routes) {
    if (r.public) {
      const key = `${r.dongleId}/${r.routeName}`;
      if (!postedMeta.has(key)) {
        postedMeta.add(key);
        await postRouteMetadata(thread, r.dongleId, r.routeName);
      }
    }
  }

  const starter = await thread.fetchStarterMessage().catch(() => null);
  if (starter) {
    await starter.edit({ components: [buildRefreshRow()] }).catch(err => log.error({ err }, 'Failed to add refresh button to shared route starter'));
    await starter.pin().catch(err => log.error({ err }, 'Failed to pin shared route starter'));
  }

  return { url: thread.url, threadId: thread.id };
}

async function processShareRoute(
  interaction: CommandInteraction | ButtonInteraction,
  routeIdInput: string,
  force: boolean,
): Promise<void> {
  const config = loadConfig();
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: 'Could not resolve guild.' });
    return;
  }

  const entries = routeIdInput.split(/[\s,]+/).filter(Boolean);
  const seen = new Set<string>();
  const unique = entries.filter(e => {
    const key = e.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (unique.length === 0) {
    await interaction.editReply({ content: 'No route IDs provided. Please provide at least one route ID or URL.' });
    return;
  }

  if (unique.length > 5) {
    await interaction.editReply({ content: 'You can share up to 5 routes at a time.' });
    return;
  }

  const parsed: Array<{ input: string; components: import('../comma.js').RouteComponents }> = [];
  const parseErrors: string[] = [];
  for (const entry of unique) {
    try {
      const components = parseRouteComponents(entry);
      parsed.push({ input: entry, components });
    } catch (err) {
      parseErrors.push(`\`${entry}\`: ${err instanceof Error ? err.message : 'Invalid format'}`);
    }
  }

  if (parseErrors.length > 0) {
    await interaction.editReply({
      content: `Could not parse the following route(s):\n${parseErrors.join('\n')}`,
    });
    return;
  }

  const validations = await Promise.all(
    parsed.map(p => validateRoute(p.components.dongleId, p.components.routeName, p.components.startSegment, p.components.endSegment, p.components.provider)),
  );

  const invalidEntries: string[] = [];
  for (let i = 0; i < validations.length; i++) {
    if (!validations[i].valid) {
      invalidEntries.push(`\`${parsed[i].input}\``);
    }
  }

  if (invalidEntries.length > 0) {
    await interaction.editReply({
      content: `The following route(s) don't appear to exist:\n${invalidEntries.join('\n')}\n\nPlease double-check and try again.`,
    });
    return;
  }

  const routes: Array<ExtractedRoute & RouteValidation> = parsed.map((p, i) => ({
    dongleId: p.components.dongleId,
    routeName: p.components.routeName,
    iteration: p.components.iteration,
    originalText: p.input,
    isUrl: /^https:\/\/connect\.comma\.ai\//i.test(p.input),
    routeNumber: parsed.length > 1 ? i + 1 : undefined,
    ...validations[i],
  }));

  if (!force) {
    const issues = computeRouteLogIssues(routes);

    if (issues.length > 0) {
      const token = interaction.id;
      await pendingStore.set(token, { routeIdInput, userId: interaction.user.id });

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`srchk_${token}`)
          .setLabel('Check Again')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🔄'),
        new ButtonBuilder()
          .setCustomId(`srfrc_${token}`)
          .setLabel('Share Anyway')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setLabel('Need help?')
          .setStyle(ButtonStyle.Link)
          .setURL('https://community.sunnypilot.ai/t/share-a-route/1916'),
      );

      await interaction.editReply({
        content: issues.join('\n'),
        components: [row],
      });
      return;
    }
  }

  const result = await createSharedRouteThread(
    guild,
    config,
    routes,
    interaction.user.id,
    interaction,
    '...',
  );

  if (!result) {
    await interaction.editReply({ content: 'Forum channel not found. Contact an admin.' });
    return;
  }

  const ticketId = String(parseInt(result.threadId.slice(-7), 10));

  const { sourceChannelName, displayName } = extractChannelAndDisplayName(interaction);

  let threadChannel = null;
  try {
    threadChannel = await guild.channels.fetch(result.threadId).catch(() => null);
    if (threadChannel?.isThread()) {
      await threadChannel.edit({ name: buildThreadTitle(routes.length, sourceChannelName, displayName, ticketId) }).catch(err => log.error({ err }, 'Failed to rename shared route thread with ticket id'));
    }
  } catch (err) {
    log.error({ err }, 'Failed to rename shared route thread with ticket id');
  }

  const routeWord = routes.length > 1 ? 'routes' : 'route';
  const channel = interaction.channel;
  const announcement = channel && 'send' in channel
    ? await (channel as import('discord.js').TextChannel).send(`📤 <@${interaction.user.id}> has shared ${routeWord} in the [Mods Route Tracker](${result.url}) for review.`).catch(() => null)
    : null;

  if (announcement && threadChannel?.isThread()) {
    const starter = await threadChannel.fetchStarterMessage().catch(() => null);
    if (starter) {
      const embed = EmbedBuilder.from(starter.embeds[0]!);
      embed.addFields({ name: '\u200B', value: `[Shared from post \u2192](${announcement.url})` });
      await starter.edit({ embeds: [embed] }).catch(err => log.error({ err }, 'Failed to add back-link to shared route thread'));
    }
  }

  await interaction.editReply({ content: '✅ Shared.', components: [] });
}

async function runShareRouteAsAdditionalReport(
  interaction: CommandInteraction,
  thread: ThreadChannel,
  routeId: string,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.editReply({ content: 'Could not resolve guild.' });
    return;
  }

  const entries = routeId.split(/[\s,]+/).filter(Boolean);
  if (entries.length === 0) {
    await interaction.editReply({ content: 'No route IDs provided. Please provide at least one route ID or URL.' });
    return;
  }
  if (entries.length > 5) {
    await interaction.editReply({ content: 'You can share up to 5 routes at a time.' });
    return;
  }

  const [primaryRoute, ...extraRoutes] = entries;
  const detailsWithExtraRoutes = extraRoutes.join('\n');

  const readyMsg = await findOpenReadyPrompt(thread);

  await submitAdditionalReport({
    interaction, thread, guild, userId: interaction.user.id,
    routeInput: primaryRoute, details: detailsWithExtraRoutes,
    ready: readyMsg ? { readyMsgId: readyMsg.id } : null,
    force: false,
  });
}

const guildId = loadConfig().guildId;

@Discord()
@Guild(guildId)
export class BotShareRoute {
  @Slash({
    name: 'share-route',
    description: 'Share route(s) for staff review. Multiple routes/URLs separated by spaces or commas.',
  })
  async shareRoute(
    @SlashOption({
      name: 'route_id',
      description: 'One or more route IDs/URLs, separated by spaces or commas (max 5).',
      required: true,
      type: ApplicationCommandOptionType.String,
      maxLength: 600,
    })
    routeId: string,
    interaction: CommandInteraction,
  ) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const channel = interaction.channel;
    if (channel?.isThread() && channel.parentId === loadConfig().forumChannelId) {
      await runShareRouteAsAdditionalReport(interaction, channel, routeId);
      return;
    }
    await processShareRoute(interaction, routeId, false);
  }

  @ButtonComponent({ id: /^srchk_/ })
  async shareCheck(interaction: ButtonInteraction) {
    const token = interaction.customId.split('_')[1];
    const pending = await pendingStore.get(token);
    if (!pending) {
      await interaction.reply({
        content: 'This request has expired. Please run `/share-route` again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.user.id !== pending.userId) {
      await interaction.reply({
        content: 'Only the original sharer can use this.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferUpdate();
    await processShareRoute(interaction, pending.routeIdInput, false);
  }

  @ButtonComponent({ id: /^srfrc_/ })
  async shareForce(interaction: ButtonInteraction) {
    const token = interaction.customId.split('_')[1];
    const pending = await pendingStore.get(token);
    if (!pending) {
      await interaction.reply({
        content: 'This request has expired. Please run `/share-route` again.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.user.id !== pending.userId) {
      await interaction.reply({
        content: 'Only the original sharer can use this.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferUpdate();
    await processShareRoute(interaction, pending.routeIdInput, true);
  }
}
