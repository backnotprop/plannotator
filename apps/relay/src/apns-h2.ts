/**
 * One HTTP/2 request over a Cloudflare `connect()` socket, for Apple's push
 * service (APNs), which speaks HTTP/2 only.
 *
 * Why not `fetch`: a Worker's `fetch` reaches origins over HTTP/1.1 under
 * workerd, and APNs refuses HTTP/1.1, so the request dies with "Network
 * connection lost" (the mobile spike, 2026-10-08, item 6). Over a TLS socket
 * from `connect()`, this hand-written HTTP/2 exchange gets Apple's own answer.
 *
 * Deliberately small and single-purpose: one connection per request, stream
 * 1 only, the client preface and an empty SETTINGS, one HEADERS frame and one
 * DATA frame, then the response's HEADERS and DATA, then close. HPACK without
 * a dynamic table: `:method POST` and `:scheme` are static-table entries,
 * `:path` and `:authority` are literals with a static-table name, every other
 * header is a literal without indexing. Of the response headers only
 * `:status` is decoded (it is always the first header, and on a fresh
 * connection it can only come from the static table or a literal); the body
 * is the DATA frames as text.
 *
 * No imports beyond `cloudflare:sockets`: this file is meant to be copied as
 * it is by another Worker that sends to APNs (Workspaces' push sender).
 * Apache 2.0, as the rest of this repository allows.
 */
import { connect } from "cloudflare:sockets";

export interface H2Request {
  hostname: string;
  port: number;
  /** TLS on the socket (APNs). Off only for a local HTTP/2 server speaking cleartext (h2c, prior knowledge). */
  tls: boolean;
  /** The request path, for example `/3/device/<token>`. */
  path: string;
  /** Lowercase names, in order; never pseudo-headers. */
  headers: readonly (readonly [string, string])[];
  body: Uint8Array;
  /** Whole exchange, from connect to the last DATA frame. */
  timeoutMs?: number;
}

export interface H2Response {
  status: number;
  body: string;
}

const PREFACE = new TextEncoder().encode("PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
const DATA = 0x0;
const HEADERS = 0x1;
const RST_STREAM = 0x3;
const SETTINGS = 0x4;
const PING = 0x6;
const GOAWAY = 0x7;
const CONTINUATION = 0x9;
const END_STREAM = 0x1;
const ACK = 0x1;
const END_HEADERS = 0x4;
const PADDED = 0x8;
const PRIORITY = 0x20;
const STREAM = 1;
/** The default SETTINGS_MAX_FRAME_SIZE, which this client never raises. */
const MAX_FRAME_SIZE = 16_384;
/** The most of an answer's header block, or of its body, the client keeps. */
const MAX_KEPT_BYTES = 8_192;

/** HPACK integer with an N-bit prefix (RFC 7541 section 5.1); `first` carries the bits above the prefix. */
function hpackInt(value: number, prefixBits: number, first: number): number[] {
  const max = (1 << prefixBits) - 1;
  if (value < max) return [first | value];
  const out = [first | max];
  value -= max;
  while (value >= 128) {
    out.push((value & 127) | 128);
    value >>>= 7;
  }
  out.push(value);
  return out;
}

const encoder = new TextEncoder();

/** A string literal, never Huffman-coded. */
function hpackString(value: string): number[] {
  const bytes = encoder.encode(value);
  return [...hpackInt(bytes.length, 7, 0), ...bytes];
}

function headerBlock(request: H2Request, authority: string): Uint8Array {
  const block: number[] = [
    0x83, // :method POST (static index 3)
    request.tls ? 0x87 : 0x86, // :scheme https (7) or http (6)
    ...hpackInt(4, 4, 0x00), ...hpackString(request.path), // :path, name from static index 4, without indexing
    ...hpackInt(1, 4, 0x00), ...hpackString(authority), // :authority, name from static index 1, without indexing
  ];
  for (const [name, value] of request.headers) block.push(0x00, ...hpackString(name), ...hpackString(value));
  return new Uint8Array(block);
}

function frame(type: number, flags: number, stream: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + payload.length);
  out[0] = (payload.length >>> 16) & 255;
  out[1] = (payload.length >>> 8) & 255;
  out[2] = payload.length & 255;
  out[3] = type;
  out[4] = flags;
  out[5] = (stream >>> 24) & 127;
  out[6] = (stream >>> 16) & 255;
  out[7] = (stream >>> 8) & 255;
  out[8] = stream & 255;
  out.set(payload, 9);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** HPACK integer decode: [value, next offset]. */
function readInt(block: Uint8Array, at: number, prefixBits: number): [number, number] {
  const max = (1 << prefixBits) - 1;
  let value = block[at]! & max;
  at += 1;
  if (value < max) return [value, at];
  let shift = 0;
  for (;;) {
    const byte = block[at]!;
    at += 1;
    value += (byte & 127) * 2 ** shift;
    shift += 7;
    if ((byte & 128) === 0) return [value, at];
  }
}

/** The Huffman codes of the ten digits (RFC 7541 Appendix B): all a status value can hold. */
const HUFFMAN_DIGITS: Record<string, string> = {
  "00000": "0", "00001": "1", "00010": "2", "011001": "3", "011010": "4",
  "011011": "5", "011100": "6", "011101": "7", "011110": "8", "011111": "9",
};

function readStatusValue(block: Uint8Array, at: number): string {
  const huffman = (block[at]! & 0x80) !== 0;
  const [length, start] = readInt(block, at, 7);
  const bytes = block.subarray(start, start + length);
  if (!huffman) return new TextDecoder().decode(bytes);
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  let code = "";
  for (const bit of bits) {
    code += bit;
    const digit = HUFFMAN_DIGITS[code];
    if (digit) {
      out += digit;
      code = "";
      if (out.length === 3) break;
    }
  }
  return out;
}

const STATIC_STATUS: Record<number, number> = { 8: 200, 9: 204, 10: 206, 11: 304, 12: 400, 13: 404, 14: 500 };

/** `:status` from a response header block: its first field, after any table size update. */
export function decodeStatus(block: Uint8Array): number | null {
  let at = 0;
  while (at < block.length && (block[at]! & 0xe0) === 0x20) at = readInt(block, at, 5)[1]; // dynamic table size update
  if (at >= block.length) return null;
  const first = block[at]!;
  if (first & 0x80) return STATIC_STATUS[readInt(block, at, 7)[0]] ?? null; // indexed field
  const prefix = (first & 0xc0) === 0x40 ? 6 : 4; // with incremental indexing, or without / never indexed
  const [nameIndex, next] = readInt(block, at, prefix);
  if (nameIndex !== 8) return null; // 8 is :status in the static table
  const status = Number(readStatusValue(block, next));
  return Number.isInteger(status) && status >= 100 ? status : null;
}

/** A frame's header block fragment, without padding and priority fields. */
function fragment(flags: number, payload: Uint8Array): Uint8Array {
  let start = 0;
  let end = payload.length;
  if (flags & PADDED) {
    end -= payload[0]!;
    start += 1;
  }
  if (flags & PRIORITY) start += 5;
  return payload.subarray(start, end);
}

/** Send one request and read its answer. Throws on a transport failure, a reset stream, an error GOAWAY, a frame over 16 KiB, an answer over 8 KiB, or the timeout. */
export async function h2Request(request: H2Request): Promise<H2Response> {
  const authority = request.port === 443 ? request.hostname : `${request.hostname}:${request.port}`;
  const socket = connect({ hostname: request.hostname, port: request.port }, { secureTransport: request.tls ? "on" : "off", allowHalfOpen: false });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("HTTP/2 request timed out")), request.timeoutMs ?? 10_000);
  });
  const exchange = async (): Promise<H2Response> => {
    await writer.write(
      concat([
        PREFACE,
        frame(SETTINGS, 0, 0, new Uint8Array()),
        frame(HEADERS, END_HEADERS, STREAM, headerBlock(request, authority)),
        frame(DATA, END_STREAM, STREAM, request.body),
      ]),
    );
    // One buffer with a read offset: what is unread is at most one partial frame (16 KiB) plus the last read.
    let buffer = new Uint8Array(MAX_FRAME_SIZE + 9);
    let at = 0;
    let filled = 0;
    let headerBytes: Uint8Array[] = [];
    let headerSize = 0;
    let status: number | null = null;
    const body: Uint8Array[] = [];
    let bodySize = 0;
    let goingAway = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(goingAway ? "HTTP/2 GOAWAY before the answer" : "HTTP/2 connection closed before the answer");
      if (filled + value.length > buffer.length) {
        const unread = buffer.subarray(at, filled);
        const next = filled - at + value.length > buffer.length ? new Uint8Array(filled - at + value.length) : buffer;
        next.set(unread, 0);
        buffer = next;
        filled -= at;
        at = 0;
      }
      buffer.set(value, filled);
      filled += value.length;
      while (filled - at >= 9) {
        const length = (buffer[at]! << 16) | (buffer[at + 1]! << 8) | buffer[at + 2]!;
        // The client never raises SETTINGS_MAX_FRAME_SIZE, so a longer frame is a protocol error (RFC 9113 4.2).
        if (length > MAX_FRAME_SIZE) throw new Error(`HTTP/2 frame of ${length} bytes, over ${MAX_FRAME_SIZE}`);
        if (filled - at < 9 + length) break;
        const type = buffer[at + 3]!;
        const flags = buffer[at + 4]!;
        const stream = ((buffer[at + 5]! & 127) << 24) | (buffer[at + 6]! << 16) | (buffer[at + 7]! << 8) | buffer[at + 8]!;
        const payload = buffer.slice(at + 9, at + 9 + length);
        at += 9 + length;
        if (at === filled) at = filled = 0;
        if (type === SETTINGS && !(flags & ACK)) await writer.write(frame(SETTINGS, ACK, 0, new Uint8Array()));
        else if (type === PING && !(flags & ACK)) await writer.write(frame(PING, ACK, 0, payload));
        else if (type === GOAWAY) {
          // A graceful GOAWAY (NO_ERROR) whose last stream id covers stream 1 still answers it: keep reading.
          const lastStream = ((payload[0]! & 127) << 24) | (payload[1]! << 16) | (payload[2]! << 8) | payload[3]!;
          const code = ((payload[4]! << 24) | (payload[5]! << 16) | (payload[6]! << 8) | payload[7]!) >>> 0;
          if (code !== 0 || lastStream < STREAM) throw new Error(`HTTP/2 GOAWAY: ${new TextDecoder().decode(payload.subarray(8))}`);
          goingAway = true;
        } else if (stream !== STREAM) continue;
        else if (type === RST_STREAM) throw new Error("HTTP/2 stream reset");
        else if (type === HEADERS || type === CONTINUATION) {
          const part = type === HEADERS ? fragment(flags, payload) : payload;
          headerSize += part.length;
          if (headerSize > MAX_KEPT_BYTES) throw new Error("HTTP/2 answer headers too large");
          headerBytes.push(part);
          if (flags & END_HEADERS) {
            if (status === null) status = decodeStatus(concat(headerBytes));
            headerBytes = [];
            headerSize = 0;
          }
          if (type === HEADERS && flags & END_STREAM) return { status: status ?? 0, body: "" };
        } else if (type === DATA) {
          const part = fragment(flags & PADDED, payload);
          bodySize += part.length;
          // Apple's answers are a few dozen bytes of JSON: a longer one is not Apple.
          if (bodySize > MAX_KEPT_BYTES) throw new Error("HTTP/2 answer body too large");
          body.push(part);
          if (flags & END_STREAM) return { status: status ?? 0, body: new TextDecoder().decode(concat(body)) };
        }
      }
    }
  };
  const run = exchange();
  // After a timeout the exchange is abandoned; its own failure, when the socket closes, is nobody's to handle.
  run.catch(() => {});
  try {
    return await Promise.race([run, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    try {
      await socket.close();
    } catch {
      // Already closed.
    }
  }
}
