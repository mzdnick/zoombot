import fs from 'fs';
import path from 'path';
import MiniSearch from 'minisearch';
import { type WikiChunk, type WikiPage } from './types.js';
import { embedBatch } from './embedder.js';
import { chunkTextByTokens } from './chunker.js';
import { createLogger } from '../logger.js';

const log = createLogger('wiki:indexer');

const INDEX_CHUNK_TOKENS = 512;
const INDEX_CHUNK_OVERLAP = 64;

const CACHE_VERSION = 8;

// Float16 / Float32 conversion for embedding storage (halves memory).
function float32ToFloat16(f32: number[]): number[] {
  const buf = new ArrayBuffer(f32.length * 4);
  new Float32Array(buf).set(f32);
  const view = new DataView(buf);
  const result: number[] = new Array(f32.length * 2);
  for (let i = 0; i < f32.length * 2; i++) {
    result[i] = view.getUint16(i * 2, true);
  }
  return result;
}

function float16ToFloat32(f16: number[]): number[] {
  const buf = new ArrayBuffer(f16.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < f16.length; i++) {
    view.setUint16(i * 2, f16[i], true);
  }
  const f32View = new Float32Array(buf);
  return Array.from(f32View);
}

function cachePath(base: string): string {
  return path.join(base, 'wiki-embeddings.json');
}

interface CachedChunk {
  path: string;
  sha: string;
  contentEmbedding: number[];
  isFloat16: boolean;
}

interface CacheData {
  version: number;
  float16: boolean;
  chunks: CachedChunk[];
}

function loadCache(cacheDir: string): CacheData | null {
  const cp = cachePath(cacheDir);
  let raw: string;
  try {
    raw = fs.readFileSync(cp, 'utf-8');
  } catch {
    return null; // No cache yet; first build.
  }
  try {
    const data = JSON.parse(raw) as CacheData;
    if (data.version === CACHE_VERSION) return data;
  } catch (err) {
    // A truncated write used to be swallowed silently; log it so a recurring
    // corruption is visible instead of looking like a routine cold start.
    log.warn({ err }, 'Wiki embedding cache unreadable; rebuilding embeddings');
  }
  return null;
}

function saveCache(cacheDir: string, cachedMap: Map<string, CachedChunk>, float16: boolean): void {
  const cp = cachePath(cacheDir);
  const dir = path.dirname(cp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const data: CacheData = {
    version: CACHE_VERSION,
    float16,
    chunks: [...cachedMap.values()],
  };

  // Write to a temp file and rename, so a crash mid-write cannot leave a
  // truncated JSON file behind at the real path.
  const tmp = `${cp}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
  fs.renameSync(tmp, cp);
}

export interface WikiIndex {
  search: (query: string) => Array<{ id: string; score: number }>;
  getChunk: (id: string) => WikiChunk | undefined;
  getContentEmbedding: (id: string) => number[] | undefined;
  getParentPageFromChunk: (chunkId: string) => WikiPage | undefined;
}

export async function buildIndex(wikiPages: WikiPage[], cacheDir: string): Promise<WikiIndex> {
  // Map parent-page path -> page metadata.
  const parentPageMap = new Map<string, WikiPage>();
  for (const p of wikiPages) parentPageMap.set(p.path, p);

  const miniSearch = new MiniSearch({
    fields: ['title', 'content'],
    storeFields: ['title', 'parentPath'],
    idField: 'path',
  });

  const chunkMap = new Map<string, WikiChunk>();
  const docs: Array<{ path: string; title: string; content: string; parentPath: string }> = [];

  for (const p of wikiPages) {
    const contentChunks = await chunkTextByTokens(p.content, INDEX_CHUNK_TOKENS, INDEX_CHUNK_OVERLAP);

    for (let i = 0; i < contentChunks.length; i++) {
      const chunkId = `${p.path}#${i}`;
      const content = contentChunks[i];

      chunkMap.set(chunkId, {
        path: chunkId,
        parentPath: p.path,
        title: p.title,
        content,
        url: p.url,
      });

      docs.push({ path: chunkId, title: p.title, content, parentPath: p.path });
    }
  }

  miniSearch.addAll(docs);

  // Cache passage embeddings. Freshness is keyed on the parent page's git
  // blob sha, so an edited page re-embeds and an unchanged page never does.
  const cache = loadCache(cacheDir);
  const cachedMap = new Map<string, CachedChunk>();
  if (cache) for (const c of cache.chunks) cachedMap.set(c.path, c);

  const staleChunks: WikiChunk[] = [];
  for (const chunk of chunkMap.values()) {
    const pageSha = parentPageMap.get(chunk.parentPath)?.sha ?? '';
    const cached = cachedMap.get(chunk.path);
    if (!cached || cached.sha !== pageSha) staleChunks.push(chunk);
  }

  if (staleChunks.length > 0) {
    const contentTexts = staleChunks.map(c => `${c.title}\n\n${c.content}`);
    const contentEmbeddings = await embedBatch(contentTexts);

    // Store embeddings as Float16 to halve memory usage.
    for (let i = 0; i < staleChunks.length; i++) {
      const c = staleChunks[i];
      const pageSha = parentPageMap.get(c.parentPath)?.sha ?? '';
      const float16Data = float32ToFloat16(contentEmbeddings[i]);

      cachedMap.set(c.path, {
        path: c.path,
        sha: pageSha,
        contentEmbedding: float16Data,
        isFloat16: true,
      });
    }

    saveCache(cacheDir, cachedMap, true);
  }

  const contentEmbedMap = new Map<string, number[]>();
  for (const [id, cached] of cachedMap) {
    contentEmbedMap.set(id, cached.isFloat16 ? float16ToFloat32(cached.contentEmbedding) : cached.contentEmbedding);
  }

  return {
    search(query: string) {
      return miniSearch.search(query, { prefix: true, fuzzy: 0.2, boost: { title: 2 } });
    },
    getChunk(id: string) {
      return chunkMap.get(id);
    },
    getContentEmbedding(id: string) {
      return contentEmbedMap.get(id);
    },
    getParentPageFromChunk(chunkId: string) {
      const c = chunkMap.get(chunkId);
      if (!c) return undefined;
      return parentPageMap.get(c.parentPath);
    },
  };
}
