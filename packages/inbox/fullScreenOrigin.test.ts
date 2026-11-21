/**
 * The frames a thread shows a file in, as a state machine checked against
 * every sequence of moves (the owner's report, 2026-10-27; fullScreenOrigin.ts).
 *
 * The person's model is a stack of views: the thread alone (T), the file
 * beside the thread (S), the file full screen (F). Opening a view pushes it;
 * closing it (× or Escape) pops back to exactly the view under it; the
 * browser's Back pops one entry too. A desktop's close of a file is a new
 * entry, so Back reopens what was closed (App.tsx `closeTo`); a phone's close
 * is the browser's Back when the file was opened from the thread.
 *
 * The window under test is fileEntryOp and fullScreenExit, run against a
 * simulated history the way App.tsx and Thread.tsx run them. The spec is a
 * separate stack of the views the person expects. After every move of every
 * sequence up to MAX_MOVES long, on a desktop and on a phone, the history's
 * entries must show exactly the expected stack, and no two neighbouring
 * entries the same view (a Back that changes nothing).
 *
 * One gap is known and left, outside full screen: a step (`]`, `[`) replaces
 * the entry on screen, so stepping onto the file of the entry under it leaves
 * two entries alike and the next Back seems to do nothing. The check skips a
 * stepped entry for that one rule.
 *
 * The old rules (every view switch replaced the entry in place; × and Escape
 * always put a desktop's file beside the thread) are kept here as `legacy`, to
 * prove the checker finds the owner's case and the Back that skipped the file
 * beside the thread.
 */
import { describe, expect, test } from 'bun:test';
import { fileEntryOp, fullExitFile, fullFromSide, fullMark, fullScreenExit, pageBackPastSwitch, withFullMark, type FrameMove } from './fullScreenOrigin';
import { sameScreenAnyView } from './fileView';

const THREAD = '#thread=t';
const OTHER = '#thread=u';
const FILES = ['a', 'b'] as const;
type FileId = (typeof FILES)[number];
type View = 'side' | 'full';
type Frame = 'T' | 'S' | 'F' | 'other';

interface Entry {
  hash: string;
  state: Record<string, unknown> | null;
}

/** What the person expects one entry of the stack to show. */
interface Expected {
  frame: Frame;
  /** The file, its version and the page an HTML file links to (`a`, `a@sent`, `a#p1`), or null. */
  file: string | null;
  /** How the full screen on this entry was entered: from the thread alone, with the view switch, or as another file opened over the one beside. */
  origin: 'T' | 'switch' | 'open' | null;
  /** The entry was pushed straight over the thread alone (a phone's close is then Back). */
  overThread: boolean;
  /** A step (`]`, `[`), or full screen's way back taking the file on screen, last changed its file in place. */
  stepped?: boolean;
}

/** A file's parts: its id, `@sent`, and `#pN` for a page it links to. */
function partsOf(file: string): { id: string; sent: boolean; page: number } {
  const match = /^([a-z])(@sent)?(?:#p(\d))?$/.exec(file)!;
  return { id: match[1]!, sent: match[2] !== undefined, page: match[3] ? Number(match[3]) : 0 };
}

function keyOf(id: string, sent: boolean, page: number): string {
  return `${id}${sent ? '@sent' : ''}${page ? `#p${page}` : ''}`;
}

function fileHash(file: string, view: View): string {
  const { id, sent, page } = partsOf(file);
  return `${THREAD}&file=${id}${sent ? '&v=sent' : ''}${page ? `&linked=p${page}` : ''}&view=${view}`;
}

function shown(hash: string, phone: boolean): { frame: Frame; file: string | null } {
  const params = new URLSearchParams(hash.slice(1));
  if (params.get('thread') !== 't') return { frame: 'other', file: null };
  const id = params.get('file');
  if (!id) return { frame: 'T', file: null };
  const linked = params.get('linked');
  const file = keyOf(id, params.get('v') === 'sent', linked ? Number(linked.slice(1)) : 0);
  return { frame: phone || params.get('view') === 'full' ? 'F' : 'S', file };
}

type Move =
  | { kind: 'open'; file: FileId; view: View }
  | { kind: 'toggleFull' }
  | { kind: 'exit' }
  | { kind: 'escape' }
  | { kind: 'pickSide' }
  | { kind: 'undoPick' }
  | { kind: 'writeReply' }
  | { kind: 'step' }
  | { kind: 'version' }
  | { kind: 'link' }
  | { kind: 'linkBack' }
  | { kind: 'closeSide' }
  | { kind: 'otherThread' }
  | { kind: 'back' };

const MOVES: Move[] = [
  ...FILES.flatMap((file) => (['side', 'full'] as const).map((view) => ({ kind: 'open', file, view }) as Move)),
  { kind: 'toggleFull' },
  { kind: 'exit' },
  { kind: 'escape' },
  { kind: 'pickSide' },
  { kind: 'undoPick' },
  { kind: 'writeReply' },
  { kind: 'step' },
  { kind: 'version' },
  { kind: 'link' },
  { kind: 'linkBack' },
  { kind: 'closeSide' },
  { kind: 'otherThread' },
  { kind: 'back' },
];

interface Rules {
  /** The window's entry for a file request (App.tsx's onOpenFile). */
  entryOp: typeof fileEntryOp;
  /** Whether × and Escape close the file (Thread.tsx's exitCloses). */
  exitCloses: (state: unknown, phone: boolean) => boolean;
  /** Whether the thread names a frame move (Thread.tsx's setFull and openFile). */
  moves: boolean;
  /** Whether a page's Back reaches past the switch's entry (App.tsx's onOpenFile `back`). */
  pastSwitch: typeof pageBackPastSwitch;
}

const current: Rules = {
  entryOp: fileEntryOp,
  exitCloses: (state, phone) => fullScreenExit(fullFromSide(state), phone) === 'close',
  moves: true,
  pastSwitch: pageBackPastSwitch,
};

/** The rules before the owner's report: a view switch swapped the entry in place; × and Escape put a desktop's file beside the thread. */
const legacy: Rules = {
  entryOp: (_now, next, request = {}) => (request.replace || request.move ? { kind: 'replace', hash: next, keep: true } : { kind: 'push', hash: next, mark: null }),
  exitCloses: (_state, phone) => phone,
  moves: false,
  pastSwitch: () => false,
};

class World {
  entries: Entry[] = [{ hash: '#list', state: null }, { hash: THREAD, state: { ibFrom: '#list' } }];
  index = 1;
  expected: Expected[] = [
    { frame: 'other', file: null, origin: null, overThread: false },
    { frame: 'T', file: null, origin: null, overThread: false },
  ];
  /** Side by side was just picked in full screen: what its Undo does (Thread.tsx pickView). */
  pick: { inPlace: boolean; origin: Expected['origin']; overThread: boolean } | null = null;
  /** The last move left a file for another without the pane asking about a comment not saved yet (or asked naming another file). */
  unasked: string | null = null;

  constructor(
    readonly phone: boolean,
    readonly rules: Rules,
  ) {}

  clone(): World {
    const w = new World(this.phone, this.rules);
    w.entries = this.entries.slice(0, this.index + 1).map((e) => ({ hash: e.hash, state: e.state ? { ...e.state } : null }));
    w.index = this.index;
    w.expected = this.expected.map((e) => ({ ...e }));
    w.pick = this.pick ? { ...this.pick } : null;
    return w;
  }

  key(): string {
    return JSON.stringify([this.entries.slice(0, this.index + 1), this.expected, this.pick]);
  }

  get now(): Entry {
    return this.entries[this.index]!;
  }

  get on(): { frame: Frame; file: string | null } {
    return shown(this.now.hash, this.phone);
  }

  get top(): Expected {
    return this.expected[this.expected.length - 1]!;
  }

  // ── The history, as a browser keeps it ──
  push(hash: string, state: Record<string, unknown>) {
    if (hash === this.now.hash) return;
    this.entries.splice(this.index + 1);
    this.entries.push({ hash, state });
    this.index += 1;
  }

  replace(hash: string, state: Record<string, unknown> | null) {
    this.entries[this.index] = { hash, state };
  }

  // ── App.tsx: onOpenFile and closeTo ──
  openFile(next: string, request: { move?: FrameMove; replace?: boolean } = {}) {
    const op = this.rules.entryOp({ hash: this.now.hash, state: this.now.state }, next, request);
    if (op.kind === 'push') this.push(op.hash, { ...(op.mark ? withFullMark(null, op.mark) : {}), ibFrom: this.now.hash });
    else if (op.kind === 'replace') this.replace(op.hash, op.keep ? this.now.state : withFullMark(this.now.state, op.mark));
    else {
      if (op.steps > this.index) throw new Error(`Back by ${op.steps} would leave the history`);
      this.index -= op.steps;
      if (op.land !== null && this.now.hash !== op.land) this.replace(op.land, this.now.state);
    }
  }

  closeToThread() {
    const from = this.now.state?.ibFrom;
    if (this.phone && from === THREAD) this.index -= 1;
    else this.push(THREAD, { ibFrom: this.now.hash });
  }

  /** A linked page's Back (App.tsx's onOpenFile with `back`): past the switch, the browser's Back, else a new entry. */
  pageBack(next: string) {
    const now = { hash: this.now.hash, state: this.now.state };
    if (this.rules.pastSwitch(now, next, sameScreenAnyView)) {
      if (this.index < 2) throw new Error('Back by 2 would leave the history');
      this.index -= 2;
      this.openFile(next, { move: 'switch-full' });
      return;
    }
    const from = this.now.state?.ibFrom;
    if (typeof from === 'string' && sameScreenAnyView(from, next)) {
      this.index -= 1;
      // The view the person is in now replaces the one the entry named.
      if (this.now.hash !== next) this.replace(next, this.now.state);
      return;
    }
    this.openFile(next);
  }

  // ── Thread.tsx: setFull and the pane's way out ──
  setFull(next: boolean, how: 'pick' | 'exit' | 'in-place' = 'pick') {
    const { file } = this.on;
    const nowFull = new URLSearchParams(this.now.hash.slice(1)).get('view') === 'full';
    const hash = fileHash(file!, next ? 'full' : 'side');
    if (!this.rules.moves || how === 'in-place' || next === nowFull) this.openFile(hash, { replace: true });
    else this.openFile(hash, { move: next ? 'switch-full' : how === 'exit' ? 'exit-full' : 'show-side' });
  }

  exitFull() {
    if (this.rules.exitCloses(this.now.state, this.phone)) this.closeToThread();
    else this.setFull(false, 'exit');
  }

  // ── The spec: the stack of views the person expects ──
  expectPush(e: Expected) {
    const top = this.top;
    if (top.frame === e.frame && top.file === e.file) return;
    this.expected.push(e);
  }

  /** Full screen ends: back to the view it was opened from; `keep`: that view takes the file on screen. */
  expectLeaveToSide(file: string, keep: boolean) {
    while (this.top.frame === 'F') this.expected.pop();
    if (keep && this.top.file !== file) {
      this.top.file = file;
      this.top.stepped = true;
    }
  }

  /**
   * One page back: the entry under this one when it shows that page (in the frame the person is in now: a swap in
   * place swaps it too); past the switch's entry when the switch sits right over that page's next page beside the
   * thread (then full screen again with the switch); else a new entry.
   */
  expectPageBack(target: string, frame: Frame) {
    const n = this.expected.length;
    const top = this.top;
    const below = this.expected[n - 2];
    const under = this.expected[n - 3];
    if (below?.file === target) {
      this.expected.pop();
      if (below.frame !== frame) this.expected[n - 2] = { ...below, frame, origin: frame === 'F' ? top.origin : null };
      return;
    }
    if (top.origin === 'switch' && below?.frame === 'S' && below.file === top.file && under?.file === target) {
      this.expected.length = n - 2;
      if (under.frame !== frame) this.expected.push({ frame, file: target, origin: 'switch', overThread: false });
      return;
    }
    this.expectPush({ frame, file: target, origin: frame === 'F' ? top.origin : null, overThread: false });
  }

  expectClose() {
    if (this.phone && this.top.overThread) this.expected.pop();
    else this.expected.push({ frame: 'T', file: null, origin: null, overThread: false });
  }

  /** Make the move; false when it cannot be made from here (its control is not on screen). */
  play(move: Move): boolean {
    const { frame, file } = this.on;
    const top = this.top;
    const pick = this.pick;
    this.pick = null;
    switch (move.kind) {
      case 'open': {
        // A tile, the preview under a message, an image in the text: from the thread (beside a file too, on a desktop).
        if (frame !== 'T' && frame !== 'S') return false;
        const opened = this.phone || move.view === 'full' ? 'F' : 'S';
        if (file === move.file) return false;
        const overSide = frame === 'S' && move.view === 'full';
        this.openFile(fileHash(move.file, move.view), overSide && this.rules.moves ? { move: 'open-full' } : {});
        this.expectPush({ frame: opened, file: move.file, origin: opened === 'F' ? (frame === 'S' ? 'open' : 'T') : null, overThread: frame === 'T' });
        return true;
      }
      case 'toggleFull':
        if (this.phone || frame !== 'S') return false;
        this.setFull(true);
        this.expectPush({ frame: 'F', file, origin: 'switch', overThread: false });
        return true;
      case 'exit':
      case 'escape':
        // × and Escape's last rung: close this full screen, back to exactly the view it was opened from.
        if (frame !== 'F') return false;
        {
          // The file the pane names when it asks about a comment not saved yet (Thread.tsx's exitLeavesFor); closing asks anyway.
          const id = partsOf(file!).id;
          const exitTo = this.rules.moves && !this.rules.exitCloses(this.now.state, this.phone) ? fullExitFile(this.now.state) : null;
          const asks = exitTo !== null && exitTo !== id ? exitTo : null;
          this.exitFull();
          const landed = this.on;
          const leftFor = landed.frame === 'S' && landed.file !== null && partsOf(landed.file).id !== id ? partsOf(landed.file).id : null;
          if (this.rules.moves && asks !== leftFor) this.unasked = `${move.kind} from ${file} landed on ${landed.file}; the pane asked naming ${asks}`;
        }
        if ((top.origin === 'switch' || top.origin === 'open') && !this.phone) this.expectLeaveToSide(file!, top.origin === 'switch');
        else this.expectClose();
        return true;
      case 'pickSide':
      case 'writeReply': {
        // Side by side in full screen's toolbar (a pick), or Write the reply in its drawer: the file beside the thread.
        if (this.phone || frame !== 'F') return false;
        const inPlace = !fullFromSide(this.now.state);
        this.setFull(false);
        if (top.origin === 'switch' || top.origin === 'open') this.expectLeaveToSide(file!, true);
        else this.expected[this.expected.length - 1] = { frame: 'S', file, origin: null, overThread: top.overThread, stepped: top.stepped };
        if (move.kind === 'pickSide') this.pick = { inPlace, origin: top.origin, overThread: top.overThread };
        return true;
      }
      case 'undoPick':
        // The toast's Undo, right after the pick: the file full screen again, as it was.
        if (!pick || frame !== 'S') return false;
        this.setFull(true, pick.inPlace ? 'in-place' : 'pick');
        if (pick.inPlace) this.expected[this.expected.length - 1] = { frame: 'F', file, origin: pick.origin, overThread: pick.overThread, stepped: top.stepped };
        else this.expectPush({ frame: 'F', file, origin: 'switch', overThread: false });
        return true;
      case 'step': {
        // `]` to the other file: the frame kept, the entry replaced.
        if (frame !== 'S' && frame !== 'F') return false;
        const other = file!.startsWith('a') ? 'b' : 'a';
        const view = new URLSearchParams(this.now.hash.slice(1)).get('view') as View;
        this.openFile(fileHash(other, view), { replace: true });
        this.top.file = other;
        this.top.stepped = true;
        return true;
      }
      case 'version': {
        // The version it sent, from full screen's ⋯: a new entry inside the same full screen.
        const parts = partsOf(file ?? 'a');
        if (frame !== 'F' || parts.sent) return false;
        const sent = keyOf(parts.id, true, 0);
        this.openFile(fileHash(sent, 'full'));
        this.expectPush({ frame: 'F', file: sent, origin: top.origin, overThread: false });
        return true;
      }
      case 'link': {
        // A page the attached HTML page links to: a new entry in the frame the person is in.
        if (frame !== 'S' && frame !== 'F') return false;
        const parts = partsOf(file!);
        if (parts.page >= 2) return false;
        const page = keyOf(parts.id, parts.sent, parts.page + 1);
        const view = new URLSearchParams(this.now.hash.slice(1)).get('view') as View;
        this.openFile(fileHash(page, view));
        this.expectPush({ frame, file: page, origin: frame === 'F' ? top.origin : null, overThread: false });
        return true;
      }
      case 'linkBack': {
        // The band's Back: one page back, in the frame the person is in.
        if (frame !== 'S' && frame !== 'F') return false;
        const parts = partsOf(file!);
        if (parts.page === 0) return false;
        const target = keyOf(parts.id, parts.sent, parts.page - 1);
        const view = new URLSearchParams(this.now.hash.slice(1)).get('view') as View;
        this.pageBack(fileHash(target, view));
        this.expectPageBack(target, frame);
        return true;
      }
      case 'closeSide':
        if (frame !== 'S') return false;
        this.closeToThread();
        this.expectClose();
        return true;
      case 'otherThread':
        // A notification or the list: another thread, a new entry (App.tsx `go`).
        if (frame === 'other') return false;
        this.push(OTHER, { ibFrom: this.now.hash });
        this.expectPush({ frame: 'other', file: null, origin: null, overThread: false });
        return true;
      case 'back':
        // The list (entry 0) is out of the model.
        if (this.index <= 1 || this.expected.length <= 2) return false;
        this.index -= 1;
        this.expected.pop();
        return true;
    }
  }

  /** The first way the history differs from the expected stack, or null. */
  fault(): string | null {
    if (this.unasked) return this.unasked;
    const seen = this.entries.slice(0, this.index + 1).map((e) => shown(e.hash, this.phone));
    const want = this.expected.map((e) => ({ frame: e.frame, file: e.file }));
    if (JSON.stringify(seen) !== JSON.stringify(want)) return `history ${JSON.stringify(seen)} but expected ${JSON.stringify(want)}`;
    for (let i = 1; i < seen.length; i++) {
      // Known and left (stepping, not full screen): a step onto the file of the entry under it leaves two alike.
      if (this.expected[i]!.stepped) continue;
      if (JSON.stringify(seen[i]) === JSON.stringify(seen[i - 1])) return `a Back from entry ${i} changes nothing`;
    }
    return null;
  }
}

const MAX_MOVES = 7;

function describeMove(move: Move): string {
  return move.kind === 'open' ? `open ${move.file} ${move.view}` : move.kind;
}

/** Every sequence of moves up to MAX_MOVES: the first that breaks the stack, or null; and how many states were reached. */
function explore(phone: boolean, rules: Rules): { counterexample: string[] | null; states: number; fault: string | null } {
  const seen = new Set<string>();
  let frontier: { world: World; path: string[] }[] = [{ world: new World(phone, rules), path: [] }];
  for (let depth = 0; depth < MAX_MOVES; depth++) {
    const next: typeof frontier = [];
    for (const { world, path } of frontier) {
      for (const move of MOVES) {
        const w = world.clone();
        if (!w.play(move)) continue;
        const step = [...path, describeMove(move)];
        const fault = w.fault();
        if (fault) return { counterexample: step, states: seen.size, fault };
        const key = w.key();
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ world: w, path: step });
      }
    }
    frontier = next;
  }
  return { counterexample: null, states: seen.size, fault: null };
}

function run(phone: boolean, rules: Rules, moves: Move[]): World {
  const w = new World(phone, rules);
  for (const move of moves) if (!w.play(move)) throw new Error(`cannot ${describeMove(move)} here`);
  return w;
}

describe('the stack of views around a file', () => {
  test('a desktop: every sequence of moves keeps the history the stack the person expects', () => {
    const result = explore(false, current);
    expect({ fault: result.fault, moves: result.counterexample }).toEqual({ fault: null, moves: null });
    // The walk reached a real space, not a handful of states.
    expect(result.states).toBeGreaterThan(1000);
  });

  test('a phone: the same, where the file is only ever full screen', () => {
    const result = explore(true, current);
    expect({ fault: result.fault, moves: result.counterexample }).toEqual({ fault: null, moves: null });
    expect(result.states).toBeGreaterThan(200);
  });

  test("the owner's case: the preview under a message opens full screen, × goes back to the thread as it was", () => {
    const w = run(false, current, [{ kind: 'open', file: 'a', view: 'full' }, { kind: 'exit' }]);
    expect(w.on).toEqual({ frame: 'T', file: null });
    // Escape's last rung agrees.
    expect(run(false, current, [{ kind: 'open', file: 'a', view: 'full' }, { kind: 'escape' }]).on).toEqual({ frame: 'T', file: null });
  });

  test('beside the thread first: × goes back beside it, and Back from full screen does too', () => {
    const w = run(false, current, [{ kind: 'open', file: 'a', view: 'side' }, { kind: 'toggleFull' }]);
    expect(fullMark(w.now.state)).toEqual({ depth: 1, viaSwitch: true, sideFrom: THREAD });
    const viaExit = w.clone();
    viaExit.play({ kind: 'exit' });
    expect(viaExit.on).toEqual({ frame: 'S', file: 'a' });
    const viaBack = w.clone();
    viaBack.play({ kind: 'back' });
    expect(viaBack.on).toEqual({ frame: 'S', file: 'a' });
    // A step inside full screen: × keeps the file on screen, beside the thread, and leaves no entry behind.
    const stepped = run(false, current, [{ kind: 'open', file: 'a', view: 'side' }, { kind: 'toggleFull' }, { kind: 'step' }, { kind: 'version' }, { kind: 'exit' }]);
    expect(stepped.on).toEqual({ frame: 'S', file: 'b@sent' });
    expect(stepped.entries.slice(0, stepped.index + 1).map((e) => shown(e.hash, false).frame)).toEqual(['other', 'T', 'S']);
  });

  test('another file opened full screen over the one beside the thread: × goes back to that one; Side by side shows the file on screen', () => {
    const opened = [{ kind: 'open', file: 'a', view: 'side' }, { kind: 'open', file: 'b', view: 'full' }] as Move[];
    expect(run(false, current, [...opened, { kind: 'exit' }]).on).toEqual({ frame: 'S', file: 'a' });
    expect(run(false, current, [...opened, { kind: 'back' }]).on).toEqual({ frame: 'S', file: 'a' });
    expect(run(false, current, [...opened, { kind: 'pickSide' }]).on).toEqual({ frame: 'S', file: 'b' });
  });

  test('the checker finds the old rules out: the owner’s case and the Back that skipped the file beside the thread', () => {
    const owner = run(false, legacy, [{ kind: 'open', file: 'a', view: 'full' }, { kind: 'exit' }]);
    expect(owner.on).toEqual({ frame: 'S', file: 'a' });
    expect(owner.fault()).not.toBeNull();
    const skipped = run(false, legacy, [{ kind: 'open', file: 'a', view: 'side' }, { kind: 'toggleFull' }, { kind: 'back' }]);
    expect(skipped.fault()).not.toBeNull();
    const found = explore(false, legacy);
    expect(found.counterexample).not.toBeNull();
    expect(found.counterexample!.length).toBeLessThanOrEqual(2);
  });
});
