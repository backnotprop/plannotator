/**
 * Plans on Bun, as an Inbox capability (packages/server/inbox-capability.ts). The route core is
 * packages/shared/plans/routes.ts; this file adds what a runtime owns: the Response, a version's bytes, and when the
 * import runs. Bun only: Plans lives in the Inbox, which the Pi server does not run.
 *
 * Off, it costs nothing: no route (the Inbox answers 404), no store opened, no import, no file written, nothing in
 * the settings answer. On:
 * - the import runs in the background once the Inbox is up, and when the switch is turned on;
 * - a request to `/api/plans` picks up what plan review wrote since (at most once per `pickUpMs`), in the background,
 *   and answers from what the library holds now (the list says `importing: true` meanwhile); the Spaces home's poll
 *   (`?poll=1`, every 5 s) picks up at most once per `pollPickUpMs` (30 s), since each pickup walks the plan history,
 *   except when plan review wrote into the history since (heard by a watch on `history/`, kept only while on): then
 *   the poll picks up once that write has settled and answers after it, so a plan arriving shows within seconds (a
 *   system with no such watch keeps the 30 s pickup);
 * - the list answers 304 to an `If-None-Match` that is still its `ETag` (nothing changed: no read, no body);
 * - one import at a time: the server is the library's one writer;
 * - an import that fails is not tried again on every request: the next pickup waits, twice as long after each failure
 *   in a row (from 4 s up to 5 min), the error is logged once per distinct message, and the list says
 *   `import_error` (the window: "Could not read your earlier plans", with Try again: `GET /api/plans?retry=1`).
 */
import { createPlanStore, type PlanStore } from "@plannotator/shared/plans/store";
import { importPlanLibraryInSteps, type PlanImportReport } from "@plannotator/shared/plans/import";
import { handlePlanRoute, PLANS_ROUTE_PREFIX } from "@plannotator/shared/plans/routes";
import { plansOn, setPlansSwitch, setSpacesView, spacesView } from "@plannotator/shared/plans/switch";
import { PLAN_IMPORT_SETTLE_MS } from "@plannotator/shared/plans/import";
import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import type { InboxCapability, InboxCore } from "./inbox-capability";

/** On Linux, the most folders (projects and plans) in history/ the Inbox watches; above it, the 30 s pickup alone. */
export const PLAN_HISTORY_WATCH_FOLDERS = 2000;

/** The folders in history/ two levels down (projects, then plans), counted up to just past `most`. */
function historyFolders(dir: string, most: number): number {
  let count = 0;
  for (const project of readdirSync(dir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    count++;
    for (const plan of readdirSync(join(dir, project.name), { withFileTypes: true })) {
      if (plan.isDirectory()) count++;
      if (count > most) return count;
    }
  }
  return count;
}

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

export interface PlansCapabilityOptions extends InboxCore {
  /** Tests: on or off, over config.json `inboxPlans`. */
  fixed?: boolean;
  /** Tests: the store (counted, or failing). */
  openStore?: (dataDir: string) => PlanStore;
  /** The shortest time between two pickups. */
  pickUpMs?: number;
  /** The shortest time between two pickups the home's poll starts (`?poll=1`). */
  pollPickUpMs?: number;
  /** The wait after the first failed import (doubled after each failure in a row), and its cap. */
  retryMs?: number;
  retryMaxMs?: number;
  /** Where a failed import is logged (once per distinct message). */
  log?: (line: string) => void;
  /** Tests: the platform the history watch is bounded for (default: this process's). */
  platform?: NodeJS.Platform;
  /** Tests: how long a heard history write must be still before the poll picks it up (default: the import's settle). */
  settleMs?: number;
}

export interface PlansCapability extends InboxCapability {
  /** The running import, or null. */
  importing(): Promise<PlanImportReport> | null;
  /** Run the import now (or join the running one). */
  sync(repair?: boolean): Promise<PlanImportReport>;
}

export function createPlansCapability(options: PlansCapabilityOptions): PlansCapability {
  let store: PlanStore | null = null;
  const storeOf = () => (store ??= (options.openStore ?? ((dataDir) => createPlanStore({ dataDir })))(options.dataDir));
  let running: Promise<PlanImportReport> | null = null;
  let lastPickUp = 0;
  // Plan review's writes into history/, heard as they happen (only while on): when the last was heard, and the last
  // one a pickup has taken.
  let heard = 0;
  let taken = 0;
  let watcher: FSWatcher | null = null;
  // A watch that failed (or would cost too much) is not tried again until Plans is turned on again: the poll's 30 s
  // pickup finds new versions without it.
  let gaveUp = false;
  const stopWatch = () => {
    watcher?.close();
    watcher = null;
  };
  const giveUp = () => {
    stopWatch();
    gaveUp = true;
  };
  const watchHistory = () => {
    if (watcher || gaveUp) return;
    const dir = join(options.dataDir, "history");
    if (!existsSync(dir)) return;
    try {
      // On Linux a recursive watch takes one inotify watch per folder, from a limit the whole machine shares: a large
      // history is left to the 30 s pickup. (macOS and Windows watch a tree as one.)
      if ((options.platform ?? process.platform) === "linux" && historyFolders(dir, PLAN_HISTORY_WATCH_FOLDERS) > PLAN_HISTORY_WATCH_FOLDERS) {
        gaveUp = true;
        return;
      }
      watcher = watch(dir, { recursive: true, persistent: false }, () => {
        heard = Date.now();
      });
      watcher.on("error", giveUp);
    } catch {
      giveUp();
    }
  };
  // A whole import finished (or failed) since the Inbox started or Plans was turned on. Until then the list says
  // `importing`; after it, the quick pickups a request starts say nothing, or a window polling while `importing` would
  // start one on every poll and be told `importing` for good.
  let caughtUp = false;
  // Failed imports in a row, the last one's message (null: the last import went through), and when the next may start.
  let failures = 0;
  let importError: string | null = null;
  let logged: string | null = null;
  let notBefore = 0;
  const on = () => options.fixed ?? plansOn();
  const log = options.log ?? ((line: string) => console.error(line));

  const sync = (repair = false): Promise<PlanImportReport> => {
    if (running) return running;
    running = Promise.resolve()
      .then(() => importPlanLibraryInSteps(storeOf(), { dataDir: options.dataDir, repair }))
      .then(
        (report) => {
          caughtUp = true;
          failures = 0;
          importError = logged = null;
          notBefore = 0;
          return report;
        },
        (error: unknown) => {
          caughtUp = true;
          failures++;
          importError = error instanceof Error ? error.message : String(error);
          notBefore = Date.now() + Math.min((options.retryMs ?? 4000) * 2 ** (failures - 1), options.retryMaxMs ?? 300_000);
          if (importError !== logged) log(`[plannotator] Plans: the plan library could not be brought up to date (${importError}).`);
          logged = importError;
          throw error;
        },
      )
      .finally(() => {
        running = null;
      });
    return running;
  };
  const background = (repair: boolean) => {
    // Logged in `sync`, once per distinct error.
    sync(repair).catch(() => {});
  };

  return {
    key: "plans",
    prefix: PLANS_ROUTE_PREFIX,
    on,
    save(next) {
      const was = on();
      const saved = setPlansSwitch(next);
      if (!saved) return false;
      if (next && !was) {
        caughtUp = false;
        notBefore = 0;
        gaveUp = false;
        background(true);
      }
      if (!next) stopWatch();
      if (was !== on()) options.changed();
      return true;
    },
    async route(req, url) {
      // The list's Try again: now, whatever the wait, and said `importing` until it ends (the window reads again).
      if (url.pathname === PLANS_ROUTE_PREFIX && url.searchParams.get("retry") === "1" && importError !== null && !running) {
        caughtUp = false;
        notBefore = 0;
        lastPickUp = 0;
      }
      watchHistory();
      const poll = url.searchParams.get("poll") === "1";
      // Plan review wrote since the last pickup, and the write has settled (the import waits for that too): now.
      const fresh = poll && heard > taken && Date.now() - heard >= (options.settleMs ?? PLAN_IMPORT_SETTLE_MS);
      const wait = fresh ? 0 : poll ? (options.pollPickUpMs ?? 30_000) : (options.pickUpMs ?? 2000);
      if (!running && Date.now() >= notBefore && Date.now() - lastPickUp >= wait) {
        lastPickUp = Date.now();
        if (fresh) taken = heard;
        background(false);
        // The arrival in this answer, not the next poll's.
        if (fresh && running) await (running as Promise<PlanImportReport>).catch(() => {});
      }
      const answer = await handlePlanRoute(
        { method: req.method, pathname: url.pathname, params: url.searchParams, json: () => req.json(), ifNoneMatch: req.headers.get("if-none-match") },
        { store: storeOf(), importing: () => running !== null && !caughtUp, importError: () => importError, view: { read: spacesView, save: setSpacesView } },
      );
      if (!answer) return null;
      if ("file" in answer) {
        return new Response(Bun.file(answer.file.path), {
          headers: { "Content-Type": answer.file.contentType, "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "sandbox", ...NO_STORE },
        });
      }
      const headers = answer.etag ? { ...NO_STORE, ETag: answer.etag } : NO_STORE;
      if (answer.status === 304) return new Response(null, { status: 304, headers });
      return Response.json(answer.body, { status: answer.status, headers });
    },
    // Present only while on: off, the settings answer is what it was before Plans existed.
    settingsWire: () => (on() ? { plans: { on: true } } : {}),
    started() {
      if (!on()) return;
      const timer = setTimeout(() => background(true), 0);
      (timer as { unref?: () => void }).unref?.();
    },
    importing: () => running,
    sync,
  };
}
