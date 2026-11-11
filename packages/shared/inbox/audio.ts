/** Recognises recordings from their first bytes (extension ignored), after the image, PDF and video checks, and reads their length from the header without decoding. AAC and WebM record no length. */

import { ebmlDocType, ftypBrands, vint } from "./video";

export type InboxAudioMediaType = "audio/mpeg" | "audio/mp4" | "audio/wav" | "audio/ogg" | "audio/flac" | "audio/aac" | "audio/webm";

const AUDIO_MAJOR_BRANDS: ReadonlySet<string> = new Set(["M4A ", "M4B ", "M4P ", "F4A ", "F4B "]);

function ascii(bytes: Uint8Array, at: number, length: number): string {
  if (at + length > bytes.length) return "";
  return String.fromCharCode(...bytes.subarray(at, at + length));
}

function u32be(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
}

function u32le(b: Uint8Array, at: number): number {
  return b[at]! + (b[at + 1]! << 8) + (b[at + 2]! << 16) + ((b[at + 3]! << 24) >>> 0);
}

function u16le(b: Uint8Array, at: number): number {
  return b[at]! + (b[at + 1]! << 8);
}

function id3Length(head: Uint8Array): number {
  if (head.length < 10 || ascii(head, 0, 3) !== "ID3") return 0;
  const sizes = [head[6]!, head[7]!, head[8]!, head[9]!];
  if (sizes.some((byte) => byte & 0x80)) return 0;
  const body = (sizes[0]! << 21) | (sizes[1]! << 14) | (sizes[2]! << 7) | sizes[3]!;
  return 10 + body + (head[5]! & 0x10 ? 10 : 0);
}

const BITRATES: Record<string, readonly number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES: Record<number, readonly number[]> = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 25: [11025, 12000, 8000] };

interface MpegFrame {
  length: number;
  samples: number;
  sampleRate: number;
  bitrate: number;
  version: number;
  mono: boolean;
}

function mpegFrame(b: Uint8Array, at: number): MpegFrame | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) return null;
  const versionBits = (b[at + 1]! >> 3) & 3;
  const layerBits = (b[at + 1]! >> 1) & 3;
  if (versionBits === 1 || layerBits === 0) return null;
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25;
  const layer = 4 - layerBits;
  const bitrateIndex = b[at + 2]! >> 4;
  const rateIndex = (b[at + 2]! >> 2) & 3;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const kbps = BITRATES[`${version === 1 ? 1 : 2}-${layer}`]![bitrateIndex]!;
  const sampleRate = SAMPLE_RATES[version]![rateIndex]!;
  const padding = (b[at + 2]! >> 1) & 1;
  const bitrate = kbps * 1000;
  const samples = layer === 1 ? 384 : layer === 2 || version === 1 ? 1152 : 576;
  const length = layer === 1 ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4 : Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  if (length < 4) return null;
  return { length, samples, sampleRate, bitrate, version, mono: (b[at + 3]! >> 6) === 3 };
}

function adtsFrame(b: Uint8Array, at: number): number {
  if (at + 7 > b.length || b[at] !== 0xff || (b[at + 1]! & 0xf6) !== 0xf0) return 0;
  if (((b[at + 2]! >> 2) & 0xf) > 12) return 0;
  const length = ((b[at + 3]! & 3) << 11) | (b[at + 4]! << 3) | (b[at + 5]! >> 5);
  return length >= 7 ? length : 0;
}

function chained(b: Uint8Array, at: number, length: number, next: (at: number) => boolean): boolean {
  const following = at + length;
  return following + 4 > b.length || next(following);
}

function oggCodec(head: Uint8Array): "opus" | "vorbis" | "flac" | "speex" | "other" | null {
  if (head.length < 28 || ascii(head, 0, 4) !== "OggS" || head[4] !== 0) return null;
  const packet = 27 + head[26]!;
  if (ascii(head, packet, 8) === "OpusHead") return "opus";
  if (head[packet] === 0x01 && ascii(head, packet + 1, 6) === "vorbis") return "vorbis";
  if (head[packet] === 0x7f && ascii(head, packet + 1, 4) === "FLAC") return "flac";
  if (ascii(head, packet, 8) === "Speex   ") return "speex";
  return "other";
}

const EBML_SEGMENT = 0x18538067;
const EBML_TRACKS = 0x1654ae6b;
const EBML_TRACK_ENTRY = 0xae;
const EBML_TRACK_TYPE = 0x83;
const EBML_CLUSTER = 0x1f43b675;

export function webmTrackKinds(head: Uint8Array): { video: boolean; audio: boolean } | null {
  const headerId = vint(head, 0, true);
  if (!headerId) return null;
  const headerSize = vint(head, headerId.length, false);
  if (!headerSize || headerSize.unknown) return null;
  let at = headerId.length + headerSize.length + headerSize.value;
  const segmentId = vint(head, at, true);
  if (!segmentId || segmentId.value !== EBML_SEGMENT) return null;
  const segmentSize = vint(head, at + segmentId.length, false);
  if (!segmentSize) return null;
  at += segmentId.length + segmentSize.length;
  for (let guard = 0; guard < 256 && at < head.length; guard++) {
    const id = vint(head, at, true);
    if (!id) return null;
    const size = vint(head, at + id.length, false);
    if (!size || size.unknown) return null;
    const body = at + id.length + size.length;
    if (id.value === EBML_CLUSTER) return null;
    if (id.value === EBML_TRACKS) {
      const end = Math.min(head.length, body + size.value);
      if (body + size.value > head.length) return null;
      const found = { video: false, audio: false };
      let entry = body;
      for (let guardEntry = 0; guardEntry < 64 && entry < end; guardEntry++) {
        const entryId = vint(head, entry, true);
        const entrySize = entryId && vint(head, entry + entryId.length, false);
        if (!entryId || !entrySize || entrySize.unknown) return null;
        const entryBody = entry + entryId.length + entrySize.length;
        if (entryId.value === EBML_TRACK_ENTRY) {
          let field = entryBody;
          const entryEnd = Math.min(end, entryBody + entrySize.value);
          for (let guardField = 0; guardField < 64 && field < entryEnd; guardField++) {
            const fieldId = vint(head, field, true);
            const fieldSize = fieldId && vint(head, field + fieldId.length, false);
            if (!fieldId || !fieldSize || fieldSize.unknown) return null;
            const fieldBody = field + fieldId.length + fieldSize.length;
            if (fieldId.value === EBML_TRACK_TYPE && fieldSize.value === 1) {
              const type = head[fieldBody];
              if (type === 1) found.video = true;
              if (type === 2) found.audio = true;
            }
            field = fieldBody + fieldSize.value;
          }
        }
        entry = entryBody + entrySize.value;
      }
      return found;
    }
    at = body + size.value;
  }
  return null;
}

/** Run AFTER image, PDF and video sniffing; a WebM is audio only when its tracks say so. */
export function sniffInboxAudio(head: Uint8Array): InboxAudioMediaType | null {
  if (ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WAVE") return "audio/wav";
  if (ascii(head, 0, 4) === "fLaC") return "audio/flac";
  const ogg = oggCodec(head);
  if (ogg) return ogg === "other" ? null : "audio/ogg";
  const brands = ftypBrands(head);
  if (brands) return AUDIO_MAJOR_BRANDS.has(brands.major) ? "audio/mp4" : null;
  if (ebmlDocType(head) === "webm") {
    const tracks = webmTrackKinds(head);
    return tracks && tracks.audio && !tracks.video ? "audio/webm" : null;
  }
  const tag = id3Length(head);
  if (tag > 0 && tag + 4 <= head.length && ascii(head, tag, 4) === "fLaC") return "audio/flac";
  let at = tag;
  while (tag > 0 && at < head.length && head[at] === 0) at++;
  if (at + 4 > head.length) return tag > 0 ? "audio/mpeg" : null;
  const frame = mpegFrame(head, at);
  if (frame && chained(head, at, frame.length, (next) => mpegFrame(head, next) !== null)) return "audio/mpeg";
  const adts = adtsFrame(head, at);
  if (adts && chained(head, at, adts, (next) => adtsFrame(head, next) > 0)) return "audio/aac";
  // An ID3v2 tag is an MP3's: a first frame the head does not show plainly (padding, a damaged frame) keeps it one.
  return tag > 0 ? "audio/mpeg" : null;
}

export function inboxAudioServedType(head: Uint8Array): InboxAudioMediaType | null {
  return sniffInboxAudio(head) ?? (ftypBrands(head) ? "audio/mp4" : null);
}

function ms(seconds: number): number | null {
  const value = Math.round(seconds * 1000);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function wavDuration(head: Uint8Array, size: number): number | null {
  let byteRate = 0;
  for (let at = 12, guard = 0; at + 8 <= head.length && guard < 64; guard++) {
    const id = ascii(head, at, 4);
    const length = u32le(head, at + 4);
    const body = at + 8;
    if (id === "fmt " && body + 12 <= head.length) byteRate = u32le(head, body + 8);
    if (id === "data") {
      const data = length === 0 || length === 0xffffffff || body + length > size ? size - body : length;
      return byteRate > 0 ? ms(data / byteRate) : null;
    }
    at = body + length + (length & 1);
  }
  return null;
}

function flacDuration(head: Uint8Array, at: number): number | null {
  if (ascii(head, at, 4) !== "fLaC" || at + 8 + 18 > head.length || (head[at + 4]! & 0x7f) !== 0) return null;
  const info = at + 8;
  const sampleRate = (head[info + 10]! << 12) | (head[info + 11]! << 4) | (head[info + 12]! >> 4);
  const total = (head[info + 13]! & 0x0f) * 2 ** 32 + u32be(head, info + 14);
  return sampleRate > 0 && total > 0 ? ms(total / sampleRate) : null;
}

function mpegDuration(head: Uint8Array, size: number): number | null {
  let at = id3Length(head);
  while (at > 0 && at < head.length && head[at] === 0) at++;
  const frame = mpegFrame(head, at);
  if (!frame) return null;
  const side = frame.version === 1 ? (frame.mono ? 17 : 32) : frame.mono ? 9 : 17;
  const xing = at + 4 + side;
  const tag = ascii(head, xing, 4);
  if ((tag === "Xing" || tag === "Info") && xing + 12 <= head.length && u32be(head, xing + 4) & 1) {
    const frames = u32be(head, xing + 8);
    if (frames > 0) return ms((frames * frame.samples) / frame.sampleRate);
  }
  const vbri = at + 4 + 32;
  if (ascii(head, vbri, 4) === "VBRI" && vbri + 18 <= head.length) {
    const frames = u32be(head, vbri + 14);
    if (frames > 0) return ms((frames * frame.samples) / frame.sampleRate);
  }
  return ms(((size - at) * 8) / frame.bitrate);
}

export function audioDurationMsFromHead(head: Uint8Array, size: number, type: InboxAudioMediaType): number | null {
  if (type === "audio/wav") return wavDuration(head, size);
  if (type === "audio/flac") return flacDuration(head, 0) ?? flacDuration(head, id3Length(head));
  if (type === "audio/mpeg") return mpegDuration(head, size);
  return null;
}

/** How many bytes of an Ogg's end its length is read from: a page is at most 64 KiB plus its header. */
export const OGG_TAIL_BYTES = 70 * 1024;

export function oggDurationMs(head: Uint8Array, tail: Uint8Array): number | null {
  const codec = oggCodec(head);
  const packet = 27 + (head[26] ?? 0);
  let rate = 0;
  let skip = 0;
  if (codec === "opus" && packet + 12 <= head.length) {
    rate = 48000;
    skip = u16le(head, packet + 10);
  } else if (codec === "vorbis" && packet + 16 <= head.length) {
    rate = u32le(head, packet + 12);
  }
  if (rate <= 0) return null;
  for (let at = tail.length - 27; at >= 0; at--) {
    if (tail[at] !== 0x4f || ascii(tail, at, 4) !== "OggS") continue;
    const low = u32le(tail, at + 6);
    const high = u32le(tail, at + 10);
    // -1: no packet ends on this page.
    if (low === 0xffffffff && high === 0xffffffff) continue;
    const granule = high * 2 ** 32 + low;
    return ms((granule - skip) / rate);
  }
  return null;
}
