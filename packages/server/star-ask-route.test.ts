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
  const call = (path: string, surface: "plan" | "annotate", remote = false) => handleStarAsk(post(path), new URL(`http://localhost:1234${path}`), surface, { remote });

  test("the claim at load uses nothing up; shown, at the decision, stamps the server's surface", async () => {
    const gh = fake();
    expect(await (await call("/api/star-ask/claim", "annotate"))!.json()).toEqual({ show: true, can_star: true });
    expect(gh.record()?.shownAt).toBeUndefined();
    expect(gh.record()?.checkedAt).toBeString();
    expect(await (await call("/api/star-ask/shown", "annotate"))!.json()).toEqual({ show: true });
    expect(gh.record()).toMatchObject({ surface: "annotate", canStar: true });
    expect(gh.record()?.shownAt).toBeString();
    expect(await (await call("/api/star-ask/shown", "annotate"))!.json()).toEqual({ show: false });
  });

  test("remote mode: never shown, gh never runs, nothing stamped (even after a local page checked)", async () => {
    const gh = fake();
    expect(await (await call("/api/star-ask/claim", "plan", true))!.json()).toEqual({ show: false, can_star: false });
    expect(gh.calls).toEqual([]);
    expect(gh.record()).toBeUndefined();
    await call("/api/star-ask/claim", "plan");
    expect(await (await call("/api/star-ask/shown", "plan", true))!.json()).toEqual({ show: false });
    expect(gh.record()?.shownAt).toBeUndefined();
  });

  test("other paths are not its own", async () => {
    fake();
    expect(await handleStarAsk(post("/api/image"), new URL("http://localhost:1234/api/image"), "plan", { remote: false })).toBeNull();
  });
});
