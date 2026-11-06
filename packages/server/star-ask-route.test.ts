/**
 * The done screen's star ask routes on the Bun plan, review and annotate servers (`handleStarAsk`, shared-handlers.ts;
 * the decisions are packages/shared/star-ask.test.ts). What regresses: a route that runs the check in remote mode
 * (gh there is the server machine's login, not the person's), a surface recorded under the wrong name, or the route
 * answering paths that are not its own.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createStarAsk, setStarAskServiceForTests, type GhRunner, type StarAskRecord } from "@plannotator/shared/star-ask";
import { handleStarAsk } from "./shared-handlers";

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

const post = (path: string, body: unknown = {}) => new Request(`http://localhost:1234${path}`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

describe("handleStarAsk", () => {
  test("the claim records the server's surface and answers how the button works", async () => {
    const gh = fake();
    const res = await handleStarAsk(post("/api/star-ask/claim"), new URL("http://localhost:1234/api/star-ask/claim"), "annotate", { remote: false });
    expect(await res!.json()).toEqual({ show: true, can_star: true });
    expect(gh.record()).toMatchObject({ surface: "annotate", canStar: true });
  });

  test("remote mode: never shown, and gh never runs", async () => {
    const gh = fake();
    const res = await handleStarAsk(post("/api/star-ask/claim"), new URL("http://localhost:1234/api/star-ask/claim"), "plan", { remote: true });
    expect(await res!.json()).toEqual({ show: false, can_star: false });
    expect(gh.calls).toEqual([]);
    expect(gh.record()).toBeUndefined();
  });

  test("other paths are not its own", async () => {
    fake();
    expect(await handleStarAsk(post("/api/image"), new URL("http://localhost:1234/api/image"), "plan", { remote: false })).toBeNull();
  });
});
