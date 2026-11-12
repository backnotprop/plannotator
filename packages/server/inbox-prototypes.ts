import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { prototypeTargets, type PrototypeAppTarget, type PrototypeTarget } from "@plannotator/core/inbox-questions";
import type { InboxAttachment, InboxLiveSiteRef } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { prototypePlace } from "./inbox-live";

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

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
  liveSites: Omit<InboxLiveSiteRef, "opened_at">[];
}

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
