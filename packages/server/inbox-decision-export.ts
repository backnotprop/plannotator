/**
 * `GET /api/inbox/threads/<id>/decisions?format=md|html|json&tz=<IANA zone>`: the thread's decisions as a download
 * (design brief "export-decisions"), with `content-disposition: attachment`, as Decision data's CSV is. Read only;
 * nothing is kept. Bun-only, like the rest of the Inbox server. The phone door carries it (`threads/:id/decisions`).
 *
 * The shape and both documents are packages/shared/inbox/decision-export*.ts; this file reads the pictures the HTML
 * embeds (each through the message image route's own rules: an image the message's body names, sniffed and capped),
 * scaled to 800 px when wider, each at most `DECISION_EXPORT_PICTURE_MAX_BYTES` and all at most
 * `DECISION_EXPORT_PICTURES_MAX_BYTES`; past either the alt text shows.
 */
import { homedir } from "node:os";
import { inboxThreadPullWire } from "@plannotator/core/inbox-types";
import {
  buildDecisionExport,
  DECISION_EXPORT_PICTURE_MAX_BYTES,
  DECISION_EXPORT_PICTURES_MAX_BYTES,
  decisionExportFileName,
  type DecisionExportFormat,
  type DecisionExportPictureSource,
  type DecisionExportV1,
} from "@plannotator/shared/inbox/decision-export";
import { renderDecisionExportHtml } from "@plannotator/shared/inbox/decision-export-html";
import { renderDecisionExportMarkdown } from "@plannotator/shared/inbox/decision-export-md";
import { readInboxMessageImageAsync } from "@plannotator/shared/inbox/message-images";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxImageScales, scaleInboxImage } from "./inbox-image-scale";
import { contentDisposition } from "./inbox-message-images";

export const INBOX_DECISION_EXPORT_ROUTE = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/decisions$/;

const PICTURE_WIDTH = 800;

const FORMATS: Record<DecisionExportFormat, string> = {
  md: "text/markdown; charset=utf-8",
  html: "text/html; charset=utf-8",
  json: "application/json; charset=utf-8",
};

/** Read each picture the document names into `images`, within the caps. Pictures that can't be read show their alt text. */
async function withPictures(doc: DecisionExportV1, pictures: readonly DecisionExportPictureSource[], store: InboxStore): Promise<void> {
  let total = 0;
  for (const source of pictures) {
    const message = store.message(source.message_id);
    const project = message ? store.project(message.project_id) : null;
    if (!message || !project) continue;
    const read = await readInboxMessageImageAsync({ body: message.body, root: project.root, base: message.base_path ?? null, path: source.src, anywhere: message.author.kind === "agent" });
    if (!read.ok) continue;
    let bytes: Uint8Array = new Uint8Array(read.bytes);
    let type = read.contentType;
    if (inboxImageScales(type, read.width, PICTURE_WIDTH, bytes.byteLength)) {
      const scaled = await scaleInboxImage(bytes, type, PICTURE_WIDTH, `decisions:${source.message_id}:${source.src}`).catch(() => null);
      if (scaled) {
        bytes = scaled.bytes;
        type = scaled.contentType;
      }
    }
    if (bytes.byteLength > DECISION_EXPORT_PICTURE_MAX_BYTES || total + bytes.byteLength > DECISION_EXPORT_PICTURES_MAX_BYTES) continue;
    total += bytes.byteLength;
    doc.images[source.ref] = `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  }
}

/** A thread's export as the download and Post decisions build it, or null for no such thread. */
export function threadDecisionExport(store: InboxStore, threadId: string, options: { tz: string; version: string; now?: () => Date }): ReturnType<typeof buildDecisionExport> | null {
  const input = store.decisionExportInput(threadId);
  if (!input) return null;
  const pulls = store.threadPulls(threadId).map((pull) => {
    const wire = inboxThreadPullWire(pull);
    return { ref: wire.ref, url: wire.url, title: wire.title };
  });
  return buildDecisionExport(input, {
    now: options.now?.() ?? new Date(),
    tz: options.tz,
    generator: `Plannotator ${options.version}`,
    pulls,
    home: process.env.HOME || homedir(),
  });
}

/** The download, or null when the path is not this route. */
export async function inboxDecisionExportRoute(url: URL, store: InboxStore, options: { version: string; now?: () => Date }): Promise<Response | null> {
  const match = INBOX_DECISION_EXPORT_ROUTE.exec(url.pathname);
  if (!match) return null;
  const threadId = match[1]!;
  const raw = url.searchParams.get("format") ?? "md";
  if (!(raw in FORMATS)) return Response.json({ error: "format: md, html or json.", code: "validation_error" }, { status: 422 });
  const format = raw as DecisionExportFormat;
  const built = threadDecisionExport(store, threadId, { tz: url.searchParams.get("tz") ?? "UTC", version: options.version, now: options.now });
  if (!built) return Response.json({ error: "No such thread.", code: "thread_not_found" }, { status: 404 });
  const { doc, pictures } = built;
  if (format !== "md") await withPictures(doc, pictures, store);
  const body = format === "md" ? renderDecisionExportMarkdown(doc) : format === "html" ? renderDecisionExportHtml(doc) : `${JSON.stringify(doc, null, 2)}\n`;
  return new Response(body, {
    headers: {
      "content-type": FORMATS[format],
      "content-disposition": contentDisposition("attachment", decisionExportFileName(doc, format)),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // Opened in place by mistake, the file still runs nothing on the Inbox's own origin.
      "content-security-policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    },
  });
}
