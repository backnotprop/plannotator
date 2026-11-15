import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DRAW_GAP_MS } from '../inbox/data/apply/drawGap';
import { ACTIONS, runAction, type Action } from '../../tests/helpers/inbox-apply-actions';
import { startApplyWorld, type ApplyWorld } from '../../tests/helpers/inbox-apply-world';
import { NO_BROWSER } from '../../tests/helpers/no-browser';

const APPLIER_KINDS = ['message:first', 'message:later', 'question', 'annotation', 'project', 'card', 'initiative', 'steps', 'thread_pull'];

function seedsFromEnv(): number[] {
  const text = process.env.INBOX_DIFF_SEEDS?.trim();
  if (!text) return Array.from({ length: 16 }, (_, i) => i + 1);
  const range = /^(\d+)-(\d+)$/.exec(text);
  if (range) return Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, i) => Number(range[1]) + i);
  return text.split(',').map((part) => Number(part.trim()));
}

const SEEDS = seedsFromEnv();
const STEPS = Number(process.env.INBOX_DIFF_STEPS ?? 60);

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function plan(seed: number, steps: number): Action[] {
  const next = random(seed);
  const int = () => Math.floor(next() * 1000);
  const start: Action[] = [{ kind: 'agent-new', n: [0, 0, 0] }, { kind: 'agent-new', n: [0, 1, 1] }];
  return [...start, ...Array.from({ length: steps }, () => ({ kind: ACTIONS[Math.floor(next() * ACTIONS.length)]!, n: [int(), int(), int()] as const }))];
}

const realFetch = globalThis.fetch;
const realNow = Date.now;
const realBrowser = process.env.PLANNOTATOR_BROWSER;
const realDataDir = process.env.PLANNOTATOR_DATA_DIR;
const scratch = mkdtempSync(join(tmpdir(), 'plannotator-inbox-apply-diff-home-'));
let base = '';
let skew = 0;
const kinds = new Map<string, number>();

beforeAll(() => {
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
  process.env.PLANNOTATOR_DATA_DIR = join(scratch, 'data');
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => realFetch(typeof input === 'string' && input.startsWith('/') ? `${base}${input}` : input, init)) as typeof fetch;
  Date.now = () => realNow() + skew;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  if (realBrowser === undefined) delete process.env.PLANNOTATOR_BROWSER;
  else process.env.PLANNOTATOR_BROWSER = realBrowser;
  if (realDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = realDataDir;
  rmSync(scratch, { recursive: true, force: true });
});

async function sync(w: ApplyWorld): Promise<void> {
  for (const event of await w.stream.through(w.server.store.cursor())) {
    const kind = event.kind === 'message' ? `message:${event.first ? 'first' : 'later'}` : event.kind;
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    skew += DRAW_GAP_MS;
    w.window.take(event);
    await Bun.sleep(0);
  }
  await w.window.settle();
}

async function check(w: ApplyWorld): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const drift = await w.window.drift();
    if (w.server.store.cursor() <= w.stream.seen || attempt >= 3) return drift;
    await sync(w);
  }
}

const outcomes = new Map<string, number>();
const productive = new Map<string, number>();

async function run(actions: readonly Action[]): Promise<{ step: number; drift: string } | null> {
  const w = await startApplyWorld();
  base = `http://127.0.0.1:${w.server.port}`;
  try {
    await w.window.readList();
    for (const [step, action] of actions.entries()) {
      const cursor = w.server.store.cursor();
      await runAction(w, action, step);
      if (w.server.store.cursor() > cursor) productive.set(action.kind, (productive.get(action.kind) ?? 0) + 1);
      await sync(w);
      const drift = await check(w);
      if (drift) return { step, drift };
      await w.window.readList();
    }
    return null;
  } finally {
    for (const [key, n] of w.window.outcomes) outcomes.set(key, (outcomes.get(key) ?? 0) + n);
    w.stop();
  }
}

async function shortest(actions: readonly Action[], step: number): Promise<{ actions: Action[]; drift: string }> {
  let kept = actions.slice(0, step + 1);
  let drift = (await run(kept))?.drift ?? '(did not fail again on its own prefix)';
  for (let i = kept.length - 2; i >= 0; i--) {
    const without = [...kept.slice(0, i), ...kept.slice(i + 1)];
    const failed = await run(without);
    if (failed && failed.step === without.length - 1) {
      kept = without;
      drift = failed.drift;
    }
  }
  return { actions: kept, drift };
}

test(`the window's held copy equals a fresh read after every step (${SEEDS.length} seeds from ${SEEDS[0]}, ${STEPS} steps)`, async () => {
  const failures: string[] = [];
  for (const seed of SEEDS) {
    const actions = plan(seed, STEPS);
    const failed = await run(actions);
    if (!failed) continue;
    const shrunk = await shortest(actions, failed.step);
    failures.push(
      [
        `seed ${seed}: drift after step ${failed.step} (${actions[failed.step]!.kind})`,
        `shortest failing sequence (${shrunk.actions.length} steps): ${shrunk.actions.map((a) => `${a.kind}[${a.n.join(',')}]`).join(' ')}`,
        `again: INBOX_DIFF_SEEDS=${seed} INBOX_DIFF_STEPS=${STEPS} bun test packages/server/inbox-apply-differential.test.ts`,
        shrunk.drift,
      ].join('\n'),
    );
  }
  if (process.env.INBOX_DIFF_SEEDS) {
    console.log(`records fed: ${JSON.stringify(Object.fromEntries(kinds))}`);
    console.log(`applier outcomes: ${JSON.stringify(Object.fromEntries([...outcomes].sort()))}`);
    console.log(`actions that wrote: ${JSON.stringify(Object.fromEntries([...productive].sort()))}`);
  }
  expect(failures.join('\n\n')).toBe('');
  expect(APPLIER_KINDS.filter((kind) => !kinds.has(kind))).toEqual([]);
}, 30_000 + SEEDS.length * STEPS * 60);
