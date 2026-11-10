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

/**
 * The boards work: Shape on, and only Shape (approval "code-review-029-shape-off": Code review on brings no board,
 * no Show me and no Shape text). A broken config.json is off. Quiet for what reads it on every request; the `shape`
 * command warns, as it did.
 */
export function shapeBoardsOn(options: { quiet?: boolean } = { quiet: true }): boolean {
  return loadConfig(options).inboxShape === true;
}

/** Turn Shape on or off; false when config.json could not be saved (nothing changed). */
export function setShapeSwitch(on: boolean): boolean {
  return saveConfig({ inboxShape: on }) && shapeSwitchOn() === on;
}
