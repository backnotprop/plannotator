/**
 * The decisions behind publishing the viewer to R2, kept free of wrangler,
 * the file system and the network so they can be tested with fakes:
 * the upload order, retrying, a small worker pool, and the post-publish check.
 *
 * The order is what keeps a failed run harmless. Exported guides pin the
 * entry JS and CSS; the entry imports chunks and the CSS loads fonts. So
 * every chunk and asset goes up first, then the entry CSS, then the entry JS
 * (the file a guide loads), then the producer manifest under /meta/. A run
 * that fails part way leaves at most unreferenced chunks behind, never a live
 * entry that points at missing files (the v0.28.30 incident: file 226 of ~402
 * got an R2 500, the entry JS was already up, its CSS was not).
 */

export interface UploadEntries {
  js: string;
  css: string;
}

export type UploadPhase = 'assets' | 'entry-css' | 'entry-js';

export interface UploadStep {
  phase: UploadPhase;
  /** Path relative to the viewer build directory (`chunks/go.X.js`). */
  rel: string;
}

/**
 * Everything that is not an entry, sorted so a run is reproducible, then the
 * entry CSS, then the entry JS. Throws when an entry is missing from the
 * build: publishing without it would be the very half-publish this prevents.
 */
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

/** Waits before attempts 2, 3, 4 and 5: 1, 2, 4, 8 seconds. */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000] as const;

export interface RetryOptions {
  /** Delay before each retry; its length is the number of retries. */
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** Told about each failed attempt that will be retried. */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs `fn` until it resolves, retrying after each delay; rethrows the last error. */
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

/** Never more than this many uploads at once. */
export const MAX_CONCURRENCY = 4;

export function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return MAX_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(n)));
}

/**
 * Runs `fn` over `items` with at most `concurrency` in flight. After the
 * first failure no new item starts; the ones already running finish, then the
 * first error is thrown.
 */
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
  /** Uploads one file; rejects on failure. */
  put: (rel: string) => Promise<void>;
  /** Uploads the producer manifest under /meta/; runs only after every step. */
  putManifest: () => Promise<void>;
  concurrency?: number;
  retry?: RetryOptions;
  log?: (line: string) => void;
}

/**
 * Publishes the steps in order: the assets with up to `concurrency` uploads at
 * once, then each entry on its own, then the manifest. Each upload is retried
 * (`withRetry`); a phase starts only after the one before it fully succeeded.
 * Rejects with an error naming the file whose last attempt failed.
 */
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

/** A wrangler call that runs longer than this is killed and retried. */
export const WRANGLER_TIMEOUT_MS = 120_000;

/** Wrangler 4's message for a key that is not in the bucket (local and remote `r2 object get`). */
export const KEY_MISSING = /The specified key does not exist\./;

export interface WranglerGetResult {
  code: number;
  out: string;
  err: string;
  timedOut?: boolean;
  /** The bytes of the `--file` it wrote, or null when there is no file. */
  file: Uint8Array | null;
}

/**
 * What an `r2 object get` said about a key: its bytes, or null when the key
 * does not exist. Only wrangler's own "The specified key does not exist."
 * counts as missing. Anything else (an R2 500, a network error, a timeout,
 * exit 0 without a file) throws, so the caller retries and then stops the
 * deploy: reading it as missing would skip the add-only guard.
 */
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
  /** Path relative to the viewer build directory. */
  rel: string;
  /** Size of the local file in bytes. */
  size: number;
}

export interface HeadResult {
  status: number;
  /** The size the site reports (Content-Length), or null when it gives none. */
  size: number | null;
}

export interface VerifyOptions {
  /** `https://guides.show/v1/`; a trailing slash is added when missing. */
  baseUrl: string;
  files: readonly VerifyFile[];
  head: (url: string) => Promise<HeadResult>;
  /**
   * Counts the body a GET returns, to confirm a size the HEAD did not match
   * or did not give (a proxy may drop or zero Content-Length on a HEAD).
   * Without it the HEAD's answer stands.
   */
  getSize?: (url: string) => Promise<number | null>;
  concurrency?: number;
  retry?: RetryOptions;
}

/**
 * HEADs every file under the base URL and returns the problems, one line each
 * (`rel: HTTP 404`, `rel: 1200 bytes on the site, 1300 here`). A network error
 * or a status other than 200 is retried briefly, in case an edge has not seen
 * the object yet; a size that differs from the local file is reported at once
 * (a different file under the same content-hashed key), after `getSize`
 * confirms it.
 */
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
  // `check` never rejects, so the pool visits every file.
  await runPool(opts.files, opts.concurrency ?? MAX_CONCURRENCY, check);
  return problems.sort();
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(error: unknown): string {
  return errorText(error).split('\n').find((l) => l.trim())?.trim() ?? 'unknown error';
}
