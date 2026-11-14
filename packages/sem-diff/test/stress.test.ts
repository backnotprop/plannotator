// Adversarial cases written by independent stress-test agents (renames, formatting,
// extract/inline, moves, and fuzzer finds), each pinned to the engine's answer. Cases marked `ok` were
// checked by hand; `known-gap` ones are misses accepted for now, pinned so that any
// change in behaviour shows up. Rebuild with test/fixtures/stress/build.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { semanticDiffFile } from '../src/index.ts';
import type { LanguageId } from '../src/parse.ts';
import { brokenRules } from './validate.ts';

type Case = { id: string; area: string; language: LanguageId; title: string; status: string; old: string; new: string; ops: unknown[] };
const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/stress/stress-cases.json', import.meta.url), 'utf8')) as Case[];
const SEMANTIC = new Set(['moved', 'movedWithEdit', 'renamed', 'reformatted', 'extractedFunction', 'inlinedFunction']);

for (const c of cases) {
  test(`stress ${c.status === 'ok' ? '' : '(known gap) '}${c.id}: ${c.title}`, async () => {
    const t0 = performance.now();
    const r = await semanticDiffFile(c.language, c.old, c.new, 'x');
    // Fuzzer finds that once took seconds or ran out of memory: keep them fast.
    if (c.area === 'robust') assert.ok(performance.now() - t0 < 3000, `took ${(performance.now() - t0).toFixed(0)} ms`);
    assert.deepEqual(brokenRules(c.old, c.new, r), []);
    const ops = r.semanticOperations.filter((o) => SEMANTIC.has(o.type)).map((o) => ({ type: o.type, old: o.lines.old.map((l) => [l.start, l.end]), new: o.lines.new.map((l) => [l.start, l.end]) }));
    assert.deepEqual(ops, c.ops);
  });
}
