import {
  shapeNoteId,
  shapeParts,
  type ShapeBoard,
  type ShapeNote,
  type ShapeNoteInput,
  type ShapeRecord,
  type ShapeVersion,
} from '@plannotator/core/shape';
import type { ShapeEvent, ShapeHost, ShapeSessionStatus } from '@plannotator/ui/components/shape';
import { CALM_AS_BUILT, snoozeBoard, SOURCES, V2, V3, type SnoozeModel } from './fixture';

const SESSION = { host: 'claude-code', id: 'harness-session' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface HarnessOptions {
  stage: 'before' | 'after';
  since: boolean;
  session: ShapeSessionStatus['state'];
  notes: boolean;
}

export function createHarnessHost(opts: HarnessOptions): ShapeHost & { id: string } {
  const id = 'shp_01JHARNESS0000000000000000';
  let model: SnoozeModel = V3;
  const versions: ShapeVersion[] = [];
  const at = (n: number) => new Date(Date.UTC(2026, 10, 3, 5, 30 + n)).toISOString();
  const push = (board: ShapeBoard, through: string | null = null) => {
    const n = versions.length + 1;
    versions.push({ ...board, n, at: at(n), base: n > 1 ? n - 1 : null, through, by: SESSION, parts: shapeParts(board) });
  };
  push(snoozeBoard(V2, opts.stage));
  push(snoozeBoard(V2, opts.stage));
  push(snoozeBoard(V3, opts.stage));

  const record = (): ShapeRecord => ({
    v: 1,
    id,
    title: versions.at(-1)!.title,
    project: { name: 'plannotator', root: '/work/plannotator' },
    session: SESSION,
    thread: 'msg_harness',
    state: 'active',
    created: at(1),
    updated: versions.at(-1)!.at,
    latest: versions.length,
    drawing: null,
  });

  let session: ShapeSessionStatus = { state: opts.session, agent: 'Claude Code' };
  const notes: ShapeNote[] = [];
  const note = (input: Partial<ShapeNote> & Pick<ShapeNote, 'kind' | 'text'>): ShapeNote => ({
    id: shapeNoteId(),
    at: new Date().toISOString(),
    v: versions.length,
    view: null,
    part: null,
    quote: null,
    from: 'you',
    re: null,
    delivered: null,
    ...input,
  });
  if (opts.notes) {
    const q = note({ kind: 'ask', view: 'how', part: 'who-days', quote: 'at least 2 days since you started', text: 'Why 2 days and not 3?', delivered: at(3) });
    notes.push(q, note({ kind: 'answer', re: q.id, from: SESSION, text: '**2 days** is what you asked for (“Make it 2 days”, 22:05) and what merged: `SNOOZE_INTRO_TENURE_MS` in `inbox-snooze-intro.ts`, line 14.' }));
    if (opts.session === 'gone') notes.push(note({ kind: 'change', view: 'picture', part: 'p-hint', quote: 'Right-click a thread…', text: 'Say “the clock” before right-click.' }));
  }

  const listeners = new Set<(e: ShapeEvent) => void>();
  const emit = (e: ShapeEvent) => listeners.forEach((l) => l(e));

  const agent = (input: ShapeNoteInput): { answer: string; next: SnoozeModel | null } => {
    const t = input.text;
    const part = input.part ?? '';
    if (/who-days|r-2days/.test(part) || /\b(3|three)\s+days\b/i.test(t)) {
      return { answer: 'I’ve left this one as it is. **2 days** is what you asked for and what merged (`inbox-snooze-intro.ts`, line 14). The board shows what is built, so 3 days would be a new PR first.', next: null };
    }
    if (/how-calm|calm-more/.test(part) || /calm|guard|remain/i.test(t)) {
      return {
        answer: `The build names them (\`snoozeIntro.ts\`, lines 3–16). The page shows it only if all of these hold when you leave the thread:\n\n${CALM_AS_BUILT.map((l) => `- ${l}`).join('\n')}\n\nI’m putting them on the board in place of “the guards that remain”.`,
        next: { ...model, calmKnown: true, calmReq: true },
      };
    }
    if (/once|how-never|p-once/.test(part) || /reload|escape|counts?/i.test(t)) {
      return {
        answer: 'Yes. The page claims the dialog before it opens, and the claim stamps it, so **every way out is final**, even a reload. Updating the label.',
        next: { ...model, onceLabel: 'Shown once, ever. Any way out counts, even a reload', neverLabel: 'any way out, even a reload' },
      };
    }
    return {
      answer: '_Stand-in agent: the harness scripts three cases. Mark “+ the calm-moment guards that remain” in How it works and ask which ones, mark “Shown once, ever” and say a reload counts too, or mark “at least 2 days” and ask for 3._',
      next: null,
    };
  };

  const stream = async (text: string, onText: (t: string) => void) => {
    const words = text.split(/(?<=\s)/);
    let out = '';
    for (const w of words) {
      out += w;
      onText(out);
      await sleep(18);
    }
  };

  const redraw = async (next: SnoozeModel, through: string) => {
    emit({ type: 'drawing', until: new Date(Date.now() + 60_000).toISOString() });
    await sleep(900);
    model = next;
    push(snoozeBoard(model, opts.stage), through);
    emit({ type: 'version', shape: record(), version: versions.at(-1)! });
  };

  return {
    id,
    async load() {
      await sleep(60);
      return {
        shape: record(),
        version: versions.at(-1)!,
        seen: opts.since ? 2 : versions.length,
        notes: notes.slice(),
        session,
      };
    },
    async version(_id, n) {
      return versions[n - 1] ?? null;
    },
    async note(_id, input) {
      const n = note({ kind: input.kind, view: input.view ?? null, part: input.part ?? null, quote: input.quote ?? null, text: input.text, v: input.v });
      notes.push(n);
      if (session.state === 'gone') return n;
      void (async () => {
        await sleep(500);
        const delivered = { ...n, delivered: new Date().toISOString() };
        notes[notes.findIndex((x) => x.id === n.id)] = delivered;
        emit({ type: 'note', note: delivered });
        const reply = agent(input);
        if (reply.next) await redraw(reply.next, n.id);
        const answer = note({ kind: 'answer', re: n.id, from: SESSION, text: reply.answer });
        notes.push(answer);
        emit({ type: 'note', note: answer });
      })();
      return n;
    },
    async ask(_id, input, onText) {
      const q = note({ kind: 'ask', view: input.view ?? null, part: input.part ?? null, quote: input.quote ?? null, text: input.text, v: input.v, delivered: new Date().toISOString() });
      notes.push(q);
      const reply = agent(input);
      await sleep(350);
      await stream(reply.answer, onText);
      const answer = note({ kind: 'answer', re: q.id, from: SESSION, text: reply.answer });
      notes.push(answer);
      if (reply.next) void redraw(reply.next, q.id);
      return { question: q, answer };
    },
    seen() {},
    events(_id, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async refresh() {
      await sleep(1200);
      emit({ type: 'drawing', until: null });
    },
    assetUrl(_id, src) {
      return src.startsWith('files/') ? `/refs/${src.slice(6)}` : src;
    },
    async readFile(_id, path) {
      return SOURCES[path] ?? null;
    },
    resumePrompt() {
      return 'plannotator shape read shp_01JHARNESS0000000000000000';
    },
    async copy(text) {
      await navigator.clipboard?.writeText(text).catch(() => {});
    },
    setSession(state: ShapeSessionStatus['state']) {
      session = { ...session, state };
      emit({ type: 'session', session });
    },
  } as ShapeHost & { id: string };
}
