/**
 * Plans on Bun, as an Inbox capability (packages/server/inbox-capability.ts). The route core is
 * packages/shared/plans/routes.ts; this file adds what a runtime owns: the Response, a version's bytes, and when the
 * import runs. Bun only: Plans lives in the Inbox, which the Pi server does not run.
 *
 * Off, it costs nothing: no route (the Inbox answers 404), no store opened, no import, no file written, nothing in
 * the settings answer. On:
 * - the import runs in the background once the Inbox is up, and when the switch is turned on;
 * - a request to `/api/plans` picks up what plan review wrote since (at most once per `pickUpMs`), in the background,
 *   and answers from what the library holds now (the list says `importing: true` meanwhile);
 * - one import at a time: the server is the library's one writer.
 */
import { createPlanStore, type PlanStore } from "@plannotator/shared/plans/store";
import { importPlanLibraryInSteps, type PlanImportReport } from "@plannotator/shared/plans/import";
import { handlePlanRoute, PLANS_ROUTE_PREFIX } from "@plannotator/shared/plans/routes";
import { plansOn, setPlansSwitch } from "@plannotator/shared/plans/switch";
import type { InboxCapability, InboxCore } from "./inbox-capability";

const NO_STORE = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } as const;

export interface PlansCapabilityOptions extends InboxCore {
  /** Tests: on or off, over config.json `inboxPlans`. */
  fixed?: boolean;
  /** Tests: the store (counted, or failing). */
  openStore?: (dataDir: string) => PlanStore;
  /** The shortest time between two pickups. */
  pickUpMs?: number;
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
  const on = () => options.fixed ?? plansOn();

  const sync = (repair = false): Promise<PlanImportReport> => {
    if (running) return running;
    running = importPlanLibraryInSteps(storeOf(), { dataDir: options.dataDir, repair }).finally(() => {
      running = null;
    });
    return running;
  };
  const background = (repair: boolean) => {
    sync(repair).catch((error) => {
      console.error(`[plannotator] Plans: the plan library could not be brought up to date (${error instanceof Error ? error.message : String(error)}).`);
    });
  };

  return {
    key: "plans",
    prefix: PLANS_ROUTE_PREFIX,
    on,
    save(next) {
      const was = on();
      const saved = setPlansSwitch(next);
      if (!saved) return false;
      if (next && !was) background(true);
      if (was !== on()) options.changed();
      return true;
    },
    async route(req, url) {
      if (!running && Date.now() - lastPickUp >= (options.pickUpMs ?? 2000)) {
        lastPickUp = Date.now();
        background(false);
      }
      const answer = await handlePlanRoute(
        { method: req.method, pathname: url.pathname, params: url.searchParams, json: () => req.json() },
        { store: storeOf(), importing: () => running !== null },
      );
      if (!answer) return null;
      if ("file" in answer) {
        return new Response(Bun.file(answer.file.path), {
          headers: { "Content-Type": answer.file.contentType, "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "sandbox", ...NO_STORE },
        });
      }
      return Response.json(answer.body, { status: answer.status, headers: NO_STORE });
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
