/**
 * Pull request authors' profile pictures for the Pull requests list (the owner, on #2608: the row's top-left spot is
 * always the author's picture). The window's CSP stays `img-src 'self' data: blob:`: it never loads a remote image
 * itself. The Inbox fetches the picture and serves it from its own origin.
 *
 * What is fetched: only the avatar URL the forge's own answer gave for an author of a PR in the current list
 * (`allow`), never a URL or login the page names. A login the last list did not return is refused before anything
 * runs.
 * - https only; at most 3 redirects, each https. The URL's host must be public (as the favicons check it) unless it
 *   is the forge host itself (a GitHub Enterprise or self-managed GitLab on a private network serves its own).
 * - One deadline for the whole fetch (4 s); at most 256 KB a picture.
 * - Only an image: `image/*` declared, and bytes that sniff as PNG, JPEG, GIF or WebP; never SVG.
 * - Under the test sandbox (`PLANNOTATOR_TEST_SANDBOX`) only, an `http://127.0.0.1:<port>/` or
 *   `http://localhost:<port>/` URL is fetched too: the break-ui harness and the e2e serve fake pictures there.
 * Cached on disk under `<inbox dir>/pull-avatars/`: a picture is fresh for a day, then fetched again (the old one is
 * served if that fails); at most 8 MB in all, the oldest dropped first. A miss is remembered for an hour, in memory.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { join } from "node:path";
import { sniffImageContentType } from "@plannotator/shared/review-image";
import { isPublicName, readCapped } from "./inbox-card-favicons";

export type PullAvatarMiss = "unknown" | "not_https" | "not_public" | "redirect" | "status" | "not_image" | "too_big" | "timeout" | "unavailable";
export type PullAvatarResult = { ok: true; type: string; body: Uint8Array<ArrayBuffer> } | { ok: false; miss: PullAvatarMiss };

export interface PullAvatarOptions {
  /** Where the pictures are kept (the Inbox's own data dir, `inbox/pull-avatars`). */
  dir: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  lookup?: (hostname: string) => Promise<string[]>;
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  /** All pictures together, on disk. */
  capBytes?: number;
  freshMs?: number;
  missMs?: number;
  /** Where `PLANNOTATOR_TEST_SANDBOX` is read (default `process.env`). */
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
  /** The logins the list returned, per forge host, with the avatar URL the forge gave (replaces the host's set). */
  allow(host: string, avatars: Readonly<Record<string, string>>): void;
  /** Whether a login is one the list returned on that host. */
  known(host: string, login: string): boolean;
  get(host: string, login: string): Promise<PullAvatarResult>;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

const keyOf = (host: string, login: string) => `${host.toLowerCase()}\n${login.toLowerCase()}`;

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
  /** https, or (the test sandbox only) http on this computer's loopback; never credentials in the URL. */
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

  /** Keeps the pictures under the cap: the least recently fetched go first. */
  function trim(): void {
    let entries: { base: string; size: number; at: number }[];
    try {
      const names = readdirSync(options.dir).filter((n) => n.endsWith(".img"));
      entries = names.map((name) => {
        const base = join(options.dir, name.slice(0, -4));
        const size = statSync(`${base}.img`).size;
        let at = 0;
        try {
          at = (JSON.parse(readFileSync(`${base}.json`, "utf8")) as { at?: number }).at ?? 0;
        } catch {
          // No meta: the first to go.
        }
        return { base, size, at };
      });
    } catch {
      return;
    }
    let total = entries.reduce((sum, e) => sum + e.size, 0);
    for (const entry of entries.sort((a, b) => a.at - b.at)) {
      if (total <= capBytes) break;
      rmSync(`${entry.base}.img`, { force: true });
      rmSync(`${entry.base}.json`, { force: true });
      total -= entry.size;
    }
  }

  function writeDisk(key: string, url: string, type: string, body: Uint8Array): void {
    try {
      mkdirSync(options.dir, { recursive: true });
      writeFileSync(`${fileOf(key)}.img`, body);
      writeFileSync(`${fileOf(key)}.json`, JSON.stringify({ type, at: now(), url }));
      trim();
    } catch {
      // A full or read-only disk: served this once, fetched again next time.
    }
  }

  async function load(host: string, start: string): Promise<PullAvatarResult> {
    let url: URL;
    try {
      url = new URL(start);
    } catch {
      return { ok: false, miss: "not_https" };
    }
    if (!fetchable(url)) return { ok: false, miss: "not_https" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
    aborted.catch(() => {});
    const deadline = <T,>(work: Promise<T>): Promise<T> => Promise.race([work, aborted]);
    // The forge's own host may be private (an enterprise forge on its network); any other host must be public.
    const allowed = async (target: URL) =>
      (target.protocol === "http:" && sandbox && LOOPBACK.has(target.hostname)) ||
      target.hostname.toLowerCase() === host.split(":")[0]!.toLowerCase() ||
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

  return {
    allow(host, avatars) {
      const prefix = `${host.toLowerCase()}\n`;
      for (const key of [...urls.keys()]) if (key.startsWith(prefix)) urls.delete(key);
      for (const [login, url] of Object.entries(avatars)) if (login && url) urls.set(keyOf(host, login), url);
    },
    known(host, login) {
      return urls.has(keyOf(host, login));
    },
    async get(host, login) {
      const key = keyOf(host, login);
      const url = urls.get(key);
      if (!url) return { ok: false, miss: "unknown" };
      const disk = readDisk(key);
      // The same picture, read within the day: no fetch.
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
          misses.set(key, { at: now(), miss: result.miss });
          // A failed refetch serves the picture already kept.
          return disk ? { ok: true, type: disk.type, body: disk.body } : result;
        })
        .finally(() => inFlight.delete(key));
      inFlight.set(key, run);
      return run;
    },
  };
}
