import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger.js';
import { githubFetch } from '../github.js';
import { type WikiPage } from './types.js';

const log = createLogger('wiki:fetcher');

const DOCS_SUBDIR = 'docs';
const GITHUB_API = 'https://api.github.com';
const WIKI_HEADERS = { 'User-Agent': 'starbot', Accept: 'application/vnd.github.v3+json' } as const;

function extractTitle(content: string, filename: string): string {
  const match = content.match(/^#\s+(.+)/m);
  if (match) return match[1].trim();
  return filename.replace(/\.md$/, '').replace(/[-_]/g, ' ');
}

function pageUrl(relativePath: string): string {
  const withoutExt = relativePath.replace(/\.md$/, '');
  const cleaned = withoutExt.replace(/\/?index$/, '');
  const suffix = cleaned ? `${cleaned}/` : '';
  return `https://wiki.firestar.link/${suffix}`;
}

async function getTreeSha(repo: string, branch: string): Promise<string> {
  const res = await githubFetch(`${GITHUB_API}/repos/${repo}/git/refs/heads/${branch}`, WIKI_HEADERS);
  if (!res.ok) throw new Error(`GitHub refs API: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { object: { sha: string } };
  return data.object.sha;
}

async function getTree(repo: string, treeSha: string) {
  const res = await githubFetch(`${GITHUB_API}/repos/${repo}/git/trees/${treeSha}?recursive=1`, WIKI_HEADERS);
  if (!res.ok) throw new Error(`GitHub trees API: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as {
    tree: Array<{ path: string; sha: string; type: string; size: number }>;
    truncated: boolean;
  };
  if (data.truncated) throw new Error('GitHub tree response truncated');
  return data.tree;
}

async function getBlob(repo: string, fileSha: string): Promise<string> {
  const res = await githubFetch(`${GITHUB_API}/repos/${repo}/git/blobs/${fileSha}`, WIKI_HEADERS);
  if (!res.ok) throw new Error(`GitHub blobs API: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { content: string; encoding: string };
  if (data.encoding !== 'base64') throw new Error(`Unexpected blob encoding: ${data.encoding}`);
  return Buffer.from(data.content, 'base64').toString('utf-8');
}

export async function fetchWikiPages(
  repo: string,
  cacheDir: string,
  branch: string = 'main',
): Promise<WikiPage[]> {
  fs.mkdirSync(cacheDir, { recursive: true });

  const treeShaPath = path.join(cacheDir, 'wiki-tree-sha.json');
  const pagesPath = path.join(cacheDir, 'wiki-pages.json');

  const currentSha = await getTreeSha(repo, branch);

  let cachedSha: string | undefined;
  try {
    cachedSha = (JSON.parse(fs.readFileSync(treeShaPath, 'utf-8')) as { sha: string }).sha;
  } catch {}

  if (cachedSha === currentSha) {
    try {
      const cached = JSON.parse(fs.readFileSync(pagesPath, 'utf-8')) as WikiPage[];
      if (cached.length > 0) {
        log.info(`Wiki loaded from cache (${cached.length} pages)`);
        return cached;
      }
    } catch {}
  }

  const items = await getTree(repo, currentSha);
  const mdFiles = items.filter(
    (f) => f.type === 'blob' && f.path.startsWith(DOCS_SUBDIR + '/') && f.path.endsWith('.md'),
  );

  const pages: WikiPage[] = [];
  for (const file of mdFiles) {
    const content = await getBlob(repo, file.sha);
    const relPath = file.path.slice(DOCS_SUBDIR.length + 1);
    pages.push({
      title: extractTitle(content, path.basename(relPath)),
      content,
      path: relPath,
      url: pageUrl(relPath),
    });
  }

  fs.writeFileSync(treeShaPath, JSON.stringify({ sha: currentSha }), 'utf-8');
  fs.writeFileSync(pagesPath, JSON.stringify(pages), 'utf-8');
  log.info(`Wiki fetched from GitHub (${pages.length} pages)`);

  return pages;
}
