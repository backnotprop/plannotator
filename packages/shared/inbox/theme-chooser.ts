/**
 * Who the one-time "themes" dialog is for (approval "inbox-theme-chooser", 2026-11-10; the owner: "only for users who
 * don't already have a custom theme. I mean, by custom, anybody who's not using the default theme ... they don't need to
 * choose, we don't need to show them this"). Pure, so a test can read every case; the Inbox server
 * (packages/server/inbox.ts) keeps the record in config.json `inboxThemeChooser` and gives the line its answer
 * (`theme_chooser` in reveals.ts).
 *
 * The default theme is Plannotator Original on both halves: config.json `theme` with no `light` and no `dark` palette,
 * or both `plannotator`. The mode (light, dark, system) is not part of it: someone who only flipped light and dark is
 * still on the default theme.
 *
 * The record, decided at the first release start of the version that ships the dialog, and kept true after it:
 *  - `dueAt`: on the default theme then. The dialog is in the line for them (fresh installs too, from their second day).
 *  - `notNeededAt`: on another theme, then or at any later look (a start, a theme saved from the Inbox, a claim). Final:
 *    going back to the default theme later never brings the dialog up.
 */
import type { ThemeConfig } from "@plannotator/core/config-types";

/** The palette both halves hold until the person picks another (packages/ui/utils/themeRegistry.ts `DEFAULT_COLOR_THEME`). */
export const THEME_CHOOSER_DEFAULT_THEME = "plannotator";

/** config.json `inboxThemeChooser`. */
export interface ThemeChooserSaved {
  dueAt?: string;
  notNeededAt?: string;
}

/** The saved theme is the default one: no palette picked for either half (the mode may be anything). */
export function themeChooserOnDefault(theme: ThemeConfig | null | undefined): boolean {
  if (!theme || typeof theme !== "object") return true;
  return (["light", "dark"] as const).every((half) => theme[half] === undefined || theme[half] === THEME_CHOOSER_DEFAULT_THEME);
}

/**
 * The record after a look at the saved theme, or null when nothing changes. Nothing saved yet: `dueAt` on the default
 * theme, `notNeededAt` on any other. Due, and now on another theme: `notNeededAt` is added (it stays for good).
 */
export function themeChooserLook(saved: ThemeChooserSaved | undefined, theme: ThemeConfig | null | undefined, at: string): ThemeChooserSaved | null {
  const onDefault = themeChooserOnDefault(theme);
  if (saved === undefined) return onDefault ? { dueAt: at } : { notNeededAt: at };
  if (saved.notNeededAt || onDefault) return null;
  return { ...saved, notNeededAt: at };
}

/** The dialog is still for this person: due, never marked as not needed, and on the default theme now. */
export function themeChooserOpen(saved: ThemeChooserSaved | undefined, theme: ThemeConfig | null | undefined): boolean {
  return typeof saved?.dueAt === "string" && !saved.notNeededAt && themeChooserOnDefault(theme);
}
