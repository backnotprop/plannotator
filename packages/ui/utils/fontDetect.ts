/**
 * Local font detection via width measurement.
 *
 * Renders a glyph-diverse sample string with the candidate family in front of
 * each generic fallback (monospace, serif, sans-serif) and compares the
 * measured width against the fallback alone. If any pair differs, the browser
 * resolved the candidate font.
 *
 * The default measurement uses a hidden DOM span, not canvas: WebKit resolves
 * some installed families (e.g. Nebula Sans) for DOM text but reports the
 * fallback width from `canvas.measureText`, which produced a false "Not found"
 * in Glimpse. An injected canvas context is still accepted for callers that
 * need the old measurement. `document.fonts.check()` is not used: it answers
 * "would this render without a font load," not "is this family available."
 *
 * Known limit: the name must be the family name the OS reports ("Iosevka
 * Custom", not a file name).
 */

import { quoteFontFamily } from "./cssFontFamily";

const SAMPLE = "mmmmmmmmmmlli0O1Il@#WQ";
const SIZE = "72px";
const GENERICS = ["monospace", "serif", "sans-serif"] as const;

type MeasureContext = Pick<CanvasRenderingContext2D, "font" | "measureText">;

function measureWithDom(quoted: string): boolean | null {
  if (typeof document === "undefined") return null;
  const host = document.body ?? document.documentElement;
  if (!host) return null;

  const probe = document.createElement("span");
  probe.textContent = SAMPLE;
  probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font-size:${SIZE}`;
  host.appendChild(probe);
  try {
    for (const generic of GENERICS) {
      probe.style.fontFamily = generic;
      const base = probe.getBoundingClientRect().width;
      probe.style.fontFamily = `${quoted}, ${generic}`;
      if (probe.getBoundingClientRect().width !== base) return true;
    }
    return false;
  } finally {
    probe.remove();
  }
}

function measureWithCanvas(quoted: string, c: MeasureContext): boolean {
  for (const generic of GENERICS) {
    c.font = `${SIZE} ${generic}`;
    const base = c.measureText(SAMPLE).width;
    c.font = `${SIZE} ${quoted}, ${generic}`;
    if (c.measureText(SAMPLE).width !== base) return true;
  }
  return false;
}

/**
 * Check whether a font family resolves on this machine.
 *
 * Returns `true` / `false` from width measurement, or `null` when measurement
 * is unavailable — callers should treat `null` as "unknown" and skip any
 * installed/missing hint. Passing `null` as the context keeps that old meaning.
 */
export function isFontInstalled(
  family: string,
  context?: MeasureContext | null,
): boolean | null {
  const quoted = quoteFontFamily(family);
  if (!quoted) return false;
  if (context === null) return null;
  return context ? measureWithCanvas(quoted, context) : measureWithDom(quoted);
}
