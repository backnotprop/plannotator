/**
 * The still of an uploaded agent icon that moves (packages/server/inbox-agent-icons.ts): its first frame, made from
 * the bytes on the server, so every window shows the same still and none has to draw one. A picture that does not
 * move has no still: the window's still address serves the picture itself.
 *
 * - SVG: the same file with every CSS animation and transition turned off and its SMIL elements (`<animate>`,
 *   `<animateTransform>`, `<animateMotion>`, `<animateColor>`, `<set>`) taken out, so it shows its rest pose. Inside an
 *   `<img>` a moving SVG ignores the system's reduced-motion setting, so the window needs this file to stay still.
 * - GIF: the header, the palette and the first image only.
 * - APNG: the PNG without its animation chunks (`acTL`, `fcTL`, `fdAT`): the default image every plain PNG reader shows.
 * - Animated WebP: its first frame as a plain WebP (the frame's own bitstream and alpha, the frame's size).
 *
 * Nothing here decodes pixels: each is a cut of the file's own blocks. A file that does not parse as expected has no
 * still (the window then shows the picture as uploaded).
 */

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
const u32be = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const u32le = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/* ---------- SVG ---------- */

const SVG_MOTION = /@keyframes|\banimation(?:-name)?\s*:|<(?:animate|animateTransform|animateMotion|animateColor|set)\b/i;
const SMIL_PAIRED = /<(animate|animateTransform|animateMotion|animateColor|set)\b[^>]*?(?<!\/)>[\s\S]*?<\/\1\s*>/gi;
const SMIL_EMPTY = /<(?:animate|animateTransform|animateMotion|animateColor|set)\b[^>]*\/>/gi;
const STILL_STYLE = "<style>*,*::before,*::after{animation:none!important;transition:none!important}</style>";

function svgStill(text: string): string | null {
  if (!SVG_MOTION.test(text)) return null;
  const open = /<svg\b[^>]*>/i.exec(text);
  if (!open) return null;
  const at = open.index + open[0].length;
  const body = text.slice(at).replace(SMIL_PAIRED, "").replace(SMIL_EMPTY, "");
  // A self-closing root (`<svg … />`) has nothing to animate.
  if (open[0].endsWith("/>")) return null;
  return `${text.slice(0, at)}${STILL_STYLE}${body}`;
}

/* ---------- GIF ---------- */

/** The bytes after a run of sub-blocks starting at `at` (each a length byte and that many bytes, ending with 0). */
function skipSubBlocks(b: Uint8Array, at: number): number {
  while (at < b.length) {
    const size = b[at]!;
    at += 1 + size;
    if (size === 0) return at;
  }
  return -1;
}

function gifStill(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (b.length < 13) return null;
  let at = 13;
  if (b[10]! & 0x80) at += 3 * (1 << ((b[10]! & 0x07) + 1));
  const head = b.subarray(0, at);
  const kept: Uint8Array[] = [];
  let first: Uint8Array | null = null;
  let frames = 0;
  while (at < b.length) {
    const kind = b[at]!;
    if (kind === 0x3b) break;
    if (kind === 0x21) {
      const label = b[at + 1]!;
      const end = skipSubBlocks(b, at + 2);
      if (end < 0) return null;
      // The frame's own control (its transparency) goes with it; the looping block and comments do not.
      if (!first && label === 0xf9) kept.push(b.subarray(at, end));
      at = end;
      continue;
    }
    if (kind === 0x2c) {
      let end = at + 10;
      if (end > b.length) return null;
      if (b[at + 9]! & 0x80) end += 3 * (1 << ((b[at + 9]! & 0x07) + 1));
      end = skipSubBlocks(b, end + 1);
      if (end < 0) return null;
      frames++;
      if (!first) first = b.subarray(at, end);
      if (frames > 1) break;
      at = end;
      continue;
    }
    return null;
  }
  if (!first || frames < 2) return null;
  return concat([head, ...kept, first, new Uint8Array([0x3b])]);
}

/* ---------- PNG / APNG ---------- */

function pngStill(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let at = 8;
  let animated = false;
  while (at + 12 <= b.length) {
    const length = u32be(b, at);
    const type = ascii(b, at + 4, at + 8);
    const end = at + 12 + length;
    if (end > b.length) return null;
    if (type === "acTL" || type === "fcTL" || type === "fdAT") animated ||= type === "acTL";
    else parts.push(b.subarray(at, end));
    at = end;
    if (type === "IEND") break;
  }
  return animated ? concat(parts) : null;
}

/* ---------- WebP ---------- */

function riffChunk(type: string, payload: Uint8Array): Uint8Array {
  const pad = payload.byteLength & 1;
  const out = new Uint8Array(8 + payload.byteLength + pad);
  out.set(new TextEncoder().encode(type), 0);
  new DataView(out.buffer).setUint32(4, payload.byteLength, true);
  out.set(payload, 8);
  return out;
}

function webpStill(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (b.length < 30 || ascii(b, 12, 16) !== "VP8X" || !(b[20]! & 0x02)) return null;
  let at = 12;
  while (at + 8 <= b.length) {
    const type = ascii(b, at, at + 4);
    const size = u32le(b, at + 4);
    const body = at + 8;
    if (body + size > b.length) return null;
    if (type === "ANMF" && size >= 16) {
      const width = u24le(b, body + 6) + 1;
      const height = u24le(b, body + 9) + 1;
      // The frame's own chunks: an optional ALPH, then VP8 or VP8L.
      const frame: Uint8Array[] = [];
      let alpha = false;
      let inner = body + 16;
      while (inner + 8 <= body + size) {
        const innerType = ascii(b, inner, inner + 4);
        const innerSize = u32le(b, inner + 4);
        const innerEnd = inner + 8 + innerSize + (innerSize & 1);
        if (inner + 8 + innerSize > body + size) return null;
        if (innerType === "ALPH" || innerType === "VP8 " || innerType === "VP8L") {
          frame.push(b.subarray(inner, Math.min(innerEnd, body + size)));
          alpha ||= innerType === "ALPH" || innerType === "VP8L";
        }
        inner = innerEnd;
      }
      if (!frame.some((chunk) => ascii(chunk, 0, 4) !== "ALPH")) return null;
      const vp8x = new Uint8Array(10);
      vp8x[0] = alpha ? 0x10 : 0;
      vp8x.set([(width - 1) & 0xff, ((width - 1) >> 8) & 0xff, ((width - 1) >> 16) & 0xff, (height - 1) & 0xff, ((height - 1) >> 8) & 0xff, ((height - 1) >> 16) & 0xff], 4);
      // Even-length chunks: an odd one was copied with its pad byte above, or gets one here.
      const chunks = [riffChunk("VP8X", vp8x), ...frame.map((chunk) => (chunk.byteLength & 1 ? concat([chunk, new Uint8Array(1)]) : chunk))];
      const payload = concat([new TextEncoder().encode("WEBP"), ...chunks]);
      const header = new Uint8Array(8);
      header.set(new TextEncoder().encode("RIFF"), 0);
      new DataView(header.buffer).setUint32(4, payload.byteLength, true);
      return concat([header, payload]);
    }
    at = body + size + (size & 1);
  }
  return null;
}

/** The still of a picture that moves (its first frame, as the same type), or null for one that does not. */
export function agentIconStill(type: string, bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
  try {
    if (type === "image/svg+xml") {
      const still = svgStill(new TextDecoder().decode(bytes));
      return still === null ? null : new TextEncoder().encode(still);
    }
    if (type === "image/gif") return gifStill(bytes);
    if (type === "image/png") return pngStill(bytes);
    if (type === "image/webp") return webpStill(bytes);
  } catch {
    // A file that does not parse: no still, the picture as uploaded.
  }
  return null;
}
