/**
 * System in the Inbox (approval "system-inbox", items 1, 4 and 5): what the window reads about each project's drawing.
 * The drawing itself lives in `<data dir>/system/<project key>/drawing/` (owner ruling q-122e6577), read with
 * `@plannotator/system`. Browser-safe, no dependencies: the drawing's model rides the wire as plain data, typed by
 * the caller (`SystemModel` in `@plannotator/system`).
 */

export type SystemDrawingState = "none" | "drawing" | "drawn" | "broken";

/** One project as System's Settings rows and the Reviews System button list it. */
export interface SystemProjectRow {
  id: string;
  key: string;
  /** The name the sidebar shows (the person's rename, or the folder's name). */
  name: string;
  /** The project's own repo, `host/owner/name`, from its folder's `origin`; null when the folder is not on this Mac or has no remote. */
  repo: string | null;
  /** The drawing in the data folder: none yet, still being drawn, drawn, or one that does not read. */
  state: SystemDrawingState;
  /** Sheets drawn. */
  sheets: number;
  /** Sheets still to draw (the drawing phase). */
  wanted: number;
}

/** `GET /api/inbox/system/projects`: every project that can be set up here (folder on this Mac with a remote) or has a drawing. */
export interface SystemProjectsAnswer {
  projects: SystemProjectRow[];
}

/** `GET /api/inbox/system/drawing?project=<id>`: one project's drawing. `model` is null when there is none, or it does not read. */
export interface SystemDrawingAnswer<Model = unknown> {
  project: SystemProjectRow;
  model: Model | null;
}

/** One open PR of the project's repo whose changed files touch drawn parts. */
export interface SystemPullTouch<Change = unknown> {
  /** The PR's key in the pulls list (`InboxPull.key`). */
  key: string;
  /** The PR's number (`InboxPull.number`): the drawing tags its parts "PR <number>". */
  number: number;
  /** The drawn parts it changes, in the drawing's order. */
  parts: { id: string; name: string }[];
  /** What the drawing marks for it at rest: the `touched` of the package's gate result for its files (`GateResult` from @plannotator/system). */
  change: Change;
}

/** `GET /api/inbox/system/pulls?project=<id>`: the open PRs that change the drawing; `unread` PRs whose files could not be read. */
export interface SystemPullsAnswer<Change = unknown> {
  pulls: SystemPullTouch<Change>[];
  unread: number;
}

/** True for a row the Reviews System button lists: a drawing on disk, drawn or being drawn (or one that does not read). */
export function systemListed(row: Pick<SystemProjectRow, "state">): boolean {
  return row.state !== "none";
}
