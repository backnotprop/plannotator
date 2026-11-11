import { quoteFontFamily } from "./cssFontFamily";

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

/** Check whether a font family resolves on this machine. */
export function isFontInstalled(
  family: string,
  context: Pick<CanvasRenderingContext2D, "font" | "measureText"> | null = getContext(),
): boolean | null {
  const quoted = quoteFontFamily(family);
  if (!quoted) return false;

  const c = context;
  if (!c) return null;

  for (const generic of GENERICS) {
    c.font = `${SIZE} ${generic}`;
    const base = c.measureText(SAMPLE).width;
    c.font = `${SIZE} ${quoted}, ${generic}`;
    if (c.measureText(SAMPLE).width !== base) return true;
  }
  return false;
}
