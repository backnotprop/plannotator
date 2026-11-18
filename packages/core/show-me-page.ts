export interface InboxShowMePage {
  attachment_id: string;
  title: string;
}

export const SHOW_ME_PAGE_TITLE_MAX = 200;

const META = /<meta\b[^>]*>/gi;

function isShowMeMeta(tag: string): boolean {
  return /\bname\s*=\s*["']?plannotator-page["']?(?=[\s/>])/i.test(tag) && /\bcontent\s*=\s*["']?show-me["']?(?=[\s/>])/i.test(tag);
}

export function isShowMePage(html: string): boolean {
  const head = html.split(/<body\b/i)[0] ?? "";
  return (head.match(META) ?? []).some(isShowMeMeta);
}

export function showMePageTitle(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const line = (match?.[1] ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length > SHOW_ME_PAGE_TITLE_MAX ? `${chars.slice(0, SHOW_ME_PAGE_TITLE_MAX - 1).join("").trimEnd()}…` : line;
}
