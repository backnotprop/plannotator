/**
 * Plannotator Inbox: which apps an attachment may open in (design record
 * "inbox-open-in", approved 2026-10-14). Pure and browser-safe: the window
 * builds its menu from it and the server's launch route
 * (packages/server/inbox-open-in.ts) refuses anything it does not allow.
 *
 * - HTML opens in a new browser tab of the page, served from its own folder
 *   under the sandbox the Inbox applies to attached pages. That is a link in
 *   the window; the server never hands an HTML file to the OS default
 *   handler, which would load it from `file://` unsandboxed.
 * - Markdown, text, code and config open in an editor from the catalog.
 * - Images, PDFs and videos open in the OS default viewer, but only when the name's
 *   extension says so too (the OS picks the app by extension; the Inbox
 *   picks the kind by bytes, and the server checks the bytes again at
 *   launch). SVG is not offered: its default app is often a browser, which
 *   would run its scripts.
 * - md, txt, json, yaml, toml and log also get the OS default on macOS and
 *   Windows (never on Linux, where `xdg-open` may sniff the content).
 * - Everything else, executables and archives included, gets the file
 *   manager (reveal) and Copy path only. Plannotator never runs a file.
 */

import { readInboxAttachmentKind } from "./inbox-attachments";
import type { OpenInKind, OpenInPlatform } from "./open-in-apps";

/** The `app_id` of the OS default handler (never a catalog id). */
export const INBOX_OPEN_IN_DEFAULT_APP = "default";

/** Image extensions the OS default viewer gets (SVG deliberately not). */
const DEFAULT_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "apng", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);

/** Video extensions the OS default player gets (the bytes are checked again at launch). */
const DEFAULT_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set(["mp4", "m4v", "mov", "webm"]);

/** Text extensions the OS default app gets on macOS and Windows. */
const DEFAULT_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown", "txt", "json", "yaml", "yml", "toml", "log"]);

/** What an attachment may open in. Reveal (the file manager) is always allowed. */
export interface InboxOpenInPolicy {
  /** A new browser tab of the page (HTML only): the window's link, never a launch. */
  browser: boolean;
  /** Catalog editors, which open the file itself. */
  editors: boolean;
  /** The OS default handler (`app_id: "default"`). */
  systemDefault: boolean;
}

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The per-kind policy for an attachment (its recorded kind and realpath) on this platform. */
export function inboxOpenInPolicy(attachment: { kind: unknown; path: string }, platform: OpenInPlatform): InboxOpenInPolicy {
  const kind = readInboxAttachmentKind(attachment.kind);
  const ext = extensionOf(attachment.path);
  switch (kind) {
    case "html":
      return { browser: true, editors: true, systemDefault: false };
    case "markdown":
    case "text":
      return { browser: false, editors: true, systemDefault: platform !== "linux" && DEFAULT_TEXT_EXTENSIONS.has(ext) };
    case "code":
    case "mermaid":
    case "graphviz":
      return { browser: false, editors: true, systemDefault: false };
    case "image":
      return { browser: false, editors: false, systemDefault: DEFAULT_IMAGE_EXTENSIONS.has(ext) };
    case "video":
      return { browser: false, editors: false, systemDefault: DEFAULT_VIDEO_EXTENSIONS.has(ext) };
    case "pdf":
      return { browser: false, editors: false, systemDefault: ext === "pdf" };
    default:
      return { browser: false, editors: false, systemDefault: false };
  }
}

/**
 * Whether the policy allows an app the server would launch: the OS default
 * by its id, the file manager always, an editor when the kind takes editors.
 * Terminals and anything else are never allowed.
 */
export function inboxOpenInAllows(policy: InboxOpenInPolicy, app: { id: string; kind?: OpenInKind }): boolean {
  if (app.id === INBOX_OPEN_IN_DEFAULT_APP) return policy.systemDefault;
  if (app.kind === "file-manager") return true;
  if (app.kind === "editor") return policy.editors;
  return false;
}
