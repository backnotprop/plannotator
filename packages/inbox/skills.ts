/**
 * Skill references in what the person sends (approval "inbox-skill-references",
 * Option B as amended). The composers keep `$write-better` and `/readback` as
 * plain text, exactly as a Plannotator comment does. At Send the window adds
 * ONE "Skills referenced" block at the end of the message, in Plannotator's
 * own words and markers (`renderSkillReferencesBlock`), with "the person"
 * asking about "this reply" or "this message":
 *
 * - a model-invocable skill is named, and the agent invokes it itself;
 * - a human-only skill (`disable-model-invocation: true`) has its SKILL.md
 *   text pasted between BEGIN/END markers, with its folder named so the agent
 *   reads the reference files beside it, because a person referencing it IS
 *   the invocation the agent cannot make.
 *
 * The block covers the words and every comment on an attached file the Send
 * carries (the per-comment export is off in the Inbox: `skillReferenceExport:
 * false` in App.tsx), so a skill is listed, and its instructions pasted, once
 * per message. Only the person's own Send composes it; an agent's message is
 * never given one (MCP has no such field, and the window folds a block only
 * under the person's own messages).
 *
 * Bounds: a body is capped at 20,000 characters by the server (and marked
 * truncated with its path); a message pastes at most 40,000 characters of
 * instructions, and a human-only skill past that is named with its folder
 * instead ("read SKILL.md in …"), the export's fallback wording.
 */
import { INBOX_MESSAGE_SKILL_AUDIENCE, INBOX_REPLY_SKILL_AUDIENCE, type SkillBlockAudience } from '@plannotator/core/skill-reference-block';
import type { InboxAnnotationRecord } from '@plannotator/core/inbox-types';
import { fetchSkillCatalog, normalizeSkillContent } from '@plannotator/ui/utils/skillCatalog';
import {
  extractSkillReferences,
  renderSkillReferencesBlock,
  type SkillCatalogEntry,
  type SkillExportContent,
} from '@plannotator/ui/utils/skillReferences';
import { inboxApi } from './api';
import { annotationOf } from './attachments';

export { INBOX_MESSAGE_SKILL_AUDIENCE, INBOX_REPLY_SKILL_AUDIENCE };

/** The most SKILL.md text one message pastes, over all its human-only skills. */
export const INBOX_SKILL_INSTRUCTIONS_BUDGET = 40_000;

/** Every skill the texts reference, in first-appearance order across them, once each. */
export function inboxSkillReferences(texts: readonly string[], catalog: readonly SkillCatalogEntry[]): SkillCatalogEntry[] {
  const seen = new Set<string>();
  const refs: SkillCatalogEntry[] = [];
  for (const text of texts) {
    for (const ref of extractSkillReferences(text, [...catalog])) {
      if (seen.has(ref.name)) continue;
      seen.add(ref.name);
      refs.push(ref);
    }
  }
  return refs;
}

/**
 * The block for these references (pure): `contents` holds the SKILL.md of
 * the human-only ones that could be read. '' with no references.
 */
export function composeInboxSkillsBlock(
  refs: readonly SkillCatalogEntry[],
  contents: ReadonlyMap<string, SkillExportContent>,
  audience: SkillBlockAudience,
  budget = INBOX_SKILL_INSTRUCTIONS_BUDGET,
): string {
  if (refs.length === 0) return '';
  // In reference order, while the budget lasts; a skill past it is named with its folder.
  const pasted = new Map<string, SkillExportContent>();
  let spent = 0;
  for (const ref of refs) {
    const content = ref.humanOnly ? contents.get(ref.name) : undefined;
    if (!content || spent + content.content.length > budget) continue;
    pasted.set(ref.name, content);
    spent += content.content.length;
  }
  return renderSkillReferencesBlock(refs, { contentOf: (name) => pasted.get(name), audience }).trimEnd();
}

/** What `inboxSkillsBlock` reads; the window's own routes by default, a test's stand-ins otherwise. */
export interface InboxSkillSources {
  catalog: () => Promise<SkillCatalogEntry[]>;
  content: (name: string) => Promise<SkillExportContent | undefined>;
}

const windowSources: InboxSkillSources = {
  catalog: fetchSkillCatalog,
  content: async (name) => {
    try {
      return normalizeSkillContent((await inboxApi.skillContent(name)).skill) ?? undefined;
    } catch {
      // Unreadable now: the skill is named with its folder instead.
      return undefined;
    }
  },
};

/**
 * The block a Send adds for the skills its texts reference, '' for none.
 * Reads each referenced human-only skill's SKILL.md now, so the message
 * carries what the skill said when it was sent. Never throws: no catalog, or
 * a body that cannot be read, gives the name-only lines.
 */
export async function inboxSkillsBlock(
  texts: readonly string[],
  audience: SkillBlockAudience,
  sources: InboxSkillSources = windowSources,
): Promise<string> {
  const written = texts.filter((t) => t.trim() !== '');
  if (written.length === 0) return '';
  let catalog: SkillCatalogEntry[];
  try {
    catalog = await sources.catalog();
  } catch {
    return '';
  }
  const refs = inboxSkillReferences(written, catalog);
  if (refs.length === 0) return '';
  const contents = new Map<string, SkillExportContent>();
  await Promise.all(
    refs
      .filter((ref) => ref.humanOnly)
      .map(async (ref) => {
        const content = await sources.content(ref.name).catch(() => undefined);
        if (content) contents.set(ref.name, content);
      }),
  );
  return composeInboxSkillsBlock(refs, contents, audience);
}

/** The comments on attached files a Send carries, as the texts their skill references are read from (a guided review's diff comments take none). */
export function annotationSkillTexts(records: readonly InboxAnnotationRecord[]): string[] {
  return records.filter((record) => !record.guide).map((record) => annotationOf(record).text ?? '');
}

/** A body and the block, one blank line apart ('' parts dropped). */
export function withSkillsBlock(text: string, block: string): string {
  return [text.trim(), block].filter((part) => part !== '').join('\n\n');
}
