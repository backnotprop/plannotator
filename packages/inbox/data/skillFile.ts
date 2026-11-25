/**
 * One skill's SKILL.md for the person to read, wherever it is: what works on one linked computer works on the others.
 *
 * A reply's skill was resolved where the person typed it, so when the message records where that was (`sent_from`:
 * the thread's own machine, or the linked computer that forwarded it) that computer's copy is read first, even when
 * this one has a different skill of the same name. Otherwise this computer's (`GET /api/inbox/skills/file`, the file
 * as it is on disk), then the thread's machine, then every other linked computer. Another computer's copy comes
 * through its door's `skills/content`, the route its reply box pastes from: the instructions without their
 * frontmatter, cut at 20,000 characters (a cut copy shows as too large, never silently short). A human-only skill
 * whose instructions went with the message is shown from what was sent when no computer has it now.
 */
import { inboxSentFromOf } from '@plannotator/core/inbox-types';
import { splitInboxSkillsBlock } from '@plannotator/core/skill-reference-block';
import { INBOX_BUILTIN_SKILL_ROOT } from '@plannotator/core/inbox-review';
import { inboxBuiltinSkillContent } from '@plannotator/core/inbox-skills-compose';
import type { SkillCatalogEntry } from '@plannotator/core/skill-references-render';
import { normalizeSkillContent } from '@plannotator/ui/utils/skillCatalog';
import { get } from '../api';
import { inboxUrl, linkedMachineFacts, linkedMachineIds, selfMachineName } from '../inboxUrl';

export type SkillFileView =
  | { found: false }
  | {
      found: true;
      name: string;
      source: 'plannotator' | 'own';
      text: string | null;
      tooLarge: boolean;
      /** The linked computer it was read from; null: this one. */
      machine: string | null;
      /** No computer has it now: the instructions as the message carried them. */
      sent?: true;
    };

/** Where the skill is read: a linked computer's id, or null for this one. */
type Source = string | null;

export interface SkillFileWhere {
  /** The thread's machine; null: this computer. */
  thread: string | null;
  /** The person's message that used it: where it was written, and its body (its skills block). */
  message?: { body: string; sent_from?: unknown } | null;
}

function viewOf(raw: unknown): SkillFileView {
  if (!raw || typeof raw !== 'object' || (raw as { found?: unknown }).found !== true) return { found: false };
  const { name, source, text, too_large } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !name) return { found: false };
  return {
    found: true,
    name,
    source: source === 'plannotator' ? 'plannotator' : 'own',
    text: typeof text === 'string' ? text : null,
    tooLarge: too_large === true,
    machine: null,
  };
}

/**
 * The computer the person typed the message on, when it says (`sent_from`): the thread's own machine (its window, or
 * a device that reached it), or the linked computer that forwarded it, found by the name the thread's machine
 * recorded. Undefined: it does not say, or that computer is not one this one knows.
 */
export function skillWrittenOn(sentFrom: unknown, thread: Source): Source | undefined {
  const from = inboxSentFromOf(sentFrom);
  if (!from) return undefined;
  if (from.kind !== 'machine') return thread;
  if (thread !== null && from.name === selfMachineName()) return null;
  return linkedMachineIds().find((id) => id !== thread && linkedMachineFacts(id)?.name === from.name);
}

/** The instructions a message's skills block carried for `name` (a human-only skill's), as sent; null when none. */
export function skillSentText(body: string, name: string): string | null {
  const split = splitInboxSkillsBlock(body);
  if (!split?.skills.some((skill) => skill.name === name && skill.included)) return null;
  const lines = split.block.split('\n');
  const begin = lines.indexOf(`--- BEGIN SKILL INSTRUCTIONS: ${name} ---`);
  const end = begin < 0 ? -1 : lines.indexOf(`--- END SKILL INSTRUCTIONS: ${name} ---`, begin + 1);
  if (end < 0) return null;
  const section = lines.slice(begin + 1, end);
  // The lines before the first blank one tell the agent what the section is; the skill's own text follows.
  const text = section.slice(section.findIndex((line) => line.trim() === '') + 1).join('\n').trim();
  return text || null;
}

async function readHere(name: string): Promise<SkillFileView> {
  try {
    return viewOf(await get<unknown>(inboxUrl(`/skills/file?name=${encodeURIComponent(name)}`)));
  } catch {
    // Unreadable here: as if missing, so another computer's copy is tried.
    return { found: false };
  }
}

/** How long another computer's copy is waited for: one asleep or slow never holds the pane. */
export const SKILL_FILE_FAR_MS = 3000;

/** A skill built into Plannotator: another computer's `skills/content` never serves one, and it is never "Your skill". */
export function builtinSkillName(name: string): boolean {
  return inboxBuiltinSkillContent({ name, root: INBOX_BUILTIN_SKILL_ROOT } as SkillCatalogEntry, true) !== undefined;
}

async function readThere(name: string, machine: string, losers: AbortSignal, ms: number): Promise<SkillFileView> {
  const own = new AbortController();
  const stop = () => own.abort();
  losers.addEventListener('abort', stop, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Its own short wait, kept even when the read does not hear its abort.
  const late = new Promise<SkillFileView>((resolve) => {
    timer = setTimeout(() => {
      own.abort();
      resolve({ found: false });
    }, ms);
  });
  const read = (async (): Promise<SkillFileView> => {
    const raw = (await get<{ skill?: unknown }>(inboxUrl(`/skills/content?name=${encodeURIComponent(name)}`, undefined, machine), own.signal)).skill;
    const there = normalizeSkillContent(raw);
    if (!there?.content) return { found: false };
    // The far side's own word when it gives one, else the name's: a built-in is never "Your skill".
    const said = (raw as { source?: unknown }).source;
    const source = said === 'plannotator' || said === 'own' ? said : builtinSkillName(name) ? 'plannotator' : 'own';
    return { found: true, name, source, text: there.truncated ? null : there.content, tooLarge: there.truncated, machine };
  })().catch((): SkillFileView => ({ found: false })); // Not there, or that computer is not answering.
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
    losers.removeEventListener('abort', stop);
  }
}

/**
 * `name`'s file, read where the message was written first when it says, then here, then the thread's machine, then
 * every other linked computer. Every computer is asked at once and the first found in that order is kept (the rest
 * are dropped); only a linked computer online now is asked, each for `farMs` at most, and none for a built-in.
 * Never throws.
 */
export async function readSkillFile(name: string, where: SkillFileWhere, farMs = SKILL_FILE_FAR_MS): Promise<SkillFileView> {
  const order: Source[] = [];
  const builtin = builtinSkillName(name);
  const add = (source: Source | undefined) => {
    if (source === undefined || order.includes(source)) return;
    if (source !== null && (builtin || linkedMachineFacts(source)?.state !== 'online')) return;
    order.push(source);
  };
  add(skillWrittenOn(where.message?.sent_from, where.thread));
  add(null);
  add(where.thread);
  for (const id of linkedMachineIds()) add(id);
  const losers = new AbortController();
  const reads = order.map((source) => (source === null ? readHere(name) : readThere(name, source, losers.signal, farMs)));
  try {
    for (const read of reads) {
      const view = await read;
      if (view.found) return view;
    }
  } finally {
    losers.abort();
  }
  const sent = where.message ? skillSentText(where.message.body, name) : null;
  if (sent) return { found: true, name, source: 'own', text: sent, tooLarge: false, machine: null, sent: true };
  return { found: false };
}
