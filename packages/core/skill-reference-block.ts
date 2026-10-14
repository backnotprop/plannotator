/**
 * The "Skills referenced" block: the words both sides of it share.
 *
 * Plannotator's feedback export (`skillReferenceExportBlock` in
 * `@plannotator/ui/utils/skillReferences`) appends this block to a comment
 * that references agent skills by name (`$write-better`, `/readback`): a
 * heading, one list line per skill, and the SKILL.md text of every
 * human-only skill between BEGIN/END markers. Plan review and annotate say it
 * on the reviewer's behalf about "this feedback". The Plannotator Inbox
 * composes the same block when the person sends a reply or a New message
 * (approval "inbox-skill-references", Option B as amended): the person's
 * request, about "this reply" or "this message".
 *
 * The renderer stays in `@plannotator/ui`; this module holds the heading and
 * the reader the Inbox needs to find the block in a stored body again (the
 * window folds it behind one "Skills: …" line, and the folded line's snippet
 * and the search index read the person's words without it). Browser-safe,
 * no dependencies.
 */

/** Who asks for the skills, and what they are asked about. */
export interface SkillBlockAudience {
  /** "reviewer" (plan review, annotate) or "person" (the Inbox). */
  readonly requester: string;
  /** "feedback", "reply" or "message". */
  readonly subject: string;
}

/** Plan review and annotate: the reviewer's feedback. The export's wording since #1229. */
export const REVIEWER_SKILL_AUDIENCE: SkillBlockAudience = { requester: 'reviewer', subject: 'feedback' };
/** The Inbox's reply box (a reply, a redirected reply). */
export const INBOX_REPLY_SKILL_AUDIENCE: SkillBlockAudience = { requester: 'person', subject: 'reply' };
/** The Inbox's New message (and the message-an-agent dialog). */
export const INBOX_MESSAGE_SKILL_AUDIENCE: SkillBlockAudience = { requester: 'person', subject: 'message' };

/** The block's first line. */
export function skillsReferencedHeading(audience: SkillBlockAudience): string {
  return `**Skills referenced** (the ${audience.requester} is asking you to invoke these skills when acting on this ${audience.subject}):`;
}

/** The words a human-only skill's list line carries when its SKILL.md text follows in the block. */
export function skillInstructionsIncludedNote(audience: SkillBlockAudience): string {
  return `its instructions are included below at the ${audience.requester}'s request`;
}

/** The heading the Inbox writes: a person's reply or message. */
const INBOX_HEADING_RE = /^\*\*Skills referenced\*\* \(the person is asking you to invoke these skills when acting on this (reply|message)\):$/;
/** One list line: "- `name`" plus an optional note in parentheses. */
const LIST_LINE_RE = /^- `([^`\n]+)`(.*)$/;
const BEGIN_RE = /^--- BEGIN SKILL INSTRUCTIONS: (.+) ---$/;
const END_RE = /^--- END SKILL INSTRUCTIONS: (.+) ---$/;

/** One skill the block names. */
export interface InboxSkillReference {
  name: string;
  /** Only a person can invoke it (its list line says "cannot be invoked by a model"). */
  humanOnly: boolean;
  /** Its SKILL.md text is in the block (a human-only skill whose instructions went with the message). */
  included: boolean;
  /** UTF-8 bytes of its instructions section (BEGIN to END), 0 when not included. */
  bytes: number;
}

/** A person's message cut where the skills block starts. */
export interface InboxSkillsSplit {
  /** Everything before the block, without trailing whitespace. */
  before: string;
  /** The block, from its heading to the end of the body. */
  block: string;
  /** What the heading calls the message. */
  subject: 'reply' | 'message';
  skills: InboxSkillReference[];
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The rest of a candidate block after its heading (`lines[from]` on), when
 * it is exactly what the window composes: list lines, then only blank lines
 * and BEGIN/END sections for skills the list says are included, each once
 * and closed, to the end of the body. Null for anything else.
 */
function readBlockTail(lines: readonly string[], from: number): InboxSkillReference[] | null {
  const skills: InboxSkillReference[] = [];
  let i = from;
  for (; i < lines.length; i++) {
    const match = LIST_LINE_RE.exec(lines[i]!);
    if (!match) break;
    const note = match[2]!;
    skills.push({
      name: match[1]!,
      humanOnly: note.includes('cannot be invoked by a model') || note.includes('human-invocation-only'),
      included: note.includes('its instructions are included below'),
      bytes: 0,
    });
  }
  if (skills.length === 0) return null;
  const byName = new Map(skills.map((s) => [s.name, s]));
  const seen = new Set<string>();
  let open: { name: string; start: number } | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (open) {
      const end = END_RE.exec(line);
      if (end && end[1] === open.name) {
        byName.get(open.name)!.bytes = utf8Bytes(lines.slice(open.start, i + 1).join('\n'));
        open = null;
      }
      continue;
    }
    if (line.trim() === '') continue;
    // Anything else after the list (the person's words, more feedback) means this is not the window's block.
    const begin = BEGIN_RE.exec(line);
    if (!begin || !byName.get(begin[1]!)?.included || seen.has(begin[1]!)) return null;
    seen.add(begin[1]!);
    open = { name: begin[1]!, start: i };
  }
  return open ? null : skills;
}

/**
 * The skills block at the END of a person's Inbox message, or null.
 *
 * The window composes the block last, so it is the LAST line that is the
 * Inbox heading (at the start of the body or after a blank line) whose tail
 * is exactly the window's shape: list lines, then nothing but blank lines and
 * closed BEGIN/END sections for skills the list includes, to the end of the
 * body. Scanning from the end is what makes text an agent wrote, and the
 * person's reply quotes (a guided-review comment's diff lines, an
 * annotation's quote), unable to fold the person's own words:
 *
 * - the real block is always last; nothing agent-written follows it, so an
 *   earlier fake heading, even one whose unterminated BEGIN would run on to
 *   the real END line, is never the one chosen;
 * - a heading inside a real block's SKILL.md body cannot validate: its
 *   marker lookalikes are neutralized, and the section's own END line breaks
 *   the tail;
 * - with no real block, agent text is always followed by the exporter's own
 *   text (a closing fence, the next section), so a fake block never reaches
 *   the end.
 *
 * Fence parity is not used: the agent controls it (a diff line that is just
 * ``` closes a quote's fence). Plannotator's reviewer wording is not an Inbox
 * heading. The caller decides whose message it is: only the person's own
 * messages carry a block the window composed.
 */
export function splitInboxSkillsBlock(body: string): InboxSkillsSplit | null {
  const lines = body.split('\n').map((line) => line.replace(/\r$/, ''));
  for (let at = lines.length - 1; at >= 0; at--) {
    const heading = INBOX_HEADING_RE.exec(lines[at]!);
    if (!heading || (at > 0 && lines[at - 1]!.trim() !== '')) continue;
    const skills = readBlockTail(lines, at + 1);
    if (!skills) continue;
    return {
      before: lines.slice(0, at).join('\n').trimEnd(),
      block: lines.slice(at).join('\n').trimEnd(),
      subject: heading[1] as 'reply' | 'message',
      skills,
    };
  }
  return null;
}

/** A person's message without its skills block (the whole body when it has none). */
export function withoutInboxSkillsBlock(body: string): string {
  return splitInboxSkillsBlock(body)?.before ?? body;
}
