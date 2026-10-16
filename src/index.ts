import { Client } from 'discordx';
import { DiscordAPIError, IntentsBitField } from 'discord.js';
import { loadConfig } from './config.js';
import { root as log } from './logger.js';
import './handlers/events.js';
import './handlers/clip/index.js';
import './handlers/identification/index.js';
import './handlers/report/index.js';
import './handlers/report/report-actions.js';
import './handlers/report/backfill.js';
import './handlers/report/freeze.js';
import './handlers/share-route.js';
import './integrations/vikunja/events.js';

const config = loadConfig();

const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
  ],
  silent: true,
  // Reject (throw) only on rate-limited thread/channel *edits* (PATCH /channels/:id)
  // so title-sync can defer + retry them instead of blocking the strict channel-edit
  // bucket. Message sends, thread creation, etc. queue and wait as normal.
  rest: { rejectOnRateLimit: (data) => data.method === 'PATCH' && data.route === '/channels/:id' },
});

client.login(config.token);

function shutdown() {
  log.info('Shutting down...');
  client.destroy();
  process.exit(0);
}

const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'EHOSTUNREACH']);

// A dropped socket, or a request REST aborted after its timeout (an
// AbortError/TimeoutError DOMException), must not take the bot down. The
// affected request just fails and the next one succeeds.
function isTransientNetworkError(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  if (e?.code && TRANSIENT_NETWORK_CODES.has(e.code)) return true;
  if (/socket hang up|socket disconnected/i.test(e?.message ?? '')) return true;
  return e?.name === 'AbortError' || e?.name === 'TimeoutError';
}

process.on('unhandledRejection', (err) => {
  // A DiscordAPIError is almost always a single bad request (expired interaction,
  // invalid form body, missing perms) - log it and keep running rather than letting
  // one interaction take the whole bot down. Transient network failures are the
  // same class. Anything else is treated as fatal.
  if (err instanceof DiscordAPIError) {
    log.error({ err }, 'Unhandled DiscordAPIError (non-fatal)');
    return;
  }
  if (isTransientNetworkError(err)) {
    log.error({ err }, 'Transient network error (non-fatal)');
    return;
  }
  log.fatal({ err }, 'Unhandled rejection');
  shutdown();
});

process.on('uncaughtException', (err) => {
  if (isTransientNetworkError(err)) {
    log.error({ err }, 'Transient network error (non-fatal)');
    return;
  }
  log.fatal({ err }, 'Uncaught exception');
  shutdown();
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
