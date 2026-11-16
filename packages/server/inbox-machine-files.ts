/**
 * A linked machine's attached Markdown or HTML file, read here as a file of this computer is (the owner, 2026-11-16:
 * "Yes, for linked computers only"): the pictures a Markdown file shows (`attachments/<id>/markdown-image`) and a
 * document next to it that a link opens in the pane (`attachments/<id>/linked-page`).
 *
 * Both are that machine's own window routes, reached through its door for a linked machine only (inbox-devices.ts,
 * `machineOnly`: a phone gets the unknown-route 404), with that machine's own rules, which this Inbox does not change.
 * What a linked machine can read through them, exactly:
 *  - `linked-page`: every `.md`/`.mdx` file (for a Markdown attachment) or `.html`/`.htm` file (for an HTML
 *    attachment) of at most 2 MB, at any depth under the folder of any attachment on that machine (whatever that
 *    folder is: no depth limit, and the root is the attachment's folder), by name (there is no listing), with no
 *    hidden segment or dotenv name below that folder, never through a symlink that leads out of it. A linked machine
 *    can make a new root: attaching any file an agent's message on that machine names (`open-in/file/attach`) makes
 *    that file's folder one.
 *  - `markdown-image`: the message-image rules (`readInboxMessageImageAsync`): every image (sniffed, at most 10 MB)
 *    that the attached Markdown file references, or with `?document=` that any `.md` such a `linked-page` would serve
 *    references; for an agent's message from anywhere on that machine's disk except dotenv files and the hidden
 *    folders of home or `/`, for the person's own message from its project.
 * Only this Inbox's window asks for either (`forwardedFileReadRefusal`: `Sec-Fetch-Site: same-origin`), so an agent's
 * or a script's bare call on this computer cannot read them through the forward.
 *
 * What this Inbox adds, whatever the far machine sends (an older, buggy or hostile one included):
 *  - a picture: a local picture's headers (`INBOX_MESSAGE_IMAGE_CSP`, nosniff, a same-origin CORP,
 *    `Cache-Control: private, no-cache`, no Content-Disposition, the far ETag kept), only when the far type is
 *    `image/…` (`502` for any other type or none), and at most the local cap (`MACHINE_IMAGE_MAX_BYTES`), cut off
 *    while it streams past it;
 *  - a linked page: a JSON answer only, read up to the view's cap, rebuilt with this Inbox's own JSON headers from
 *    the fields the window reads (each capped), its html's asset URLs and its Open in new tab URL rebased onto this
 *    Inbox's forward (inbox-machine-page.ts), an URL that is not a far asset URL dropped.
 * Both are read from this computer's own window (same-origin): the cross-site exception does not change.
 */
import { MAX_REVIEW_IMAGE_PREVIEW_BYTES } from "@plannotator/shared/diff-paths";
import { MAX_HTML_ASSET_DOCUMENT_BYTES } from "@plannotator/shared/html-assets";
import { INBOX_MESSAGE_IMAGE_CSP } from "@plannotator/shared/inbox/message-images";
import { MACHINE_VIEW_MAX_BYTES, readCappedBytes, rebaseMachineHtmlAssets, refusal } from "./inbox-machine-page";

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

/** A far picture's headers as a local picture's: this Inbox's CORP and cache rule, never the far disposition. */
function pictureHeaders(far: Headers): Headers {
  const headers = new Headers(far);
  headers.set("cross-origin-resource-policy", "same-origin");
  // As the local route (inboxImageResponse): the file can change on disk, so the window revalidates by its ETag.
  headers.set("cache-control", "private, no-cache");
  headers.delete("content-disposition");
  return headers;
}

/**
 * A far `markdown-image` answer as a local picture. A 200 must be an image, at most the cap; a 304 gets a local
 * picture's headers; a refusal or anything else passes on as the forward passes any far answer. The forward sets the
 * CSP and nosniff.
 */
export function machineMarkdownImageAnswer(answer: Response): Response {
  if (answer.status === 304) return new Response(null, { status: 304, headers: pictureHeaders(answer.headers) });
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
  return new Response(answer.body ? capped(answer.body, MACHINE_IMAGE_MAX_BYTES) : null, { status: 200, headers: pictureHeaders(answer.headers) });
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

/** The longest name and path a linked page's answer may carry: a file name, and a path on any disk. */
const LINKED_NAME_MAX = 1024;
const LINKED_PATH_MAX = 4096;
/**
 * Its text (a real far machine reads at most 2 MB) and its served html. The html is that file after `rewriteHtml`
 * (re-serialized, and every relative asset reference given its folder's route), which can grow well past the file:
 * a 2 MB page with thousands of pictures opens on that machine, so it opens here too.
 */
const LINKED_TEXT_MAX = MAX_HTML_ASSET_DOCUMENT_BYTES;
const LINKED_HTML_MAX = 4 * MAX_HTML_ASSET_DOCUMENT_BYTES;
/** This Inbox's own headers on a rebuilt answer (the forward adds `sandbox` and nosniff). */
const LINKED_PAGE_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/**
 * A far `linked-page` answer as the window reads a local one: `{ serverSession, path, name, html, text?, url }`, under
 * this Inbox's own JSON headers, the html's asset URLs and the new tab's URL through the forward. A refusal passes on;
 * a 200 that is not JSON, of another shape, or past a cap is refused here.
 */
export async function machineLinkedPageAnswer(answer: Response, machine: string): Promise<Response> {
  if (answer.status !== 200) return answer;
  const unreadable = () => refusal(502, "machine_answer_unreadable", "That machine's answer could not be read.");
  const tooLargePage = () => refusal(413, "machine_page_too_large", "This page is too large to open from another computer.");
  if (!/^application\/json\s*(?:;|$)/i.test((answer.headers.get("content-type") ?? "").trim())) {
    void answer.body?.cancel().catch(() => {});
    return unreadable();
  }
  const bytes = await readCappedBytes(answer, MACHINE_VIEW_MAX_BYTES);
  if (!bytes) {
    void answer.body?.cancel().catch(() => {});
    return tooLargePage();
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown> | null;
  } catch {
    body = null;
  }
  const html = body?.html;
  const shaped = body && typeof body.path === "string" && typeof body.name === "string" && (typeof html === "string" || (html === null && typeof body.text === "string"));
  if (!body || !shaped) return unreadable();
  const { path, name } = body as { path: string; name: string };
  if (!name || name.length > LINKED_NAME_MAX || !path || path.length > LINKED_PATH_MAX) return unreadable();
  if (typeof html === "string" ? html.length > LINKED_HTML_MAX : (body.text as string).length > LINKED_TEXT_MAX) return tooLargePage();
  const page =
    typeof html === "string"
      ? { html: rebaseMachineHtmlAssets(html, machine), url: farDocumentUrl(body.url, machine) }
      : { html: null, text: body.text as string, url: null };
  const session = typeof body.serverSession === "string" ? body.serverSession.slice(0, 128) : "";
  return new Response(JSON.stringify({ serverSession: session, path, name, ...page }), { status: 200, headers: LINKED_PAGE_HEADERS });
}
