export interface UploadEntries {
  js: string;
  css: string;
}

export type UploadPhase = 'assets' | 'entry-css' | 'entry-js';

export interface UploadStep {
  phase: UploadPhase;
  rel: string;
}

export function uploadPlan(files: readonly string[], entries: UploadEntries): UploadStep[] {
  for (const entry of [entries.js, entries.css]) {
    if (!files.includes(entry)) throw new Error(`viewer build is missing its entry file ${entry}`);
  }
  const assets = files.filter((f) => f !== entries.js && f !== entries.css).sort();
  return [
    ...assets.map((rel) => ({ phase: 'assets' as const, rel })),
    { phase: 'entry-css', rel: entries.css },
    { phase: 'entry-js', rel: entries.js },
  ];
}

export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] as const;

export interface RetryOptions {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const delays = opts.delaysMs ?? RETRY_DELAYS_MS;
  const wait = opts.sleep ?? sleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      const delay = delays[attempt - 1];
      if (delay === undefined) throw error;
      opts.onRetry?.(attempt, error, delay);
      await wait(delay);
    }
  }
}

export const MAX_CONCURRENCY = 4;

export function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return MAX_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(n)));
}

export async function runPool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;
  const worker = async () => {
    while (!failure && next < items.length) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(clampConcurrency(concurrency), items.length) }, worker));
  if (failure) throw (failure as { error: unknown }).error;
}

export interface PublishOptions {
  steps: readonly UploadStep[];
  put: (rel: string) => Promise<void>;
  putManifest: () => Promise<void>;
  concurrency?: number;
  retry?: RetryOptions;
  log?: (line: string) => void;
}

export async function publishViewer(opts: PublishOptions): Promise<number> {
  const log = opts.log ?? (() => {});
  const total = opts.steps.length;
  let uploaded = 0;
  const upload = async (rel: string) => {
    try {
      await withRetry(() => opts.put(rel), {
        ...opts.retry,
        onRetry: (attempt, error, delay) => {
          log(`  retrying ${rel} in ${delay / 1000}s (attempt ${attempt} failed: ${firstLine(error)})`);
          opts.retry?.onRetry?.(attempt, error, delay);
        },
      });
    } catch (error) {
      throw new Error(`upload failed for ${rel} after ${(opts.retry?.delaysMs ?? RETRY_DELAYS_MS).length + 1} attempts: ${errorText(error)}`);
    }
    uploaded++;
    if (uploaded % 25 === 0) log(`  ${uploaded}/${total}`);
  };
  const assets = opts.steps.filter((s) => s.phase === 'assets').map((s) => s.rel);
  await runPool(assets, opts.concurrency ?? MAX_CONCURRENCY, upload);
  for (const phase of ['entry-css', 'entry-js'] as const) {
    for (const step of opts.steps.filter((s) => s.phase === phase)) await upload(step.rel);
  }
  await withRetry(() => opts.putManifest(), opts.retry).catch((error) => {
    throw new Error(`manifest upload failed: ${errorText(error)}`);
  });
  return uploaded;
}

export const WRANGLER_TIMEOUT_MS = 120_000;

export const KEY_MISSING = /The specified key does not exist\./;

export interface WranglerGetResult {
  code: number;
  out: string;
  err: string;
  timedOut?: boolean;
  file: Uint8Array | null;
}

export function existingFromGet(key: string, r: WranglerGetResult): Uint8Array | null {
  if (r.timedOut) throw new Error(`reading ${key} timed out`);
  if (r.code !== 0) {
    if (KEY_MISSING.test(`${r.out}\n${r.err}`)) return null;
    throw new Error(`could not read ${key} (exit ${r.code})\n${(r.err || r.out).trim()}`);
  }
  if (!r.file) throw new Error(`wrangler exited 0 for ${key} but wrote no file`);
  return r.file;
}

export interface VerifyFile {
  rel: string;
  size: number;
}

export interface HeadResult {
  status: number;
  size: number | null;
}

export interface VerifyOptions {
  baseUrl: string;
  files: readonly VerifyFile[];
  head: (url: string) => Promise<HeadResult>;
  getSize?: (url: string) => Promise<number | null>;
  concurrency?: number;
  retry?: RetryOptions;
}

export async function findMissing(opts: VerifyOptions): Promise<string[]> {
  const base = opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`;
  const problems: string[] = [];
  const check = async ({ rel, size }: VerifyFile) => {
    let found: HeadResult;
    try {
      found = await withRetry(async () => {
        const r = await opts.head(`${base}${rel}`);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        return r;
      }, opts.retry);
    } catch (error) {
      problems.push(`${rel}: ${firstLine(error)}`);
      return;
    }
    let siteSize = found.size;
    if (siteSize !== size && opts.getSize) {
      try { siteSize = await opts.getSize(`${base}${rel}`); } catch (error) { problems.push(`${rel}: ${firstLine(error)}`); return; }
    }
    if (siteSize === null) problems.push(`${rel}: the site gave no size (Content-Length)`);
    else if (siteSize !== size) problems.push(`${rel}: ${siteSize} bytes on the site, ${size} here`);
  };
  await runPool(opts.files, opts.concurrency ?? MAX_CONCURRENCY, check);
  return problems.sort();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(error: unknown): string {
  return errorText(error).split('\n').find((l) => l.trim())?.trim() ?? 'unknown error';
}
