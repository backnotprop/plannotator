import { spawnSync } from "node:child_process";

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

export function box(type: string, ...parts: Buffer[]): Buffer {
  const payload = Buffer.concat(parts);
  return Buffer.concat([u32(8 + payload.length), Buffer.from(type, "latin1"), payload]);
}

function fullBox(type: string, version: number, ...parts: Buffer[]): Buffer {
  return box(type, Buffer.from([version, 0, 0, 0]), ...parts);
}

const MATRIX = Buffer.concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

function mvhd(timescale: number, duration: number, version: 0 | 1): Buffer {
  const times = version === 1 ? Buffer.concat([u64(0), u64(0), u32(timescale), u64(duration)]) : Buffer.concat([u32(0), u32(0), u32(timescale), u32(duration)]);
  return fullBox("mvhd", version, times, u32(0x00010000), Buffer.from([1, 0]), Buffer.alloc(10), MATRIX, Buffer.alloc(24), u32(2));
}

function tkhd(id: number, width: number, height: number, version: 0 | 1): Buffer {
  const times = version === 1 ? Buffer.concat([u64(0), u64(0), u32(id), u32(0), u64(0)]) : Buffer.concat([u32(0), u32(0), u32(id), u32(0), u32(0)]);
  return fullBox("tkhd", version, times, Buffer.alloc(8), Buffer.alloc(2), Buffer.alloc(2), Buffer.alloc(2), Buffer.alloc(2), MATRIX, u32(width * 65536), u32(height * 65536));
}

function hdlr(handler: string): Buffer {
  return fullBox("hdlr", 0, u32(0), Buffer.from(handler, "latin1"), Buffer.alloc(12), Buffer.from("\0"));
}

function trak(id: number, handler: "vide" | "soun", width: number, height: number, version: 0 | 1): Buffer {
  return box("trak", tkhd(id, handler === "vide" ? width : 0, handler === "vide" ? height : 0, version), box("mdia", hdlr(handler)));
}

export interface Mp4Options {
  major?: string;
  compatible?: string[];
  duration?: number;
  timescale?: number;
  width?: number;
  height?: number;
  moovAtEnd?: boolean;
  mdatBytes?: number;
  largeMdat?: boolean;
  version?: 0 | 1;
  tracks?: ("vide" | "soun")[];
}

export function mp4(options: Mp4Options = {}): Buffer {
  const {
    major = "isom",
    compatible = ["isom", "iso2", "avc1", "mp41"],
    duration = 461.3,
    timescale = 1000,
    width = 1920,
    height = 1080,
    moovAtEnd = true,
    mdatBytes = 4096,
    largeMdat = false,
    version = 0,
    tracks = ["soun", "vide"],
  } = options;
  const ftyp = box("ftyp", Buffer.from(major, "latin1"), u32(0x200), ...compatible.map((brand) => Buffer.from(brand, "latin1")));
  const moov = box("moov", mvhd(timescale, Math.round(duration * timescale), version), ...tracks.map((handler, i) => trak(i + 1, handler, width, height, version)));
  const payload = Buffer.alloc(mdatBytes, 0x5a);
  const mdat = largeMdat ? Buffer.concat([u32(1), Buffer.from("mdat"), u64(16 + mdatBytes), payload]) : box("mdat", payload);
  return Buffer.concat(moovAtEnd ? [ftyp, mdat, moov] : [ftyp, moov, mdat]);
}

export function ebml(docType: "webm" | "matroska" = "webm"): Buffer {
  const doc = Buffer.from(docType, "latin1");
  const children = Buffer.concat([
    Buffer.from([0x42, 0x86, 0x81, 0x01]),
    Buffer.from([0x42, 0xf7, 0x81, 0x01]),
    Buffer.from([0x42, 0x82, 0x80 | doc.length]),
    doc,
    Buffer.from([0x42, 0x87, 0x81, 0x04]),
  ]);
  const header = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | children.length]), children]);
  return Buffer.concat([header, Buffer.from([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), Buffer.alloc(512, 0x11)]);
}

export function ffmpegCan(encoder: string): boolean {
  const run = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8", timeout: 10_000 });
  return run.status === 0 && new RegExp(`\\s${encoder}\\s`).test(run.stdout);
}

export function encodeWithFfmpeg(out: string, format: "mp4" | "webm", options: { faststart?: boolean } = {}): void {
  const codec = format === "mp4" ? ["-c:v", "libx264", "-pix_fmt", "yuv420p", ...(options.faststart ? ["-movflags", "+faststart"] : [])] : ["-c:v", "libvpx", "-b:v", "200k"];
  const run = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x240:rate=10", ...codec, out], { encoding: "utf8", timeout: 60_000 });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr}`);
}
