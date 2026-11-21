/**
 * The link records (inbox-links.ts): the one place linking state lives.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxLinks, parseLinkOffer, type InboxLinkRecord } from "./inbox-links";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "plannotator-links-"));
  roots.push(root);
  return join(root, "data");
}
const record = (id: string, name: string, url = "https://mini.tail1234.ts.net:8443"): InboxLinkRecord => ({
  id,
  name,
  token: "tok_x",
  transport: { kind: "tailnet", url },
  device_id: null,
  linked_at: "2026-10-30T00:00:00Z",
});
const OTHER = "ibx_01K00000000000000000000000";

describe("machines.json", () => {
  test("an Inbox that never links writes nothing; once an offer keeps its id, the id survives restarts", () => {
    const dir = dataDir();
    const links = InboxLinks.open(dir);
    expect(links.selfId).toMatch(/^ibx_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(existsSync(join(dir, "inbox", "machines.json"))).toBe(false);
    links.keepSelf();
    expect(InboxLinks.open(dir).selfId).toBe(links.selfId);
  });

  test("an unreadable machines.json is moved aside, never written over", () => {
    const dir = dataDir();
    const links = InboxLinks.open(dir);
    links.put(record(OTHER, "Mini"));
    const file = join(dir, "inbox", "machines.json");
    writeFileSync(file, '{"v":1,"self":{"id":"ibx_01K', { mode: 0o600 });
    const reopened = InboxLinks.open(dir);
    expect(reopened.list()).toHaveLength(0);
    const aside = readdirSync(join(dir, "inbox")).filter((name) => name.startsWith("machines.json.unreadable-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, "inbox", aside[0]!), "utf8")).toBe('{"v":1,"self":{"id":"ibx_01K');
    expect(existsSync(file)).toBe(false);
  });

  test("rule 19: a second link to the same Inbox id replaces the first (re-pairing, a new address)", () => {
    const links = InboxLinks.open(dataDir());
    links.put(record(OTHER, "Mini"));
    links.put(record(OTHER, "Mini", "https://mini-2.tail1234.ts.net:8443"));
    expect(links.list().map((l) => l.transport.url)).toEqual(["https://mini-2.tail1234.ts.net:8443"]);
  });

  test("rule 19: a link to this Inbox's own id is refused (a data folder copied to another computer)", () => {
    const links = InboxLinks.open(dataDir());
    expect(() => links.put(record(links.selfId, "Me"))).toThrow(/own link code/);
    expect(links.list()).toHaveLength(0);
  });

  test("the file holds tokens: 0600, written by temp file and rename, nothing left beside it", () => {
    const dir = dataDir();
    const links = InboxLinks.open(dir);
    links.put(record(OTHER, "Mini"));
    links.remove(OTHER);
    links.put(record(OTHER, "Mini"));
    const file = join(dir, "inbox", "machines.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "inbox")).filter((name) => name.includes("machines"))).toEqual(["machines.json"]);
    expect(InboxLinks.open(dir).get(OTHER)?.token).toBe("tok_x");
  });

  test("a record whose transport is unusable (plain http to another host) is not loaded", () => {
    const dir = dataDir();
    const links = InboxLinks.open(dir);
    links.put(record(OTHER, "Mini"));
    const file = join(dir, "inbox", "machines.json");
    const text = readFileSync(file, "utf8").replace("https://mini.tail1234.ts.net:8443", "http://mini.tail1234.ts.net:8443");
    writeFileSync(file, text);
    expect(InboxLinks.open(dir).list()).toHaveLength(0);
  });
});

describe("the pairing link", () => {
  test("a link code is read for its id, name, tailnet address, secret and digits; anything else is not one", () => {
    const offer = parseLinkOffer(`plannotator://link?v=1&id=${OTHER}&name=Mac%20mini&tailnet=mini.tail1234.ts.net%3A8443&secret=s3cr3t&code=123456`);
    expect(offer).toEqual({ id: OTHER, name: "Mac mini", tailnet: "mini.tail1234.ts.net:8443", secret: "s3cr3t", code: "123456" });
    expect(parseLinkOffer("plannotator://pair?v=1&secret=x")).toBeNull();
    expect(parseLinkOffer("plannotator://link?v=2&secret=x")).toBeNull();
    expect(parseLinkOffer("https://example.com/link?v=1")).toBeNull();
    expect(parseLinkOffer(`plannotator://link?v=1&id=not-an-id&secret=x`)!.id).toBeNull();
  });
});
