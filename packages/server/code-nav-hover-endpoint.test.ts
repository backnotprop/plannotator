/**
 * POST /api/code-nav/hover — dual-runtime (Bun + Pi).
 *
 * Guards two things, both of them the repo's standing two-runtime hazard:
 *  1. Both servers answer the SAME response shape, including the forward
 *     compatibility fields a later tier fills (`source`, `symbolKind`,
 *     `signature`, `doc`) — a Pi mirror that drifts to `/resolve`'s shape
 *     would render an empty card in one runtime and a full one in the other.
 *  2. A session with no local checkout is refused by both with 400, so the
 *     hook renders nothing rather than hovering over confidently-wrong
 *     results from whatever directory the process happened to start in.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReviewServer as startBunReviewServer } from './review';
import { startReviewServer as startPiReviewServer } from '../../apps/pi-extension/server';
import { getVcsContext } from './vcs';

const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
const originalPort = process.env.PLANNOTATOR_PORT;
const tempDirs: string[] = [];

// rg is the whole backend. Where it is missing the endpoint still answers 200
// with `backend: 'unavailable'` — the shape assertions below hold either way,
// so only the enrichment assertions are gated on it.
const hasRipgrep = spawnSync('rg', ['--version']).status === 0;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
}

const SOURCE = [
  '// Charges the card.',
  'export function charge(amount, key) {',
  '  return gateway.post(endpoint, { amount, key });',
  '}',
  '',
  'export function retryCharge(amount, key) {',
  '  return charge(amount, key);',
  '}',
  '',
  'export function queueCharge(amount, key) {',
  '  return charge(amount, key);',
  '}',
  '',
].join('\n');

function initRepo(): string {
  const repoDir = makeTempDir('plannotator-hover-endpoint-');
  git(repoDir, ['init', '-q']);
  git(repoDir, ['branch', '-M', 'main']);
  git(repoDir, ['config', 'user.email', 'test@example.com']);
  git(repoDir, ['config', 'user.name', 'Test']);
  writeFileSync(join(repoDir, 'pay.js'), SOURCE);
  git(repoDir, ['add', 'pay.js']);
  git(repoDir, ['commit', '-q', '-m', 'initial']);
  return repoDir;
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const RAW_PATCH = [
  'diff --git a/pay.js b/pay.js',
  '--- a/pay.js',
  '+++ b/pay.js',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

const HOVER_REQUEST = {
  symbol: 'charge',
  filePath: 'pay.js',
  line: 2,
  charStart: 16,
  side: 'new',
  language: 'javascript',
};

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  if (originalPort === undefined) delete process.env.PLANNOTATOR_PORT;
  else process.env.PLANNOTATOR_PORT = originalPort;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/code-nav/hover', () => {
  for (const [runtime, startServer] of [
    ['Bun', startBunReviewServer],
    ['Pi', startPiReviewServer],
  ] as const) {
    test(`${runtime} answers the hover shape for a local git session`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir('plannotator-hover-data-');
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const repoDir = initRepo();
      const gitContext = await getVcsContext(repoDir, 'git');

      const server = await startServer({
        rawPatch: RAW_PATCH,
        gitRef: 'Working tree',
        diffType: 'uncommitted',
        gitContext,
        agentCwd: repoDir,
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });
      try {
        const res = await fetch(`${server.url}/api/code-nav/hover`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(HOVER_REQUEST),
        });
        expect(res.status).toBe(200);
        const data = await res.json() as Record<string, unknown>;

        // The shape both runtimes owe the client, tier-independent.
        expect(Object.keys(data).sort()).toEqual([
          'alternateDefinition',
          'backend',
          'capped',
          'definition',
          'referenceCount',
          'references',
          'source',
          'stats',
          'symbol',
        ]);
        expect(data.source).toBe('search');
        expect(data.symbol).toBe('charge');
        expect(typeof (data.stats as { elapsedMs: number }).elapsedMs).toBe('number');

        if (!hasRipgrep) {
          expect(data.backend).toBe('unavailable');
          return;
        }

        expect(data.backend).toBe('search');
        const definition = data.definition as {
          filePath: string;
          line: number;
          symbolKind: string | null;
          signature: string | null;
          signatureApproximate: boolean;
          doc: string | null;
          preview: { startLine: number; lines: string[] } | null;
          otherCandidateCount: number;
        };
        expect(definition.filePath).toBe('pay.js');
        expect(definition.line).toBe(2);
        expect(definition.symbolKind).toBe('function');
        expect(definition.signature).toBe('export function charge(amount, key) {');
        expect(definition.signatureApproximate).toBe(true);
        expect(definition.doc).toBe('Charges the card.');
        // Present in the shape both runtimes owe, null until a consumer exists.
        expect(definition.preview).toBeNull();
        // The two call sites, and only those — the definition line is not
        // double-counted as a reference.
        expect(data.referenceCount).toBe(2);
        expect(data.references).toHaveLength(2);
        expect(data.capped).toBe(false);
      } finally {
        server.stop();
      }
    });

    test(`${runtime} refuses a session with no local checkout`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir('plannotator-hover-data-');
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());

      const server = await startServer({
        rawPatch: RAW_PATCH,
        gitRef: 'Piped diff',
        diffType: 'uncommitted',
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });
      try {
        const res = await fetch(`${server.url}/api/code-nav/hover`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(HOVER_REQUEST),
        });
        expect(res.status).toBe(400);
      } finally {
        server.stop();
      }
    });

    test(`${runtime} rejects a traversing filePath`, async () => {
      process.env.PLANNOTATOR_DATA_DIR = makeTempDir('plannotator-hover-data-');
      if (runtime === 'Pi') process.env.PLANNOTATOR_PORT = String(await reservePort());
      const repoDir = initRepo();
      const gitContext = await getVcsContext(repoDir, 'git');

      const server = await startServer({
        rawPatch: RAW_PATCH,
        gitRef: 'Working tree',
        diffType: 'uncommitted',
        gitContext,
        agentCwd: repoDir,
        origin: runtime === 'Pi' ? 'pi' : 'claude-code',
        htmlContent: '<!doctype html><html><body>review</body></html>',
      });
      try {
        const res = await fetch(`${server.url}/api/code-nav/hover`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...HOVER_REQUEST, filePath: '../etc/passwd' }),
        });
        expect(res.status).toBe(400);
      } finally {
        server.stop();
      }
    });
  }
});
