import TurndownService from "turndown";
// @ts-expect-error — @joplin/turndown-plugin-gfm ships JS only, no .d.ts (see declarations.d.ts for local types)
import { gfm } from "@joplin/turndown-plugin-gfm";

const td = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

td.use(gfm);

// Turndown keeps unrecognised tags, and style/script text can leak through.
td.remove(["style", "script", "noscript"]);

export function htmlToMarkdown(html: string): string {
  return td.turndown(html);
}
