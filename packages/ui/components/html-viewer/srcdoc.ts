/**
 * Srcdoc injection builder for the HTML viewer.
 *
 * Product rule: arbitrary HTML must render exactly as it would in a plain
 * browser tab. The viewer never writes into the document's namespace — no bare
 * CSS custom properties, no classes on the author's root, no `color-scheme`,
 * no styling of author elements. Host theme tokens are pushed under the
 * viewer-owned `--pn-*` prefix, which the annotation CSS reads.
 *
 * Documents that WANT to follow the host theme (e.g. Plannotator-generated
 * artifacts) opt in with `<meta name="plannotator-theme" content="host">`,
 * which re-enables the bare-token push, the `light` class on their root, and
 * `color-scheme` sync — for that document only.
 *
 * Pure string logic (no DOM) so the rendering-neutrality contract is unit-testable.
 */
import { ANNOTATION_HIGHLIGHT_CSS, BRIDGE_SCRIPT } from "./bridge-script";

export const THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--success",
  "--success-foreground",
  "--warning",
  "--warning-foreground",
  "--border",
  "--input",
  "--ring",
  "--code-bg",
  "--focus-highlight",
  "--font-sans",
  "--font-mono",
  "--radius",
] as const;

/** Viewer-owned namespace for properties injected into the document. */
export const PN_TOKEN_PREFIX = "--pn-";

/**
 * Version-diff highlights. htmlDiff tags the <ins>/<del> it generates with
 * this class so author-written <ins>/<del> markup is never restyled.
 */
export const DIFF_HIGHLIGHT_CSS =
  "ins.plannotator-diff{background:#e6ffec;color:#0a7d33;text-decoration:none;border-radius:2px;box-shadow:0 0 0 1px #abf2bc inset}" +
  "del.plannotator-diff{background:#ffebe9;color:#b31d28;text-decoration:line-through;border-radius:2px;box-shadow:0 0 0 1px #ffc1bc inset}";

/**
 * True when the document opts in to following the host theme via
 * `<meta name="plannotator-theme" content="host">` (attribute order/quoting agnostic).
 */
export function hasHostThemeOptIn(rawHtml: string): boolean {
  const metas = rawHtml.match(/<meta\b[^>]*>/gi);
  if (!metas) return false;
  return metas.some(
    (tag) =>
      /\bname\s*=\s*["']?plannotator-theme["']?/i.test(tag) &&
      /\bcontent\s*=\s*["']?host["']?/i.test(tag),
  );
}

/**
 * Build the theme properties to write into the document. Bare host token names
 * (`--muted`, `--background`, …) collide with author variables, so they are
 * remapped to `--pn-*`; the originals ride along only for host-theme documents.
 */
export function buildThemeTokenPayload(
  tokens: Record<string, string>,
  hostTheme: boolean,
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const [key, val] of Object.entries(tokens)) {
    payload[PN_TOKEN_PREFIX + key.slice(2)] = val;
    if (hostTheme) payload[key] = val;
  }
  return payload;
}

export interface SrcdocInjectionOptions {
  /** Host theme tokens, keyed by bare name (as read from the host root). */
  tokens: Record<string, string>;
  /** Whether the host is currently in its light theme. */
  isLight: boolean;
  /** Document opted in to host theming (see {@link hasHostThemeOptIn}). */
  hostTheme: boolean;
  /** The version-diff view is showing (rawHtml is htmlDiff output). */
  diffActive: boolean;
}

/** The `<style>` + `<script>` block spliced into the document's head. */
export function buildSrcdocInjection({
  tokens,
  isLight,
  hostTheme,
  diffActive,
}: SrcdocInjectionOptions): string {
  const payload = buildThemeTokenPayload(tokens, hostTheme);
  let themeCSS = ":root {\n";
  for (const [key, val] of Object.entries(payload)) {
    themeCSS += `  ${key}: ${val};\n`;
  }
  themeCSS += "}\n";
  // Host-theme documents mirror the host's light/dark; arbitrary documents keep
  // their own color-scheme resolution (document + OS), like a standalone tab.
  if (hostTheme) {
    themeCSS += `:root { color-scheme: ${isLight ? "light" : "dark"}; }\n`;
  }
  const diffCSS = diffActive ? DIFF_HIGHLIGHT_CSS : "";
  return `<style>${themeCSS}${ANNOTATION_HIGHLIGHT_CSS}${diffCSS}</style><script>${BRIDGE_SCRIPT}</script>`;
}

/** Splice the injection just before `</head>`, or prepend when there is none. */
export function injectIntoHead(rawHtml: string, injection: string): string {
  const headClose = rawHtml.indexOf("</head>");
  if (headClose !== -1) {
    return rawHtml.slice(0, headClose) + injection + rawHtml.slice(headClose);
  }
  return injection + rawHtml;
}
