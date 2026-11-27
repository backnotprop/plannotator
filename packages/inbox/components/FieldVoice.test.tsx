/**
 * The Other fields under one Send (a thread, decision mode): useOtherFieldVoice in FieldVoice.tsx.
 *
 * What regresses: Send going out while one Other field is still being transcribed (its words lost), Send staying off
 * after every take has ended, two takes at once read as one (the first to end turning Send back on while the second
 * runs), and a pane kept off the page (parked) still offering a mic in its Other fields.
 *
 * DOM-gated: runs under DOM_TESTS=1 (happy-dom), from tests/dom-test-list.txt.
 */
import { afterEach, expect, test } from 'bun:test';
import { act, useContext } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QuestionOtherToolsContext } from '@plannotator/ui/components/QuestionOtherTools';
import { QuestionVoiceBusy, useOtherFieldVoice, type OtherFieldVoice } from './FieldVoice';

const hasDom = typeof document !== 'undefined';
let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

let seen: { voice: OtherFieldVoice; report: ((id: string, busy: boolean) => void) | null; tools: unknown } | null = null;

function Field() {
  const report = useContext(QuestionVoiceBusy);
  const tools = useContext(QuestionOtherToolsContext);
  seen = { ...seen!, report, tools };
  return null;
}

function Host({ off }: { off: boolean }) {
  const voice = useOtherFieldVoice(off);
  seen = { voice, report: null, tools: null };
  return <>{voice.wrap(<Field />)}</>;
}

async function mount(off: boolean) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Host off={off} />));
}

test.skipIf(!hasDom)('Send waits until every Other take under it has ended', async () => {
  await mount(false);
  const report = seen!.report!;
  expect(seen!.voice.busy).toBe(false);
  await act(async () => report('first', true));
  await act(async () => report('second', true));
  expect(seen!.voice.busy).toBe(true);
  await act(async () => report('first', false));
  expect(seen!.voice.busy).toBe(true);
  expect(seen!.voice.busyNow()).toBe(true);
  await act(async () => report('second', false));
  expect(seen!.voice.busy).toBe(false);
  expect(seen!.voice.busyNow()).toBe(false);
});

test.skipIf(!hasDom)('a parked pane offers no mic in its Other fields; a live one does', async () => {
  await mount(true);
  expect(seen!.tools).toBeNull();
  await act(async () => root!.render(<Host off={false} />));
  expect(seen!.tools).not.toBeNull();
});
