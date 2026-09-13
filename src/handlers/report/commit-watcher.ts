import { EventEmitter } from 'node:events';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createStore } from '../../store.js';
import { fetchBranchTip } from '../../github.js';

const log = createLogger('commit-watcher');

export interface CommitTip {
  sha: string;
  short: string;
  date: string;
  branch: string;
  repo: string;
}

const stateStore = createStore<{ sha: string }>('commit-watcher');

export const commitEvents = new EventEmitter();

export function onCommit(fn: (commit: CommitTip) => void): void {
  commitEvents.on('commit', fn);
}

export function waitBranchConfigured(): boolean {
  return !!loadConfig().uatWaitBranch;
}

/** Branch tip sha the watcher last observed (undefined before its first poll). */
export async function getLastSeenSha(): Promise<string | undefined> {
  return (await stateStore.get('last'))?.sha;
}

// Single-flight: calls concurrent with an in-flight poll no-op.
let polling = false;

export async function pollOnce(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const { uatWaitRepo, uatWaitBranch, mainRepo } = loadConfig();
    if (!uatWaitBranch) return;
    const repo = uatWaitRepo ?? mainRepo;
    const tip = await fetchBranchTip(repo, uatWaitBranch);
    if (!tip) return;
    const last = await stateStore.get('last');
    if (last?.sha === tip.sha) return;
    await stateStore.set('last', { sha: tip.sha });
    log.info({ sha: tip.short, branch: uatWaitBranch, repo }, 'New commit on watch branch');
    commitEvents.emit('commit', {
      sha: tip.sha,
      short: tip.short,
      date: tip.date,
      branch: uatWaitBranch,
      repo,
    } satisfies CommitTip);
  } catch (err) {
    log.warn({ err }, 'Commit watcher poll failed');
  } finally {
    polling = false;
  }
}

export function initCommitWatcher(): void {
  if (!waitBranchConfigured()) {
    log.info('No REPORTS_UAT_WAIT_BRANCH configured; commit watcher disabled');
    return;
  }
  const minutes = loadConfig().uatPollMinutes;
  void pollOnce();
  const timer = setInterval(() => { void pollOnce(); }, minutes * 60 * 1000);
  timer.unref();
  log.info(`Watching for commits every ${minutes} min`);
}
