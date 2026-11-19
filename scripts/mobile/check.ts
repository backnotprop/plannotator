/**
 * Is the mobile contract in step with the product? (docs/agent-guides/mobile.md)
 *
 *   bun scripts/mobile/check.ts
 *
 * Every comparison of the live product with a committed contract file: each
 * generator's output (door.json, the schema, Wire.swift, tokens, words, the
 * parity surface and ledger, the vectors, the stream suite), the ledger's
 * rules, and whether each flow check's cited file still exists. Only the
 * mobile-contract workflow's `contract` job runs it (a pull request that
 * touches the contract or its scripts, a push to main, nightly). It is a
 * script, not a test file, and no test imports it, so an Inbox pull request
 * never fails for a mobile reason; when main moves ahead, this says what to
 * do in its first line.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FLOW_FILES } from './flows';
import { GENERATORS } from './generators';
import { REGENERATE, ROOT, emit } from './lib';
import { entryFingerprints, parityProblems, readLedger } from './parity';
import { buildSurface, surfaceEntries } from './surface';
import { generateStreamVectors } from './vectors-stream';

const CHECK = /^- \[([a-z]+-\d{2})\]\s+(.*)$/;
const CITED = /\(((?:[\w./-]+:\d+)(?:; [\w./-]+:\d+)*)\)$/;

/** Each flow check citing a file that no longer exists (the file only, never the line). */
export function flowCitationProblems(): string[] {
  const bad: string[] = [];
  for (const file of FLOW_FILES) {
    for (const line of readFileSync(join(ROOT, file), 'utf8').split('\n')) {
      const m = CHECK.exec(line);
      const cited = m ? CITED.exec(m[2]!.trimEnd()) : null;
      if (!m || !cited) continue;
      for (const ref of cited[1]!.split('; ')) {
        const path = ref.slice(0, ref.lastIndexOf(':'));
        if (!existsSync(join(ROOT, path))) bad.push(`${file} [${m[1]}]: ${path} does not exist`);
      }
    }
  }
  return bad;
}

/** What is out of step, in the words a person acts on. Empty: the contract matches the product. */
export async function contractReport(): Promise<string[]> {
  const ledger = readLedger();
  const live = surfaceEntries(buildSurface());
  const named = new Set(ledger.rows.flatMap((r) => r.surface));
  const liveSet = new Set(live);
  const added = live.filter((e) => !named.has(e));
  const lost = [...named].filter((e) => !liveSet.has(e)).sort();
  const stale: string[] = [];
  for (const [, generate] of GENERATORS) stale.push(...emit(await generate(), true));
  stale.push(...emit(generateStreamVectors(), true));
  const surface = buildSurface();
  const rules = parityProblems(ledger, live, surface.check ?? [], entryFingerprints()).filter(
    (p) => !p.startsWith('The window gained') && !p.startsWith('The window lost') && !p.includes(REGENERATE),
  );
  const citations = flowCitationProblems();
  const lines: string[] = [];
  if (added.length || lost.length || stale.length) {
    lines.push(`main is ahead of the mobile contract: run \`${REGENERATE}\` in a mobile PR`);
    if (added.length) lines.push(`New entries (that command records them as undecided, dated today; decide them within 14 days):`, ...added.map((e) => `  ${e}`));
    if (lost.length) lines.push('Entries the product no longer has (that command takes them out of the ledger):', ...lost.map((e) => `  ${e}`));
    if (stale.length) lines.push('Stale contract files (that command rewrites them):', ...stale.map((p) => `  ${p}`));
  }
  if (citations.length) lines.push('Flow checks citing a file that is gone (edit the flow to cite where the window does it now):', ...citations.map((c) => `  ${c}`));
  if (rules.length) lines.push('The ledger breaks its rules (edit apps/mobile/contract/parity/ledger.json):', ...rules.map((r) => `  ${r}`));
  return lines;
}

if (import.meta.main) {
  const lines = await contractReport();
  if (lines.length) {
    console.error(lines.join('\n'));
    process.exit(1);
  }
  console.log('the mobile contract is in step with the product');
}
