/**
 * The ShapeHost contract: everything the board needs from the app it sits in.
 *
 * `ShapeSurface` is host-neutral like the Inbox thread parts: it never makes
 * a request, reads the address bar, a cookie or storage. The Inbox and the
 * standalone Shapes page each pass an adapter over the same routes
 * (SPEC.md §3, "Host seam"); the dev harness passes an in-memory one.
 */
import type { ShapeBoxSelection, ShapeReadAsset } from './boxSelect';
import type { ComponentType, ReactNode } from 'react';
import type { ShapeCodeTarget, ShapeNote, ShapeNoteInput, ShapeRecord, ShapeVersion, ShapeViewId } from '@plannotator/core/shape';

export type { ShapeBoard, ShapeNote, ShapeNoteInput, ShapeRecord, ShapeRef, ShapeVersion, ShapeViewId } from '@plannotator/core/shape';

/** The agent session that drew the shape, as the host knows it now. */
export interface ShapeSessionStatus {
  /** live: notes reach it now; busy: it is mid-turn (notes queue); gone: notes wait for any agent. */
  state: 'live' | 'busy' | 'gone';
  /** The agent's name ("Claude Code"). */
  agent: string;
}

/** One shape, opened. */
export interface ShapeLoaded {
  shape: ShapeRecord;
  version: ShapeVersion;
  /** The last version the person looked at (null: never opened). */
  seen: number | null;
  notes: ShapeNote[];
  session: ShapeSessionStatus;
}

export type ShapeEvent =
  /** The agent wrote a new version. */
  | { type: 'version'; shape: ShapeRecord; version: ShapeVersion }
  /** The agent says it is drawing (until a time), or stopped. */
  | { type: 'drawing'; until: string | null }
  /** A note was stored or changed (an answer, a delivery). */
  | { type: 'note'; note: ShapeNote }
  /** Finished, reopened. */
  | { type: 'state'; shape: ShapeRecord }
  | { type: 'session'; session: ShapeSessionStatus };

/** What the Annotate box was opened on, and the optional words. */
export interface ShapeShowMeInput {
  /** What the person calls it: the part's heading, the words they selected, or the file and lines. */
  name: string;
  /** Its `data-code` value, when it has one. */
  code?: string;
  words: string;
}

export interface ShapeHost {
  load(id: string): Promise<ShapeLoaded>;
  /** One older version ("what changed since you looked"). */
  version(id: string, n: number): Promise<ShapeVersion | null>;
  /** Store a Change it (or a general comment). It reaches the agent, or waits for one. */
  note(id: string, input: ShapeNoteInput): Promise<ShapeNote>;
  /** Ask: store the question and stream the answer (the session, else Ask AI). */
  ask(id: string, input: ShapeNoteInput, onText: (text: string) => void): Promise<{ question: ShapeNote; answer: ShapeNote | null }>;
  /** The person has seen version `n` (after its draw-in). */
  seen(id: string, n: number): void;
  /** Subscribe; returns the unsubscribe. */
  events(id: string, listener: (event: ShapeEvent) => void): () => void;

  /** Show me on a part, from the Annotate box: the agent draws a new board of it, and this one stays. Absent: no button. */
  showMe?(id: string, input: ShapeShowMeInput): void;
  /** "Bring it up to date": a quiet request to the agent. Absent: no button. */
  refresh?(id: string): Promise<void>;
  /** The refresh button's words, when a host has its own. Absent: "Bring it up to date". */
  refreshLabel?: string;
  /** The URL of a file the shape keeps (`files/…`). Absent: the src as written. */
  assetUrl?(id: string, src: string): string;
  /** A file's text, for a file reference and the Code view's whole-file viewer. */
  readFile?(id: string, path: string): Promise<string | null>;
  /** A control beside a file the board names (a reference, the file viewer, the guide's file cards): the host's "open in". Absent: none. */
  fileAction?(id: string, file: { path: string; line?: number }): ReactNode;
  /** Hover insight data for a code token (code review's `/api/code-nav/hover`), handed to `CodeHoverCard`. */
  codeHover?(id: string, request: ShapeCodeHoverRequest): Promise<unknown | null>;
  /** The prompt that resumes waiting changes in any session ("Copy prompt"). */
  resumePrompt?(id: string): string;
  /** Copy text (the host's clipboard). */
  copy?(text: string): Promise<void> | void;
  /**
   * Once the session ended, nothing answers an Ask here: the question waits for the agent (the Inbox, which has
   * no Ask AI fallback). Absent: a host whose Ask AI answers then, and the panel says so.
   */
  askWaitsWhenEnded?: boolean;
  /**
   * This host cannot tell whether the agent's session is live (the standalone Shape page: its server knows no
   * sessions, so every board reads `gone`). The Ask panel then shows no session line at all, rather than claim the
   * session ended. Absent: the line shows the session's state, as always.
   */
  sessionless?: boolean;
}

/** A board that takes a dragged box (`boxSelect` on ShapeSurface). */
export interface ShapeBoxOptions {
  /** A same-site image or font as a data: URL, for the box's picture. Absent: the picture has no images and the system's font. */
  readAsset?: ShapeReadAsset;
  /** The box's Show me: the same object a comment is made from, and whatever was typed. Absent: no Show me. */
  onShowMe?: (selection: ShapeBoxSelection, text: string) => void;
  /**
   * The box's Add to reply: the same object and whatever was typed, for the host's reply to the board's thread (the
   * Inbox: the picture as a file, the label and words as text). Absent: no Add to reply.
   */
  onAddToReply?: (selection: ShapeBoxSelection, text: string) => void;
}

export interface ShapeCodeHoverRequest {
  symbol: string;
  filePath: string;
  line: number;
  charStart: number;
  side: 'new';
}

/** The props the Code view's guide component takes (`@plannotator/guide-viewer/ShapeCodeGuide` matches them). */
export interface ShapeCodeGuideProps {
  code: NonNullable<ShapeVersion['views']['code']>;
  renderDiff: (file: { path: string; patch: string }) => ReactNode;
  openLine?: (path: string) => number | null;
  onOpenFile?: (path: string, line: number) => void;
  headerActions?: ReactNode;
  /** The host's control beside a file (`ShapeHost.fileAction`). */
  fileAction?: (path: string) => ReactNode;
}

/** The props a code hover card takes (code review's `TokenHoverCard` matches them). */
export interface ShapeCodeHoverCardProps {
  hover: { request: ShapeCodeHoverRequest; data: never; rect: DOMRect };
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onSelectLocation?: (location: { filePath: string; line: number }) => void;
}

export type ShapePanelTab = 'ask' | 'thread' | 'refs';

/** A place in a review's guided review: a file and line, a guide step (from 1), every file, or (empty) its start. */
export interface ShapeReviewAt {
  path?: string;
  line?: number;
  step?: number;
  files?: boolean;
}

/**
 * The review a board is part of (the host found it: the Inbox, a review's thread). What's changed shows its facts,
 * Guided review, Full review and its guide-step links, and with no Code view the board's `file:line` links open it.
 */
export interface ShapeSurfaceReview {
  /** What names it on the facts line (a pull request's "#2661"). */
  label?: string;
  files?: number;
  additions?: number;
  deletions?: number;
  /**
   * How many guide steps the review has. A change's "Guide step N" past it is not drawn. Absent: every step link
   * shows, and one the review answers false to opens the review at its start.
   */
  steps?: number;
  /**
   * Open the review's guided review there. False (or a promise of false) when it cannot show that place, such as a
   * file the review does not change: the board opens the file in its own viewer instead.
   */
  open(at: ShapeReviewAt): boolean | Promise<boolean>;
}

export interface ShapeSurfaceProps {
  host: ShapeHost;
  id: string;
  /** The × at the title's right closes Shape (the Inbox: back to the thread). Absent: no close button. */
  onClose?: () => void;
  /** The Code view's Guided Review. Absent: the Code view lists the guide's steps without diffs. */
  CodeGuide?: ComponentType<ShapeCodeGuideProps>;
  /** The hover card for code tokens in the whole-file viewer. Absent: no hover insights. */
  CodeHoverCard?: ComponentType<ShapeCodeHoverCardProps>;
  /**
   * A drawn part with `data-code` was clicked: a host that shows this code itself (code review's diff) takes it and
   * returns true. False: the Code view, else the board's own viewer opens it (never `review`). Absent: as any code
   * link (the Code view, `review`, the viewer).
   */
  onCode?: (target: ShapeCodeTarget, el: HTMLElement, version?: ShapeVersion | null) => boolean;
  /** The Thread tab's body (an Inbox shape). Absent: no Thread tab. Mark each message `data-shape-message="<id>"`. */
  renderThread?: (options: { flash: string | null }) => ReactNode;
  /**
   * Plannotator's board: annotation starts off behind an Annotate button, a number pops out a bubble with its
   * picture and line (a file's lines through `host.readFile`, and a PR or link with a picture opens the picture),
   * and a narrow canvas scrolls sideways. Absent: a part can be marked at once, a number lights and opens, a
   * narrow canvas shrinks to fit.
   */
  readFirst?: boolean;
  /** Where to start. */
  initialView?: ShapeViewId;
  initialPanel?: ShapePanelTab | null;
  /** The view or the panel changed (a host keeps its URL in step). */
  onNavigate?: (state: { view: ShapeViewId; panel: ShapePanelTab | null }) => void;
  /** Before the title, on its line (the Inbox: its sidebar toggle). Absent: the title comes first. */
  headStart?: ReactNode;
  /** In the group at the title's right, first (the Inbox's list of a thread's boards). */
  headSide?: ReactNode;
  /**
   * False: no Code view in the dock, even on a board that has one (Plannotator's board: a review's guided review is
   * its own place). A part's `file:line` then opens the review there (`review`), else the file viewer. Absent: true.
   */
  codeView?: boolean;
  /** The review this board is part of. Absent: What's changed shows no review facts, buttons or guide-step links. */
  review?: ShapeSurfaceReview | null;
  /**
   * While annotating with the pointer, a mouse drag draws a box and comments on what is inside it (the Inbox, by
   * ShapeBoard). Absent: pointing and clicking only, as always.
   */
  boxSelect?: ShapeBoxOptions;
  /**
   * On a dark board only (Plannotator, by ShapeBoard): box borders and zone edges at 3:1 against what they sit on, a
   * box's fill distinct from its zone, words kept at least as readable as they were (up to 7:1), and each picture the
   * board keeps (`files/…`) on a light tile so a dark logo holds. A light board is drawn exactly as without it. Absent:
   * the board is drawn as written in both themes, as before. See `darkContrast.ts`.
   */
  darkContrast?: boolean;
}
