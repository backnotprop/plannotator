/**
 * The rule that keeps draft text out of every durable record of finished commands, held over the two tables that
 * decide it (rule 8's DOOR_WRITES in inbox-outbox.ts, the door's ALLOWLIST in inbox-devices.ts), in process. No Inbox.
 * What regresses:
 *  - a route the outbox table calls `draft` that the door would record, or the other way round (the tables disagree);
 *  - a new route with a `draft` word in its path classified as anything else (`set`, say), so its words would be
 *    held in the outbox or written to the door's command log;
 *  - for any `draft` route: the outbox taking it (a byte written), or the real door writing a line to
 *    inbox/device-commands.jsonl for it, on a success or on a refusal that carries the draft's words.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_DEVICE_COMMANDS_FILE } from "@plannotator/shared/inbox/devices";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { createInboxDevices, doorRouteNames, doorRouteOf, doorWriteRoutes } from "./inbox-devices";
import { DOOR_WRITES, InboxOutbox } from "./inbox-outbox";

type Json = Record<string, any>;
const MACHINE = "ibx_01K00000000000000000000000";
const THREAD = "msg_01K7000000000000000000ABCD";
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "plannotator-draft-routes-"));
  roots.push(root);
  return root;
};

/** `POST a/(b|c)` as `POST a/b`, `POST a/c`: one name per route. */
const expand = (name: string): string[] => {
  const words = /\(([a-z-]+(?:\|[a-z-]+)+)\)/.exec(name);
  return words ? words[1]!.split("|").flatMap((word) => expand(name.replace(words[0]!, word))) : [name];
};
/** A door pattern in the outbox table's words. */
const named = (source: string) => `POST ${source.replace(/^\^|\$$/g, "").replaceAll("([^/]+)", ":id").replaceAll("\\/", "/")}`;
/** A path with a `draft` or `drafts` word in one of its segments (`draft`, `comment-draft`, `comment_draft`, `drafts`). */
const draftWorded = (name: string) => name.slice("POST ".length).split("/").some((segment) => segment.split(/[-_]/).some((word) => word === "draft" || word === "drafts"));

const tableDrafts = () =>
  Object.entries(DOOR_WRITES)
    .filter(([, kind]) => kind === "draft")
    .map(([name]) => name)
    .sort();
const doorDrafts = () =>
  doorWriteRoutes()
    .filter((route) => route.carries === "draft")
    .flatMap((route) => expand(named(route.route)))
    .sort();

describe("draft text is never in a durable record of finished commands", () => {
  test("parity: the outbox table calls a route `draft` exactly when the door says it carries draft text", () => {
    expect(tableDrafts().length).toBeGreaterThan(0);
    expect(doorDrafts()).toEqual(tableDrafts());
  });

  test("tripwire: every POST route in either table with a `draft` word in its path is a `draft` route", () => {
    const door = doorRouteNames()
      .filter((name) => name.startsWith("POST "))
      .flatMap(expand);
    const worded = [...new Set([...Object.keys(DOOR_WRITES), ...door])].filter(draftWorded).sort();
    expect(worded.length).toBeGreaterThan(0);
    expect(worded.filter((name) => DOOR_WRITES[name] !== "draft")).toEqual([]);
    expect(worded.filter((name) => door.includes(name) && !doorDrafts().includes(name))).toEqual([]);
    // The word is found in a hyphenated or snake_case segment too (made-up names: no such routes exist).
    expect(["POST threads/:id/comment_draft", "POST threads/:id/comment-draft", "POST drafts/:id", "POST threads/:id/seen", "POST threads/:id/drafty"].map(draftWorded)).toEqual([true, true, true, false, false]);
  });

  describe("every `draft` route, run", () => {
    const secret = "Charlie Dunn's refund, typed and not sent";
    for (const name of tableDrafts()) {
      const path = name.slice("POST ".length).replaceAll(":id", THREAD);

      test(`${name}: the outbox refuses it and writes nothing`, () => {
        const outbox = InboxOutbox.open(join(temp(), "data"));
        outbox.submit(MACHINE, `threads/${THREAD}/read`, { idempotency_key: "first" });
        const file = join(outbox.storeDir, "outbox", `${MACHINE}.jsonl`);
        const before = statSync(file).size;
        expect(() => outbox.submit(MACHINE, path, { idempotency_key: "draft-write", body: secret, base: null })).toThrow();
        expect(statSync(file).size).toBe(before);
        expect(readFileSync(file, "utf8")).not.toContain(secret);
        expect(outbox.list(MACHINE).map((entry) => entry.route)).toEqual([`threads/${THREAD}/read`]);
      });

      test(`${name}: the real door writes no line to its command log, answered or refused`, async () => {
        expect(doorRouteOf("POST", path, true)).not.toBeNull();
        const dataDir = temp();
        let status = 200;
        const handed: string[] = [];
        const devices = createInboxDevices({
          dataDir,
          serverSession: "0".repeat(32),
          port: () => 1,
          registry: () => ({ v: 1, pid: process.pid, port: 1, url: "", version: "dev", token: "t".repeat(64), serverSession: "0".repeat(32), startedAt: "" }),
          readBody: async (req) => (await req.json()) as Record<string, unknown>,
          // The window's handler as a stand-in: its answer carries the draft's words, a success or a conflict.
          dispatch: async (req) => {
            const at = new URL(req.url).pathname;
            if (at.endsWith("/seen")) return Response.json({ ok: true });
            handed.push(at);
            const body = (await req.json()) as Json;
            return Response.json(status === 200 ? { draft: { body: body.body ?? secret } } : { code: "draft_conflict", draft: { body: secret } }, { status });
          },
        });
        const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
        const machine = (await (await devices.door(new Request(pairUrl, { method: "POST", body: JSON.stringify({ name: "MacBook", platform: "machine", secret: devices.machineDoor.openMachineOffer().secret }) }), pairUrl)).json()) as Json;
        const post = async (route: string, body: Json) => {
          const url = new URL(`http://127.0.0.1/api/inbox/device/${route}`);
          const answer = await devices.door(new Request(url, { method: "POST", headers: { Authorization: `Bearer ${machine.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }), url);
          return answer.status;
        };
        const logFile = join(inboxDir(dataDir), INBOX_DEVICE_COMMANDS_FILE);
        const lines = () => (existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean) : []);
        expect(await post(path, { idempotency_key: "draft-ok", body: secret, base: null })).toBe(200);
        status = 409;
        expect(await post(path, { idempotency_key: "draft-refused", body: secret, base: null })).toBe(409);
        // Both reached the window's handler: the door answered them, it did not refuse them itself.
        expect(handed).toHaveLength(2);
        expect(lines()).toEqual([]);
        // The same door still records a write that carries no draft (so an empty log above is the rule, not a dead log).
        status = 200;
        expect(await post(`threads/${THREAD}/seen`, { idempotency_key: "seen" })).toBe(200);
        expect(lines()).toHaveLength(1);
        expect(lines().join("\n")).not.toContain(secret);
      });
    }
  });
});
