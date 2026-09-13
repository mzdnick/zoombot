import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Client, GuildMember, ThreadChannel } from 'discord.js';
import { getScheduledClose } from '../../handlers/report/close-scheduler.js';
import { recordHumanReportActivity } from '../../handlers/report/dormant-scheduler.js';
import {
  canRenameThread,
  hasStaffRole,
  renameReportThread,
  setReportAssignee,
} from '../../handlers/report/report-actions.js';
import { StoredReport } from '../../handlers/report/report-store.js';
import { getScheduledSnooze } from '../../handlers/report/snooze-scheduler.js';
import { createLogger } from '../../logger.js';
import { createStore } from '../../store.js';
import { stripRouteIds } from '../../comma.js';
import { VikunjaNotFoundError } from './client.js';
import {
  extractDiscordAssignee,
  getVikunjaIntegration,
  recreateDeletedTask,
  removeLink,
  syncReport,
  taskTitleForThread,
  threadIdForTask,
} from './sync.js';

const log = createLogger('vikunja-webhook');
const MAX_BODY_BYTES = 1024 * 1024;
const RETRY_MS = 60_000;

interface WebhookUser {
  id?: number;
  username?: string;
  name?: string;
}

interface WebhookTask {
  id?: number;
  title?: string;
  description?: string;
  done?: boolean;
  due_date?: string | null;
  labels?: unknown[];
}

export interface VikunjaWebhook {
  event_name: string;
  data: {
    task?: WebhookTask;
    doer?: WebhookUser;
    comment?: { id?: number; comment?: string; author?: WebhookUser };
    assignee?: { user_id?: number; id?: number };
  };
}

interface PendingWebhook {
  payload: VikunjaWebhook;
  attempts?: number;
}

/** Attempts before a persistently failing event is dropped from the inbox. */
export const MAX_WEBHOOK_ATTEMPTS = 30;

const inbox = createStore<Record<string, PendingWebhook>>('vikunja-webhooks');
const PENDING_KEY = 'pending';
let inboxChain: Promise<unknown> = Promise.resolve();
let drainPromise: Promise<void> | null = null;
let drainRequested = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let server: Server | null = null;

export function verifyVikunjaSignature(body: Buffer, signature: string, secret: string): boolean {
  // Vikunja v2.5 signs raw bytes with HMAC-SHA256 and sends lowercase hex, without a prefix.
  if (!/^[a-fA-F0-9]{64}$/.test(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  const received = Buffer.from(signature, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export class WebhookRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'WebhookRequestError';
  }
}

function webhookPayload(value: unknown): value is VikunjaWebhook {
  return value != null && typeof value === 'object'
    && typeof (value as { event_name?: unknown }).event_name === 'string'
    && (value as { data?: unknown }).data != null
    && typeof (value as { data?: unknown }).data === 'object';
}

export function parseVerifiedWebhook(body: Buffer, signature: string, secret: string): VikunjaWebhook {
  if (!signature || !verifyVikunjaSignature(body, signature, secret)) {
    throw new WebhookRequestError(401, 'Invalid Vikunja webhook signature');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new WebhookRequestError(400, 'Invalid Vikunja webhook JSON');
  }
  if (!webhookPayload(payload)) throw new WebhookRequestError(400, 'Invalid Vikunja webhook payload');
  return payload;
}

async function mutateInbox<T>(fn: (pending: Record<string, PendingWebhook>) => Promise<T> | T): Promise<T> {
  const run = inboxChain.then(async () => {
    const pending = (await inbox.get(PENDING_KEY)) ?? {};
    const result = await fn(pending);
    await inbox.set(PENDING_KEY, pending);
    return result;
  });
  inboxChain = run.then(() => undefined, () => undefined);
  return run;
}

function enqueue(signature: string, payload: VikunjaWebhook): Promise<void> {
  return mutateInbox(pending => { pending[signature] = { payload }; });
}

function removePending(signature: string): Promise<void> {
  return mutateInbox(pending => { delete pending[signature]; });
}

/** Persists one more failed attempt and returns the new count (0 if the entry vanished). */
function recordAttempt(signature: string): Promise<number> {
  return mutateInbox(pending => {
    const entry = pending[signature];
    if (!entry) return 0;
    entry.attempts = (entry.attempts ?? 0) + 1;
    return entry.attempts;
  });
}

function taskIdOf(payload: VikunjaWebhook): number | null {
  const id = payload.data.task?.id;
  return Number.isSafeInteger(id) && id! > 0 ? id! : null;
}

function displayName(user: WebhookUser | undefined): string {
  return user?.name || user?.username || 'Vikunja user';
}

export function editableTaskTitle(title: string, ticketId: string): string | null {
  const prefix = `#${ticketId} — `;
  if (!title.startsWith(prefix)) return null;
  const humanTitle = title.slice(prefix.length).trim();
  return humanTitle || null;
}

export function splitDiscordMessage(content: string, limit = 2_000): string[] {
  const chunks: string[] = [];
  let rest = content.trim();
  while (rest.length > limit) {
    const newline = rest.lastIndexOf('\n', limit);
    const space = rest.lastIndexOf(' ', limit);
    const cut = Math.max(newline, space);
    let end = cut > limit / 2 ? cut : limit;
    // Never cut between a surrogate pair.
    const last = rest.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

async function linkedThread(client: Client, taskId: number): Promise<ThreadChannel | null> {
  const threadId = await threadIdForTask(taskId);
  if (!threadId) {
    log.debug({ taskId }, 'Vikunja webhook ignored for an unlinked task');
    return null;
  }
  const channel = await client.channels.fetch(threadId);
  if (!channel?.isThread()) {
    log.warn({ taskId, threadId }, 'Vikunja webhook mapped to a missing Discord thread');
    return null;
  }
  return channel;
}

async function syncCanonical(thread: ThreadChannel): Promise<void> {
  if (!(await syncReport(thread))) throw new Error(`Could not synchronize report ${thread.id}`);
}

async function mappedMember(thread: ThreadChannel, vikunjaUserId: number | undefined): Promise<GuildMember | null> {
  const integration = getVikunjaIntegration();
  const discordUserId = vikunjaUserId == null ? undefined : integration?.config.userMap[String(vikunjaUserId)];
  if (!discordUserId) return null;
  return thread.guild.members.fetch(discordUserId).catch(() => null);
}

async function processComment(client: Client, payload: VikunjaWebhook, taskId: number): Promise<void> {
  const integration = getVikunjaIntegration();
  const thread = await linkedThread(client, taskId);
  if (!integration || !thread) return;
  const commentId = payload.data.comment?.id;
  if (!Number.isSafeInteger(commentId) || commentId! <= 0) {
    throw new Error(`Vikunja comment event for task ${taskId} has no comment id`);
  }
  // Webhook comments are stored HTML. Fetching this one resource in markdown avoids
  // introducing an HTML-to-Discord converter and keeps the bridge dependency-free.
  const comment = await integration.api.getComment(taskId, commentId!).catch((err: unknown) => {
    // A comment deleted before delivery can never succeed; dropping beats retrying forever.
    if (err instanceof VikunjaNotFoundError) return null;
    throw err;
  });
  if (!comment) {
    log.info({ taskId, commentId }, 'Vikunja comment vanished before delivery; dropping event');
    return;
  }
  const safeText = stripRouteIds(comment.comment);
  const body = safeText || 'Web comment contained route details; use the existing Discord route-sharing workflow for route IDs.';
  const author = comment.author ?? payload.data.comment?.author ?? payload.data.doer;
  const content = `**Web · ${displayName(author)}**\n\n${body}`;
  for (const chunk of splitDiscordMessage(content)) {
    await thread.send({ content: chunk, allowedMentions: { parse: [] } });
  }
  // The Discord delivery has already happened; do not retry the inbound event and
  // duplicate a human comment if recording activity is temporarily unavailable.
  await recordHumanReportActivity(thread).catch(err =>
    log.warn({ err, threadId: thread.id }, 'Could not record web-originated human activity'));
}

async function processTaskUpdated(client: Client, payload: VikunjaWebhook, taskId: number): Promise<void> {
  const thread = await linkedThread(client, taskId);
  if (!thread) return;
  const report = await StoredReport.get(thread.id);
  const title = payload.data.task?.title;
  if (report && title) {
    const canonical = taskTitleForThread(thread.name, report.data.ticketId, report.data.label);
    const humanTitle = title === canonical ? null : editableTaskTitle(title, report.data.ticketId);
    const member = await mappedMember(thread, payload.data.doer?.id);
    if (humanTitle && member && canRenameThread(member)
      && !(await getScheduledClose(thread.id)) && !(await getScheduledSnooze(thread.id))) {
      try {
        await renameReportThread(thread, thread.guild, report.data.ticketId, humanTitle);
      } catch (err) {
        // A Discord rate limit rejects the web edit; the canonical sync below restores it.
        log.warn({ err, threadId: thread.id }, 'Vikunja title edit could not rename the Discord report');
      }
    }
  }
  await syncCanonical(thread);
}

async function processAssignee(client: Client, payload: VikunjaWebhook, taskId: number, created: boolean): Promise<void> {
  const thread = await linkedThread(client, taskId);
  if (!thread) return;
  const actor = await mappedMember(thread, payload.data.doer?.id);
  if (!actor || !hasStaffRole(actor)) {
    await syncCanonical(thread);
    return;
  }

  const assigneeId = payload.data.assignee?.user_id ?? payload.data.assignee?.id;
  if (!Number.isSafeInteger(assigneeId) || assigneeId! <= 0) {
    await syncCanonical(thread);
    return;
  }
  const integration = getVikunjaIntegration();
  const discordAssigneeId = integration?.config.userMap[String(assigneeId)];
  if (!integration || !discordAssigneeId) {
    await syncCanonical(thread);
    return;
  }

  if (created) {
    const assignee = await thread.guild.members.fetch(discordAssigneeId).catch(() => null);
    if (assignee && hasStaffRole(assignee)) {
      await setReportAssignee(thread, thread.guild, { userId: assignee.id, username: assignee.user.username });
    }
  } else {
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (extractDiscordAssignee(starter?.embeds[0]?.fields) === discordAssigneeId) {
      await setReportAssignee(thread, thread.guild, null);
    }
  }
  await syncCanonical(thread);
}

async function processTaskDeleted(client: Client, taskId: number): Promise<void> {
  const thread = await linkedThread(client, taskId);
  if (!thread) return;
  const report = await StoredReport.get(thread.id);
  if (report && report.isActive === false) {
    await removeLink(thread.id, taskId);
    return;
  }
  if (!(await recreateDeletedTask(thread, taskId))) {
    throw new Error(`Could not recreate deleted Vikunja task ${taskId}`);
  }
}

export async function processVikunjaWebhook(client: Client, payload: VikunjaWebhook): Promise<void> {
  const integration = getVikunjaIntegration();
  if (!integration) return;
  if (payload.data.doer?.id === integration.botUserId) return;
  const taskId = taskIdOf(payload);
  if (taskId == null) {
    log.debug({ eventName: payload.event_name }, 'Vikunja webhook ignored without a task id');
    return;
  }

  switch (payload.event_name) {
    case 'task.comment.created':
      await processComment(client, payload, taskId);
      return;
    case 'task.updated':
      await processTaskUpdated(client, payload, taskId);
      return;
    case 'task.assignee.created':
      await processAssignee(client, payload, taskId, true);
      return;
    case 'task.assignee.deleted':
      await processAssignee(client, payload, taskId, false);
      return;
    case 'task.deleted':
      await processTaskDeleted(client, taskId);
      return;
    default:
      log.debug({ eventName: payload.event_name }, 'Vikunja webhook event ignored');
  }
}

function scheduleRetry(client: Client): void {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void drainVikunjaWebhooks(client).catch(err => log.warn({ err }, 'Vikunja webhook retry crashed'));
  }, RETRY_MS);
  retryTimer.unref();
}

export async function drainVikunjaWebhooks(client: Client): Promise<void> {
  if (drainPromise) {
    // An event can land after the active drain's snapshot. One more pass picks it up.
    drainRequested = true;
    return drainPromise;
  }
  drainPromise = (async () => {
    let failed = false;
    do {
      drainRequested = false;
      const pending = (await inbox.get(PENDING_KEY)) ?? {};
      for (const [signature, entry] of Object.entries(pending)) {
        const attempts = await recordAttempt(signature);
        if (attempts === 0) continue;
        if (attempts > MAX_WEBHOOK_ATTEMPTS) {
          log.error({ signature, eventName: entry.payload.event_name, taskId: taskIdOf(entry.payload), attempts },
            'Vikunja webhook event dropped after repeated failures');
          await removePending(signature);
          continue;
        }
        try {
          await processVikunjaWebhook(client, entry.payload);
          await removePending(signature);
        } catch (err) {
          failed = true;
          if (attempts === 1) log.warn({ err, signature }, 'Vikunja webhook processing failed; will retry');
          else log.debug({ err, signature, attempts }, 'Vikunja webhook processing will retry');
        }
      }
    } while (drainRequested);
    if (failed) scheduleRetry(client);
  })().catch(err => {
    log.warn({ err }, 'Vikunja webhook inbox drain failed; will retry');
    scheduleRetry(client);
  }).finally(() => {
    const rerun = drainRequested;
    drainPromise = null;
    if (rerun) void drainVikunjaWebhooks(client)
      .catch(err => log.warn({ err }, 'Vikunja webhook follow-up drain crashed'));
  });
  return drainPromise;
}

class BodyTooLargeError extends Error {}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => tooLarge ? reject(new BodyTooLargeError()) : resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, client: Client): Promise<void> {
  if (request.method !== 'POST') {
    response.statusCode = 405;
    response.end();
    return;
  }
  if (request.url?.split('?')[0] !== '/vikunja/webhook') {
    response.statusCode = 404;
    response.end();
    return;
  }
  const integration = getVikunjaIntegration();
  if (!integration) {
    response.statusCode = 503;
    response.end();
    return;
  }
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    response.statusCode = 413;
    response.end();
    request.resume();
    return;
  }
  const header = request.headers['x-vikunja-signature'];
  const signature = typeof header === 'string' ? header : '';
  if (!signature) {
    response.statusCode = 401;
    response.end();
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(request);
  } catch (err) {
    response.statusCode = err instanceof BodyTooLargeError ? 413 : 400;
    response.end();
    return;
  }
  let payload: VikunjaWebhook;
  try {
    payload = parseVerifiedWebhook(body, signature, integration.config.webhookSecret);
  } catch (err) {
    response.statusCode = err instanceof WebhookRequestError ? err.status : 400;
    response.end();
    return;
  }
  try {
    await enqueue(signature, payload);
  } catch (err) {
    log.warn({ err }, 'Could not persist Vikunja webhook');
    response.statusCode = 503;
    response.end();
    return;
  }
  response.statusCode = 204;
  response.end();
  void drainVikunjaWebhooks(client).catch(err => log.warn({ err }, 'Vikunja webhook drain crashed'));
}

export function startVikunjaWebhookServer(client: Client): void {
  const integration = getVikunjaIntegration();
  if (server || !integration) return;
  const port = integration.config.webhookPort;
  const created = createServer((request, response) => {
    void handleRequest(request, response, client).catch(err => {
      log.warn({ err }, 'Vikunja webhook request failed');
      if (!response.headersSent) {
        response.statusCode = 500;
        response.end();
      }
    });
  });
  created.on('error', err => {
    log.warn({ err, port }, 'Vikunja webhook server failed');
    if (server === created) server = null;
  });
  created.on('close', () => {
    if (server === created) server = null;
  });
  created.listen(port, '0.0.0.0');
  server = created;
  log.info({ port }, 'Vikunja webhook server listening');
}
