/**
 * Local font detection via width measurement.
 *
 * Renders a glyph-diverse sample string with the candidate family in front of
 * each generic fallback (monospace, serif, sans-serif) and compares measured
 * widths against the fallback alone. If any pair differs, the browser resolved
 * the candidate font — it is installed (or already loaded as a webfont).
 *
 * This observes actual rendering rather than querying font-availability APIs,
 * so it is deterministic for a given machine + browser + installed-font set.
 * `document.fonts.check()` is NOT used: its spec answers "would this render
 * without a font load," which browsers answer inconsistently for families the
 * page never registered.
 *
 * Known limits:
 * - The name must be the family name as the OS reports it ("Iosevka Custom",
 *   not a file name).
 * - A font installed mid-session is picked up on the next call (no event).
 */

const SAMPLE = "mmmmmmmmmmlli0O1Il@#WQ";
const SIZE = "72px";
const GENERICS = ["monospace", "serif", "sans-serif"] as const;

let ctx: CanvasRenderingContext2D | null | undefined;

function getContext(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx;
  try {
    ctx = document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  return ctx;
}

/**
 * Check whether a font family resolves on this machine.
 *
 * Returns `true` / `false` from width measurement, or `null` when measurement
 * is unavailable (no canvas) — callers should treat `null` as "unknown" and
 * skip any installed/missing hint.
 */
export function isFontInstalled(family: string): boolean | null {
  const name = family.trim().replace(/["']/g, "");
  if (!name) return false;

  const c = getContext();
  if (!c) return null;

  for (const generic of GENERICS) {
    c.font = `${SIZE} ${generic}`;
    const base = c.measureText(SAMPLE).width;
    c.font = `${SIZE} "${name}", ${generic}`;
    if (c.measureText(SAMPLE).width !== base) return true;
  }
  return false;
}
