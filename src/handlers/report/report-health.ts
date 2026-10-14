import type { Client } from 'discord.js';
import { Events, RESTJSONErrorCodes } from 'discord.js';
import { Discord, On, ArgsOf } from 'discordx';
import { createLogger } from '../../logger.js';
import { StoredReport } from './report-store.js';

const log = createLogger('report-health');

const HEALTH_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

let healthTimer: ReturnType<typeof setInterval> | null = null;
let checking = false;

export function initReportHealth(client: Client): void {
  if (healthTimer) return;
  healthTimer = setInterval(() => { void runHealthCheck(client); }, HEALTH_CHECK_INTERVAL_MS);
  setTimeout(() => { void runHealthCheck(client); }, 120_000).unref();
}

function isUnknownChannel(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === RESTJSONErrorCodes.UnknownChannel;
}

export async function runHealthCheck(client: Client): Promise<number> {
  if (checking) return 0;
  checking = true;
  let forgotten = 0;
  try {
    const reports = await StoredReport.listAll();
    for (const report of reports) {
      try {
        await client.channels.fetch(report.threadId);
      } catch (err) {
        if (!isUnknownChannel(err)) continue;
        if (await StoredReport.forget(report.threadId)) forgotten++;
      }
    }
    if (forgotten > 0) log.info({ forgotten, total: reports.length }, 'Report health check complete');
  } catch (err) {
    log.error({ err }, 'Report health check failed');
  } finally {
    checking = false;
  }
  return forgotten;
}

@Discord()
export class ReportHealth {
  @On({ event: Events.ThreadDelete })
  async onThreadDelete([thread]: ArgsOf<Events.ThreadDelete>): Promise<void> {
    await StoredReport.forget(thread.id).catch(err =>
      log.error({ err, threadId: thread.id }, 'Failed to forget deleted report thread'));
  }
}
