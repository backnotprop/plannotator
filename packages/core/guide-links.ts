export type GuideLinkScheme = "code" | "symbol" | "chapter";

export const GUIDE_LINK_SCHEMES: readonly GuideLinkScheme[] = ["code", "symbol", "chapter"];

export type GuideLink =
  | { readonly kind: "code"; readonly href: string; readonly path: string; readonly startLine?: number; readonly endLine?: number }
  | { readonly kind: "symbol"; readonly href: string; readonly name: string; readonly path?: string }
  | { readonly kind: "chapter"; readonly href: string; readonly chapter: number };

export type GuideLinkParse =
  | { readonly ok: true; readonly link: GuideLink }
  | { readonly ok: false; readonly href: string; readonly error: string };

export function isGuideLinkHref(href: string): boolean {
  return /^(?:code|symbol|chapter):/i.test(href.trim());
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function pathProblem(path: string): string | null {
  if (path.length === 0) return "it names no file";
  if (path.includes("\\")) return "use / between folders, not \\";
  if (CONTROL_CHARACTER.test(path)) return "the path has a control character";
  if (path.startsWith("/")) return "use the repo-relative path, without a leading /";
  if (path.startsWith("./")) return "use the repo-relative path, without a leading ./";
  if (path.split("/").some((segment) => segment === "..")) return "the path may not contain ..";
  return null;
}

export function parseGuideLink(rawHref: string): GuideLinkParse | null {
  const href = rawHref.trim();
  const scheme = /^(code|symbol|chapter):/i.exec(href);
  if (!scheme) return null;
  const kind = scheme[1].toLowerCase() as GuideLinkScheme;
  const rest = href.slice(scheme[0].length);
  const bad = (error: string): GuideLinkParse => ({ ok: false, href, error: `\`${href}\`: ${error}` });

  if (kind === "chapter") {
    if (!/^\d+$/.test(rest)) return bad("write the chapter's number in reading order, like `chapter:2`");
    const chapter = Number(rest);
    if (chapter < 1) return bad("chapters are numbered from 1");
    return { ok: true, link: { kind, href, chapter } };
  }

  if (kind === "code") {
    const hash = rest.indexOf("#");
    const rawPath = hash >= 0 ? rest.slice(0, hash) : rest;
    if (/\s/.test(rawPath)) return bad("write spaces in a path as %20");
    const path = decode(rawPath);
    const problem = pathProblem(path);
    if (problem) return bad(problem);
    if (hash < 0) return { ok: true, link: { kind, href, path } };
    const fragment = rest.slice(hash + 1);
    const lines = /^L(\d+)(?:-L?(\d+))?$/.exec(fragment);
    if (!lines) return bad("the line goes after # as `#L24` or `#L24-L40`");
    const startLine = Number(lines[1]);
    const endLine = lines[2] !== undefined ? Number(lines[2]) : undefined;
    if (startLine < 1) return bad("lines are numbered from 1");
    if (endLine !== undefined && endLine < startLine) return bad("the range ends before it starts");
    return {
      ok: true,
      link: endLine !== undefined && endLine !== startLine ? { kind, href, path, startLine, endLine } : { kind, href, path, startLine },
    };
  }

  const hash = rest.lastIndexOf("#");
  const name = decode(hash >= 0 ? rest.slice(hash + 1) : rest).trim();
  const path = hash >= 0 ? decode(rest.slice(0, hash)) : undefined;
  if (name.length === 0) return bad("it names no symbol");
  if (CONTROL_CHARACTER.test(name)) return bad("the symbol name has a control character");
  if (/\s/.test(name)) return bad("a symbol name has no spaces");
  if (path !== undefined) {
    const problem = pathProblem(path);
    if (problem) return bad(problem);
    return { ok: true, link: { kind, href, name, path } };
  }
  return { ok: true, link: { kind, href, name } };
}

export type GuideLinkSource = "markdown" | "mermaid" | "html";

export interface GuideLinkOccurrence {
  readonly href: string;
  readonly label?: string;
}

export const GUIDE_LINK_TARGET_SOURCE = String.raw`(?:code|symbol|chapter):(?:[^()\s]|\([^()\s]*\))*`;

const MARKDOWN_LINK = new RegExp(String.raw`\[([^\]\n]*)\]\(\s*(${GUIDE_LINK_TARGET_SOURCE})\s*\)`, "gi");
const MERMAID_CLICK = /^\s*click\s+\S+\s+(?:href\s+)?(?:"([^"]*)"|'([^']*)')/gim;
const HTML_HREF = /\b(?:href|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;

export function findGuideLinks(text: string, source: GuideLinkSource): GuideLinkOccurrence[] {
  const out: GuideLinkOccurrence[] = [];
  if (source === "markdown") {
    for (const m of text.matchAll(MARKDOWN_LINK)) out.push({ href: m[2], label: m[1] });
  } else if (source === "mermaid") {
    for (const m of text.matchAll(MERMAID_CLICK)) {
      const href = m[1] ?? m[2] ?? "";
      if (isGuideLinkHref(href)) out.push({ href });
    }
  } else {
    for (const m of text.matchAll(HTML_HREF)) {
      const href = m[1] ?? m[2] ?? m[3] ?? "";
      if (isGuideLinkHref(href)) out.push({ href });
    }
  }
  return out;
}
