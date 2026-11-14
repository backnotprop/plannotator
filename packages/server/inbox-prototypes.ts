/**
 * A question's prototypes at send (approval "inbox-question-tradeoffs"): the
 * pages a `Prototype:` line names, under an option or for the whole question.
 *
 * - A path is an HTML file the message attaches: it must be one of the
 *   send's `attachments` (matched as a link to an attachment is, from the
 *   folder the agent sent from or the project root, or by its bare name), so
 *   the window shows it exactly as it was sent.
 * - An address (`http://localhost:3000/…`) is an app running on this
 *   computer: checked and probed through the live engine
 *   (`inbox-live.ts` `checkPrototypeApps`), and kept as one of the message's
 *   `live_sites`.
 *
 * Any prototype that does not hold refuses the whole send, naming the
 * question and the option, before anything is written. Bun-only, like the
 * rest of the Inbox.
 */
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { prototypeTargets, type PrototypeAppTarget, type PrototypeTarget } from "@plannotator/core/inbox-questions";
import type { InboxAttachment, InboxLiveSiteRef } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { prototypePlace } from "./inbox-live";

/** A path's realpath when it exists, else the path as resolved. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The attachment a prototype's path names, or null: the path (without `?` or
 * `#`) from each base (the folder the agent sent from, then the project
 * root), or as an absolute path, against each attachment's realpath and the
 * path the agent named; else a bare file name the one attachment of that
 * name has.
 */
export function prototypeFileAttachment(target: string, attachments: readonly InboxAttachment[], bases: readonly string[]): InboxAttachment | null {
  const path = target.trim().replace(/[?#].*$/s, "");
  if (!path || attachments.length === 0) return null;
  const candidates = new Set<string>();
  const add = (full: string) => {
    candidates.add(full);
    candidates.add(real(full));
  };
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Not percent-encoded after all.
  }
  for (const written of new Set([path, decoded])) {
    if (isAbsolute(written)) add(resolve(written));
    else for (const base of bases) if (base && isAbsolute(base)) add(resolve(base, written));
  }
  const hit = attachments.find((a) => candidates.has(a.path) || (a.named_path !== null && candidates.has(a.named_path)));
  if (hit) return hit;
  if (/[\\/]/.test(decoded)) return null;
  const named = attachments.filter((a) => a.name === decoded || basename(a.path) === decoded);
  return named.length === 1 ? named[0]! : null;
}

export interface CheckedPrototypes {
  /** The running apps, checked and probed (the message's `live_sites`). */
  liveSites: Omit<InboxLiveSiteRef, "opened_at">[];
}

/**
 * Check a body's prototypes before the send writes anything: each file is an
 * attached HTML file, each app passes the live engine's checks and probe.
 * `checkApps` absent: this Inbox takes no app (the send is refused when the
 * body names one). `probing: false` on a replay of a message already sent.
 */
export async function checkSendPrototypes(
  body: string,
  options: {
    attachments: readonly InboxAttachment[];
    bases: readonly string[];
    checkApps?: (apps: readonly PrototypeAppTarget[], probing?: boolean) => Promise<Omit<InboxLiveSiteRef, "opened_at">[]>;
    probing: boolean;
  },
): Promise<CheckedPrototypes> {
  const targets: PrototypeTarget[] = typeof body === "string" && body.includes(":::question") ? prototypeTargets(body) : [];
  if (targets.length === 0) return { liveSites: [] };
  for (const file of targets.filter((t) => t.kind === "file")) {
    const attachment = prototypeFileAttachment(file.target, options.attachments, options.bases);
    if (!attachment) {
      throw new InboxError(
        "validation_error",
        `body: ${prototypePlace(file)}: Prototype: ${file.target}: not in attachments. Attach the HTML file in the same send, or give the address of an app running on this computer (http://localhost:…).`,
        { field: "body" },
      );
    }
    if (attachment.kind !== "html") {
      throw new InboxError("validation_error", `body: ${prototypePlace(file)}: Prototype: ${file.target}: a prototype is an HTML page; ${attachment.name} is not one.`, { field: "body" });
    }
  }
  const apps = targets.filter((t) => t.kind === "app");
  if (apps.length === 0) return { liveSites: [] };
  if (!options.checkApps) {
    throw new InboxError("validation_error", `body: ${prototypePlace(apps[0]!)}: Prototype: ${apps[0]!.target}: this Inbox shows no running app.`, { field: "body" });
  }
  return { liveSites: await options.checkApps(apps, options.probing) };
}
