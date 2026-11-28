/**
 * The launch switch: a remote on/off switch, carrying a launch link, that lets one dialog appear once per computer
 * (a Product Hunt launch). This module is the mechanism only: the strict parser, the reader that keeps the last good
 * copy in the data folder, the one-time record, and the routes. No page draws anything from it yet.
 *
 * The document, https://plannotator.ai/launch.json (apps/marketing/public/launch.json), at most 4 KB:
 *
 *   { "v": 1, "campaign": "product-hunt-2026", "on": true,
 *     "url": "https://www.producthunt.com/posts/plannotator?utm_source=plannotator",
 *     "startsAt": "2026-12-02T08:01:00Z", "endsAt": "2026-12-03T08:00:00Z" }
 *
 * The dialog's words ship in the release: the file carries only the switch, the link and the dates. Keys not listed
 * are ignored (a later version may add fields) and never kept or passed on.
 * `{ "v": 1, "campaign": "…", "on": false }` is a valid off. Anything else is off: not JSON, over 4 KB, another `v`, a
 * campaign this release does not know (`LAUNCH_CAMPAIGNS`: the words and art ship in the release), a url that is not exactly https on www.producthunt.com (no port, no
 * user info, no hash, path /posts/<slug> or /products/<slug>[/…], query only `launch=<slug>` and `utm_*` keys), dates
 * that are not ISO instants, an end not after the start, a span over 14 days. `launchActive(doc, now)`: on, and
 * startsAt <= now < endsAt, so a kept "on" copy turns itself off at endsAt with no request.
 *
 * Who asks (every gate, in order; `launchSwitchEndpoint`): no request at all when
 *  - PLANNOTATOR_LAUNCH_URL=off;
 *  - update checks are off (PLANNOTATOR_UPDATE_CHECK=0, or `updateCheck: false` in config.json);
 *  - the daily ping's environment opt-outs are set (NO_ANON_PING, DO_NOT_TRACK, a CI variable: parseTelemetryEnvOff);
 *  - under the test sandbox (PLANNOTATOR_TEST_SANDBOX or NODE_ENV=test), unless PLANNOTATOR_LAUNCH_URL is a loopback
 *    http URL (tests only); outside it the variable is ignored (but `off`), so nothing can point real apps elsewhere;
 *  - it is not a release build (release CI's compiled mark, or a host's own word: Pi's and OpenCode's release.json).
 * Those gates also close the claim: switched off means no dialog either.
 *
 * The request, from the local server only (never a page): GET, no query, no cookies, `user-agent: plannotator`, 3 s for
 * the whole answer, 4 KB cap, redirects refused. At start when due, in the background: nothing waits on it and it
 * fails silently. How often, across every process sharing the data folder (`checkedAt` in the kept file;
 * `launchRefreshMs`): every 3 hours while the kept answer is off or absent (or its launch ended), hourly while it is on
 * with startsAt still ahead, every 15 minutes while the launch is on. The dialog becomes due at startsAt from the kept
 * copy, with no request, so the "on" file must be live on the site at least 3 hours before startsAt. A 200 replaces
 * the kept copy with what it parsed to (an invalid answer keeps an off); a failure keeps the last copy. Every timer is
 * unref'd: none keeps a process alive.
 *
 * Kept: `<data dir>/launch-switch.json` `{ checkedAt, doc, shown? }` (0600, written whole, its shown marks always
 * kept). The claim reads only this and the machine state.
 * Shown once per computer, on whichever surface comes first: `launch[campaign]` in the machine state
 * (`{ shownAt, answer?: "opened" | "dismissed", answeredAt? }`), stamped by a compare-and-set inside saveConfig's lock
 * (saveConfigIf), so two surfaces stamping at once cannot both win: the first stamp stays, the other gets no. The
 * second record: the campaign in the kept file's `shown`, written after every stamp that was not taken, so a machine
 * state that cannot be saved (a hand-broken config.json) still shows it once. Neither written: it does not show (and a
 * data folder that takes no write is never offered it).
 */
import { accessSync, constants as fsConstants, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, parseTelemetryEnvOff, resolveUpdateCheck, saveConfig, saveConfigIf, type PlannotatorConfig } from "./config";
import { isMarkedReleaseBuild } from "./daily-ping";
import { getPlannotatorDataDir } from "./data-dir";

export const LAUNCH_SWITCH_URL = "https://plannotator.ai/launch.json";
export const LAUNCH_SWITCH_FILE = "launch-switch.json";
export const LAUNCH_SWITCH_MAX_BYTES = 4 * 1024;
export const LAUNCH_SWITCH_TIMEOUT_MS = 3_000;
/** While the launch is on (inside its dates): how often to ask, so switching it off reaches every app soon. */
export const LAUNCH_SWITCH_REFRESH_MS = 15 * 60 * 1000;
/** While a kept "on" waits for its startsAt. */
export const LAUNCH_SWITCH_AHEAD_REFRESH_MS = 60 * 60 * 1000;
/** While the kept answer is off or absent, or its launch has ended. */
export const LAUNCH_SWITCH_OFF_REFRESH_MS = 3 * 60 * 60 * 1000;
/** The reader's timer never wakes sooner than this. */
const LAUNCH_SWITCH_MIN_WAKE_MS = 60 * 1000;
export const LAUNCH_SWITCH_MAX_SPAN_MS = 14 * 24 * 60 * 60 * 1000;

export type LaunchDoc =
  | { v: 1; campaign: string; on: false; url?: string; startsAt?: string; endsAt?: string }
  | { v: 1; campaign: string; on: true; url: string; startsAt: string; endsAt: string };

export type LaunchAnswer = "opened" | "dismissed";

/** `launch[campaign]` in the machine state. */
export interface LaunchShownRecord {
  shownAt?: string;
  answer?: LaunchAnswer;
  answeredAt?: string;
}

export type LaunchClaim = { show: false } | { show: true; campaign: string; url: string };

// ── The parser ──

const CAMPAIGN = /^[a-z0-9-]{1,40}$/;
/**
 * The campaigns this release has words and art for (packages/ui/utils/launchDialogWords.ts,
 * apps/marketing/public/launch/<campaign>.webp). The words are fixed in the release, so a launch.json naming any other
 * campaign (a later launch, a typo) is off here: it never shows this release's words again.
 */
export const LAUNCH_CAMPAIGNS: readonly string[] = ["product-hunt-2026"];
const SLUG = "[a-z0-9-]{1,80}";
const URL_SHAPE = new RegExp(`^https://www\\.producthunt\\.com/(?:posts/${SLUG}|products/${SLUG}(?:/${SLUG})*)(?:\\?([^#]*))?$`);
const QUERY_VALUE = /^[A-Za-z0-9._-]{1,80}$/;
const LAUNCH_VALUE = new RegExp(`^${SLUG}$`);
const UTM_KEY = /^utm_[a-z]{1,20}$/;
const URL_MAX = 400;

/** The url's query: only `launch=<slug>` and `utm_*` keys, each once, each with a plain value. */
function queryOk(query: string): boolean {
  if (query === "") return false;
  const seen = new Set<string>();
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return false;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (seen.has(key)) return false;
    seen.add(key);
    if (key === "launch") {
      if (!LAUNCH_VALUE.test(value)) return false;
    } else if (!UTM_KEY.test(key) || !QUERY_VALUE.test(value)) return false;
  }
  return true;
}

/** Exactly a Product Hunt post or product page over https (see the header). */
export function launchUrlOk(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > URL_MAX) return false;
  const shape = URL_SHAPE.exec(raw);
  if (!shape) return false;
  if (shape[1] !== undefined && !queryOk(shape[1])) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // The parser's own reading must be the text as written: no normalising a port, case, dots or escapes away.
  return url.href === raw && url.protocol === "https:" && url.hostname === "www.producthunt.com" && url.port === ""
    && url.username === "" && url.password === "" && url.hash === "";
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|([+-])(\d{2}):(\d{2}))$/;

/** An ISO instant (a date, a time, and Z or an offset) that names a real moment, as milliseconds; else null. */
export function launchInstant(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  const m = INSTANT.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number, number];
  const s = Number(m[6] ?? "0");
  const ms = Number((m[7] ?? "0").padEnd(3, "0"));
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59) return null;
  const local = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const check = new Date(local);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  let offset = 0;
  if (m[8] !== "Z") {
    const oh = Number(m[10]);
    const om = Number(m[11]);
    if (oh > 23 || om > 59) return null;
    offset = (m[9] === "-" ? -1 : 1) * (oh * 60 + om) * 60_000;
  }
  return local - offset;
}

/**
 * The document from the site's bytes or text, or null (off) for anything that is not exactly the shape above. An `on:
 * false` document may still carry the other fields (a launch set up ahead): each one present must be valid too.
 */
export function parseLaunchDoc(input: string | Uint8Array): LaunchDoc | null {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > LAUNCH_SWITCH_MAX_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  return launchDocFrom(value);
}

/** The same rules for a value already parsed (the kept copy is checked again on every read). */
export function launchDocFrom(value: unknown): LaunchDoc | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  // Keys it does not know are ignored (a later version may add fields); only the ones below are kept.
  if (r.v !== 1 || typeof r.campaign !== "string" || !CAMPAIGN.test(r.campaign) || typeof r.on !== "boolean") return null;
  if (!LAUNCH_CAMPAIGNS.includes(r.campaign)) return null;
  const doc: Record<string, unknown> = { v: 1, campaign: r.campaign, on: r.on };
  if (r.url !== undefined) {
    if (!launchUrlOk(r.url)) return null;
    doc.url = r.url;
  }
  if ((r.startsAt === undefined) !== (r.endsAt === undefined)) return null;
  if (r.startsAt !== undefined) {
    const start = launchInstant(r.startsAt);
    const end = launchInstant(r.endsAt);
    if (start === null || end === null || end <= start || end - start > LAUNCH_SWITCH_MAX_SPAN_MS) return null;
    doc.startsAt = r.startsAt;
    doc.endsAt = r.endsAt;
  }
  if (r.on === true && (doc.url === undefined || doc.startsAt === undefined)) return null;
  return doc as unknown as LaunchDoc;
}

/** The switch is on now: an on document, inside [startsAt, endsAt). */
export function launchActive(doc: LaunchDoc | null | undefined, now: number): doc is Extract<LaunchDoc, { on: true }> {
  if (!doc || doc.on !== true) return false;
  const start = launchInstant(doc.startsAt);
  const end = launchInstant(doc.endsAt);
  return start !== null && end !== null && now >= start && now < end;
}

/** How long a check stays fresh, from what is kept now (the header's cadence). */
export function launchRefreshMs(doc: LaunchDoc | null | undefined, now: number): number {
  if (!doc || doc.on !== true) return LAUNCH_SWITCH_OFF_REFRESH_MS;
  const start = launchInstant(doc.startsAt);
  const end = launchInstant(doc.endsAt);
  if (start === null || end === null || now >= end) return LAUNCH_SWITCH_OFF_REFRESH_MS;
  return now < start ? LAUNCH_SWITCH_AHEAD_REFRESH_MS : LAUNCH_SWITCH_REFRESH_MS;
}

// ── Who asks ──

let releaseOverride: boolean | null = null;

/** A host that knows better than the compiled mark says whether this process is a release (OpenCode). Null: the mark. */
export function setLaunchSwitchRelease(release: boolean | null): void {
  releaseOverride = release;
}

export function launchSwitchRelease(): boolean {
  return releaseOverride ?? isMarkedReleaseBuild();
}

/** A loopback http URL (tests under the sandbox only), or null. */
function loopbackUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
    return url.protocol === "http:" && loopback && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Where this process may ask, or null for nowhere (every gate in the header). `updateCheck`: resolveUpdateCheck for
 * this process (config.json and PLANNOTATOR_UPDATE_CHECK).
 */
export function launchSwitchEndpoint(env: NodeJS.ProcessEnv, release: boolean, updateCheck: boolean): string | null {
  const override = env.PLANNOTATOR_LAUNCH_URL?.trim();
  if (override?.toLowerCase() === "off") return null;
  if (!updateCheck) return null;
  if (parseTelemetryEnvOff(env)) return null;
  if (env.PLANNOTATOR_TEST_SANDBOX || env.NODE_ENV === "test") return loopbackUrl(override);
  return release ? LAUNCH_SWITCH_URL : null;
}

/** `launchSwitchEndpoint` for this process now: its environment, config.json's update check, the release gate. */
export function launchSwitchEndpointNow(release: boolean = launchSwitchRelease()): string | null {
  return launchSwitchEndpoint(process.env, release, resolveUpdateCheck(loadConfig({ quiet: true })));
}

// ── The kept copy ──

export interface LaunchKept {
  checkedAt?: string;
  doc: LaunchDoc | null;
  /** Campaigns a surface showed on this computer: the second record of the one-time stamp (see the header). */
  shown?: string[];
}

/** The kept file's shown marks: campaign names only, each once. */
function shownMarks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((c): c is string => typeof c === "string" && CAMPAIGN.test(c)))].slice(0, 32);
}

function readKeptRaw(dataDir: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, LAUNCH_SWITCH_FILE), "utf-8")) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function readLaunchKept(dataDir: string): LaunchKept {
  const raw = readKeptRaw(dataDir);
  if (!raw) return { doc: null };
  const checkedAt = typeof raw.checkedAt === "string" && launchInstant(raw.checkedAt) !== null ? raw.checkedAt : undefined;
  const shown = shownMarks(raw.shown);
  return { ...(checkedAt ? { checkedAt } : {}), doc: launchDocFrom(raw.doc), ...(shown.length ? { shown } : {}) };
}

/** Written whole; the shown marks on disk now are always kept (a refresh never drops one another process wrote). */
function writeLaunchKept(dataDir: string, kept: LaunchKept): void {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, LAUNCH_SWITCH_FILE);
  const shown = shownMarks([...shownMarks(readKeptRaw(dataDir)?.shown), ...(kept.shown ?? [])]);
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ checkedAt: kept.checkedAt, doc: kept.doc, ...(shown.length ? { shown } : {}) })}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Mark `campaign` shown in the kept file; true when the mark reads back. Never throws. */
function markLaunchShown(dataDir: string, campaign: string): boolean {
  try {
    const kept = readLaunchKept(dataDir);
    writeLaunchKept(dataDir, { ...kept, shown: [...(kept.shown ?? []), campaign] });
    return readLaunchKept(dataDir).shown?.includes(campaign) === true;
  } catch {
    return false;
  }
}

/** Whether the data folder takes a write now (a read-only folder cannot hold either record). */
function dataDirWritable(dataDir: string): boolean {
  try {
    accessSync(dataDir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * One GET within `timeoutMs` for the whole answer: the bytes of a 200 of at most LAUNCH_SWITCH_MAX_BYTES, "invalid"
 * for a 200 that is too big, or null (a redirect, another status, offline, too slow). Never throws.
 */
export async function fetchLaunchDoc(fetcher: typeof fetch, url: string, timeoutMs: number = LAUNCH_SWITCH_TIMEOUT_MS): Promise<Uint8Array | "invalid" | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => {
      controller.abort();
      fail(new Error("timed out"));
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  late.catch(() => {});
  try {
    const res = await Promise.race([
      fetcher(url, { method: "GET", redirect: "manual", credentials: "omit", signal: controller.signal, headers: { "user-agent": "plannotator", accept: "application/json" } }),
      late,
    ]);
    if (res.status !== 200) {
      void res.body?.cancel().catch(() => {});
      return null;
    }
    const length = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(length) && length > LAUNCH_SWITCH_MAX_BYTES) {
      void res.body?.cancel().catch(() => {});
      return "invalid";
    }
    const reader = res.body?.getReader();
    if (!reader) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), late]);
      if (done) break;
      total += value.byteLength;
      if (total > LAUNCH_SWITCH_MAX_BYTES) {
        void reader.cancel().catch(() => {});
        return "invalid";
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return bytes;
  } catch {
    controller.abort();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── The one-time record ──

export interface LaunchShownStore {
  read(campaign: string): LaunchShownRecord | undefined;
  /** Write the record; true when it reached the file. */
  write(campaign: string, record: LaunchShownRecord): boolean;
  /**
   * The one-time stamp: check that no surface showed it and write `record`, as one step (no other writer between).
   * `taken`: shown or answered already (the first stamp stays). `failed`: open, but the stamp did not reach the file.
   */
  stamp(campaign: string, record: LaunchShownRecord): "stamped" | "taken" | "failed";
}

/** `launch[campaign]` as the machine state holds it, keeping only the fields written here. */
export function readLaunchShown(config: Pick<PlannotatorConfig, "launch"> | undefined, campaign: string): LaunchShownRecord | undefined {
  const all = config?.launch as unknown;
  if (!all || typeof all !== "object" || Array.isArray(all)) return undefined;
  const raw = (all as Record<string, unknown>)[campaign];
  if (raw === undefined) return undefined;
  // A hand edit that is not a record: closed, as if shown.
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { shownAt: "unknown" };
  const r = raw as Record<string, unknown>;
  const out: LaunchShownRecord = {};
  if (typeof r.shownAt === "string") out.shownAt = r.shownAt;
  if (r.answer === "opened" || r.answer === "dismissed") out.answer = r.answer;
  if (typeof r.answeredAt === "string") out.answeredAt = r.answeredAt;
  return out;
}

/** The machine state (state.json, through the locked read-merge-write); other campaigns kept as they are. */
export const configLaunchShownStore: LaunchShownStore = {
  read: (campaign) => readLaunchShown(loadConfig({ quiet: true }), campaign),
  write(campaign, record) {
    const all = loadConfig({ quiet: true }).launch;
    const others = all && typeof all === "object" && !Array.isArray(all) ? all : {};
    if (!saveConfig({ launch: { ...others, [campaign]: record } })) return false;
    const back = configLaunchShownStore.read(campaign);
    return back?.shownAt === record.shownAt && back?.answer === record.answer;
  },
  stamp(campaign, record) {
    const saved = saveConfigIf((current) => {
      const before = readLaunchShown(current, campaign);
      if (before?.shownAt || before?.answer) return null;
      const all = current.launch;
      const others = all && typeof all === "object" && !Array.isArray(all) ? all : {};
      return { launch: { ...others, [campaign]: record } };
    });
    if (saved === "declined") return "taken";
    // The lock can be unavailable (saveConfig then writes unlocked): the stamp read back says who won.
    const back = configLaunchShownStore.read(campaign);
    if (saved === "saved" && back?.shownAt === record.shownAt) return "stamped";
    return back?.shownAt || back?.answer ? "taken" : "failed";
  },
};

// ── The service ──

export interface LaunchSwitchDeps {
  dataDir: () => string;
  /** `launchSwitchEndpoint` for this process now (null: no request, and no dialog). */
  endpoint: () => string | null;
  shown: LaunchShownStore;
  fetch?: typeof fetch;
  now?: () => number;
  /** Tests: one freshness for every state (default `launchRefreshMs`). */
  refreshMs?: number;
  timeoutMs?: number;
}

export interface LaunchSwitchService {
  /** Ask the site now unless the kept check is still fresh (any process; `launchRefreshMs`) or an ask is running. Never throws. */
  refresh(): Promise<"asked" | "fresh" | "off" | "busy">;
  /** At a server's start: one refresh in the background, then one each time the kept check goes stale (unref'd timers). Once a process. */
  start(): void;
  /** May a surface show the dialog: the kept copy only (and a background refresh when due). */
  claim(): LaunchClaim;
  /**
   * The surface drew it: a compare-and-set stamping `launch[campaign].shownAt`. `{ show: false }` when another surface
   * stamped it first (that one keeps it). The kept file's mark is written too; `{ show: false }` when neither lands.
   */
  shown(campaign?: string): { show: boolean };
  /** How it ended: the link opened, or closed. Once. */
  answer(answer: LaunchAnswer, campaign?: string): { ok: boolean };
}

export function createLaunchSwitch(deps: LaunchSwitchDeps): LaunchSwitchService {
  const now = () => (deps.now ? deps.now() : Date.now());
  const freshFor = (doc: LaunchDoc | null, at: number) => deps.refreshMs ?? launchRefreshMs(doc, at);
  let running: Promise<"asked" | "fresh" | "off" | "busy"> | null = null;
  let started = false;
  const no: LaunchClaim = { show: false };
  // Campaigns this process has stamped (or tried to): never claimed here again, whatever reached the files.
  const shownHere = new Set<string>();

  /** The launch on now, and whether it is still open on this computer (neither record says shown). */
  const current = (): { doc: Extract<LaunchDoc, { on: true }>; open: boolean } | null => {
    if (!deps.endpoint()) return null;
    const kept = readLaunchKept(deps.dataDir());
    const doc = kept.doc;
    if (!launchActive(doc, now())) return null;
    if (shownHere.has(doc.campaign) || kept.shown?.includes(doc.campaign)) return { doc, open: false };
    const record = deps.shown.read(doc.campaign);
    return { doc, open: !record?.shownAt && !record?.answer };
  };
  /** When the kept check goes stale (or the kept launch starts or ends), from now. */
  const nextWakeMs = (): number => {
    const { checkedAt, doc } = readLaunchKept(deps.dataDir());
    const at = now();
    const last = checkedAt ? launchInstant(checkedAt) : null;
    let wake = last === null || last > at ? 0 : last + freshFor(doc, at) - at;
    for (const edge of doc?.on === true ? [launchInstant(doc.startsAt), launchInstant(doc.endsAt)] : []) {
      if (edge !== null && edge > at) wake = Math.min(wake, edge - at);
    }
    return Math.max(LAUNCH_SWITCH_MIN_WAKE_MS, wake);
  };

  const service: LaunchSwitchService = {
    refresh() {
      if (running) return Promise.resolve("busy");
      running = (async () => {
        try {
          const endpoint = deps.endpoint();
          if (!endpoint) return "off" as const;
          const dataDir = deps.dataDir();
          const kept = readLaunchKept(dataDir);
          const last = kept.checkedAt ? launchInstant(kept.checkedAt) : null;
          const at = now();
          if (last !== null && at - last < freshFor(kept.doc, at) && last <= at) return "fresh" as const;
          // Stamped before the request: other processes sharing the data folder wait their turn.
          writeLaunchKept(dataDir, { checkedAt: new Date(at).toISOString(), doc: kept.doc });
          const got = await fetchLaunchDoc(deps.fetch ?? fetch, endpoint, deps.timeoutMs ?? LAUNCH_SWITCH_TIMEOUT_MS);
          if (got !== null) writeLaunchKept(dataDir, { checkedAt: new Date(at).toISOString(), doc: got === "invalid" ? null : parseLaunchDoc(got) });
          return "asked" as const;
        } catch {
          return "off" as const;
        }
      })().finally(() => {
        running = null;
      });
      return running;
    },

    start() {
      if (started) return;
      started = true;
      const wake = (ms: number) => {
        const timer = setTimeout(() => {
          void service
            .refresh()
            .catch(() => undefined)
            .then(() => {
              let next = LAUNCH_SWITCH_OFF_REFRESH_MS;
              try {
                next = nextWakeMs();
              } catch {
                // An unreadable data folder: look again in 3 hours.
              }
              wake(next);
            });
        }, ms);
        (timer as { unref?: () => void }).unref?.();
      };
      wake(0);
    },

    claim() {
      try {
        const due = setTimeout(() => void service.refresh().catch(() => {}), 0);
        (due as { unref?: () => void }).unref?.();
        const live = current();
        // A read-only data folder can hold neither record: it would show on every load, so it never shows.
        if (!live?.open || !dataDirWritable(deps.dataDir())) return no;
        return { show: true, campaign: live.doc.campaign, url: live.doc.url };
      } catch {
        return no;
      }
    },

    shown(campaign) {
      try {
        const live = current();
        if (!live?.open || (campaign !== undefined && campaign !== live.doc.campaign)) return { show: false };
        const name = live.doc.campaign;
        const stamped = deps.shown.stamp(name, { shownAt: new Date(now()).toISOString() });
        if (stamped === "taken") return { show: false };
        // The second record, in the data folder, written either way: a machine state that cannot be saved (a
        // hand-broken config.json) or that breaks later still reads as shown on this computer.
        const marked = markLaunchShown(deps.dataDir(), name);
        // This process never claims it again, whatever was written.
        shownHere.add(name);
        // Neither record written: every later load would show it again, so it does not show at all.
        return { show: stamped === "stamped" || marked };
      } catch {
        return { show: false };
      }
    },

    answer(answer, campaign) {
      try {
        const name = campaign ?? readLaunchKept(deps.dataDir()).doc?.campaign;
        if (!name || !CAMPAIGN.test(name)) return { ok: false };
        const record = deps.shown.read(name);
        if (!record?.shownAt) return { ok: false };
        if (record.answer) return { ok: true };
        return { ok: deps.shown.write(name, { ...record, answer, answeredAt: new Date(now()).toISOString() }) };
      } catch {
        return { ok: false };
      }
    },
  };
  return service;
}

// ── The routes ──

export type LaunchSwitchAction = "claim" | "shown" | "answer";

/**
 * One action, runtime-free (the Bun servers, the Pi servers and the Inbox hand in the parsed body): `claim` →
 * `{ show: false }` or `{ show: true, campaign, url }` (the dialog's words ship in the release); `shown` (`{ campaign? }`) → `{ show }`;
 * `answer` (`{ answer: "opened" | "dismissed", campaign? }`) → `{ ok }`, 400 for another answer.
 */
export function launchSwitchAction(service: LaunchSwitchService, action: LaunchSwitchAction, body: unknown): { status: number; body: unknown } {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const campaign = typeof b.campaign === "string" && CAMPAIGN.test(b.campaign) ? b.campaign : undefined;
  if (action === "claim") return { status: 200, body: service.claim() };
  if (action === "shown") return { status: 200, body: service.shown(campaign) };
  if (b.answer !== "opened" && b.answer !== "dismissed") return { status: 400, body: { error: "answer: opened or dismissed." } };
  return { status: 200, body: service.answer(b.answer, campaign) };
}

const ROUTE_PREFIX = "/api/launch-switch/";

/**
 * `POST /api/launch-switch/claim`, `/shown` and `/answer` on the plan, review and annotate servers (both runtimes).
 * Null for any other path; 405 for another method.
 */
export function launchSwitchRoute(service: LaunchSwitchService, method: string, path: string, body: unknown): { status: number; body: unknown } | null {
  if (!path.startsWith(ROUTE_PREFIX)) return null;
  const action = path.slice(ROUTE_PREFIX.length);
  if (action !== "claim" && action !== "shown" && action !== "answer") return null;
  if (method !== "POST") return { status: 405, body: { error: "Use POST." } };
  return launchSwitchAction(service, action, body);
}

let defaultService: LaunchSwitchService | null = null;
let serviceForTests: LaunchSwitchService | null = null;

/**
 * This process's switch: the data folder, config.json's update check, the environment, and the release gate
 * (`release`: a host's own word, as Pi's `release.json`; default `launchSwitchRelease()`).
 */
export function launchSwitchService(release?: () => boolean): LaunchSwitchService {
  if (serviceForTests) return serviceForTests;
  defaultService ??= createLaunchSwitch({
    dataDir: () => getPlannotatorDataDir(),
    endpoint: () => launchSwitchEndpointNow(release ? release() : launchSwitchRelease()),
    shown: configLaunchShownStore,
  });
  return defaultService;
}

/** Tests only: the service every route uses (null: back to the real one). */
export function setLaunchSwitchServiceForTests(service: LaunchSwitchService | null): void {
  serviceForTests = service;
  defaultService = null;
}
