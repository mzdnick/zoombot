import { pipeline, env } from '@huggingface/transformers';
import { createLogger } from '../logger.js';

const log = createLogger('wiki:embedder');

// Weights live on the compose volume (../files/data) so container recreation
// does not re-download the model from huggingface.co.
env.cacheDir = 'data/hf-models';

interface EmbeddingResult {
  dims: number[];
  data: Float32Array;
}

interface EmbeddingPipeline {
  (texts: string[], options: { pooling: string; normalize: boolean }): Promise<EmbeddingResult>;
  tokenizer: {
    encode: (text: string, opts?: { addSpecialTokens: boolean }) => number[];
    decode: (ids: number[], opts?: { skipSpecialTokens: boolean }) => string;
    (text: string, opts?: { addSpecialTokens: boolean }): { inputIds: number[]; attentionMask?: number[] };
  };
}

let pipe: EmbeddingPipeline | null = null;

const LOAD_ATTEMPTS = 3;

async function loadPipe(): Promise<EmbeddingPipeline> {
  for (let attempt = 1; ; attempt++) {
    try {
      // q8 weights (~25MB) instead of the fp32 default (~130MB); accuracy loss
      // is negligible for wiki search and the smaller footprint keeps small
      // hosts from being OOM-killed during index builds.
      return await pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', { dtype: 'q8' }) as unknown as EmbeddingPipeline;
    } catch (err) {
      if (attempt >= LOAD_ATTEMPTS) throw err;
      log.warn({ err, attempt }, 'Model load failed; retrying');
      await new Promise(resolve => setTimeout(resolve, attempt * 10_000));
    }
  }
}

async function getPipe(): Promise<EmbeddingPipeline> {
  if (!pipe) {
    pipe = await loadPipe();
  }
  return pipe;
}

// One inference per call would build a single input tensor sized
// chunks x 512 tokens, which OOM-kills the bot on ~1GB hosts during the
// first index build. Small slices keep peak memory flat.
const EMBED_BATCH_SIZE = 8;

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const fn = await getPipe();
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const slice = texts.slice(i, i + EMBED_BATCH_SIZE);
    const result = await fn(slice, { pooling: 'cls', normalize: true });
    const dims = result.dims;
    const dim = dims[dims.length - 1];
    for (let j = 0; j < slice.length; j++) {
      vectors.push(Array.from(result.data.subarray(j * dim, (j + 1) * dim)));
    }
  }
  return vectors;
}

export async function getTokenizer(): Promise<EmbeddingPipeline['tokenizer']> {
  const p = await getPipe();
  return p.tokenizer;
}
