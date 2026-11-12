import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head.subarray(0, 4), body, tail]);
}

export function identiconPng(login: string, size = 60): Buffer {
  const hash = createHash('sha256').update(login.toLowerCase()).digest();
  const hue = (hash[0]! / 255) * 360;
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    const a = 0.55 * Math.min(0.55, 1 - 0.55);
    return Math.round((0.55 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  const ink = [f(0), f(8), f(4)];
  const paper = [240, 240, 240];
  const on = (x: number, y: number) => (hash[1 + y * 3 + Math.min(x, 4 - x)]! & 1) === 1;
  const cell = size / 6;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x - cell / 2) / cell);
      const gy = Math.floor((y - cell / 2) / cell);
      const lit = gx >= 0 && gx < 5 && gy >= 0 && gy < 5 && on(gx, gy);
      const [r, g, b] = lit ? ink : paper;
      const at = y * (size * 3 + 1) + 1 + x * 3;
      raw[at] = r!;
      raw[at + 1] = g!;
      raw[at + 2] = b!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

export interface FakeAvatars {
  origin: string;
  url: (login: string) => string;
  served: string[];
  close: () => Promise<void>;
}

export async function startFakeAvatars(): Promise<FakeAvatars> {
  const served: string[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    served.push(path);
    const match = /^\/([A-Za-z0-9._-]+)\.png$/.exec(path);
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const png = identiconPng(match[1]!);
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) }).end(png);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return { origin, url: (login) => `${origin}/${login}.png`, served, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
