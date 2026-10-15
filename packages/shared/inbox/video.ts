/**
 * Plannotator Inbox: telling a film from its bytes, and reading an MP4/MOV's
 * length and frame size from its header without reading the film.
 *
 * - MP4 / MOV: an ISO base media file starts with an `ftyp` box (offset 4)
 *   whose major and compatible brands name what it holds. A video brand
 *   (`isom`, `iso2`..`iso9`, `mp41`, `mp42`, `avc1`, `M4V `, `qt  `, `dash`,
 *   ...) makes it a video, unless the MAJOR brand is an image or audio one
 *   (`avif`, `heic`, `mif1`, `M4A `, ...): an AVIF is sniffed as an image
 *   first anyway, and an `.m4a` lists `isom` among its compatible brands.
 *   `qt  ` as the major brand is QuickTime (`video/quicktime`); the rest is
 *   `video/mp4`.
 * - WebM: the EBML magic `1A 45 DF A3` and a DocType of `webm` in the EBML
 *   header. Matroska (`matroska`, `.mkv`) stays a file: browsers do not
 *   promise to play it. WebM carries no metadata here (contract: MP4/MOV only).
 *
 * The header walk (`readMp4VideoMetadata`) seeks from box to box through a
 * reader that returns a few bytes at a position: the top-level boxes until
 * `moov` (which may sit after a 461 MB `mdat`), then `mvhd` for the length
 * and each `trak`'s `tkhd` + `mdia/hdlr` for the first video track's size.
 * It reads a few hundred bytes in all and visits a bounded number of boxes, so
 * a hostile file costs nothing. A parsed `moov` with tracks but no video track
 * is audio (an `.m4a` named `.mp4`): the caller keeps it a `file`.
 */

/** Brands that hold video. */
const VIDEO_BRANDS: ReadonlySet<string> = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "iso7",
  "iso8",
  "iso9",
  "mp41",
  "mp42",
  "mp71",
  "avc1",
  "M4V ",
  "M4VH",
  "M4VP",
  "qt  ",
  "dash",
  "msnv",
  "3gp4",
  "3gp5",
  "3gp6",
  "3gp7",
  "3gp8",
  "3gp9",
  "3g2a",
  "f4v ",
  "mmp4",
  "XAVC",
]);

/** Major brands of image and audio files in the same box format: never a video. */
const NOT_VIDEO_MAJOR_BRANDS: ReadonlySet<string> = new Set([
  "avif",
  "avis",
  "heic",
  "heix",
  "heim",
  "heis",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
  "M4A ",
  "M4B ",
  "M4P ",
  "F4A ",
  "F4B ",
]);

export type InboxVideoMediaType = "video/mp4" | "video/quicktime" | "video/webm";

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
}

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
}

function u64(bytes: Uint8Array, at: number): number {
  return u32(bytes, at) * 2 ** 32 + u32(bytes, at + 4);
}

/** The `ftyp` brands of an ISO base media file, or null when it is not one. */
function ftypBrands(head: Uint8Array): { major: string; compatible: string[] } | null {
  if (head.length < 16 || fourcc(head, 4) !== "ftyp") return null;
  const size = u32(head, 0);
  if (size < 16) return null;
  const end = Math.min(size, head.length);
  const compatible: string[] = [];
  for (let at = 16; at + 4 <= end; at += 4) compatible.push(fourcc(head, at));
  return { major: fourcc(head, 8), compatible };
}

/** An EBML variable-length integer at `at`: its value (marker removed unless `keepMarker`) and its length. */
function vint(bytes: Uint8Array, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } | null {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || at + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = bytes[at + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

/** The DocType a WebM/Matroska EBML header names, or null when the bytes do not start with one. */
function ebmlDocType(head: Uint8Array): string | null {
  if (head.length < 8 || head[0] !== 0x1a || head[1] !== 0x45 || head[2] !== 0xdf || head[3] !== 0xa3) return null;
  const size = vint(head, 4, false);
  if (!size) return null;
  let at = 4 + size.length;
  const end = size.unknown ? head.length : Math.min(head.length, at + size.value);
  for (let guard = 0; at < end && guard < 64; guard++) {
    const id = vint(head, at, true);
    if (!id) return null;
    const len = vint(head, at + id.length, false);
    if (!len || len.unknown) return null;
    const body = at + id.length + len.length;
    if (id.value === 0x4282) {
      if (len.value > 64 || body + len.value > head.length) return null;
      return String.fromCharCode(...head.subarray(body, body + len.value)).replace(/\0+$/, "");
    }
    at = body + len.value;
  }
  return null;
}

/**
 * The video container the first bytes of a file name, or null. Run AFTER
 * image sniffing (an AVIF stays an image).
 */
export function sniffInboxVideo(head: Uint8Array): InboxVideoMediaType | null {
  const brands = ftypBrands(head);
  if (brands) {
    if (NOT_VIDEO_MAJOR_BRANDS.has(brands.major)) return null;
    if (!VIDEO_BRANDS.has(brands.major) && !brands.compatible.some((brand) => VIDEO_BRANDS.has(brand))) return null;
    return brands.major === "qt  " ? "video/quicktime" : "video/mp4";
  }
  return ebmlDocType(head) === "webm" ? "video/webm" : null;
}

/** Read up to `length` bytes at `position` (fewer at the end of the file). */
export type InboxVideoReader = (position: number, length: number) => Promise<Uint8Array>;

export interface InboxVideoMetadata {
  duration_ms?: number;
  width?: number;
  height?: number;
  /** False when the `moov` parsed, had tracks, and none of them was video (an audio file). */
  hasVideoTrack: boolean;
}

/** The most boxes the walk visits, at every level together. */
const MAX_BOXES = 4096;

interface Box {
  type: string;
  /** Where its payload starts. */
  body: number;
  /** Where it ends. */
  end: number;
}

/**
 * The length and first video track's frame size of an MP4/MOV, read by
 * seeking from box to box (`read` returns the bytes at a position). Null when
 * the header cannot be walked (truncated, no `moov`): the caller keeps the
 * brand's verdict and records no metadata.
 */
export async function readMp4VideoMetadata(read: InboxVideoReader, size: number): Promise<InboxVideoMetadata | null> {
  let visited = 0;
  const boxAt = async (at: number, limit: number): Promise<Box | null> => {
    if (at + 8 > limit || ++visited > MAX_BOXES) return null;
    const header = await read(at, 16);
    if (header.length < 8) return null;
    let boxSize = u32(header, 0);
    const type = fourcc(header, 4);
    let body = at + 8;
    if (boxSize === 1) {
      if (header.length < 16) return null;
      boxSize = u64(header, 8);
      body = at + 16;
    } else if (boxSize === 0) {
      boxSize = limit - at;
    }
    if (boxSize < body - at || at + boxSize > limit) return null;
    return { type, body, end: at + boxSize };
  };
  const children = async function* (parent: { body: number; end: number }) {
    let at = parent.body;
    while (at < parent.end) {
      const box = await boxAt(at, parent.end);
      if (!box) return;
      yield box;
      at = box.end;
    }
  };

  let moov: Box | null = null;
  for await (const box of children({ body: 0, end: size })) {
    if (box.type === "moov") {
      moov = box;
      break;
    }
  }
  if (!moov) return null;

  const out: InboxVideoMetadata = { hasVideoTrack: false };
  let tracks = 0;
  for await (const box of children(moov)) {
    if (box.type === "mvhd") {
      const b = await read(box.body, 32);
      if (b.length < 20) continue;
      const v1 = b[0] === 1;
      if (v1 && b.length < 32) continue;
      const timescale = u32(b, v1 ? 20 : 12);
      const duration = v1 ? u64(b, 24) : u32(b, 16);
      const unknown = v1 ? u32(b, 24) === 0xffffffff && u32(b, 28) === 0xffffffff : duration === 0xffffffff;
      if (timescale > 0 && duration > 0 && !unknown) {
        const ms = Math.round((duration / timescale) * 1000);
        if (Number.isFinite(ms) && ms > 0) out.duration_ms = ms;
      }
    } else if (box.type === "trak") {
      tracks++;
      if (out.hasVideoTrack) continue;
      let handler: string | null = null;
      let dims: { width: number; height: number } | null = null;
      for await (const part of children(box)) {
        if (part.type === "tkhd") {
          const b = await read(part.body, 96);
          const v1 = b[0] === 1;
          const at = v1 ? 88 : 76;
          if (b.length >= at + 8) {
            const width = Math.round(u32(b, at) / 65536);
            const height = Math.round(u32(b, at + 4) / 65536);
            if (width > 0 && height > 0) dims = { width, height };
          }
        } else if (part.type === "mdia") {
          for await (const inner of children(part)) {
            if (inner.type !== "hdlr") continue;
            const b = await read(inner.body, 12);
            if (b.length >= 12) handler = fourcc(b, 8);
            break;
          }
        }
      }
      if (handler === "vide") {
        out.hasVideoTrack = true;
        if (dims) {
          out.width = dims.width;
          out.height = dims.height;
        }
      }
    }
  }
  // A moov that listed no tracks at all says nothing either way.
  if (tracks === 0) out.hasVideoTrack = true;
  return out;
}
