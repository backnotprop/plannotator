/**
 * The "Star the repo" ask (approval "star-ask", 2026-11-06, `.product/approved/star-ask/`): one humble ask, once, to
 * people who already use Plannotator, on whichever surface comes first (the Inbox's corner card, or the done screen of
 * plan review, code review and annotate).
 *
 * Shown once, everywhere: one config.json record, `starAsk` (`StarAskRecord`), read and written only here. The first
 * surface that shows the ask stamps `shownAt`; no surface shows it again. Ignoring it or closing the tab counts as an
 * answer. `answer` says how it ended: `starred` (gh starred it on the click), `opened` (the GitHub page opened),
 * `not-now`, or `already` (the check found a star before the ask showed, so nothing showed).
 *
 * Who sees it (every gate, in order):
 *  - a release build (`starAskEnabled`): never a dev build, a test or CI. Under the test sandbox only
 *    PLANNOTATOR_STAR_ASK_PREVIEW=1 turns it on, for a scratch build's pictures and e2e (gh is faked there);
 *  - the record is open (`starAskOpen`): never shown and never answered, on any surface;
 *  - a returning person: plan review, code review and annotate read the daily ping's first-use week
 *    (`starAskReturning`: week 2 or later). The Inbox's line has its own need (7 days, 10 threads:
 *    shared/inbox/reveals.ts) and its own calm moment;
 *  - the already-starred check, run only now, after every local rule passed, once: `gh api
 *    user/starred/backnotprop/plannotator` with the person's own gh login. 204: stamp `already`, show nothing. 404:
 *    show it, and the button stars with gh (`canStar`). gh missing, signed out, any other answer, or nothing within
 *    `STAR_ASK_GH_TIMEOUT_MS`: show it, and the button is a plain link to the repository.
 * Starring runs only on the person's click (`star`), never on its own and never because of a check.
 *
 * Privacy: the check and the star call GitHub with the person's own gh account; GitHub learns that account asked about
 * the repository. The result stays in config.json and goes nowhere else.
 */
import { spawn } from "node:child_process";
import { loadConfig, saveConfig, type PlannotatorConfig } from "./config";
import { dailyPingAge, firstUseWeek, isMarkedReleaseBuild, readDailyPingState, utcDay } from "./daily-ping";
import { getPlannotatorDataDir } from "./data-dir";

export const STAR_ASK_REPO = "backnotprop/plannotator";
export const STAR_ASK_URL = `https://github.com/${STAR_ASK_REPO}`;
/** The check and the star each wait this long for gh, then give up (the link fallback). */
export const STAR_ASK_GH_TIMEOUT_MS = 3_000;
/** Plan review, code review and annotate: the daily ping's age bucket from which a person is returning (week 2+). */
export const STAR_ASK_MIN_AGE_WEEK = 2;

export type StarAskAnswer = "starred" | "opened" | "not-now" | "already";
export type StarAskSurface = "inbox" | "plan" | "review" | "annotate";

/** config.json `starAsk`. */
export interface StarAskRecord {
  /** When a surface showed the ask (absent: never shown). */
  shownAt?: string;
  /** How it ended (absent: shown and not answered yet, or never shown). */
  answer?: StarAskAnswer;
  answeredAt?: string;
  /** The surface that showed it (or checked, for `already`). */
  surface?: StarAskSurface;
  /** The check said gh can star it (404 from GitHub): the button stars with gh. */
  canStar?: boolean;
}

const ANSWERS: readonly StarAskAnswer[] = ["starred", "opened", "not-now", "already"];
const SURFACES: readonly StarAskSurface[] = ["inbox", "plan", "review", "annotate"];

/** The record as config.json holds it, keeping only the fields this module writes (a hand edit may hold anything). */
export function readStarAskRecord(config: Pick<PlannotatorConfig, "starAsk"> | undefined): StarAskRecord | undefined {
  const raw = config?.starAsk as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: StarAskRecord = {};
  if (typeof r.shownAt === "string") out.shownAt = r.shownAt;
  if (typeof r.answer === "string" && (ANSWERS as readonly string[]).includes(r.answer)) out.answer = r.answer as StarAskAnswer;
  if (typeof r.answeredAt === "string") out.answeredAt = r.answeredAt;
  if (typeof r.surface === "string" && (SURFACES as readonly string[]).includes(r.surface)) out.surface = r.surface as StarAskSurface;
  if (typeof r.canStar === "boolean") out.canStar = r.canStar;
  return out;
}

/** Never shown and never answered: a surface may still ask. Any other value in config.json (a hand edit) is closed. */
export function starAskOpen(record: StarAskRecord | undefined, raw: unknown = record): boolean {
  if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) return false;
  return !record?.shownAt && !record?.answer;
}

// ── Gates ──

let releaseOverride: boolean | null = null;

/**
 * A host that knows better than the compiled-in mark says whether this process is a release (OpenCode: release CI's
 * `dist/release.json`). Null: back to the mark. The binary needs no call: release CI compiles the mark in.
 */
export function setStarAskRelease(release: boolean | null): void {
  releaseOverride = release;
}

/** This process is a release build (a host's word, else release CI's compiled-in mark). */
export function starAskRelease(): boolean {
  return releaseOverride ?? isMarkedReleaseBuild();
}

/**
 * The ask may run in this process at all: a release build, outside CI. Under the test sandbox (PLANNOTATOR_TEST_SANDBOX
 * or NODE_ENV=test) never, unless PLANNOTATOR_STAR_ASK_PREVIEW=1 asks for it (a scratch build's pictures, e2e; gh is
 * faked there).
 */
export function starAskEnabled(env: NodeJS.ProcessEnv = process.env, release: boolean = starAskRelease()): boolean {
  if (env.PLANNOTATOR_TEST_SANDBOX || env.NODE_ENV === "test") return env.PLANNOTATOR_STAR_ASK_PREVIEW === "1";
  if (env.CI) return false;
  return release;
}

/**
 * Plan review, code review and annotate keep no first-use date of their own: the daily ping's first-use week
 * (`ping.json` `firstWeek`, else the oldest time on the data folder, which works with the ping off too). Returning:
 * week 2 or later.
 */
export function starAskReturning(dataDir: string = getPlannotatorDataDir(), now: number = Date.now()): boolean {
  const today = utcDay(now);
  const firstWeek = readDailyPingState(dataDir).firstWeek ?? firstUseWeek(dataDir, today);
  return dailyPingAge(firstWeek, today) >= STAR_ASK_MIN_AGE_WEEK;
}

// ── gh ──

export interface GhResult {
  /** The exit code; null when gh could not start (missing) or was stopped at the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

/** Runs `gh` with these arguments; resolves (never rejects) within about `timeoutMs`. Tests inject a fake. */
export type GhRunner = (args: readonly string[], timeoutMs: number) => Promise<GhResult>;

/**
 * A runner for `command` (default `gh`, from the PATH: the person's own gh with their own login). A missing program
 * resolves with `code: null`; one that runs past `timeoutMs` is killed and resolves `timedOut`.
 */
export const createGhRunner = (command = "gh"): GhRunner => (args, timeoutMs) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: GhResult) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_PROMPT_DISABLED: "1" }, windowsHide: true });
    } catch {
      finish({ code: null, stdout, stderr });
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", () => finish({ code: null, stdout, stderr }));
    child.on("close", (code) => finish({ code: typeof code === "number" ? code : null, stdout, stderr }));
  });

/** The person's own gh. */
export const runGh: GhRunner = createGhRunner();

const GH_PATH = `user/starred/${STAR_ASK_REPO}`;
/** The check: is the repository starred by the gh account? (`--include` prints the status line.) */
export const STAR_ASK_CHECK_ARGS = ["api", "--include", "--hostname", "github.com", GH_PATH] as const;
/** The star, on the click only. */
export const STAR_ASK_STAR_ARGS = ["api", "--include", "--hostname", "github.com", "-X", "PUT", GH_PATH] as const;

/** The HTTP status gh saw: the status line `--include` prints, else gh's "(HTTP 404)" error. Null: no answer. */
export function ghHttpStatus(result: GhResult): number | null {
  if (result.timedOut) return null;
  const line = /^HTTP\/[\d.]+\s+(\d{3})\b/m.exec(result.stdout);
  if (line) return Number(line[1]);
  const error = /\(HTTP (\d{3})\)/.exec(result.stderr);
  return error ? Number(error[1]) : null;
}

export type StarAskCheck = "starred" | "not-starred" | "unknown";

/** 204: starred. 404: not starred. Anything else (gh missing, signed out, an error, the timeout): unknown. */
export async function checkStarred(run: GhRunner, timeoutMs: number = STAR_ASK_GH_TIMEOUT_MS): Promise<StarAskCheck> {
  try {
    const status = ghHttpStatus(await withTimeout(run(STAR_ASK_CHECK_ARGS, timeoutMs), timeoutMs));
    return status === 204 ? "starred" : status === 404 ? "not-starred" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Star it with gh: true only on GitHub's 204. */
export async function starRepo(run: GhRunner, timeoutMs: number = STAR_ASK_GH_TIMEOUT_MS): Promise<boolean> {
  try {
    return ghHttpStatus(await withTimeout(run(STAR_ASK_STAR_ARGS, timeoutMs), timeoutMs)) === 204;
  } catch {
    return false;
  }
}

/** A runner that never answers still ends at the timeout (a little after its own). */
function withTimeout(pending: Promise<GhResult>, timeoutMs: number): Promise<GhResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ code: null, stdout: "", stderr: "", timedOut: true }), timeoutMs + 250);
    pending.then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ── The decisions ──

export interface StarAskStore {
  /** The record now (`raw`: config.json's value as written, for a hand edit that is not an object). */
  read(): { record: StarAskRecord | undefined; raw: unknown };
  /** Write the record; true when it reached the file. */
  write(record: StarAskRecord): boolean;
}

/** config.json, through the locked read-merge-write. */
export const configStarAskStore: StarAskStore = {
  read() {
    const config = loadConfig({ quiet: true });
    return { record: readStarAskRecord(config), raw: (config as { starAsk?: unknown }).starAsk };
  },
  write(record) {
    if (!saveConfig({ starAsk: record })) return false;
    const back = readStarAskRecord(loadConfig({ quiet: true }));
    return back?.shownAt === record.shownAt && back?.answer === record.answer;
  },
};

export interface StarAskDeps {
  store: StarAskStore;
  run: GhRunner;
  /** `starAskEnabled` for this process. */
  enabled: () => boolean;
  /** The person is returning (`starAskReturning`; the Inbox's line decides its own, so it passes `() => true`). */
  returning: () => boolean;
  now?: () => Date;
  timeoutMs?: number;
}

export interface StarAskClaim {
  show: boolean;
  /** The button stars with gh; false: the button is a link to the repository. */
  canStar: boolean;
}

export interface StarAskClaimOptions {
  /** The surface's own rules (the Inbox's line), checked before the check and again after it. */
  gate?: () => boolean;
  /** Write the shown record (the Inbox stamps its line in the same save). Default: the store. */
  stamp?: (record: StarAskRecord) => boolean;
}

export interface StarAskService {
  /** A surface is about to show the ask: every gate, then the check, then the stamp. */
  claim(surface: StarAskSurface, options?: StarAskClaimOptions): Promise<StarAskClaim>;
  /** The click on "Star on GitHub" while the button stars with gh. */
  star(): Promise<{ starred: boolean }>;
  /** Not now, or the GitHub page opened from the link. */
  answer(answer: "not-now" | "opened"): { ok: boolean };
}

export function createStarAsk(deps: StarAskDeps): StarAskService {
  const now = () => (deps.now ? deps.now() : new Date());
  const timeoutMs = deps.timeoutMs ?? STAR_ASK_GH_TIMEOUT_MS;
  const open = () => {
    const { record, raw } = deps.store.read();
    return starAskOpen(record, raw);
  };
  // One check at a time in this process: a second tab's claim while the first waits on gh shows nothing.
  let claiming = false;
  let starring: Promise<{ starred: boolean }> | null = null;

  return {
    async claim(surface, options = {}) {
      const no: StarAskClaim = { show: false, canStar: false };
      const gate = options.gate ?? (() => true);
      if (claiming || !deps.enabled() || !open() || !gate() || !deps.returning()) return no;
      claiming = true;
      try {
        const check = await checkStarred(deps.run, timeoutMs);
        // Another surface (or process) may have shown it while gh answered.
        if (!open() || !gate()) return no;
        const at = now().toISOString();
        if (check === "starred") {
          deps.store.write({ answer: "already", answeredAt: at, surface });
          return no;
        }
        const record: StarAskRecord = { shownAt: at, surface, canStar: check === "not-starred" };
        const written = (options.stamp ?? deps.store.write)(record);
        // Not written (a read-only data dir): showing it anyway would show it on every load.
        return written ? { show: true, canStar: record.canStar === true } : no;
      } finally {
        claiming = false;
      }
    },

    star() {
      // A double click stars once.
      starring ??= (async () => {
        const { record } = deps.store.read();
        if (record?.answer === "starred") return { starred: true };
        if (!record?.shownAt || record.answer || record.canStar !== true) return { starred: false };
        const starred = await starRepo(deps.run, timeoutMs);
        if (starred) deps.store.write({ ...deps.store.read().record, answer: "starred", answeredAt: now().toISOString() });
        return { starred };
      })().finally(() => {
        starring = null;
      });
      return starring;
    },

    answer(answer) {
      const { record } = deps.store.read();
      if (!record?.shownAt) return { ok: false };
      if (record.answer) return { ok: true };
      return { ok: deps.store.write({ ...record, answer, answeredAt: now().toISOString() }) };
    },
  };
}

// ── The routes (plan review, code review and annotate; both runtimes) ──

/**
 * `POST /api/star-ask/claim` and `/api/star-ask/answer` (`{ answer: "not-now" | "opened" }`). Null for any other path.
 * The page claims once it has loaded, while the session is open: the server stops as soon as the decision is sent, so
 * the done screen's card holds the answer and its button is the link (no gh star from there; the Inbox has one).
 * Runtime-free: the Bun and Pi servers hand in the method and the parsed body.
 */
export async function starAskRoute(
  service: StarAskService,
  surface: StarAskSurface,
  method: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: unknown } | null> {
  if (path !== "/api/star-ask/claim" && path !== "/api/star-ask/answer") return null;
  if (method !== "POST") return { status: 405, body: { error: "Use POST." } };
  if (path === "/api/star-ask/claim") {
    const claim = await service.claim(surface);
    return { status: 200, body: { show: claim.show, can_star: claim.canStar } };
  }
  const answer = body && typeof body === "object" ? (body as { answer?: unknown }).answer : undefined;
  if (answer !== "not-now" && answer !== "opened") return { status: 400, body: { error: "answer: not-now or opened." } };
  return { status: 200, body: service.answer(answer) };
}

let defaultService: StarAskService | null = null;
let serviceForTests: StarAskService | null = null;

/**
 * This process's ask: config.json, the person's gh, and the release gate (`release`: a host's own word, as Pi's
 * `release.json`; default `starAskRelease()`).
 */
export function starAskService(release?: () => boolean): StarAskService {
  if (serviceForTests) return serviceForTests;
  defaultService ??= createStarAsk({
    store: configStarAskStore,
    run: runGh,
    enabled: () => starAskEnabled(process.env, release ? release() : starAskRelease()),
    returning: () => starAskReturning(),
  });
  return defaultService;
}

/** Tests only: the service every route uses (null: back to the real one). */
export function setStarAskServiceForTests(service: StarAskService | null): void {
  serviceForTests = service;
  defaultService = null;
}
