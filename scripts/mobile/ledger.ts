/**
 * The parity ledger as it is in the checkout (apps/mobile/contract/parity/ledger.json) and as the one command
 * rewrites it (docs/agent-guides/mobile.md). The rules are parity.ts, which reads nothing; this module reads the
 * ledger, the live surface and what the phone builds from each entry. Only the generators (all.ts) and
 * scripts/mobile/check.ts import it, never a test.
 */
import { createHash } from 'node:crypto';
import { doorEntries } from './door';
import { FLOW_FILES } from './flows';
import { OUT, jsonText, readRepoText, type Output } from './lib';
import { ledgerInStep, type Ledger } from './parity';
import { buildSchema } from './schema';
import { CHECK_LINE, buildSurface, surfaceEntries } from './surface';

export function readLedger(): Ledger {
  return JSON.parse(readRepoText(OUT.ledger)) as Ledger;
}

/**
 * Each entry's fingerprint: what the phone builds from it. A field: its schema; a door route: its door.json entry;
 * a flow check: its line. Other kinds: the name alone.
 */
export function entryFingerprints(): Map<string, string> {
  const out = new Map<string, string>();
  const hash = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);
  const defs = (buildSchema() as { $defs: Record<string, { properties?: Record<string, unknown> }> }).$defs;
  for (const [type, def] of Object.entries(defs)) for (const [field, schema] of Object.entries(def.properties ?? {})) out.set(`field:${type}.${field}`, hash(JSON.stringify(schema)));
  for (const route of doorEntries()) out.set(`door:${route.name}`, hash(JSON.stringify(route)));
  for (const file of FLOW_FILES) {
    for (const line of readRepoText(file).split('\n')) {
      const id = CHECK_LINE.exec(line)?.[1];
      if (id) out.set(`check:${id}`, hash(line));
    }
  }
  return out;
}

export function generateLedger(): Output[] {
  return [{ path: OUT.ledger, text: jsonText(ledgerInStep(readLedger(), surfaceEntries(buildSurface()), entryFingerprints())) }];
}
