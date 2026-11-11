import { isThisMachineReader } from "@plannotator/shared/this-machine-reader";
import { isRemoteSession } from "./remote";

export function isThisMachineRequest(req: Request): boolean {
  return isThisMachineReader(isRemoteSession(), req.headers);
}
