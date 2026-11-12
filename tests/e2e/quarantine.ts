import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type QuarantineEntry = {
  spec: string;
  title: string;
  describe?: string;
  why: string;
  firstSeen: string;
  evidence: number[];
  dependents?: { title: string; why: string }[];
};

export const QUARANTINE_FILE = join(__dirname, 'quarantine.json');

export function quarantineEntries(file = QUARANTINE_FILE): QuarantineEntry[] {
  return (JSON.parse(readFileSync(file, 'utf8')) as { tests: QuarantineEntry[] }).tests;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function testPattern(spec: string, title: string, describe?: string): RegExp {
  const under = describe ? `${escape(describe)} (?:.* )?` : '';
  return new RegExp(`(?:^| )${escape(spec)} (?:.* )?${under}${escape(title)}(?: @\\S+)*$`);
}

export function quarantinedTests(entries = quarantineEntries()): { spec: string; title: string; describe?: string }[] {
  return entries.flatMap((entry) => [
    { spec: entry.spec, title: entry.title, describe: entry.describe },
    ...(entry.dependents ?? []).map((d) => ({ spec: entry.spec, title: d.title, describe: entry.describe })),
  ]);
}

export function quarantineFilter(env: Record<string, string | undefined>, entries = quarantineEntries()): { grepInvert?: RegExp[] } {
  if (!env.CI || env.CI === 'false' || env.CI === '0') return {};
  const patterns = quarantinedTests(entries).map((t) => testPattern(t.spec, t.title, t.describe));
  return patterns.length ? { grepInvert: patterns } : {};
}
