import { loadConfig, saveConfig } from "../config";

export const SHAPE_SWITCH_NOT_SAVED =
  "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.";

export function shapeSwitchOn(): boolean {
  return loadConfig().inboxShape === true;
}

export function shapeBoardsOn(options: { quiet?: boolean } = { quiet: true }): boolean {
  return loadConfig(options).inboxShape === true;
}

export function setShapeSwitch(on: boolean): boolean {
  return saveConfig({ inboxShape: on }) && shapeSwitchOn() === on;
}
