/**
 * Recordings from their bytes (audio.ts) and the kind a send gives them
 * (decideInboxAttachmentKind): MP3, AAC, M4A, WAV, Ogg, FLAC and WebM audio
 * are `audio` with their media type and, where the header holds it, their
 * length; a film, an Ogg holding video and plain binaries are not. The
 * containers are built in the test (tests/helpers/audio-fixtures.ts).
 */
import { describe, expect, test } from "bun:test";
import { adts, flac, id3, mp3, ogg, wav, webm } from "../../../tests/helpers/audio-fixtures";
import { ebml, mp4 } from "../../../tests/helpers/video-fixtures";
import { audioDurationMsFromHead, inboxAudioServedType, oggDurationMs, sniffInboxAudio, webmTrackKinds } from "./audio";
import { decideInboxAttachmentKind, INBOX_ATTACHMENT_HEAD_BYTES } from "./attachments";
import { readMp4VideoMetadata } from "./video";

const head = (bytes: Buffer) => bytes.subarray(0, INBOX_ATTACHMENT_HEAD_BYTES);

function reader(bytes: Buffer) {
  return async (position: number, length: number) => bytes.subarray(position, position + length);
}

describe("sniffInboxAudio", () => {
  test("each container by its first bytes, whatever its name", () => {
    expect(sniffInboxAudio(wav())).toBe("audio/wav");
    expect(sniffInboxAudio(mp3())).toBe("audio/mpeg");
    expect(sniffInboxAudio(mp3({ tag: false }))).toBe("audio/mpeg");
    expect(sniffInboxAudio(adts())).toBe("audio/aac");
    expect(sniffInboxAudio(ogg("opus"))).toBe("audio/ogg");
    expect(sniffInboxAudio(ogg("vorbis"))).toBe("audio/ogg");
    expect(sniffInboxAudio(flac())).toBe("audio/flac");
    expect(sniffInboxAudio(mp4({ major: "M4A ", compatible: ["M4A ", "mp42", "isom"], tracks: ["soun"] }))).toBe("audio/mp4");
    expect(sniffInboxAudio(webm(["audio"]))).toBe("audio/webm");
  });

  test("a film, an Ogg holding video, a lone frame sync and other binaries are not recordings", () => {
    // A film's brands are the video sniffer's; an audio-only MP4 is decided by its tracks (below).
    expect(sniffInboxAudio(mp4())).toBeNull();
    expect(sniffInboxAudio(webm(["video", "audio"]))).toBeNull();
    // A WebM whose tracks the head does not reach stays a video.
    expect(sniffInboxAudio(ebml("webm"))).toBeNull();
    expect(sniffInboxAudio(ogg("theora"))).toBeNull();
    // One MPEG frame header followed by bytes that are not the next frame: not an MP3.
    const lone = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413, 0), Buffer.from("PK\x03\x04"), Buffer.alloc(200)]);
    expect(sniffInboxAudio(lone)).toBeNull();
    expect(sniffInboxAudio(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).toBeNull();
    expect(sniffInboxAudio(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]))).toBeNull();
    expect(sniffInboxAudio(new Uint8Array())).toBeNull();
  });

  test("an ID3 tag longer than the head still names an MP3", () => {
    expect(sniffInboxAudio(head(Buffer.concat([id3(200_000), mp3({ tag: false })])))).toBe("audio/mpeg");
  });

  test("the type served is the sniffed one, or audio/mp4 for an MP4 holding only sound", () => {
    expect(inboxAudioServedType(mp4({ tracks: ["soun"] }))).toBe("audio/mp4");
    expect(inboxAudioServedType(wav())).toBe("audio/wav");
    expect(inboxAudioServedType(Buffer.from("plain text"))).toBeNull();
  });

  test("a WebM's tracks are read from its head", () => {
    expect(webmTrackKinds(webm(["audio"]))).toEqual({ video: false, audio: true });
    expect(webmTrackKinds(webm(["video", "audio"]))).toEqual({ video: true, audio: true });
    expect(webmTrackKinds(ebml("webm"))).toBeNull();
  });
});

describe("a recording's length", () => {
  test("WAV, FLAC and MP3 (Xing frame count, else its constant bitrate) from the head", () => {
    const tone = wav({ seconds: 2.5, rate: 8000 });
    expect(audioDurationMsFromHead(tone, tone.length, "audio/wav")).toBe(2500);
    const lossless = flac({ seconds: 4.25, rate: 48000 });
    expect(audioDurationMsFromHead(lossless, lossless.length, "audio/flac")).toBe(4250);
    // 100 frames of 1152 samples at 44.1 kHz.
    const vbr = mp3({ xingFrames: 100 });
    expect(audioDurationMsFromHead(vbr, vbr.length, "audio/mpeg")).toBe(Math.round((100 * 1152 * 1000) / 44100));
    // A constant 128 kbps over the bytes after the tag.
    const cbr = mp3({ frames: 40 });
    expect(audioDurationMsFromHead(cbr, cbr.length, "audio/mpeg")).toBe(Math.round(((40 * 417 * 8) / 128000) * 1000));
    expect(audioDurationMsFromHead(adts(), 1200, "audio/aac")).toBeNull();
  });

  test("an Ogg's from its last page's granule, less Opus's pre-skip", () => {
    const opus = ogg("opus", { seconds: 3.5 });
    expect(oggDurationMs(opus, opus.subarray(-500))).toBe(3500);
    const vorbis = ogg("vorbis", { seconds: 7.25, rate: 22050 });
    expect(oggDurationMs(vorbis, vorbis.subarray(-500))).toBe(7250);
    expect(oggDurationMs(opus, Buffer.alloc(100))).toBeNull();
  });
});

describe("decideInboxAttachmentKind for recordings", () => {
  test("kind audio with its media type and length; the name never decides", async () => {
    const tone = wav({ seconds: 2 });
    expect(decideInboxAttachmentKind("/x/voice-note.wav", head(tone), false, tone.length, null)).toEqual({ kind: "audio", media_type: "audio/wav", duration_ms: 2000 });
    expect(decideInboxAttachmentKind("/x/take.bin", head(tone), false, tone.length, null).kind).toBe("audio");
    const song = mp3({ xingFrames: 100 });
    expect(decideInboxAttachmentKind("/x/song.mp3", head(song), false, song.length, null)).toMatchObject({ kind: "audio", media_type: "audio/mpeg" });
    expect(decideInboxAttachmentKind("/x/a.aac", adts(), false, 1200, null)).toEqual({ kind: "audio", media_type: "audio/aac" });
    expect(decideInboxAttachmentKind("/x/a.flac", flac(), false, 400, null)).toEqual({ kind: "audio", media_type: "audio/flac", duration_ms: 4250 });
    expect(decideInboxAttachmentKind("/x/memo.webm", webm(["audio"]), false, 400, null)).toEqual({ kind: "audio", media_type: "audio/webm" });
    // An Ogg's length comes from the tail read at send (readInboxVideoMetadata), passed in as the metadata.
    expect(decideInboxAttachmentKind("/x/a.opus", ogg("opus"), false, 3000, { hasVideoTrack: false, duration_ms: 3500 })).toEqual({ kind: "audio", media_type: "audio/ogg", duration_ms: 3500 });
  });

  test("an M4A, and an MP4 whose tracks hold no video, are recordings with the length its header walk read", async () => {
    const m4a = mp4({ major: "M4A ", compatible: ["M4A ", "mp42", "isom"], tracks: ["soun"], duration: 61.5 });
    const meta = await readMp4VideoMetadata(reader(m4a), m4a.length);
    expect(decideInboxAttachmentKind("/x/memo.m4a", head(m4a), false, m4a.length, meta)).toEqual({ kind: "audio", media_type: "audio/mp4", duration_ms: 61500 });
    const named = mp4({ tracks: ["soun"], duration: 12 });
    const walked = await readMp4VideoMetadata(reader(named), named.length);
    expect(decideInboxAttachmentKind("/x/voice.mp4", head(named), false, named.length, walked)).toEqual({ kind: "audio", media_type: "audio/mp4", duration_ms: 12000 });
  });

  test("a film stays a video; a WebM with video and audio tracks stays a video", () => {
    expect(decideInboxAttachmentKind("/x/cut.mp4", mp4(), false, 0, null).kind).toBe("video");
    expect(decideInboxAttachmentKind("/x/demo.webm", webm(["video", "audio"]), false, 400, null)).toEqual({ kind: "video", media_type: "video/webm" });
    expect(decideInboxAttachmentKind("/x/demo.ogv", ogg("theora"), false, 400, null).kind).toBe("file");
  });
});
