/**
 * Bun adapter for `isThisMachineReader` (packages/shared/this-machine-reader.ts):
 * whether a request is a page on this machine, for the reads that reach past
 * the session's roots. The Pi mirror is apps/pi-extension/server/this-machine.ts.
 */

import { isThisMachineReader } from "@plannotator/shared/this-machine-reader";
import { isRemoteSession } from "./remote";

export function isThisMachineRequest(req: Request): boolean {
  return isThisMachineReader(isRemoteSession(), req.headers);
}
