import { LRUCache } from 'lru-cache';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('github');

const COMMIT_BRANCHES = ['main', 'develop'] as const;

export interface CommitChoice {
  sha: string;
  short: string;
  branch: string;
  subject: string;
  date: string;
}

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    committer: { date: string } | null;
  };
}

// Unauthenticated GitHub API allows 60 req/hr per IP. Branch commit lists are
// LRU-cached for 5 minutes (≤ 24 req/hr across the two branches) to stay under it.
const GITHUB_HEADERS = { Accept: 'application/vnd.github+json' } as const;

const COMMITS_CACHE_TTL_MS = 5 * 60_000;
const branchCommitsCache = new LRUCache<string, CommitChoice[]>({ max: 10, ttl: COMMITS_CACHE_TTL_MS });

async function fetchBranchCommits(branch: string): Promise<CommitChoice[]> {
  const cached = branchCommitsCache.get(branch);
  if (cached) return cached;
  const { mainRepo } = loadConfig();
  try {
    const res = await fetch(
      `https://api.github.com/repos/${mainRepo}/commits?sha=${encodeURIComponent(branch)}&per_page=10`,
      { headers: GITHUB_HEADERS },
    );
    if (!res.ok) {
      log.warn({ branch, status: res.status }, 'GitHub commits request failed');
      return [];
    }
    const data = await res.json() as GitHubCommit[];
    if (!Array.isArray(data)) return [];
    const choices = data.map(c => ({
      sha: c.sha,
      short: c.sha.slice(0, 7),
      branch,
      subject: c.commit.message.split('\n')[0],
      date: c.commit.committer?.date ?? '',
    }));
    branchCommitsCache.set(branch, choices);
    return choices;
  } catch (err) {
    log.warn({ err, branch }, 'GitHub commits request errored');
    return [];
  }
}

export async function fetchCommitChoices(): Promise<CommitChoice[]> {
  const perBranch = await Promise.all(COMMIT_BRANCHES.map(fetchBranchCommits));
  const sorted = perBranch.flat().sort((a, b) => b.date.localeCompare(a.date));
  // Dedupe by sha: Discord rejects a select menu with duplicate option values.
  const bySha = new Map<string, CommitChoice>();
  for (const c of sorted) if (!bySha.has(c.sha)) bySha.set(c.sha, c);
  return [...bySha.values()].slice(0, 25); // Discord select menus cap at 25 options
}
