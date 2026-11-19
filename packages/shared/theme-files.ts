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
      const checked = validateThemeFile(JSON.parse(readFileSync(path, "utf8")));
      if (!checked.ok) {
        skipped.push({ file, reason: `${checked.problem.field}: ${checked.problem.message}` });
        continue;
      }
      if (`${checked.theme.id}.json` !== file) {
        skipped.push({ file, reason: `its id is "${checked.theme.id}"; the file must be named ${checked.theme.id}.json.` });
        continue;
      }
      themes.push(checked.theme);
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
  const body = `${JSON.stringify(checked.theme, null, 2)}\n`;
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

/** Move `themes/<id>.json` to `themes/removed/`; the path it went to, or null when there was no such file. */
export function removeCustomTheme(dataDir: string, id: string, now = Date.now()): string | null {
  if (!THEME_ID_PATTERN.test(id)) return null;
  const dir = customThemesDir(dataDir);
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return null;
  const removedDir = join(dir, "removed");
  mkdirSync(removedDir, { recursive: true });
  const to = join(removedDir, `${id}-${now}.json`);
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
 * `/plannotator-themes.js`: a classic script every page links in its head
 * (apps/hook, apps/review and apps/inbox index.html), so it runs before the
 * app's module script and before the first paint. It hands the registry the
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

/** The route every server answers with customThemesScript. */
export const CUSTOM_THEMES_SCRIPT_PATH = "/plannotator-themes.js";

/** The headers of that answer: a script, read fresh on every page load (a theme added since shows on reload). */
export const CUSTOM_THEMES_SCRIPT_HEADERS: Record<string, string> = {
  "Content-Type": "text/javascript; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
