import type { Guild, ThreadChannel } from 'discord.js';
import {
  GuildMember,
  MessageFlags,
  ForumChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { LRUCache } from 'lru-cache';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { COLORS, formatGitBranch, formatGitCommit } from '../../util.js';
import { stripLeadingEmoji } from './title-sync.js';
import {
  parseRouteComponents,
  fetchRouteMetadata,
  secondsToSegment,
  segmentToSeconds,
  validateRoute,
  type ExtractedRoute,
  type RouteComponents,
  type RouteProvider,
} from '../../comma.js';
import { konikViewerUrl, getKonikRouteInfo } from '../../konik.js';

const log = createLogger('route-tracker');

export const TRACKER_FIELD_PREFIX = '[Mods Route Tracker \u2192]';
export const ORIGINAL_POST_PREFIX = '[Original Post \u2192]';

const STATUS_EMOJI = {
  public: '\uD83C\uDF0E',
  private: '\u26AB',
  logs: '\uD83D\uDCDC',
  noLogs: '\u26A0\uFE0F',
  refresh: '\uD83D\uDD04',
} as const;

export const STATUS_LEGEND =
  `${STATUS_EMOJI.public} = public | ${STATUS_EMOJI.private} = private | ` +
  `${STATUS_EMOJI.logs} = logs | ${STATUS_EMOJI.noLogs} = no/partial logs`;

const STATUS_PREFIX_RE = new RegExp(
  `^(?:${STATUS_EMOJI.public} (?:${STATUS_EMOJI.logs}|${STATUS_EMOJI.noLogs}) |${STATUS_EMOJI.private} )`,
  'u',
);

function routeStatusEmoji(r: ExtractedRoute): string {
  if (r.public === undefined) return '';
  if (!r.public) return `${STATUS_EMOJI.private} `;
  return `${STATUS_EMOJI.public} ${r.rlogsAvailable ? STATUS_EMOJI.logs : STATUS_EMOJI.noLogs} `;
}

function routeLinkUrl(r: ExtractedRoute): string {
  if (r.provider === 'konik') {
    const seg = r.originalText?.match(/^https:\/\/(?:useradmin\.konik\.ai\/\?onebox=|stable\.konik\.ai\/)[a-f0-9]{16}(?:%7C|[|\/])[a-f0-9]{8}--[a-f0-9]{10}(\/\d+(?:\/\d+)?)?\/?$/i);
    return `${konikViewerUrl(r.dongleId, r.routeName)}${seg?.[1] ?? ''}`;
  }
  const orig = r.originalText;
  if (orig && /^https:\/\/connect\.comma\.ai\//i.test(orig)) return orig;
  if (orig) {
    const m = orig.match(/^[a-f0-9]{16}[\/|][a-f0-9]{8}--[a-f0-9]{10}(?:\/(\d+)(?:\/(\d+))?)?$/i);
    if (m && m[1] !== undefined) {
      const s1 = segmentToSeconds(parseInt(m[1], 10));
      const s2 = m[2] !== undefined ? segmentToSeconds(parseInt(m[2], 10)) : null;
      return `https://connect.comma.ai/${r.dongleId}/${r.routeName}/${s1}${s2 !== null ? '/' + s2 : ''}`;
    }
  }
  return `https://connect.comma.ai/${r.dongleId}/${r.routeName}`;
}

function routeShortForm(r: ExtractedRoute): string {
  const orig = r.originalText;
  const base = `${r.dongleId}/${r.routeName}`;
  if (orig) {
    const url = orig.match(/^https:\/\/connect\.comma\.ai\/[a-f0-9]{16}\/[a-f0-9]{8}--[a-f0-9]{10}(?:\/(\d+)(?:\/(\d+))?)?\/?$/i)
      ?? orig.match(/^https:\/\/(?:useradmin\.konik\.ai\/\?onebox=|stable\.konik\.ai\/)[a-f0-9]{16}(?:%7C|[|\/])[a-f0-9]{8}--[a-f0-9]{10}(?:\/(\d+)(?:\/(\d+))?)?\/?$/i);
    if (url) {
      if (url[1] === undefined) return base;
      const seg1 = secondsToSegment(url[1]);
      if (url[2] === undefined) return `${base}/${seg1}`;
      const seg2 = secondsToSegment(url[2]);
      return `${base}/${seg1}/${seg2}`;
    }
    const hex = orig.match(/^[a-f0-9]{16}[\/|][a-f0-9]{8}--[a-f0-9]{10}\/([a-f0-9]{8}--[a-f0-9]{10})$/i);
    if (hex) return `${base}/${hex[1]}`;
    const bare = orig.match(/^[a-f0-9]{16}[\/|][a-f0-9]{8}--[a-f0-9]{10}(?:\/(\d+)(?:\/(\d+))?)?$/i);
    if (bare && bare[1] !== undefined) {
      return bare[2] !== undefined ? `${base}/${bare[1]}/${bare[2]}` : `${base}/${bare[1]}`;
    }
  }
  return r.iteration ? `${base}/${r.iteration}` : base;
}

export function routeNumberLabel(routeNumber: number): string {
  return `**[Route ${routeNumber}]**`;
}

export function routeLinkMarkdown(r: ExtractedRoute, sharedAt: number = Date.now()): string {
  const url = routeLinkUrl(r);
  const short = routeShortForm(r);
  const original = r.originalText ?? short;
  const linkText = r.routeNumber ? `Route ${r.routeNumber}` : 'Route';
  const konikMark = r.provider === 'konik' ? '\ud83d\udc34 ' : '';
  const ts = `<t:${Math.floor(sharedAt / 1000)}:f>`;
  return `${routeStatusEmoji(r)}${konikMark}[${linkText}](${url}) \u2014 \`${short}\` \u2014 ${ts} \u2014 ||\`${original}\`||`;
}

export function buildConfirmRows(
  routes: Array<{ dongleId: string; routeName: string; iteration?: string; provider?: RouteProvider }>,
  ticketId: string,
  userId: string,
): ActionRowBuilder<ButtonBuilder>[] {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  // Different mentions (URL vs bare, different segments) can resolve to the same
  // underlying route + iteration; dedupe so custom_ids stay unique.
  const seen = new Set<string>();
  for (const r of routes) {
    const key = `${r.dongleId}/${r.routeName}/${r.iteration ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (rows.length === 0 || rows[rows.length - 1].components.length >= 3) {
      rows.push(new ActionRowBuilder<ButtonBuilder>());
    }
    rows[rows.length - 1].addComponents(
      new ButtonBuilder()
        .setCustomId(encodeConfirmCustomId(ticketId, userId, r.dongleId, r.routeName, r.provider ?? 'comma', r.iteration))
        .setLabel(`Confirm ${r.dongleId.slice(0, 8)}`)
        .setStyle(ButtonStyle.Primary)
        .setEmoji('\uD83D\uDCCD'),
    );
  }
  return rows;
}

export function buildRefreshRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('refresh_routes')
      .setLabel('Refresh Status')
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(STATUS_EMOJI.refresh),
  );
}

export function encodeConfirmCustomId(
  ticketId: string,
  userId: string,
  dongleId: string,
  routeName: string,
  provider: RouteProvider,
  iteration?: string,
): string {
  return `cr_${ticketId}_${userId}_${dongleId}_${routeName}_${provider}${iteration ? '_' + iteration : ''}`;
}

export function parseConfirmCustomId(
  customId: string,
): { ticketId: string; userId: string; dongleId: string; routeName: string; provider: RouteProvider; iteration?: string } | null {
  const parts = customId.split('_');
  if (parts.length < 6 || parts[0] !== 'cr') return null;
  const provider: RouteProvider = parts[5] === 'konik' ? 'konik' : 'comma';
  return { ticketId: parts[1], userId: parts[2], dongleId: parts[3], routeName: parts[4], provider, iteration: parts[6] || undefined };
}

const REFRESH_COOLDOWN_MS = 60_000;
export const refreshCooldowns = new LRUCache<string, number>({ max: 500, ttl: REFRESH_COOLDOWN_MS });

export async function postRouteMetadata(channel: ThreadChannel, dongleId: string, routeName: string, provider: RouteProvider = 'comma'): Promise<void> {
  if (provider === 'konik') return postKonikRouteMetadata(channel, dongleId, routeName);
  const meta = await fetchRouteMetadata(dongleId, routeName);
  if (!meta) return;
  const embed = new EmbedBuilder()
    .setColor(COLORS.amber)
    .setTitle('Route Metadata')
    .addFields(
      { name: 'Route ID', value: `${dongleId}/${routeName}`, inline: true },
      { name: 'Start Time', value: `<t:${Math.floor(meta.start_time_utc_millis / 1000)}:f>`, inline: true },
      { name: 'End Time', value: `<t:${Math.floor(meta.end_time_utc_millis / 1000)}:f>`, inline: true },
      { name: 'Git Remote', value: meta.git_remote, inline: true },
      { name: 'Git Branch', value: formatGitBranch(meta.git_branch, meta.git_remote), inline: true },
      { name: 'Git Commit', value: formatGitCommit(meta.git_commit, meta.git_remote), inline: true },
      { name: 'Git Commit Date', value: meta.git_commit_date, inline: true },
      { name: 'Git Dirty', value: String(meta.git_dirty), inline: true },
    );
  await channel.send({ embeds: [embed] }).catch(err => log.warn({ err }, 'Failed to post route metadata'));
}

async function postKonikRouteMetadata(channel: ThreadChannel, dongleId: string, routeName: string): Promise<void> {
  const { metadata } = await getKonikRouteInfo(dongleId, routeName);
  if (!metadata) return;
  const remote = metadata.gitRemote ? metadata.gitRemote.replace(/^https?:\/\//, '').replace(/\.git$/, '') : '';
  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: 'Route ID', value: `${dongleId}/${routeName}`, inline: true },
  ];
  if (metadata.gitRemote) fields.push({ name: 'Git Remote', value: metadata.gitRemote, inline: true });
  if (metadata.gitBranch) fields.push({ name: 'Git Branch', value: formatGitBranch(metadata.gitBranch, remote), inline: true });
  if (metadata.gitCommit) fields.push({ name: 'Git Commit', value: formatGitCommit(metadata.gitCommit, remote), inline: true });
  if (metadata.gitDirty !== undefined) fields.push({ name: 'Git Dirty', value: String(metadata.gitDirty), inline: true });
  if (metadata.platform) fields.push({ name: 'Platform', value: metadata.platform, inline: true });
  const embed = new EmbedBuilder().setColor(COLORS.amber).setTitle('Route Metadata (Konik)').addFields(...fields);
  await channel.send({ embeds: [embed] }).catch(err => log.warn({ err }, 'Failed to post konik route metadata'));
}

function migrateFieldsToDescription(embed: { fields?: Array<{ name: string; value: string; inline?: boolean }> }, builder: EmbedBuilder): string {
  if (builder.data.description) return builder.data.description;

  const parts: string[] = [];
  const keptFields: Array<{ name: string; value: string; inline?: boolean }> = [];

  for (const field of embed.fields ?? []) {
    if (field.name === 'Route') {
      parts.push(`**Route**\n${field.value}`);
    } else if (field.name === 'Additional Routes') {
      parts.push(`**Additional Routes**\n${field.value}`);
    } else {
      keptFields.push(field);
    }
  }

  if (parts.length === 0) return '';

  const desc = parts.join('\n');
  builder.setDescription(desc);
  builder.setFields(...keptFields);
  return desc;
}

const ROUTE_HEADER = '**Route**';
const ADDITIONAL_HEADER = '**Additional Routes**';
const MAX_DESC_LENGTH = 4096;
const DESC_SAFETY_MARGIN = 64;

export interface ParsedTrackerDescription {
  primaryLine: string | null;
  additionalLines: string[];
}

export function parseTrackerDescription(desc: string | undefined | null): ParsedTrackerDescription {
  if (!desc) return { primaryLine: null, additionalLines: [] };
  const lines = desc.split('\n');
  let primaryLine: string | null = null;
  const additionalLines: string[] = [];
  let section: 'primary' | 'additional' | null = null;
  for (const raw of lines) {
    const line = raw;
    if (line === ROUTE_HEADER) {
      section = 'primary';
      continue;
    }
    if (line === ADDITIONAL_HEADER) {
      section = 'additional';
      continue;
    }
    if (!line.trim()) continue;
    if (section === 'primary' && primaryLine === null) primaryLine = line;
    else if (section === 'additional') additionalLines.push(line);
  }
  return { primaryLine, additionalLines };
}

export function buildTrackerDescription(primaryLine: string | null, additionalLines: string[]): string {
  const sections: string[] = [];
  if (primaryLine) sections.push(`${ROUTE_HEADER}\n${primaryLine}`);

  if (additionalLines.length > 0) {
    const primarySection = primaryLine ? `${ROUTE_HEADER}\n${primaryLine}\n` : '';
    const header = `${ADDITIONAL_HEADER}\n`;
    const truncationNoticeMax = `\n_…N older route(s) omitted (tracker limit)._`.length;
    const budget = MAX_DESC_LENGTH - DESC_SAFETY_MARGIN - primarySection.length - header.length - truncationNoticeMax;

    const kept: string[] = [];
    let used = 0;
    for (let i = additionalLines.length - 1; i >= 0; i--) {
      const line = additionalLines[i];
      const cost = line.length + 1;
      if (cost > budget) continue;
      if (used + cost > budget && kept.length > 0) break;
      kept.unshift(line);
      used += cost;
    }

    let section = header + kept.join('\n');
    const omitted = additionalLines.length - kept.length;
    if (omitted > 0) {
      section += `\n_…${omitted} older route(s) omitted (tracker limit)._`;
    }
    sections.push(section);
  }

  return sections.join('\n');
}

async function refreshRouteLine(line: string): Promise<string> {
  const shortMatch = line.match(/`([^`]+)`/);
  if (!shortMatch) return line;
  let components: RouteComponents;
  try {
    components = parseRouteComponents(shortMatch[1]);
  } catch {
    return line;
  }
  const urlMatch = line.match(/\]\((https?:\/\/[^)]+)\)/);
  const provider: RouteProvider = urlMatch && /konik\.ai/i.test(urlMatch[1]) ? 'konik' : (components.provider ?? 'comma');
  const v = await validateRoute(components.dongleId, components.routeName, components.startSegment, components.endSegment, provider);
  if (!v.valid) return line;
  const emoji = routeStatusEmoji({
    dongleId: components.dongleId,
    routeName: components.routeName,
    public: v.public,
    rlogsAvailable: v.rlogsAvailable,
  });
  return emoji + line.replace(STATUS_PREFIX_RE, '');
}

export async function handleRefreshRoutes(interaction: import('discord.js').ButtonInteraction): Promise<void> {
  if (!(interaction.member instanceof GuildMember) || !interaction.member.roles.cache.hasAny(...loadConfig().staffRoles)) {
    await interaction.reply({ content: 'Only staff can refresh route status.', flags: MessageFlags.Ephemeral });
    return;
  }

  const key = interaction.message.id;
  const remaining = refreshCooldowns.getRemainingTTL(key);
  if (remaining > 0) {
    await interaction.reply({
      content: `This tracker was just refreshed. Try again in ${Math.ceil(remaining / 1000)}s.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  refreshCooldowns.set(key, Date.now());

  await interaction.deferUpdate();

  const embed = interaction.message.embeds[0];
  if (!embed) {
    await interaction.followUp({ content: 'No route tracker embed to refresh.', flags: MessageFlags.Ephemeral });
    return;
  }

  const updated = EmbedBuilder.from(embed);
  const desc = migrateFieldsToDescription(embed, updated);
  if (desc) {
    const lines = desc.split('\n');
    updated.setDescription((await Promise.all(lines.map(refreshRouteLine))).join('\n'));
  }

  if (interaction.channel?.isThread()) await reopenIfArchived(interaction.channel);
  await interaction.message.edit({ embeds: [updated] }).catch(err =>
    log.error({ err }, 'Failed to refresh route tracker'),
  );
}

// Callers resolve an existing tracker via the OP's stored URL; this only creates.
export async function createRouteTrackerThread(
  guild: Guild,
  config: ReturnType<typeof loadConfig>,
  primaryRoute: ExtractedRoute | undefined,
  threadUrl: string,
  publicThreadTitle: string,
): Promise<{ url: string; threadId: string } | null> {
  const routesForum = await getForum(guild, config.routesChannelId);
  if (!routesForum) return null;
  const title = stripLeadingEmoji(publicThreadTitle).trimStart();
  const primaryLink = primaryRoute ? routeLinkMarkdown(primaryRoute) : null;

  const routeEmbed = new EmbedBuilder()
    .setColor(COLORS.amber)
    .setTitle(title)
    .setFooter({ text: STATUS_LEGEND })
    .setTimestamp();
  if (primaryLink) {
    routeEmbed.setDescription(`**Route**\n${primaryLink}`);
  }

  const routesThread = await routesForum.threads.create({
    name: title,
    message: { embeds: [routeEmbed] },
  });

  const starter = await routesThread.fetchStarterMessage();
  if (starter) {
    routeEmbed.addFields(
      { name: '\u200B', value: `${ORIGINAL_POST_PREFIX}(${threadUrl})` },
    );
    await starter.edit({ embeds: [routeEmbed], components: [buildRefreshRow()] });
  }

  if (primaryRoute?.public) {
    await postRouteMetadata(routesThread, primaryRoute.dongleId, primaryRoute.routeName, primaryRoute.provider);
  }

  return { url: routesThread.url, threadId: routesThread.id };
}

async function reopenIfArchived(thread: ThreadChannel): Promise<void> {
  if (!thread.archived) return;
  await thread.setArchived(false).catch(err =>
    log.warn({ err, threadId: thread.id }, 'Failed to reopen archived tracker thread'));
}

export async function addAdditionalRoutesToTracker(
  guild: Guild,
  threadId: string,
  additionalRoutes: ExtractedRoute[],
  sourceUrl?: string,
  sourceName?: string,
): Promise<void> {
  if (additionalRoutes.length === 0) return;
  try {
    const channel = await guild.channels.fetch(threadId);
    if (!channel?.isThread()) return;
    await reopenIfArchived(channel);
    const starter = await channel.fetchStarterMessage();
    if (!starter) return;
    const embed = starter.embeds[0];
    if (!embed) return;
    const updated = EmbedBuilder.from(embed);
    const existingDesc = migrateFieldsToDescription(embed, updated);
    const { primaryLine, additionalLines: existingAdditional } = parseTrackerDescription(existingDesc);
    const seenShort = new Set<string>();
    for (const line of existingAdditional) {
      const m = line.match(/`([^`]+)`/);
      if (m) seenShort.add(m[1]);
    }
    const newRoutes = additionalRoutes.filter(r => {
      const short = routeShortForm(r);
      if (seenShort.has(short)) return false;
      seenShort.add(short);
      return true;
    });
    const newLinks = newRoutes.map(r => {
      const base = routeLinkMarkdown(r);
      return sourceUrl && sourceName ? `${base} \u2014 [${sourceName}](${sourceUrl})` : base;
    });
    if (newLinks.length === 0) return;
    const desc = buildTrackerDescription(primaryLine, [...existingAdditional, ...newLinks]);
    updated.setDescription(desc);
    await starter.edit({ embeds: [updated] });
    const postedMeta = new Set<string>();
    for (const r of newRoutes) {
      if (r.public) {
        const key = `${r.dongleId}/${r.routeName}`;
        if (!postedMeta.has(key)) {
          postedMeta.add(key);
          await postRouteMetadata(channel, r.dongleId, r.routeName, r.provider);
        }
      }
    }
  } catch (err) {
    log.warn({ err }, 'Failed to add additional routes to tracker');
  }
}

export async function getForum(guild: Guild, id: string): Promise<ForumChannel | null> {
  const cached = guild.channels.cache.get(id);
  if (cached instanceof ForumChannel) return cached;
  try {
    const ch = await guild.channels.fetch(id);
    return ch instanceof ForumChannel ? ch : null;
  } catch (err) {
    log.warn({ err }, 'Failed to fetch forum channel');
    return null;
  }
}
