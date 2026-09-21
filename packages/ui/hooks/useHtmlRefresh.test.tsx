/**
 * Refresh-cycle guards for the published useHtmlRefresh (DOM-gated).
 *
 * The failures worth catching: a superseded or post-navigation fetch still
 * applying its bytes; a missing/unavailable snapshot applying anything; the
 * restore acknowledgement firing more than once per refresh, or for a
 * report that belongs to another document or an older reload generation.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useHtmlRefresh,
  type HtmlRefreshResult,
  type HtmlRefreshSnapshot,
  type UseHtmlRefreshReturn,
} from './useHtmlRefresh';

const hasDom = typeof document !== 'undefined';

type Deferred = { resolve: (value: HtmlRefreshSnapshot) => void };

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (!hasDom) return;
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function Harness({
  documentKey,
  fetchSnapshot,
  onSnapshot,
  onUnanchored,
  onResult,
  api,
}: {
  documentKey: string | null;
  fetchSnapshot: (key: string | null) => Promise<HtmlRefreshSnapshot>;
  onSnapshot: (rawHtml: string) => void;
  onUnanchored: (ids: string[]) => void;
  onResult: (result: HtmlRefreshResult) => void;
  api: { current: UseHtmlRefreshReturn | null };
}) {
  api.current = useHtmlRefresh({ documentKey, fetchSnapshot, onSnapshot, onUnanchored, onResult });
  return null;
}

async function mount(initialKey: string | null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const api: { current: UseHtmlRefreshReturn | null } = { current: null };
  const pending: Deferred[] = [];
  const fetched: Array<string | null> = [];
  const snapshots: string[] = [];
  const unanchored: string[][] = [];
  const results: HtmlRefreshResult[] = [];
  const fetchSnapshot = (key: string | null) =>
    new Promise<HtmlRefreshSnapshot>((resolve) => {
      fetched.push(key);
      pending.push({ resolve });
    });
  const render = async (documentKey: string | null) => {
    await act(async () => {
      root!.render(
        <Harness
          documentKey={documentKey}
          fetchSnapshot={fetchSnapshot}
          onSnapshot={(raw) => snapshots.push(raw)}
          onUnanchored={(ids) => unanchored.push(ids)}
          onResult={(r) => results.push(r)}
          api={api}
        />,
      );
    });
  };
  await render(initialKey);
  const settle = async (index: number, value: HtmlRefreshSnapshot) => {
    // The hook's continuation (apply, generation bump, isRefreshing reset)
    // runs several microtasks after the fetch resolves; a macrotask turn
    // keeps every resulting state update inside act.
    await act(async () => {
      pending[index]!.resolve(value);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  return { api, render, settle, fetched, snapshots, unanchored, results };
}

describe.if(hasDom)('useHtmlRefresh (published)', () => {
  test('a superseded fetch never applies: only the newest refresh lands', async () => {
    const h = await mount('a.html');
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => { first = h.api.current!.refresh(); });
    await act(async () => { second = h.api.current!.refresh(); });
    expect(h.fetched).toEqual(['a.html', 'a.html']);
    await h.settle(0, { status: 'ok', rawHtml: '<p>stale</p>' });
    expect(h.snapshots).toEqual([]);
    expect(h.api.current!.isRefreshing).toBe(true);
    await h.settle(1, { status: 'ok', rawHtml: '<p>fresh</p>' });
    await first;
    await second;
    expect(h.snapshots).toEqual(['<p>fresh</p>']);
    expect(h.api.current!.reloadGeneration).toBe(1);
    expect(h.api.current!.isRefreshing).toBe(false);
    expect(h.results).toEqual(['refreshed']);
  });

  test('a document change cancels the in-flight fetch and its restore ack', async () => {
    const h = await mount('a.html');
    let inflight!: Promise<void>;
    await act(async () => { inflight = h.api.current!.refresh(); });
    await h.render('b.html');
    expect(h.api.current!.isRefreshing).toBe(false);
    await h.settle(0, { status: 'ok', rawHtml: '<p>from a</p>' });
    await inflight;
    expect(h.snapshots).toEqual([]);
    expect(h.api.current!.reloadGeneration).toBe(0);
    // No pending ack survives the navigation: a report is ignored.
    h.api.current!.reportAnnotationRestore(['x']);
    expect(h.unanchored).toEqual([]);
  });

  test('missing and unavailable snapshots report their outcome and apply nothing', async () => {
    const h = await mount('a.html');
    let p!: Promise<void>;
    await act(async () => { p = h.api.current!.refresh(); });
    await h.settle(0, { status: 'missing' });
    await p;
    await act(async () => { p = h.api.current!.refresh(); });
    await h.settle(1, { status: 'unavailable' });
    await p;
    expect(h.results).toEqual(['missing', 'unavailable']);
    expect(h.snapshots).toEqual([]);
    expect(h.api.current!.reloadGeneration).toBe(0);
  });

  test('the restore ack fires once per refresh with the first report, and only for that generation', async () => {
    const h = await mount('a.html');
    // Before any refresh a report has nothing to acknowledge.
    h.api.current!.reportAnnotationRestore(['early']);
    expect(h.unanchored).toEqual([]);

    let p!: Promise<void>;
    await act(async () => { p = h.api.current!.refresh(); });
    await h.settle(0, { status: 'ok', rawHtml: '<p>v2</p>' });
    await p;
    h.api.current!.reportAnnotationRestore(['lost-1', 'lost-2']);
    h.api.current!.reportAnnotationRestore([]);
    expect(h.unanchored).toEqual([['lost-1', 'lost-2']]);

    // A clean refresh acknowledges an empty report too (the host clears its chip).
    await act(async () => { p = h.api.current!.refresh(); });
    await h.settle(1, { status: 'ok', rawHtml: '<p>v3</p>' });
    await p;
    h.api.current!.reportAnnotationRestore([]);
    h.api.current!.reportAnnotationRestore(['late']);
    expect(h.unanchored).toEqual([['lost-1', 'lost-2'], []]);
  });

  test('a rejecting fetchSnapshot is an unavailable outcome, never an unhandled rejection', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const api: { current: UseHtmlRefreshReturn | null } = { current: null };
    const results: HtmlRefreshResult[] = [];
    const snapshots: string[] = [];
    await act(async () => {
      root!.render(
        <Harness
          documentKey="a.html"
          fetchSnapshot={() => Promise.reject(new Error('network down'))}
          onSnapshot={(raw) => snapshots.push(raw)}
          onUnanchored={() => {}}
          onResult={(r) => results.push(r)}
          api={api}
        />,
      );
    });
    await act(async () => { await api.current!.refresh(); });
    expect(results).toEqual(['unavailable']);
    expect(snapshots).toEqual([]);
    expect(api.current!.isRefreshing).toBe(false);
  });

  test('canRefresh follows enabled and the document key', async () => {
    const h = await mount(null);
    expect(h.api.current!.canRefresh).toBe(false);
    await act(async () => { await h.api.current!.refresh(); });
    expect(h.fetched).toEqual([]);
    await h.render('a.html');
    expect(h.api.current!.canRefresh).toBe(true);
  });
});
