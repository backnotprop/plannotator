/**
 * The ShapeHost contract: everything the board needs from the app it sits in.
 *
 * `ShapeSurface` is host-neutral like the Inbox thread parts: it never makes
 * a request, reads the address bar, a cookie or storage. The Inbox and the
 * standalone Shapes page each pass an adapter over the same routes
 * (SPEC.md §3, "Host seam"); the dev harness passes an in-memory one.
 */
import type { ComponentType, ReactNode } from 'react';
import type { ShapeNote, ShapeNoteInput, ShapeRecord, ShapeVersion, ShapeViewId } from '@plannotator/core/shape';

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

  /** "Bring it up to date": a quiet request to the agent. Absent: no button. */
  refresh?(id: string): Promise<void>;
  /** The URL of a file the shape keeps (`files/…`). Absent: the src as written. */
  assetUrl?(id: string, src: string): string;
  /** A file's text, for a file reference and the Code view's whole-file viewer. */
  readFile?(id: string, path: string): Promise<string | null>;
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
}

/** The props a code hover card takes (code review's `TokenHoverCard` matches them). */
export interface ShapeCodeHoverCardProps {
  hover: { request: ShapeCodeHoverRequest; data: never; rect: DOMRect };
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  onSelectLocation?: (location: { filePath: string; line: number }) => void;
}

export type ShapePanelTab = 'ask' | 'thread' | 'refs';

export interface ShapeSurfaceProps {
  host: ShapeHost;
  id: string;
  /** The × at the title's right closes Shape (the Inbox: back to the thread). Absent: no close button. */
  onClose?: () => void;
  /** The Code view's Guided Review. Absent: the Code view lists the guide's steps without diffs. */
  CodeGuide?: ComponentType<ShapeCodeGuideProps>;
  /** The hover card for code tokens in the whole-file viewer. Absent: no hover insights. */
  CodeHoverCard?: ComponentType<ShapeCodeHoverCardProps>;
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
}
