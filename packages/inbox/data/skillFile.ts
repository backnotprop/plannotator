/**
 * One skill's SKILL.md for the person to read (`GET /api/inbox/skills/file`, packages/server/inbox-skill-file.ts),
 * always from this computer's own Inbox: the skill a reply used was resolved where the person typed it. A thread on a
 * linked machine whose skill is not here reads that machine's own skill text instead (its `skills/content`, the
 * route its reply box pastes from: the instructions without their frontmatter).
 */
import { normalizeSkillContent } from '@plannotator/ui/utils/skillCatalog';
import { get } from '../api';
import { inboxUrl } from '../inboxUrl';

export type SkillFileView =
  | { found: false }
  | { found: true; name: string; source: 'plannotator' | 'own'; text: string | null; tooLarge: boolean; machine: string | null };

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

/** `machine`: the thread's linked machine, read only when this computer has no such skill. Never throws. */
export async function readSkillFile(name: string, machine: string | null): Promise<SkillFileView> {
  let here: SkillFileView = { found: false };
  try {
    here = viewOf(await get<unknown>(inboxUrl(`/skills/file?name=${encodeURIComponent(name)}`)));
  } catch {
    // Unreadable here: as if missing, so the machine's copy is tried.
  }
  if (here.found || !machine) return here;
  try {
    const there = normalizeSkillContent((await get<{ skill?: unknown }>(inboxUrl(`/skills/content?name=${encodeURIComponent(name)}`, undefined, machine))).skill);
    if (there?.content) return { found: true, name, source: 'own', text: there.content, tooLarge: false, machine };
  } catch {
    // Not there either.
  }
  return { found: false };
}
