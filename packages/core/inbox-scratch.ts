export const INBOX_SCRATCH_PICK = "scratch";

const SLUG_MAX = 48;

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

export function inboxScratchCandidate(slug: string, n: number): string {
  return n <= 1 ? slug : `${slug}-${n}`;
}
