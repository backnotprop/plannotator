/**
 * A linked machine's attached Markdown or HTML file, read here as a file of this computer is (the owner, 2026-11-16:
 * "Yes, for linked computers only"): the pictures a Markdown file shows (`attachments/<id>/markdown-image`) and a
 * document next to it that a link opens in the pane (`attachments/<id>/linked-page`).
 *
 * Both are that machine's own window routes, reached through its door for a linked machine only (inbox-devices.ts,
 * `machineOnly`: a phone gets the unknown-route 404), so the far machine applies its own rules: by the attachment's
 * id, a path relative to the file's folder (never absolute), inside that folder by realpath, no hidden segment or
 * dotenv name, only pictures the file itself shows, sniffed and capped. No door answer changes.
 *
 * What this Inbox adds, whatever the far machine sends (an older, buggy or hostile one included):
 *  - a picture: a local picture's headers (`INBOX_MESSAGE_IMAGE_CSP`, nosniff, a same-origin CORP), an `image/` type
 *    or nothing, and at most the local cap (`MACHINE_IMAGE_MAX_BYTES`), cut off while it streams past it;
 *  - a linked page: read up to the view's cap, only the fields the window reads, its html's asset URLs and its
 *    Open in new tab URL rebased onto this Inbox's forward (inbox-machine-page.ts), an URL that is not a far asset
 *    URL dropped.
 * Both are read from this computer's own window (same-origin): the cross-site exception does not change.
 */
import { MAX_REVIEW_IMAGE_PREVIEW_BYTES } from "@plannotator/shared/diff-paths";
import { INBOX_MESSAGE_IMAGE_CSP } from "@plannotator/shared/inbox/message-images";
import { MACHINE_VIEW_MAX_BYTES, readCappedBytes, rebaseMachineHtmlAssets, rebasedHeaders, refusal } from "./inbox-machine-page";

/** The pictures a far Markdown file shows. */
export const MACHINE_MARKDOWN_IMAGE_ROUTE = /^attachments\/[^/]+\/markdown-image$/;
/** A document next to a far attached file. */
export const MACHINE_LINKED_PAGE_ROUTE = /^attachments\/[^/]+\/linked-page$/;
/** The most of one far picture passed on: the local route's own cap. */
export const MACHINE_IMAGE_MAX_BYTES = MAX_REVIEW_IMAGE_PREVIEW_BYTES;
/** The CSP every far picture gets here: a local one's. */
export const MACHINE_IMAGE_CSP = INBOX_MESSAGE_IMAGE_CSP;

const tooLarge = () => refusal(413, "image_too_large", "That image is larger than 10 MB.");

/** `body`, erroring once more than `max` bytes went through. */
function capped(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let size = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > max) controller.error(new Error("image_too_large"));
        else controller.enqueue(chunk);
      },
    }),
  );
}

/**
 * A far `markdown-image` answer as a local picture. A 200 must be an image, at most the cap; a refusal, a 304 or
 * anything else passes on as the forward passes any far answer. The forward sets the CSP and nosniff.
 */
export function machineMarkdownImageAnswer(answer: Response): Response {
  if (answer.status !== 200) return answer;
  const drop = () => void answer.body?.cancel().catch(() => {});
  if (!(answer.headers.get("content-type") ?? "").trim().toLowerCase().startsWith("image/")) {
    drop();
    return refusal(502, "machine_answer_unreadable", "That machine's answer could not be read.");
  }
  const declared = Number(answer.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MACHINE_IMAGE_MAX_BYTES) {
    drop();
    return tooLarge();
  }
  const headers = new Headers(answer.headers);
  headers.set("cross-origin-resource-policy", "same-origin");
  return new Response(answer.body ? capped(answer.body, MACHINE_IMAGE_MAX_BYTES) : null, { status: 200, headers });
}

/** A far Open in new tab URL (`/api/html-assets/<token>/<path>`) through the forward, or null for anything else. */
function farDocumentUrl(url: unknown, machine: string): string | null {
  if (typeof url !== "string") return null;
  const match = /^\/api\/html-assets\/([A-Za-z0-9_-]+)\/([^?#]+)$/.exec(url);
  if (!match) return null;
  const path = match[2]!;
  if (/%2e|%2f|%5c|\\|\s/i.test(path) || path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return `/api/inbox/m/${machine}/html-assets/${match[1]}/${path}`;
}

/**
 * A far `linked-page` answer as the window reads a local one: `{ serverSession, path, name, html, text?, url }`, the
 * html's asset URLs and the new tab's URL through the forward. A refusal passes on; an answer past the cap or of
 * another shape is refused here.
 */
export async function machineLinkedPageAnswer(answer: Response, machine: string): Promise<Response> {
  if (answer.status !== 200 || !(answer.headers.get("content-type") ?? "").includes("json")) return answer;
  const bytes = await readCappedBytes(answer, MACHINE_VIEW_MAX_BYTES);
  if (!bytes) {
    void answer.body?.cancel().catch(() => {});
    return refusal(413, "machine_page_too_large", "This page is too large to open from another computer.");
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> | null;
  } catch {
    body = null;
  }
  const html = body?.html;
  const shaped = body && typeof body.path === "string" && typeof body.name === "string" && (typeof html === "string" || (html === null && typeof body.text === "string"));
  if (!body || !shaped) return refusal(502, "machine_answer_unreadable", "That machine's answer could not be read.");
  const page =
    typeof html === "string"
      ? { html: rebaseMachineHtmlAssets(html, machine), url: farDocumentUrl(body.url, machine) }
      : { html: null, text: body.text as string, url: null };
  return Response.json({ serverSession: typeof body.serverSession === "string" ? body.serverSession : "", path: body.path, name: body.name, ...page }, { status: 200, headers: rebasedHeaders(answer.headers) });
}
