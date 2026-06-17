import { afterEach, describe, expect, test } from "bun:test";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

import { useFileBrowser, type UseFileBrowserReturn } from "./useFileBrowser";
import type { VaultNode } from "../types";

const hasDom = typeof document !== "undefined";
const realFetch = globalThis.fetch;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetchResponses(responses: Response[]): void {
  const nextFetch = async () => responses.shift() ?? response({ error: "unexpected fetch" }, 500);
  globalThis.fetch = nextFetch as unknown as typeof fetch;
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

afterEach(() => {
  globalThis.fetch = realFetch;
  if (hasDom) document.body.innerHTML = "";
});

describe("useFileBrowser", () => {
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
});
