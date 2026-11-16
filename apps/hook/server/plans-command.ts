/**
 * `plannotator plans`: Plans' switch from a terminal, and its list (unreleased, HIDDEN_SUBCOMMANDS in cli.ts).
 *
 *   plannotator plans        turn Plans on (config.json `inboxPlans`) and open the Inbox on its Plans page, starting
 *                            the Inbox detached when it is not running (the rules of `plannotator inbox --open`);
 *                            prints the page's URL. Only from a person's terminal: typing it is the opt-in, so a
 *                            shell with no terminal (an agent's) is refused and nothing changes.
 *   plannotator plans off    turn Plans off; the library stays on disk.
 *   plannotator plans list   the plans, one line each: from the running Inbox (which picks up what plan review
 *                            wrote since), else read from the library on disk. Never starts the Inbox, never writes.
 *
 * Off, everything but `plans` and `plans off` prints PLANS_OFF_TEXT and exits 1, starting nothing.
 */
import { createPlanStore } from "@plannotator/shared/plans/store";
import { PLANS_SWITCH_NOT_SAVED, plansOn, setPlansSwitch } from "@plannotator/shared/plans/switch";
import { inboxStatus } from "@plannotator/shared/inbox/registry";
import type { PlanSummary } from "@plannotator/core/plans";
import { PLANS_COMMAND_USAGE } from "./cli";

export { PLANS_COMMAND_USAGE };

/** What every `plannotator plans …` but `plans` and `plans off` says while Plans is off. */
export const PLANS_OFF_TEXT = "plans_off: Plans is off. To turn it on, run `plannotator plans`.";

export interface PlansCommandDeps {
  dataDir: string;
  /** The running Inbox, starting it detached when needed (`ensureInboxRunning`). */
  ensureInbox: () => Promise<{ url: string; port: number }>;
  /** Open a URL in the browser without waiting on it; "remote" when no browser could open here. */
  openUrl: (url: string) => Promise<unknown>;
  /** What to say when no browser opened because this is a remote session. */
  remoteHint?: (port: number) => string;
  /** The running Inbox, else null; never starts one. */
  runningInbox?: () => Promise<{ url: string } | null>;
  fetch?: typeof fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  /** How long `list` waits for an import the Inbox is running. */
  listWaitMs?: number;
}

export async function runPlansCommand(argv: readonly string[], deps: PlansCommandDeps): Promise<number> {
  const out = deps.stdout ?? ((text: string) => void process.stdout.write(`${text}\n`));
  const err = deps.stderr ?? ((text: string) => void process.stderr.write(`${text}\n`));
  const which = argv[0];

  if (which === "off" && argv.length === 1) {
    if (!setPlansSwitch(false)) {
      err(`config_not_saved: ${PLANS_SWITCH_NOT_SAVED}`);
      return 1;
    }
    out("Plans is off.");
    return 0;
  }

  if (which === undefined) {
    if (!setPlansSwitch(true)) {
      err(`config_not_saved: ${PLANS_SWITCH_NOT_SAVED}`);
      return 1;
    }
    err("Plans is on.");
    let entry: { url: string; port: number };
    try {
      entry = await deps.ensureInbox();
    } catch (error) {
      err(error instanceof Error ? error.message : String(error));
      return 1;
    }
    const url = new URL("#plans", entry.url).href;
    if ((await deps.openUrl(url)) === "remote" && deps.remoteHint) err(deps.remoteHint(entry.port));
    out(url);
    return 0;
  }

  if (!plansOn()) {
    err(PLANS_OFF_TEXT);
    return 1;
  }

  if ((which === "--help" || which === "-h") && argv.length === 1) {
    out(PLANS_COMMAND_USAGE);
    return 0;
  }

  if (which === "list" && argv.length === 1) {
    const plans = await listPlans(deps);
    if (plans.length === 0) out("No plans yet.");
    for (const plan of plans) out(planLine(plan));
    return 0;
  }

  err(PLANS_COMMAND_USAGE);
  return 2;
}

/** One plan as `plans list` prints it: id, last change, project, head version, decision, name. */
export function planLine(plan: PlanSummary): string {
  const day = plan.updated_at.slice(0, 10);
  const decision = plan.decision ? `${plan.decision.decision}${plan.decision.version_number ? ` v${plan.decision.version_number}` : ""}` : "no decision";
  const changed = plan.changed && plan.seen_version_number !== null ? ` · changed, you saw v${plan.seen_version_number}` : "";
  return `${plan.id}  ${day}  ${plan.project_name ?? "-"}  v${plan.head_version_number}  ${decision}${changed}  ${plan.name}`;
}

async function listPlans(deps: PlansCommandDeps): Promise<PlanSummary[]> {
  const running = await (deps.runningInbox ?? (async () => {
    const status = await inboxStatus(deps.dataDir);
    return status.state === "running" ? status.entry : null;
  }))();
  if (running) {
    const get = deps.fetch ?? fetch;
    const until = Date.now() + (deps.listWaitMs ?? 30_000);
    for (;;) {
      try {
        const answer = await get(new URL("/api/plans", running.url).href);
        if (!answer.ok) break; // an Inbox older than Plans: the library on disk
        const body = (await answer.json()) as { plans?: PlanSummary[]; importing?: boolean };
        if (!body.importing || Date.now() >= until) return body.plans ?? [];
      } catch {
        break; // gone between the status and the read: the library on disk
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (Date.now() >= until) break;
    }
  }
  return createPlanStore({ dataDir: deps.dataDir }).list();
}
