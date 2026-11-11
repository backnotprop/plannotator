/**
 * Saves a history version when the open file changes on disk.
 * The server reads the file itself (a client never supplies the saved text) and saves only if the bytes on disk still have the hash the editor named.
 */

import { statSync } from "node:fs";
import { computeAnnotateHistory, type AnnotateHistoryResult } from "./annotate-history";
import { readSourceFileSnapshot } from "./source-save-node";
import { MAX_ANNOTATABLE_FILE_BYTES } from "@plannotator/core/annotatable";
import { isSourceSaveFilePath } from "@plannotator/core/source-save";
import { checkServerSession, serverSessionMismatchBody } from "@plannotator/core/server-session";

export const ANNOTATE_LIVE_VERSION_PATH = "/api/plan/versions";

export interface AnnotateLiveVersionContext {
  serverSession: string;
  historyEnabled: boolean;
  resolvedFilePath: string | null;
  project: string;
  readSnapshot?: (path: string) => { text: string; hash: string };
  sizeOf?: (path: string) => number;
}

export type AnnotateLiveVersionOutcome =
  | { status: 200; body: AnnotateLiveVersionSaved; history: AnnotateHistoryResult }
  | { status: 400 | 404 | 409 | 413 | 500; body: { ok: false; code: string; error: string } };

export interface AnnotateLiveVersionSaved {
  ok: true;
  saved: boolean;
  previousPlan: string | null;
  versionInfo: AnnotateHistoryResult["versionInfo"];
}

function refuse(status: 400 | 404 | 409 | 413 | 500, code: string, error: string): AnnotateLiveVersionOutcome {
  return { status, body: { ok: false, code, error } };
}

export function saveAnnotateLiveVersion(
  body: unknown,
  ctx: AnnotateLiveVersionContext,
): AnnotateLiveVersionOutcome {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return refuse(400, "validation_error", "Expected a JSON object.");
  }
  if (checkServerSession(body, ctx.serverSession) === "mismatch") {
    const mismatch = serverSessionMismatchBody();
    return refuse(409, mismatch.code, mismatch.error);
  }
  const hash = (body as Record<string, unknown>).hash;
  if (typeof hash !== "string" || hash.length === 0 || hash.length > 200) {
    return refuse(400, "validation_error", "hash: the source hash of the text on screen is required.");
  }
  if (!ctx.resolvedFilePath) {
    return refuse(404, "not_eligible", "Live versions are kept only for a single local Markdown or text file.");
  }
  if (!ctx.historyEnabled) {
    return refuse(409, "history_off", "Annotate history is turned off (PLANNOTATOR_ANNOTATE_HISTORY=0).");
  }

  // The annotate cap (2 MB), checked before the read and again on the bytes
  // read, so a file that grew past it is never read whole or saved.
  const tooLarge = () => refuse(413, "too_large", "The file is too large to keep as a version (max 2MB).");
  let snapshot: { text: string; hash: string };
  try {
    if ((ctx.sizeOf ?? ((path: string) => statSync(path).size))(ctx.resolvedFilePath) > MAX_ANNOTATABLE_FILE_BYTES) {
      return tooLarge();
    }
    snapshot = (ctx.readSnapshot ?? readSourceFileSnapshot)(ctx.resolvedFilePath);
  } catch {
    return refuse(409, "missing", "The file could not be read.");
  }
  if (new TextEncoder().encode(snapshot.text).byteLength > MAX_ANNOTATABLE_FILE_BYTES) return tooLarge();
  if (snapshot.hash !== hash) {
    return refuse(409, "stale", "The file changed again; nothing was saved.");
  }
  if (snapshot.text.length === 0) {
    return refuse(409, "empty", "The file is empty; nothing was saved.");
  }

  const history = computeAnnotateHistory(ctx.project, ctx.resolvedFilePath, snapshot.text);
  if (!history) {
    return refuse(500, "history_unavailable", "The version could not be saved.");
  }
  return {
    status: 200,
    history,
    body: {
      ok: true,
      saved: history.isNew,
      previousPlan: history.previousPlan,
      versionInfo: history.versionInfo,
    },
  };
}

export function annotateLiveVersionFilePath(input: {
  sourceSaveEligible: boolean;
  resolvedFilePath: string;
  realFilePath: string | null;
}): string | null {
  if (!input.sourceSaveEligible) return null;
  if (!isSourceSaveFilePath(input.resolvedFilePath)) return null;
  if (input.realFilePath && !isSourceSaveFilePath(input.realFilePath)) return null;
  return input.resolvedFilePath;
}
