import { createHash } from "node:crypto";
import { sanitizeTag } from "@plannotator/core/project";

export function inboxProjectKey(name: string, root: string, hashLength = 6): string {
  const base = sanitizeTag(name) ?? "project";
  const hash = createHash("sha256").update(root).digest("hex").slice(0, Math.min(hashLength, 64));
  return `${base}-${hash}`;
}
