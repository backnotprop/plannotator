/**
 * What a list row's grey slot shows (option A, "name instead of project", the owner's decision of 2026-11-10; the
 * states in briefs `session-names-states.md`). Pure, so every state is one case of its table test.
 *
 * - A project with fewer than two live sessions (`several` false, held as severalSessions.ts decides), or a row with no
 *   session (the CLI, a raw MCP send, a note): the project, exactly as before.
 * - Otherwise the session's name in the project's place, the project in the tooltip ("plannotator · docs sweep").
 *   The name is the first there is of: the name the person gave (`label`), the host's generated title or Claude
 *   Code's own name for the session (`title`), else a default made here, the project and a short code from the
 *   session id ("plannotator-k3"), stable, lengthened only when two sessions of the project would share it.
 * - Two sessions of the project that would read alike each add their code: "docs (k3)", "docs (p9)".
 * - A long name is cut in the middle at SLOT_NAME_MAX characters ("Fix login…for SSO users"); the tooltip has it whole.
 */
import { shortLabel } from './sessionLabels';

/** The longest name the slot draws, in characters; past it, cut in the middle (CSS then cuts at the column). */
export const SLOT_NAME_MAX = 32;

export interface SlotNames {
  /** The name the person gave (the list's `session_labels`, or a linked machine's agent label). */
  label?: string | null;
  /** The host's generated title, else Claude Code's own name (the list's `session_titles`). */
  title?: string | null;
}

export interface RowSlotInput {
  /** The project as the row shows it. */
  project: string;
  /** The session the row is about (its author, or the addressee of a thread the person started); null: none. */
  session: string | null;
  names: SlotNames;
  /** The project has two or more live sessions, as held (severalSessions.ts). */
  several: boolean;
  /** The project's other known sessions and their names: a name that would read the same adds its code. */
  peers: readonly ({ session: string } & SlotNames)[];
}

export type RowSlot = { kind: 'project'; text: string } | { kind: 'name'; text: string; tip: string };

/** A session id's code in base 36 (FNV-1a), stable across windows and reloads. */
function codeOf(session: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < session.length; i += 1) {
    hash ^= session.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Lowest digits first: each is spread evenly (a 32-bit number's leading base-36 digit is only ever 0 or 1).
  let out = '';
  for (let i = 0; i < 6; i += 1, hash = Math.floor(hash / 36)) out += (hash % 36).toString(36);
  return out;
}

/** The shortest code (2 characters or more) no other session of the project shares. */
export function sessionCode(session: string, others: readonly string[]): string {
  const mine = codeOf(session);
  const theirs = others.filter((other) => other !== session).map(codeOf);
  let n = 2;
  while (n < mine.length && theirs.some((code) => code.slice(0, n) === mine.slice(0, n))) n += 1;
  return mine.slice(0, n);
}

const clean = (name: string | null | undefined): string | null => (typeof name === 'string' && name.trim() ? name.trim() : null);
const same = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

/** A session's name: the person's, else the generated one, else the default; null when it has none of the first two. */
function givenName(names: SlotNames): string | null {
  return clean(names.label) ?? clean(names.title);
}

export function rowSlot(input: RowSlotInput): RowSlot {
  if (!input.several || !input.session) return { kind: 'project', text: input.project };
  const others = input.peers.filter((peer) => peer.session !== input.session);
  const code = sessionCode(input.session, others.map((peer) => peer.session));
  const given = givenName(input.names);
  let name = given ?? `${input.project}-${code}`;
  if (given && others.some((peer) => { const theirs = givenName(peer); return theirs !== null && same(theirs, given); })) name = `${given} (${code})`;
  return { kind: 'name', text: shortLabel(name, SLOT_NAME_MAX), tip: `${input.project} · ${name}` };
}
