/**
 * The thread canvas's one switch (config.json `inboxCanvas` in the data dir; off unless it is exactly `true`). Config
 * only: there is no Settings row, no menu item and no command that turns it on. The Inbox's capability
 * (packages/server/canvas-capability.ts) and `plannotator canvas` (apps/hook/server/canvas-command.ts) read it here.
 */
import { loadConfig, saveConfig } from "../config";

/** The canvas is on. Quiet: read on every request; a broken config.json is off. */
export function canvasOn(): boolean {
  return loadConfig({ quiet: true }).inboxCanvas === true;
}

/** Set the switch (the capability seam's save); false when config.json could not be saved. */
export function setCanvasSwitch(on: boolean): boolean {
  return saveConfig({ inboxCanvas: on }) && canvasOn() === on;
}
