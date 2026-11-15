import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { LANGUAGES, type LanguageId } from '../src/parse.ts';
import { semanticDiffFile } from '../src/index.ts';

type Ranges = Array<[number, number]>;
type Entry = { type: string; old?: Ranges; new?: Ranges; optional?: boolean };
type Case = { id: string; language: string; title: string; expected: string; status: 'ok' | 'borderline'; old: string; new: string; ops: Entry[]; never?: Entry[] };

const CLAIMS = new Set(['moved', 'movedWithEdit', 'renamed', 'reformatted', 'reordered', 'extractedFunction', 'inlinedFunction']);
const dir = path.join(import.meta.dirname, 'fixtures', 'traps');

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  for (const c of JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Case[]) {
    const supported = c.language in LANGUAGES;
    const held = supported ? LANGUAGES[c.language as LanguageId].holdBack : undefined;
    for (const shipped of held?.size ? [false, true] : [true]) test(`${c.id}: ${c.title}${held?.size ? (shipped ? ' (as shipped)' : ' (rules, nothing held back)') : ''}`, { skip: supported ? false : `no ${c.language} engine yet` }, async () => {
      const cfg = LANGUAGES[c.language as LanguageId];
      if (!shipped) cfg.holdBack = undefined;
      let r;
      try {
        r = await semanticDiffFile(c.language as LanguageId, c.old, c.new, c.id);
      } finally {
        cfg.holdBack = held;
      }
      const ops = r.semanticOperations;
      const overlaps = (o: (typeof ops)[number], e: Entry) =>
        e.type === o.type && (['old', 'new'] as const).every((s) => !e[s] || o.lines[s].some((l) => e[s]!.some(([a, b]) => l.start <= b && a <= l.end)));
      const show = () => JSON.stringify(ops.map((o) => [o.type, o.lines.old.map((l) => [l.start, l.end]), o.lines.new.map((l) => [l.start, l.end])]));
      const heldHere = shipped && c.ops.some((x) => held?.has(x.type));
      for (const e of (c.never ?? []).filter((x) => !heldHere || CLAIMS.has(x.type))) assert.ok(!ops.some((o) => overlaps(o, e)), `never ${JSON.stringify(e)}: ${c.expected}\n  got ${show()}`);
      if (c.status !== 'ok') return;
      for (const e of c.ops.filter((x) => !x.optional && !(shipped && held?.has(x.type)))) assert.ok(ops.some((o) => overlaps(o, e)), `expected ${JSON.stringify(e)}: ${c.expected}\n  got ${show()}`);
      for (const o of ops) if (CLAIMS.has(o.type)) assert.ok(c.ops.some((e) => overlaps(o, e)), `unexpected ${o.type}: ${c.expected}\n  got ${show()}`);
    });
  }
}
