/**
 * The done screen's star ask route on the Pi plan, review and annotate servers (`handleStarAskRequest`, handlers.ts),
 * the Bun servers' mirror (packages/server/star-ask-route.test.ts). What regresses: Pi's route missing (claim at load,
 * shown at the decision), the claim using the ask up, recording the wrong surface, or checking or stamping in remote mode.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createStarAsk, setStarAskServiceForTests, type GhRunner, type StarAskRecord } from "../generated/star-ask.ts";
import { handleStarAskRequest } from "./handlers.ts";

afterEach(() => setStarAskServiceForTests(null));

function fake() {
  let record: StarAskRecord | undefined;
  const calls: string[][] = [];
  const run: GhRunner = async (args) => {
    calls.push([...args]);
    return { code: 1, stdout: "HTTP/2.0 404 Not Found\r\n\r\n", stderr: "" };
  };
  setStarAskServiceForTests(
    createStarAsk({ store: { read: () => ({ record, raw: record }), write: (r) => ((record = r), true) }, run, enabled: () => true, returning: () => true, timeoutMs: 50 }),
  );
  return { calls, record: () => record };
}

function exchange(path: string, body: unknown = {}) {
  const req = Object.assign(Readable.from([JSON.stringify(body)]), { method: "POST", url: path, headers: {} }) as unknown as IncomingMessage;
  const sent: { status?: number; body?: string } = {};
  const res = {
    writeHead(status: number) {
      sent.status = status;
      return res;
    },
    end(chunk: string) {
      sent.body = chunk;
    },
  } as unknown as ServerResponse;
  return { req, res, sent, url: new URL(`http://localhost:1234${path}`) };
}

describe("handleStarAskRequest (Pi)", () => {
  const call = async (path: string, surface: "plan" | "review", remote = false) => {
    const x = exchange(path);
    expect(await handleStarAskRequest(x.req, x.res, x.url, surface, remote)).toBe(true);
    return JSON.parse(x.sent.body!);
  };

  test("the claim at load uses nothing up; shown, at the decision, stamps the server's surface", async () => {
    const gh = fake();
    expect(await call("/api/star-ask/claim", "review")).toEqual({ show: true, can_star: true });
    expect(gh.record()?.shownAt).toBeUndefined();
    expect(await call("/api/star-ask/shown", "review")).toEqual({ show: true });
    expect(gh.record()).toMatchObject({ surface: "review", canStar: true });
    expect(await call("/api/star-ask/shown", "review")).toEqual({ show: false });
  });

  test("remote mode: never shown, gh never runs, nothing stamped", async () => {
    const gh = fake();
    expect(await call("/api/star-ask/claim", "plan", true)).toEqual({ show: false, can_star: false });
    expect(gh.calls).toEqual([]);
    await call("/api/star-ask/claim", "plan");
    expect(await call("/api/star-ask/shown", "plan", true)).toEqual({ show: false });
    expect(gh.record()?.shownAt).toBeUndefined();
  });

  test("other paths are not its own", async () => {
    fake();
    const x = exchange("/api/image");
    expect(await handleStarAskRequest(x.req, x.res, x.url, "plan", false)).toBe(false);
  });
});
