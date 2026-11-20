export interface InboxPictureItPage {
  attachment_id: string;
  title: string;
}

export const PICTURE_IT_PAGE_TITLE_MAX = 200;
export const PICTURE_IT_HEAD_MAX = 256 * 1024;

const TAG_MAX = 4096;
const RAW_BLOCKS = ["script", "style", "template"] as const;

const NAME = /(?<![-\w])name\s*=\s*["']?plannotator-page["']?(?=[\s/>])/i;
const CONTENT = /(?<![-\w])content\s*=\s*["']?picture-it["']?(?=[\s/>])/i;

function opens(lower: string, at: number, name: string): boolean {
  if (!lower.startsWith(name, at + 1)) return false;
  const next = lower[at + 1 + name.length];
  return next === undefined || next === ">" || next === "/" || /\s/.test(next);
}

function readHead(html: string): { marked: boolean; title: string | null } {
  const text = html.length > PICTURE_IT_HEAD_MAX ? html.slice(0, PICTURE_IT_HEAD_MAX) : html;
  const lower = text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
  let marked = false;
  let title: string | null = null;
  let at = lower.indexOf("<");
  while (at !== -1) {
    let next = at + 1;
    if (lower.startsWith("<!--", at)) {
      const end = lower.indexOf("-->", at + 4);
      if (end === -1) break;
      next = end + 3;
    } else if (opens(lower, at, "body")) {
      break;
    } else if (opens(lower, at, "meta")) {
      const end = lower.indexOf(">", at);
      if (end !== -1 && end - at <= TAG_MAX) {
        const tag = text.slice(at, end + 1);
        if (NAME.test(tag) && CONTENT.test(tag)) marked = true;
        next = end + 1;
      }
    } else if (opens(lower, at, "title")) {
      const open = lower.indexOf(">", at);
      const close = open === -1 ? -1 : lower.indexOf("</title", open);
      if (close === -1) break;
      if (title === null) title = text.slice(open + 1, close);
      next = close + 7;
    } else {
      const raw = RAW_BLOCKS.find((name) => opens(lower, at, name));
      if (raw) {
        const end = lower.indexOf(`</${raw}`, at);
        if (end === -1) break;
        next = end + raw.length + 2;
      }
    }
    at = lower.indexOf("<", next);
  }
  return { marked, title };
}

export function isPictureItPage(html: string): boolean {
  return readHead(html).marked;
}

export function pictureItPageTitle(html: string): string {
  const line = (readHead(html).title ?? "").slice(0, TAG_MAX).replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length > PICTURE_IT_PAGE_TITLE_MAX ? `${chars.slice(0, PICTURE_IT_PAGE_TITLE_MAX - 1).join("").trimEnd()}…` : line;
}
