/** What a list row's grey slot shows. The rule and its states: docs/agent-guides/inbox-compose.md. */
import { graphemesOf } from '@plannotator/core/inbox-format';

/** Cut at the end, as CSS cuts the column, so a cut name never shows two "…". */
export const SLOT_NAME_MAX = 32;

export interface SlotNames {
  label?: string | null;
  title?: string | null;
}

export interface RowSlotInput {
  project: string;
  session: string | null;
  names: SlotNames;
  several: boolean;
  peers: readonly ({ session: string } & SlotNames)[];
}

export type RowSlot = { kind: 'project'; text: string } | { kind: 'name'; text: string; tip: string };

function codeOf(session: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < session.length; i += 1) {
    hash ^= session.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Lowest digits first: a 32-bit number's leading base-36 digit is only ever 0 or 1.
  let out = '';
  for (let i = 0; i < 6; i += 1, hash = Math.floor(hash / 36)) out += (hash % 36).toString(36);
  return out;
}

export function sessionCode(session: string, others: readonly string[]): string {
  const mine = codeOf(session);
  const theirs = others.filter((other) => other !== session).map(codeOf);
  let n = 2;
  while (n < mine.length && theirs.some((code) => code.slice(0, n) === mine.slice(0, n))) n += 1;
  return mine.slice(0, n);
}

const clean = (name: string | null | undefined): string | null => (typeof name === 'string' && name.trim() ? name.trim() : null);
const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

function endCut(name: string, max: number): string {
  const chars = graphemesOf(name);
  return chars.length <= max ? name : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

function givenName(names: SlotNames): string | null {
  return clean(names.label) ?? clean(names.title);
}

export function rowSlot(input: RowSlotInput): RowSlot {
  if (!input.several || !input.session) return { kind: 'project', text: input.project };
  const others = input.peers.filter((peer) => peer.session !== input.session);
  const code = sessionCode(input.session, others.map((peer) => peer.session));
  const given = givenName(input.names);
  const alike = given !== null && others.some((peer) => { const theirs = givenName(peer); return theirs !== null && same(theirs, given); });
  const name = given === null ? `${input.project}-${code}` : alike ? `${given} (${code})` : given;
  const text = given === null ? name : alike ? `${endCut(given, SLOT_NAME_MAX - code.length - 3)} (${code})` : endCut(given, SLOT_NAME_MAX);
  return { kind: 'name', text, tip: `${input.project} · ${name}` };
}
