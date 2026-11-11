/**
 * The list feed (stage 3, PR 5; the wire is `packages/core/inbox-list-feed.ts`): every list row as a reader of the
 * window's list sees it (the store's row plus its pin, launch, checklist, snooze as of now and PRs), kept per thread,
 * with its place, in list order, versioned. A change re-works only the rows it can have moved, and each reader that
 * asked (`/events?list=1`) gets a `list` frame with the rows that really changed.
 *
 * Which rows a change can move (spike X2 and the server's decorations):
 * - the store's row: the threads its row cache dropped (`drainListRowChanges`: a line, a draft, a comment, a live
 *   session's answer), and every thread a store line names (a PR or checklist line is not in the store's row);
 * - pins, snoozes and checklists that wait: the threads whose entry came, went or changed;
 * - launches: every launched thread, on a live-session or launch move and on a full list read;
 * - the clock: a snooze that ran out (a timer wakes the feed at the soonest one while a reader listens); a session's
 *   grace and a checklist's wait move with the live sessions, which the delivery watch reports;
 * - linked machines (the merged view): each machine row its list read replaced.
 * A row is compared by the hash of its JSON, worked out only for the rows above, so a frame carries only real changes.
 *
 * Two views: this Inbox's own rows, and the merged view (`machines=1`: every linked machine's rows too), made the
 * first time a reader asks for it. The same rows go to every reader of a view; a guest over the tailnet gets the
 * Agents without labels (as the list route strips them). Versions are `<run>.<n>`, one count over both views; each
 * view keeps a bounded log of the threads each version changed, for `since` catch-ups.
 *
 * Today's whole list read (`listModel`) is put together from here too: the rows in their places need no sort, and
 * the `since` delta takes each row's hash instead of its JSON. Its answer is byte for byte what it was.
 */

import {
  inboxListCounts,
  inboxPageRows,
  inboxPlaceCompare,
  inboxRowPlace,
  type InboxListCatchUp,
  type InboxListCounts,
  type InboxListFrame,
  type InboxListPage,
  type InboxPlacedRow,
  type InboxRowChange,
  type InboxRowPlace,
} from "@plannotator/core/inbox-list-feed";
import { inboxRowAsOf, inboxSnoozeDelay, type InboxSnooze } from "@plannotator/core/inbox-snooze";
import { inboxThreadPullsSummary, type InboxAgentsGroup, type InboxLine, type InboxListRow, type InboxPin, type InboxThreadPull } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { randomBytes } from "node:crypto";

export type InboxListView = "own" | "merged";

/** The most versions a view's catch-up log keeps, and the most thread ids in it: past either, an older `since` reads a first page. */
const LOG_VERSIONS = 4096;
const LOG_IDS = 50_000;
/** Past this share of a view's rows changed at once, its order is sorted again rather than moved row by row. */
const RESORT_SHARE = 0.25;

interface Entry extends InboxPlacedRow {
  /** The hash of the row's JSON, worked out when first needed. */
  hash?: number | bigint;
}

export interface InboxListFeedDeps {
  store: InboxStore;
  now?: () => Date;
  /** The threads whose checklist waits on the person now (null: the Checklist switch is off). */
  stepsWaiting: (now: Date) => ReadonlySet<string> | null;
  /** The launch decoration for this sync (the identity when launch is off). */
  launchDecorator: () => (row: InboxListRow) => InboxListRow;
  /** Linked machines (the merged view); absent: this Inbox links none. */
  machines?: () => { selfId: string; rows: () => readonly InboxListRow[] } | null;
  /** The sidebar's Agents of a view, from its own rows in the store's order, with labels (the owner's). */
  agents: (view: InboxListView, own: readonly InboxListRow[], now: Date) => InboxAgentsGroup[];
  /** The Agents as a reader who is not this computer's owner reads them. */
  agentsWithoutLabels: (agents: InboxAgentsGroup[]) => InboxAgentsGroup[];
  /** The sidebar's folders of a view (today's `projects`), from its own rows. */
  folders: (view: InboxListView, own: readonly InboxListRow[]) => Record<string, unknown>[];
  /** The rest of today's list model (`update`, `notice`, `restart_*`, `session_labels`, `self`, `machines`…) for this reader. */
  head: (view: InboxListView, owner: boolean) => Record<string, unknown>;
  serverSession: string;
  cursor: () => number;
  /** A row hash (Bun's, as the list delta uses). */
  hash?: (text: string) => number | bigint;
}

interface Reader {
  owner: boolean;
  send: (frame: InboxListFrame) => void;
}

interface ViewState {
  rows: Map<string, Entry>;
  /** Every entry in list order (`inboxPlaceCompare`), archived ones in their place too, and the entry each thread has there. */
  order: Entry[];
  inOrder: Map<string, Entry>;
  /** Threads whose entry changed since the order was last brought up to date. */
  moved: Set<string>;
  version: number;
  /** Versions after this one are in the log. */
  from: number;
  log: { n: number; ids: string[] }[];
  logIds: number;
  readers: Set<Reader>;
  /** What the last version said, to send only what moved. */
  pins: string;
  agents: string;
  folders: string;
}

export function createInboxListFeed(deps: InboxListFeedDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const hash = deps.hash ?? ((text: string) => Bun.hash(text));
  const run = randomBytes(6).toString("hex");
  let n = 0;
  const views = new Map<InboxListView, ViewState>();
  /** Own rows as the merged view carries them (with this machine's id), one object per own row. */
  const mergedOwn = new WeakMap<InboxListRow, InboxListRow>();
  const hashes = new WeakMap<InboxListRow, number | bigint>();

  // What changed since the last sync, from outside the store's own row cache.
  const named = new Set<string>();
  let namedAll = false;
  const onLine = (line: InboxLine) => {
    switch (line.kind) {
      case "message":
        named.add(line.record.thread_id);
        break;
      case "question": {
        const threadId = store.message(line.record.message_id)?.thread_id;
        if (threadId) named.add(threadId);
        else namedAll = true;
        break;
      }
      case "annotation":
      case "steps":
      case "thread_pull":
        named.add(line.record.thread_id);
        break;
      case "project":
        namedAll = true;
        break;
      default:
        break;
    }
  };
  const stopLines = store.subscribe(onLine);

  // The decoration inputs as the last sync saw them.
  let lastPins = new Map<string, string>();
  let lastSnoozes = new Map<string, InboxSnooze>();
  let lastSteps: ReadonlySet<string> = new Set();
  let lastMachineRows = new Map<string, InboxListRow>();
  let started = false;

  const versionOf = (at: number) => `${run}.${at}`;
  const hashOf = (entry: Entry): number | bigint => (entry.hash ??= hashes.get(entry.row) ?? remember(entry.row));
  const remember = (row: InboxListRow) => {
    const h = hash(JSON.stringify(row));
    hashes.set(row, h);
    return h;
  };

  const viewOf = (view: InboxListView): ViewState => {
    let state = views.get(view);
    if (!state) {
      state = { rows: new Map(), order: [], inOrder: new Map(), moved: new Set(), version: n, from: n, log: [], logIds: 0, readers: new Set(), pins: "", agents: "", folders: "" };
      views.set(view, state);
      // A new view starts whole: every row is put in at the next sync, under one version nobody can catch up from.
      namedAll = true;
    }
    return state;
  };

  /** Today's decoration of the store's own rows, for one sync (`listModel`'s order: pin, launch, checklist, snooze, PRs). */
  const decoration = (at: Date) => {
    const pins = new Map(store.pins().map((pin: InboxPin) => [pin.thread_id, pin.pinned_at]));
    const snoozes = new Map(store.snoozes().map((snooze) => [snooze.thread_id, snooze]));
    const steps = deps.stepsWaiting(at) ?? new Set<string>();
    const launch = deps.launchDecorator();
    const pulls = new Map<string, InboxThreadPull[]>();
    for (const pull of store.allThreadPulls()) {
      const list = pulls.get(pull.thread_id);
      if (list) list.push(pull);
      else pulls.set(pull.thread_id, [pull]);
    }
    const decorate = (row: InboxListRow): InboxListRow => {
      const pinned = pins.get(row.thread_id);
      let out = launch(pinned !== undefined ? { ...row, pinned_at: pinned } : row);
      if (steps.has(row.thread_id)) out = { ...out, steps_waiting: true };
      const snooze = snoozes.get(row.thread_id);
      if (snooze) out = inboxRowAsOf({ ...out, snoozed: { until: snooze.until, at: snooze.at } }, at);
      const list = pulls.get(row.thread_id);
      const summary = list ? inboxThreadPullsSummary(list.sort((a, b) => a.added_at.localeCompare(b.added_at) || a.id.localeCompare(b.id))) : undefined;
      return summary ? { ...out, pulls: summary } : out;
    };
    return { pins, snoozes, steps, decorate };
  };

  /** Put a view's changed rows in (null: gone); the threads whose row really changed. */
  const apply = (state: ViewState, changes: Map<string, InboxListRow | null>, at: Date): string[] => {
    const changed: string[] = [];
    for (const [id, row] of changes) {
      const held = state.rows.get(id);
      if (!row) {
        if (held) {
          state.rows.delete(id);
          state.moved.add(id);
          changed.push(id);
        }
        continue;
      }
      if (held && held.row === row) continue;
      const entry: Entry = { row, place: inboxRowPlace(row, at) };
      if (held && hashOf(held) === hashOf(entry) && samePlace(held.place, entry.place)) continue;
      state.rows.set(id, entry);
      state.moved.add(id);
      changed.push(id);
    }
    return changed;
  };

  const samePlace = (a: InboxRowPlace, b: InboxRowPlace) => a.group === b.group && a.at === b.at && a.archived === b.archived;

  /** The view's rows in list order, brought up to date. */
  const ordered = (state: ViewState): Entry[] => {
    if (state.moved.size === 0) return state.order;
    const insertAt = (order: Entry[], entry: Entry) => {
      let lo = 0;
      let hi = order.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (inboxPlaceCompare(order[mid]!, entry) < 0) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    if (state.moved.size > state.order.length * RESORT_SHARE) {
      state.order = [...state.rows.values()].sort(inboxPlaceCompare);
      state.inOrder = new Map(state.order.map((entry) => [entry.row.thread_id, entry]));
    } else {
      const order = state.order;
      for (const id of state.moved) {
        const before = state.inOrder.get(id);
        if (before) {
          const at = insertAt(order, before);
          if (order[at] === before) order.splice(at, 1);
          else order.splice(order.indexOf(before), 1);
          state.inOrder.delete(id);
        }
        const entry = state.rows.get(id);
        if (!entry) continue;
        order.splice(insertAt(order, entry), 0, entry);
        state.inOrder.set(id, entry);
      }
    }
    state.moved.clear();
    return state.order;
  };

  /**
   * This Inbox's own rows (decorated, without a machine id) in the store's order, as `listModel` built them: the
   * Agents and the folders are worked out from these in either view. The store's order as kept, with no live-session
   * call asked again (a sync has just taken every change).
   */
  const ownInStoreOrder = (): InboxListRow[] => {
    const own = views.get("own")!;
    const out: InboxListRow[] = [];
    for (const row of store.listRowsAsKept()) {
      const entry = own.rows.get(row.thread_id);
      if (entry) out.push(entry.row);
    }
    return out;
  };

  /** The counts of a view, its folders in the order the sidebar has them (a folder's `machine` on the merged view). */
  const countsOf = (state: ViewState, view: InboxListView, own: readonly InboxListRow[], folders = deps.folders(view, own)): InboxListCounts =>
    inboxListCounts(
      state.rows.values(),
      folders.map((folder) => ({ id: String(folder.id), ...(typeof folder.machine === "string" ? { machine: folder.machine } : {}) })),
    );

  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Wake at the soonest snooze still running in any view, while a reader listens. */
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (![...views.values()].some((state) => state.readers.size > 0)) return;
    const untils = [...lastSnoozes.values()].map((snooze) => snooze.until);
    for (const row of lastMachineRows.values()) if (row.snoozed) untils.push(row.snoozed.until);
    const at = now();
    const delay = inboxSnoozeDelay(untils, at);
    if (delay === null) return;
    timer = setTimeout(() => {
      timer = null;
      sync({ launched: false, recheck: false });
    }, delay + 5);
    (timer as { unref?: () => void }).unref?.();
  };

  /**
   * Bring every view up to date and publish what changed. `recheck`: ask the live sessions again (a list read, a
   * delivery move); `launched`: work out every launched row again (its run line moves without a store line).
   */
  let lastAt = now();
  const sync = (options: { recheck: boolean; launched: boolean }): void => {
    const at = now();
    lastAt = at;
    const drained = store.drainListRowChanges(options.recheck);
    const all = !started || drained.all || namedAll;
    started = true;
    namedAll = false;
    const own = viewOf("own");
    const { pins, snoozes, steps, decorate } = decoration(at);
    const ids = new Set<string>();
    if (all) {
      for (const row of store.listRows()) ids.add(row.thread_id);
      for (const id of own.rows.keys()) ids.add(id);
    } else {
      for (const id of drained.threads) ids.add(id);
      for (const id of named) ids.add(id);
      for (const map of [pins, lastPins]) for (const id of map.keys()) if (pins.get(id) !== lastPins.get(id)) ids.add(id);
      // Every snoozed thread: an entry that came, went, changed or ran out (by the clock) is among them.
      for (const id of snoozes.keys()) ids.add(id);
      for (const id of lastSnoozes.keys()) ids.add(id);
      for (const id of steps) if (!lastSteps.has(id)) ids.add(id);
      for (const id of lastSteps) if (!steps.has(id)) ids.add(id);
      if (options.launched) for (const root of store.launchedRoots()) ids.add(root.id);
    }
    named.clear();
    lastPins = new Map([...pins].map(([id, pinned]) => [id, pinned]));
    lastSnoozes = snoozes;
    lastSteps = steps;
    const ownChanges = new Map<string, InboxListRow | null>();
    for (const id of ids) {
      const row = store.listRow(id);
      ownChanges.set(id, row && row.thread_id === id ? decorate(row) : null);
    }
    const changed = new Map<InboxListView, string[]>([["own", apply(own, ownChanges, at)]]);
    const merged = views.get("merged");
    if (merged) {
      const mergedChanges = new Map<string, InboxListRow | null>();
      const linked = deps.machines?.() ?? null;
      const selfId = linked?.selfId;
      for (const id of all ? ids : changed.get("own")!) {
        const entry = own.rows.get(id);
        mergedChanges.set(id, entry ? withMachine(entry.row, selfId) : null);
      }
      const machineRows = new Map<string, InboxListRow>();
      // One row per thread: the first machine's (two machines claiming one id is not a list a reader can hold).
      for (const row of linked?.rows() ?? []) if (!own.rows.has(row.thread_id) && !store.message(row.thread_id) && !machineRows.has(row.thread_id)) machineRows.set(row.thread_id, row);
      for (const [id, row] of machineRows) {
        // A linked machine's row: when its list read replaced it, or it is snoozed (our clock may give it back).
        if (all || lastMachineRows.get(id) !== row || row.snoozed) mergedChanges.set(id, inboxRowAsOf(withoutStepsWaiting(row), at));
      }
      for (const id of lastMachineRows.keys()) if (!machineRows.has(id) && !own.rows.has(id)) mergedChanges.set(id, null);
      lastMachineRows = machineRows;
      changed.set("merged", apply(merged, mergedChanges, at));
    }
    for (const [view, ids2] of changed) publish(view, ids2, at, options.launched || options.recheck);
    arm();
  };

  const withMachine = (row: InboxListRow, selfId: string | undefined): InboxListRow => {
    if (selfId === undefined) return row;
    let out = mergedOwn.get(row);
    if (!out) mergedOwn.set(row, (out = { ...row, machine: selfId }));
    return out;
  };
  const withoutStepsWaiting = (row: InboxListRow): InboxListRow => {
    if (!("steps_waiting" in row)) return row;
    const { steps_waiting: _dropped, ...rest } = row;
    return rest;
  };

  /** A new version for a view when something a reader holds moved: its log, and a frame to each reader. */
  const publish = (view: InboxListView, ids: string[], at: Date, sessions: boolean) => {
    const state = views.get(view)!;
    const pinsNow = store.pins().map((pin) => pin.thread_id).filter((id) => state.rows.has(id));
    const pinsText = pinsNow.join(",");
    const readers = state.readers.size > 0;
    // The Agents and folders are worked out only for a reader, and only when rows or the live sessions moved.
    let own: InboxListRow[] | null = null;
    let agents: InboxAgentsGroup[] | null = null;
    let agentsText = state.agents;
    let folders: Record<string, unknown>[] | null = null;
    let foldersText = state.folders;
    if (readers && (ids.length > 0 || sessions)) {
      own = ownInStoreOrder();
      agents = deps.agents(view, own, at);
      agentsText = JSON.stringify(agents);
      folders = deps.folders(view, own);
      foldersText = JSON.stringify(folders.map(folderMeta));
    }
    const pinsMoved = pinsText !== state.pins;
    const agentsMoved = agentsText !== state.agents;
    const foldersMoved = foldersText !== state.folders;
    if (ids.length === 0 && !pinsMoved && !agentsMoved && !foldersMoved) return;
    const after = state.version;
    state.version = ++n;
    state.pins = pinsText;
    state.agents = agentsText;
    state.folders = foldersText;
    state.log.push({ n: state.version, ids });
    state.logIds += ids.length;
    while (state.log.length > LOG_VERSIONS || state.logIds > LOG_IDS) {
      const dropped = state.log.shift()!;
      state.logIds -= dropped.ids.length;
      state.from = dropped.n;
    }
    if (!readers) return;
    own ??= ownInStoreOrder();
    const frame: InboxListFrame = {
      v: 1,
      version: versionOf(state.version),
      after: versionOf(after),
      cursor: deps.cursor(),
      changes: ids.map((id) => changeOf(state, id)),
      counts: countsOf(state, view, own, folders ?? undefined),
      ...(pinsMoved ? { pins: pinsNow } : {}),
      ...(foldersMoved && folders ? { projects: folders } : {}),
    };
    const ownerFrame = agentsMoved && agents ? { ...frame, agents } : frame;
    const guestFrame = agentsMoved && agents ? { ...frame, agents: deps.agentsWithoutLabels(agents) } : frame;
    for (const reader of state.readers) reader.send(reader.owner ? ownerFrame : guestFrame);
  };

  /** A folder without its numbers (`counts.projects` carries those). */
  const folderMeta = (folder: Record<string, unknown>) => {
    const { threads: _t, unread: _u, listed: _l, archived: _a, ...meta } = folder;
    return meta;
  };

  const changeOf = (state: ViewState, id: string): InboxRowChange => {
    const entry = state.rows.get(id);
    return { thread_id: id, row: entry?.row ?? null, place: entry?.place ?? null, seq: null };
  };

  /** Up to date for a read: the live sessions asked again and the launched rows worked out, as a full list read does. */
  const ready = (view: InboxListView): ViewState => {
    viewOf(view);
    sync({ recheck: true, launched: true });
    return views.get(view)!;
  };

  /** A reader's first page (or a page after a cursor, or through a row). */
  const page = (view: InboxListView, owner: boolean, query: { after?: string | null; through?: string | null; limit?: number }): InboxListPage => {
    const state = ready(view);
    const pins = store.pins().map((pin) => pin.thread_id).filter((id) => state.rows.has(id));
    const { rows, next } = inboxPageRows(ordered(state), { ...query, pins, sorted: true });
    const own = ownInStoreOrder();
    const folders = deps.folders(view, own);
    const agents = deps.agents(view, own, lastAt);
    return {
      serverSession: deps.serverSession,
      cursor: deps.cursor(),
      version: versionOf(state.version),
      head: deps.head(view, owner),
      projects: folders,
      counts: countsOf(state, view, own, folders),
      pins,
      agents: owner ? agents : deps.agentsWithoutLabels(agents),
      rows: rows.map(({ row, place }) => ({ row, place })),
      next,
    };
  };

  /** What changed after `since`, each changed row as it is now; a first page when the log no longer reaches back that far. */
  const catchUp = (view: InboxListView, owner: boolean, since: string): InboxListCatchUp | InboxListPage => {
    const state = ready(view);
    const match = /^([0-9a-f]+)\.(\d+)$/.exec(since);
    const at = match && match[1] === run ? Number(match[2]) : null;
    if (at === null || at < state.from || at > state.version) return page(view, owner, {});
    const ids = new Set<string>();
    for (const entry of state.log) if (entry.n > at) for (const id of entry.ids) ids.add(id);
    const own = ownInStoreOrder();
    const folders = deps.folders(view, own);
    const agents = deps.agents(view, own, lastAt);
    return {
      serverSession: deps.serverSession,
      cursor: deps.cursor(),
      version: versionOf(state.version),
      since,
      head: deps.head(view, owner),
      projects: folders,
      counts: countsOf(state, view, own, folders),
      pins: store.pins().map((pin) => pin.thread_id).filter((id) => state.rows.has(id)),
      agents: owner ? agents : deps.agentsWithoutLabels(agents),
      changes: [...ids].map((id) => changeOf(state, id)),
    };
  };

  /** A reader that asked for frames (`/events?list=1`). Returns its leave. */
  const listen = (view: InboxListView, reader: Reader): (() => void) => {
    const state = viewOf(view);
    if (!started) sync({ recheck: true, launched: true });
    state.readers.add(reader);
    arm();
    return () => {
      state.readers.delete(reader);
      arm();
    };
  };

  /** Something outside the store moved rows (a draft, a pin, a snooze, the live sessions, a launch, a machine's list): publish once this task ends. */
  let scheduled: { recheck: boolean; launched: boolean } | null = null;
  const changedLater = (options: { recheck?: boolean; launched?: boolean } = {}) => {
    if (![...views.values()].some((state) => state.readers.size > 0)) return;
    if (scheduled) {
      scheduled.recheck ||= !!options.recheck;
      scheduled.launched ||= !!options.launched;
      return;
    }
    scheduled = { recheck: !!options.recheck, launched: !!options.launched };
    queueMicrotask(() => {
      const run2 = scheduled!;
      scheduled = null;
      sync(run2);
    });
  };
  // A store line: published right after the record frames it caused (those go out as the line lands). A draft, a pin
  // or a snooze writes no line: each is published the same way, whichever route or tool made it.
  const stopPublishOnLine = store.subscribe(() => changedLater());
  const stopPins = store.onPinsChange(() => changedLater());
  const stopSnoozes = store.onSnoozesChange(() => changedLater());
  const stopDrafts = store.onReplyDraftChange(() => changedLater());

  return {
    run,
    /** Is anybody listening (the delivery watch runs for them). */
    listening: () => [...views.values()].some((state) => state.readers.size > 0),
    changedLater,
    listen,
    page,
    catchUp,
    /**
     * The rows of today's whole list read, brought up to date: the view's rows in list order (the place order),
     * this Inbox's own rows in the store's order (as `listModel` built them), and each row's hash for the delta.
     */
    read: (view: InboxListView) => {
      const state = ready(view);
      return { ordered: ordered(state), own: ownInStoreOrder(), byId: state.rows, now: lastAt };
    },
    /** A row's hash (Bun's hash of its JSON), remembered for the row object: the list delta reads it instead of the JSON. */
    hashOf: (row: InboxListRow) => hashes.get(row) ?? remember(row),
    /**
     * Tests: every row of a view decorated again from the store now, with nothing kept (the feed's rows must equal
     * these after any change). Asks the live sessions and launches as a list read does.
     */
    reference: (view: InboxListView): Map<string, InboxPlacedRow> => {
      const at = now();
      const { decorate } = decoration(at);
      const out = new Map<string, InboxPlacedRow>();
      const linked = deps.machines?.() ?? null;
      for (const stored of store.listRows()) {
        const row = decorate(stored);
        const shown = view === "merged" && linked ? { ...row, machine: linked.selfId } : row;
        out.set(row.thread_id, { row: shown, place: inboxRowPlace(shown, at) });
      }
      if (view === "merged") {
        for (const row of linked?.rows() ?? []) {
          if (out.has(row.thread_id) || store.message(row.thread_id)) continue;
          const shown = inboxRowAsOf(withoutStepsWaiting(row), at);
          out.set(row.thread_id, { row: shown, place: inboxRowPlace(shown, at) });
        }
      }
      return out;
    },
    /** Tests: the view's version and log reach. */
    debug: (view: InboxListView) => {
      const state = viewOf(view);
      return { version: versionOf(state.version), from: versionOf(state.from), rows: state.rows.size, readers: state.readers.size };
    },
    stop: () => {
      stopLines();
      stopPublishOnLine();
      stopPins();
      stopSnoozes();
      stopDrafts();
      if (timer) clearTimeout(timer);
    },
  };
}

export type InboxListFeed = ReturnType<typeof createInboxListFeed>;
/** The rows of a whole list read as `read()` gives them. */
export type InboxListFeedRead = ReturnType<InboxListFeed["read"]>;
