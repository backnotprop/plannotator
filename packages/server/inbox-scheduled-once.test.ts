/**
 * The window's routine create, once per key. What regresses: a retried or kept-draft create (the same key) making a
 * second routine, a failed create blocking the key's next try, or a deleted routine answered again.
 */
import { expect, test } from "bun:test";
import { createOnce } from "./inbox-scheduled-once";

type Rec = { id: string; name: string };

function world() {
  const rows = new Map<string, Rec>();
  let n = 0;
  let fail = false;
  const create = async (name: string): Promise<Rec> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (fail) throw new Error("disk full");
    const rec = { id: `sch_${++n}`, name };
    rows.set(rec.id, rec);
    return rec;
  };
  const once = createOnce<Rec, Rec>(new Map());
  const make = (key: unknown, name: string) => once(key, () => create(name), (id) => rows.get(id) ?? null, (rec) => rec);
  return { rows, make, failNext: (on: boolean) => void (fail = on) };
}

test("two creates with one key, one after the other or at once, make one routine", async () => {
  const w = world();
  const [a, b] = await Promise.all([w.make("k1", "Digest"), w.make("k1", "Digest")]);
  const c = await w.make("k1", "Digest");
  expect([a.id, b.id, c.id]).toEqual(["sch_1", "sch_1", "sch_1"]);
  expect(w.rows.size).toBe(1);
  // Another key, or none, is another routine.
  expect((await w.make("k2", "Digest")).id).toBe("sch_2");
  expect((await w.make(undefined, "Digest")).id).toBe("sch_3");
});

test("a key whose create failed makes it on the next try; a key whose routine was deleted makes a new one", async () => {
  const w = world();
  w.failNext(true);
  await expect(w.make("k1", "Digest")).rejects.toThrow("disk full");
  w.failNext(false);
  const made = await w.make("k1", "Digest");
  expect(made.id).toBe("sch_1");
  w.rows.delete(made.id);
  expect((await w.make("k1", "Digest")).id).toBe("sch_2");
});
