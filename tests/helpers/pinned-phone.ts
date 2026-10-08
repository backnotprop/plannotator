/**
 * A scripted phone on the same Wi-Fi: one HTTP/1.1 request over a TLS socket
 * whose certificate is pinned by SHA-256, as the iPhone app checks it
 * (adr/implementation/inbox-mobile.md, section 3: the leaf certificate's
 * SHA-256 equals the fingerprint the phone holds; no host name, chain or
 * dates). The pin is checked when the handshake ends, before a byte of the
 * request is written: a wrong fingerprint sends nothing.
 *
 * The request line goes out exactly as given (no URL normalization), so a
 * door review can send encoded path tricks and any Host or Origin header.
 */
import { createHash } from "node:crypto";
import tls from "node:tls";

export class PinMismatchError extends Error {
  constructor(readonly presented: string) {
    super(`The server's certificate does not match the pinned fingerprint (it presented ${presented}).`);
  }
}

export interface PinnedAnswer {
  status: number;
  headers: Record<string, string>;
  text: string;
  /** The SHA-256 of the certificate the server presented. */
  presented: string;
}

/** Connect, check the pin, then hand back the open socket. Rejects with PinMismatchError on a wrong certificate. */
export function pinnedSocket(address: string, fingerprint: string): Promise<tls.TLSSocket> {
  const at = address.lastIndexOf(":");
  const host = address.slice(0, at);
  const port = Number(address.slice(at + 1));
  return new Promise((resolve, reject) => {
    // The phone holds a fingerprint, not a CA: the pin below replaces the chain check (contract section 3).
    // nosemgrep: plannotator.network.tls-verification-disabled
    const socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
      const presented = createHash("sha256").update(socket.getPeerCertificate().raw).digest("hex");
      if (presented !== fingerprint) {
        socket.destroy();
        reject(new PinMismatchError(presented));
        return;
      }
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function decodeChunked(body: Buffer): Buffer {
  const parts: Buffer[] = [];
  let at = 0;
  while (at < body.length) {
    const end = body.indexOf("\r\n", at);
    if (end < 0) break;
    const size = parseInt(body.subarray(at, end).toString("latin1"), 16);
    if (!size) break;
    parts.push(body.subarray(end + 2, end + 2 + size));
    at = end + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

/**
 * One request through the pinned socket. `headers` are sent as given; Host
 * defaults to the address and `Connection: close` is added.
 */
export async function pinnedRequest(
  address: string,
  fingerprint: string,
  init: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<PinnedAnswer> {
  const socket = await pinnedSocket(address, fingerprint);
  const presented = createHash("sha256").update(socket.getPeerCertificate().raw).digest("hex");
  const headers: Record<string, string> = { Host: address, ...init.headers, Connection: "close" };
  if (init.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(init.body));
  const head = [`${init.method ?? "GET"} ${init.path} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => {
      const raw = Buffer.concat(chunks);
      const split = raw.indexOf("\r\n\r\n");
      if (split < 0) return reject(new Error(`No HTTP answer: ${raw.toString("latin1").slice(0, 200)}`));
      const [statusLine, ...lines] = raw.subarray(0, split).toString("latin1").split("\r\n");
      const answerHeaders: Record<string, string> = {};
      for (const line of lines) {
        const colon = line.indexOf(":");
        answerHeaders[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      let body = raw.subarray(split + 4);
      if (answerHeaders["transfer-encoding"]?.toLowerCase() === "chunked") body = decodeChunked(body);
      resolve({ status: Number(statusLine!.split(" ")[1]), headers: answerHeaders, text: body.toString("utf8"), presented });
    });
    socket.write(init.body === undefined ? head : head + init.body);
  });
}
