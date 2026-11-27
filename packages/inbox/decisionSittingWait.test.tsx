/**
 * Decision mode on a thread watched after the last decisions read. The window holds only the watched threads'
 * decisions (`keepWatched`), so a thread just opened shows its "Decide these N" from the read's counts before its
 * own decisions are held. Pressed in that moment, the sitting waits for its thread's read, then: (a) shows the cards
 * with the thread's name; (b) ends, when the thread has nothing left (answered on another device); (c) when every
 * try fails, says so with Try again. What regresses if this fails: the sitting has no name, or the person is left on
 * "Reading what waits on you…" with no way on.
 *
 * App's own wiring (useDecideSitting, readKeptDecisions, DecisionMode) over a stubbed decisions read; no Inbox.
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, useCallback, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import type { InboxDecision } from '@plannotator/core/inbox-types';
import type { SettingsModel } from './api';
import type { DecideSitting } from './app/useDecideSitting';
import { newDecisionWatch } from './decisions/model';

const hasDom = typeof document !== 'undefined';
const { useDecideSitting } = (hasDom ? await import('./app/useDecideSitting') : {}) as typeof import('./app/useDecideSitting');
const { DecisionMode } = (hasDom ? await import('./decisions/DecisionMode') : {}) as typeof import('./decisions/DecisionMode');
const { readKeptDecisions } = (hasDom ? await import('./decisions/keptRead') : {}) as typeof import('./decisions/keptRead');
const { createInboxQueryClient } = (hasDom ? await import('./data/client') : {}) as typeof import('./data/client');

const T = 'msg_thread_t';
const SUBJECT = 'Ship the ledger export';

function decision(key: string, thread = T): InboxDecision {
  const messageId = `msg_${thread}_m`;
  return {
    id: `${messageId}/${key}`,
    question: {
      key,
      position: 0,
      kind: 'single',
      prompt: `Prompt ${key}?`,
      context: null,
      choices: [
        { label: 'Yes', description: null, recommended: false, settled: false },
        { label: 'No', description: null, recommended: false, settled: false },
      ],
      recommendation: null,
      suggested_text: null,
      stopped: null,
      holds_up: [],
      asked_by_agent_id: null,
      orphaned: false,
      state: 'open',
      answer: null,
      revision: 0,
      sent_revision: 0,
      picked_by: null,
      picked_at: null,
      sent_reply_id: null,
      message_id: messageId,
      superseded_by: null,
    },
    message: { id: messageId, created_at: '2026-11-27T10:00:00.000Z', author: { kind: 'agent', host: 'claude-code', session: 'ses_a', name: null }, excerpt: null },
    pictures: { inline: [], attachments: [] },
    thread: { id: thread, subject: thread === T ? SUBJECT : 'Another thread', thread_name: null, project: { id: 'prj_1', name: 'ledger-api' }, section: 'waiting' },
    session: { key: 's:claude-code\u0000ses_a', host: 'claude-code', session: 'ses_a', name: null, wakes: false },
  };
}

const ALL = [decision('q-1'), decision('q-2'), decision('q-9', 'msg_other')];
const settings = { decision_mode: { on: true } } as unknown as SettingsModel;
type Answer = () => Promise<{ decisions: InboxDecision[] }>;

let root: Root | null = null;
let host: HTMLElement | null = null;
let realFetch: typeof fetch;
let answer: Answer;
let reads = 0;

beforeEach(() => {
  realFetch = globalThis.fetch;
  // The cards' own thread reads never answer: these cases are about the decisions read only.
  globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch;
  answer = () => Promise.resolve({ decisions: ALL });
  reads = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  client = null;
  globalThis.fetch = realFetch;
});

function Harness({ paneOpen }: { paneOpen: boolean }) {
  const [decisions, setDecisions] = useState<InboxDecision[] | null>(null);
  const [decide, setDecide] = useState<DecideSitting | null>(null);
  const decideOpener = useRef<HTMLElement | null>(null);
  const decisionWatch = useRef(newDecisionWatch());
  const refreshDecisions = useCallback(
    () =>
      readKeptDecisions(
        () => {
          reads += 1;
          return answer();
        },
        decisionWatch.current,
        setDecisions,
      ),
    [],
  );
  const { decideInThread, sittingDecisions, sittingRead, closeDecide } = useDecideSitting({
    settings,
    decisions,
    setDecisions,
    decide,
    setDecide,
    decideOpener,
    decisionWatch,
    refreshDecisions,
    refreshList: async () => null,
    route: { page: 'inbox', thread: paneOpen ? T : null, file: null, ref: null },
  });
  const entry = paneOpen ? decideInThread(T) : null;
  return (
    <>
      {entry && (
        <button type="button" data-decide-entry="" onClick={entry.onDecide}>
          Decide these {entry.count}
        </button>
      )}
      {decide && (
        <DecisionMode
          open={!decide.tucked}
          decisions={sittingDecisions}
          readFailed={sittingRead.failed}
          onReadAgain={sittingRead.retry}
          scope={decide.title}
          rows={new Map()}
          phone={false}
          refresh={() => void refreshDecisions()}
          subscribeQuestions={() => () => {}}
          onTuck={() => {}}
          onClose={closeDecide}
        />
      )}
    </>
  );
}

let client: QueryClient | null = null;
function Window({ paneOpen }: { paneOpen: boolean }) {
  client ??= createInboxQueryClient();
  return (
    <QueryClientProvider client={client}>
      <Harness paneOpen={paneOpen} />
    </QueryClientProvider>
  );
}

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const flush = () => act(async () => await new Promise((done) => setTimeout(done, 0)));

async function until(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await act(async () => await new Promise((done) => setTimeout(done, 25)));
  }
  return check();
}

/** The window read its decisions with the pane closed; the thread opens and its own read is held; Decide is pressed. */
async function openBeforeTheThreadsRead(): Promise<{ land: (value: { decisions: InboxDecision[] } | Error) => void }> {
  host = document.createElement('div');
  host.className = 'pn-inbox';
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host!);
    root.render(<Window paneOpen={false} />);
  });
  await flush();
  let release!: (value: { decisions: InboxDecision[] } | Error) => void;
  const held = new Promise<{ decisions: InboxDecision[] }>((resolve, reject) => {
    release = (value) => (value instanceof Error ? reject(value) : resolve(value));
  });
  answer = () => held;
  act(() => root!.render(<Window paneOpen />));
  await flush();
  // The count is there at once, from the last read's counts.
  expect(q('[data-decide-entry]')?.textContent).toBe('Decide these 2');
  act(() => q('[data-decide-entry]')!.click());
  await flush();
  expect(q('.ib-dm-loading')?.textContent).toBe('Reading what waits on you…');
  return { land: release };
}

test.skipIf(!hasDom)("(a) the thread's read lands: the cards show, with the thread's name in the head", async () => {
  const { land } = await openBeforeTheThreadsRead();
  await act(async () => land({ decisions: ALL }));
  expect(await until(() => q('[data-decision-head]')?.textContent !== 'Reading what waits on you…', 2_000)).toBe(true);
  expect(q('[data-decision-scope]')?.textContent).toBe(SUBJECT);
});

test.skipIf(!hasDom)('(b) the read finds nothing left in the thread: the sitting ends, it does not hang on loading', async () => {
  const { land } = await openBeforeTheThreadsRead();
  // Answered on another device meanwhile: the read keeps the same (empty) list, which by itself draws nothing.
  await act(async () => land({ decisions: [decision('q-9', 'msg_other')] }));
  expect(await until(() => q('[data-decision-end]') !== null, 2_000)).toBe(true);
  expect(q('.ib-dm-loading')).toBeNull();
});

test.skipIf(!hasDom)('(c) every read fails: it goes again, then says it could not read, and Try again reads anew', async () => {
  const { land } = await openBeforeTheThreadsRead();
  const before = reads;
  answer = () => Promise.reject(new Error('the Inbox did not answer'));
  await act(async () => land(new Error('the Inbox did not answer')));
  // Tries 2 and 3 come 1.5 s and 3 s later; only then is the person told.
  expect(q('[data-decision-read-failed]')).toBeNull();
  expect(await until(() => q('[data-decision-read-failed]') !== null, 6_000)).toBe(true);
  expect(reads - before).toBeGreaterThanOrEqual(2);
  expect(q('[data-decision-read-failed]')?.textContent).toContain("Couldn't read the question.");
  answer = () => Promise.resolve({ decisions: ALL });
  act(() => q('[data-decision-read-failed] button')!.click());
  expect(await until(() => q('[data-decision-scope]')?.textContent === SUBJECT, 2_000)).toBe(true);
  expect(q('[data-decision-read-failed]')).toBeNull();
}, 15_000);
