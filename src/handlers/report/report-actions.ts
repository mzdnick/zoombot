import { Discord, ButtonComponent, ModalComponent, SelectMenuComponent, Slash, SlashGroup, Guild, ContextMenu } from 'discordx';
import type { CommandInteraction, StringSelectMenuInteraction, ActionRow, MessageActionRowComponent, MessageContextMenuCommandInteraction } from 'discord.js';
import {
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type ThreadChannel,
  type ForumChannel,
  type Message,
  ApplicationCommandType,
  ComponentType,
  GuildMember,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  LabelBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createStore } from '../../store.js';
import { COLORS, formatGitCommit, discordTimestamp, timeAgo, isStaleBuild } from '../../util.js';
import { normalizeRouteInput, parseNormalizedRoute, parseRouteComponents, validateRoute, computeRouteLogIssues, extractRouteIds, replaceRouteIds, fetchRouteCommitInfo, type RouteComponents } from '../../comma.js';
import { randomUUID } from 'node:crypto';
import { fetchCommitChoices, type CommitChoice } from '../../github.js';
import { getForum, addAdditionalRoutesToTracker, createRouteTrackerThread, routeNumberLabel, TRACKER_FIELD_PREFIX } from './route-tracker.js';
import { resolveTagIds, buildActionRow, buildDonateRow, swapForumTags } from './report-service.js';
import {
  setThreadStatusEmoji,
  setThreadStatusAndClose,
  setReportCloseHandler,
  stripLeadingEmoji,
  withThreadLock,
  isRateLimit,
  retryDelay,
  splitReportTitle,
  composeReportTitle,
  maxRenameLength,
  MAX_TITLE_LEN,
} from './title-sync.js';
import { scheduleClose, getScheduledClose, nextCloseAt, closingNoticeField, cancelScheduledClose, stripClosingNoticeFrom } from './close-scheduler.js';
import { StoredReport } from './report-store.js';
import { getFreeze } from './freeze-state.js';
import { fixedButtonLabel, fixedModalTitle, labelForThread, reportNoun } from './report-copy.js';
import {
  scheduleSnooze,
  getScheduledSnooze,
  cancelSnooze,
  reopenSnoozedThread,
  finalizeSnoozeMessage,
  wakesField,
  snoozeDurationMs,
  DEFAULT_SNOOZE,
  SNOOZE_EMOJI,
} from './snooze-scheduler.js';

const log = createLogger('report-actions');

const assigneeTagStore = createStore<string>('assignee-tags');

async function getOrCreateAssigneeTag(forum: import('discord.js').ForumChannel, userId: string, username: string): Promise<string | null> {
  const cached = await assigneeTagStore.get(userId);
  if (cached) {
    if (forum.availableTags.some(t => t.id === cached)) return cached;
    await assigneeTagStore.delete(userId);
  }

  const tagName = `Assignee ${username}`;
  const existing = forum.availableTags.find(t => t.name === tagName);
  if (existing) {
    await assigneeTagStore.set(userId, existing.id);
    return existing.id;
  }

  try {
    const updated = await forum.setAvailableTags([
      ...forum.availableTags.map(t => ({ name: t.name, id: t.id, moderated: t.moderated, emoji: t.emoji ?? undefined })),
      { name: tagName },
    ]);
    const created = updated.availableTags.find(t => t.name === tagName);
    if (!created) return null;
    await assigneeTagStore.set(userId, created.id);
    return created.id;
  } catch (err) {
    log.warn({ err, tagName }, 'Failed to create assignee tag');
    return null;
  }
}

async function ensureForumTag(forum: ForumChannel, name: string): Promise<ForumChannel> {
  if (forum.availableTags.some(t => t.name === name)) return forum;
  const updated = await forum.setAvailableTags([
    ...forum.availableTags.map(t => ({ name: t.name, id: t.id, moderated: t.moderated, emoji: t.emoji ?? undefined })),
    { name },
  ]).catch(err => {
    log.warn({ err, name }, 'Failed to create forum tag');
    return null;
  });
  return updated ?? forum;
}

function hasStaffRole(member: GuildMember): boolean {
  return member.roles.cache.has(loadConfig().staffRole);
}

function hasScholarRole(member: GuildMember): boolean {
  const { scholarRole } = loadConfig();
  return scholarRole != null && member.roles.cache.has(scholarRole);
}

function canRenameThread(member: GuildMember): boolean {
  return hasStaffRole(member) || hasScholarRole(member);
}

async function applyAssignment(
  thread: ThreadChannel,
  guild: import('discord.js').Guild,
  userId: string,
  username: string,
): Promise<void> {
  await thread.members.add(userId).catch(err => log.warn({ err }, 'Failed to add member to thread'));

  const starter = await thread.fetchStarterMessage();
  const embed = starter?.embeds[0];
  if (starter && embed) {
    const updated = EmbedBuilder.from(embed);
    const idx = embed.fields?.findIndex(f => f.name === '👤 Assigned to') ?? -1;
    const field = { name: '👤 Assigned to', value: `<@${userId}>` };
    if (idx >= 0) updated.spliceFields(idx, 1, field);
    else updated.addFields(field);
    await starter.edit({ embeds: [updated] }).catch(() => {});
  }

  const forum = await getForum(guild, loadConfig().forumChannelId);
  if (forum) {
    const assigneeTagId = await getOrCreateAssigneeTag(forum, userId, username);
    const addTagIds = [...resolveTagIds(forum, ['ASSIGNED']), ...(assigneeTagId ? [assigneeTagId] : [])];

    const assigneeTagIds = new Set(forum.availableTags.filter(t => t.name.startsWith('Assignee ')).map(t => t.id));
    const existing = (thread.appliedTags as string[]).filter(
      id => !assigneeTagIds.has(id) && !addTagIds.includes(id),
    );
    await thread.setAppliedTags([...existing, ...addTagIds]).catch(() => {});
  }
}

const RENAME_OPTION = { label: 'Rename Thread', value: 'rename', emoji: '✏️', description: "Change this report thread's title" };

function buildStaffActionsReply(ticketId: string, renameOnly = false) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`staff_select_${ticketId}`)
    .setPlaceholder('Choose an action...')
    .addOptions(
      ...(renameOnly ? [RENAME_OPTION] : [
        { label: 'Assign', value: 'assign', emoji: '👤', description: 'Assign a staff member to this report' },
        { label: 'Request User Testing', value: 'waituser', emoji: '🧪', description: 'Ask the user to test and report back' },
        { label: 'Merge', value: 'merge', emoji: '🔀', description: 'Merge this report into another thread' },
        RENAME_OPTION,
        { label: 'Snooze', value: 'snooze', emoji: '😴', description: 'Temporarily close and auto-reopen later' },
        { label: 'Close', value: 'close', emoji: '🔐', description: 'Close this report' },
      ]),
    );
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  return { content: 'Select a staff action:', components: [row], flags: MessageFlags.Ephemeral } as const;
}

async function closeThread(thread: ThreadChannel, guild: import('discord.js').Guild): Promise<void> {
  const config = loadConfig();
  const forum = await getForum(guild, config.forumChannelId);
  if (!forum) return;
  // A wake timer must never reopen a thread that's being permanently closed.
  await cancelSnooze(thread.id);
  await swapForumTags(thread, forum, { remove: ['OPEN', 'WAITING FOR DEV', 'WAITING FOR USER'], add: ['CLOSED'] });
  // No .catch: a rate-limit must propagate so title-sync can retry. Lock before
  // archive - archiving first blocks the lock edit.
  if (!thread.locked) await thread.setLocked(true);
  if (!thread.archived) await thread.setArchived(true);
  await StoredReport.syncFromThread(thread);
  await StoredReport.markClosed(thread.id);
}

// title-sync's deferred worker and restart recovery finalize closes; give it a
// way to do so without an import cycle.
setReportCloseHandler(thread => closeThread(thread, thread.guild));

async function updateThreadButtons(thread: ThreadChannel): Promise<string | null> {
  const starter = await thread.fetchStarterMessage();
  if (!starter) return null;

  const embed = starter.embeds[0];
  if (!embed) return null;

  const titleMatch = embed.title?.match(/\((\d+)\)\s*$/);
  const ticketId = titleMatch?.[1] ?? String(parseInt(thread.id.slice(-7), 10));

  const actionRow = buildActionRow(ticketId);
  const edited = await starter.edit({ components: [actionRow] }).catch(err => { log.warn({ err }, 'Failed to update thread buttons'); return null; });
  if (!edited) return null;
  return ticketId;
}

// choices is snapshotted so the select handler doesn't refetch a list that may have rotated.
const waitCommitStore = createStore<{
  message: string; audience: string; submitterId: string; ticketId: string; threadId: string; choices: CommitChoice[];
}>('wait-commit-pending', { ttl: 15 * 60 * 1000 });

const readyReqStore = createStore<{ requiredShort?: string; requiredDate?: string }>(
  'wait-ready-req', { ttl: 30 * 24 * 60 * 60 * 1000 });

const pendingAdditionalReportStore = createStore<{
  userId: string;
  threadId: string;
  routeInput: string;
  details: string;
  readyMsgId: string | null;
}>('pending-additional-report', { ttl: 15 * 60 * 1000 });

const LOG_HELP_URL = 'https://wiki.firestar.link/faq/#how-do-i-upload-logs-for-troubleshooting';

const CLOSING_LOCK_MSG = "This report is closing soon - it can't be reopened until then.";

function snoozeLockMsg(pendingSnooze: { wakeAt: number }): string {
  return `This report is snoozed and will reopen <t:${Math.floor(pendingSnooze.wakeAt / 1000)}:R>. Use **Reopen Now** on the snooze notice to cancel it early.`;
}

function buildAdditionalReportModal(customId: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Additional Report');

  const routeInput = new TextInputBuilder({
    custom_id: 'route_id',
    style: TextInputStyle.Short,
    placeholder: 'dongle_id/route_name, connect.comma.ai, or stable.konik.ai URL',
    required: true,
    max_length: 256,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Route ID').setTextInputComponent(routeInput));

  const detailsInput = new TextInputBuilder({
    custom_id: 'details',
    style: TextInputStyle.Paragraph,
    placeholder: 'What additional info should we know?',
    required: false,
    max_length: 1024,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Details (optional)').setTextInputComponent(detailsInput));

  return modal;
}

// Split threads have no `By` field, so fall back to the linked Original Report's starter.
// Pre-"Reported By" threads put the reporting user as a leading mention in the content.
const leadingMention = (content?: string | null): string => content?.trimStart().match(/^<@!?(\d+)>/)?.[1] ?? '';

export async function resolveSubmitterId(thread: ThreadChannel, guild: import('discord.js').Guild): Promise<string> {
  const starter = await thread.fetchStarterMessage().catch(() => null);
  const fields = starter?.embeds[0]?.fields;
  const direct = fields?.find(f => f.name === 'By')?.value.match(/<@(\d+)>/)?.[1];
  if (direct) return direct;
  const directLegacy = leadingMention(starter?.content);
  if (directLegacy) return directLegacy;

  // Original Report URL: .../channels/<guild>/<channel>/<msg>
  const origUrl = fields?.find(f => /Original Report/.test(f.value ?? ''))?.value?.match(/\]\((.+?)\)/)?.[1];
  const origChannelId = origUrl?.split('/').slice(-2, -1)[0];
  if (origChannelId) {
    const origChannel = await guild.channels.fetch(origChannelId).catch(() => null);
    if (origChannel?.isThread()) {
      const origStarter = await origChannel.fetchStarterMessage().catch(() => null);
      const resolved = origStarter?.embeds[0]?.fields?.find(f => f.name === 'By')?.value.match(/<@(\d+)>/)?.[1];
      if (resolved) return resolved;
      const resolvedLegacy = leadingMention(origStarter?.content);
      if (resolvedLegacy) return resolvedLegacy;
    }
  }
  return '';
}

async function notifyAssigneeReady(thread: ThreadChannel, respondingUserId: string, link?: string): Promise<void> {
  const starter = await thread.fetchStarterMessage().catch(() => null);
  const assigneeId = starter?.embeds[0]?.fields?.find(f => f.name === '👤 Assigned to')?.value.match(/<@(\d+)>/)?.[1];
  if (!assigneeId || assigneeId === respondingUserId) return;
  await thread.send({
    content: `🔔 <@${assigneeId}> - <@${respondingUserId}> marked this **ready for another look**.${link ? ` [View their response](${link})` : ''}`,
    allowedMentions: { users: [assigneeId] },
  }).catch(err => log.warn({ err }, 'Failed to ping assignee on ready'));
}

interface WaitUserParams {
  mode: string;
  audience: string;
  message: string;
  submitterId: string;
  ticketId: string;
  requiredSha?: string;
  requiredShort?: string;
  branch?: string;
  requiredDate?: string;
}

const WAITING_FOR_USER_TITLE = '🧪 Waiting for User';

function isOpenReadyPrompt(m: Message, botId?: string): boolean {
  return (!botId || m.author.id === botId) &&
    m.components.length > 0 &&
    m.embeds[0]?.title === WAITING_FOR_USER_TITLE;
}

export async function findOpenReadyPrompt(thread: ThreadChannel): Promise<Message | null> {
  const botId = thread.client.user?.id;
  const messages = await thread.messages.fetch({ limit: 50 }).catch(() => null);
  if (!messages) return null;
  return messages.find(m => isOpenReadyPrompt(m, botId)) ?? null;
}

async function clearOpenWaitUserPrompts(thread: ThreadChannel): Promise<void> {
  const botId = thread.client.user?.id;
  const messages = await thread.messages.fetch({ limit: 50 }).catch(err => {
    log.warn({ err, threadId: thread.id }, 'Failed to fetch messages to clear prior Waiting for User prompts');
    return null;
  });
  if (!messages) return;

  const stale = messages.filter(m => isOpenReadyPrompt(m, botId));

  for (const msg of stale.values()) {
    await readyReqStore.delete(msg.id);
    await msg.delete().catch(err =>
      log.warn({ err, msgId: msg.id }, 'Failed to delete prior Waiting for User prompt (may already be gone)'));
  }
}

async function finalizeWaitUser(thread: ThreadChannel, forum: ForumChannel, params: WaitUserParams): Promise<void> {
  await clearOpenWaitUserPrompts(thread);

  // Best-effort (no deferred retry like closeThread): swallow even rate-limits.
  await swapForumTags(thread, forum, { remove: ['WAITING FOR DEV'], add: ['WAITING FOR USER'] })
    .catch(err => log.warn({ err }, 'Failed to swap forum tags for WAITING FOR USER'));
  await setThreadStatusEmoji(thread, 'waiting-for-user');

  const needsRoute = params.mode !== 'anytime';
  const action = params.mode === 'anytime'
    ? "Click **Ready** below when you've tested and have feedback to share (no @pings please)."
    : "A **new route** is needed to reopen this report. Click **Send Route** below to submit one once you've tested (no @pings please).";

  let required = '';
  if (params.mode === 'newer' && params.requiredSha) {
    const committed = params.requiredDate ? discordTimestamp(params.requiredDate) : null;
    required = `\n\nThe route must be on commit ${formatGitCommit(params.requiredSha, `github.com/${loadConfig().mainRepo}`)} (${params.branch}${committed ? `, committed ${committed}` : ''}) or newer.`;
  } else if (params.mode === 'newernow' && params.requiredDate) {
    const committed = discordTimestamp(params.requiredDate);
    required = `\n\nThe route must be on a commit newer than the latest one${committed ? ` as of ${committed}` : ''}. An update will be pushed to the testing branch \`Dom\` shortly - see the [branch switching guide](https://wiki.firestar.link/software/starpilot/#changing-branches) to switch to it.`;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.amber)
    .setTitle(WAITING_FOR_USER_TITLE)
    .setDescription(`${params.message ? params.message + '\n\n' : ''}${action}${required}`)
    .setTimestamp();

  // With no resolvable submitter, a 'sub' Ready and the Fixed button reject everyone -
  // fall back to an ungated Ready and drop Fixed.
  if (!params.submitterId) {
    log.warn({ threadId: thread.id, ticketId: params.ticketId }, 'No submitter resolved; posting ungated Ready without Fixed button');
  }
  const readyAudience = params.submitterId ? params.audience : 'any';
  const label = await labelForThread(thread.id, thread.name);
  const buttons = [
    new ButtonBuilder()
      .setCustomId(`ready_${params.mode}_${readyAudience}_${params.ticketId}_${params.submitterId}`)
      .setLabel(needsRoute ? 'Send Route' : 'Ready')
      .setStyle(ButtonStyle.Success)
      .setEmoji(needsRoute ? '🛣️' : '✅'),
  ];
  if (params.submitterId) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`fixed_${params.audience}_${params.ticketId}_${params.submitterId}`)
        .setLabel(fixedButtonLabel(label))
        .setStyle(ButtonStyle.Success)
        .setEmoji('🎉'),
    );
  }
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

  const sent = await thread.send({
    content: params.submitterId ? `<@${params.submitterId}>` : undefined,
    embeds: [embed],
    components: [row],
    allowedMentions: params.submitterId ? { users: [params.submitterId] } : undefined,
  });
  await StoredReport.syncFromThread(thread);
  if (params.requiredDate) {
    await readyReqStore.set(sent.id, {
      requiredShort: params.requiredSha ? (params.requiredShort ?? params.requiredSha.slice(0, 7)) : undefined,
      requiredDate: params.requiredDate,
    });
  }
}

async function completeReadyMessage(thread: ThreadChannel, msgId: string, note: string): Promise<void> {
  const msg = await thread.messages.fetch(msgId).catch(() => null);
  if (!msg) return;
  const embeds = msg.embeds[0]
    ? [EmbedBuilder.from(msg.embeds[0])
        .setColor(COLORS.green)
        .setTitle('✅ User Responded')
        .addFields({ name: '\u200B', value: note })]
    : [];
  await msg.edit({ embeds, components: [] }).catch(err => log.warn({ err }, 'Failed to complete Ready message'));
}

async function ensureTrackerThread(thread: ThreadChannel, guild: import('discord.js').Guild): Promise<{ url: string; threadId: string } | null> {
  const starter = await thread.fetchStarterMessage().catch(() => null);
  const embed = starter?.embeds[0];
  const existing = trackerRefFromStarter(starter);
  if (existing) return existing;

  const tracker = await createRouteTrackerThread(guild, loadConfig(), undefined, thread.url, thread.name);
  if (tracker && starter && embed) {
    const updated = EmbedBuilder.from(embed);
    updated.addFields({ name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${tracker.url})` });
    await starter.edit({ embeds: [updated] }).catch(err => log.warn({ err }, 'Failed to add tracker field to starter'));
  }
  return tracker;
}

function buildWaitUserModal(ticketId: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`waituser_modal_${ticketId}`)
    .setTitle('Request User Testing');

  const messageInput = new TextInputBuilder({
    custom_id: 'message',
    style: TextInputStyle.Paragraph,
    placeholder: 'What should they test / which logs do you need?',
    required: false,
    max_length: 1024,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Message to the user (optional)').setTextInputComponent(messageInput));

  const modeSelect = new StringSelectMenuBuilder()
    .setCustomId('reopen_mode')
    .setMinValues(1)
    .addOptions(
      { label: 'Anytime', value: 'anytime', description: 'The user can respond right away', default: true },
      { label: 'With a new route', value: 'route', description: 'Responding requires submitting a new route' },
      { label: 'From commit newer than now', value: 'newernow', description: 'New route must be on a commit newer than the latest one now' },
      { label: 'Newer than a specific commit', value: 'newer', description: 'New route must be on a chosen commit or newer' },
    );
  modal.addLabelComponents(new LabelBuilder().setLabel('When may the user reopen?').setStringSelectMenuComponent(modeSelect));

  const audienceSelect = new StringSelectMenuBuilder()
    .setCustomId('respond_audience')
    .setMinValues(1)
    .addOptions(
      { label: 'Any Thread Participant', value: 'any', description: 'Anyone in the thread can respond', default: true },
      { label: 'Submitter', value: 'sub', description: 'Only the original submitter can respond' },
    );
  modal.addLabelComponents(new LabelBuilder().setLabel('Who may respond?').setStringSelectMenuComponent(audienceSelect));

  return modal;
}

function buildAssignModal(ticketId: string, defaultUserId: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`assign_modal_${ticketId}`)
    .setTitle('Assign Report');

  const userSelect = new UserSelectMenuBuilder()
    .setCustomId('assignee')
    .setPlaceholder('Select a staff member to assign')
    .setMinValues(1)
    .setMaxValues(1)
    .setDefaultUsers(defaultUserId);
  modal.addLabelComponents(new LabelBuilder().setLabel('Assign this report to').setUserSelectMenuComponent(userSelect));

  return modal;
}

async function assignModalForThread(thread: ThreadChannel, ticketId: string, fallbackUserId: string): Promise<ModalBuilder> {
  const starter = await thread.fetchStarterMessage();
  const current = starter?.embeds[0]?.fields?.find(f => f.name === '👤 Assigned to')?.value.match(/<@(\d+)>/)?.[1];
  return buildAssignModal(ticketId, current ?? fallbackUserId);
}

function buildMergeModal(customId: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Merge Report');

  const targetInput = new TextInputBuilder({
    custom_id: 'target_thread',
    style: TextInputStyle.Short,
    placeholder: 'Paste the target thread URL or ID',
    required: true,
    max_length: 200,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Target Thread').setTextInputComponent(targetInput));

  return modal;
}

function buildSnoozeModal(ticketId: string): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId(`snooze_modal_${ticketId}`)
    .setTitle('Snooze Report');

  const durationSelect = new StringSelectMenuBuilder()
    .setCustomId('duration')
    .setMinValues(1)
    .addOptions(
      { label: '1 day', value: '1d', default: true },
      { label: '3 days', value: '3d' },
      { label: '1 week', value: '1w' },
    );
  modal.addLabelComponents(new LabelBuilder().setLabel('Snooze duration').setStringSelectMenuComponent(durationSelect));

  const reasonInput = new TextInputBuilder({
    custom_id: 'reason',
    style: TextInputStyle.Paragraph,
    placeholder: 'Why is this being snoozed? (optional)',
    required: false,
    max_length: 1024,
  });
  modal.addLabelComponents(new LabelBuilder().setLabel('Reason (optional)').setTextInputComponent(reasonInput));

  return modal;
}

function buildRenameModal(thread: ThreadChannel, ticketId: string): ModalBuilder {
  const parts = splitReportTitle(thread.name, ticketId);
  const max = maxRenameLength(parts);

  const modal = new ModalBuilder()
    .setCustomId(`rename_modal_${ticketId}`)
    .setTitle('Rename Thread');

  const titleInput = new TextInputBuilder({
    custom_id: 'title',
    style: TextInputStyle.Short,
    required: true,
    max_length: max,
    value: parts.title.slice(0, max),
  });
  modal.addLabelComponents(
    new LabelBuilder()
      .setLabel('New title')
      .setDescription(`Result: ${parts.prefix}…${parts.suffix}`)
      .setTextInputComponent(titleInput),
  );

  return modal;
}

function quoteTitle(title: string): string {
  return `\`\`\`\n${title}\n\`\`\``;
}

function trackerRefFromStarter(starter: Message | null): { url: string; threadId: string } | null {
  const trackerUrl = starter?.embeds[0]?.fields
    ?.find(f => f.value?.startsWith(TRACKER_FIELD_PREFIX))
    ?.value?.match(/\]\((.+?)\)/)?.[1];
  const trackerThreadId = trackerUrl?.split('/').pop();
  if (!trackerUrl || !trackerThreadId) return null;
  return { url: trackerUrl, threadId: trackerThreadId };
}

async function renameTrackerThread(
  guild: import('discord.js').Guild,
  trackerThreadId: string,
  reportName: string,
): Promise<void> {
  const tracker = await guild.channels.fetch(trackerThreadId).catch(() => null);
  if (!tracker?.isThread()) return;

  const name = stripLeadingEmoji(reportName).trimStart().slice(0, MAX_TITLE_LEN);
  if (tracker.name !== name) {
    await withThreadLock(tracker.id, async () => { await tracker.setName(name); })
      .catch(err => log.warn({ err, trackerThreadId }, 'Failed to rename route tracker thread'));
  }

  const starter = await tracker.fetchStarterMessage().catch(() => null);
  const embed = starter?.embeds[0];
  if (!starter || !embed || embed.title === name) return;
  await starter.edit({ embeds: [EmbedBuilder.from(embed).setTitle(name)] })
    .catch(err => log.warn({ err, trackerThreadId }, 'Failed to retitle route tracker embed'));
}

function ticketIdFromStarter(starter: Message | null): string | null {
  if (!starter) return null;
  const staffButton = starter.components
    .filter(row => row.type === ComponentType.ActionRow)
    .flatMap(row => (row as ActionRow<MessageActionRowComponent>).components)
    .find(c => c.type === ComponentType.Button && c.customId?.startsWith('staff_actions_'));
  if (!staffButton || staffButton.type !== ComponentType.Button) return null;
  return staffButton.customId!.replace('staff_actions_', '');
}

interface StaffActionContext {
  thread: ThreadChannel;
  guild: import('discord.js').Guild;
  ticketId: string;
}

// Must not defer: callers showModal on success, which fails on an acknowledged interaction.
async function resolveStaffActionContext(interaction: MessageContextMenuCommandInteraction): Promise<StaffActionContext | null> {
  const thread = interaction.channel;
  if (!thread?.isThread()) {
    await interaction.reply({ content: 'This can only be used inside a report thread.', flags: MessageFlags.Ephemeral });
    return null;
  }

  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
    return null;
  }

  const starter = await thread.fetchStarterMessage().catch(() => null);
  const ticketId = ticketIdFromStarter(starter);
  if (!ticketId) {
    await interaction.reply({ content: 'This thread is not a report thread (no Staff Actions button found in its starter message).', flags: MessageFlags.Ephemeral });
    return null;
  }

  if (await getScheduledClose(thread.id)) {
    await interaction.reply({ content: 'This report is closing soon - staff actions are locked until then.', flags: MessageFlags.Ephemeral });
    return null;
  }

  const pendingSnooze = await getScheduledSnooze(thread.id);
  if (pendingSnooze) {
    await interaction.reply({ content: snoozeLockMsg(pendingSnooze), flags: MessageFlags.Ephemeral });
    return null;
  }

  return { thread, guild, ticketId };
}

async function beginScheduledClose(thread: ThreadChannel, closedByUserId: string): Promise<{ ok: boolean; message: string }> {
  const closeAt = nextCloseAt();
  const closeStarter = await thread.fetchStarterMessage();
  if (closeStarter) {
    const closeEmbed = closeStarter.embeds[0];
    if (closeEmbed) {
      const closeUpdated = EmbedBuilder.from(closeEmbed);
      closeUpdated.addFields({ name: '​', value: `🔐 Closed by <@${closedByUserId}>` });
      await closeStarter.edit({ embeds: [closeUpdated] }).catch(err => log.warn({ err }, 'Failed to edit starter'));
    }
  }

  const noticeEmbed = new EmbedBuilder()
    .setColor(COLORS.blurple)
    .setTitle('🔐 Closed')
    .setDescription(`Closed by <@${closedByUserId}>.`)
    .addFields(closingNoticeField(closeAt))
    .setTimestamp();
  const noticeMsg = await thread.send({ embeds: [noticeEmbed] }).catch(err => { log.warn({ err }, 'Failed to post closing notice'); return null; });

  const scheduled = await scheduleClose(thread, 'closed', closeAt, noticeMsg?.id ?? '');
  if (!scheduled) {
    await noticeMsg?.delete().catch(() => {});
    return { ok: false, message: 'This report is already closing.' };
  }
  return { ok: true, message: 'Report will close shortly.' };
}

export async function submitAdditionalReport(params: {
  interaction: ModalSubmitInteraction | CommandInteraction | ButtonInteraction;
  thread: ThreadChannel;
  guild: import('discord.js').Guild;
  userId: string;
  routeInput: string;
  details: string;
  ready: { readyMsgId: string } | null;
  force: boolean;
}): Promise<void> {
  const { interaction, thread, guild, userId, routeInput, details, ready, force } = params;
  log.info({ userId, threadId: thread.id, routeInput, details, ready: !!ready, force }, 'Additional report submitted');
  const reply = (content: string) => interaction.editReply({ content, components: [] });

  const trimmedInput = routeInput.trim();
  let normalizedRoute: string;
  let comps: RouteComponents | undefined;
  try {
    normalizedRoute = normalizeRouteInput(trimmedInput);
    comps = parseRouteComponents(trimmedInput);
  } catch (err) {
    await reply(`Invalid route ID. ${err instanceof Error ? err.message : 'Use the format \`dongle_id/route_name\`, a connect.comma.ai URL, or a stable.konik.ai URL.'}`);
    return;
  }

  const parsed = parseNormalizedRoute(normalizedRoute);
  if (!parsed) {
    await reply('Invalid route ID. Use the format `dongle_id/route_name` (e.g. `a1b2c3d4e5f6a7b8/0000aaaa--98c2d4e6f8`), a connect.comma.ai URL, or a stable.konik.ai URL.');
    return;
  }
  parsed.originalText = trimmedInput;
  parsed.isUrl = /^https?:\/\//i.test(trimmedInput);
  parsed.provider = comps.provider;

  const { dongleId, routeName } = parsed;
  const primary = await validateRoute(dongleId, routeName, comps.startSegment, comps.endSegment, comps.provider);
  if (!primary.valid) {
    await reply('That route does not exist. Please check the Route ID and try again.');
    return;
  }
  parsed.public = primary.public;
  parsed.rlogsAvailable = primary.rlogsAvailable;

  const detailRoutes = details
    ? extractRouteIds(details).filter(r => (r.originalText ?? '').toLowerCase() !== trimmedInput.toLowerCase())
    : [];
  const detailValidations = await Promise.all(detailRoutes.map(r => validateRoute(r.dongleId, r.routeName, undefined, undefined, r.provider)));
  const numberedDetailRoutes = detailRoutes.map((r, i) => ({ ...r, ...detailValidations[i], routeNumber: i + 1 }));

  if (!force) {
    const issues = computeRouteLogIssues([
      { originalText: parsed.originalText, public: primary.public, rlogsAvailable: primary.rlogsAvailable, rlogCheck: primary.rlogCheck },
      ...numberedDetailRoutes.filter(r => r.valid),
    ]);
    if (issues.length > 0) {
      const token = randomUUID();
      await pendingAdditionalReportStore.set(token, { userId, threadId: thread.id, routeInput, details, readyMsgId: ready?.readyMsgId ?? null });
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`archk_${token}`).setLabel('Check Again').setStyle(ButtonStyle.Primary).setEmoji('🔄'),
        new ButtonBuilder().setCustomId(`arfrc_${token}`).setLabel('Share Anyway').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setLabel('Need help?').setStyle(ButtonStyle.Link).setURL(LOG_HELP_URL),
      );
      await interaction.editReply({ content: issues.join('\n'), components: [row] });
      return;
    }
  }

  if (ready) {
    const req = await readyReqStore.get(ready.readyMsgId);
    if (req) {
      const meta = await fetchRouteCommitInfo(dongleId, routeName, parsed.provider);
      if (!meta) {
        await reply("Couldn't read this route's commit (make sure logs are uploaded). Nothing was submitted - the report is still **WAITING FOR USER**; try again once logs are up.");
        return;
      }
      if (isStaleBuild(meta.git_commit_date, req.requiredDate)) {
        const routeShort = meta.git_commit.slice(0, 7);
        const routeWhen = discordTimestamp(meta.git_commit_date);
        const reqWhen = req.requiredDate ? discordTimestamp(req.requiredDate) : null;
        const reqLabel = req.requiredShort ? `required \`${req.requiredShort}\`` : 'the required build';
        await reply(`Route **rejected** - it's from an older build than required: route commit \`${routeShort}\`${routeWhen ? ` (committed ${routeWhen})` : ''} predates ${reqLabel}${reqWhen ? ` (committed ${reqWhen})` : ''}. Nothing was submitted - the report is still **WAITING FOR USER**; test on a newer build and submit a fresh route.`);
        return;
      }
    }
  }

  if (ready && await getScheduledClose(thread.id)) {
    await reply(CLOSING_LOCK_MSG);
    return;
  }

  const tracker = await ensureTrackerThread(thread, guild);
  if (!tracker) {
    await reply('Failed to create a route tracker thread.');
    return;
  }

  const cleanDetails = details ? replaceRouteIds(details, [parsed, ...numberedDetailRoutes], routeNumberLabel) : '';

  const msg = await thread.send({
    content: `<@${userId}>`,
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.blurple)
        .setDescription(cleanDetails || 'No additional info')
        .addFields({ name: '​', value: `${TRACKER_FIELD_PREFIX}(${tracker.url})` })
        .setTimestamp(),
    ],
  });

  const additionalReportId = String(parseInt(msg.id.slice(-7), 10));
  await msg.edit({
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`split_${additionalReportId}`)
          .setLabel('✂️ Split to Thread')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  });

  await addAdditionalRoutesToTracker(
    guild, tracker.threadId, [parsed, ...numberedDetailRoutes.filter(r => r.valid)],
    msg.url, `Additional Report #${additionalReportId}`,
  );

  let lifecycleNote = '';
  if (ready) {
    const forum = await getForum(guild, loadConfig().forumChannelId);
    if (forum) {
      await swapForumTags(thread, forum, { remove: ['WAITING FOR USER'], add: ['WAITING FOR DEV'] })
        .catch(err => log.warn({ err }, 'Failed to swap forum tags for WAITING FOR DEV'));
    }
    await setThreadStatusEmoji(thread, 'waiting-for-dev');
    await StoredReport.syncFromThread(thread);
    await completeReadyMessage(thread, ready.readyMsgId, `A new route was submitted by <@${userId}> - [Additional Report #${additionalReportId}](${msg.url})`);
    await readyReqStore.delete(ready.readyMsgId);
    await notifyAssigneeReady(thread, userId, msg.url);
    lifecycleNote = ' The report is now marked **WAITING FOR DEV**.';
  }

  await StoredReport.update(thread.id, { lastActivityAt: Date.now() });
  await reply(`Route added to the tracker thread.${!primary.public ? ' The route is not yet public - please make it public so staff can view it.' : ''}${lifecycleNote}`);
}

async function rejectIfFrozen(interaction: ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction): Promise<boolean> {
  const freeze = await getFreeze();
  if (!freeze) return false;
  if (interaction.member instanceof GuildMember && hasStaffRole(interaction.member)) return false;
  const expiry = freeze.expiresAt ? ` It thaws <t:${Math.floor(freeze.expiresAt / 1000)}:R>.` : '';
  await interaction.reply({ content: `**${freeze.message}**${expiry}`, flags: MessageFlags.Ephemeral });
  return true;
}
@Discord()
export class BotReportActions {
  @ButtonComponent({ id: /^additional_report_/ })
  async additionalReport(interaction: ButtonInteraction) {
    if (await rejectIfFrozen(interaction)) return;
    await interaction.showModal(buildAdditionalReportModal(`additional_report_modal_${interaction.id}`));
  }

  @ButtonComponent({ id: /^archk_/ })
  @ButtonComponent({ id: /^arfrc_/ })
  async additionalReportGate(interaction: ButtonInteraction) {
    const force = interaction.customId.startsWith('arfrc_');
    const token = interaction.customId.split('_')[1];
    const pending = await pendingAdditionalReportStore.get(token);
    if (!pending) {
      await interaction.reply({ content: 'This request has expired. Please submit the additional report again.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.user.id !== pending.userId) {
      await interaction.reply({ content: 'Only the original submitter can use this.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferUpdate();
    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({ content: 'Could not resolve guild.', components: [] });
      return;
    }
    let thread: ThreadChannel | null = interaction.channel?.isThread() ? interaction.channel : null;
    if (!thread) {
      const fetched = await guild.channels.fetch(pending.threadId).catch(() => null);
      thread = fetched?.isThread() ? fetched : null;
    }
    if (!thread) {
      await interaction.editReply({ content: 'Could not resolve the report thread.', components: [] });
      return;
    }
    await submitAdditionalReport({
      interaction, thread, guild, userId: pending.userId,
      routeInput: pending.routeInput, details: pending.details,
      ready: pending.readyMsgId ? { readyMsgId: pending.readyMsgId } : null,
      force,
    });
  }

  @ModalComponent({ id: /^waituser_modal_/ })
  async handleWaitUserSubmit(interaction: ModalSubmitInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can request user testing.', flags: MessageFlags.Ephemeral });
      return;
    }

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
      return;
    }

    const pendingClose = await getScheduledClose(thread.id);
    if (pendingClose) {
      await interaction.reply({ content: CLOSING_LOCK_MSG, flags: MessageFlags.Ephemeral });
      return;
    }

    // Launched from the ephemeral Staff Actions select - acknowledge against that
    // message so the dropdown gets replaced instead of left dangling
    if (interaction.isFromMessage()) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }

    const ticketId = interaction.customId.replace('waituser_modal_', '');
    const message = interaction.fields.getTextInputValue('message');
    const modeValues = interaction.fields.getStringSelectValues('reopen_mode');
    const mode = modeValues.length > 0 ? modeValues[0] : 'anytime';
    const audienceValues = interaction.fields.getStringSelectValues('respond_audience');
    const audience = audienceValues.length > 0 ? audienceValues[0] : 'any';

    const submitterId = await resolveSubmitterId(thread, guild);

    const forum = await getForum(guild, loadConfig().forumChannelId);
    if (!forum) {
      await interaction.editReply({ content: 'Forum channel not found. Contact an admin.', components: [] });
      return;
    }

    if (mode === 'newernow') {
      const requiredDate = new Date().toISOString();
      await finalizeWaitUser(thread, forum, { mode, audience, message, submitterId, ticketId, requiredDate });
      const committed = discordTimestamp(requiredDate);
      await interaction.editReply({
        content: `Report marked **WAITING FOR USER** - required a build newer than the latest commit${committed ? ` as of ${committed}` : ''}.`,
        components: [],
      });
      return;
    }

    if (mode === 'newer') {
      const choices = await fetchCommitChoices();
      if (choices.length === 0) {
        await interaction.editReply({ content: "Couldn't reach GitHub to list commits. Try again in a moment.", components: [] });
        return;
      }
      await waitCommitStore.set(interaction.id, { message, audience, submitterId, ticketId, threadId: thread.id, choices });
      const select = new StringSelectMenuBuilder()
        .setCustomId(`wcommit_${interaction.id}`)
        .setPlaceholder('Select the minimum required commit…')
        .addOptions(choices.map(c => {
          const label = `${c.branch} ${c.short} - ${c.subject}`;
          // plain text only - Discord doesn't render <t:…> markup in option descriptions
          const when = c.date ? c.date.replace('T', ' ').replace(/Z$/, ' UTC') : null;
          const ago = c.date ? timeAgo(c.date) : null;
          return {
            label: label.length > 100 ? label.slice(0, 99) + '…' : label,
            value: c.sha,
            description: when ? (ago ? `${when} - ${ago}` : when) : undefined,
          };
        }));
      await interaction.editReply({
        content: 'Pick the commit the new route must be on (or newer):',
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      });
      return;
    }

    await finalizeWaitUser(thread, forum, { mode, audience, message, submitterId, ticketId });
    await interaction.editReply({ content: 'Report marked **WAITING FOR USER**.', components: [] });
  }

  @SelectMenuComponent({ id: /^wcommit_/ })
  async handleWaitCommitSelect(interaction: StringSelectMenuInteraction) {
    if (await rejectIfFrozen(interaction)) return;
    const token = interaction.customId.split('_')[1];
    const pending = await waitCommitStore.get(token);
    if (!pending) {
      await interaction.reply({ content: 'This request has expired. Use **Request User Testing** again.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can request user testing.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
      return;
    }

    let thread: ThreadChannel | null = interaction.channel?.isThread() ? interaction.channel : null;
    if (!thread) {
      const fetched = await guild.channels.fetch(pending.threadId).catch(() => null);
      thread = fetched?.isThread() ? fetched : null;
    }
    if (!thread) {
      await interaction.reply({ content: 'Could not resolve the report thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const forum = await getForum(guild, loadConfig().forumChannelId);
    if (!forum) {
      await interaction.reply({ content: 'Forum channel not found. Contact an admin.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate();

    const requiredSha = interaction.values[0];
    const choice = pending.choices?.find(c => c.sha === requiredSha);
    const requiredShort = choice?.short ?? requiredSha.slice(0, 7);
    const branch = choice?.branch ?? 'unknown';
    const requiredDate = choice?.date;

    await finalizeWaitUser(thread, forum, {
      mode: 'newer',
      audience: pending.audience,
      message: pending.message,
      submitterId: pending.submitterId,
      ticketId: pending.ticketId,
      requiredSha,
      requiredShort,
      branch,
      requiredDate,
    });
    await waitCommitStore.delete(token);

    const committed = requiredDate ? discordTimestamp(requiredDate) : null;
    await interaction.editReply({
      content: `Report marked **WAITING FOR USER** - required commit \`${requiredShort}\` (${branch}${committed ? `, committed ${committed}` : ''}) or newer.`,
      components: [],
    });
  }

  @ButtonComponent({ id: /^ready_/ })
  async handleReadyButton(interaction: ButtonInteraction) {
    const [, mode, audience, ticketId, submitterId] = interaction.customId.split('_');

    if (await rejectIfFrozen(interaction)) return;

    if (interaction.channelId && await getScheduledClose(interaction.channelId)) {
      await interaction.reply({ content: CLOSING_LOCK_MSG, flags: MessageFlags.Ephemeral });
      return;
    }

    const isStaff = interaction.member instanceof GuildMember && hasStaffRole(interaction.member);
    const allowed = isStaff || (audience === 'sub' ? interaction.user.id === submitterId : true);
    if (!allowed) {
      await interaction.reply({ content: 'Only the original submitter (or staff) can respond to this request.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (mode === 'anytime') {
      const modal = new ModalBuilder()
        .setCustomId(`readyfb_modal_${ticketId}_${interaction.message.id}`)
        .setTitle('Ready - Feedback');
      const feedbackInput = new TextInputBuilder({
        custom_id: 'feedback',
        style: TextInputStyle.Paragraph,
        placeholder: 'How did testing go? Anything to add?',
        required: false,
        max_length: 1024,
      });
      modal.addLabelComponents(new LabelBuilder().setLabel('Feedback (optional)').setTextInputComponent(feedbackInput));
      await interaction.showModal(modal);
      return;
    }

    await interaction.showModal(buildAdditionalReportModal(`additional_report_modal_ready_${ticketId}_${interaction.message.id}`));
  }

  @ModalComponent({ id: /^readyfb_modal_/ })
  async handleReadyFeedbackSubmit(interaction: ModalSubmitInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const msgId = interaction.customId.split('_')[3];

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.editReply({ content: 'This can only be used from a thread.' });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({ content: 'Could not resolve guild.' });
      return;
    }

    if (await getScheduledClose(thread.id)) {
      await interaction.editReply({ content: CLOSING_LOCK_MSG });
      return;
    }

    const feedback = interaction.fields.getTextInputValue('feedback');
    log.info({ userId: interaction.user.id, threadId: thread.id, feedback }, 'Report marked ready');
    let feedbackMsg: import('discord.js').Message | null = null;
    if (feedback) {
      const routes = extractRouteIds(feedback);
      const validations = await Promise.all(routes.map(r => validateRoute(r.dongleId, r.routeName, undefined, undefined, r.provider)));
      const numbered = routes.map((r, i) => ({ ...r, ...validations[i], routeNumber: i + 1 }));
      const cleanFeedback = replaceRouteIds(feedback, numbered, routeNumberLabel);
      const validRoutes = numbered.filter(r => r.valid);
      const tracker = validRoutes.length > 0 ? await ensureTrackerThread(thread, guild) : null;

      const feedbackEmbed = new EmbedBuilder()
        .setColor(COLORS.blurple)
        .setTitle('💬 Feedback')
        .setDescription(cleanFeedback || 'No additional info')
        .setTimestamp();
      if (tracker) {
        feedbackEmbed.addFields({ name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${tracker.url})` });
      }

      feedbackMsg = await thread.send({
        content: `<@${interaction.user.id}>`,
        embeds: [feedbackEmbed],
      }).catch(err => { log.warn({ err }, 'Failed to post ready feedback'); return null; });

      if (tracker) {
        await addAdditionalRoutesToTracker(
          guild, tracker.threadId, validRoutes,
          feedbackMsg?.url, feedbackMsg ? 'User Feedback' : undefined,
        );
      }
    }

    const forum = await getForum(guild, loadConfig().forumChannelId);
    if (forum) {
      await swapForumTags(thread, forum, { remove: ['WAITING FOR USER'], add: ['WAITING FOR DEV'] })
        .catch(err => log.warn({ err }, 'Failed to swap forum tags for WAITING FOR DEV'));
    }
    await setThreadStatusEmoji(thread, 'waiting-for-dev');
    await StoredReport.syncFromThread(thread);
    await completeReadyMessage(thread, msgId, feedbackMsg
      ? `Feedback submitted by <@${interaction.user.id}> - [view it](${feedbackMsg.url})`
      : `Marked ready by <@${interaction.user.id}>`);
    await notifyAssigneeReady(thread, interaction.user.id, feedbackMsg?.url);

    await interaction.editReply({ content: 'Thanks! The report is back to **WAITING FOR DEV**.' });
  }

  @ButtonComponent({ id: /^fixed_(?!confirm_)/ })
  async handleFixedButton(interaction: ButtonInteraction) {
    const [, , ticketId, submitterId] = interaction.customId.split('_');

    if (interaction.channelId && await getScheduledClose(interaction.channelId)) {
      await interaction.reply({ content: CLOSING_LOCK_MSG, flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.user.id !== submitterId) {
      const isStaff = interaction.member instanceof GuildMember && hasStaffRole(interaction.member);
      if (isStaff) {
        await interaction.reply({
          content: 'Only the original reporter can mark this as resolved. If closing this was intentional, use **Staff Actions → Close** below.',
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`staff_actions_${ticketId}`).setLabel('Staff Actions').setStyle(ButtonStyle.Primary).setEmoji('🛠️'),
          )],
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.reply({ content: 'Only the original reporter can mark this as resolved.', flags: MessageFlags.Ephemeral });
      return;
    }

    const threadName = interaction.channel?.isThread() ? interaction.channel.name : '';
    const label = await labelForThread(interaction.channelId, threadName);
    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`fixed_confirm_${ticketId}_${submitterId}_${interaction.message.id}`).setLabel(fixedButtonLabel(label)).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('fixed_confirm_cancel').setLabel('Nevermind').setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({
      content: `Are you sure you want to mark this as resolved? This will **close this ${reportNoun(label)}** shortly.`,
      components: [confirmRow],
      flags: MessageFlags.Ephemeral,
    });
  }

  @ButtonComponent({ id: /^fixed_confirm_/ })
  async handleFixedConfirm(interaction: ButtonInteraction) {
    const parts = interaction.customId.split('_');
    if (parts[2] === 'cancel') {
      await interaction.update({ content: 'Okay - left open.', components: [] });
      return;
    }
    const [, , ticketId, submitterId, msgId] = parts;

    if (interaction.user.id !== submitterId) {
      await interaction.reply({ content: 'Only the original reporter can mark this as resolved.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.channelId && await getScheduledClose(interaction.channelId)) {
      await interaction.update({ content: CLOSING_LOCK_MSG, components: [] });
      return;
    }

    const threadName = interaction.channel?.isThread() ? interaction.channel.name : '';
    const label = await labelForThread(interaction.channelId, threadName);
    const modal = new ModalBuilder()
      .setCustomId(`fixed_modal_${ticketId}_${msgId}`)
      .setTitle(fixedModalTitle(label));
    const noteInput = new TextInputBuilder({
      custom_id: 'note',
      style: TextInputStyle.Paragraph,
      placeholder: 'Anything to add for the dev? (optional)',
      required: false,
      max_length: 1024,
    });
    modal.addLabelComponents(new LabelBuilder().setLabel('Additional feedback (optional)').setTextInputComponent(noteInput));
    await interaction.showModal(modal);
  }

  @ModalComponent({ id: /^fixed_modal_/ })
  async handleFixedSubmit(interaction: ModalSubmitInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const msgId = interaction.customId.split('_')[3];

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.editReply({ content: 'This can only be used from a thread.' });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({ content: 'Could not resolve guild.' });
      return;
    }

    if (await getScheduledClose(thread.id)) {
      await interaction.editReply({ content: CLOSING_LOCK_MSG });
      return;
    }

    const note = interaction.fields.getTextInputValue('note');

    const closeAt = nextCloseAt();
    const resolvedEmbed = new EmbedBuilder()
      .setColor(COLORS.green)
      .setTitle('✅ Resolved by User')
      .setFooter({ text: `Closed by ${interaction.user.tag}` })
      .setTimestamp();
    if (note) resolvedEmbed.setDescription(note);
    resolvedEmbed.addFields(closingNoticeField(closeAt));
    const donateRow = buildDonateRow(loadConfig(), guild.id);
    const noticeMsg = await thread.send({ content: `<@${interaction.user.id}> marked this issue as fixed.`, embeds: [resolvedEmbed], components: donateRow ? [donateRow] : [] }).catch(err => { log.warn({ err }, 'Failed to post resolved embed'); return null; });

    const waitMsg = await thread.messages.fetch(msgId).catch(() => null);
    if (waitMsg) {
      const embeds = waitMsg.embeds[0]
        ? [EmbedBuilder.from(waitMsg.embeds[0])
            .setColor(COLORS.green)
            .setTitle('✅ Resolved by User')
            .addFields({ name: '\u200B', value: `Marked fixed by <@${interaction.user.id}>` })]
        : [];
      await waitMsg.edit({ embeds, components: [] }).catch(err => log.warn({ err }, 'Failed to complete Fixed message'));
    }

    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter) {
      const starterEmbed = starter.embeds[0];
      if (starterEmbed) {
        const updated = EmbedBuilder.from(starterEmbed);
        updated.addFields({ name: '\u200B', value: `🔐 Closed by <@${interaction.user.id}> (issue marked fixed)` });
        await starter.edit({ embeds: [updated] }).catch(err => log.warn({ err }, 'Failed to edit starter'));
      }
    }

    const scheduled = await scheduleClose(thread, 'resolved', closeAt, noticeMsg?.id ?? '');
    if (!scheduled) {
      await noticeMsg?.delete().catch(() => {});
      await interaction.editReply({ content: 'This report is already closing.' });
      return;
    }
    await interaction.editReply({ content: 'Thanks! This report will close as resolved shortly - add any final notes before then.' });
  }

  @ButtonComponent({ id: /^cancel_close_/ })
  async cancelClose(interaction: ButtonInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can cancel a scheduled close.', flags: MessageFlags.Ephemeral });
      return;
    }

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const claimed = await cancelScheduledClose(thread.id);
    if (!claimed) {
      await interaction.reply({ content: 'There is no pending close to cancel.', flags: MessageFlags.Ephemeral });
      return;
    }

    await stripClosingNoticeFrom(thread, claimed.noticeMessageId);
    await thread.messages.fetch(claimed.noticeMessageId).then(msg =>
      msg.edit({ components: msg.components.slice(0, -1) })
    ).catch(err => log.warn({ err }, 'Failed to remove Cancel Close button'));
    await thread.send(`↩️ Scheduled close cancelled by <@${interaction.user.id}> - this report stays open.`);
    await interaction.reply({ content: 'Close cancelled - the report stays open.', flags: MessageFlags.Ephemeral });
  }

  @ButtonComponent({ id: /^staff_actions_/ })
  async staffActions(interaction: ButtonInteraction) {
    if (!(interaction.member instanceof GuildMember) || !canRenameThread(interaction.member)) {
      await interaction.reply({ content: 'You do not have permission to use this action.', flags: MessageFlags.Ephemeral });
      return;
    }

    const ticketId = interaction.customId.replace('staff_actions_', '');
    await interaction.reply(buildStaffActionsReply(ticketId, !hasStaffRole(interaction.member)));
  }

  @SelectMenuComponent({ id: /^staff_select_/ })
  async staffSelect(interaction: StringSelectMenuInteraction) {
    if (!(interaction.member instanceof GuildMember) || !canRenameThread(interaction.member)) {
      await interaction.reply({ content: 'You do not have permission to use this action.', flags: MessageFlags.Ephemeral });
      return;
    }

    const [action] = interaction.values;
    if (!['assign', 'close', 'merge', 'waituser', 'snooze', 'rename'].includes(action)) {
      await interaction.reply({ content: 'Invalid action.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (action !== 'rename' && !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'You do not have permission to use this action.', flags: MessageFlags.Ephemeral });
      return;
    }

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
      return;
    }

    const pendingClose = await getScheduledClose(thread.id);
    if (pendingClose) {
      await interaction.reply({ content: 'This report is closing soon - staff actions are locked until then.', flags: MessageFlags.Ephemeral });
      return;
    }

    const pendingSnooze = await getScheduledSnooze(thread.id);
    if (pendingSnooze) {
      await interaction.reply({ content: snoozeLockMsg(pendingSnooze), flags: MessageFlags.Ephemeral });
      return;
    }

    if (action === 'rename') {
      const ticketId = interaction.customId.replace('staff_select_', '');
      await interaction.showModal(buildRenameModal(thread, ticketId));
      return;
    }

    if (action === 'waituser') {
      const ticketId = interaction.customId.replace('staff_select_', '');
      await interaction.showModal(buildWaitUserModal(ticketId));
      return;
    }

    if (action === 'snooze') {
      const ticketId = interaction.customId.replace('staff_select_', '');
      await interaction.showModal(buildSnoozeModal(ticketId));
      return;
    }

    if (action === 'merge') {
      await interaction.showModal(buildMergeModal(`merge_modal_${interaction.id}`));
      return;
    }

    if (action === 'assign') {
      const ticketId = interaction.customId.replace('staff_select_', '');
      await interaction.showModal(await assignModalForThread(thread, ticketId, interaction.user.id));
      return;
    }

    await interaction.deferUpdate();
    await interaction.deleteReply().catch(() => {});

    const closeResult = await beginScheduledClose(thread, interaction.user.id);
    await interaction.followUp({ content: closeResult.message, flags: MessageFlags.Ephemeral });
  }

  @ModalComponent({ id: /^assign_modal_/ })
  async handleAssignSubmit(interaction: ModalSubmitInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can use staff actions.', flags: MessageFlags.Ephemeral });
      return;
    }

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
      return;
    }

    const pendingClose = await getScheduledClose(thread.id);
    if (pendingClose) {
      await interaction.reply({ content: 'This report is closing soon - staff actions are locked until then.', flags: MessageFlags.Ephemeral });
      return;
    }

    const target = interaction.fields.getSelectedUsers('assignee', false)?.first();
    if (!target) {
      await interaction.reply({ content: 'No user selected.', flags: MessageFlags.Ephemeral });
      return;
    }

    const fromMessage = interaction.isFromMessage();
    if (fromMessage) {
      await interaction.deferUpdate();
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    const respond = (content: string) =>
      fromMessage
        ? interaction.followUp({ content, flags: MessageFlags.Ephemeral })
        : interaction.editReply({ content });

    const member = await guild.members.fetch(target.id).catch(() => null);
    if (!member || !hasStaffRole(member)) {
      await respond(`<@${target.id}> doesn't have the staff role and can't be assigned.`);
      return;
    }

    if (fromMessage) await interaction.deleteReply().catch(() => {});
    await applyAssignment(thread, guild, target.id, target.username);
    await respond(`Assigned <@${target.id}> to this report.`);
  }

  @ModalComponent({ id: /^rename_modal_/ })
  async handleRenameSubmit(interaction: ModalSubmitInteraction) {
    if (!(interaction.member instanceof GuildMember) || !canRenameThread(interaction.member)) {
      await interaction.reply({ content: 'You do not have permission to rename report threads.', flags: MessageFlags.Ephemeral });
      return;
    }

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (await getScheduledClose(thread.id)) {
      await interaction.reply({ content: 'This report is closing soon - staff actions are locked until then.', flags: MessageFlags.Ephemeral });
      return;
    }

    const pendingSnooze = await getScheduledSnooze(thread.id);
    if (pendingSnooze) {
      await interaction.reply({ content: snoozeLockMsg(pendingSnooze), flags: MessageFlags.Ephemeral });
      return;
    }

    const newTitle = interaction.fields.getTextInputValue('title').trim();
    if (!newTitle) {
      await interaction.reply({ content: 'The title cannot be empty.', flags: MessageFlags.Ephemeral });
      return;
    }

    const ticketId = interaction.customId.replace('rename_modal_', '');

    const fromMessage = interaction.isFromMessage();
    if (fromMessage) {
      await interaction.deferUpdate();
      await interaction.deleteReply().catch(() => {});
    } else {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
    const respond = (content: string) =>
      fromMessage
        ? interaction.followUp({ content, flags: MessageFlags.Ephemeral })
        : interaction.editReply({ content });

    // Compute `desired` inside the lock so a concurrent status-emoji change can't
    // be clobbered: if the status worker renames the thread between computing the
    // title and acquiring the lock, we'd write back a stale prefix. Recomputing
    // from thread.name under the lock preserves whatever emoji is current.
    let outcome: { noop: true } | { noop: false; name: string };
    try {
      outcome = await withThreadLock(thread.id, async () => {
        const desired = composeReportTitle(splitReportTitle(thread.name, ticketId), newTitle);
        if (thread.name === desired) return { noop: true as const };
        await thread.setName(desired);
        return { noop: false as const, name: desired };
      });
    } catch (err) {
      if (isRateLimit(err)) {
        const retryAt = Math.floor((Date.now() + retryDelay(err)) / 1000);
        await respond(`Discord only allows 2 thread renames per 10 minutes. Try again <t:${retryAt}:R> with:\n${quoteTitle(newTitle)}`);
        return;
      }
      log.warn({ err, threadId: thread.id }, 'Failed to rename report thread');
      await respond(`Failed to rename this thread. Your title was:\n${quoteTitle(newTitle)}`);
      return;
    }

    if (outcome.noop) {
      await respond('The title is already set to that.');
      return;
    }

    log.info({ userId: interaction.user.id, threadId: thread.id, ticketId, name: outcome.name }, 'Report thread renamed');
    await StoredReport.update(thread.id, { threadName: outcome.name });

    const starter = await thread.fetchStarterMessage().catch(() => null);
    const tracker = trackerRefFromStarter(starter);
    if (tracker) await renameTrackerThread(guild, tracker.threadId, outcome.name);

    await respond(`Renamed to **${outcome.name}**`);
  }

  @ButtonComponent({ id: /^split_/ })
  async splitToThread(interaction: ButtonInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can split reports.', flags: MessageFlags.Ephemeral });
      return;
    }

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    if (!guild) return;

    const additionalMsg = interaction.message;
    const additionalEmbed = additionalMsg.embeds?.[0];
    const rawDetails = additionalEmbed?.description?.trim() || '';

    const starter = await thread.fetchStarterMessage();
    if (!starter) {
      await interaction.reply({ content: 'Could not find the report starter message.', flags: MessageFlags.Ephemeral });
      return;
    }

    const opEmbed = starter.embeds[0];
    if (!opEmbed) {
      await interaction.reply({ content: 'Could not find the report embed.', flags: MessageFlags.Ephemeral });
      return;
    }

    const trackerField = opEmbed.fields?.find(f =>
      f.value?.startsWith(TRACKER_FIELD_PREFIX),
    );
    if (!trackerField) {
      await interaction.reply({ content: 'No route tracker thread found for this report.', flags: MessageFlags.Ephemeral });
      return;
    }
    const trackerUrl = trackerField.value?.match(/\]\((.+?)\)/)?.[1];
    if (!trackerUrl) {
      await interaction.reply({ content: 'Could not parse the tracker link.', flags: MessageFlags.Ephemeral });
      return;
    }

    const config = loadConfig();
    const forum = await getForum(guild, config.forumChannelId);
    if (!forum) {
      await interaction.reply({ content: 'Forum channel not found.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferUpdate();

    const opTitle = opEmbed.title || thread.name;
    const splitEmbed = new EmbedBuilder()
      .setColor(COLORS.blurple)
      .setTitle(`${opTitle} (Split)`)
      .setDescription(rawDetails || 'Additional report')
      .addFields(
        { name: '\u200B', value: `${TRACKER_FIELD_PREFIX}(${trackerUrl})` },
        { name: '\u200B', value: `[Original Report \u2192](${starter.url})` },
      )
      .setTimestamp();

    const splitName = `✂️ Split - ${thread.name}`;
    const threadName = splitName.length > 100 ? splitName.slice(0, 97) + '\u2026' : splitName;

    const newThread = await forum.threads.create({
      name: threadName,
      message: { embeds: [splitEmbed] },
      appliedTags: thread.appliedTags as string[],
    });

    const splitTicketId = String(parseInt(newThread.id.slice(-7), 10));

    // Creation hook: a split is a new report owned by the original submitter.
    // A split is a new report owned by the original submitter.
    const splitSubmitter = await resolveSubmitterId(thread, guild);
    if (splitSubmitter) {
      const splitTagNameById = new Map(forum.availableTags.map(t => [t.id, t.name]));
      await StoredReport.record({
        threadId: newThread.id,
        ticketId: splitTicketId,
        reporterId: splitSubmitter,
        label: 'Split',
        threadName: newThread.name,
        url: newThread.url,
        tagNames: (newThread.appliedTags as string[]).map(id => splitTagNameById.get(id) ?? ''),
        createdTimestamp: newThread.createdTimestamp ?? Date.now(),
        lastActivityAt: Date.now(),
      });
    }

    const splitStarter = await newThread.fetchStarterMessage();
    if (splitStarter) {
      const actionRow = buildActionRow(splitTicketId);
      await splitStarter.edit({ components: [actionRow] }).catch(err => log.warn({ err }, 'Failed to add action buttons'));
      await splitStarter.pin().catch(err => log.warn({ err }, 'Failed to pin split starter'));
    }

    const updatedEmbed = EmbedBuilder.from(opEmbed);
    const origPostIdx = opEmbed.fields?.findIndex(
      f => f.name === 'Original Post' || ('value' in f && (f.value as string)?.startsWith('[Original Post \u2192]')),
    ) ?? -1;
    const splitField = { name: '✂️ Split', value: `[${newThread.name}](${newThread.url})`, inline: true };
    if (origPostIdx >= 0) {
      updatedEmbed.spliceFields(origPostIdx, 0, splitField);
    } else {
      updatedEmbed.addFields(splitField);
    }
    await starter.edit({ embeds: [updatedEmbed] }).catch(err => log.warn({ err }, 'Failed to edit OP embed'));

    const updatedAdditionalEmbed = EmbedBuilder.from(additionalEmbed!);
    updatedAdditionalEmbed.addFields({ name: '✂️ Split to', value: `[${newThread.name}](${newThread.url})`, inline: true });
    await interaction.message.edit({ embeds: [updatedAdditionalEmbed], components: [] }).catch(err => log.warn({ err }, 'Failed to edit additional embed'));
  }

  @ModalComponent({ id: /^additional_report_modal_/ })
  async additionalReportModal(interaction: ModalSubmitInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // additional_report_modal_ready_<ticketId>_<msgId> reopens a WAITING FOR USER report
    const ready = interaction.customId.startsWith('additional_report_modal_ready_');
    const readyMsgId = ready ? interaction.customId.split('_')[5] : null;

    const routeId = interaction.fields.getTextInputValue('route_id');
    const details = interaction.fields.getTextInputValue('details');

    log.info({
      userId: interaction.user.id,
      type: 'additional',
      route: routeId,
      details: details || null,
    }, 'Additional report submitted');

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.editReply({ content: 'This can only be used from a thread.' });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.editReply({ content: 'Could not resolve guild.' });
      return;
    }

    await submitAdditionalReport({
      interaction, thread, guild, userId: interaction.user.id,
      routeInput: routeId, details,
      ready: readyMsgId ? { readyMsgId } : null,
      force: false,
    });
  }

  @ModalComponent({ id: /^merge_modal_/ })
  async mergeModal(interaction: ModalSubmitInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can merge reports.', flags: MessageFlags.Ephemeral });
      return;
    }

    const targetStr = interaction.fields.getTextInputValue('target_thread').trim();
    const targetId = targetStr.split('/').pop() || targetStr;

    const source = interaction.channel;
    if (!source?.isThread()) {
      await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
      return;
    }

    const targetChannel = await guild.channels.fetch(targetId);
    if (!targetChannel?.isThread()) {
      await interaction.reply({ content: 'Target channel is not a valid thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const sourceStarter = await source.fetchStarterMessage();
    if (sourceStarter) {
      const sourceEmbed = sourceStarter.embeds[0];
      if (sourceEmbed) {
        const mergedEmbed = EmbedBuilder.from(sourceEmbed);
        mergedEmbed.addFields({ name: '\u200B', value: `Merged from [${source.name}](${source.url})` });
        await targetChannel.send({ embeds: [mergedEmbed] });
      }
    }

    await interaction.reply({ content: `Report merged into ${targetChannel}.`, flags: MessageFlags.Ephemeral });

    if (guild) {
      const mergeDeferred = await setThreadStatusAndClose(source, 'closed');
      if (mergeDeferred) {
        await interaction.followUp({
          content: 'Closing the source thread - it may take a moment if Discord is rate-limiting us.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
    }
  }

  @ModalComponent({ id: /^snooze_modal_/ })
  async handleSnoozeSubmit(interaction: ModalSubmitInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can snooze reports.', flags: MessageFlags.Ephemeral });
      return;
    }

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const guild = interaction.guild;
    if (!guild) {
      await interaction.reply({ content: 'Could not resolve guild.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (await getScheduledClose(thread.id)) {
      await interaction.reply({ content: CLOSING_LOCK_MSG, flags: MessageFlags.Ephemeral });
      return;
    }
    if (await getScheduledSnooze(thread.id)) {
      await interaction.reply({ content: 'This report is already snoozed.', flags: MessageFlags.Ephemeral });
      return;
    }

    const duration = interaction.fields.getStringSelectValues('duration')[0] ?? DEFAULT_SNOOZE;
    const reason = interaction.fields.getTextInputValue('reason').trim();
    const wakeAt = Date.now() + snoozeDurationMs(duration);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Capture pre-snooze state so the wake can restore it verbatim.
    const priorName = thread.name;
    const priorTagIds = thread.appliedTags as string[];

    // Flag the snoozed state in the forum list via the title emoji.
    const base = stripLeadingEmoji(thread.name).replace(/^ /, '');
    const snoozedName = `${SNOOZE_EMOJI} ${base}`.slice(0, 100);
    if (thread.name !== snoozedName) {
      await thread.setName(snoozedName).catch(err => log.warn({ err }, 'Failed to rename thread for snooze'));
    }

    const embed = new EmbedBuilder()
      .setColor(COLORS.amber)
      .setTitle('😴 Snoozed')
      .setDescription(`Snoozed by <@${interaction.user.id}>.${reason ? `\n\n${reason}` : ''}`)
      .addFields(wakesField(wakeAt))
      .setTimestamp();
    const reopenRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('reopen_now').setLabel('Reopen Now').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
    );
    const snoozeMsg = await thread.send({ embeds: [embed], components: [reopenRow] }).catch(err => { log.warn({ err }, 'Failed to post snooze notice'); return null; });
    if (!snoozeMsg) {
      await interaction.editReply({ content: 'Failed to post the snooze notice.' });
      return;
    }

    const fetched = await getForum(guild, loadConfig().forumChannelId);
    if (fetched) {
      const forum = await ensureForumTag(fetched, 'SNOOZED');
      await swapForumTags(thread, forum, { remove: ['OPEN', 'WAITING FOR DEV', 'WAITING FOR USER'], add: ['SNOOZED'] })
        .catch(err => log.warn({ err }, 'Failed to swap forum tags for snooze'));
    }
    // Post the notice before archiving: a locked/archived thread can't receive it.
    if (!thread.locked) await thread.setLocked(true).catch(err => log.warn({ err }, 'Failed to lock snoozed thread'));
    if (!thread.archived) await thread.setArchived(true).catch(err => log.warn({ err }, 'Failed to archive snoozed thread'));

    await scheduleSnooze(thread.id, wakeAt, snoozeMsg.id, reason || undefined, interaction.user.id, priorTagIds, priorName);
    await StoredReport.syncFromThread(thread);

    await interaction.editReply({ content: `Report snoozed - it will reopen <t:${Math.floor(wakeAt / 1000)}:R>. Use **Reopen Now** on the notice to cancel early.` });
  }

  @ButtonComponent({ id: 'reopen_now' })
  async handleReopenNow(interaction: ButtonInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can reopen a snoozed report.', flags: MessageFlags.Ephemeral });
      return;
    }

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    if (!(await getScheduledSnooze(thread.id))) {
      await interaction.reply({ content: 'This report is not snoozed.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const entry = await reopenSnoozedThread(thread);
    if (!entry) {
      await interaction.editReply({ content: 'This report is not snoozed.' });
      return;
    }
    await finalizeSnoozeMessage(thread, entry.snoozeMessageId, { title: '↩️ Snooze Cancelled', cancelledBy: interaction.user.id });
    await interaction.editReply({ content: 'Snooze cancelled - report reopened.' });
  }

  @ButtonComponent({ id: /^assign_/ })
  @ButtonComponent({ id: /^close_/ })
  @ButtonComponent({ id: /^merge_/ })
  async legacyButton(interaction: ButtonInteraction) {
    await this.handleLegacyButton(interaction);
  }

  private async handleLegacyButton(interaction: ButtonInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can use staff actions.', flags: MessageFlags.Ephemeral });
      return;
    }

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.reply({ content: 'This can only be used from a thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const ticketId = await updateThreadButtons(thread);
    if (!ticketId) {
      await interaction.reply({ content: 'Could not update thread buttons. Use `/update-report-thread` instead.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({
      content: `Thread updated to the new button format. (Ticket **${ticketId}**) Use **Staff Actions** to assign, merge, or close.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

const guildId = loadConfig().guildId;

@Discord()
@Guild(guildId)
@SlashGroup({
  description: 'Report thread management',
  name: 'report-actions',
  defaultMemberPermissions: PermissionFlagsBits.ManageThreads,
})
@SlashGroup('report-actions')
export class ReportCommands {
  @Slash({ description: 'Update the action buttons on this report thread to the latest format', name: 'update-thread' })
  async updateThread(interaction: CommandInteraction) {
    if (!(interaction.member instanceof GuildMember) || !hasStaffRole(interaction.member)) {
      await interaction.reply({ content: 'Only staff can update report threads.', flags: MessageFlags.Ephemeral });
      return;
    }

    const channel = interaction.channel;
    if (!channel?.isThread()) {
      await interaction.reply({ content: 'This command can only be used inside a report thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const ticketId = await updateThreadButtons(channel);
    if (!ticketId) {
      await interaction.reply({ content: 'Could not update thread buttons. No report embed found.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply({ content: `Report thread buttons updated to the latest format. (Ticket **${ticketId}**)`, flags: MessageFlags.Ephemeral });
  }

  @Slash({ description: 'Open the staff actions menu for this report thread', name: 'staff-actions' })
  async staffActionsCommand(interaction: CommandInteraction) {
    if (!(interaction.member instanceof GuildMember) || !canRenameThread(interaction.member)) {
      await interaction.reply({ content: 'You do not have permission to use this action.', flags: MessageFlags.Ephemeral });
      return;
    }

    const thread = interaction.channel;
    if (!thread?.isThread()) {
      await interaction.reply({ content: 'This command can only be used inside a report thread.', flags: MessageFlags.Ephemeral });
      return;
    }

    const starter = await thread.fetchStarterMessage();
    const ticketId = ticketIdFromStarter(starter);
    if (!ticketId) {
      await interaction.reply({ content: 'No Staff Actions button found in this thread\'s starter message.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.reply(buildStaffActionsReply(ticketId, !hasStaffRole(interaction.member)));
  }
}

@Discord()
export class BotReportStaffContextMenus {
  @ContextMenu({ name: 'Rename Thread', type: ApplicationCommandType.Message, defaultMemberPermissions: 0n })
  @Guild(guildId)
  async renameContext(interaction: MessageContextMenuCommandInteraction) {
    if (!(interaction.member instanceof GuildMember) || !canRenameThread(interaction.member)) {
      await interaction.reply({ content: 'You do not have permission to rename report threads.', flags: MessageFlags.Ephemeral });
      return;
    }
    const ctx = await resolveStaffActionContext(interaction);
    if (!ctx) return;
    await interaction.showModal(buildRenameModal(ctx.thread, ctx.ticketId));
  }

  @ContextMenu({ name: 'Assign', type: ApplicationCommandType.Message, defaultMemberPermissions: PermissionFlagsBits.ManageThreads })
  @Guild(guildId)
  async assignContext(interaction: MessageContextMenuCommandInteraction) {
    const ctx = await resolveStaffActionContext(interaction);
    if (!ctx) return;
    await interaction.showModal(await assignModalForThread(ctx.thread, ctx.ticketId, interaction.user.id));
  }

  @ContextMenu({ name: 'Request User Testing', type: ApplicationCommandType.Message, defaultMemberPermissions: PermissionFlagsBits.ManageThreads })
  @Guild(guildId)
  async waitUserContext(interaction: MessageContextMenuCommandInteraction) {
    const ctx = await resolveStaffActionContext(interaction);
    if (!ctx) return;
    await interaction.showModal(buildWaitUserModal(ctx.ticketId));
  }

  @ContextMenu({ name: 'Merge', type: ApplicationCommandType.Message, defaultMemberPermissions: PermissionFlagsBits.ManageThreads })
  @Guild(guildId)
  async mergeContext(interaction: MessageContextMenuCommandInteraction) {
    const ctx = await resolveStaffActionContext(interaction);
    if (!ctx) return;
    await interaction.showModal(buildMergeModal(`merge_modal_${interaction.id}`));
  }

  @ContextMenu({ name: 'Snooze', type: ApplicationCommandType.Message, defaultMemberPermissions: PermissionFlagsBits.ManageThreads })
  @Guild(guildId)
  async snoozeContext(interaction: MessageContextMenuCommandInteraction) {
    const ctx = await resolveStaffActionContext(interaction);
    if (!ctx) return;
    await interaction.showModal(buildSnoozeModal(ctx.ticketId));
  }

  @ContextMenu({ name: 'Close', type: ApplicationCommandType.Message, defaultMemberPermissions: PermissionFlagsBits.ManageThreads })
  @Guild(guildId)
  async closeContext(interaction: MessageContextMenuCommandInteraction) {
    const ctx = await resolveStaffActionContext(interaction);
    if (!ctx) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await beginScheduledClose(ctx.thread, interaction.user.id);
    await interaction.editReply({ content: result.message });
  }
}
