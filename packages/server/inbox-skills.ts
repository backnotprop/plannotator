/**
 * The Inbox's skill catalog (approval "inbox-skill-references"): what the
 * composers' `/` and `$` picker lists, and the SKILL.md text of a human-only
 * skill the window pastes into the person's message when they send it
 * (Option B: the window composes the body, as plan review composes its
 * feedback).
 *
 *   GET /api/inbox/skills                 → { skills: [{ name, root, description?, humanOnly, dir }] }
 *   GET /api/inbox/skills/content?name=…  → { skill: { name, dir, path, content, truncated, humanOnly } }
 *   GET /api/inbox/skills/file?name=…     → one skill's SKILL.md for the person to read (inbox-skill-file.ts)
 *
 * The same discovery and the same answers as plan review's `/api/skills` and
 * `/api/skills/content` (`handleReferenceSkills`, `handleReferenceSkillContent`):
 * the global skill folders only (`~/.claude/skills` or `$CLAUDE_CONFIG_DIR`,
 * `$CODEX_HOME/skills`, `~/.agents/skills`, `$XDG_CONFIG_HOME/agents/skills`),
 * read fresh on every request, never a project's; a content name is matched
 * against discovered skills and never used as a path; a body is capped at
 * 20,000 characters.
 *
 * Read routes: the loopback window and the owner over the tailnet, like every
 * other read; another site is refused (`403 cross_origin`), because the
 * answers name folders on this computer. The phone's device door carries both
 * (contract 7.46, 7.47). Agents never use these: MCP has no skills field.
 */
import { INBOX_BUILTIN_SKILL_ROOT, INBOX_REVIEW_SKILLS } from "@plannotator/core/inbox-review";
import { CREATE_ROUTINE_SKILL } from "@plannotator/core/create-routine-skill";
import { PICTURE_IT_SKILL } from "@plannotator/core/picture-it-skill";
import { composeInboxSkillsBlock, inboxBuiltinSkillContent } from "@plannotator/core/inbox-skills-compose";
import { INBOX_MESSAGE_SKILL_AUDIENCE } from "@plannotator/core/skill-reference-block";
import type { SkillCatalogEntry, SkillExportContent } from "@plannotator/core/skill-references-render";
import { listReferenceSkills, readReferenceSkillContent, type ReferenceSkillContent } from "./review-skill-loader";
import { handleReferenceSkillContent } from "./shared-handlers";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest } from "./inbox-cross-site";
import { inboxSkillFile } from "./inbox-skill-file";

export const INBOX_SKILLS_PATH = "/api/inbox/skills";
export const INBOX_SKILL_CONTENT_PATH = "/api/inbox/skills/content";
/** One skill's SKILL.md for the person to read (inbox-skill-file.ts). */
export const INBOX_SKILL_FILE_PATH = "/api/inbox/skills/file";

function noStore(res: Response): Response {
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("X-Content-Type-Options", "nosniff");
  return res;
}

/**
 * The catalog with Plannotator's own review skills first (code review in the
 * Inbox, approval "inbox-code-review-direction"), while the person has Code
 * review on: `root: "plannotator"` (the list's "Plannotator"), human-only so
 * the window pastes their instructions into the reply that names one, and no
 * folder (the window carries their text, `@plannotator/core/inbox-review`).
 * A skill of the person's own with the same name wins: the built-in is left
 * out. Off, the catalog is exactly the discovered skills. `/create-routine` the same way while Routines are on. `/picture-it` always, first.
 */
export function inboxSkillCatalog(codeReview: boolean, discovered: () => ReturnType<typeof listReferenceSkills> = listReferenceSkills, routines = false): Response {
  return Response.json({ skills: inboxSkillEntries(codeReview, discovered, routines) });
}

export function inboxSkillEntries(codeReview: boolean, discovered: () => ReturnType<typeof listReferenceSkills>, routines: boolean): SkillCatalogEntry[] {
  let skills: ReturnType<typeof listReferenceSkills>;
  try {
    skills = discovered();
  } catch {
    skills = [];
  }
  const own = new Set(skills.map((skill) => skill.name));
  // `/create-routine` (packages/core/create-routine-skill.ts) while Routines are on.
  const offered = [PICTURE_IT_SKILL, ...(codeReview ? INBOX_REVIEW_SKILLS : []), ...(routines ? [CREATE_ROUTINE_SKILL] : [])];
  const builtins = offered.filter((skill) => !own.has(skill.name)).map((skill) => ({
    name: skill.name,
    root: INBOX_BUILTIN_SKILL_ROOT as SkillCatalogEntry["root"],
    description: skill.description,
    humanOnly: true,
  }));
  return [...builtins, ...skills];
}

export interface InboxSkillSwitches {
  codeReview: boolean;
  routines: boolean;
  diagrams: boolean;
}

export function inboxSkillsBlockFor(
  names: readonly string[],
  switches: InboxSkillSwitches,
  sources: { discovered: () => ReturnType<typeof listReferenceSkills>; read: (name: string) => ReferenceSkillContent | null } = { discovered: listReferenceSkills, read: readReferenceSkillContent },
): string {
  const catalog = inboxSkillEntries(switches.codeReview, sources.discovered, switches.routines);
  const refs = names.flatMap((name) => catalog.find((entry) => entry.name === name) ?? []);
  const contents = new Map<string, SkillExportContent>();
  for (const ref of refs) {
    if (!ref.humanOnly) continue;
    const read = ref.root === INBOX_BUILTIN_SKILL_ROOT ? inboxBuiltinSkillContent(ref, switches.diagrams) : sources.read(ref.name);
    if (read?.content) contents.set(ref.name, { content: read.content, truncated: read.truncated, dir: read.dir, path: read.path });
  }
  return composeInboxSkillsBlock(refs, contents, INBOX_MESSAGE_SKILL_AUDIENCE);
}

/** The answer for a skills path, or null for any other path. `codeReview`, `routines`, `diagrams`: the person's switches. */
export function inboxSkillsRoute(
  req: Request,
  url: URL,
  options: { codeReview?: boolean; routines?: boolean; diagrams?: boolean; discovered?: () => ReturnType<typeof listReferenceSkills> } = {},
): Response | null {
  if (url.pathname !== INBOX_SKILLS_PATH && url.pathname !== INBOX_SKILL_CONTENT_PATH && url.pathname !== INBOX_SKILL_FILE_PATH) return null;
  if (req.method !== "GET") return noStore(Response.json({ error: "Use GET." }, { status: 405 }));
  if (isCrossSiteRequest(req)) return noStore(Response.json(INBOX_CROSS_SITE_BODY, { status: 403 }));
  if (url.pathname === INBOX_SKILL_FILE_PATH) {
    // Every built-in, whatever the switches say today: its text ships here, and a reply sent while one was on names it.
    const catalog = inboxSkillEntries(true, options.discovered ?? listReferenceSkills, true);
    return noStore(Response.json(inboxSkillFile(url.searchParams.get("name") ?? "", catalog, options.diagrams !== false)));
  }
  return noStore(url.pathname === INBOX_SKILLS_PATH ? inboxSkillCatalog(options.codeReview === true, undefined, options.routines === true) : handleReferenceSkillContent(req));
}
