import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The mock module exposes its call log and mutable tree sha through __state
// so tests can count API hits and simulate wiki updates.
vi.mock('../github.js', () => {
  const state = { calls: [] as string[], sha: 'sha-1' };
  const githubFetch = async (url: string) => {
    state.calls.push(url);
    if (url.includes('/git/refs/')) {
      return { ok: true, json: async () => ({ object: { sha: state.sha } }) };
    }
    if (url.includes('/git/trees')) {
      return {
        ok: true,
        json: async () => ({
          tree: [
            { path: 'docs/index.md', sha: 'blob-index', type: 'blob', size: 10 },
            { path: 'docs/guide/intro.md', sha: 'blob-intro', type: 'blob', size: 10 },
            { path: 'README.md', sha: 'blob-readme', type: 'blob', size: 10 },
          ],
          truncated: false,
        }),
      };
    }
    const content = Buffer.from('# Page\nbody').toString('base64');
    return { ok: true, json: async () => ({ content, encoding: 'base64' }) };
  };
  return { githubFetch, __state: state };
});

import { fetchWikiPages } from './fetcher.js';
import * as github from '../github.js';

const state = (github as unknown as { __state: { calls: string[]; sha: string } }).__state;

let cacheDir: string;

describe('fetchWikiPages', () => {
  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-fetch-test-'));
    state.calls = [];
    state.sha = 'sha-1';
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('builds page URLs from the given base and skips non-docs files', async () => {
    const pages = await fetchWikiPages('owner/repo', cacheDir, 'https://wiki.zoompilot.ai/');
    expect(pages.map(p => p.url).sort()).toEqual([
      'https://wiki.zoompilot.ai/',
      'https://wiki.zoompilot.ai/guide/intro/',
    ]);
  });

  it('serves the second call with the same tree and base from cache', async () => {
    await fetchWikiPages('owner/repo', cacheDir, 'https://wiki.zoompilot.ai/');
    const afterFirst = state.calls.length;
    // The refs lookup always runs to compare tree SHAs; a cache hit adds
    // exactly that one call and skips the tree and blob fetches.
    await fetchWikiPages('owner/repo', cacheDir, 'https://wiki.zoompilot.ai/');
    expect(state.calls.length).toBe(afterFirst + 1);
    expect(state.calls[state.calls.length - 1]).toContain('/git/refs/');
  });

  it('re-fetches when the base URL changes even if the tree is unchanged', async () => {
    await fetchWikiPages('owner/repo', cacheDir, 'https://wiki.zoompilot.ai/');
    const afterFirst = state.calls.length;
    const pages = await fetchWikiPages('owner/repo', cacheDir, 'https://wiki.example.org/');
    expect(state.calls.length).toBeGreaterThan(afterFirst);
    expect(pages.map(p => p.url).sort()).toEqual([
      'https://wiki.example.org/',
      'https://wiki.example.org/guide/intro/',
    ]);
  });
});
