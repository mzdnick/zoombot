export interface WikiPage {
  title: string;
  content: string;
  path: string;
  url: string;
  /** Git blob sha of the source file; the embedding-cache invalidation key. */
  sha: string;
}

export interface WikiChunk {
  /** Stable identifier for the chunk. */
  path: string;
  parentPath: string;
  title: string;
  content: string;
  url: string;
}

export interface WikiResult {
  title: string;
  url: string;
  score: number;
}
