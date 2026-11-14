import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { isIP } from "node:net";
import { INBOX_LIVE_URL_MAX, type InboxLiveSiteRef } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";

export type WebFraming = "framed" | "not_framed" | "unknown";

export const WEB_FRAMING_TIMEOUT_MS = 5_000;

export interface WebFramingDeps {
  resolve?: (hostname: string) => Promise<string[]>;
  fetchHeaders?: (url: URL, address: string, signal: AbortSignal) => Promise<{ status: number; headers: IncomingHttpHeaders }>;
  timeoutMs?: number;
}

export function isWebPrototype(target: string): boolean {
  return /^https:/i.test(target.trim());
}

export function checkWebPrototypeUrl(raw: string): URL {
  const refuse = (message: string): never => {
    throw new InboxError("validation_error", `url: ${message}`, { field: "url" });
  };
  if (raw.length > INBOX_LIVE_URL_MAX) refuse(`at most ${INBOX_LIVE_URL_MAX} characters.`);
  let url: URL | null = null;
  try {
    url = new URL(raw.trim());
  } catch {
    refuse(`${raw.trim()} is not an address.`);
  }
  if (url!.protocol !== "https:") refuse("give an https:// address.");
  if (url!.username || url!.password) refuse("no user name or password in the address.");
  url!.hash = "";
  return url!;
}

function v4Number(ip: string): number {
  return ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);
}

const V4_PRIVATE: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function publicV4(ip: string): boolean {
  const n = v4Number(ip);
  return !V4_PRIVATE.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4Number(base) / 2 ** (32 - bits)));
}

function v6Words(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, "");
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (tail) {
    const n = v4Number(tail[1]!);
    text = `${text.slice(0, -tail[1]!.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const left = head ? head.split(":") : [];
  const right = rest ? rest.split(":") : [];
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  const words = [...left, ...Array(Math.max(fill, 0)).fill("0"), ...right].map((w) => parseInt(w, 16));
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

function embeddedV4(words: number[]): string {
  return [words[6]! >> 8, words[6]! & 0xff, words[7]! >> 8, words[7]! & 0xff].join(".");
}

export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const kind = isIP(bare);
  if (kind === 4) return publicV4(bare);
  if (kind !== 6) return false;
  const w = v6Words(bare);
  if (!w) return false;
  const zeros = (n: number) => w.slice(0, n).every((x) => x === 0);
  if (zeros(5) && w[5] === 0xffff) return publicV4(embeddedV4(w));
  if (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((x) => x === 0)) return publicV4(embeddedV4(w));
  if ((w[0]! & 0xe000) !== 0x2000) return false;
  if (w[0] === 0x2001 && (w[1] === 0x0db8 || w[1]! < 0x0200)) return false;
  if (w[0] === 0x2002) return false;
  return true;
}

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, ""))) return false;
  if (!host.includes(".")) return true;
  return /(^|\.)(localhost|local|internal|lan|home\.arpa|ts\.net)$/.test(host);
}

async function resolveAll(hostname: string): Promise<string[]> {
  return (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);
}

export function headersOver(url: URL, address: string, signal: AbortSignal, send: typeof request = request): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((done, fail) => {
    const req = send(
      {
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: Number(url.port || 443),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { accept: "text/html", "user-agent": "Plannotator" },
        agent: false,
        signal,
        lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
          const family = isIP(address);
          if (options?.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        }) as unknown as RequestOptions["lookup"],
      },
      (res) => {
        done({ status: res.statusCode ?? 0, headers: res.headers });
        res.destroy();
        req.destroy();
      },
    );
    req.on("error", fail);
    req.end();
  });
}

function values(header: string | string[] | undefined): string[] {
  return (Array.isArray(header) ? header : header === undefined ? [] : [header]).flatMap((value) => value.split(","));
}

function mayMatchAnyone(source: string): boolean {
  return source.includes("*") || /^[a-z][a-z0-9+.-]*:$/i.test(source);
}

export function framingOfHeaders(status: number, headers: IncomingHttpHeaders): WebFraming {
  if (status >= 300 && status < 400) return "unknown";
  const xfo = values(headers["x-frame-options"]).map((value) => value.trim().toLowerCase());
  if (xfo.includes("deny") || xfo.includes("sameorigin")) return "not_framed";
  const ancestors = values(headers["content-security-policy"])
    .flatMap((policy) => policy.split(";"))
    .map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name?.toLowerCase() === "frame-ancestors")
    .map(([, ...sources]) => sources);
  if (ancestors.some((sources) => !sources.some(mayMatchAnyone))) return "not_framed";
  return "framed";
}

async function framingOf(url: URL, deps: WebFramingDeps, signal: AbortSignal): Promise<WebFraming> {
  if (url.protocol !== "https:" || url.username || url.password) return "unknown";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isPrivateHostname(host)) return "unknown";
  const addresses = isIP(host) ? [host] : await (deps.resolve ?? resolveAll)(host);
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) return "unknown";
  if (signal.aborted) return "unknown";
  const answer = await (deps.fetchHeaders ?? ((u: URL, a: string, s: AbortSignal) => headersOver(u, a, s)))(url, addresses[0]!, signal);
  return framingOfHeaders(answer.status, answer.headers);
}

export async function checkWebFraming(url: URL, deps: WebFramingDeps = {}): Promise<WebFraming> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<WebFraming>((done) => {
    timer = setTimeout(() => done("unknown"), deps.timeoutMs ?? WEB_FRAMING_TIMEOUT_MS);
  });
  try {
    return await Promise.race([framingOf(url, deps, controller.signal).catch((): WebFraming => "unknown"), limit]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function defaultWebFraming(url: URL): Promise<WebFraming> {
  if (process.env.PLANNOTATOR_TEST_SANDBOX) return Promise.resolve("unknown");
  return checkWebFraming(url);
}

export function webFrameCsp(origin: string): string {
  return ["default-src 'none'", "style-src 'unsafe-inline'", `frame-src ${origin}`, "frame-ancestors 'self'", "base-uri 'none'", "form-action 'none'"].join("; ");
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function webFramePage(site: Pick<InboxLiveSiteRef, "url">): Response {
  const url = checkWebPrototypeUrl(site.url);
  const body =
    '<!doctype html><html><head><meta charset="utf-8"><title>Prototype</title>'
    + "<style>html,body{margin:0;height:100%;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style>"
    + `</head><body><iframe src="${escapeAttribute(url.href)}" title="${escapeAttribute(url.href)}" referrerpolicy="no-referrer"></iframe></body></html>`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": webFrameCsp(url.origin),
      "X-Frame-Options": "SAMEORIGIN",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

export function prototypesNotFramedText(urls: readonly string[]): string {
  return urls
    .map((url) => ` Prototype: ${url}: this page does not allow being shown inside another page, so the person opens it in a new tab. To show it in the Inbox, let it be framed (no X-Frame-Options DENY or SAMEORIGIN; frame-ancestors allowing it).`)
    .join("");
}
