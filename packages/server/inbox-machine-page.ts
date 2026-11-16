/**
 * Another linked machine's attached HTML page, opened from this Inbox: in a tab of its own ("Open in" → Browser,
 * `attachments/<id>/page`) and in the viewer's frame (`attachments/<id>/view`). The owner, 2026-11-16: a page an agent
 * wrote on another of the person's computers opens here as seamlessly as a local one.
 *
 * Built only from what that machine's door already serves, so its door, and what a phone reaches, are unchanged:
 *  - `attachments/<id>/view`: the page as its window reads it, with a `<base href>` at its folder's asset route
 *    (`/api/html-assets/<token>/`) and the attachment's state;
 *  - `html-assets/<token>/<path>`: that folder, under the far machine's unguessable per-folder token.
 * Every root-relative `/api/html-assets/` the far machine wrote names ITS asset route, which this origin does not
 * know. It is rebased onto the forward, `/api/inbox/m/<machine>/html-assets/`, so the page, its folder and the
 * pictures it names load from here through the forward.
 *
 * The protection is a local page's, exactly (`packages/server/inbox-attachments.ts`, the `page` route): the same
 * 303 to the page's own asset URL, or the same body with `htmlAssetDocumentHeaders(INBOX_HTML_DOCUMENT_CSP)`, the
 * byte guards and `Referrer-Policy: no-referrer`; and the asset answers keep the far machine's sandboxed headers
 * (the forward's `passAnswer` adds `sandbox` if one ever lacks it).
 */
import { MAX_HTML_ASSET_DOCUMENT_BYTES, htmlAssetDocumentHeaders } from "@plannotator/shared/html-assets";
import { readInboxAttachmentKind } from "@plannotator/core/inbox-types";
import { BYTE_GUARD_HEADERS, INBOX_HTML_DOCUMENT_CSP, inboxRefusesAssetPath } from "./inbox-attachments";

/** The new-tab page of an attachment, as the window names it after the forward's machine id. */
export const MACHINE_PAGE_ROUTE = /^attachments\/([^/]+)\/page$/;
/** The viewer's read of an attachment. */
export const MACHINE_VIEW_ROUTE = /^attachments\/[^/]+\/view$/;
/** The far machine's HTML asset route (its door's `html-assets/<token>/<path>`). */
export const MACHINE_ASSET_ROUTE = /^html-assets\/[^/]+\/.+$/;

/** A root-relative `/api/html-assets/` (after a quote, `(`, `=`, a comma or a space), never one inside another URL. */
const ROOT_RELATIVE_ASSETS = /(?<![\w.:/%-])\/api\/html-assets\//g;

/** `text` with every root-relative `/api/html-assets/` the far machine wrote pointed at this Inbox's forward to it. */
export function rebaseMachineHtmlAssets(text: string, machine: string): string {
  return text.replace(ROOT_RELATIVE_ASSETS, `/api/inbox/m/${machine}/html-assets/`);
}

/** The token of the page's own folder, from the first `<base href>` its window wrote (comments skipped). */
function folderToken(html: string): string | null {
  const base = /<base\b[^>]*>/i.exec(html.replace(/<!--[\s\S]*?(?:-->|$)/g, ""));
  return base ? (/\bhref\s*=\s*["']?\/api\/html-assets\/([A-Za-z0-9_-]+)\//i.exec(base[0])?.[1] ?? null) : null;
}

/** Headers without the length (a rebased body has another). */
function withoutLength(headers: Headers): Headers {
  const out = new Headers(headers);
  out.delete("content-length");
  return out;
}

interface FarView {
  html?: unknown;
  attachment?: { kind?: unknown; name?: unknown; path?: unknown; unavailable?: unknown; current?: { size?: unknown } | null };
}

/**
 * `attachments/<id>/page` for a page on `machine`, from its door's `view` answer. `pass` hands a refusal (or an
 * answer that is not one this can read) to the window as the forward passes any far answer.
 */
export async function machinePageAnswer(view: Response, machine: string, search: string, pass: (response: Response) => Response): Promise<Response> {
  if (!view.ok || !(view.headers.get("content-type") ?? "").includes("json")) return pass(view);
  const body = (await view.json().catch(() => null)) as FarView | null;
  const attachment = body?.attachment;
  if (!attachment || typeof body?.html !== "string") {
    const name = typeof attachment?.name === "string" ? attachment.name : "This attachment";
    if (attachment && readInboxAttachmentKind(attachment.kind) !== "html") {
      return Response.json({ error: `${name} is not an HTML page.`, code: "attachment_not_html" }, { status: 415, headers: BYTE_GUARD_HEADERS });
    }
    return Response.json({ error: "That machine's answer could not be read.", code: "machine_answer_unreadable" }, { status: 502, headers: BYTE_GUARD_HEADERS });
  }
  const sent = new URLSearchParams(search).get("version") === "sent";
  // As a local page: the current file gone or changed type is refused with its own words (the sent version still opens).
  const unavailable = attachment.unavailable as { code?: unknown; message?: unknown } | null | undefined;
  if (!sent && unavailable && typeof unavailable.code === "string") {
    const status = unavailable.code === "attachment_changed_type" ? 409 : 404;
    return Response.json({ error: typeof unavailable.message === "string" ? unavailable.message : "The file is not on disk as it was.", code: unavailable.code }, { status, headers: BYTE_GUARD_HEADERS });
  }
  const token = folderToken(body.html);
  const name = typeof attachment.path === "string" ? (attachment.path.split(/[\\/]/).pop() ?? "") : "";
  const size = typeof attachment.current?.size === "number" ? attachment.current.size : Infinity;
  // As a local page: the file at its own folder's asset URL, through the forward, so relative assets, #anchors and
  // frames resolve natively under the document CSP. A name the asset route refuses, a page over its size or the sent
  // bytes are served below instead.
  if (!sent && token && /\.html?$/i.test(name) && !inboxRefusesAssetPath(name) && size <= MAX_HTML_ASSET_DOCUMENT_BYTES) {
    const location = `/api/inbox/m/${machine}/html-assets/${encodeURIComponent(token)}/${encodeURIComponent(name)}`;
    return new Response(null, { status: 303, headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  return new Response(rebaseMachineHtmlAssets(body.html, machine), {
    headers: { ...htmlAssetDocumentHeaders(INBOX_HTML_DOCUMENT_CSP), ...BYTE_GUARD_HEADERS, "Referrer-Policy": "no-referrer" },
  });
}

/** The far `view` answer with its page's `html` rebased, so the viewer's frame loads the page's folder through the forward. */
export async function machineViewAnswer(view: Response, machine: string): Promise<Response> {
  if (!view.ok || !(view.headers.get("content-type") ?? "").includes("json")) return view;
  const text = await view.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return new Response(text, { status: view.status, headers: view.headers });
  }
  if (typeof body.html !== "string") return new Response(text, { status: view.status, headers: view.headers });
  return new Response(JSON.stringify({ ...body, html: rebaseMachineHtmlAssets(body.html, machine) }), { status: view.status, headers: withoutLength(view.headers) });
}

/** A far HTML asset: a document or a stylesheet names pictures by root-relative token URLs, which are rebased; anything else as it came. */
export async function machineAssetAnswer(answer: Response, machine: string): Promise<Response> {
  const type = (answer.headers.get("content-type") ?? "").toLowerCase();
  if (!answer.ok || !(type.startsWith("text/html") || type.startsWith("text/css"))) return answer;
  return new Response(rebaseMachineHtmlAssets(await answer.text(), machine), { status: answer.status, headers: withoutLength(answer.headers) });
}
