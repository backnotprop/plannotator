export interface SkillBlockAudience {
  readonly requester: string;
  readonly subject: string;
}

export const REVIEWER_SKILL_AUDIENCE: SkillBlockAudience = { requester: 'reviewer', subject: 'feedback' };
export const INBOX_REPLY_SKILL_AUDIENCE: SkillBlockAudience = { requester: 'person', subject: 'reply' };
export const INBOX_MESSAGE_SKILL_AUDIENCE: SkillBlockAudience = { requester: 'person', subject: 'message' };

export function skillsReferencedHeading(audience: SkillBlockAudience): string {
  return `**Skills referenced** (the ${audience.requester} is asking you to invoke these skills when acting on this ${audience.subject}):`;
}

export function skillInstructionsIncludedNote(audience: SkillBlockAudience): string {
  return `its instructions are included below at the ${audience.requester}'s request`;
}

const INBOX_HEADING_RE = /^\*\*Skills referenced\*\* \(the person is asking you to invoke these skills when acting on this (reply|message)\):$/;
const LIST_LINE_RE = /^- `([^`\n]+)`(.*)$/;
const BEGIN_RE = /^--- BEGIN SKILL INSTRUCTIONS: (.+) ---$/;
const END_RE = /^--- END SKILL INSTRUCTIONS: (.+) ---$/;
const NOTE_BEGIN_RE = /^--- BEGIN PLANNOTATOR NOTE: (.+) ---$/;
const NOTE_END_RE = /^--- END PLANNOTATOR NOTE: (.+) ---$/;

export function inboxSkillNoteSection(name: string, text: string): string {
  return `--- BEGIN PLANNOTATOR NOTE: ${name} ---\n${text}\n--- END PLANNOTATOR NOTE: ${name} ---`;
}

export interface InboxSkillReference {
  name: string;
  humanOnly: boolean;
  included: boolean;
  bytes: number;
}

export interface InboxSkillsSplit {
  before: string;
  block: string;
  subject: 'reply' | 'message';
  skills: InboxSkillReference[];
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

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
  const noted = new Set<string>();
  let open: { name: string; start: number; note: boolean } | null = null;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (open) {
      const end = (open.note ? NOTE_END_RE : END_RE).exec(line);
      if (end && end[1] === open.name) {
        if (!open.note) byName.get(open.name)!.bytes = utf8Bytes(lines.slice(open.start, i + 1).join('\n'));
        open = null;
      }
      continue;
    }
    if (line.trim() === '') continue;
    const note = NOTE_BEGIN_RE.exec(line);
    if (note && byName.has(note[1]!) && !noted.has(note[1]!)) {
      noted.add(note[1]!);
      open = { name: note[1]!, start: i, note: true };
      continue;
    }
    const begin = BEGIN_RE.exec(line);
    if (!begin || !byName.get(begin[1]!)?.included || seen.has(begin[1]!)) return null;
    seen.add(begin[1]!);
    open = { name: begin[1]!, start: i, note: false };
  }
  return open ? null : skills;
}

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

export function withoutInboxSkillsBlock(body: string): string {
  return splitInboxSkillsBlock(body)?.before ?? body;
}
