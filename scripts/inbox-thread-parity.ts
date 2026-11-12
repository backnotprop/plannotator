import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { seedThreadParity } from '../tests/e2e/inbox-thread-parity-seed';
import { inboxScratch, rememberInboxOf, removeInboxScratch, stopScratchInbox } from '../tests/e2e/inbox-scratch';

const repo = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const keep = args.includes('--keep');

function sh(cmd: string[], options: SpawnSyncOptions = {}): string {
  const result = spawnSync(cmd[0]!, cmd.slice(1), { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28, ...options });
  if (result.status !== 0) throw new Error(`${cmd.join(' ')} failed (${result.status}):\n${result.stderr ?? ''}${result.stdout ?? ''}`);
  return String(result.stdout ?? '').trim();
}

function log(line: string): void {
  process.stdout.write(`[parity] ${line}\n`);
}

function build(dir: string, outfile: string): void {
  mkdirSync(dirname(outfile), { recursive: true });
  const loud: SpawnSyncOptions = { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] };
  sh(['bun', 'run', '--cwd', 'apps/review', 'build'], loud);
  sh(['bun', 'run', 'build:hook'], loud);
  sh(['bun', 'build', 'apps/hook/server/index.ts', '--compile', '--no-compile-autoload-bunfig', '--define', '__CLI_VERSION__="0.0.0-dev"', '--outfile', outfile], loud);
}

function baseBinary(): { binary: string; label: string } {
  const given = flag('--base-binary');
  if (given) return { binary: resolve(given), label: given };
  const ref = flag('--base') ?? 'origin/main';
  if (ref.startsWith('origin/')) sh(['git', 'fetch', '-q', 'origin']);
  const sha = sh(['git', 'rev-parse', `${ref}^{commit}`]);
  const binary = join(repo, '.local', 'parity', 'bin', `base-${sha.slice(0, 12)}`, 'plannotator');
  if (existsSync(binary)) {
    log(`reference: ${ref} ${sha.slice(0, 12)} (cached ${relative(repo, binary)})`);
    return { binary, label: `${ref} ${sha}` };
  }
  const src = join(tmpdir(), `plannotator-parity-src-${sha.slice(0, 12)}`);
  rmSync(src, { recursive: true, force: true });
  log(`reference: building ${ref} ${sha.slice(0, 12)} in ${src}`);
  sh(['git', 'worktree', 'add', '-q', '--detach', src, sha]);
  try {
    sh(['bun', 'install', '--frozen-lockfile'], { cwd: src, stdio: ['ignore', 'ignore', 'inherit'] });
    build(src, binary);
  } finally {
    sh(['git', 'worktree', 'remove', '--force', src]);
  }
  return { binary, label: `${ref} ${sha}` };
}

function candidateBinary(): { binary: string; label: string } {
  const given = flag('--candidate-binary');
  if (given) return { binary: resolve(given), label: given };
  const binary = join(repo, '.local', 'parity', 'bin', 'candidate', 'plannotator');
  const head = sh(['git', 'rev-parse', 'HEAD']);
  const dirty = sh(['git', 'status', '--porcelain']) !== '';
  log(`candidate: building this checkout (${head.slice(0, 12)}${dirty ? ', with uncommitted changes' : ''})`);
  build(repo, binary);
  return { binary, label: `this checkout ${head}${dirty ? ' (uncommitted changes)' : ''}` };
}

function capture(role: 'reference' | 'candidate', binary: string, seedRoot: string, out: string): number {
  log(`${role}: capturing with ${binary}`);
  const result = spawnSync(join(repo, 'node_modules', '.bin', 'playwright'), ['test', '-c', 'tests/e2e/inbox-thread-parity.config.ts'], {
    cwd: repo,
    stdio: 'inherit',
    env: { ...process.env, PLANNOTATOR_PARITY_SEED: seedRoot, PLANNOTATOR_PARITY_OUT: out, PLANNOTATOR_PARITY_ROLE: role, PLANNOTATOR_E2E_BINARY: binary },
  });
  return result.status ?? 1;
}

function files(dir: string, prefix = ''): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]));
}

interface Failure {
  test: string;
  project: string;
  message: string;
}

function failures(results: string): Failure[] {
  if (!existsSync(results)) return [{ test: '(the run)', project: '', message: 'no results.json' }];
  const report = JSON.parse(readFileSync(results, 'utf8')) as { suites: Suite[]; errors?: { message?: string }[] };
  type Suite = { title: string; specs?: { title: string; tests: { projectName: string; results: { status: string; errors?: { message?: string }[] }[] }[] }[]; suites?: Suite[] };
  const out: Failure[] = (report.errors ?? []).map((e) => ({ test: '(global)', project: '', message: e.message ?? '' }));
  const walk = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests) {
        for (const r of t.results) {
          for (const e of r.errors ?? []) out.push({ test: spec.title, project: t.projectName, message: (e.message ?? '').replace(/\u001b\[[0-9;]*m/g, '') });
          if (r.status !== 'passed' && (r.errors ?? []).length === 0) out.push({ test: spec.title, project: t.projectName, message: r.status });
        }
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites) walk(suite);
  return out;
}

function shotOf(message: string): string {
  return /Snapshot: (\S+)/.exec(message)?.[1] ?? /png\/[^/]+\/(\S+?\.png)/.exec(message)?.[1] ?? '(unknown)';
}

function pixelsOf(message: string): string {
  return /\d+ pixels \(ratio [^)]*\) are different/.exec(message)?.[0] ?? /Expected an image \d+px by \d+px, received \d+px by \d+px[^.]*/.exec(message)?.[0] ?? message.split('\n')[0]!;
}

async function main(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = resolve(flag('--out') ?? join(repo, '.local', 'parity', stamp));
  if (existsSync(out)) rmSync(out, { recursive: true });
  mkdirSync(out, { recursive: true });
  const base = baseBinary();
  const candidate = candidateBinary();

  const seedRoot = inboxScratch('plannotator-thread-parity-seed-');
  try {
    log(`seeding ${seedRoot} with the reference binary`);
    const seed = await seedThreadParity(base.binary, seedRoot, async (dataDir) => {
      rememberInboxOf(dataDir);
      await stopScratchInbox(dataDir);
    });
    writeFileSync(join(out, 'seed.json'), JSON.stringify(seed, null, 2));
    const referenceStatus = capture('reference', base.binary, seedRoot, out);
    if (referenceStatus !== 0) throw new Error(`the reference run failed (exit ${referenceStatus}); see above. Nothing was compared.`);
    capture('candidate', candidate.binary, seedRoot, out);
  } finally {
    if (keep) log(`kept the seed at ${seedRoot}`);
    else await removeInboxScratch(seedRoot);
  }

  const pngs = files(join(out, 'reference', 'png')).filter((f) => f.endsWith('.png'));
  const failed = failures(join(out, 'candidate', 'results.json'));
  const pixel = failed.filter((f) => /toHaveScreenshot|Screenshot comparison failed|snapshot doesn't exist|pixels/.test(f.message));
  const other = failed.filter((f) => !pixel.includes(f));

  const refDom = join(out, 'reference', 'dom');
  const candDom = join(out, 'candidate', 'dom');
  const names = [...new Set([...files(refDom), ...files(candDom)])].sort();
  const domDiffs: string[] = [];
  const diffDir = join(out, 'dom-diff');
  for (const name of names) {
    const a = join(refDom, name);
    const b = join(candDom, name);
    if (existsSync(a) && existsSync(b) && readFileSync(a, 'utf8') === readFileSync(b, 'utf8')) continue;
    domDiffs.push(name);
    const diff = spawnSync('diff', ['-u', existsSync(a) ? a : '/dev/null', existsSync(b) ? b : '/dev/null'], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout;
    mkdirSync(dirname(join(diffDir, `${name}.diff`)), { recursive: true });
    writeFileSync(join(diffDir, `${name}.diff`), diff);
  }

  const ok = pixel.length === 0 && other.length === 0 && domDiffs.length === 0;
  const summary = {
    ok,
    reference: base.label,
    candidate: candidate.label,
    screenshots: { compared: pngs.length, differing: pixel.length },
    dom: { compared: names.length, differing: domDiffs.length },
    otherFailures: other.length,
  };
  const pixelShots = pixel.map((f) => ({ project: f.project, snapshot: shotOf(f.message), difference: pixelsOf(f.message) }));
  writeFileSync(join(out, 'report.json'), JSON.stringify({ ...summary, pixel: pixelShots, other, domDiffs }, null, 2));
  const lines = [
    '# Inbox thread parity',
    '',
    `- Reference: ${base.label}`,
    `- Candidate: ${candidate.label}`,
    `- Screenshots: ${pngs.length} compared at zero pixels, ${pixel.length} differing`,
    `- outerHTML and page errors: ${names.length} files compared, ${domDiffs.length} differing`,
    `- Other failures: ${other.length}`,
    `- Result: ${ok ? 'IDENTICAL' : 'DIFFERENT'}`,
    '',
    ...(pixel.length ? ['## Differing screenshots (actual, expected and diff PNGs in candidate/test-results/)', '', ...pixel.map((f) => `- ${f.project}/${shotOf(f.message)}: ${pixelsOf(f.message)}`), ''] : []),
    ...(domDiffs.length ? ['## Differing DOM files (unified diffs in dom-diff/)', '', ...domDiffs.map((n) => `- ${n}`), ''] : []),
    ...(other.length ? ['## Other failures', '', ...other.map((f) => `- ${f.project} › ${f.test}: ${f.message.split('\n')[0]}`), ''] : []),
  ];
  writeFileSync(join(out, 'report.md'), `${lines.join('\n')}\n`);
  process.stdout.write(`\n${lines.join('\n')}\nEvidence: ${out}\n`);
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(2);
});
