/**
 * What a skill emoji's card shows (approval "inbox-reactions-every-message", item 7): the skill's description and the
 * first words of its instructions, read from this window's own skills (the catalog the reply box lists, and a
 * built-in's text from the window), once per skill. Read only when a card opens; null while unknown.
 */
import { fetchSkillCatalog, normalizeSkillContent } from '@plannotator/ui/utils/skillCatalog';
import { inboxApi } from '../api';
import { builtinSkillContent } from '../skills';

export interface SkillPreviewText {
  description: string;
  excerpt: string;
  /** One of Plannotator's own skills (root `plannotator`), not the person's. */
  builtin: boolean;
  /** Not in this computer's skills now. */
  missing: boolean;
}

const known = new Map<string, Promise<SkillPreviewText>>();

/** The first lines of a SKILL.md worth reading: no frontmatter, no headings, at most about 220 characters. */
export function skillExcerpt(content: string): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && !line.startsWith('```'));
  const text = lines.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text;
}

export function skillPreviewText(name: string): Promise<SkillPreviewText> {
  const had = known.get(name);
  if (had) return had;
  const read = (async (): Promise<SkillPreviewText> => {
    const entry = (await fetchSkillCatalog().catch(() => [])).find((e) => e.name === name);
    if (!entry) return { description: '', excerpt: '', builtin: false, missing: true };
    const builtin = entry.root === 'plannotator';
    let content = builtinSkillContent(entry)?.content;
    if (!content && !builtin) {
      try {
        content = normalizeSkillContent((await inboxApi.skillContent(name)).skill)?.content;
      } catch {
        // Unreadable now: the card shows the description alone.
      }
    }
    return { description: entry.description ?? '', excerpt: content ? skillExcerpt(content) : '', builtin, missing: false };
  })();
  known.set(name, read);
  // A failed or missing read is tried again next time.
  void read.then((text) => text.missing && known.delete(name));
  return read;
}
