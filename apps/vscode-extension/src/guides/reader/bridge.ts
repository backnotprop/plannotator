/**
 * The reader's side of the messages with the extension: one place that
 * posts, one listener that accepts only the webview host's own messages
 * (`fromWebviewHost`, the same rule as the other Guides webviews), and
 * request/answer pairing for hovers and references.
 */

import type { DiffPosition, FromReader, HoverAnswer, ToReader } from "../reader-protocol";
import { fromWebviewHost } from "../webview/host-messages";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

const api = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : { postMessage: () => {}, getState: () => null, setState: () => {} };

export function post(message: FromReader): void {
  api.postMessage(message);
}

export const viewState = {
  get: () => api.getState() as { scrollY?: number; chapter?: number } | null,
  set: (s: { scrollY?: number; chapter?: number }) => api.setState(s),
};

type Listener = (msg: ToReader) => void;
const listeners = new Set<Listener>();

export function onMessage(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let nextReq = 1;
const hoverWaiters = new Map<number, (a: HoverAnswer | null) => void>();
const refWaiters = new Map<number, (n: number | null) => void>();

/** Hover round trips, for the latency check (drive script reads `window.__pnHoverTimings`). */
export const hoverTimings: Array<{ ms: number; serverMs: number | null; at: DiffPosition; ok: boolean; t: number; signature: string | null; doc: boolean; def: string | null }> = [];
(window as unknown as { __pnHoverTimings: typeof hoverTimings }).__pnHoverTimings = hoverTimings;

window.addEventListener("message", (event: MessageEvent<ToReader>) => {
  if (!fromWebviewHost(event)) return;
  const msg = event.data;
  if (!msg || typeof msg !== "object" || typeof (msg as { type?: unknown }).type !== "string") return;
  if (msg.type === "hover") {
    const done = hoverWaiters.get(msg.reqId);
    hoverWaiters.delete(msg.reqId);
    done?.(msg.answer);
    return;
  }
  if (msg.type === "references") {
    const done = refWaiters.get(msg.reqId);
    refWaiters.delete(msg.reqId);
    done?.(msg.count);
    return;
  }
  for (const l of listeners) l(msg);
});

const HOVER_TIMEOUT_MS = 15_000;

/** Ask the extension for the language server's hover at a diff position. */
export function requestHover(at: DiffPosition, signal?: AbortSignal): Promise<HoverAnswer | null> {
  const reqId = nextReq++;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const finish = (a: HoverAnswer | null) => {
      clearTimeout(timer);
      hoverWaiters.delete(reqId);
      const code = a?.blocks.find((b) => b.kind === "code");
      hoverTimings.push({
        ms: performance.now() - t0,
        serverMs: a?.elapsedMs ?? null,
        at,
        ok: !!a,
        t: Date.now(),
        signature: code ? code.text.slice(0, 120) : null,
        doc: !!a?.blocks.some((b) => b.kind === "markdown"),
        def: a?.definition ? `${a.definition.path}:${a.definition.line}` : null,
      });
      resolve(a);
    };
    const timer = setTimeout(() => finish(null), HOVER_TIMEOUT_MS);
    hoverWaiters.set(reqId, finish);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      hoverWaiters.delete(reqId);
      resolve(null);
    });
    post({ type: "hover", reqId, at });
  });
}

export function requestReferences(at: DiffPosition): Promise<number | null> {
  const reqId = nextReq++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      refWaiters.delete(reqId);
      resolve(null);
    }, 30_000);
    refWaiters.set(reqId, (n) => {
      clearTimeout(timer);
      resolve(n);
    });
    post({ type: "references", reqId, at });
  });
}

/** For the latency check: hover each position directly (no dwell, no cache). */
(window as unknown as { __pnMeasureHover: (list: DiffPosition[]) => Promise<number[]> }).__pnMeasureHover = async (list) => {
  const out: number[] = [];
  for (const at of list) {
    const t0 = performance.now();
    await requestHover(at);
    out.push(performance.now() - t0);
  }
  return out;
};
