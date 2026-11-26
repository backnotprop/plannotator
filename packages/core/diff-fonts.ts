/**
 * The Code Font menu's web fonts (Settings → Reviews → Code Font): the stylesheet each one loads when it is picked
 * (`loadDiffFont`, packages/ui/utils/diffFonts.ts), and the places those stylesheets and their font files come from.
 *
 * The Inbox window's CSP (packages/server/inbox.ts `WINDOW_CSP`) allows exactly `DIFF_FONT_SOURCES`, so a font added
 * here from another place fails packages/server/inbox-code-fonts.test.ts until the sources say where it comes from.
 */

/** Google Fonts: its `css2` stylesheets live here; the font files they name live on `fonts.gstatic.com`. */
const GOOGLE_FONTS_STYLESHEETS = "https://fonts.googleapis.com";
const GOOGLE_FONTS_FILES = "https://fonts.gstatic.com";

/**
 * Hack on jsDelivr: `hack.css` and the files it names (`fonts/hack-*.woff2` and `.woff`, relative to the
 * stylesheet), all under this one folder. jsDelivr answers `hack-font@3` itself (no redirect), so the path holds.
 */
const HACK_FOLDER = "https://cdn.jsdelivr.net/npm/hack-font@3/build/web/";

export const DIFF_FONT_URLS: Readonly<Record<string, string>> = {
  "Red Hat Mono": `${GOOGLE_FONTS_STYLESHEETS}/css2?family=Red+Hat+Mono:wght@300..700&display=swap`,
  "Fira Code": `${GOOGLE_FONTS_STYLESHEETS}/css2?family=Fira+Code:wght@300..700&display=swap`,
  "Atkinson Hyperlegible Mono": `${GOOGLE_FONTS_STYLESHEETS}/css2?family=Atkinson+Hyperlegible+Mono:wght@200..700&display=swap`,
  "Source Code Pro": `${GOOGLE_FONTS_STYLESHEETS}/css2?family=Source+Code+Pro:wght@300..700&display=swap`,
  "JetBrains Mono": `${GOOGLE_FONTS_STYLESHEETS}/css2?family=JetBrains+Mono:wght@300..700&display=swap`,
  "IBM Plex Mono": `${GOOGLE_FONTS_STYLESHEETS}/css2?family=IBM+Plex+Mono:wght@300..700&display=swap`,
  "Inconsolata": `${GOOGLE_FONTS_STYLESHEETS}/css2?family=Inconsolata:wght@300..700&display=swap`,
  "Roboto Mono": `${GOOGLE_FONTS_STYLESHEETS}/css2?family=Roboto+Mono:wght@300..700&display=swap`,
  "Hack": `${HACK_FOLDER}hack.css`,
};

/** Where the menu's stylesheets (`style-src`) and their font files (`font-src`) come from, and nothing else. */
export const DIFF_FONT_SOURCES = {
  stylesheets: [GOOGLE_FONTS_STYLESHEETS, HACK_FOLDER],
  files: [GOOGLE_FONTS_FILES, HACK_FOLDER],
} as const;
