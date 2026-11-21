/**
 * Bun adapter for `isThisMachineReader` (packages/shared/this-machine-reader.ts):
 * whether a request is a page on this machine, for the reads that reach past
 * the session's roots. The Pi mirror is apps/pi-extension/server/this-machine.ts.
 *
 * Also the per-request answer for a remote session that only SSH turned on
 * (`isSshDetectedRemote`): the server still binds every interface, as it
 * always has over SSH, but a request whose TCP peer is loopback (the person's
 * own `ssh -L` tunnel or editor port forward, or a browser on that machine)
 * with a loopback Host and no proxy header is answered as in a local session.
 * A request from another address gets exactly what remote mode gives.
 */

import { isLoopbackPeerAddress, isThisMachineReader } from "@plannotator/shared/this-machine-reader";
import { isRemoteSession, isSshDetectedRemote } from "./remote";

/** The TCP peer of each request a server saw, noted at the top of its fetch (Bun's Request does not carry it). */
const peers = new WeakMap<Request, string>();

/** Note a request's TCP peer address: call first thing in a server's `fetch(req, server)`. */
export function notePeer(req: Request, server: { requestIP(req: Request): { address: string } | null }): void {
  const address = server.requestIP(req)?.address;
  if (address) peers.set(req, address);
}

/**
 * In a remote session only SSH turned on: whether this request came over
 * loopback with a loopback Host and no proxy header, so it is answered as in
 * a local session. False in every other session, and for a request whose
 * peer was never noted.
 */
export function isSshTunnelRequest(req: Request): boolean {
  return isSshDetectedRemote() && isLoopbackPeerAddress(peers.get(req)) && isThisMachineReader(false, req.headers);
}

export function isThisMachineRequest(req: Request): boolean {
  return isThisMachineReader(isRemoteSession() && !isSshTunnelRequest(req), req.headers);
}
