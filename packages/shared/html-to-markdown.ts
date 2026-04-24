/**
 * HTML-to-Markdown conversion via Turndown.
 *
 * Shared between the CLI (single HTML file / URL) and the server
 * (on-demand conversion for HTML files in folder mode).
 */

import TurndownService from "turndown";
// @ts-expect-error — @joplin/turndown-plugin-gfm ships JS only, no .d.ts (see declarations.d.ts for local types)
import { gfm } from "@joplin/turndown-plugin-gfm";

const td = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

td.use(gfm);

// Strip <style> and <script> tags entirely (Turndown keeps unrecognised
// tags as blank by default, but their text content can leak through).
td.remove(["style", "script", "noscript"]);

/**
 * Convert an HTML string to Markdown.
 *
 * Uses a module-level TurndownService singleton (stateless, safe to reuse).
 * GFM tables, strikethrough, and task lists are supported via turndown-plugin-gfm.
 */
export function htmlToMarkdown(html: string): string {
  return td.turndown(html);
}
