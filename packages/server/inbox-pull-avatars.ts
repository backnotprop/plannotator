import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { lookup as dnsLookup } from "node:dns/promises";
import { join } from "node:path";
import { sniffImageContentType } from "@plannotator/shared/review-image";
import { isPublicName, readCapped } from "./inbox-card-favicons";

export type PullAvatarMiss = "unknown" | "not_https" | "not_public" | "redirect" | "status" | "not_image" | "too_big" | "timeout" | "unavailable";
export type PullAvatarResult = { ok: true; type: string; body: Uint8Array<ArrayBuffer> } | { ok: false; miss: PullAvatarMiss };

export interface PullAvatarOptions {
  dir: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  lookup?: (hostname: string) => Promise<string[]>;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  capBytes?: number;
  freshMs?: number;
  missMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
}

export const PULL_AVATAR_TIMEOUT_MS = 4000;
export const PULL_AVATAR_MAX_BYTES = 256 * 1024;
export const PULL_AVATAR_CAP_BYTES = 8 * 1024 * 1024;
const FRESH_MS = 24 * 60 * 60 * 1000;
const MISS_MS = 60 * 60 * 1000;
const MAX_REDIRECTS = 3;
const SERVED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface PullAvatars {
  allow(host: string, avatars: Readonly<Record<string, string>>): void;
  allowOnly(lists: readonly { host: string; avatars: Readonly<Record<string, string>> }[]): void;
  known(host: string, login: string): boolean;
  missesHeld(): number;
  get(host: string, login: string): Promise<PullAvatarResult>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost"]);
const PICTURE_PX = 96;

function sizeForAFace(url: URL): void {
  const github = url.hostname === "avatars.githubusercontent.com" || url.hostname.startsWith("avatars.") || url.pathname.startsWith("/avatars/");
  if (!github) return;
  url.searchParams.delete("size");
  url.searchParams.set("s", String(PICTURE_PX));
}

const keyOf = (host: string, login: string) => `${host.toLowerCase()}\n${login.toLowerCase()}`;

function forgeOrigin(host: string): { hostname: string; port: string } | null {
  if (!host || /[/?#@\\\s]/.test(host)) return null;
  try {
    const url = new URL(`https://${host}/`);
    return { hostname: url.hostname, port: url.port };
  } catch {
    return null;
  }
}

export function createPullAvatars(options: PullAvatarOptions): PullAvatars {
  const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
  const lookup = options.lookup ?? (async (hostname: string) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? PULL_AVATAR_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? PULL_AVATAR_MAX_BYTES;
  const capBytes = options.capBytes ?? PULL_AVATAR_CAP_BYTES;
  const freshMs = options.freshMs ?? FRESH_MS;
  const missMs = options.missMs ?? MISS_MS;
  const urls = new Map<string, string>();
  const misses = new Map<string, { at: number; miss: PullAvatarMiss }>();
  const inFlight = new Map<string, Promise<PullAvatarResult>>();
  const sandbox = !!(options.env ?? process.env).PLANNOTATOR_TEST_SANDBOX;
  const fetchable = (url: URL) => !url.username && !url.password && (url.protocol === "https:" || (sandbox && url.protocol === "http:" && LOOPBACK.has(url.hostname)));

  const fileOf = (key: string) => join(options.dir, createHash("sha256").update(key).digest("hex").slice(0, 32));

  function readDisk(key: string): { type: string; at: number; url: string; body: Uint8Array<ArrayBuffer> } | null {
    try {
      const meta = JSON.parse(readFileSync(`${fileOf(key)}.json`, "utf8")) as { type?: unknown; at?: unknown; url?: unknown };
      if (typeof meta.type !== "string" || !SERVED.has(meta.type) || typeof meta.at !== "number" || typeof meta.url !== "string") return null;
      const bytes = readFileSync(`${fileOf(key)}.img`);
      return { type: meta.type, at: meta.at, url: meta.url, body: new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as Uint8Array<ArrayBuffer> };
    } catch {
      return null;
    }
  }

  let used: number | null = null;
  let writtenDuringTrim = 0;
  let trimming: Promise<void> | null = null;

  function trim(): Promise<void> {
    if (trimming) return trimming;
    writtenDuringTrim = 0;
    trimming = (async () => {
      let total = 0;
      try {
        const names = (await readdir(options.dir)).filter((n) => n.endsWith(".img"));
        const entries = await Promise.all(
          names.map(async (name) => {
            const base = join(options.dir, name.slice(0, -4));
            const size = await stat(`${base}.img`).then((s) => s.size, () => 0);
            const at = await readFile(`${base}.json`, "utf8").then(
              (text) => (JSON.parse(text) as { at?: number }).at ?? 0,
              () => 0,
            );
            return { base, size, at };
          }),
        );
        total = entries.reduce((sum, e) => sum + e.size, 0);
        if (total > capBytes) {
          for (const entry of entries.sort((a, b) => a.at - b.at)) {
            if (total <= capBytes) break;
            await rm(`${entry.base}.img`, { force: true });
            await rm(`${entry.base}.json`, { force: true });
            total -= entry.size;
          }
        }
      } catch {
        used = null;
        return;
      }
      used = total + writtenDuringTrim;
    })().finally(() => {
      trimming = null;
      if (writtenDuringTrim > 0 && used !== null && used > capBytes) void trim();
    });
    return trimming;
  }

  function writeDisk(key: string, url: string, type: string, body: Uint8Array): void {
    let replaced = 0;
    try {
      mkdirSync(options.dir, { recursive: true });
      try {
        replaced = statSync(`${fileOf(key)}.img`).size;
      } catch {
        replaced = 0;
      }
      writeFileSync(`${fileOf(key)}.img`, body);
      writeFileSync(`${fileOf(key)}.json`, JSON.stringify({ type, at: now(), url }));
    } catch {
      return;
    }
    const delta = body.byteLength - replaced;
    if (trimming) writtenDuringTrim += delta;
    else if (used !== null) used += delta;
    if (used === null || used > capBytes) void trim();
  }

  function rememberMiss(key: string, miss: PullAvatarMiss): void {
    const at = now();
    for (const [k, m] of misses) if (at - m.at >= missMs) misses.delete(k);
    misses.set(key, { at, miss });
  }

  async function load(host: string, start: string): Promise<PullAvatarResult> {
    let url: URL;
    try {
      url = new URL(start);
    } catch {
      return { ok: false, miss: "not_https" };
    }
    if (!fetchable(url)) return { ok: false, miss: "not_https" };
    sizeForAFace(url);
    const named = forgeOrigin(host);
    const forge = named ? { hostname: named.hostname, port: url.hostname === named.hostname ? url.port : named.port } : null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
    aborted.catch(() => {});
    const deadline = <T,>(work: Promise<T>): Promise<T> => Promise.race([work, aborted]);
    const allowed = async (target: URL) =>
      (target.protocol === "http:" && sandbox && LOOPBACK.has(target.hostname)) ||
      (!!forge && target.protocol === "https:" && target.hostname === forge.hostname && target.port === forge.port) ||
      (await deadline(isPublicName(target.hostname, lookup)));
    try {
      for (let hop = 0; ; hop++) {
        if (!(await allowed(url))) return { ok: false, miss: "not_public" };
        const response = await deadline(fetchImpl(url.href, { method: "GET", redirect: "manual", credentials: "omit", headers: { accept: "image/*" }, signal: controller.signal }));
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => {});
          const location = response.headers.get("location");
          if (!location || hop + 1 > MAX_REDIRECTS) return { ok: false, miss: "redirect" };
          let next: URL;
          try {
            next = new URL(location, url);
          } catch {
            return { ok: false, miss: "redirect" };
          }
          if (!fetchable(next)) return { ok: false, miss: "redirect" };
          url = next;
          continue;
        }
        if (response.status !== 200) {
          await response.body?.cancel().catch(() => {});
          return { ok: false, miss: "status" };
        }
        const declared = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
        if (!declared.startsWith("image/") || declared === "image/svg+xml") {
          await response.body?.cancel().catch(() => {});
          return { ok: false, miss: "not_image" };
        }
        const length = Number(response.headers.get("content-length"));
        if (Number.isFinite(length) && length > maxBytes) {
          await response.body?.cancel().catch(() => {});
          return { ok: false, miss: "too_big" };
        }
        const body = await readCapped(response, maxBytes, deadline);
        if (!body) return { ok: false, miss: "too_big" };
        const type = sniffImageContentType(body);
        if (!type || !SERVED.has(type)) return { ok: false, miss: "not_image" };
        return { ok: true, type, body };
      }
    } catch {
      return { ok: false, miss: controller.signal.aborted ? "timeout" : "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  }

  const allow = (host: string, avatars: Readonly<Record<string, string>>) => {
    const prefix = `${host.toLowerCase()}\n`;
    for (const key of [...urls.keys()]) if (key.startsWith(prefix)) urls.delete(key);
    for (const [login, url] of Object.entries(avatars)) if (login && url) urls.set(keyOf(host, login), url);
  };

  return {
    allow,
    allowOnly(lists) {
      const listed = new Set(lists.map((l) => l.host.toLowerCase()));
      for (const key of [...urls.keys()]) if (!listed.has(key.slice(0, key.indexOf("\n")))) urls.delete(key);
      for (const { host, avatars } of lists) allow(host, avatars);
    },
    missesHeld: () => misses.size,
    known(host, login) {
      return urls.has(keyOf(host, login));
    },
    async get(host, login) {
      const key = keyOf(host, login);
      const url = urls.get(key);
      if (!url) return { ok: false, miss: "unknown" };
      const disk = readDisk(key);
      if (disk && disk.url === url && now() - disk.at < freshMs) return { ok: true, type: disk.type, body: disk.body };
      const missed = misses.get(key);
      if (missed && now() - missed.at < missMs) return disk ? { ok: true, type: disk.type, body: disk.body } : { ok: false, miss: missed.miss };
      const pending = inFlight.get(key);
      if (pending) return pending;
      const run = load(host, url)
        .then((result): PullAvatarResult => {
          if (result.ok) {
            misses.delete(key);
            writeDisk(key, url, result.type, result.body);
            return result;
          }
          rememberMiss(key, result.miss);
          return disk ? { ok: true, type: disk.type, body: disk.body } : result;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, run);
      return run;
    },
  };
}
