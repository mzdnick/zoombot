import { loadConfig } from '../../config.js';
import { StoredReport } from './report-store.js';

export interface ActiveCapVerdict {
  allowed: boolean;
  active: StoredReport[];
}

export function activeCapMessage(limit: number, active: StoredReport[]): string {
  const lines = active.map(r => `- [${r.data.threadName}](${r.url})`).join('\n');
  return `You can only have **${limit}** active report thread(s) at a time. Please wait until one of yours is resolved, or add to an existing thread instead:\n${lines}`;
}

export async function checkActiveCap(userId: string): Promise<ActiveCapVerdict> {
  const limit = loadConfig().maxActiveReports;
  if (limit <= 0) return { allowed: true, active: [] };
  const active = await StoredReport.activeForUser(userId);
  return { allowed: active.length < limit, active };
}
