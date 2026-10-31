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
import { adoptLegacyTailnetDoor, chooseTailnetDoorPort, writeTailnetDoorRecord } from "./inbox-tailnet-door";

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
