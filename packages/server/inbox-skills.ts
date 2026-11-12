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

export function inboxSkillCatalog(codeReview: boolean, discovered: () => ReturnType<typeof listReferenceSkills> = listReferenceSkills, shape = false): Response {
  if (!codeReview && !shape) return handleReferenceSkills();
  let skills: ReturnType<typeof listReferenceSkills>;
  try {
    skills = discovered();
  } catch {
    skills = [];
  }
  const own = new Set(skills.map((skill) => skill.name));
  const offered = [...(codeReview ? INBOX_REVIEW_SKILLS : []), ...(shape ? [SHAPE_SKILL] : [])];
  const builtins = offered.filter((skill) => !own.has(skill.name)).map((skill) => ({
    name: skill.name,
    root: INBOX_BUILTIN_SKILL_ROOT,
    description: skill.description,
    humanOnly: true,
  }));
  return Response.json({ skills: [...builtins, ...skills] });
}

export function inboxSkillsRoute(req: Request, url: URL, options: { codeReview?: boolean; shape?: boolean } = {}): Response | null {
  if (url.pathname !== INBOX_SKILLS_PATH && url.pathname !== INBOX_SKILL_CONTENT_PATH) return null;
  if (req.method !== "GET") return noStore(Response.json({ error: "Use GET." }, { status: 405 }));
  if (isCrossSiteRequest(req)) return noStore(Response.json(INBOX_CROSS_SITE_BODY, { status: 403 }));
  return noStore(url.pathname === INBOX_SKILLS_PATH ? inboxSkillCatalog(options.codeReview === true, undefined, options.shape === true) : handleReferenceSkillContent(req));
}
