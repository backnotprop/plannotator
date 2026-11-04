/**
 * The Inbox's skill catalog (approval "inbox-skill-references"): what the
 * composers' `/` and `$` picker lists, and the SKILL.md text of a human-only
 * skill the window pastes into the person's message when they send it
 * (Option B: the window composes the body, as plan review composes its
 * feedback).
 *
 *   GET /api/inbox/skills                 → { skills: [{ name, root, description?, humanOnly, dir }] }
 *   GET /api/inbox/skills/content?name=…  → { skill: { name, dir, path, content, truncated, humanOnly } }
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
import { SHAPE_SKILL } from "@plannotator/core/shape-skill";
import { listReferenceSkills } from "./review-skill-loader";
import { handleReferenceSkillContent, handleReferenceSkills } from "./shared-handlers";
import { INBOX_CROSS_SITE_BODY, isCrossSiteRequest } from "./inbox-cross-site";

export const INBOX_SKILLS_PATH = "/api/inbox/skills";
export const INBOX_SKILL_CONTENT_PATH = "/api/inbox/skills/content";

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
 * out. Off, the catalog is exactly the discovered skills.
 */
export function inboxSkillCatalog(codeReview: boolean, discovered: () => ReturnType<typeof listReferenceSkills> = listReferenceSkills, shape = false): Response {
  if (!codeReview && !shape) return handleReferenceSkills();
  let skills: ReturnType<typeof listReferenceSkills>;
  try {
    skills = discovered();
  } catch {
    skills = [];
  }
  const own = new Set(skills.map((skill) => skill.name));
  // Shape's `/shape` (approval "shape-living-board") while Shape is on, beside the review skills while Code review is.
  const offered = [...(codeReview ? INBOX_REVIEW_SKILLS : []), ...(shape ? [SHAPE_SKILL] : [])];
  const builtins = offered.filter((skill) => !own.has(skill.name)).map((skill) => ({
    name: skill.name,
    root: INBOX_BUILTIN_SKILL_ROOT,
    description: skill.description,
    humanOnly: true,
  }));
  return Response.json({ skills: [...builtins, ...skills] });
}

/** The answer for a skills path, or null for any other path. `codeReview`: the person's Code review switch. */
export function inboxSkillsRoute(req: Request, url: URL, options: { codeReview?: boolean; shape?: boolean } = {}): Response | null {
  if (url.pathname !== INBOX_SKILLS_PATH && url.pathname !== INBOX_SKILL_CONTENT_PATH) return null;
  if (req.method !== "GET") return noStore(Response.json({ error: "Use GET." }, { status: 405 }));
  if (isCrossSiteRequest(req)) return noStore(Response.json(INBOX_CROSS_SITE_BODY, { status: 403 }));
  return noStore(url.pathname === INBOX_SKILLS_PATH ? inboxSkillCatalog(options.codeReview === true, undefined, options.shape === true) : handleReferenceSkillContent(req));
}
