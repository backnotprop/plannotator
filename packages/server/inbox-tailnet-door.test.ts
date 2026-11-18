/**
 * The Inbox's tailnet door port and its record (inbox-tailnet-door.ts): the
 * first publish takes the first free port of 8443 to 8450; that port sticks,
 * and a later start that finds it held refuses rather than move. Only a
 * mapping that matches the record (port, exact target, while published) is
 * the Inbox's. An older build's inbox.json `tailnet` is read as the record
 * once, and only an exact target counts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { adoptLegacyTailnetDoor, chooseTailnetDoorPort, loopbackPortRefused, loopbackTargetDead, ownLeftoverTarget, readTailnetDoorRecord, withMadeTargets, writeTailnetDoorRecord } from "./inbox-tailnet-door";

/** `tailscale serve status --json` with these mappings. */
const status = (mappings: Record<number, string>) =>
  JSON.stringify({
    TCP: Object.fromEntries(Object.keys(mappings).map((p) => [p, { HTTPS: true }])),
    Web: Object.fromEntries(Object.entries(mappings).map(([p, proxy]) => [`mac.tail0000.ts.net:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
  });
const DOOR = "http://127.0.0.1:52900";
const THEIRS = "http://127.0.0.1:62440";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const dataDir = () => {
  const root = mkdtempSync(join(tmpdir(), "plannotator-tailnet-door-"));
  roots.push(root);
  mkdirSync(join(root, "inbox"));
  return root;
};
const recordIn = (dir: string) => JSON.parse(readFileSync(join(dir, "inbox", "tailnet-door.json"), "utf8"));

describe("chooseTailnetDoorPort", () => {
  test("the first publish: 8443 when it is free, else the next free port; every port held is taken", () => {
    expect(chooseTailnetDoorPort("{}", null)).toEqual({ state: "usable", port: 8443, own: null });
    expect(chooseTailnetDoorPort(status({ 8443: THEIRS, 8444: THEIRS }), null)).toEqual({ state: "usable", port: 8445, own: null });
    // A target that only happens to be the door listener's port is someone else's with no record.
    expect(chooseTailnetDoorPort(status({ 8443: DOOR }), null)).toEqual({ state: "usable", port: 8444, own: null });
    const all = Object.fromEntries([8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450].map((p) => [p, THEIRS]));
    expect(chooseTailnetDoorPort(status(all), null)).toEqual({ state: "taken" });
  });

  test("the kept port sticks: reused while free, re-pointed when it is the Inbox's own, and held (never a move) when another mapping took it", () => {
    const record = { https_port: 8445, target: DOOR, published: true };
    expect(chooseTailnetDoorPort("{}", record)).toEqual({ state: "usable", port: 8445, own: null });
    expect(chooseTailnetDoorPort(status({ 8445: DOOR }), record)).toEqual({ state: "usable", port: 8445, own: DOOR });
    expect(chooseTailnetDoorPort(status({ 8445: THEIRS }), record)).toEqual({ state: "held", port: 8445 });
    // After a take-down (published: false), even the old exact target on that port is someone else's.
    expect(chooseTailnetDoorPort(status({ 8445: DOOR }), { ...record, published: false })).toEqual({ state: "held", port: 8445 });
  });

  test("a mapping this Inbox made where nothing listens now (a crash, a stop whose take-down read an empty serve status) is its own leftover: re-pointed; any other stays held", () => {
    const OLD = "http://127.0.0.1:52901";
    const record = { https_port: 8445, target: DOOR, published: false, made: [OLD, DOOR] };
    const dead = (target: string) => target === DOOR || target === OLD;
    // Its last target, after a take-down wrote published: false.
    expect(chooseTailnetDoorPort(status({ 8445: DOOR }), record, dead)).toEqual({ state: "usable", port: 8445, own: DOOR });
    // A target it made before that.
    expect(chooseTailnetDoorPort(status({ 8445: OLD }), record, dead)).toEqual({ state: "usable", port: 8445, own: OLD });
    // Something listens on its old target now: not dead, so never taken.
    expect(chooseTailnetDoorPort(status({ 8445: DOOR }), record, () => false)).toEqual({ state: "held", port: 8445 });
    // Someone else's mapping, dead or not: never the Inbox's.
    expect(chooseTailnetDoorPort(status({ 8445: THEIRS }), record, () => true)).toEqual({ state: "held", port: 8445 });
  });

  test("made targets ride the record, each once, the newest kept", () => {
    const dir = dataDir();
    const made = withMadeTargets(["http://127.0.0.1:1", "http://127.0.0.1:2"], "http://127.0.0.1:1", null, "http://127.0.0.1:3", "https://example.com");
    expect(made).toEqual(["http://127.0.0.1:2", "http://127.0.0.1:1", "http://127.0.0.1:3"]);
    writeTailnetDoorRecord(dir, { https_port: 8443, target: "http://127.0.0.1:3", published: false, made });
    expect(readTailnetDoorRecord(dir)?.made).toEqual(made);
    expect(withMadeTargets(Array.from({ length: 20 }, (_, i) => `http://127.0.0.1:${i + 1}`)).length).toBe(8);
  });

  test("the leftover to probe: a mapping on the record's port to its target or one it made, never its live published one or someone else's", () => {
    const OLD = "http://127.0.0.1:52901";
    const record = { https_port: 8445, target: DOOR, published: false, made: [OLD, DOOR] };
    expect(ownLeftoverTarget(status({ 8445: OLD }), record)).toBe(OLD);
    expect(ownLeftoverTarget(status({ 8445: DOOR }), record)).toBe(DOOR);
    expect(ownLeftoverTarget(status({ 8445: DOOR }), { ...record, published: true })).toBeNull();
    expect(ownLeftoverTarget(status({ 8445: THEIRS }), record)).toBeNull();
    expect(ownLeftoverTarget("{}", record)).toBeNull();
    expect(ownLeftoverTarget(status({ 8445: OLD }), null)).toBeNull();
  });

  test("a port something listens on, on every interface (0.0.0.0, as most servers do), is never dead", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      expect(await loopbackPortRefused(port)).toBe(false);
      expect(await loopbackTargetDead(`http://127.0.0.1:${port}`)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a port nothing listens on is dead: the connect is refused", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await loopbackPortRefused(port)).toBe(true);
    expect(await loopbackTargetDead(`http://127.0.0.1:${port}`)).toBe(true);
    expect(await loopbackTargetDead("https://example.com:443")).toBe(false);
  });

  test("output it cannot read is malformed, never a guess", () => {
    expect(chooseTailnetDoorPort("not json", null)).toEqual({ state: "malformed" });
    expect(chooseTailnetDoorPort("not json", { https_port: 8443, target: DOOR, published: true })).toEqual({ state: "malformed" });
  });
});

describe("adoptLegacyTailnetDoor (inbox.json from v0.28.40 and earlier)", () => {
  const legacy = { https_port: 8443, door_port: 52900 };

  test("a mapping to exactly the recorded door_port is adopted as the Inbox's; the port is kept", () => {
    const dir = dataDir();
    expect(adoptLegacyTailnetDoor(dir, legacy, status({ 8443: DOOR }))).toEqual({ https_port: 8443, target: DOOR, published: true });
    expect(recordIn(dir)).toEqual({ v: 1, https_port: 8443, target: DOOR, published: true });
  });

  test("a different target, or no mapping, is never the Inbox's: the port is kept, the mapping is not", () => {
    const other = dataDir();
    expect(adoptLegacyTailnetDoor(other, legacy, status({ 8443: THEIRS }))).toEqual({ https_port: 8443, target: DOOR, published: false });
    expect(adoptLegacyTailnetDoor(dataDir(), legacy, "{}")).toEqual({ https_port: 8443, target: DOOR, published: false });
  });

  test("once a record exists, inbox.json never counts again; with no old record, or output it cannot read, nothing is written", () => {
    const dir = dataDir();
    writeTailnetDoorRecord(dir, { https_port: 8444, target: "http://127.0.0.1:1111", published: false });
    expect(adoptLegacyTailnetDoor(dir, legacy, status({ 8443: DOOR }))).toEqual({ https_port: 8444, target: "http://127.0.0.1:1111", published: false });
    expect(recordIn(dir).https_port).toBe(8444);
    const none = dataDir();
    expect(adoptLegacyTailnetDoor(none, undefined, status({ 8443: DOOR }))).toBeNull();
    expect(adoptLegacyTailnetDoor(none, legacy, "not json")).toBeNull();
    expect(() => recordIn(none)).toThrow();
  });
});
