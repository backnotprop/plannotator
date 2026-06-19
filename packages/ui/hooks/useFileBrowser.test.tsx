import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

import { useFileBrowser, type UseFileBrowserReturn } from "./useFileBrowser";
import type { VaultNode } from "../types";

const hasDom = typeof document !== "undefined";
const realFetch = globalThis.fetch;
const realEventSource = globalThis.EventSource;

class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  close(): void {
    this.closed = true;
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchResponses(responses: Response[]): string[] {
  const calls: string[] = [];
  const nextFetch = async () => responses.shift() ?? response({ error: "unexpected fetch" }, 500);
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return nextFetch();
  }) as unknown as typeof fetch;
  return calls;
}

function installMockEventSource(): void {
  MockEventSource.instances = [];
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Harness({ resultRef }: { resultRef: { current: UseFileBrowserReturn | null } }) {
  resultRef.current = useFileBrowser();
  return null;
}

async function mountHook(): Promise<{
  result: { current: UseFileBrowserReturn | null };
  unmount: () => Promise<void>;
}> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const resultRef: { current: UseFileBrowserReturn | null } = { current: null };
  let root: Root;
  await act(async () => {
    root = createRoot(host);
    root.render(<Harness resultRef={resultRef} />);
  });
  return {
    result: resultRef,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      host.remove();
    },
  };
}

async function fetchTree(
  browser: UseFileBrowserReturn,
  dirPath: string,
  options?: { quiet?: boolean },
): Promise<void> {
  await act(async () => {
    await (browser.fetchTree(dirPath, options) as unknown as Promise<void>);
  });
}

const tick = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

afterEach(() => {
  globalThis.fetch = realFetch;
  if (realEventSource) globalThis.EventSource = realEventSource;
  else delete (globalThis as Record<string, unknown>).EventSource;
  MockEventSource.instances = [];
  if (hasDom) document.body.innerHTML = "";
});

describe("useFileBrowser", () => {
  test.skipIf(!hasDom)("waits for the initial tree fetch before opening the live watcher", async () => {
    installMockEventSource();
    const dirPath = "/tmp/plannotator-docs";
    const pending = deferred<Response>();
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return pending.promise;
    }) as unknown as typeof fetch;

    const session = await mountHook();
    await act(async () => {
      session.result.current!.fetchAll([dirPath]);
    });
    await tick(0);

    expect(calls).toHaveLength(1);
    expect(session.result.current!.dirs[0]).toMatchObject({ path: dirPath, isLoading: true });
    expect(MockEventSource.instances).toHaveLength(0);

    await act(async () => {
      pending.resolve(response({ tree: [] }));
      await tick(0);
    });
    await tick(0);

    expect(session.result.current!.dirs[0]).toMatchObject({ path: dirPath, isLoading: false, error: null });
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toContain("/api/reference/files/stream?");

    await session.unmount();
  });

  test.skipIf(!hasDom)("quiet invalid-directory refresh clears stale files", async () => {
    const dirPath = "/tmp/plannotator-docs";
    const tree: VaultNode[] = [{ type: "file", name: "a.md", path: "a.md" }];
    installFetchResponses([
      response({
        tree,
        workspaceStatus: {
          available: true,
          rootPath: dirPath,
          files: {},
          totals: { files: 0, additions: 0, deletions: 0 },
        },
      }),
      response({ error: "Invalid directory path" }, 400),
    ]);

    const session = await mountHook();
    await fetchTree(session.result.current!, dirPath);
    expect(session.result.current!.dirs[0]?.tree).toEqual(tree);
    expect(session.result.current!.dirs[0]?.error).toBeNull();

    await fetchTree(session.result.current!, dirPath, { quiet: true });
    expect(session.result.current!.dirs[0]).toMatchObject({
      path: dirPath,
      tree: [],
      error: "Invalid directory path",
    });
    expect(session.result.current!.dirs[0]?.workspaceStatus).toBeUndefined();

    await session.unmount();
  });

  test.skipIf(!hasDom)("quiet server failure preserves the previous tree", async () => {
    const dirPath = "/tmp/plannotator-docs";
    const tree: VaultNode[] = [{ type: "file", name: "a.md", path: "a.md" }];
    installFetchResponses([
      response({ tree }),
      response({ error: "Failed to list directory files" }, 500),
    ]);

    const session = await mountHook();
    await fetchTree(session.result.current!, dirPath);
    await fetchTree(session.result.current!, dirPath, { quiet: true });

    expect(session.result.current!.dirs[0]).toMatchObject({
      path: dirPath,
      tree,
      error: null,
    });

    await session.unmount();
  });

  test.skipIf(!hasDom)("refreshes after an SSE ready event from reconnect", async () => {
    installMockEventSource();
    const dirPath = "/tmp/plannotator-docs";
    const initialTree: VaultNode[] = [{ type: "file", name: "a.md", path: "a.md" }];
    const reconnectedTree: VaultNode[] = [
      { type: "file", name: "a.md", path: "a.md" },
      { type: "file", name: "b.md", path: "b.md" },
    ];
    const calls = installFetchResponses([
      response({ tree: initialTree }),
      response({ tree: reconnectedTree }),
    ]);

    const session = await mountHook();
    await fetchTree(session.result.current!, dirPath);
    await tick(0);

    const source = MockEventSource.instances[0];
    expect(source?.url).toContain("/api/reference/files/stream?");
    expect(session.result.current!.dirs[0]?.tree).toEqual(initialTree);
    expect(calls).toHaveLength(1);

    source!.emit({ type: "ready", dirPath });
    await tick(150);
    expect(calls).toHaveLength(1);
    expect(session.result.current!.dirs[0]?.tree).toEqual(initialTree);

    source!.emit({ type: "ready", dirPath });
    await tick(150);
    expect(calls).toHaveLength(2);
    expect(session.result.current!.dirs[0]?.tree).toEqual(reconnectedTree);

    await session.unmount();
  });
});
