import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Fake embedder and tokenizer so the test downloads no model and runs no
// inference. __state counts embedded chunks for cache-hit assertions.
vi.mock('./embedder.js', () => {
  const state = { embedCalls: 0 };
  return {
    embedBatch: async (texts: string[]) => {
      state.embedCalls += texts.length;
      return texts.map((t, i) => [t.length + 0.5, i, -1]);
    },
    getTokenizer: async () => ({
      encode: (t: string) => t.split(/\s+/),
      decode: (ids: number[]) => ids.join(' '),
    }),
    __state: state,
  };
});

import { buildIndex } from './indexer.js';
import * as embedder from './embedder.js';

const state = (embedder as unknown as { __state: { embedCalls: number } }).__state;

const page = (sha: string) => ({
  title: 'Guide',
  path: 'guide.md',
  sha,
  url: 'https://wiki.example.org/guide/',
  // Long enough to split into several chunks at 512 tokens / 64 overlap.
  content: Array.from({ length: 1200 }, (_, i) => `word${i}`).join(' '),
});

let cacheDir: string;

describe('buildIndex cache invalidation', () => {
  beforeEach(() => {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-index-test-'));
    state.embedCalls = 0;
  });

  afterEach(() => {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it('embeds a cold cache once, then skips unchanged pages by blob sha', async () => {
    const pages = [page('sha-1')];

    await buildIndex([...pages], cacheDir);
    const firstBuild = state.embedCalls;
    expect(firstBuild).toBeGreaterThan(0);

    state.embedCalls = 0;
    await buildIndex([...pages], cacheDir);
    expect(state.embedCalls).toBe(0);

    // Regression: the old mtime key never changed, so a wiki edit kept its
    // stale embeddings forever. A sha bump must re-embed every chunk.
    state.embedCalls = 0;
    await buildIndex([page('sha-2')], cacheDir);
    expect(state.embedCalls).toBe(firstBuild);
  });
});
