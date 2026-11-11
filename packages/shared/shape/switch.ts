/** Shape's one switch (config.json `inboxShape`), read and written only here. */
import { loadConfig, saveConfig } from "../config";

export const SHAPE_SWITCH_NOT_SAVED =
  "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.";

export function shapeSwitchOn(): boolean {
  return loadConfig().inboxShape === true;
}

/** Shape on, and only Shape: Code review on brings no board. A broken config.json is off. Quiet for per-request reads; the `shape` command warns. */
export function shapeBoardsOn(options: { quiet?: boolean } = { quiet: true }): boolean {
  return loadConfig(options).inboxShape === true;
}

export function setShapeSwitch(on: boolean): boolean {
  return saveConfig({ inboxShape: on }) && shapeSwitchOn() === on;
}
