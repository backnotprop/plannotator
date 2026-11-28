/**
 * A terminal place an agent starts in: Settings → Agents' "Start new agents in" names one, and the launch engine
 * (inbox-launch.ts) starts a new agent in a tab of it instead of in the background, closes its pane on Stop and asks
 * whether that pane is gone before a reply starts it again. Rex (inbox-rex.ts, registered by inbox-rex-place.ts) is
 * the only one. The engine reaches a place only through `InboxTerminalPlace`, found by the kind its launch record names
 * (`inboxLaunchPlace`), never by asking which terminal it is.
 *
 * The stored record stays Rex's (`InboxLaunchRecord.rex`), and so do the wire fields and words: a place's words are
 * functions of its name (packages/core/inbox-run-line.ts), which for Rex give its words as they always were.
 */
import { INBOX_REX_NAME } from "@plannotator/core/inbox-run-line";
import { inboxLaunchInRex, type InboxLaunchRecord, type InboxLaunchRex } from "@plannotator/core/inbox-types";
import type { InboxPlace } from "@plannotator/shared/inbox/connection";

/** Which place (a pane's `InboxPlace.kind` is the same). */
export type InboxTerminalPlaceKind = InboxPlace["kind"];

/** Each place's name, as the person reads it in its words, known even when that place is not on this computer. */
const NAMES: Record<InboxTerminalPlaceKind, string> = { rex: INBOX_REX_NAME };
export const inboxTerminalPlaceName = (kind: InboxTerminalPlaceKind): string => NAMES[kind];

/** Why a place is not here to start in: its app is not open (`absent`), its server does not answer (`server`), it is another account's (`shared`). */
export type InboxTerminalAway = "absent" | "server" | "shared";

/** A start in a place: the agent's own interactive command, in a new tab named `tab` of the place's session for `projectKey`. */
export interface InboxTerminalOpenRequest {
  project: string;
  projectKey: string;
  tab: string;
  command: string;
  pathPrepend?: readonly string[];
}

/**
 * What a start in a place did. `opened`: `line` says where it is, `pane` the pane made for it (Stop closes it), when
 * known. Not opened: `sent`, it was asked and no answer came (it may run: nothing else starts); `refused`, it said no
 * and made nothing; `shared`, it is another account's and nothing was asked. Otherwise it is not here.
 */
export type InboxTerminalOpened = { opened: true; line: string; pane: InboxPlace | null } | { opened: false; sent: boolean; refused?: true; shared?: true };

/** What closing a pane came to: closed, already gone, the place said no, or no answer in time. */
export type InboxTerminalClosed = "closed" | "gone" | "refused" | "no_answer";

/** What a program in a pane says it is doing (only its state, and for `blocked` what it waits for). */
export interface InboxTerminalStatus {
  state: "idle" | "working" | "done" | "blocked" | "error";
  kind?: "permission" | "question" | "auth";
}

/** Where the window asking is: this computer's own (`here`) or another computer's (`away`). */
export type InboxTerminalReach = "here" | "away";

/** What the launch engine asks of a place. */
export interface InboxTerminalPlace {
  readonly kind: InboxTerminalPlaceKind;
  /** A server with no app of its own on this computer: not here means its server is not running (`server`). */
  readonly headless: boolean;
  /** Whether an agent can start in it now (Settings → Agents' read: one bounded read), and if not, why. */
  here(): Promise<{ here: true } | { here: false; why: InboxTerminalAway }>;
  /** Run `command` in a new tab, never moving the person's app to it (one start at a time per project). */
  open(request: InboxTerminalOpenRequest): Promise<InboxTerminalOpened>;
  /** The pane is gone (true), there (false), or no answer (null). */
  paneGone(pane: InboxPlace): Promise<boolean | null>;
  /** Stop: close the pane, which ends the program in it. */
  closePane(pane: InboxPlace): Promise<InboxTerminalClosed>;
}

/**
 * What the list and Show ask of a place (inbox.ts): where agents live and what their panes say, from the last read
 * and never waiting on it; Show takes the person's app to a pane. Rex's own `createInboxRex` is one as it is.
 */
export interface InboxTerminalPlaceReads {
  places(hints: ReadonlyMap<string, InboxPlace>): Map<string, string>;
  statuses(hints: ReadonlyMap<string, InboxPlace>): Map<string, InboxTerminalStatus>;
  freshStatuses(hints: ReadonlyMap<string, InboxPlace>): Map<string, InboxTerminalStatus>;
  watch(hints: ReadonlyMap<string, InboxPlace>): void;
  version(): number;
  offersShow(reach?: InboxTerminalReach): boolean;
  show(pane: InboxPlace, reach?: InboxTerminalReach): Promise<{ shown: boolean; refused?: true; by?: string[] }>;
  close(): void;
}

/** The places on this computer, by kind. */
export type InboxTerminalPlaces = { readonly [K in InboxTerminalPlaceKind]?: InboxTerminalPlace };

/** The place a launch asked for at Send, from its stored record (`launch.rex`), with its name; null: it starts in the background. */
export function inboxLaunchPlace(launch: Pick<InboxLaunchRecord, "rex">): { kind: InboxTerminalPlaceKind; name: string; record: InboxLaunchRex } | null {
  return launch.rex ? { kind: "rex", name: inboxTerminalPlaceName("rex"), record: launch.rex } : null;
}

/** The launch runs in its place (it asked for one, and the place made its tab): the place owns it. */
export const inboxLaunchInPlace = (launch: Pick<InboxLaunchRecord, "rex" | "session_ref">): boolean => inboxLaunchInRex(launch);

/** The pane its place made for it (renewed by each start again there), or null when not known. */
export function inboxLaunchPane(launch: Pick<InboxLaunchRecord, "rex">): InboxPlace | null {
  const place = inboxLaunchPlace(launch);
  return place?.record.session && place.record.block ? { kind: place.kind, session: place.record.session, block: place.record.block } : null;
}

/** What a launch's record says once its place made the tab: where, and the pane (for Stop). */
export const inboxLaunchPlaceRecord = (line: string, pane: InboxPlace | null): InboxLaunchRex => ({ line, ...(pane ? { session: pane.session, block: pane.block } : {}) });

/** The place a "Start new agents in" setting names, or null (the Inbox: the background). */
export const inboxStartInPlace = (startIn: string | undefined): InboxTerminalPlaceKind | null => (startIn === "rex" ? "rex" : null);

/** A new launch's record asking for `kind` (empty until the start). */
export const inboxLaunchAsking = (kind: InboxTerminalPlaceKind): Pick<InboxLaunchRecord, "rex"> => (kind === "rex" ? { rex: {} } : {});
