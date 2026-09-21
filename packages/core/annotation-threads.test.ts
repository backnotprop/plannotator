/**
 * The one threading rule every `inReplyTo` consumer applies. Failures to
 * catch: a cycle member being treated as a reply (and then dropped by a
 * renderer that only walks down from roots), a self-reference threading
 * under itself, and the ingest accepting a write that would close a cycle.
 */
import { describe, expect, test } from "bun:test";
import { resolveReplyParents, resolveThreadRootTimestamps, validateReplyTarget } from "./annotation-threads";

const a = (id: string, inReplyTo?: string) => ({ id, inReplyTo });

describe("resolveReplyParents", () => {
  test("valid replies keep their parent; roots, orphans and self-references are roots", () => {
    const parents = resolveReplyParents([a("p"), a("r", "p"), a("orphan", "gone"), a("self", "self"), a("deep", "r")]);
    expect(parents.get("p")).toBeNull();
    expect(parents.get("r")).toBe("p");
    expect(parents.get("orphan")).toBeNull();
    expect(parents.get("self")).toBeNull();
    expect(parents.get("deep")).toBe("r");
  });

  test("every member of a cycle is a root, and a reply to a cycle member still threads under it", () => {
    const parents = resolveReplyParents([a("x", "y"), a("y", "x"), a("c", "x"), a("l1", "l3"), a("l2", "l1"), a("l3", "l2")]);
    expect(parents.get("x")).toBeNull();
    expect(parents.get("y")).toBeNull();
    expect(parents.get("c")).toBe("x");
    expect(parents.get("l1")).toBeNull();
    expect(parents.get("l2")).toBeNull();
    expect(parents.get("l3")).toBeNull();
  });

  test("a reply whose parent is an orphan is still a reply (the orphan renders as a root)", () => {
    const parents = resolveReplyParents([a("o", "gone"), a("r", "o")]);
    expect(parents.get("o")).toBeNull();
    expect(parents.get("r")).toBe("o");
  });

  test("a chain that runs into a cycle: the run-in stays replies, the cycle is roots, in any input order", () => {
    // c -> b -> x -> y -> x. Listed cycle-first and run-in-first.
    for (const items of [
      [a("x", "y"), a("y", "x"), a("b", "x"), a("c", "b")],
      [a("c", "b"), a("b", "x"), a("x", "y"), a("y", "x")],
    ]) {
      const parents = resolveReplyParents(items);
      expect(parents.get("c")).toBe("b");
      expect(parents.get("b")).toBe("x");
      expect(parents.get("x")).toBeNull();
      expect(parents.get("y")).toBeNull();
    }
  });

  // A hostile or buggy tool can POST a 5,000-deep chain; walking each chain
  // to its root without memoization made this quadratic (5,000 = 431 ms,
  // 20,000 = 9.8 s), and the panel re-ran it on every render.
  test("a 5,000-deep chain resolves parents and root timestamps in linear time", () => {
    const items = [{ id: "0", inReplyTo: undefined as string | undefined, createdA: 0 }];
    for (let i = 1; i < 5000; i++) items.push({ id: String(i), inReplyTo: String(i - 1), createdA: i });
    const start = performance.now();
    const parents = resolveReplyParents(items);
    const rootTs = resolveThreadRootTimestamps(items, parents);
    const elapsed = performance.now() - start;
    expect(parents.get("4999")).toBe("4998");
    expect(parents.get("0")).toBeNull();
    expect(rootTs.get("4999")).toBe(0);
    expect(rootTs.get("0")).toBe(0);
    expect(elapsed).toBeLessThan(100);
  });
});

describe("resolveThreadRootTimestamps", () => {
  test("replies take their root's timestamp; roots, orphans and cycle members keep their own", () => {
    const items = [
      { id: "p", createdA: 10 },
      { id: "r", inReplyTo: "p", createdA: 50 },
      { id: "rr", inReplyTo: "r", createdA: 60 },
      { id: "orphan", inReplyTo: "gone", createdA: 20 },
      { id: "x", inReplyTo: "y", createdA: 30 },
      { id: "y", inReplyTo: "x", createdA: 40 },
      { id: "c", inReplyTo: "x", createdA: 70 },
    ];
    const ts = resolveThreadRootTimestamps(items);
    expect(ts.get("r")).toBe(10);
    expect(ts.get("rr")).toBe(10);
    expect(ts.get("orphan")).toBe(20);
    expect(ts.get("x")).toBe(30);
    expect(ts.get("y")).toBe(40);
    expect(ts.get("c")).toBe(30);
  });
});

describe("validateReplyTarget", () => {
  const all = [a("p"), a("r", "p"), a("x", "y"), a("y", "x")];

  test("accepts an existing different target and clearing", () => {
    expect(validateReplyTarget(all, "x", "p")).toBeNull();
    expect(validateReplyTarget(all, "r", null)).toBeNull();
    expect(validateReplyTarget(all, "r", undefined)).toBeNull();
  });

  test("rejects self, missing, non-string and cycle-closing targets", () => {
    expect(validateReplyTarget(all, "p", "p")).toContain("itself");
    expect(validateReplyTarget(all, "p", "nope")).toContain("nope");
    expect(validateReplyTarget(all, "p", 42)).toContain("inReplyTo");
    expect(validateReplyTarget(all, "p", "")).toContain("inReplyTo");
    // r -> p; setting p -> r closes p -> r -> p.
    expect(validateReplyTarget(all, "p", "r")).toContain("cycle");
  });

  test("a pre-existing cycle elsewhere does not block an unrelated reply", () => {
    expect(validateReplyTarget(all, "p", "x")).toBeNull();
  });
});
