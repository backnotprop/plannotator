/**
 * Plans' one switch (config.json `inboxPlans` in the data dir; off unless the person turned it on). The Inbox's
 * settings (`POST /api/inbox/settings` `{ plans: { on } }`, packages/server/plans-capability.ts) and
 * `plannotator plans` / `plannotator plans off` (apps/hook/server/plans-command.ts) read and write it here, so they
 * can never disagree. No agent tool or agent text turns it on.
 */
import { loadConfig, saveConfig } from "../config";

/** Why the switch did not change: config.json could not be written. */
export const PLANS_SWITCH_NOT_SAVED =
  "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.";

/** Plans is on: the person turned it on (unset or anything but `true` is off; a broken config.json is off). Quiet: read on every request. */
export function plansOn(): boolean {
  return loadConfig({ quiet: true }).inboxPlans === true;
}

/** Turn Plans on or off; false when config.json could not be saved (nothing changed). */
export function setPlansSwitch(on: boolean): boolean {
  return saveConfig({ inboxPlans: on }) && plansOn() === on;
}
