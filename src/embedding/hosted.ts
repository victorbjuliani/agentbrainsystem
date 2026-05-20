/**
 * Hosted embedding providers — opt-in, gated on an API key env var.
 *
 * These are thin `fetch`-based clients (no SDK dependency) for Gemini
 * (`text-embedding-004`) and Voyage (`voyage-3`). The local provider is what ships by
 * default; these exist so the layer is genuinely pluggable. Construction throws a
 * clear error when the required API key env var is missing, so a misconfigured swap
 * fails loudly instead of at first request.
 *
 * Every batch is L2-normalized client-side (hosted APIs do not all guarantee it) and
 * run through the dimension guard before returning.
 */
import { assertDimensions } from './guard.js';
import type { EmbeddingProvider } from './provider.js';

/** L2-normalize a vector in place-safe fashion (returns a new array). */
function l2normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const x of vec) sumSq += x * x;
  const norm = Math.sqrt(sumSq);
  if (norm === 0) return vec.slice();
  return vec.map((x) => x / norm);
}

function requireEnv(envVar: string, providerName: string): string {
  const value = process.env[envVar];
  if (value === undefined || value.trim() === '') {
    throw new Error(`provider ${providerName} requires API key ${envVar}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Gemini — text-embedding-004 (default 768-dim)
// ---------------------------------------------------------------------------

const GEMINI_DEFAULT_MODEL = 'text-embedding-004';
const GEMINI_DEFAULT_DIMENSIONS = 768;
const GEMINI_API_KEY_ENV = 'GEMINI_API_KEY';

interface GeminiBatchResponse {
  embeddings?: { values: number[] }[];
}

export interface GeminiProviderOptions {
  model?: string;
  dimensions?: number;
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'gemini';
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;

  constructor(options: GeminiProviderOptions = {}) {
    this.apiKey = requireEnv(GEMINI_API_KEY_ENV, 'gemini');
    this.model = options.model ?? GEMINI_DEFAULT_MODEL;
    this.dimensions = options.dimensions ?? GEMINI_DEFAULT_DIMENSIONS;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}` +
      `:batchEmbedContents?key=${encodeURIComponent(this.apiKey)}`;
    const body = {
      requests: texts.map((text) => ({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
      })),
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`gemini embeddings request failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as GeminiBatchResponse;
    const vectors = (json.embeddings ?? []).map((e) => l2normalize(e.values));
    return assertDimensions(vectors, this.dimensions);
  }
}

// ---------------------------------------------------------------------------
// Voyage — voyage-3 (default 1024-dim)
// ---------------------------------------------------------------------------

const VOYAGE_DEFAULT_MODEL = 'voyage-3';
const VOYAGE_DEFAULT_DIMENSIONS = 1024;
const VOYAGE_API_KEY_ENV = 'VOYAGE_API_KEY';

interface VoyageResponse {
  data?: { embedding: number[] }[];
}

export interface VoyageProviderOptions {
  model?: string;
  dimensions?: number;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'voyage';
  readonly model: string;
  readonly dimensions: number;
  private readonly apiKey: string;

  constructor(options: VoyageProviderOptions = {}) {
    this.apiKey = requireEnv(VOYAGE_API_KEY_ENV, 'voyage');
    this.model = options.model ?? VOYAGE_DEFAULT_MODEL;
    this.dimensions = options.dimensions ?? VOYAGE_DEFAULT_DIMENSIONS;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`voyage embeddings request failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as VoyageResponse;
    const vectors = (json.data ?? []).map((d) => l2normalize(d.embedding));
    return assertDimensions(vectors, this.dimensions);
  }
}
