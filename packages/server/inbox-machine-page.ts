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
 * pictures it names load from here through the forward. The rebase is a convenience, not a boundary: it only ever
 * writes this Inbox's own route to the same machine, and a page that steps around it reaches nothing a local page
 * could not (every folder still needs its token).
 *
 * What this Inbox guarantees, whatever the far machine sends (an older, buggy or hostile one included):
 *  - the new tab is a local page's: the same 303 to the page's own asset URL, or the same body under
 *    `htmlAssetDocumentHeaders(INBOX_HTML_DOCUMENT_CSP)`, the byte guards and `Referrer-Policy: no-referrer`;
 *  - an answer from the folder (`html-assets/…`) gets a local folder's CSP, never the far one: a page
 *    `INBOX_HTML_DOCUMENT_CSP`, anything else `HTML_ASSET_SUBRESOURCE_CSP` (`machineAssetCsp`);
 *  - every other forwarded answer keeps the far CSP only as `farCsp` leaves it: always sandboxed, never with
 *    `allow-same-origin`, `allow-top-navigation…` or `allow-popups-to-escape-sandbox`, and always `nosniff`
 *    (the forward's `passAnswer`). So nothing another machine serves runs as this origin.
 *  - what is read into memory here is capped; past the cap the answer streams on as it came (not rebased), or the
 *    page is refused.
 */
import { HTML_ASSET_SUBRESOURCE_CSP, MAX_HTML_ASSET_DOCUMENT_BYTES, htmlAssetDocumentHeaders } from "@plannotator/shared/html-assets";
import { readInboxAttachmentKind } from "@plannotator/core/inbox-types";
import { BYTE_GUARD_HEADERS, INBOX_HTML_DOCUMENT_CSP, inboxRefusesAssetPath } from "./inbox-attachments";

/** The new-tab page of an attachment, as the window names it after the forward's machine id. */
export const MACHINE_PAGE_ROUTE = /^attachments\/([^/]+)\/page$/;
/** The viewer's read of an attachment. */
export const MACHINE_VIEW_ROUTE = /^attachments\/[^/]+\/view$/;
/** The far machine's HTML asset route (its door's `html-assets/<token>/<path>`). */
export const MACHINE_ASSET_ROUTE = /^html-assets\/[^/]+\/.+$/;

/**
 * The most of a far `view` answer read here: the page's text and its served html (each at most the 2 MB document
 * cap on a real Inbox), JSON-escaped, with room to spare.
 */
export const MACHINE_VIEW_MAX_BYTES = 8 * MAX_HTML_ASSET_DOCUMENT_BYTES;
/** The most of a far page or stylesheet rebased here; a bigger one streams on as it came. */
export const MACHINE_ASSET_REBASE_MAX_BYTES = 4 * MAX_HTML_ASSET_DOCUMENT_BYTES;

/** A root-relative `/api/html-assets/` (after a quote, `(`, `=`, a comma or a space), never one inside another URL. */
const ROOT_RELATIVE_ASSETS = /(?<![\w.:/%-])\/api\/html-assets\//g;

/** `text` with every root-relative `/api/html-assets/` the far machine wrote pointed at this Inbox's forward to it. */
export function rebaseMachineHtmlAssets(text: string, machine: string): string {
  return text.replace(ROOT_RELATIVE_ASSETS, `/api/inbox/m/${machine}/html-assets/`);
}

/** Sandbox flags that would let a far document act as this origin, or leave its sandbox. */
const ESCAPING_FLAG = /^(?:allow-same-origin|allow-top-navigation(?:-[a-z-]+)?|allow-popups-to-escape-sandbox)$/i;

/**
 * A far answer's CSP as this origin serves it: every `sandbox` directive kept without the flags that would escape it,
 * and `sandbox` added when there is none. Several policies (`,`) are read as one: the sandbox is what is guaranteed.
 */
export function farCsp(csp: string | null | undefined): string {
  const directives = (csp ?? "").split(/[;,]/).map((d) => d.trim()).filter(Boolean);
  let sandboxed = false;
  const kept = directives.map((directive) => {
    const [name, ...flags] = directive.split(/\s+/);
    if (name!.toLowerCase() !== "sandbox") return directive;
    sandboxed = true;
    return ["sandbox", ...flags.filter((flag) => !ESCAPING_FLAG.test(flag))].join(" ");
  });
  if (!sandboxed) kept.push("sandbox");
  return kept.join("; ");
}

/** An HTML comment, to the end of the text when unclosed. A RegExp constructor: Semgrep's TS parser fails on `<!--` in a regex literal. */
const HTML_COMMENT = new RegExp("<!--[\\s\\S]*?(?:-->|$)", "g");

/** The token of the page's own folder, from the first `<base href>` its window wrote (comments skipped). */
function folderToken(html: string): string | null {
  const base = /<base\b[^>]*>/i.exec(html.replace(HTML_COMMENT, ""));
  return base ? (/\bhref\s*=\s*["']?\/api\/html-assets\/([A-Za-z0-9_-]+)\//i.exec(base[0])?.[1] ?? null) : null;
}

/**
 * At most `max` bytes of `answer`, read from a twin so that past the cap the answer itself still streams on whole.
 * Null past the cap (or a declared length past it); the answer is then untouched.
 */
export async function readCappedBytes(answer: Response, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(answer.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  const twin = answer.clone();
  const reader = twin.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      void reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  // Read whole: the answer's own copy of the bytes is not needed.
  void answer.body?.cancel().catch(() => {});
  return new Uint8Array(Buffer.concat(chunks));
}

/** A rebased body's headers: its length, range and ranges are B's no longer. */
function rebasedHeaders(headers: Headers): Headers {
  const out = new Headers(headers);
  for (const name of ["content-length", "content-range", "accept-ranges"]) out.delete(name);
  return out;
}

interface FarView {
  html?: unknown;
  attachment?: { kind?: unknown; name?: unknown; path?: unknown; unavailable?: unknown; current?: { size?: unknown } | null };
}

export const refusal = (status: number, code: string, error: string) => Response.json({ error, code }, { status, headers: BYTE_GUARD_HEADERS });

/**
 * `attachments/<id>/page` for a page on `machine`, from its door's `view` answer. `pass` hands a refusal (or an
 * answer that is not one this can read) to the window as the forward passes any far answer.
 */
export async function machinePageAnswer(view: Response, machine: string, search: string, pass: (response: Response) => Response): Promise<Response> {
  if (view.status !== 200 || !(view.headers.get("content-type") ?? "").includes("json")) return pass(view);
  const bytes = await readCappedBytes(view, MACHINE_VIEW_MAX_BYTES);
  if (!bytes) {
    void view.body?.cancel().catch(() => {});
    return refusal(413, "machine_page_too_large", "This page is too large to open from another computer.");
  }
  let body: FarView | null = null;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as FarView | null;
  } catch {
    body = null;
  }
  const attachment = body?.attachment;
  if (!attachment || typeof body?.html !== "string") {
    const name = typeof attachment?.name === "string" ? attachment.name : "This attachment";
    if (attachment && readInboxAttachmentKind(attachment.kind) !== "html") return refusal(415, "attachment_not_html", `${name} is not an HTML page.`);
    return refusal(502, "machine_answer_unreadable", "That machine's answer could not be read.");
  }
  const sent = new URLSearchParams(search).get("version") === "sent";
  // As a local page: the current file gone or changed type is refused with its own words (the sent version still opens).
  const unavailable = attachment.unavailable as { code?: unknown; message?: unknown } | null | undefined;
  if (!sent && unavailable && typeof unavailable.code === "string") {
    const known = unavailable.code === "attachment_changed_type" || unavailable.code === "attachment_missing";
    return refusal(unavailable.code === "attachment_changed_type" ? 409 : 404, known ? unavailable.code : "attachment_missing", typeof unavailable.message === "string" ? unavailable.message.slice(0, 300) : "The file is not on disk as it was.");
  }
  const token = folderToken(body.html);
  const name = typeof attachment.path === "string" ? (attachment.path.split(/[\\/]/).pop() ?? "") : "";
  const size = typeof attachment.current?.size === "number" ? attachment.current.size : Infinity;
  // As a local page: the file at its own folder's asset URL, through the forward, so relative assets, #anchors and
  // frames resolve natively under the document CSP. A name the asset route refuses, a page over its size or the sent
  // bytes are served below instead. Only a token and one encoded name segment reach the Location.
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
  if (view.status !== 200 || !(view.headers.get("content-type") ?? "").includes("json")) return view;
  const bytes = await readCappedBytes(view, MACHINE_VIEW_MAX_BYTES);
  // Past the cap: as it came (the viewer still shows the page; its folder may not load).
  if (!bytes) return view;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return new Response(bytes, { status: view.status, headers: view.headers });
  }
  if (!body || typeof body.html !== "string") return new Response(bytes, { status: view.status, headers: view.headers });
  return new Response(JSON.stringify({ ...body, html: rebaseMachineHtmlAssets(body.html, machine) }), { status: view.status, headers: rebasedHeaders(view.headers) });
}

/**
 * A far HTML asset. A document or a stylesheet (a plain 200) names pictures by root-relative token URLs, which are
 * rebased byte for byte (read as Latin-1, so every other byte, whatever the charset, comes back as it was). A part
 * (206), a refusal, anything else, or a body past the cap: as it came.
 */
export async function machineAssetAnswer(answer: Response, machine: string): Promise<Response> {
  const type = (answer.headers.get("content-type") ?? "").toLowerCase();
  if (answer.status !== 200 || !(type.startsWith("text/html") || type.startsWith("text/css"))) return answer;
  const bytes = await readCappedBytes(answer, MACHINE_ASSET_REBASE_MAX_BYTES);
  if (!bytes) return answer;
  const rebased = Buffer.from(rebaseMachineHtmlAssets(Buffer.from(bytes).toString("latin1"), machine), "latin1");
  return new Response(rebased, { status: 200, headers: rebasedHeaders(answer.headers) });
}

/**
 * The CSP a far `html-assets/…` answer gets here, whatever the far one said: a local folder's. A page is a local
 * attached page's (`INBOX_HTML_DOCUMENT_CSP`); anything else is a local support asset's (`HTML_ASSET_SUBRESOURCE_CSP`).
 */
export function machineAssetCsp(answer: Response): string {
  return (answer.headers.get("content-type") ?? "").trim().toLowerCase().startsWith("text/html") ? INBOX_HTML_DOCUMENT_CSP : HTML_ASSET_SUBRESOURCE_CSP;
}
