/**
 * A linked machine's own skills, read through its door (`/api/inbox/m/<machine>/skills` and `skills/content`, the
 * routes the reply box reads here). A skill emoji is one set on every linked machine, so it can name a skill that is
 * only on the machine whose thread it is pressed in: its block is composed from that machine's skill, and the text
 * travels in the reply's feedback as a typed `/skill` reply's does.
 */
import { normalizeSkillContent } from '@plannotator/ui/utils/skillCatalog';
import type { SkillCatalogEntry } from '@plannotator/ui/utils/skillReferences';
import { get } from '../api';
import { inboxUrl } from '../inboxUrl';
import type { InboxSkillSources } from '../skills';

const ROOTS = new Set(['claude', 'codex', 'universal', 'plannotator']);

function entryOf(raw: unknown): SkillCatalogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const { name, root, description, humanOnly, dir } = raw as Record<string, unknown>;
  if (typeof name !== 'string' || !name) return null;
  return {
    name,
    root: typeof root === 'string' && ROOTS.has(root) ? (root as SkillCatalogEntry['root']) : 'universal',
    ...(typeof description === 'string' && description ? { description } : {}),
    humanOnly: humanOnly === true,
    ...(typeof dir === 'string' && dir ? { dir } : {}),
  };
}

export function machineSkillSources(machine: string): InboxSkillSources {
  return {
    catalog: async () => {
      const answer = await get<{ skills?: unknown }>(inboxUrl('/skills', undefined, machine));
      return Array.isArray(answer.skills) ? answer.skills.map(entryOf).filter((entry): entry is SkillCatalogEntry => entry !== null) : [];
    },
    content: async (name) => {
      try {
        return normalizeSkillContent((await get<{ skill?: unknown }>(inboxUrl(`/skills/content?name=${encodeURIComponent(name)}`, undefined, machine))).skill) ?? undefined;
      } catch {
        return undefined;
      }
    },
  };
}
