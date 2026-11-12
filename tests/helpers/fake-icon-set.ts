import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { deflateSync } from 'node:zlib';

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function png(size: number, pixel: (x: number, y: number) => [number, number, number, number], padTo = 0): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4);
  }
  const head = new Uint8Array(13);
  const view = new DataView(head.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  head.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw))];
  const sofar = parts.reduce((sum, p) => sum + p.length, 0) + 12;
  if (padTo > sofar + 12) parts.push(chunk('tEXt', new TextEncoder().encode(`Comment\0${'.'.repeat(padTo - sofar - 12 - 8)}`)));
  parts.push(chunk('IEND', new Uint8Array()));
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const hsl = (h: number, s: number, l: number): [number, number, number] => {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
};

export function creature(n: number, padTo = 0): Uint8Array {
  let seed = (n * 2654435761) >>> 0;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const body = hsl((n * 47) % 360, 0.62, 0.55);
  const dark = hsl((n * 47) % 360, 0.5, 0.22);
  const on = new Set<string>();
  for (let y = 3; y < 14; y++) for (let x = 2; x < 8; x++) if (rand() < (y > 5 && y < 12 && x > 3 ? 0.92 : 0.45)) on.add(`${x},${y}`);
  const filled = (x: number, y: number) => on.has(`${x < 8 ? x : 15 - x},${y}`);
  const eye = (x: number, y: number) => y === 7 && (x === 5 || x === 10);
  return png(16, (x, y) => {
    if (filled(x, y)) return eye(x, y) ? [20, 20, 28, 255] : [...body, 255];
    if (filled(x - 1, y) || filled(x + 1, y) || filled(x, y - 1) || filled(x, y + 1)) return [...dark, 255];
    return [0, 0, 0, 0];
  }, padTo);
}

export interface FakeIconSet {
  url: string;
  pointer: string;
  hits: Map<string, number>;
  total: () => number;
  heal: () => void;
  stop: () => Promise<void>;
}

export async function serveFakeIconSet(options: { id?: string; name?: string; count?: number; notImage?: number[]; huge?: number[]; failFrom?: number; redirect?: Record<number, string>; delayMs?: number; names?: boolean; padTo?: number } = {}): Promise<FakeIconSet> {
  const id = options.id ?? 'blobs';
  const count = options.count ?? 24;
  const hits = new Map<string, number>();
  let failFrom = options.failFrom ?? Infinity;
  const NAMES = ['mossy', 'mote', 'pip', 'bramble', 'glim', 'tuft', 'nib', 'quill', 'sprocket', 'wisp', 'burr', 'fennel'];
  let base = '';
  const answer = async (path: string): Promise<{ status: number; type?: string; body?: Uint8Array | string; location?: string }> => {
    const json = (value: unknown) => ({ status: 200, type: 'application/json', body: JSON.stringify(value) });
    if (path === '/index.json') return json({ v: 1, sets: [{ id, name: options.name ?? 'Blobs', count, manifest: `${base}/${id}.json` }] });
    if (path === `/${id}.json`) return json({ v: 1, name: options.name ?? 'Blobs', count, icon: `${base}/icons/{n}.png`, ...(options.names === false ? {} : { names: `${base}/names.json` }), pixelated: true, size: 16, licence: 'CC0-1.0' });
    if (path === '/names.json') return json({ results: Array.from({ length: count }, (_, i) => ({ name: `${NAMES[i % NAMES.length]}${i >= NAMES.length ? `-${Math.floor(i / NAMES.length) + 1}` : ''}` })) });
    const match = /^\/icons\/(\d+)\.png$/.exec(path);
    if (!match) return { status: 404, body: 'no' };
    const n = Number(match[1]);
    if (options.delayMs) await new Promise((done) => setTimeout(done, options.delayMs));
    if (n >= failFrom) return { status: 503, body: 'busy' };
    if (options.redirect?.[n]) return { status: 302, location: options.redirect[n]! };
    if (options.notImage?.includes(n)) return { status: 200, type: 'image/png', body: '<html><script>alert(1)</script></html>' };
    if (options.huge?.includes(n)) {
      const big = new Uint8Array(600 * 1024);
      big.set(creature(n));
      return { status: 200, type: 'image/png', body: big };
    }
    if (n < 1 || n > count) return { status: 404, body: 'no' };
    return { status: 200, type: 'image/png', body: creature(n, options.padTo) };
  };
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    void answer(path).then((a) => {
      res.statusCode = a.status;
      if (a.type) res.setHeader('content-type', a.type);
      if (a.location) res.setHeader('location', a.location);
      res.end(a.body ?? '');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    pointer: `${base}/index.json`,
    hits,
    total: () => [...hits.values()].reduce((a, b) => a + b, 0),
    heal: () => {
      failFrom = Infinity;
    },
    stop: () =>
      new Promise<void>((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      }),
  };
}
