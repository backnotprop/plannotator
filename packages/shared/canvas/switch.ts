/**
 * The thread canvas's one switch (config.json `inboxCanvas` in the data dir; off unless it is exactly `true`). Config
 * only: there is no Settings row, no menu item, no command and no settings POST that turns it on or off. The Inbox's
 * capability (packages/server/canvas-capability.ts) and `plannotator canvas` (apps/hook/server/canvas-command.ts)
 * read it here.
 */
import { loadConfig } from "../config";

/** The canvas is on. Quiet: read on every request; a broken config.json is off. */
export function canvasOn(): boolean {
  return loadConfig({ quiet: true }).inboxCanvas === true;
}
