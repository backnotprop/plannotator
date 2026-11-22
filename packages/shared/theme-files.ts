/**
 * Custom themes in the data dir: `<data dir>/themes/<id>.json`, one theme file
 * each (packages/core/theme-file.ts). Written by `plannotator theme add`, read
 * by every server for the page's `/plannotator-themes.js`, and by the Inbox's
 * settings route to accept a custom id.
 *
 * Every read validates again: a file edited by hand, or written by an older or
 * newer version, is skipped (with its reason for `theme list`) rather than
 * drawn. Removing a theme moves its file to `themes/removed/`, so nothing a
 * person made is lost by a command.
 *
 * Node-bound (fs); vendored into the Pi extension (apps/pi-extension/vendor.sh).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BUILT_IN_THEME_IDS,
  CUSTOM_THEME_LIMIT,
  customThemeInfo,
  THEME_FILE_MAX_BYTES,
  THEME_ID_PATTERN,
  themeFileCss,
  themeSyntaxPayload,
  validateThemeFile,
  type CustomThemeInfo,
  type ThemeFile,
} from "@plannotator/core/theme-file";

/** The folder custom themes live in. */
export function customThemesDir(dataDir: string): string {
  return join(dataDir, "themes");
}

/** A theme file that is in the folder but is not drawn, and why (`theme list` shows it). */
export interface SkippedThemeFile {
  file: string;
  reason: string;
}

/**
 * Each file's last reading, keyed by path and checked against its size and
 * modification time: every page load lists the themes (the page script), and a
 * theme with code colours can run to a few hundred rules, so an unchanged file
 * is not parsed and validated again.
 */
const readings = new Map<string, { size: number; mtimeMs: number; result: { theme: ThemeFile } | { reason: string } }>();

function readThemeFile(path: string, file: string, size: number, mtimeMs: number): { theme: ThemeFile } | { reason: string } {
  const last = readings.get(path);
  if (last && last.size === size && last.mtimeMs === mtimeMs) return last.result;
  let result: { theme: ThemeFile } | { reason: string };
  try {
    const checked = validateThemeFile(JSON.parse(readFileSync(path, "utf8")));
    if (!checked.ok) result = { reason: `${checked.problem.field}: ${checked.problem.message}` };
    else if (`${checked.theme.id}.json` !== file) result = { reason: `its id is "${checked.theme.id}"; the file must be named ${checked.theme.id}.json.` };
    else result = { theme: checked.theme };
  } catch (err) {
    result = { reason: `not readable as JSON (${err instanceof Error ? err.message : String(err)}).` };
  }
  readings.set(path, { size, mtimeMs, result });
  return result;
}

/** The custom themes in the data dir, sorted by name, and the files that were skipped. */
export function listCustomThemes(dataDir: string): { themes: ThemeFile[]; skipped: SkippedThemeFile[] } {
  const dir = customThemesDir(dataDir);
  const themes: ThemeFile[] = [];
  const skipped: SkippedThemeFile[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return { themes, skipped };
  }
  for (const file of names) {
    if (themes.length >= CUSTOM_THEME_LIMIT) {
      skipped.push({ file, reason: `more than ${CUSTOM_THEME_LIMIT} themes; this one is not loaded.` });
      continue;
    }
    const path = join(dir, file);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      if (stat.size > THEME_FILE_MAX_BYTES) {
        skipped.push({ file, reason: `larger than ${THEME_FILE_MAX_BYTES / 1024} KB.` });
        continue;
      }
      const read = readThemeFile(path, file, stat.size, stat.mtimeMs);
      if ("reason" in read) skipped.push({ file, reason: read.reason });
      else themes.push(read.theme);
    } catch (err) {
      skipped.push({ file, reason: `not readable as JSON (${err instanceof Error ? err.message : String(err)}).` });
    }
  }
  themes.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { themes, skipped };
}

/** One custom theme by id, or null (not there, or not valid). */
export function readCustomTheme(dataDir: string, id: string): ThemeFile | null {
  if (!THEME_ID_PATTERN.test(id)) return null;
  return listCustomThemes(dataDir).themes.find((theme) => theme.id === id) ?? null;
}

/** A palette id the page can draw: a built-in, or a custom theme in this data dir. */
export function isRegisteredThemeId(dataDir: string, id: string): boolean {
  if (BUILT_IN_THEME_IDS.includes(id)) return true;
  return readCustomTheme(dataDir, id) !== null;
}

export type SaveCustomThemeResult =
  | { ok: true; replaced: boolean; path: string }
  | { ok: false; code: "too_many" | "not_saved"; message: string };

/** Write a validated theme to `themes/<id>.json` (replacing one with the same id), through a temp file. */
export function saveCustomTheme(dataDir: string, theme: ThemeFile): SaveCustomThemeResult {
  const checked = validateThemeFile(theme);
  if (!checked.ok) return { ok: false, code: "not_saved", message: `${checked.problem.field}: ${checked.problem.message}` };
  const dir = customThemesDir(dataDir);
  const path = join(dir, `${theme.id}.json`);
  const replaced = existsSync(path);
  if (!replaced && listCustomThemes(dataDir).themes.length >= CUSTOM_THEME_LIMIT) {
    return { ok: false, code: "too_many", message: `${CUSTOM_THEME_LIMIT} custom themes is the most; remove one first (plannotator theme remove <id>).` };
  }
  // Indented to be read and edited by hand; compact when that would not fit (a theme with many code colour rules).
  const pretty = `${JSON.stringify(checked.theme, null, 2)}\n`;
  const body = Buffer.byteLength(pretty) <= THEME_FILE_MAX_BYTES ? pretty : `${JSON.stringify(checked.theme)}\n`;
  if (Buffer.byteLength(body) > THEME_FILE_MAX_BYTES) return { ok: false, code: "not_saved", message: `the theme is larger than ${THEME_FILE_MAX_BYTES / 1024} KB.` };
  try {
    mkdirSync(dir, { recursive: true });
    const temp = join(dir, `.${theme.id}.${process.pid}.tmp`);
    writeFileSync(temp, body, { mode: 0o644 });
    renameSync(temp, path);
  } catch (err) {
    return { ok: false, code: "not_saved", message: `could not write ${path} (${err instanceof Error ? err.message : String(err)}).` };
  }
  return { ok: true, replaced, path };
}

/**
 * Move `themes/<id>.json` to `themes/removed/`; the path it went to, or null
 * when there was no such file. Never over an earlier removal (two in the same
 * millisecond take `-2`, ...). Throws when the folder cannot be written (the
 * CLI says so in one line).
 */
export function removeCustomTheme(dataDir: string, id: string, now = Date.now()): string | null {
  if (!THEME_ID_PATTERN.test(id)) return null;
  const dir = customThemesDir(dataDir);
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return null;
  const removedDir = join(dir, "removed");
  mkdirSync(removedDir, { recursive: true });
  let to = join(removedDir, `${id}-${now}.json`);
  for (let n = 2; existsSync(to); n++) to = join(removedDir, `${id}-${now}-${n}.json`);
  renameSync(path, to);
  return to;
}

/** What a page needs to draw the custom themes: the registry entries, and their stylesheet. */
export function customThemesPayload(dataDir: string): { themes: CustomThemeInfo[]; css: string } {
  const themes: CustomThemeInfo[] = [];
  const css: string[] = [];
  for (const theme of listCustomThemes(dataDir).themes) {
    try {
      css.push(themeFileCss(theme));
      themes.push(customThemeInfo(theme));
    } catch {
      // themeFileCss refuses anything that is not a colour; such a theme is left out.
    }
  }
  return { themes, css: css.join("\n") };
}

/** JSON safe inside a script: no `<` (so never `</script>`), no line or paragraph separators. */
function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * The themes script: written into each page's head where the build's
 * `/plannotator-themes.js` tag is (pageWithCustomThemes), so it runs before
 * the app's module script and before the first paint; the route answers it
 * too, for a page held from before. It hands the registry the
 * custom themes (`window.__PLANNOTATOR_CUSTOM_THEMES__`, read by
 * packages/ui/utils/themeRegistry.ts) and adds their stylesheet to the head.
 * With no custom themes it sets an empty list and adds nothing.
 */
export function customThemesScript(dataDir: string): string {
  let payload: { themes: CustomThemeInfo[]; css: string };
  try {
    payload = customThemesPayload(dataDir);
  } catch {
    payload = { themes: [], css: "" };
  }
  return `(function(){var d=${scriptSafeJson(payload)};window.__PLANNOTATOR_CUSTOM_THEMES__=d.themes;if(!d.css)return;var s=document.createElement("style");s.id="plannotator-custom-themes";s.textContent=d.css;(document.head||document.documentElement).appendChild(s)})();\n`;
}

/** The page's tag for the themes script, as the build writes it (`<script vite-ignore src=...>` in each index.html). */
const THEMES_TAG = /<script\b[^>]*\bsrc="\/plannotator-themes\.js"[^>]*><\/script>/;

/** The page as served to a person with no custom theme: the build's page without its themes tag (the release smoke's digests). */
export function pageWithoutCustomThemes(html: string): string {
  return html.replace(THEMES_TAG, "");
}

/** Per page: the page with no themes tag, and the last page made with themes in it (so a body is made once). */
const pages: { html: string; bare: string; last: { script: string; page: string } | null }[] = [];

/**
 * The page as a server sends it: the themes script written into the page at
 * the tag (`<script>…</script>`, the same script `/plannotator-themes.js`
 * answers), or the tag left out when the data dir has no custom themes. So a
 * page load makes no request for themes, and a person with none gets a page
 * with nothing added. The same string comes back while the themes are
 * unchanged, so a compressed body made for it is reused (app-html.ts caches by
 * page). A page without the tag is returned as it is.
 */
export function pageWithCustomThemes(html: string, dataDir: string): string {
  let entry = pages.find((e) => e.html === html);
  if (!entry) {
    if (!THEMES_TAG.test(html)) return html;
    entry = { html, bare: pageWithoutCustomThemes(html), last: null };
    pages.push(entry);
    if (pages.length > 8) pages.shift();
  }
  let script = "";
  try {
    script = listCustomThemes(dataDir).themes.length > 0 ? customThemesScript(dataDir) : "";
  } catch {
    script = "";
  }
  // The script holds no "<" (scriptSafeJson), so nothing in it can end the element; checked again here.
  if (!script || script.includes("<")) return entry.bare;
  if (entry.last?.script !== script) {
    const at = html.search(THEMES_TAG);
    const tag = html.match(THEMES_TAG)![0];
    entry.last = { script, page: `${html.slice(0, at)}<script>${script.trimEnd()}</script>${html.slice(at + tag.length)}` };
  }
  return entry.last.page;
}

/** The route every server answers with customThemesScript (and, with `?syntax=<id>`, customThemeSyntaxJson). */
export const CUSTOM_THEMES_SCRIPT_PATH = "/plannotator-themes.js";

/**
 * One custom theme's code colours as JSON (`themeSyntaxPayload`: per half that
 * has them, its rules and the text and ground they sit on), or null when there
 * is no such theme or it has none. Kept out of the page script, which runs
 * before the first paint on every page: the page asks for it when code first
 * renders in that theme (packages/ui/utils/customSyntaxThemes.ts).
 */
export function customThemeSyntaxJson(dataDir: string, id: string): string | null {
  const theme = readCustomTheme(dataDir, id);
  if (!theme) return null;
  const payload = themeSyntaxPayload(theme);
  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : null;
}

/** The route's answer for a request's query: the page script, or with `?syntax=<id>` that theme's code colours (404 when it has none). */
export function customThemesAnswer(dataDir: string, search: URLSearchParams): { status: number; headers: Record<string, string>; body: string } {
  const id = search.get("syntax");
  if (id === null) return { status: 200, headers: CUSTOM_THEMES_SCRIPT_HEADERS, body: customThemesScript(dataDir) };
  let json: string | null = null;
  try {
    json = THEME_ID_PATTERN.test(id) ? customThemeSyntaxJson(dataDir, id) : null;
  } catch {
    json = null;
  }
  if (json === null) return { status: 404, headers: { ...CUSTOM_THEME_SYNTAX_HEADERS, "Content-Type": "text/plain; charset=utf-8" }, body: "no code colours for that theme" };
  return { status: 200, headers: CUSTOM_THEME_SYNTAX_HEADERS, body: json };
}

/** The headers of that answer: a script, read fresh on every page load (a theme added since shows on reload). */
export const CUSTOM_THEMES_SCRIPT_HEADERS: Record<string, string> = {
  "Content-Type": "text/javascript; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

/** The headers of a theme's code colours: JSON, read fresh like the script. */
export const CUSTOM_THEME_SYNTAX_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
