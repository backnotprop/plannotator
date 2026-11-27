/**
 * Where the Code Font menu's web fonts come from (Settings → Reviews → Code Font; the menu's table and loader are
 * `DIFF_FONT_URLS` and `loadDiffFont` in packages/ui/utils/diffFonts.ts). The Inbox window's CSP
 * (packages/server/inbox.ts `WINDOW_CSP`) allows exactly these for stylesheets and font files, and
 * packages/server/inbox-code-fonts.test.ts fails when a font in the table is not allowed by them.
 *
 * The table stays in ui and this list here (the server's side): the published @plannotator/ui pins a published core,
 * and a new core module would need a core release first.
 */

/** Hack on jsDelivr: `hack.css` and the files it names (`fonts/hack-*.woff2`, `.woff`, relative to it), all in
 * this one folder. Pinned to 3.3.0, not `@3` (which follows the newest 3.x, so a new publish would change what the
 * window loads); jsDelivr answers this path itself (no redirect), so the path match holds. */
const HACK_FOLDER = "https://cdn.jsdelivr.net/npm/hack-font@3.3.0/build/web/";

export const DIFF_FONT_SOURCES = {
  /** Google Fonts' `css2` stylesheets, and Hack's. */
  stylesheets: ["https://fonts.googleapis.com", HACK_FOLDER],
  /** The files Google's stylesheets name live on `fonts.gstatic.com`; Hack's sit next to its stylesheet. */
  files: ["https://fonts.gstatic.com", HACK_FOLDER],
} as const;
