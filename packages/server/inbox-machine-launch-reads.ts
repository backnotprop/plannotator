/**
 * Remote launch: each linked machine's last good launch read (docs/agent-guides/inbox-launch.md, "From another
 * linked machine"). A window reads a linked machine's `sessions` through the forward while it is online; the launch
 * block and home of the last read that answered are kept here, in memory, so a window opened while that machine is
 * asleep (a reload, a new tab, the phone) still lists its projects in New message's folder menu, and a Send there
 * waits in the outbox. Never on disk, like the machine's list (inbox-peer-link.ts): after a restart its projects come
 * back once it does. It goes with the link.
 */

import type { InboxComposeLaunch } from "@plannotator/core/inbox-types";
import { readCapped } from "./inbox-peer-link";

/** The route whose answer is kept: the far `sessions` read, with its launch block. */
export const MACHINE_SESSIONS_ROUTE = "sessions";
/** A far `sessions` answer is read no further than this for keeping (the window still gets all of it). */
const SESSIONS_KEEP_MAX_BYTES = 2 * 1024 * 1024;

/** What a window needs of a linked machine's read to draw its group in the folder menu. */
export interface MachineLaunchRead {
  launch: InboxComposeLaunch;
  home: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * The launch read in a far `sessions` answer, or null when it has none (launch off there, an older Inbox, not JSON).
 * Only the launch block and home are kept; the live sessions are not, since they are stale the moment it sleeps.
 */
export function machineLaunchReadOf(body: unknown): MachineLaunchRead | null {
  if (!isRecord(body)) return null;
  const launch = body.launch;
  if (!isRecord(launch) || !Array.isArray(launch.agents) || !Array.isArray(launch.projects)) return null;
  return { launch: launch as unknown as InboxComposeLaunch, home: typeof body.home === "string" ? body.home : null };
}

/** A tailnet guest's copy: no folder-trust facts (`untrusted`, the owner's alone), as a guest's forwarded read has none. */
export function machineLaunchReadForGuest(read: MachineLaunchRead): MachineLaunchRead {
  return { ...read, launch: { ...read.launch, agents: read.launch.agents.map(({ untrusted: _untrusted, ...agent }) => agent) } };
}

/** The kept reads, one per linked machine. */
export function createMachineLaunchReads() {
  const reads = new Map<string, MachineLaunchRead>();
  return {
    /**
     * Keep the read in a far `sessions` answer that answered (pass a clone: the window gets the original). An answer
     * with no launch block forgets the machine's read; one that can't be read keeps the last. `linked`: asked once the
     * body is read, so a machine unlinked meanwhile is not kept again.
     */
    async keep(machine: string, answer: Response, linked: () => boolean): Promise<void> {
      if (!answer.ok) return;
      let body: unknown;
      try {
        const raw = await readCapped(answer, SESSIONS_KEEP_MAX_BYTES);
        if (raw === null) return;
        body = JSON.parse(raw);
      } catch {
        return;
      }
      if (!linked()) return;
      const read = machineLaunchReadOf(body);
      if (read) reads.set(machine, read);
      else reads.delete(machine);
    },
    /** Every kept read of the machines in `ids`, for the window's machines answer; a guest's without trust facts. */
    view(ids: readonly string[], guest: boolean): Record<string, MachineLaunchRead> {
      const out: Record<string, MachineLaunchRead> = {};
      for (const id of ids) {
        const read = reads.get(id);
        if (read) out[id] = guest ? machineLaunchReadForGuest(read) : read;
      }
      return out;
    },
    forget(machine: string): void {
      reads.delete(machine);
    },
  };
}
