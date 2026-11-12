import { findGuideLinks, parseGuideLink, type GuideLink, type GuideSymbolResolution } from "../core/adapter";
import type { McpToolDefinition } from "../mcp/protocol";

export const SHOW_ANSWER_TOOL_NAME = "show_answer";
export const MAX_ANSWER_HTML_BYTES = 128 * 1024;
export const MAX_ANSWER_TITLE_CHARS = 160;

export const ANSWER_GUIDE = [
  "Show your answer to the reviewer as one HTML page. It opens in a tab beside the diff they are reading.",
  "Answer the question first, in plain words, in the first sentence or two. Then explain, briefly. Keep it short: a few paragraphs.",
  "Draw only when a picture explains more than text (before and after, a flow, a timeline): inline <svg>, or a Mermaid diagram as <pre class=\"mermaid\">…</pre>, which the extension draws.",
  "Link to code with <a href=\"code:path/to/file.ts#L12-L20\">, to a symbol with <a href=\"symbol:name\"> (or symbol:path#name), to a chapter with <a href=\"chapter:2\">; a drawn box can be such a link too (data-link=\"code:…\" on any element). Paths are repo-relative. Every link must resolve: the tool tells you which do not.",
  "Inline <style> and <script> are fine; nothing loads from the network (no CDN, no fetch, no external images; images only as data: URLs).",
  "Use the page's color variables so it reads in light and dark themes: --foreground, --muted, --background, --card, --border, --accent, --add, --del, --chart-1 to --chart-6, and the fonts --font and --mono.",
  "Call show_answer once with the whole page (call it again to replace it if the tool refuses it), then end your turn. Do not edit any file.",
].join("\n");

export const SHOW_ANSWER_TOOL: McpToolDefinition = {
  name: SHOW_ANSWER_TOOL_NAME,
  title: "Show the answer",
  description: ANSWER_GUIDE,
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "One line that answers the question (shown above the page)." },
      html: { type: "string", description: "The answer page: an HTML fragment or a whole document. Inline CSS, SVG and scripts allowed; nothing from the network." },
    },
    required: ["title", "html"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export interface AnswerLinkHooks {
  chapterCount: number;
  fileExists(path: string): Promise<boolean>;
  resolveSymbol?(name: string, path: string | undefined): Promise<GuideSymbolResolution>;
}

export type ShowAnswerCheck =
  | { ok: true; title: string; html: string; links: number; text: string }
  | { ok: false; text: string };

const DATA_LINK = /\bdata-link\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const MERMAID_BLOCK = /<(pre|div)\b[^>]*\bclass\s*=\s*["'][^"']*\bmermaid\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi;

function decodeEntities(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function answerLinks(html: string): string[] {
  const out: string[] = [];
  for (const o of findGuideLinks(html, "html")) out.push(decodeEntities(o.href));
  for (const m of html.matchAll(DATA_LINK)) out.push(decodeEntities(m[1] ?? m[2] ?? ""));
  for (const m of html.matchAll(MERMAID_BLOCK)) for (const o of findGuideLinks(decodeEntities(m[2]), "mermaid")) out.push(o.href);
  return [...new Set(out.map((h) => h.trim()).filter((h) => /^(code|symbol|chapter):/i.test(h)))];
}

export async function checkShowAnswer(args: unknown, hooks: AnswerLinkHooks): Promise<ShowAnswerCheck> {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const problems: string[] = [];
  const title = typeof a.title === "string" ? a.title.replace(/\s+/g, " ").trim() : "";
  const html = typeof a.html === "string" ? a.html : "";
  if (!title) problems.push("title is missing: give one line that answers the question.");
  else if (title.length > MAX_ANSWER_TITLE_CHARS) problems.push(`title is ${title.length} characters; keep it under ${MAX_ANSWER_TITLE_CHARS}.`);
  if (!html.trim()) problems.push("html is missing: pass the whole answer page.");
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_ANSWER_HTML_BYTES) problems.push(`html is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_ANSWER_HTML_BYTES / 1024} KB. Shorten it (fewer words, a simpler drawing).`);
  const links = html ? answerLinks(html) : [];
  for (const href of links) {
    const problem = await linkProblem(href, hooks);
    if (problem) problems.push(problem);
  }
  if (problems.length) {
    return { ok: false, text: `The answer was not shown. Fix these and call show_answer again:\n${problems.map((p) => `- ${p}`).join("\n")}` };
  }
  const linkNote = links.length ? ` Its ${links.length} ${links.length === 1 ? "link resolves" : "links resolve"}.` : "";
  return { ok: true, title, html, links: links.length, text: `Shown to the reviewer.${linkNote} End your turn now.` };
}

async function linkProblem(href: string, hooks: AnswerLinkHooks): Promise<string | null> {
  const parsed = parseGuideLink(href);
  if (!parsed) return null;
  if (!parsed.ok) return parsed.error;
  const problem = await resolvedProblem(parsed.link, hooks);
  return problem ? `${href}: ${problem}` : null;
}

async function resolvedProblem(link: GuideLink, hooks: AnswerLinkHooks): Promise<string | null> {
  if (link.kind === "chapter") {
    return link.chapter >= 1 && link.chapter <= hooks.chapterCount ? null : `the guide has ${hooks.chapterCount} ${hooks.chapterCount === 1 ? "chapter" : "chapters"}.`;
  }
  if (link.kind === "code") return (await hooks.fileExists(link.path)) ? null : "no such file at the head (use the repo-relative path).";
  if (link.path && !(await hooks.fileExists(link.path))) return "no such file at the head (use the repo-relative path).";
  if (!hooks.resolveSymbol) return null;
  const r = await hooks.resolveSymbol(link.name, link.path);
  return r.status === "missing" ? "no such symbol found; link the code with code:path#Lnn instead." : null;
}
