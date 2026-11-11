/** "New scratch folder" where compose names a folder by its project id: never a project id (`prj_…`). */
export const INBOX_SCRATCH_PICK = "scratch";

const SLUG_MAX = 48;

/** A thread name as a folder name: lowercase ASCII letters, digits and single dashes; "scratch" when nothing is left. */
export function inboxScratchSlug(name: string | null | undefined): string {
  const slug = (name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug || "scratch";
}

/** The `n`th candidate for a slug: the slug itself, then `slug-2`, `slug-3`… */
export function inboxScratchCandidate(slug: string, n: number): string {
  return n <= 1 ? slug : `${slug}-${n}`;
}
