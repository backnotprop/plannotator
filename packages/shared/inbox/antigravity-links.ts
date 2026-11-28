/**
 * The Antigravity CLI hand-overs in the Inbox's own data folder
 * (`inbox/antigravity/links/<conversation id>.json`, 0600; written by
 * `plannotator inbox antigravity`, read by packages/server/
 * inbox-antigravity-wake.ts). Each holds a token for one agy process's
 * language server, which ends with that agy, so a hand-over whose agy is gone
 * is removed: when a new one is written, and on the wake's passes.
 *
 * Gone means: the agy pid the hand-over names is not running, or, for one
 * that names no pid, nothing answers on its loopback port. Anything else
 * (an answer that is late, a file this build cannot read) is kept: a reply
 * attempt that the server refuses still ends it.
 */

import { readdirSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { antigravityLoopbackAddress, isAntigravityConversationId, type InboxAntigravityLink } from "@plannotator/core/inbox-types";

/** Whether a process with this pid runs (one this user may not signal runs too). */
export function antigravityPidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether a loopback port refuses a connection outright (nothing listens there). Late or any other answer: no.
 * `localhost` is both 127.0.0.1 and ::1 (agy listens on either): it refuses only when both do.
 */
export async function antigravityPortRefuses(address: string, timeoutMs = 1000): Promise<boolean> {
  const loopback = antigravityLoopbackAddress(address);
  if (!loopback) return false;
  const cut = loopback.lastIndexOf(":");
  const name = loopback.slice(0, cut);
  const port = Number(loopback.slice(cut + 1));
  const hosts = name === "localhost" ? ["127.0.0.1", "::1"] : [name.replace(/^\[|\]$/g, "")];
  for (const host of hosts) if (!(await refuses(host, port, timeoutMs))) return false;
  return true;
}

function refuses(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (refused: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(refused);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once("connect", () => done(false));
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code === "ECONNREFUSED"));
  });
}

/** Whether a hand-over's agy is gone: its pid is not running, or (no pid) its port refuses. */
export async function antigravityLinkGone(link: Partial<InboxAntigravityLink>): Promise<boolean> {
  if (link.pid !== undefined) return !antigravityPidAlive(link.pid);
  return typeof link.address === "string" ? antigravityPortRefuses(link.address) : false;
}

/**
 * Removes the hand-overs in `dir` whose agy is gone (`keep`: a conversation whose file is left alone). Returns the
 * conversations whose hand-over was removed.
 */
export async function pruneAntigravityLinks(dir: string, keep?: string): Promise<string[]> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const conversation = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
    if (!isAntigravityConversationId(conversation) || conversation === keep?.toLowerCase()) continue;
    let link: Partial<InboxAntigravityLink>;
    try {
      link = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<InboxAntigravityLink>;
    } catch {
      continue;
    }
    if (!(await antigravityLinkGone(link))) continue;
    rmSync(join(dir, name), { force: true });
    removed.push(conversation);
  }
  return removed;
}
