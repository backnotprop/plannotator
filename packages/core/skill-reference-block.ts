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
 * The skills block at the END of a person's Inbox message, or null.
 *
 * The block is the last thing the window composes, so it runs from the
 * first line that is exactly the Inbox heading, standing at the start of the
 * body or after a blank line and followed by at least one list line, to the
 * end. The first, not the last: a pasted SKILL.md may quote the heading, and
 * the person's own words before the block never hold it by accident. Anything
 * else (an agent's message, a heading quoted mid-text, Plannotator's reviewer
 * wording) is null and the body reads whole. The caller decides whose message
 * it is: only the person's own messages carry a block the window composed.
 */
export function splitInboxSkillsBlock(body: string): InboxSkillsSplit | null {
  const lines = body.split('\n');
  for (let at = 0; at < lines.length; at++) {
    const heading = INBOX_HEADING_RE.exec(lines[at]!.replace(/\r$/, ''));
    if (!heading) continue;
    if (at > 0 && lines[at - 1]!.trim() !== '') continue;
    const skills: InboxSkillReference[] = [];
    let i = at + 1;
    for (; i < lines.length; i++) {
      const match = LIST_LINE_RE.exec(lines[i]!.replace(/\r$/, ''));
      if (!match) break;
      skills.push({ name: match[1]!, included: match[2]!.includes('its instructions are included below'), bytes: 0 });
    }
    if (skills.length === 0) continue;
    // Size each instructions section the list says is included.
    const byName = new Map(skills.map((s) => [s.name, s]));
    let open: { name: string; start: number } | null = null;
    for (; i < lines.length; i++) {
      const line = lines[i]!.replace(/\r$/, '');
      if (!open) {
        const begin = BEGIN_RE.exec(line);
        if (begin) open = { name: begin[1]!, start: i };
        continue;
      }
      const end = END_RE.exec(line);
      if (end && end[1] === open.name) {
        const skill = byName.get(open.name);
        if (skill?.included) skill.bytes += utf8Bytes(lines.slice(open.start, i + 1).join('\n'));
        open = null;
      }
    }
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
