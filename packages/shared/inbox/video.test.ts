/**
 * A film told from its bytes, and an MP4/MOV's length and frame size read
 * from its header by seeking (never the whole file). The films are built in
 * the test (tests/helpers/video-fixtures.ts); a real encoder's output is
 * checked too when ffmpeg is on the PATH.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ebml, encodeWithFfmpeg, ffmpegCan, mp4 } from "../../../tests/helpers/video-fixtures";
import { decideInboxAttachmentKind, INBOX_ATTACHMENT_HEAD_BYTES } from "./attachments";
import { readMp4VideoMetadata, sniffInboxVideo } from "./video";

/** A reader over bytes that counts what it read: the walk must seek, never read the film. */
function reader(bytes: Buffer) {
  const reads: { position: number; length: number }[] = [];
  return {
    reads,
    read: async (position: number, length: number) => {
      reads.push({ position, length });
      return bytes.subarray(position, Math.min(bytes.length, position + length));
    },
  };
}

/** A sparse reader for a film whose `mdat` is too large to build: the head, a hole, and the tail. */
function sparse(head: Buffer, holeBytes: number, tail: Buffer) {
  const size = head.length + holeBytes + tail.length;
  return {
    size,
    read: async (position: number, length: number) => {
      const out = Buffer.alloc(Math.max(0, Math.min(length, size - position)));
      for (let i = 0; i < out.length; i++) {
        const at = position + i;
        out[i] = at < head.length ? head[at]! : at >= head.length + holeBytes ? tail[at - head.length - holeBytes]! : 0;
      }
      return out;
    },
  };
}

describe("sniffInboxVideo", () => {
  test("MP4 by its ftyp brands: video/mp4, QuickTime as video/quicktime", () => {
    expect(sniffInboxVideo(mp4())).toBe("video/mp4");
    expect(sniffInboxVideo(mp4({ major: "mp42", compatible: ["mp42", "isom"] }))).toBe("video/mp4");
    expect(sniffInboxVideo(mp4({ major: "M4V ", compatible: ["M4V ", "M4A ", "mp42"] }))).toBe("video/mp4");
    expect(sniffInboxVideo(mp4({ major: "qt  ", compatible: ["qt  "] }))).toBe("video/quicktime");
    // A video brand only among the compatible ones still counts.
    expect(sniffInboxVideo(mp4({ major: "XXXX", compatible: ["avc1"] }))).toBe("video/mp4");
  });

  test("image and audio brands stay out, whatever the compatible brands say", () => {
    expect(sniffInboxVideo(mp4({ major: "M4A ", compatible: ["M4A ", "mp42", "isom"] }))).toBeNull();
    expect(sniffInboxVideo(mp4({ major: "avif", compatible: ["avif", "mif1", "miaf"] }))).toBeNull();
    expect(sniffInboxVideo(mp4({ major: "heic", compatible: ["mif1", "heic"] }))).toBeNull();
    expect(sniffInboxVideo(mp4({ major: "XXXX", compatible: ["YYYY"] }))).toBeNull();
  });

  test("WebM by its EBML DocType; Matroska and anything else are not videos", () => {
    expect(sniffInboxVideo(ebml("webm"))).toBe("video/webm");
    expect(sniffInboxVideo(ebml("matroska"))).toBeNull();
    expect(sniffInboxVideo(Buffer.from("%PDF-1.4\n"))).toBeNull();
    expect(sniffInboxVideo(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBeNull();
    expect(sniffInboxVideo(new Uint8Array())).toBeNull();
  });
});

describe("readMp4VideoMetadata", () => {
  test("moov at the end: length and the video track's size, read in a few small seeks", async () => {
    const film = mp4({ duration: 461.3, width: 1920, height: 1080, mdatBytes: 200_000 });
    const r = reader(film);
    const meta = await readMp4VideoMetadata(r.read, film.length);
    expect(meta).toEqual({ hasVideoTrack: true, duration_ms: 461300, width: 1920, height: 1080 });
    // Never the mdat: each read is a header-sized slice.
    expect(r.reads.every((read) => read.length <= 96)).toBe(true);
    expect(r.reads.reduce((n, read) => n + read.length, 0)).toBeLessThan(1500);
  });

  test("moov first (faststart), version-1 boxes, and a 64-bit mdat", async () => {
    for (const options of [{ moovAtEnd: false }, { version: 1 as const }, { largeMdat: true }]) {
      const film = mp4({ duration: 151.04, width: 1280, height: 720, ...options });
      expect(await readMp4VideoMetadata(reader(film).read, film.length)).toEqual({ hasVideoTrack: true, duration_ms: 151040, width: 1280, height: 720 });
    }
  });

  test("a 461 MB film: moov after the mdat is reached by seeking past it", async () => {
    const whole = mp4({ duration: 7 * 60 + 41, mdatBytes: 16 });
    // Rebuild the same layout with a huge mdat: ftyp, an mdat header naming 461 MB, then the moov.
    const ftypEnd = whole.readUInt32BE(0);
    const ftyp = whole.subarray(0, ftypEnd);
    const moov = whole.subarray(ftypEnd + 8 + 16);
    const mdatBytes = 461 * 1024 * 1024;
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + mdatBytes);
    header.write("mdat", 4, "latin1");
    const film = sparse(Buffer.concat([ftyp, header]), mdatBytes, moov);
    expect(await readMp4VideoMetadata(film.read, film.size)).toEqual({ hasVideoTrack: true, duration_ms: 461000, width: 1920, height: 1080 });
  });

  test("an audio-only file says so; a truncated or moov-less file gives nothing", async () => {
    const audio = mp4({ tracks: ["soun"] });
    expect((await readMp4VideoMetadata(reader(audio).read, audio.length))?.hasVideoTrack).toBe(false);
    const cut = mp4().subarray(0, 120);
    expect(await readMp4VideoMetadata(reader(cut).read, cut.length)).toBeNull();
  });

  test("a hostile box size never loops or reads past the end", async () => {
    const film = Buffer.from(mp4());
    // An mdat that claims to be larger than the file.
    film.writeUInt32BE(0xfffffff0, film.readUInt32BE(0));
    expect(await readMp4VideoMetadata(reader(film).read, film.length)).toBeNull();
  });
});

describe("decideInboxAttachmentKind for films", () => {
  test("video with the header's metadata; WebM with none; audio stays a file; an AVIF stays an image", async () => {
    const film = mp4({ duration: 102.4, width: 640, height: 360 });
    const meta = await readMp4VideoMetadata(reader(film).read, film.length);
    expect(decideInboxAttachmentKind("/x/cut.mp4", film.subarray(0, INBOX_ATTACHMENT_HEAD_BYTES), false, film.length, meta)).toEqual({
      kind: "video",
      media_type: "video/mp4",
      duration_ms: 102400,
      width: 640,
      height: 360,
    });
    // A film named anything: the bytes decide.
    expect(decideInboxAttachmentKind("/x/clip.bin", film, false, film.length, meta).kind).toBe("video");
    expect(decideInboxAttachmentKind("/x/demo.webm", ebml("webm"), false, 600, null)).toEqual({ kind: "video", media_type: "video/webm" });
    expect(decideInboxAttachmentKind("/x/demo.mkv", ebml("matroska"), false, 600, null)).toEqual({ kind: "file" });
    const audio = mp4({ tracks: ["soun"] });
    expect(decideInboxAttachmentKind("/x/voice.mp4", audio, false, audio.length, await readMp4VideoMetadata(reader(audio).read, audio.length))).toEqual({ kind: "file" });
    // Brands alone (no header walked) still say video.
    expect(decideInboxAttachmentKind("/x/cut.mov", mp4({ major: "qt  ", compatible: ["qt  "] }), false, 0, null)).toEqual({ kind: "video", media_type: "video/quicktime" });
    const avif = mp4({ major: "avif", compatible: ["avif", "mif1", "miaf"] });
    expect(decideInboxAttachmentKind("/x/photo.avif", avif, false, avif.length, null).kind).not.toBe("video");
  });
});

describe.skipIf(!ffmpegCan("libx264") || !ffmpegCan("libvpx"))("a real encoder's output", () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-video-ffmpeg-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("H.264 MP4 (moov at the end, and faststart) and VP8 WebM", async () => {
    for (const faststart of [false, true]) {
      const path = join(dir, `clip-${faststart}.mp4`);
      encodeWithFfmpeg(path, "mp4", { faststart });
      const bytes = readFileSync(path);
      expect(sniffInboxVideo(bytes)).toBe("video/mp4");
      const meta = await readMp4VideoMetadata(reader(bytes).read, bytes.length);
      expect(meta?.hasVideoTrack).toBe(true);
      expect(meta?.width).toBe(320);
      expect(meta?.height).toBe(240);
      expect(Math.abs((meta?.duration_ms ?? 0) - 2000)).toBeLessThan(150);
    }
    const webm = join(dir, "clip.webm");
    encodeWithFfmpeg(webm, "webm");
    expect(sniffInboxVideo(readFileSync(webm))).toBe("video/webm");
  });
});
