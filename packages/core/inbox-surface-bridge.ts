/**
 * The surface bridge (adr/implementation/inbox-mobile.md, section 5): the
 * messages between a native shell (the iPhone app's WKWebView) and the
 * surface, the single-file build of Plannotator's viewers that the shell
 * loads (`apps/hook/dist/surface.html`, built by `apps/inbox`'s
 * `build:surface`).
 *
 * The surface has no network: the shell fetches every byte through the
 * Inbox's device door and hands it over here. Picks and Send are native and
 * never cross the bridge.
 *
 * - Shell to surface: `window.plannotatorSurface.receive(message)`.
 * - Surface to shell: `window.webkit.messageHandlers.plannotatorSurface.postMessage(message)`.
 *   The shell takes messages from the main frame only, so an agent's HTML,
 *   drawn in its sandboxed frame, cannot reach the bridge.
 *
 * Every message is `{ v: 1, type, ... }`. A surface given another `v`
 * answers `error` with `code: "bridge_version"`.
 *
 * Reaches the Inbox through `@plannotator/core/inbox-types` (re-exported
 * there), so core's export map is unchanged.
 */

import type { InboxAnnotationRecord, InboxAttachmentState } from "./inbox-attachments";
import type { InboxGuideRef } from "./inbox-types";

/** The version both sides speak; `ready` carries it as `bridge`. */
export const INBOX_SURFACE_BRIDGE_VERSION = 1 as const;

/**
 * Plannotator's `Annotation` (`packages/ui/types.ts`), as the viewer made it.
 * Opaque here, as in the store (`InboxAnnotationRecord.annotation`). A draft
 * is one with an empty `text`: the shell fills the person's words in and
 * saves it through the door (exchange 7.17).
 */
export type SurfaceAnnotation = Record<string, unknown>;

// ─────────────────────────────── Shell to surface ───────────────────────────────

/** The person opens a file (3.6, 4.1 to 4.4). */
export interface SurfaceOpenAttachment {
  v: 1;
  type: "open_attachment";
  attachment: InboxAttachmentState;
  /** `"current"` or the sent sha256: the annotations' key, as the door's `view` answers it. */
  version: string;
  /** The version's text (for HTML, the page as the agent wrote it). */
  text: string;
  /** For HTML: the page with its `<base href>` rewritten onto the shell's asset scheme; null otherwise. */
  html: string | null;
  /** This file and version's annotations, waiting for a Send. */
  annotations: InboxAnnotationRecord[];
  /** An annotation id to scroll to (the "3 annotations" sheet's file name), or null. */
  focus: string | null;
}

/** A guided review opens (6.1, 6.2) on its sections. */
export interface SurfaceOpenGuide {
  v: 1;
  type: "open_guide";
  message_id: string;
  guide: InboxGuideRef;
  /** The stored snapshot, exactly as the door answers it (exchange 7.19). */
  snapshot: unknown;
  /** The person's ticks kept on the message, or null for none yet. */
  reviewed: boolean[] | null;
}

/** The shell's own bar moves the guide: a section (6.2), or back to the sections (6.1) with null. */
export interface SurfaceOpenSection {
  v: 1;
  type: "open_section";
  section: number | null;
}

/** The Annotate and Interact switch of 4.3. */
export interface SurfaceSetMode {
  v: 1;
  type: "set_mode";
  mode: "annotate" | "interact";
}

/** Parent or Child in 4.3: the pin moves to the element around it, or back in. */
export interface SurfaceStepPin {
  v: 1;
  type: "step_pin";
  direction: "parent" | "child";
}

/** At open and on every change. */
export interface SurfaceSetAppearance {
  v: 1;
  type: "set_appearance";
  theme: "light" | "dark";
  /** The Dynamic Type size as a multiple of the default (`UIFontMetrics`); 1 is the default. */
  text_scale: number;
}

/** The door saved it: the surface draws it as saved and drops the draft it came from. */
export interface SurfaceCommitAnnotation {
  v: 1;
  type: "commit_annotation";
  annotation: InboxAnnotationRecord;
}

/** Removed, or a draft cancelled (4.4 Cancel). */
export interface SurfaceRemoveAnnotation {
  v: 1;
  type: "remove_annotation";
  id: string;
}

/**
 * Send asks for the annotations as Plannotator's feedback text (the window's
 * `attachmentFeedback`): the reply's `feedback` field (exchange 7.11). The
 * text is built here because only Plannotator's parser can number the lines
 * the person read; nothing is drawn.
 */
export interface SurfaceExportFeedback {
  v: 1;
  type: "export_feedback";
  /** Echoed by the answer. */
  id: string;
  /** The annotations riding the Send. */
  annotations: InboxAnnotationRecord[];
  /** The thread's attachments (exchange 7.14). */
  attachments: InboxAttachmentState[];
  /** Each annotated file version's text, read through `view` just before the Send. */
  texts: { attachment_id: string; version: string; text: string }[];
  /** The thread's project root, so a path inside it reads relative. */
  project_root: string;
}

/**
 * Comment in the edit menu (4.1): the text selected in a markdown or text
 * file becomes a draft now, answered by `selection` (both fields null when
 * nothing is selected). On a touch screen the surface does not paint a
 * selection as it settles: that would replace the system selection and close
 * its edit menu before the person reached Comment.
 */
export interface SurfaceCommentSelection {
  v: 1;
  type: "comment_selection";
}

export type SurfaceShellMessage =
  | SurfaceCommentSelection
  | SurfaceExportFeedback
  | SurfaceOpenAttachment
  | SurfaceOpenGuide
  | SurfaceOpenSection
  | SurfaceSetMode
  | SurfaceStepPin
  | SurfaceSetAppearance
  | SurfaceCommitAnnotation
  | SurfaceRemoveAnnotation;

// ─────────────────────────────── Surface to shell ───────────────────────────────

/** The bundle loaded; the shell sends nothing before it. */
export interface SurfaceReady {
  v: 1;
  type: "ready";
  bridge: typeof INBOX_SURFACE_BRIDGE_VERSION;
  /** The Plannotator version the surface was built from. */
  build: string;
}

/** A text selection settled (`draft` set) or cleared (both null). Comment in the edit menu uses `draft` (4.1, 4.2). */
export interface SurfaceSelection {
  v: 1;
  type: "selection";
  quote: string | null;
  draft: SurfaceAnnotation | null;
}

/** An HTML pin landed, or Parent or Child moved it (4.3). */
export interface SurfacePin {
  v: 1;
  type: "pin";
  /** `label` is the element as the sheet names it (Plannotator's pinpoint label: "Button", a heading's words); `selector` finds it again. */
  target: { label: string; selector: string };
  draft: SurfaceAnnotation;
}

/** A tap on a block (pinpoint) or a diagram part: open the composer now (4.4). */
export interface SurfaceDraft {
  v: 1;
  type: "draft";
  target: { kind: "block" | "node" | "edge"; label: string };
  draft: SurfaceAnnotation;
}

/** A saved mark was tapped: the shell shows it with Edit and Remove (4.3). */
export interface SurfaceAnnotationTapped {
  v: 1;
  type: "annotation";
  id: string;
}

/** A section's Reviewed tick (6.2): every section's tick, for the door's save (exchange 7.20). */
export interface SurfaceReviewed {
  v: 1;
  type: "reviewed";
  message_id: string;
  reviewed: boolean[];
}

/** The guide moved: a section is on screen (6.2), or the sections (6.1) with null. The shell's title reads "02 of 04" from it. */
export interface SurfaceSection {
  v: 1;
  type: "section";
  message_id: string;
  section: number | null;
  sections: number;
}

/** A link in the content; the shell opens it in the system browser. */
export interface SurfaceLink {
  v: 1;
  type: "link";
  href: string;
}

/** The answer to `export_feedback`. */
export interface SurfaceFeedback {
  v: 1;
  type: "feedback";
  id: string;
  text: string;
}

/** The surface could not draw what it was given. */
export interface SurfaceError {
  v: 1;
  type: "error";
  code: SurfaceErrorCode;
  message: string;
}

/**
 * - `bridge_version`: the message's `v` is not this surface's.
 * - `bad_message`: not a message this surface knows, or missing what it needs.
 * - `guide_invalid`: the snapshot did not parse as a guided review.
 */
export type SurfaceErrorCode = "bridge_version" | "bad_message" | "guide_invalid";

export type SurfaceMessage =
  | SurfaceReady
  | SurfaceSelection
  | SurfacePin
  | SurfaceDraft
  | SurfaceAnnotationTapped
  | SurfaceReviewed
  | SurfaceSection
  | SurfaceLink
  | SurfaceFeedback
  | SurfaceError;

const SHELL_TYPES: ReadonlySet<string> = new Set<SurfaceShellMessage["type"]>([
  "comment_selection",
  "export_feedback",
  "open_attachment",
  "open_guide",
  "open_section",
  "set_mode",
  "step_pin",
  "set_appearance",
  "commit_annotation",
  "remove_annotation",
]);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Read a message from the shell. The shell is the app itself, so this checks
 * the envelope and what the surface needs to draw, not every field.
 */
export function readSurfaceShellMessage(value: unknown): { ok: true; message: SurfaceShellMessage } | { ok: false; code: SurfaceErrorCode; message: string } {
  if (!isObject(value) || typeof value.type !== "string") return { ok: false, code: "bad_message", message: "A bridge message is an object with a type." };
  if (value.v !== INBOX_SURFACE_BRIDGE_VERSION) {
    return { ok: false, code: "bridge_version", message: `This surface speaks bridge version ${INBOX_SURFACE_BRIDGE_VERSION}, not ${String(value.v)}.` };
  }
  if (!SHELL_TYPES.has(value.type)) return { ok: false, code: "bad_message", message: `Unknown message type "${value.type}".` };
  const bad = (what: string) => ({ ok: false as const, code: "bad_message" as const, message: `${value.type}: ${what}` });
  switch (value.type) {
    case "export_feedback":
      if (typeof value.id !== "string" || typeof value.project_root !== "string") return bad("id and project_root are strings.");
      if (!Array.isArray(value.annotations) || !Array.isArray(value.attachments) || !Array.isArray(value.texts)) return bad("annotations, attachments and texts are lists.");
      break;
    case "open_attachment":
      if (!isObject(value.attachment) || typeof value.attachment.kind !== "string") return bad("attachment is missing.");
      if (typeof value.text !== "string" || typeof value.version !== "string") return bad("text and version are strings.");
      if (value.attachment.kind === "html" && typeof value.html !== "string") return bad("an HTML attachment carries html.");
      if (!Array.isArray(value.annotations)) return bad("annotations is a list.");
      break;
    case "open_guide":
      if (typeof value.message_id !== "string" || !isObject(value.snapshot)) return bad("message_id and snapshot are required.");
      break;
    case "open_section":
      if (value.section !== null && !(Number.isInteger(value.section) && (value.section as number) >= 0)) return bad("section is an index or null.");
      break;
    case "set_mode":
      if (value.mode !== "annotate" && value.mode !== "interact") return bad('mode is "annotate" or "interact".');
      break;
    case "step_pin":
      if (value.direction !== "parent" && value.direction !== "child") return bad('direction is "parent" or "child".');
      break;
    case "set_appearance":
      if (value.theme !== "light" && value.theme !== "dark") return bad('theme is "light" or "dark".');
      if (typeof value.text_scale !== "number" || !(value.text_scale > 0)) return bad("text_scale is a positive number.");
      break;
    case "commit_annotation":
      if (!isObject(value.annotation) || typeof value.annotation.id !== "string" || !isObject(value.annotation.annotation)) return bad("annotation is the door's record.");
      break;
    case "remove_annotation":
      if (typeof value.id !== "string") return bad("id is a string.");
      break;
  }
  return { ok: true, message: value as unknown as SurfaceShellMessage };
}
