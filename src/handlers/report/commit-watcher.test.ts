import { beforeEach, describe, expect, it, vi } from 'vitest';

const backing: Record<string, unknown> = {};

vi.mock('../../config.js', () => ({
  loadConfig: vi.fn(() => ({
    mainRepo: 'owner/main',
    uatWaitRepo: undefined,
    uatWaitBranch: 'Dom',
    uatPollMinutes: 5,
  })),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));
vi.mock('../../store.js', () => ({
  createStore: () => ({
    get: async (key: string) => backing[key],
    set: async (key: string, value: unknown) => { backing[key] = value; },
    delete: async (key: string) => { delete backing[key]; return true; },
  }),
}));
vi.mock('../../github.js', () => ({
  fetchBranchTip: vi.fn(),
}));

import { loadConfig } from '../../config.js';
import { fetchBranchTip } from '../../github.js';
import { pollOnce, onCommit, waitBranchConfigured, type CommitTip } from './commit-watcher.js';

const mockConfig = vi.mocked(loadConfig);
const mockTip = vi.mocked(fetchBranchTip);

function tip(sha: string): CommitTip & { subject: string } {
  return { sha, short: sha.slice(0, 7), branch: 'Dom', subject: 'fix: thing', date: '2026-08-26T00:00:00Z', repo: 'owner/main' };
}

async function collect(): Promise<CommitTip[]> {
  const seen: CommitTip[] = [];
  onCommit(c => seen.push(c));
  return seen;
}

beforeEach(() => {
  for (const key of Object.keys(backing)) delete backing[key];
  vi.clearAllMocks();
  mockConfig.mockReturnValue({
    mainRepo: 'owner/main',
    uatWaitRepo: undefined,
    uatWaitBranch: 'Dom',
    uatPollMinutes: 5,
  } as ReturnType<typeof loadConfig>);
});

describe('pollOnce', () => {
  it('emits and persists a new tip sha', async () => {
    mockTip.mockResolvedValue(tip('a'.repeat(40)));
    const seen = await collect();
    await pollOnce();
    expect(seen).toHaveLength(1);
    expect(seen[0].short).toBe('aaaaaaa');
    expect(backing['last']).toEqual({ sha: 'a'.repeat(40) });
  });

  it('does not re-emit an unchanged sha', async () => {
    mockTip.mockResolvedValue(tip('a'.repeat(40)));
    const seen = await collect();
    await pollOnce();
    await pollOnce();
    expect(seen).toHaveLength(1);
  });

  it('does not re-emit the stored sha after a restart', async () => {
    backing['last'] = { sha: 'b'.repeat(40) };
    mockTip.mockResolvedValue(tip('b'.repeat(40)));
    const seen = await collect();
    await pollOnce();
    expect(seen).toHaveLength(0);
  });

  it('falls back to mainRepo when no wait repo is set', async () => {
    mockTip.mockResolvedValue(tip('c'.repeat(40)));
    const seen = await collect();
    await pollOnce();
    expect(mockTip).toHaveBeenCalledWith('owner/main', 'Dom');
    expect(seen[0].repo).toBe('owner/main');
  });

  it('uses the configured wait repo when set', async () => {
    mockConfig.mockReturnValue({
      mainRepo: 'owner/main',
      uatWaitRepo: 'owner/wait',
      uatWaitBranch: 'Dom',
      uatPollMinutes: 5,
    } as ReturnType<typeof loadConfig>);
    mockTip.mockResolvedValue({ ...tip('d'.repeat(40)), repo: 'owner/wait' });
    await pollOnce();
    expect(mockTip).toHaveBeenCalledWith('owner/wait', 'Dom');
  });

  it('emits nothing when the fetch fails', async () => {
    mockTip.mockResolvedValue(null);
    const seen = await collect();
    await pollOnce();
    expect(seen).toHaveLength(0);
    expect(backing['last']).toBeUndefined();
  });
});

describe('waitBranchConfigured', () => {
  it('is false without REPORTS_UAT_WAIT_BRANCH', () => {
    mockConfig.mockReturnValue({
      mainRepo: 'owner/main',
      uatWaitBranch: undefined,
    } as ReturnType<typeof loadConfig>);
    expect(waitBranchConfigured()).toBe(false);
  });

  it('is true with REPORTS_UAT_WAIT_BRANCH', () => {
    expect(waitBranchConfigured()).toBe(true);
  });
});
