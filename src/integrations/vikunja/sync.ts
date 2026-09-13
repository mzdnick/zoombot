import type { Client, ThreadChannel } from 'discord.js';
import type { VikunjaConfig } from '../../config.js';
import { stripRouteIds } from '../../comma.js';
import { createLogger } from '../../logger.js';
import { createStore } from '../../store.js';
import type { ReportCategory } from '../../handlers/report/my-reports.js';
import { StoredReport } from '../../handlers/report/report-store.js';
import { getScheduledSnooze } from '../../handlers/report/snooze-scheduler.js';
import { splitReportTitle } from '../../handlers/report/title-sync.js';
import {
  VikunjaClient,
  VikunjaError,
  VikunjaNotFoundError,
  type VikunjaLabel,
  type VikunjaTask,
  type VikunjaTaskPatch,
} from './client.js';

const log = createLogger('vikunja-sync');

export const VIKUNJA_TYPE_LABELS = ['Bug Report', 'Feedback', 'Feature Request', 'Split'] as const;
export const VIKUNJA_STATE_LABELS = ['Waiting for Developer', 'Waiting for User', 'Snoozed', 'Closed'] as const;
export const VIKUNJA_OWNED_LABELS = [...VIKUNJA_TYPE_LABELS, ...VIKUNJA_STATE_LABELS] as const;

const typeLabelByStoredTagName = new Map<string, (typeof VIKUNJA_TYPE_LABELS)[number]>([
  ['BUG', 'Bug Report'],
  ['FEEDBACK', 'Feedback'],
  ['FEATURE REQUEST', 'Feature Request'],
  ['SPLIT', 'Split'],
]);
const ownedLabelNames = new Set<string>(VIKUNJA_OWNED_LABELS);
const stateLabelByCategory: Record<ReportCategory, (typeof VIKUNJA_STATE_LABELS)[number]> = {
  'Waiting for Dev': 'Waiting for Developer',
  'Needs your Attention': 'Waiting for User',
  Snoozed: 'Snoozed',
  Closed: 'Closed',
};

const linkStore = createStore<string>('vikunja-links');
const THREAD_KEY = 'thread:';
const TASK_KEY = 'task:';

export interface InitializedVikunja {
  config: VikunjaConfig;
  api: VikunjaClient;
  botUserId: number;
  labelIds: ReadonlyMap<string, number>;
  discordUserToVikunja: Readonly<Record<string, number>>;
}

let integration: InitializedVikunja | null = null;
let initializing: Promise<boolean> | null = null;
let createLock = Promise.resolve();

async function withCreateLock<T>(fn: () => Promise<T>): Promise<T> {
  const previous = createLock;

  let release!: () => void;
  createLock = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous;

  try {
    return await fn();
  } finally {
    release();
  }
}

export function getVikunjaIntegration(): InitializedVikunja | null {
  return integration;
}

export function stateLabelForCategory(category: ReportCategory): (typeof VIKUNJA_STATE_LABELS)[number] {
  return stateLabelByCategory[category];
}

export function expectedIntegrationLabels(
  typeLabel: (typeof VIKUNJA_TYPE_LABELS)[number],
  stateLabel: (typeof VIKUNJA_STATE_LABELS)[number],
): string[] {
  return [typeLabel, stateLabel];
}

export function taskTitleForThread(threadName: string, ticketId: string, fallbackTitle: string): string {
  const humanTitle = splitReportTitle(threadName, ticketId).title.trim() || fallbackTitle;
  return `#${ticketId} — ${humanTitle}`;
}

export function labelChanges(
  current: ReadonlyArray<Pick<VikunjaLabel, 'id' | 'title'>>,
  desired: ReadonlyArray<string>,
): { remove: number[]; add: string[] } {
  const desiredNames = new Set(desired);
  const presentNames = new Set(current.map(label => label.title));
  return {
    remove: current
      .filter(label => ownedLabelNames.has(label.title) && !desiredNames.has(label.title))
      .map(label => label.id),
    add: desired.filter(name => !presentNames.has(name)),
  };
}

export function extractDiscordAssignee(fields: ReadonlyArray<{ name: string; value: string }> | undefined): string | null {
  return fields?.find(field => field.name === '👤 Assigned to')?.value.match(/<@!?(\d+)>/)?.[1] ?? null;
}

export function reverseUserMap(userMap: Record<string, string>): Record<string, number> {
  const reversed: Record<string, number> = {};
  for (const [vikunjaUserId, discordUserId] of Object.entries(userMap)) {
    const id = Number(vikunjaUserId);
    if (Number.isSafeInteger(id) && id > 0) reversed[discordUserId] = id;
  }
  return reversed;
}

export interface DiscordCommentInput {
  displayName: string;
  content: string;
  url: string;
  attachments: ReadonlyArray<{ name?: string | null; url: string }>;
}

export function formatDiscordComment(input: DiscordCommentInput): string | null {
  const content = stripRouteIds(input.content);
  const attachments = input.attachments.map(attachment =>
    `[${attachment.name || 'Attachment'}](${attachment.url})`);
  if (!content && attachments.length === 0) return null;
  return [
    `**Discord · ${input.displayName}**`,
    content,
    attachments.join('\n'),
    `[Open in Discord](${input.url})`,
  ].filter(Boolean).join('\n\n');
}

interface EmbedLike {
  title?: string | null;
  description?: string | null;
  fields?: ReadonlyArray<{ name: string; value: string }>;
}

export function renderDiscordEmbed(embed: EmbedLike | undefined): string {
  if (!embed) return '';
  const parts: string[] = [];
  if (embed.title) parts.push(`**${embed.title}**`);
  if (embed.description) parts.push(embed.description);
  for (const field of embed.fields ?? []) {
    if (!field.value?.trim()) continue;
    if (!field.name || field.name === '\u200B') parts.push(field.value);
    else parts.push(`**${field.name}**\n${field.value}`);
  }
  return parts.join('\n\n');
}

export async function taskIdForThread(threadId: string): Promise<number | null> {
  const stored = await linkStore.get(`${THREAD_KEY}${threadId}`);
  const id = Number(stored);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function threadIdForTask(taskId: number): Promise<string | null> {
  return (await linkStore.get(`${TASK_KEY}${taskId}`)) ?? null;
}

export async function saveLink(threadId: string, taskId: number): Promise<void> {
  await linkStore.set(`${THREAD_KEY}${threadId}`, String(taskId));
  await linkStore.set(`${TASK_KEY}${taskId}`, threadId);
}

export async function removeLink(threadId: string, taskId?: number): Promise<void> {
  const resolvedTaskId = taskId ?? await taskIdForThread(threadId);
  await linkStore.delete(`${THREAD_KEY}${threadId}`);
  if (resolvedTaskId != null) await linkStore.delete(`${TASK_KEY}${resolvedTaskId}`);
}

// Serializes projection per thread to prevent duplicate task creation.
const syncLocks = new Map<string, Promise<unknown>>();

function withSyncLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const previous = syncLocks.get(threadId) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  syncLocks.set(threadId, tail);
  void tail.then(() => {
    if (syncLocks.get(threadId) === tail) syncLocks.delete(threadId);
  });
  return run;
}

export async function initializeVikunja(config: VikunjaConfig): Promise<boolean> {
  if (integration) return true;
  if (initializing) return initializing;

  initializing = (async () => {
    try {
      const api = new VikunjaClient(config);
      const [user, project, labels] = await Promise.all([
        api.getCurrentUser(),
        api.getProject(config.projectId),
        api.listLabels(),
      ]);
      if (project.id !== config.projectId) {
        log.error({ projectId: config.projectId }, 'Vikunja project lookup returned the wrong project');
        return false;
      }

      const labelIds = new Map<string, number>();
      const duplicates = new Set<string>();
      for (const label of labels) {
        if (!ownedLabelNames.has(label.title)) continue;
        if (labelIds.has(label.title)) duplicates.add(label.title);
        else labelIds.set(label.title, label.id);
      }
      const missing = VIKUNJA_OWNED_LABELS.filter(name => !labelIds.has(name));
      if (missing.length > 0 || duplicates.size > 0) {
        log.error({ missing, duplicates: [...duplicates] }, 'Vikunja disabled: required labels are missing or duplicated');
        return false;
      }

      integration = {
        config,
        api,
        botUserId: user.id,
        labelIds,
        discordUserToVikunja: reverseUserMap(config.userMap),
      };
      log.info({ projectId: config.projectId, botUserId: user.id }, 'Vikunja synchronization initialized');
      return true;
    } catch (err) {
      log.warn({ err }, 'Vikunja initialization failed; synchronization disabled for this process');
      return false;
    } finally {
      initializing = null;
    }
  })();
  return initializing;
}

interface DesiredTask {
  title: string;
  description: string;
  typeLabel: (typeof VIKUNJA_TYPE_LABELS)[number];
  stateLabel: (typeof VIKUNJA_STATE_LABELS)[number];
  done: boolean;
  dueDate: string | null;
  assigneeId: number | null;
}

function isTypeLabel(label: string): label is (typeof VIKUNJA_TYPE_LABELS)[number] {
  return (VIKUNJA_TYPE_LABELS as readonly string[]).includes(label);
}

export function resolveReportType(
  report: Pick<StoredReport['data'], 'label' | 'tagNames'>,
): (typeof VIKUNJA_TYPE_LABELS)[number] | null {
  if (isTypeLabel(report.label)) return report.label;
  if (report.label !== 'Report') return null;
  const matches = report.tagNames
    .map(tagName => isTypeLabel(tagName) ? tagName : typeLabelByStoredTagName.get(tagName))
    .filter((typeLabel): typeLabel is (typeof VIKUNJA_TYPE_LABELS)[number] => typeLabel != null);
  return matches.length === 1 ? matches[0] : null;
}

async function desiredTaskFor(thread: ThreadChannel, report: StoredReport, starter: Awaited<ReturnType<ThreadChannel['fetchStarterMessage']>>): Promise<DesiredTask | null> {
  const typeLabel = resolveReportType(report.data);
  if (!typeLabel) {
    log.warn({ threadId: thread.id, label: report.data.label }, 'Vikunja sync skipped report with an unknown type label');
    return null;
  }
  const stateLabel = stateLabelForCategory(report.category);
  const snooze = report.category === 'Snoozed' ? await getScheduledSnooze(thread.id) : undefined;
  const discordAssignee = extractDiscordAssignee(starter?.embeds[0]?.fields);
  const assigneeId = discordAssignee ? integration?.discordUserToVikunja[discordAssignee] ?? null : null;
  if (discordAssignee && assigneeId == null) {
    log.debug({ threadId: thread.id, discordAssignee }, 'Vikunja assignee is not mapped');
  }

  const reporter = thread.guild.members.cache.get(report.reporterId)?.displayName;
  const starterMarkdown = renderDiscordEmbed(starter?.embeds[0]);
  const description = [
    `**Ticket:** #${report.data.ticketId}`,
    `**Type:** ${typeLabel}`,
    ...(reporter ? [`**Reporter:** ${reporter}`] : []),
    `[Open in Discord](${thread.url})`,
    ...(starterMarkdown ? ['---', starterMarkdown] : []),
  ].join('\n\n');

  return {
    title: taskTitleForThread(thread.name, report.data.ticketId, typeLabel),
    description,
    typeLabel,
    stateLabel,
    done: report.category === 'Closed',
    dueDate: snooze ? new Date(snooze.wakeAt).toISOString() : null,
    assigneeId,
  };
}

function dueDateTime(value: string | null | undefined): number | null {
  if (!value || value.startsWith('0001-01-01')) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function taskPatch(task: VikunjaTask, desired: DesiredTask): VikunjaTaskPatch | null {
  const patch: VikunjaTaskPatch = {};
  if (task.title !== desired.title) patch.title = desired.title;
  if (task.description !== desired.description) patch.description = desired.description;
  if (Boolean(task.done) !== desired.done) patch.done = desired.done;
  if (dueDateTime(task.due_date) !== dueDateTime(desired.dueDate)) patch.due_date = desired.dueDate;
  return Object.keys(patch).length > 0 ? patch : null;
}

async function createLinkedTask(thread: ThreadChannel, desired: DesiredTask): Promise<number> {
  const current = integration;
  if (!current) throw new Error('Vikunja is not initialized');
  const task = await withCreateLock(() => current.api.createTask(current.config.projectId, {
    title: desired.title,
    description: desired.description,
    done: desired.done,
    ...(desired.dueDate ? { due_date: desired.dueDate } : {}),
  }));
  // Link immediately before secondary label/assignee writes.
  await saveLink(thread.id, task.id);
  return task.id;
}

async function getOrCreateTask(thread: ThreadChannel, desired: DesiredTask): Promise<VikunjaTask> {
  const current = integration;
  if (!current) throw new Error('Vikunja is not initialized');
  let taskId = await taskIdForThread(thread.id);
  if (taskId == null) {
    // On GET failure after create, caller retries without duplicating.
    taskId = await createLinkedTask(thread, desired);
    return current.api.getTask(taskId);
  }
  try {
    const task = await current.api.getTask(taskId);
    // Repair reverse link if process halted between writes.
    await saveLink(thread.id, task.id);
    return task;
  } catch (err) {
    if (!(err instanceof VikunjaNotFoundError)) throw err;
    await removeLink(thread.id, taskId);
    taskId = await createLinkedTask(thread, desired);
    return current.api.getTask(taskId);
  }
}

async function normalizeLabels(task: VikunjaTask, desired: DesiredTask): Promise<void> {
  const current = integration;
  if (!current) return;
  const changes = labelChanges(task.labels ?? [], expectedIntegrationLabels(desired.typeLabel, desired.stateLabel));
  for (const labelId of changes.remove) await current.api.removeTaskLabel(task.id, labelId);
  for (const labelName of changes.add) await current.api.addTaskLabel(task.id, current.labelIds.get(labelName)!);
}

async function normalizeAssignee(task: VikunjaTask, desired: DesiredTask): Promise<void> {
  const current = integration;
  if (!current) return;
  const assignees = task.assignees ?? [];
  for (const assignee of assignees) {
    if (assignee.id !== desired.assigneeId) await current.api.removeAssignee(task.id, assignee.id);
  }
  if (desired.assigneeId != null && !assignees.some(assignee => assignee.id === desired.assigneeId)) {
    await current.api.addAssignee(task.id, desired.assigneeId);
  }
}

async function syncUnlocked(thread: ThreadChannel): Promise<boolean> {
  if (!integration) return false;
  const stored = await StoredReport.get(thread.id);
  if (!stored) return true;
  const report = await StoredReport.syncFromThread(thread);
  if (!report) return true;
  const starter = await thread.fetchStarterMessage().catch(err => {
    log.warn({ err, threadId: thread.id }, 'Vikunja sync could not fetch the report starter');
    return null;
  });
  if (!starter) return false;
  const desired = await desiredTaskFor(thread, report, starter);
  if (!desired) return false;

  const task = await getOrCreateTask(thread, desired);
  const patch = taskPatch(task, desired);
  if (patch) await integration.api.patchTask(task.id, patch);
  await normalizeLabels(task, desired);
  await normalizeAssignee(task, desired);
  return true;
}

/** Best-effort canonical projection. Never lets Vikunja errors reach Discord workflows. */
export async function syncReport(thread: ThreadChannel): Promise<boolean> {
  if (!integration) return false;
  try {
    return await withSyncLock(thread.id, () => syncUnlocked(thread));
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'Vikunja report synchronization failed');
    return false;
  }
}

export function queueVikunjaSync(thread: ThreadChannel): void {
  if (!integration) return;
  void syncReport(thread).catch(err => log.warn({ err, threadId: thread.id }, 'Vikunja queued sync failed'));
}

async function createProjectedComment(thread: ThreadChannel, comment: string): Promise<void> {
  const current = integration;
  if (!current) return;
  if (!(await syncReport(thread))) return;
  const taskId = await taskIdForThread(thread.id);
  if (taskId == null) return;
  await current.api.createComment(taskId, comment);
}

export function queueVikunjaComment(thread: ThreadChannel, input: DiscordCommentInput): void {
  const comment = formatDiscordComment(input);
  if (!integration || !comment) return;
  void createProjectedComment(thread, comment)
    .catch(err => log.warn({ err, threadId: thread.id }, 'Vikunja comment synchronization failed'));
}

export function queueVikunjaEmbedComment(
  thread: ThreadChannel,
  message: { embeds: ReadonlyArray<EmbedLike>; url: string },
): void {
  const content = renderDiscordEmbed(message.embeds[0]);
  if (!content) return;
  queueVikunjaComment(thread, { displayName: 'Starbot', content, url: message.url, attachments: [] });
}

async function relateReports(first: ThreadChannel, second: ThreadChannel): Promise<void> {
  const current = integration;
  if (!current || first.id === second.id) return;
  const [firstSynced, secondSynced] = await Promise.all([syncReport(first), syncReport(second)]);
  if (!firstSynced || !secondSynced) return;
  const [firstTaskId, secondTaskId] = await Promise.all([taskIdForThread(first.id), taskIdForThread(second.id)]);
  if (firstTaskId == null || secondTaskId == null || firstTaskId === secondTaskId) return;
  try {
    await current.api.createRelation(firstTaskId, secondTaskId);
  } catch (err) {
    // Existing relation returns 409 conflict; treat as desired state.
    if (err instanceof VikunjaError && err.status === 409) return;
    throw err;
  }
}

export function queueVikunjaRelation(first: ThreadChannel, second: ThreadChannel): void {
  if (!integration) return;
  void relateReports(first, second)
    .catch(err => log.warn({ err, firstThreadId: first.id, secondThreadId: second.id }, 'Vikunja relation synchronization failed'));
}

function originalReportThreadId(fields: ReadonlyArray<{ name: string; value: string }> | undefined): string | null {
  const value = fields?.find(field => /Original Report/.test(field.value))?.value;
  const url = value?.match(/\]\((.+?)\)/)?.[1];
  const parts = url?.split('/').filter(Boolean);
  return parts?.at(-2) ?? null;
}

async function recoverSplitRelation(client: Client, threadId: string): Promise<void> {
  const split = await client.channels.fetch(threadId).catch(() => null);
  if (!split?.isThread()) return;
  const starter = await split.fetchStarterMessage().catch(() => null);
  const originalId = originalReportThreadId(starter?.embeds[0]?.fields);
  if (!originalId) return;
  const original = await client.channels.fetch(originalId).catch(() => null);
  if (original?.isThread()) await relateReports(split, original);
}

/** Reconciles active and recently closed reports on startup; never scans forum history. */
export async function syncAllReports(client: Client): Promise<void> {
  if (!integration) return;
  const reports = await StoredReport.listAll();
  const recentHorizon = Date.now() - 48 * 60 * 60 * 1000;
  const toSync = reports.filter(r => r.isActive || r.data.lastActivityAt > recentHorizon);
  let processed = 0;
  let succeeded = 0;
  let skipped = 0;
  let failed = 0;
  for (let i = 0; i < toSync.length; i += 5) {
    const chunk = toSync.slice(i, i + 5);
    await Promise.all(chunk.map(async report => {
      processed++;
      const typeKnown = resolveReportType(report.data) != null;
      const channel = await client.channels.fetch(report.threadId).catch(() => null);
      if (!channel?.isThread()) {
        skipped++;
        return;
      }
      if (await syncReport(channel)) succeeded++;
      else if (typeKnown) failed++;
      else skipped++;
    }));
  }
  for (const report of toSync) {
    if (!report.isActive || report.data.label !== 'Split') continue;
    await recoverSplitRelation(client, report.threadId).catch(err =>
      log.warn({ err, threadId: report.threadId }, 'Vikunja split relation recovery failed'));
  }
  log.info({ processed, succeeded, skipped, failed }, 'Vikunja reconciliation complete');
}

/** Recreates a human-deleted task while keeping its reverse link for durable retry. */
export async function recreateDeletedTask(thread: ThreadChannel, deletedTaskId: number): Promise<boolean> {
  return withSyncLock(thread.id, async () => {
    const currentTaskId = await taskIdForThread(thread.id);
    if (currentTaskId != null && currentTaskId !== deletedTaskId) {
      // Ignore delayed deletion event if already replaced.
      await linkStore.delete(`${TASK_KEY}${deletedTaskId}`);
      return true;
    }

    // Retain reverse link until replacement projects to allow retry.
    await linkStore.delete(`${THREAD_KEY}${thread.id}`);
    const synced = await syncUnlocked(thread);
    if (synced) await linkStore.delete(`${TASK_KEY}${deletedTaskId}`);
    return synced;
  });
}
