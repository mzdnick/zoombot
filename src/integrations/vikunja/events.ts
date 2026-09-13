import { Events } from 'discord.js';
import type { Client } from 'discord.js';
import { ArgsOf, Discord, Once, On } from 'discordx';
import { loadConfig } from '../../config.js';
import { StoredReport } from '../../handlers/report/report-store.js';
import { FIX_INCOMING_TITLE } from '../../handlers/report/report-actions.js';
import { createLogger } from '../../logger.js';
import {
  initializeVikunja,
  getVikunjaIntegration,
  queueVikunjaComment,
  queueVikunjaEmbedComment,
  queueVikunjaSync,
  syncAllReports,
} from './sync.js';
import { drainVikunjaWebhooks, startVikunjaWebhookServer } from './webhook.js';

const log = createLogger('vikunja-events');
const DOMAIN_MESSAGE_TITLES = new Set([
  '🧪 Waiting for User',
  FIX_INCOMING_TITLE,
  '💬 Feedback',
  '✅ Resolved by User',
  '😴 Snoozed',
]);

@Discord()
export class VikunjaEvents {
  @Once({ event: Events.ClientReady })
  async ready([client]: ArgsOf<Events.ClientReady>) {
    const vikunjaConfig = loadConfig().vikunja;
    if (!vikunjaConfig) return;

    const discordClient = client as Client;
    const activate = () => {
      startVikunjaWebhookServer(discordClient);
      void drainVikunjaWebhooks(discordClient)
        .catch(err => log.warn({ err }, 'Vikunja webhook inbox recovery failed'));
      void syncAllReports(discordClient)
        .catch(err => log.warn({ err }, 'Vikunja startup reconciliation failed'));
    };

    if (await initializeVikunja(vikunjaConfig)) {
      activate();
      return;
    }
    // A Vikunja outage at boot must not disable the projection for the whole
    // process; poll until the connection succeeds.
    const retry = setInterval(() => {
      void initializeVikunja(vikunjaConfig).then(ok => {
        if (!ok) return;
        clearInterval(retry);
        log.info('Vikunja recovered; activating synchronization');
        activate();
      }).catch(err => log.warn({ err }, 'Vikunja initialization retry failed'));
    }, 60_000);
    retry.unref();
  }

  @On({ event: Events.ThreadUpdate })
  async threadUpdate([, thread]: ArgsOf<Events.ThreadUpdate>) {
    if (!getVikunjaIntegration()) return;
    if (!thread.isThread() || thread.parentId !== loadConfig().forumChannelId) return;
    const report = await StoredReport.get(thread.id).catch(err => {
      log.warn({ err, threadId: thread.id }, 'Could not check report before Vikunja sync');
      return null;
    });
    if (report) queueVikunjaSync(thread);
  }

  @On({ event: Events.MessageCreate })
  async messageCreate([message]: ArgsOf<Events.MessageCreate>) {
    if (!getVikunjaIntegration()) return;
    const thread = message.channel;
    if (!thread.isThread() || thread.parentId !== loadConfig().forumChannelId) return;
    const report = await StoredReport.get(thread.id).catch(err => {
      log.warn({ err, threadId: thread.id }, 'Could not check report before Vikunja comment sync');
      return null;
    });
    if (!report) return;

    if (!message.author.bot) {
      queueVikunjaComment(thread, {
        displayName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
        content: message.content,
        url: message.url,
        attachments: [...message.attachments.values()].map(attachment => ({ name: attachment.name, url: attachment.url })),
      });
      return;
    }

    // Never mirror generic bot traffic or the web->Discord bridge. These exact titles
    // are Starbot domain messages that represent human modal input/workflow feedback.
    if (message.author.id !== message.client.user?.id) return;
    if (!DOMAIN_MESSAGE_TITLES.has(message.embeds[0]?.title ?? '')) return;
    queueVikunjaEmbedComment(thread, message);
  }
}
