import type { ButtonComponent, Client, ForumChannel, Guild, Message } from 'discord.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { COLORS } from '../../util.js';
import { StoredReport } from './report-store.js';
import { getForum } from './route-tracker.js';
import { extendSnoozesAfterThaw } from './snooze-scheduler.js';
import { dormantBumpedAt, getFreeze, saveFreeze, patchFreeze, clearFreeze, type FreezeRecord } from './freeze-state.js';

const log = createLogger('freeze');

export const THAW_BUTTON_ID = 'freeze_thaw';
const REPORT_BUTTON_IDS = ['report_bug', 'report_feedback', 'report_feature'];

// ---- Banner -------------------------------------------------------------

export function freezeBannerEmbed(record: FreezeRecord): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLORS.amber)
    .setTitle('\u2744\uFE0F Reports Frozen')
    .setDescription(record.message)
    .setTimestamp(record.startedAt);
  if (record.expiresAt) {
    embed.addFields({ name: '\u200B', value: `Thaws <t:${Math.floor(record.expiresAt / 1000)}:R>` });
  }
  return embed;
}

export function bannerLink(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

// ---- Button message -----------------------------------------------------

async function findReportButtonMessage(client: Client, channelId: string): Promise<Message | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) return null;
  const pins = await channel.messages.fetchPins().catch(() => null);
  const pinned = pins?.items.find(({ message: m }) => m.author.id === client.user!.id && m.components.length > 0)?.message ?? null;
  if (pinned) return pinned;
  const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
  return messages?.find(m => m.author.id === client.user!.id && m.components.some(row => row.type === 1 && row.components.some(c => c.type === 2 && REPORT_BUTTON_IDS.includes(c.customId ?? '')))) ?? null;
}

export async function setReportButtonsDisabled(client: Client, disabled: boolean): Promise<boolean> {
  const config = loadConfig();
  const message = await findReportButtonMessage(client, config.reportButtonChannelId);
  if (!message) return false;
  const isButton = (c: unknown): c is ButtonComponent => (c as { type?: number }).type === 2;
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (const row of message.components) {
    if (row.type !== 1) continue;
    const buttons = row.components.filter(isButton).map(c =>
      new ButtonBuilder({
        customId: c.customId ?? '',
        label: c.label ?? undefined,
        style: c.style,
        emoji: c.emoji ?? undefined,
        disabled: disabled && REPORT_BUTTON_IDS.includes(c.customId ?? ''),
      }),
    );
    if (buttons.length > 0) rows.push(new ActionRowBuilder<ButtonBuilder>().setComponents(buttons));
  }
  await message.edit({ components: rows }).catch(err => log.warn({ err }, 'Failed to toggle report buttons'));
  return true;
}

// ---- Forum permissions & thread locks -----------------------------------

async function applySendMessagesDeny(forum: ForumChannel, guild: Guild, record: FreezeRecord): Promise<void> {
  // Capture exactly once, before any edit: a crash after the edit must not
  // snapshot our own deny as the "prior" state.
  if (!record.overwriteCaptured) {
    const prior = forum.permissionOverwrites.cache.get(guild.id);
    const bit = (flag: bigint) => (prior ? (prior.allow.has(flag) ? true : prior.deny.has(flag) ? false : null) : null);
    const captured = await patchFreeze({
      priorSendMessages: bit(PermissionFlagsBits.SendMessages),
      priorSendMessagesInThreads: bit(PermissionFlagsBits.SendMessagesInThreads),
      overwriteCaptured: true,
    });
    if (captured) record.overwriteCaptured = true;
  }
  await forum.permissionOverwrites.edit(guild.id, { SendMessages: false, SendMessagesInThreads: false }, { type: 0 });
}

async function restoreOverwrite(forum: ForumChannel, guild: Guild, record: FreezeRecord): Promise<void> {
  await forum.permissionOverwrites.edit(
    guild.id,
    { SendMessages: record.priorSendMessages ?? null, SendMessagesInThreads: record.priorSendMessagesInThreads ?? null },
    { type: 0 },
  );
}

async function postBanner(client: Client, record: FreezeRecord): Promise<boolean> {
  const config = loadConfig();
  const channel = await client.channels.fetch(config.reportButtonChannelId).catch(() => null);
  if (!channel?.isSendable()) {
    log.error('Cannot post freeze banner: button channel missing');
    return false;
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(THAW_BUTTON_ID).setLabel('Thaw Freeze').setStyle(ButtonStyle.Danger),
  );
  const sent = await channel.send({ embeds: [freezeBannerEmbed(record)], components: [row] });
  await patchFreeze({ bannerMessageId: sent.id });
  return true;
}

async function deleteBanner(client: Client, record: FreezeRecord): Promise<void> {
  if (!record.bannerMessageId) return;
  const config = loadConfig();
  const channel = await client.channels.fetch(config.reportButtonChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;
  const message = await channel.messages.fetch(record.bannerMessageId).catch(() => null);
  await message?.delete().catch(() => {});
}

// ---- Freeze / thaw engines ----------------------------------------------

export async function startFreeze(client: Client, params: { hours: number; message: string; initiatedBy: string }): Promise<FreezeRecord | null> {
  if (await getFreeze()) return null;
  const now = Date.now();
  const record: FreezeRecord = {
    startedAt: now,
    expiresAt: params.hours > 0 ? now + params.hours * 60 * 60 * 1000 : null,
    message: params.message,
    initiatedBy: params.initiatedBy,
    priorSendMessages: null,
    priorSendMessagesInThreads: null,
    overwriteCaptured: false,
    bannerMessageId: null,
    steps: { overwrite: false, buttons: false, locks: false, banner: false },
  };
  // Persisted first: a crash mid-apply resumes from the record on boot.
  await saveFreeze(record);
  await resumeFreeze(client);
  const final = await getFreeze();
  if (final?.expiresAt) armExpiry(client, final.expiresAt);
  log.info({ initiatedBy: params.initiatedBy, hours: params.hours }, 'Reports frozen');
  return final;
}

export async function resumeFreeze(client: Client): Promise<void> {
  let record = await getFreeze();
  if (!record) return;
  const config = loadConfig();
  const guild = client.guilds.cache.get(config.guildId) ?? await client.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) return;
  const forum = await getForum(guild, config.forumChannelId);
  if (!forum) return;

  if (!record.steps.overwrite) {
    await applySendMessagesDeny(forum, guild, record);
    record = (await patchFreeze({ steps: { ...record.steps, overwrite: true } }))!;
  }
  if (!record.steps.buttons) {
    await setReportButtonsDisabled(client, true);
    record = (await patchFreeze({ steps: { ...record.steps, buttons: true } }))!;
  }
  if (!record.steps.locks) {
    // Thread locking was dropped; the permission deny enforces the freeze.
    await patchFreeze({ steps: { ...record.steps, locks: true } });
    record = (await getFreeze())!;
  }
  if (!record.steps.banner) {
    const posted = await postBanner(client, record);
    // Left unmarked on failure so the next resume retries the banner.
    if (posted) await patchFreeze({ steps: { ...record.steps, banner: true } });
  }
}

let thawChain: Promise<void> = Promise.resolve();

export function thawFreeze(client: Client): Promise<void> {
  const run = thawChain.then(() => performThaw(client));
  thawChain = run.then(() => undefined, () => undefined);
  return run;
}

async function performThaw(client: Client): Promise<void> {
  const record = await getFreeze();
  if (!record) return;
  const config = loadConfig();
  const guild = client.guilds.cache.get(config.guildId) ?? await client.guilds.fetch(config.guildId).catch(() => null);
  if (!guild) return;

  clearExpiryTimer();
  // Flag first so boot resumes an interrupted thaw; revert steps are idempotent.
  await patchFreeze({ thawing: true });
  const forum = await getForum(guild, config.forumChannelId);
  if (forum) await restoreOverwrite(forum, guild, record).catch(err => log.warn({ err }, 'Failed to restore forum permissions on thaw'));
  await setReportButtonsDisabled(client, false);
  await deleteBanner(client, record);

  const endedAt = Date.now();
  // Time adjustments are not idempotent, so they run after the record clear:
  // a crash can skip them but never double-apply.
  await clearFreeze();
  await bumpDormancyAfterThaw({ startedAt: record.startedAt, endedAt });
  await extendSnoozesAfterThaw(client, { startedAt: record.startedAt, endedAt });
  log.info({ durationMs: endedAt - record.startedAt }, 'Reports thawed');
}

async function bumpDormancyAfterThaw(freeze: { startedAt: number; endedAt: number }): Promise<void> {
  const dormantMs = loadConfig().dormantCloseDays * 24 * 60 * 60 * 1000;
  const reports = await StoredReport.listAll();
  for (const report of reports) {
    const bumped = dormantBumpedAt(report.data.lastActivityAt, freeze, dormantMs);
    if (bumped !== report.data.lastActivityAt) {
      await StoredReport.update(report.threadId, { lastActivityAt: bumped });
    }
  }
}

// ---- Boot recovery --------------------------------------------------------

export async function recoverFreeze(client: Client): Promise<void> {
  const record = await getFreeze();
  if (!record) return;
  if (record.thawing) {
    await thawFreeze(client);
    return;
  }
  if (record.expiresAt && record.expiresAt <= Date.now()) {
    await thawFreeze(client);
    return;
  }
  if (record.expiresAt) armExpiry(client, record.expiresAt);
  await resumeFreeze(client);
}

// ---- Expiry timer ---------------------------------------------------------

let expiryTimer: ReturnType<typeof setTimeout> | null = null;

export function armExpiry(client: Client, expiresAt: number): void {
  clearExpiryTimer();
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    void thawFreeze(client);
  }, Math.max(0, expiresAt - Date.now()));
}

export function clearExpiryTimer(): void {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}
