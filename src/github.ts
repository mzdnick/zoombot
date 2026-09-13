import { LRUCache } from 'lru-cache';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('github');

const DEFAULT_COMMIT_BRANCHES = ['main', 'develop'] as const;

// The commit picker offers the wait branch so "newer than a specific commit"
// stays consistent with what the commit watcher activates on.
function commitBranches(): string[] {
  const wait = loadConfig().uatWaitBranch;
  return [...new Set(wait ? ['main', wait] : DEFAULT_COMMIT_BRANCHES)];
}

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
    author: { date: string } | null;
  };
}

// Committer date first; author date covers committer-less commits so an empty
// date never silently fails a "newer than" comparison.
function commitDateOf(c: GitHubCommit): string {
  return c.commit.committer?.date ?? c.commit.author?.date ?? '';
}

// Without GITHUB_TOKEN the unauthenticated API allows 60 req/hr per IP; the
// token lifts that to 5,000/hr. Branch commit lists are LRU-cached for 5
// minutes (≤ 24 req/hr across the two branches) to stay safe either way.
const GITHUB_HEADERS = { Accept: 'application/vnd.github+json' } as const;

export async function githubFetch(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const token = loadConfig().githubToken;
  const base = token ? { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` } : GITHUB_HEADERS;
  return fetch(url, { headers: { ...base, ...headers } });
}

const COMMITS_CACHE_TTL_MS = 5 * 60_000;
const branchCommitsCache = new LRUCache<string, CommitChoice[]>({ max: 10, ttl: COMMITS_CACHE_TTL_MS });

function toChoice(c: GitHubCommit, branch: string): CommitChoice {
  return {
    sha: c.sha,
    short: c.sha.slice(0, 7),
    branch,
    subject: c.commit.message.split('\n')[0],
    date: commitDateOf(c),
  };
}

async function fetchBranchCommits(branch: string): Promise<CommitChoice[]> {
  const cached = branchCommitsCache.get(branch);
  if (cached) return cached;
  const { mainRepo } = loadConfig();
  try {
    const res = await githubFetch(
      `https://api.github.com/repos/${mainRepo}/commits?sha=${encodeURIComponent(branch)}&per_page=10`,
    );
    if (!res.ok) {
      log.warn({ branch, status: res.status }, 'GitHub commits request failed');
      return [];
    }
    const data = await res.json() as GitHubCommit[];
    if (!Array.isArray(data)) return [];
    const choices = data.map(c => toChoice(c, branch));
    branchCommitsCache.set(branch, choices);
    return choices;
  } catch (err) {
    log.warn({ err, branch }, 'GitHub commits request errored');
    return [];
  }
}

export async function fetchCommitChoices(): Promise<CommitChoice[]> {
  const branches = commitBranches();
  const perBranch = await Promise.all(branches.map(fetchBranchCommits));
  const sorted = perBranch.flat().sort((a, b) => b.date.localeCompare(a.date));
  // Dedupe by sha: Discord rejects a select menu with duplicate option values.
  const bySha = new Map<string, CommitChoice>();
  for (const c of sorted) if (!bySha.has(c.sha)) bySha.set(c.sha, c);
  return [...bySha.values()].slice(0, 25); // Discord select menus cap at 25 options
}

// Uncached single-commit read for the commit watcher.
export async function fetchBranchTip(repo: string, branch: string): Promise<CommitChoice | null> {
  try {
    const res = await githubFetch(
      `https://api.github.com/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`,
    );
    if (!res.ok) {
      log.warn({ repo, branch, status: res.status }, 'GitHub branch tip request failed');
      return null;
    }
    const data = await res.json() as GitHubCommit[];
    if (!Array.isArray(data) || data.length === 0) return null;
    return toChoice(data[0], branch);
  } catch (err) {
    log.warn({ err, repo, branch }, 'GitHub branch tip request errored');
    return null;
  }
}
