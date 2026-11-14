// Rebuilds stress-cases.json from the adversarial cases the stress-test agents wrote:
// node test/fixtures/stress/build.ts <stress-dir>... Each case is pinned to the
// engine's current semantic operations; `status` says whether that answer is right
// (fixed / ok) or a known gap. Review the diff of the JSON before committing a rebuild.
import fs from 'node:fs';
import { semanticDiffFile } from '../../../src/index.ts';

const KNOWN = new Set([
  // Misses, accepted for now: they fall back to a plain diff.
  'ren-fmt-01', 'ts-asi-throw', 'ts-asi-async-arrow', 'rs-lifetime-split', 'ts-return-parens', 'ts-crlf-file',
  'ts-inline-oneliner', 'ts-extract-oneliner', 'rs-inline-oneliner', 'ts-nested-fn', 'go-multi-return-extract',
  'go-init-insert-first', 'go-iota-enums-swap', 'go-type-group', 'ts-tail-to-next-head', 'ts-method-cross-class-big',
  'go-single-to-group', 'ts-declare-module', 'ts-export-default', 'rs-two-impl-blocks-same-type',
  // TypeScript round (ts-structure, ts-extract): a property of an untyped local renamed with a field;
  // boilerplate (try/catch, retry, effect cleanup) appearing once per version; callers the engine does not see.
  'rename-input-name', 'prop-destructure-rename-jsx-kept', 'interface-merge-member-move', 'declare-module-reformat', 'declare-global-fn-move',
  'export-default-object-move-methods', 'static-block-move',
  'trycatch-unrelated', 'trycatch-diffmsg', 'trycatch-inline-fp', 'retry-boilerplate', 'loop-boilerplate', 'timing-boilerplate', 'interval-effect',
  'useeffect-boilerplate', 'abort-effect', 'handler-closure', 'express-route-caller', 'test-setup-extract', 'ren-decl-02', 'ts-move-total-rewrite', 'ts-twice-in-caller',
  'name-collision-format', 'extract-twice-in-caller',
]);
const SEMANTIC = new Set(['moved', 'movedWithEdit', 'renamed', 'reformatted', 'extractedFunction', 'inlinedFunction']);
const out: unknown[] = [];
for (const dir of process.argv.slice(2)) {
  for (const c of JSON.parse(fs.readFileSync(`${dir}/cases.json`, 'utf8'))) {
    const language = c.language === 'ts' ? 'typescript' : c.language;
    const r = await semanticDiffFile(language, c.old, c.new, 'x');
    const ops = r.semanticOperations.filter((o) => SEMANTIC.has(o.type)).map((o) => ({ type: o.type, old: o.lines.old.map((l) => [l.start, l.end]), new: o.lines.new.map((l) => [l.start, l.end]) }));
    out.push({ id: c.id, area: dir.split('/').pop(), language, title: c.title ?? c.id, expected: c.expected ?? c.why ?? '', status: KNOWN.has(c.id) ? 'known-gap' : 'ok', old: c.old, new: c.new, ops });
  }
}
fs.writeFileSync(new URL('./stress-cases.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(`${out.length} cases`);
