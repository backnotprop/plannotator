import { describe, expect, test } from 'bun:test';
import { clampConcurrency, existingFromGet, findMissing, publishViewer, RETRY_DELAYS_MS, runPool, uploadPlan, withRetry } from './viewer-upload';

const entries = { js: 'viewer.AAA.js', css: 'viewer.BBB.css' };
// readdirSync order on the runner that failed in v0.28.30: the entry JS came before most chunks.
const files = ['viewer.AAA.js', 'chunks/z.1.js', 'worker.W.js', 'viewer.BBB.css', 'chunks/a.2.js', 'fonts/x.woff2'];
const noWait = { sleep: async () => {} };

describe('uploadPlan', () => {
  test('every chunk and asset first, then the entry CSS, then the entry JS', () => {
    const plan = uploadPlan(files, entries);
    expect(plan.map((s) => s.rel)).toEqual(['chunks/a.2.js', 'chunks/z.1.js', 'fonts/x.woff2', 'worker.W.js', 'viewer.BBB.css', 'viewer.AAA.js']);
    expect(plan.map((s) => s.phase)).toEqual(['assets', 'assets', 'assets', 'assets', 'entry-css', 'entry-js']);
  });

  test('refuses a build without its entries', () => {
    expect(() => uploadPlan(['chunks/a.js', 'viewer.BBB.css'], entries)).toThrow(/viewer\.AAA\.js/);
  });
});

describe('withRetry', () => {
  test('retries with 1, 2, 4, 8 s waits and succeeds on the last attempt', async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await withRetry(async () => { if (++calls < 5) throw new Error('R2 500'); return 'ok'; }, { sleep: async (ms) => { waits.push(ms); } });
    expect(out).toBe('ok');
    expect(calls).toBe(5);
    expect(waits).toEqual([...RETRY_DELAYS_MS]);
    expect(waits).toEqual([1000, 2000, 4000, 8000]);
  });

  test('rethrows the last error once the attempts run out', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new Error(`fail ${calls}`); }, noWait)).rejects.toThrow('fail 5');
    expect(calls).toBe(5);
  });

  test('does not wait after a success', async () => {
    const waits: number[] = [];
    await withRetry(async () => 1, { sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([]);
  });
});

describe('runPool', () => {
  test('never runs more than the cap at once, and the cap is 4', async () => {
    let active = 0;
    let peak = 0;
    const seen: number[] = [];
    await runPool(Array.from({ length: 30 }, (_, i) => i), 16, async (i) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      seen.push(i); active--;
    });
    expect(peak).toBe(4);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  test('starts nothing new after a failure and throws it', async () => {
    const started: number[] = [];
    await expect(runPool([0, 1, 2, 3, 4, 5, 6, 7], 2, async (i) => {
      started.push(i);
      if (i === 1) throw new Error('boom');
      await new Promise((r) => setTimeout(r, 1));
    })).rejects.toThrow('boom');
    expect(started).toEqual([0, 1]);
  });

  test('clampConcurrency keeps 1 to 4', () => {
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(2)).toBe(2);
    expect(clampConcurrency(9)).toBe(4);
    expect(clampConcurrency(Number.NaN)).toBe(4);
  });
});

describe('publishViewer', () => {
  const plan = uploadPlan(files, entries);

  test('entries go up only after every asset, then the manifest', async () => {
    const order: string[] = [];
    const assetsInFlightAtEntry: number[] = [];
    let assetsInFlight = 0;
    const uploaded = await publishViewer({
      steps: plan,
      concurrency: 4,
      put: async (rel) => {
        const isEntry = rel === entries.js || rel === entries.css;
        if (isEntry) assetsInFlightAtEntry.push(assetsInFlight);
        else assetsInFlight++;
        await new Promise((r) => setTimeout(r, 1));
        if (!isEntry) assetsInFlight--;
        order.push(rel);
      },
      putManifest: async () => { order.push('meta'); },
      retry: noWait,
    });
    expect(uploaded).toBe(files.length);
    expect(assetsInFlightAtEntry).toEqual([0, 0]);
    expect(order.slice(-3)).toEqual([entries.css, entries.js, 'meta']);
    expect(new Set(order.slice(0, 4))).toEqual(new Set(['chunks/a.2.js', 'chunks/z.1.js', 'fonts/x.woff2', 'worker.W.js']));
  });

  test('a transient R2 500 is retried and the run succeeds', async () => {
    const tries = new Map<string, number>();
    const logs: string[] = [];
    await publishViewer({
      steps: plan,
      put: async (rel) => {
        const n = (tries.get(rel) ?? 0) + 1;
        tries.set(rel, n);
        if (rel === 'chunks/z.1.js' && n < 3) throw new Error('500 Internal Server Error');
      },
      putManifest: async () => {},
      retry: noWait,
      log: (l) => logs.push(l),
    });
    expect(tries.get('chunks/z.1.js')).toBe(3);
    expect(logs.filter((l) => l.includes('retrying chunks/z.1.js'))).toHaveLength(2);
  });

  test('a lasting failure on an asset stops the run before any entry or the manifest', async () => {
    const put: string[] = [];
    let manifest = false;
    await expect(publishViewer({
      steps: plan,
      concurrency: 1,
      put: async (rel) => { put.push(rel); if (rel === 'fonts/x.woff2') throw new Error('500'); },
      putManifest: async () => { manifest = true; },
      retry: noWait,
    })).rejects.toThrow(/upload failed for fonts\/x\.woff2 after 5 attempts/);
    expect(put).not.toContain(entries.css);
    expect(put).not.toContain(entries.js);
    expect(put.filter((r) => r === 'fonts/x.woff2')).toHaveLength(5);
    expect(manifest).toBe(false);
  });

  test('a lasting failure on the CSS never publishes the entry JS', async () => {
    const put: string[] = [];
    await expect(publishViewer({
      steps: plan,
      put: async (rel) => { put.push(rel); if (rel === entries.css) throw new Error('500'); },
      putManifest: async () => {},
      retry: noWait,
    })).rejects.toThrow(/viewer\.BBB\.css/);
    expect(put).not.toContain(entries.js);
  });
  test('a lasting failure on the entry JS never uploads the manifest', async () => {
    const put: string[] = [];
    let manifest = false;
    await expect(publishViewer({
      steps: plan,
      put: async (rel) => { put.push(rel); if (rel === entries.js) throw new Error('500'); },
      putManifest: async () => { manifest = true; },
      retry: noWait,
    })).rejects.toThrow(/upload failed for viewer\.AAA\.js after 5 attempts/);
    expect(put.filter((r) => r === entries.js)).toHaveLength(5);
    expect(manifest).toBe(false);
  });
});

// What wrangler 4.129 prints for `r2 object get <bucket/key> --file <tmp> --remote`
// (the banner and messages are its own strings; see wrangler-dist/cli.js).
const BANNER = '\n ⛅️ wrangler 4.129.0\n───────────────────\nResource location: remote \n\n';
const DOWNLOADING = 'Downloading "v1/viewer.AAA.js" from "guides-show-viewer".\n';
const LOGS = '🪵  Logs were written to "/home/runner/.config/.wrangler/logs/wrangler-2026-10-24_10-00-00_000.log"\n';
const wranglerMissing = { code: 1, out: BANNER + DOWNLOADING, err: `\n✘ [ERROR] The specified key does not exist.\n\n\n${LOGS}`, file: null };
const wrangler500 = {
  code: 1,
  out: BANNER + DOWNLOADING,
  err: '\n✘ [ERROR] A request to the Cloudflare API (/accounts/0123abcd/r2/buckets/guides-show-viewer/objects/v1/viewer.AAA.js) failed.\n\n'
    + '  Failed to fetch /accounts/0123abcd/r2/buckets/guides-show-viewer/objects/v1/viewer.AAA.js - 500: Internal Server Error;\n'
    + '  {"success":false,"errors":[{"code":10001,"message":"We encountered an internal error. Please try again."}],"messages":[],"result":null}\n\n'
    + '  If you think this is a bug, please open an issue at: https://github.com/cloudflare/workers-sdk/issues/new/choose\n\n' + LOGS,
  file: null,
};

describe('existingFromGet', () => {
  test('only "The specified key does not exist." reads as missing', () => {
    expect(existingFromGet('v1/viewer.AAA.js', wranglerMissing)).toBeNull();
  });

  test('an R2 500 is an error, not a missing key', () => {
    expect(() => existingFromGet('v1/viewer.AAA.js', wrangler500)).toThrow(/could not read v1\/viewer\.AAA\.js \(exit 1\)[\s\S]*500: Internal Server Error/);
  });

  test('exit 0 without a file is an error', () => {
    expect(() => existingFromGet('v1/viewer.AAA.js', { code: 0, out: BANNER + DOWNLOADING + 'Download complete.\n', err: '', file: null }))
      .toThrow(/exited 0 for v1\/viewer\.AAA\.js but wrote no file/);
  });

  test('a timed-out call is an error even when its output mentions a missing key', () => {
    expect(() => existingFromGet('v1/viewer.AAA.js', { ...wranglerMissing, code: -1, timedOut: true })).toThrow(/timed out/);
  });

  test('exit 0 with a file answers its bytes', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(existingFromGet('v1/viewer.AAA.js', { code: 0, out: BANNER + DOWNLOADING + 'Download complete.\n', err: '', file: bytes })).toBe(bytes);
  });
});

describe('findMissing', () => {
  const local = [{ rel: 'viewer.AAA.js', size: 100 }, { rel: 'chunks/a.2.js', size: 50 }, { rel: 'viewer.BBB.css', size: 30 }];

  test('HEADs every file under the base and lists the ones that are not 200', async () => {
    const asked: string[] = [];
    const missing = await findMissing({
      baseUrl: 'https://guides.show/v1',
      files: local,
      head: async (url) => { asked.push(url); return url.endsWith('.css') ? { status: 404, size: null } : { status: 200, size: url.endsWith('a.2.js') ? 50 : 100 }; },
      retry: noWait,
    });
    expect([...new Set(asked)].sort()).toEqual(['https://guides.show/v1/chunks/a.2.js', 'https://guides.show/v1/viewer.AAA.js', 'https://guides.show/v1/viewer.BBB.css']);
    expect(missing).toEqual(['viewer.BBB.css: HTTP 404']);
  });

  test('a size that differs from the local file is a problem, reported without retrying', async () => {
    let calls = 0;
    const problems = await findMissing({
      baseUrl: 'https://guides.show/v1/',
      files: [{ rel: 'chunks/a.2.js', size: 50 }],
      head: async () => { calls++; return { status: 200, size: 48 }; },
      retry: noWait,
    });
    expect(problems).toEqual(['chunks/a.2.js: 48 bytes on the site, 50 here']);
    expect(calls).toBe(1);
  });

  test('a HEAD size that a GET contradicts is not a problem; one a GET confirms is', async () => {
    const files = [{ rel: 'viewer.AAA.js', size: 100 }, { rel: 'chunks/a.2.js', size: 50 }];
    const problems = await findMissing({
      baseUrl: 'https://guides.show/v1/',
      files,
      head: async () => ({ status: 200, size: 0 }),
      getSize: async (url) => (url.endsWith('viewer.AAA.js') ? 100 : 49),
      retry: noWait,
    });
    expect(problems).toEqual(['chunks/a.2.js: 49 bytes on the site, 50 here']);
  });

  test('no size from the site is a problem, not a pass', async () => {
    const problems = await findMissing({ baseUrl: 'https://guides.show/v1/', files: [{ rel: 'viewer.AAA.js', size: 100 }], head: async () => ({ status: 200, size: null }), retry: noWait });
    expect(problems).toEqual(['viewer.AAA.js: the site gave no size (Content-Length)']);
  });

  test('retries a network error before calling a file missing', async () => {
    let calls = 0;
    const missing = await findMissing({
      baseUrl: 'https://guides.show/v1/',
      files: [{ rel: 'viewer.AAA.js', size: 100 }],
      head: async () => { if (++calls < 2) throw new Error('ECONNRESET'); return { status: 200, size: 100 }; },
      retry: noWait,
    });
    expect(missing).toEqual([]);
    expect(calls).toBe(2);
  });
});
