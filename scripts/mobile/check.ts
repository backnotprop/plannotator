/**
 * Is the mobile contract in step with the product? (docs/agent-guides/mobile.md)
 *
 *   bun scripts/mobile/check.ts
 *
 * Every comparison of the live product with a committed contract file: each
 * generator's output (door.json, the schema, Wire.swift, tokens, words, the
 * parity surface and ledger, the vectors, the stream suite), the generators'
 * own rules (rules.ts), the ledger's rules, and whether each flow check's
 * cited file still exists. Only the mobile-contract workflow runs it (its
 * `contract` job: a pull request that touches the contract or its scripts, a
 * push to main, nightly). It is a script, not a test file, and no test
 * imports it, so an Inbox pull request never fails for a mobile reason.
 *
 * When main has moved ahead, the first line says what to do. A generator that
 * throws still gets that first line, then the generator and its message. The
 * mobile modules are imported one step at a time, so a product export a
 * generator needs going missing is reported the same way, not as a stack.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGENERATE, ROOT, emit, type Output } from './lib';

/** The first line whenever main is ahead of the contract. */
export const BEHIND = `main is ahead of the mobile contract: run \`${REGENERATE}\` in a mobile PR`;

const CHECK = /^- \[([a-z]+-\d{2})\]\s+(.*)$/;
const CITED = /\(((?:[\w./-]+:\d+)(?:; [\w./-]+:\d+)*)\)$/;

/** Each flow check citing a file that no longer exists (the file only, never the line). */
export function flowCitationProblems(files: readonly string[]): string[] {
  const bad: string[] = [];
  for (const file of files) {
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

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!;

/** What is out of step, in the words a person acts on. Empty: the contract matches the product. */
export async function contractReport(): Promise<string[]> {
  const failed: string[] = [];
  const attempt = async <T>(name: string, run: () => T | Promise<T>): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      failed.push(`${name} failed: ${message(error)}`);
      return undefined;
    }
  };

  const stale: string[] = [];
  const generators = await attempt('loading the generators', async () => (await import('./generators')).GENERATORS);
  for (const [name, generate] of generators ?? []) {
    const outputs = await attempt(`generator ${name}`, generate);
    if (outputs) stale.push(...emit(outputs, true));
  }
  const stream = await attempt('generator vectors-stream', async () => (await import('./vectors-stream')).generateStreamVectors() as Output[]);
  if (stream) stale.push(...emit(stream, true));

  const parity = await import('./parity');
  const read = await attempt('reading the ledger and the live surface', async () => {
    const { readLedger, entryFingerprints } = await import('./ledger');
    const { buildSurface, surfaceEntries } = await import('./surface');
    const surface = buildSurface();
    return { ledger: readLedger(), surface, live: surfaceEntries(surface), prints: entryFingerprints() };
  });
  let added: string[] = [];
  let lost: string[] = [];
  let emptied: string[] = [];
  let ledgerRules: string[] = [];
  if (read) {
    const { ledger, surface, live, prints } = read;
    const named = new Set(ledger.rows.flatMap((r) => r.surface));
    const liveSet = new Set(live);
    added = live.filter((e) => !named.has(e));
    lost = [...named].filter((e) => !liveSet.has(e)).sort();
    emptied = parity.emptiedRows(ledger, parity.ledgerInStep(ledger, live, prints)).map((r) => `${r.id} (${r.mobile}): ${r.surface.join(', ')}`);
    ledgerRules = parity.parityProblems(ledger, live, surface.check ?? [], prints).filter(
      (p) => !p.startsWith('The window gained') && !p.startsWith('The window lost') && !p.includes(REGENERATE),
    );
  }

  const rules: string[] = [];
  const ruleModule = await attempt('loading the generators\' rules', () => import('./rules'));
  if (ruleModule) {
    for (const [name, run] of [['door rules', ruleModule.doorRules], ['schema rules', ruleModule.schemaRules], ['word rules', ruleModule.wordRules]] as const) {
      rules.push(...((await attempt(name, run)) ?? []));
    }
  }
  const citations = (await attempt('the flow checks', async () => flowCitationProblems((await import('./flows')).FLOW_FILES))) ?? [];

  const lines: string[] = [];
  if (added.length || lost.length || stale.length || failed.length) {
    lines.push(BEHIND);
    if (failed.length) lines.push(`Failed (fix it in scripts/mobile/ in that PR; until then \`${REGENERATE}\` fails the same way):`, ...failed.map((f) => `  ${f}`));
    if (added.length) lines.push(`New entries (that command records them as undecided, dated today; decide them within 14 days):`, ...added.map((e) => `  ${e}`));
    if (lost.length) lines.push('Entries the product no longer has (that command takes them out of the ledger):', ...lost.map((e) => `  ${e}`));
    if (emptied.length) lines.push('Decided rows left naming nothing (move each decision to the entry that replaced it, if any):', ...emptied.map((e) => `  ${e}`));
    if (stale.length) lines.push('Stale contract files (that command rewrites them):', ...stale.map((p) => `  ${p}`));
  }
  if (rules.length) lines.push("The generators' rules fail (fix scripts/mobile/ in a mobile PR):", ...rules.map((r) => `  ${r}`));
  if (citations.length) lines.push('Flow checks citing a file that is gone (edit the flow to cite where the window does it now):', ...citations.map((c) => `  ${c}`));
  if (ledgerRules.length) lines.push('The ledger breaks its rules (edit apps/mobile/contract/parity/ledger.json):', ...ledgerRules.map((r) => `  ${r}`));
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
