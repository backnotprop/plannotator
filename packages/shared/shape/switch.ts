/**
 * Shape's one switch (config.json `inboxShape` in the data dir). The Inbox's
 * Settings → Capabilities → Shape (packages/server/inbox.ts), the Shapes server
 * and `plannotator shape on|off` (apps/hook/server/shape-command.ts) all read and
 * write it here, so they can never disagree.
 */
import { loadConfig, saveConfig } from "../config";

/** Why a switch did not change: config.json could not be written. */
export const SHAPE_SWITCH_NOT_SAVED =
  "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.";

/** Shape is on: the person turned it on (unset is off). */
export function shapeSwitchOn(): boolean {
  return loadConfig().inboxShape === true;
}

/** Turn Shape on or off; false when config.json could not be saved (nothing changed). */
export function setShapeSwitch(on: boolean): boolean {
  saveConfig({ inboxShape: on });
  return shapeSwitchOn() === on;
}
