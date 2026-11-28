/**
 * The window's routine create, once per key. What regresses: a retried, kept-draft or restored-tab create (the same
 * key) making a second routine, also after a restart (the key is on the record); a failed create blocking the key's
 * next try, or each create that waited on it making its own; a deleted routine answered again; a key of any length.
 */
import { expect, test } from "bun:test";
import { createOnce } from "./inbox-scheduled-once";

type Rec = { id: string; name: string; create_key?: string };

function world() {
  const rows = new Map<string, Rec>();
  let n = 0;
  let fail = false;
  const create = async (name: string, key: string | undefined): Promise<Rec> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (fail) throw new Error("disk full");
    const rec = { id: `sch_${++n}`, name, ...(key ? { create_key: key } : {}) };
    rows.set(rec.id, rec);
    return rec;
  };
  // A fresh in-flight map each time: an Inbox restarted between two creates.
  const make = (key: unknown, name: string, inflight = new Map<string, Promise<unknown>>()) =>
    createOnce<Rec, Rec>(inflight)(key, (k) => create(name, k), (k) => [...rows.values()].find((r) => r.create_key === k) ?? null, (rec) => rec);
  return { rows, make, failNext: (on: boolean) => void (fail = on) };
}

test("one key makes one routine: at once, one after the other, and after a restart", async () => {
  const w = world();
  const inflight = new Map<string, Promise<unknown>>();
  const [a, b] = await Promise.all([w.make("k1", "Digest", inflight), w.make("k1", "Digest", inflight)]);
  const c = await w.make("k1", "Digest");
  expect([a.id, b.id, c.id]).toEqual(["sch_1", "sch_1", "sch_1"]);
  expect(w.rows.size).toBe(1);
  expect(inflight.size).toBe(0);
  // Another key, or none, is another routine.
  expect((await w.make("k2", "Digest")).id).toBe("sch_2");
  expect((await w.make(undefined, "Digest")).id).toBe("sch_3");
});

test("a failed create frees its key: the creates that waited on it make one routine between them", async () => {
  const w = world();
  const inflight = new Map<string, Promise<unknown>>();
  w.failNext(true);
  const first = w.make("k1", "Digest", inflight);
  const waiting = [w.make("k1", "Digest", inflight), w.make("k1", "Digest", inflight)];
  await expect(first).rejects.toThrow("disk full");
  w.failNext(false);
  const made = await Promise.all(waiting);
  expect(made.map((r) => r.id)).toEqual(["sch_1", "sch_1"]);
  expect(w.rows.size).toBe(1);
  // Its routine deleted: the key makes a new one.
  w.rows.delete("sch_1");
  expect((await w.make("k1", "Digest")).id).toBe("sch_2");
});

test("a key over 128 characters, or not a string, is refused and makes nothing", async () => {
  const w = world();
  await expect(w.make("k".repeat(129), "Digest")).rejects.toThrow("idempotency_key: a string of at most 128 characters.");
  await expect(w.make(42, "Digest")).rejects.toThrow("idempotency_key");
  expect(w.rows.size).toBe(0);
});
