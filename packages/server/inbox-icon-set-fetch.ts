/** Fetchable icon sets: a small remote manifest, downloaded into the data folder on one click. http(s) only, no redirect or link to a private address unless the person's own pointer is on one, at most 3 redirects each checked, size and count caps, and only the five image types are kept. */

import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { InboxIconSet, InboxIconSetIcon, InboxIconSetListing } from "@plannotator/core/inbox-types";
import { sniffImageContentType } from "@plannotator/shared/review-image";
import { AGENT_ICON_MAX_BYTES } from "./inbox-agent-icons";
import { trimPng } from "./inbox-icon-trim";

export const INBOX_ICON_SETS_DIR = "icon-sets";
export const INBOX_ICON_SETS_POINTER_DEFAULT = "https://plannotator.ai/assets/icon-sets/v1/index.json";

export const ICON_SET_CAPS = {
  pointerBytes: 64 * 1024,
  manifestBytes: 256 * 1024,
  namesBytes: 2 * 1024 * 1024,
  iconBytes: AGENT_ICON_MAX_BYTES,
  icons: 2000,
  setBytes: 64 * 1024 * 1024,
  redirects: 3,
  timeoutMs: 20_000,
  together: 10,
  retryWaitsMs: [2_000, 8_000, 20_000],
} as const;

const POINTER_FRESH_MS = 60 * 60 * 1000;
const POINTER_MISSING_MS = 10 * 60 * 1000;

const SET_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const EXT: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg" };
const TYPE_OF_EXT = Object.fromEntries(Object.entries(EXT).map(([type, ext]) => [ext, type])) as Readonly<Record<string, string>>;
const ICON_FILE = /^(\d{1,5})\.(png|jpg|gif|webp|svg)$/;

function v4Private(ip: string): boolean {
  const [a = 0, b = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return v4Private(ip);
  if (kind !== 6) return true;
  const low = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(low);
  if (mapped) return v4Private(mapped[1]!);
  if (low === "::" || low === "::1") return true;
  return /^f[cd]/.test(low) || /^fe[89ab]/.test(low) || /^ff/.test(low);
}

export type HostKind = "private" | "public";
export async function classifyHost(hostname: string): Promise<HostKind> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPrivateAddress(host) ? "private" : "public";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return "private";
  try {
    const found = await lookup(host, { all: true });
    return found.length === 0 || found.some((entry) => isPrivateAddress(entry.address)) ? "private" : "public";
  } catch {
    return "private";
  }
}

export type Got = { ok: true; bytes: Uint8Array<ArrayBuffer> } | { ok: false; reason: "bad_url" | "private" | "redirects" | "status" | "too_big" | "network"; status?: number };

export interface FetchPolicy {
  fetch: typeof fetch;
  classify: (hostname: string) => Promise<HostKind>;
  allowPrivate: boolean;
}

/** GET under the policy: http(s) only, each redirect checked again, the body cut off past `max`. One deadline for the whole GET, so a link that stalls without closing is given up. */
export async function carefulGet(raw: string, max: number, policy: FetchPolicy, timeoutMs: number = ICON_SET_CAPS.timeoutMs): Promise<Got> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => {
      controller.abort();
      fail(new Error("timed out"));
    }, timeoutMs);
  });
  late.catch(() => {});
  try {
    return await carefulGetBefore(raw, max, policy, controller.signal, late);
  } finally {
    clearTimeout(timer);
  }
}

async function carefulGetBefore(raw: string, max: number, policy: FetchPolicy, signal: AbortSignal, late: Promise<never>): Promise<Got> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  for (let hop = 0; hop <= ICON_SET_CAPS.redirects; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "bad_url" };
    if (url.username || url.password) return { ok: false, reason: "bad_url" };
    if (!policy.allowPrivate && (await policy.classify(url.hostname)) === "private") return { ok: false, reason: "private" };
    let res: Response;
    try {
      res = await Promise.race([policy.fetch(url, { redirect: "manual", signal, headers: { accept: "*/*" } }), late]);
    } catch {
      return { ok: false, reason: "network" };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      void res.body?.cancel().catch(() => {});
      try {
        url = new URL(res.headers.get("location")!, url);
      } catch {
        return { ok: false, reason: "bad_url" };
      }
      continue;
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => {});
      return { ok: false, reason: "status", status: res.status };
    }
    const length = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(length) && length > max) {
      void res.body?.cancel().catch(() => {});
      return { ok: false, reason: "too_big" };
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      const reader = res.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), late]).catch((cause: unknown) => {
            void reader.cancel().catch(() => {});
            throw cause;
          });
          if (done) break;
          total += value.byteLength;
          if (total > max) {
            void reader.cancel().catch(() => {});
            return { ok: false, reason: "too_big" };
          }
          chunks.push(value);
        }
      }
    } catch {
      return { ok: false, reason: "network" };
    }
    const bytes = new Uint8Array(total) as Uint8Array<ArrayBuffer>;
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return { ok: true, bytes };
  }
  return { ok: false, reason: "redirects" };
}

interface PointerEntry {
  id: string;
  name: string;
  count: number;
  manifest: string;
}

interface KeptSet {
  v: 1;
  id: string;
  name: string;
  count: number;
  start: number;
  icon: string;
  mirrors: string[];
  pixelated?: boolean;
  size?: number;
  mono?: boolean;
  zoom?: number;
  trim?: true;
  licence?: string;
  credit?: string;
  local?: true;
  icons: InboxIconSetIcon[];
}

const text = (value: unknown, max: number): string | undefined => (typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined);
const isPattern = (value: unknown): value is string => typeof value === "string" && value.length <= 2048 && /\{n3?\}/.test(value);

function readPointer(bytes: Uint8Array, builtIn: ReadonlySet<string>): PointerEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return [];
  }
  const file = value as { v?: unknown; sets?: unknown } | null;
  if (!file || file.v !== 1 || !Array.isArray(file.sets)) return [];
  const out: PointerEntry[] = [];
  for (const raw of file.sets.slice(0, 50)) {
    const entry = raw as Record<string, unknown> | null;
    const id = typeof entry?.id === "string" && SET_ID.test(entry.id) && !builtIn.has(entry.id) ? entry.id : null;
    const name = text(entry?.name, 80);
    const manifest = text(entry?.manifest, 2048);
    const count = typeof entry?.count === "number" && Number.isSafeInteger(entry.count) && entry.count > 0 ? Math.min(entry.count, ICON_SET_CAPS.icons) : null;
    if (id && name && manifest && count && !out.some((kept) => kept.id === id)) out.push({ id, name, count, manifest });
  }
  return out;
}

function niceName(raw: string): string {
  const name = raw.trim().slice(0, 80);
  if (/[A-Z ]/.test(name)) return name;
  const spaced = name.replace(/[-_]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function namesFrom(value: unknown): string[] {
  const list = Array.isArray(value) ? value : Array.isArray((value as { results?: unknown } | null)?.results) ? ((value as { results: unknown[] }).results as unknown[]) : [];
  return list.map((item) => (typeof item === "string" ? item : typeof (item as { name?: unknown } | null)?.name === "string" ? (item as { name: string }).name : ""));
}

export const iconUrl = (pattern: string, n: number) => pattern.replaceAll("{n3}", String(n).padStart(3, "0")).replaceAll("{n}", String(n));

export interface IconSetFetcher {
  list(remote: boolean): Promise<InboxIconSet[]>;
  listing(id: string): InboxIconSetListing | null;
  read(id: string, icon: string): { type: string; body: Uint8Array<ArrayBuffer> } | null;
  get(id: string): Promise<InboxIconSet | null>;
  resume(): void;
  running(id: string): Promise<void> | null;
}

export function createIconSetFetcher(options: {
  dir: string;
  pointer: string | null;
  builtIn: ReadonlySet<string>;
  fetch?: typeof fetch;
  classify?: (hostname: string) => Promise<HostKind>;
  now?: () => number;
  retryWaitsMs?: readonly number[];
}): IconSetFetcher {
  const { dir, pointer, builtIn } = options;
  const doFetch = options.fetch ?? fetch;
  const classify = options.classify ?? classifyHost;
  const now = options.now ?? Date.now;
  const waits = options.retryWaitsMs ?? ICON_SET_CAPS.retryWaitsMs;
  let offered: { sets: PointerEntry[]; at: number; ok: boolean; private: boolean } | null = null;
  let reading: Promise<void> | null = null;
  const runs = new Map<string, Promise<void>>();
  const failed = new Set<string>();

  const setDir = (id: string) => join(dir, id);
  const keptOf = (id: string): KeptSet | null => {
    if (!SET_ID.test(id) || builtIn.has(id)) return null;
    try {
      const value = JSON.parse(readFileSync(join(setDir(id), "set.json"), "utf8")) as KeptSet;
      return value && value.v === 1 && value.id === id && Array.isArray(value.icons) ? value : null;
    } catch {
      return null;
    }
  };
  const haveOf = (id: string): Map<string, string> => {
    const out = new Map<string, string>();
    let names: string[] = [];
    try {
      names = readdirSync(setDir(id));
    } catch {
      return out;
    }
    for (const name of names) {
      const match = ICON_FILE.exec(name);
      if (match) out.set(String(Number(match[1])), name);
    }
    return out;
  };
  const stateOf = (id: string, kept: KeptSet | null): NonNullable<InboxIconSet["get"]> => {
    const have = kept ? haveOf(id).size : 0;
    if (runs.has(id)) return { state: "getting", have };
    if (!kept) return { state: failed.has(id) ? "failed" : "none", have: 0 };
    if (existsSync(join(setDir(id), ".getting")) || failed.has(id)) return { state: "failed", have };
    return { state: "done", have };
  };
  const summary = (id: string, kept: KeptSet | null, entry?: PointerEntry): InboxIconSet => ({
    id,
    name: kept?.name ?? entry?.name ?? id,
    count: kept?.count ?? entry?.count ?? 0,
    kind: "fetchable",
    ...(kept?.pixelated ? { pixelated: true } : {}),
    ...(kept?.size ? { size: kept.size } : {}),
    ...(kept?.mono ? { mono: true } : {}),
    ...(kept?.zoom ? { zoom: kept.zoom } : {}),
    ...(kept?.credit ? { credit: kept.credit } : {}),
    ...(kept?.licence ? { licence: kept.licence } : {}),
    get: stateOf(id, kept),
  });
  const keptIds = (): string[] => {
    try {
      return readdirSync(dir).filter((name) => SET_ID.test(name) && !builtIn.has(name) && existsSync(join(dir, name, "set.json")));
    } catch {
      return [];
    }
  };

  const readOffered = async (): Promise<void> => {
    if (!pointer) return;
    if (offered && now() - offered.at < (offered.ok ? POINTER_FRESH_MS : POINTER_MISSING_MS)) return;
    if (reading) return reading;
    reading = (async () => {
      let host: URL | null = null;
      try {
        host = new URL(pointer);
      } catch {
        // A pointer that is not a URL offers nothing.
      }
      const own = host ? (await classify(host.hostname)) === "private" : false;
      const got = host ? await carefulGet(pointer, ICON_SET_CAPS.pointerBytes, { fetch: doFetch, classify, allowPrivate: own }) : null;
      offered = got?.ok ? { sets: readPointer(got.bytes, builtIn), at: now(), ok: true, private: own } : { sets: offered?.sets ?? [], at: now(), ok: false, private: own };
    })().finally(() => {
      reading = null;
    });
    return reading;
  };
  const policy = (local = offered?.private ?? false): FetchPolicy => ({ fetch: doFetch, classify, allowPrivate: local });

  const writeAtomic = (file: string, bytes: Uint8Array | string) => {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, bytes, { mode: 0o600 });
    renameSync(temp, file);
  };

  const keepManifest = async (entry: PointerEntry): Promise<KeptSet | null> => {
    const already = keptOf(entry.id);
    if (already) return already;
    const got = await carefulGet(entry.manifest, ICON_SET_CAPS.manifestBytes, policy());
    if (!got.ok) return null;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(new TextDecoder().decode(got.bytes)) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!raw || raw.v !== 1 || !isPattern(raw.icon)) return null;
    const count = typeof raw.count === "number" && Number.isSafeInteger(raw.count) && raw.count > 0 ? Math.min(raw.count, ICON_SET_CAPS.icons) : 0;
    if (!count) return null;
    const start = typeof raw.start === "number" && Number.isSafeInteger(raw.start) && raw.start >= 0 && raw.start < 100_000 ? raw.start : 1;
    let names: string[] = [];
    if (Array.isArray(raw.names)) names = namesFrom(raw.names);
    else if (typeof raw.names === "string") {
      const list = await carefulGet(raw.names, ICON_SET_CAPS.namesBytes, policy());
      if (list.ok) {
        try {
          names = namesFrom(JSON.parse(new TextDecoder().decode(list.bytes)));
        } catch {
          // No names: numbers only.
        }
      }
    }
    const fixes = raw.nameFixes && typeof raw.nameFixes === "object" && !Array.isArray(raw.nameFixes) ? (raw.nameFixes as Record<string, unknown>) : {};
    const icons: InboxIconSetIcon[] = [];
    for (let i = 0; i < count; i++) {
      const slug = names[i] ?? "";
      const fixed = typeof fixes[slug] === "string" ? (fixes[slug] as string) : "";
      icons.push({ id: String(start + i), n: start + i, name: fixed ? fixed.slice(0, 80) : slug ? niceName(slug) : `#${start + i}` });
    }
    const kept: KeptSet = {
      v: 1,
      id: entry.id,
      name: text(raw.name, 80) ?? entry.name,
      count,
      start,
      icon: raw.icon,
      mirrors: Array.isArray(raw.mirrors) ? raw.mirrors.filter(isPattern).slice(0, 4) : [],
      ...(raw.pixelated === true ? { pixelated: true } : {}),
      ...(typeof raw.size === "number" && Number.isSafeInteger(raw.size) && raw.size > 0 && raw.size <= 512 ? { size: raw.size } : {}),
      ...(raw.mono === true ? { mono: true } : {}),
      ...(raw.trim === true ? { trim: true as const } : {}),
      ...(typeof raw.zoom === "number" && raw.zoom > 1 && raw.zoom <= 3 ? { zoom: Math.round(raw.zoom * 100) / 100 } : {}),
      ...(text(raw.licence, 200) ? { licence: text(raw.licence, 200) } : {}),
      ...(text(raw.credit, 400) ? { credit: text(raw.credit, 400) } : {}),
      ...(offered?.private ? { local: true as const } : {}),
      icons,
    };
    mkdirSync(setDir(entry.id), { recursive: true, mode: 0o700 });
    writeFileSync(join(setDir(entry.id), ".getting"), "", { mode: 0o600 });
    writeAtomic(join(setDir(entry.id), "set.json"), `${JSON.stringify(kept)}\n`);
    return kept;
  };

  const fetchIcons = async (kept: KeptSet): Promise<boolean> => {
    const folder = setDir(kept.id);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(join(folder, ".getting"), "", { mode: 0o600 });
    const have = haveOf(kept.id);
    let bytesKept = 0;
    const todo = kept.icons.filter((icon) => !have.has(icon.id));
    let next = 0;
    let complete = true;
    let over = false;
    const attempt = async (icon: InboxIconSetIcon): Promise<"kept" | "refused" | "unreachable"> => {
      let unreachable = true;
      for (const pattern of [kept.icon, ...kept.mirrors]) {
        const got = await carefulGet(iconUrl(pattern, icon.n), ICON_SET_CAPS.iconBytes, policy(kept.local === true));
        if (!got.ok) {
          // A refusal of the address itself would be the same on a mirror's; a missing file might not be.
          if (got.reason === "too_big") return "refused";
          if (got.reason !== "network") unreachable = false;
          continue;
        }
        const type = sniffImageContentType(got.bytes);
        if (!type || !EXT[type]) return "refused";
        const bytes = kept.trim && type === "image/png" ? (trimPng(got.bytes) ?? got.bytes) : got.bytes;
        if (bytesKept + bytes.byteLength > ICON_SET_CAPS.setBytes || bytes.byteLength > ICON_SET_CAPS.iconBytes) {
          over = true;
          return "refused";
        }
        bytesKept += bytes.byteLength;
        writeAtomic(join(folder, `${icon.n}.${EXT[type]}`), bytes);
        return "kept";
      }
      return unreachable ? "unreachable" : "refused";
    };
    let down = false;
    const one = async (icon: InboxIconSetIcon) => {
      // A link that drops for a moment (hotel WiFi) waits and tries again, rather than running through every icon
      // left in a second and stopping short.
      for (let tries = 0; ; tries++) {
        const result = await attempt(icon);
        if (result === "kept") return;
        if (result === "refused") break;
        if (tries >= waits.length || down) {
          down = true;
          break;
        }
        await new Promise((done) => setTimeout(done, waits[tries]));
      }
      complete = false;
    };
    const worker = async () => {
      while (next < todo.length && !over && !down) await one(todo[next++]!);
    };
    await Promise.all(Array.from({ length: Math.min(ICON_SET_CAPS.together, todo.length) }, worker));
    if (complete && !over) rmSync(join(folder, ".getting"), { force: true });
    return complete && !over;
  };

  const run = (entry: PointerEntry | null, id: string): Promise<void> => {
    const running = runs.get(id);
    if (running) return running;
    const task = (async () => {
      failed.delete(id);
      const kept = keptOf(id) ?? (entry ? await keepManifest(entry) : null);
      if (!kept) {
        failed.add(id);
        return;
      }
      if (!(await fetchIcons(kept))) failed.add(id);
    })()
      .catch(() => {
        failed.add(id);
      })
      .finally(() => {
        runs.delete(id);
      });
    runs.set(id, task);
    return task;
  };

  return {
    async list(remote) {
      if (remote) await readOffered();
      const out: InboxIconSet[] = [];
      const seen = new Set<string>();
      for (const entry of offered?.sets ?? []) {
        seen.add(entry.id);
        out.push(summary(entry.id, keptOf(entry.id), entry));
      }
      for (const id of keptIds()) if (!seen.has(id)) out.push(summary(id, keptOf(id)));
      return out;
    },
    listing(id) {
      const kept = keptOf(id);
      if (!kept) return null;
      const have = haveOf(id);
      return { ...summary(id, kept), icons: kept.icons, have: kept.icons.filter((icon) => have.has(icon.id)).map((icon) => icon.id) };
    },
    read(id, icon) {
      if (!SET_ID.test(id) || builtIn.has(id) || !/^\d{1,5}$/.test(icon)) return null;
      const name = haveOf(id).get(String(Number(icon)));
      if (!name) return null;
      try {
        const bytes = readFileSync(join(setDir(id), name));
        // Sniffed again as it leaves: what is served is always one of the five types.
        const type = sniffImageContentType(bytes);
        if (!type || type !== TYPE_OF_EXT[name.split(".")[1]!]) return null;
        return { type, body: new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) as Uint8Array<ArrayBuffer> };
      } catch {
        return null;
      }
    },
    async get(id) {
      if (!SET_ID.test(id) || builtIn.has(id)) return null;
      const kept = keptOf(id);
      if (!kept) await readOffered();
      const entry = offered?.sets.find((set) => set.id === id) ?? null;
      if (!kept && !entry) return null;
      void run(entry, id);
      return summary(id, keptOf(id), entry ?? undefined);
    },
    resume() {
      for (const id of keptIds()) if (existsSync(join(setDir(id), ".getting"))) void run(null, id);
    },
    running: (id) => runs.get(id) ?? null,
  };
}

export function iconSetsPointer(env: Record<string, string | undefined> = process.env): string | null {
  const given = env.PLANNOTATOR_ICON_SETS_URL;
  if (given === undefined) return INBOX_ICON_SETS_POINTER_DEFAULT;
  const value = given.trim();
  return value === "" || value.toLowerCase() === "off" ? null : value;
}
