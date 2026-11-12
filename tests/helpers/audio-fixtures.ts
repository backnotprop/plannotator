function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

function u16le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

export function wav(options: { seconds?: number; rate?: number } = {}): Buffer {
  const { seconds = 2, rate = 8000 } = options;
  const count = Math.round(seconds * rate);
  const data = Buffer.alloc(count);
  for (let i = 0; i < count; i++) {
    const envelope = 0.15 + 0.6 * Math.abs(Math.sin((Math.PI * 2 * i) / count));
    data[i] = Math.round(128 + 120 * envelope * Math.sin((2 * Math.PI * 440 * i) / rate));
  }
  const fmt = Buffer.concat([Buffer.from("fmt "), u32le(16), u16le(1), u16le(1), u32le(rate), u32le(rate), u16le(1), u16le(8)]);
  const body = Buffer.concat([Buffer.from("WAVE"), fmt, Buffer.from("data"), u32le(count), data]);
  return Buffer.concat([Buffer.from("RIFF"), u32le(body.length), body]);
}

export function id3(bodyBytes = 100): Buffer {
  const size = Buffer.from([(bodyBytes >> 21) & 0x7f, (bodyBytes >> 14) & 0x7f, (bodyBytes >> 7) & 0x7f, bodyBytes & 0x7f]);
  return Buffer.concat([Buffer.from("ID3"), Buffer.from([4, 0, 0]), size, Buffer.alloc(bodyBytes)]);
}

export function mp3(options: { frames?: number; tag?: boolean; xingFrames?: number } = {}): Buffer {
  const { frames = 8, tag = true, xingFrames } = options;
  const frame = (first: boolean) => {
    const b = Buffer.alloc(417);
    b.set([0xff, 0xfb, 0x90, 0x00]);
    if (first && xingFrames !== undefined) {
      b.write("Xing", 36, "latin1");
      b.set(u32be(1), 40);
      b.set(u32be(xingFrames), 44);
    }
    return b;
  };
  return Buffer.concat([...(tag ? [id3()] : []), ...Array.from({ length: frames }, (_, i) => frame(i === 0))]);
}

export function adts(frames = 6): Buffer {
  const length = 200;
  const frame = () => {
    const b = Buffer.alloc(length);
    b.set([0xff, 0xf1, 0x50, 0x80 | ((length >> 11) & 3), (length >> 3) & 0xff, ((length & 7) << 5) | 0x1f, 0xfc]);
    return b;
  };
  return Buffer.concat(Array.from({ length: frames }, frame));
}

function oggPage(packet: Buffer, granule: number, type: number, sequence: number): Buffer {
  const segments: number[] = [];
  let left = packet.length;
  while (left >= 255) {
    segments.push(255);
    left -= 255;
  }
  segments.push(left);
  const header = Buffer.alloc(27);
  header.write("OggS", 0, "latin1");
  header[4] = 0;
  header[5] = type;
  header.writeUInt32LE(granule % 2 ** 32, 6);
  header.writeUInt32LE(Math.floor(granule / 2 ** 32), 10);
  header.writeUInt32LE(0x1234, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = segments.length;
  return Buffer.concat([header, Buffer.from(segments), packet]);
}

export function ogg(codec: "opus" | "vorbis" | "theora", options: { seconds?: number; rate?: number; preSkip?: number; bodyBytes?: number } = {}): Buffer {
  const { seconds = 3.5, rate = 44100, preSkip = 312, bodyBytes = 2000 } = options;
  const first =
    codec === "opus"
      ? Buffer.concat([Buffer.from("OpusHead"), Buffer.from([1, 2]), u16le(preSkip), u32le(48000), u16le(0), Buffer.from([0])])
      : codec === "vorbis"
        ? Buffer.concat([Buffer.from([1]), Buffer.from("vorbis"), u32le(0), Buffer.from([2]), u32le(rate), u32le(0), u32le(128000), u32le(0), Buffer.from([0xb8, 1])])
        : Buffer.concat([Buffer.from([0x80]), Buffer.from("theora"), Buffer.alloc(30)]);
  const granuleRate = codec === "opus" ? 48000 : rate;
  const last = Math.round(seconds * granuleRate) + (codec === "opus" ? preSkip : 0);
  return Buffer.concat([oggPage(first, 0, 2, 0), oggPage(Buffer.alloc(bodyBytes, 0x33), 1000, 0, 1), oggPage(Buffer.alloc(100, 0x44), last, 4, 2)]);
}

export function flac(options: { seconds?: number; rate?: number } = {}): Buffer {
  const { seconds = 4.25, rate = 48000 } = options;
  const samples = Math.round(seconds * rate);
  const info = Buffer.alloc(34);
  info.writeUInt16BE(4096, 0);
  info.writeUInt16BE(4096, 2);
  info[10] = (rate >> 12) & 0xff;
  info[11] = (rate >> 4) & 0xff;
  info[12] = ((rate & 0xf) << 4) | (1 << 1) | 0;
  info[13] = (15 << 4) | (Math.floor(samples / 2 ** 32) & 0xf);
  info.writeUInt32BE(samples % 2 ** 32, 14);
  return Buffer.concat([Buffer.from("fLaC"), Buffer.from([0x80, 0, 0, 34]), info, Buffer.alloc(256, 0x55)]);
}

function element(id: number[], body: Buffer, unknownSize = false): Buffer {
  const size = unknownSize ? Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]) : body.length < 127 ? Buffer.from([0x80 | body.length]) : Buffer.from([0x40 | (body.length >> 8), body.length & 0xff]);
  return Buffer.concat([Buffer.from(id), size, body]);
}

export function webm(tracks: ("video" | "audio")[]): Buffer {
  const doc = Buffer.from("webm", "latin1");
  const header = element([0x1a, 0x45, 0xdf, 0xa3], Buffer.concat([Buffer.from([0x42, 0x86, 0x81, 0x01]), Buffer.from([0x42, 0x82, 0x80 | doc.length]), doc]));
  const info = element([0x15, 0x49, 0xa9, 0x66], Buffer.from([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]));
  const entries = tracks.map((kind, i) =>
    element([0xae], Buffer.concat([Buffer.from([0xd7, 0x81, i + 1]), Buffer.from([0x83, 0x81, kind === "video" ? 1 : 2]), element([0x86], Buffer.from(kind === "video" ? "V_VP8" : "A_OPUS"))])),
  );
  const tracksElement = element([0x16, 0x54, 0xae, 0x6b], Buffer.concat(entries));
  const segment = element([0x18, 0x53, 0x80, 0x67], Buffer.concat([info, tracksElement, Buffer.from([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), Buffer.alloc(64, 0x22)]), true);
  return Buffer.concat([header, segment]);
}
