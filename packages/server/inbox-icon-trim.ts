/**
 * Trims a fetched set's PNG to its picture (a fetchable set's manifest `trim: true`, inbox-icon-set-fetch.ts): sprites
 * often sit small in the middle of a large clear square, so at 16 to 24 px only a speck would show. The clear border
 * goes, and the picture is kept centred in the smallest square that holds it (one clear pixel round it), as an RGBA
 * PNG. Anything it cannot read (interlaced, 16-bit, not a PNG, nothing clear to trim) is kept as it came: null.
 * `node:zlib` only, no dependency.
 */
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** The picture's pixels as RGBA, or null when this reader does not take it. */
export function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
  if (bytes.length < 33 || SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let palette: Uint8Array | null = null;
  let alphas: Uint8Array | null = null;
  const data: Uint8Array[] = [];
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    const name = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (name === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = body[8]!;
      type = body[9]!;
      if (body[12] !== 0) return null;
    } else if (name === "PLTE") palette = body;
    else if (name === "tRNS") alphas = body;
    else if (name === "IDAT") data.push(body);
    else if (name === "IEND") break;
    at += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels || !width || !height || width > 1024 || height > 1024) return null;
  if (depth !== 8 && !(type === 3 && (depth === 1 || depth === 2 || depth === 4))) return null;
  if (type === 3 && !palette) return null;
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(inflateSync(Buffer.concat(data)));
  } catch {
    return null;
  }
  const stride = Math.ceil((width * channels * depth) / 8);
  const bpp = Math.max(1, (channels * depth) / 8);
  if (raw.length < height * (stride + 1)) return null;
  const rows = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = rows.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp]! : 0;
      const b = up ? up[i]! : 0;
      const c = up && i >= bpp ? up[i - bpp]! : 0;
      let v = line[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      out[i] = v & 0xff;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (type === 3) {
        const index = depth === 8 ? row[x]! : (row[(x * depth) >> 3]! >> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1);
        rgba.set([palette![index * 3] ?? 0, palette![index * 3 + 1] ?? 0, palette![index * 3 + 2] ?? 0, alphas?.[index] ?? 255], o);
      } else if (type === 6) rgba.set(row.subarray(x * 4, x * 4 + 4), o);
      else if (type === 2) rgba.set([row[x * 3]!, row[x * 3 + 1]!, row[x * 3 + 2]!, 255], o);
      else if (type === 4) rgba.set([row[x * 2]!, row[x * 2]!, row[x * 2]!, row[x * 2 + 1]!], o);
      else rgba.set([row[x]!, row[x]!, row[x]!, 255], o);
    }
  }
  return { width, height, rgba };
}

function chunk(name: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  out.set(new TextEncoder().encode(name), 4);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/** RGBA pixels as a PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const head = new Uint8Array(13);
  new DataView(head.buffer).setUint32(0, width);
  new DataView(head.buffer).setUint32(4, height);
  head.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array(SIGNATURE), chunk("IHDR", head), chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** The PNG trimmed to its picture in a square, or null to keep it as it came. */
export function trimPng(bytes: Uint8Array): Uint8Array | null {
  const image = decodePng(bytes);
  if (!image) return null;
  const { width, height, rgba } = image;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (rgba[(y * width + x) * 4 + 3]! > 0) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
  if (right < 0) return null;
  const w = right - left + 1;
  const h = bottom - top + 1;
  const side = Math.max(w, h) + 2;
  if (side >= Math.max(width, height)) return null;
  const out = new Uint8Array(side * side * 4);
  const dx = Math.floor((side - w) / 2);
  const dy = Math.floor((side - h) / 2);
  for (let y = 0; y < h; y++) out.set(rgba.subarray(((top + y) * width + left) * 4, ((top + y) * width + left + w) * 4), ((dy + y) * side + dx) * 4);
  return encodePng(side, side, out);
}
