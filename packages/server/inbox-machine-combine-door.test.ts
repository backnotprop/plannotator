/**
 * A Combine, and a Tidy with the person's words, at a linked machine's door (approval "inbox-multi-select";
 * docs/agent-guides/inbox-machines.md). The sending Inbox forwards them only for a press in its window and marks
 * that; the receiving one must refuse the same call without the mark, as it does a launch. What regresses: a script
 * holding a machine's token starting a Combine or a worded Tidy on the other machine; a press in the window refused
 * there; a Tidy without words (held and replayed without the mark) refused.
 *
 * Starts Inboxes: CI runs it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer } from "./inbox";
import { MACHINE_WINDOW_HEADER } from "./inbox-outbox";

type Json = Record<string, any>;

/** No real tailscale ever runs: the loopback transport is the test sandbox's, and serve holds nothing. */
const tailscale: TailscaleRunner = (args) => ({ status: 0, stdout: args[1] === "status" ? "{}" : "", stderr: "" });

describe("Combine and a worded Tidy at a linked machine's door", () => {
  const dirs: string[] = [];
  const sandboxWas = process.env.PLANNOTATOR_TEST_SANDBOX;
  beforeAll(() => {
    process.env.PLANNOTATOR_TEST_SANDBOX = "1";
  });
  afterAll(() => {
    if (sandboxWas === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
    else process.env.PLANNOTATOR_TEST_SANDBOX = sandboxWas;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  const start = (dataDir: string) => startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale, readProjectRepo: async () => null });
  const at = (port: number) => `http://127.0.0.1:${port}`;

  test("without the window's mark both are refused (window_only); with it they pass the door; a Tidy without words is not refused", async () => {
    const dataA = scratch("plannotator-combine-door-a-");
    const a = await start(dataA);
    const b = await start(scratch("plannotator-combine-door-b-"));
    try {
      const offered = (await (await fetch(`${at(b.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(a.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(b.port), back: at(a.port) }) });
      expect(linked.status).toBe(201);
      const token = (JSON.parse(readFileSync(join(dataA, "inbox", "machines.json"), "utf8")) as Json).links[0].token as string;
      // A's machine token at B's door, as A's Inbox sends a write: with or without the mark of a press in its window.
      const door = async (route: string, body: Json, window: boolean) => {
        const res = await fetch(`${at(b.port)}/api/inbox/device/${route}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(window ? { [MACHINE_WINDOW_HEADER]: "1" } : {}) },
          body: JSON.stringify(body),
        });
        return [res.status, ((await res.json()) as Json).code ?? null] as const;
      };
      const combine = { thread_ids: ["thr_one", "thr_two"], session: "ses-nobody", idempotency_key: "door-combine-1" };
      const worded = { sessions: ["ses-nobody"], words: "Only the billing threads", idempotency_key: "door-tidy-1" };

      expect(await door("combine", combine, false)).toEqual([403, "window_only"]);
      expect(await door("tidy", worded, false)).toEqual([403, "window_only"]);
      // Spaces only are no words: the plain Tidy, held and replayed like any append.
      expect((await door("tidy", { ...worded, words: "   ", idempotency_key: "door-tidy-2" }, false))[1]).not.toBe("window_only");

      // A press in A's window: past the door, to B's own checks (nobody to ask in this empty Inbox). Its own key: the
      // door answers a device's key once and replays that answer, the refusal too.
      const pressed = await door("combine", { ...combine, idempotency_key: "door-combine-2" }, true);
      expect(pressed[0]).not.toBe(403);
      expect(pressed[1]).not.toBe("window_only");
      const tidied = await door("tidy", { ...worded, idempotency_key: "door-tidy-3" }, true);
      expect(tidied[0]).not.toBe(403);
      expect(tidied[1]).not.toBe("window_only");
    } finally {
      a.stop();
      b.stop();
    }
  }, 60_000);
});
