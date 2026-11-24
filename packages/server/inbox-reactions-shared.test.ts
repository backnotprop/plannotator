/**
 * The reaction tray's saved emoji, one set on every linked machine (inbox-reactions-shared.ts). What this catches: a
 * save that does not outrank a far machine's newer set (the set flips back on the next read), two machines that saved
 * the same revision settling on different sets, a far copy that is not newer taken over this one, and a far set that
 * loses its skills or reads garbage as a set.
 */
import { describe, expect, test } from "bun:test";
import type { InboxReaction } from "@plannotator/core/inbox-types";
import { mergeSharedReactions, nextSharedReactionsRev, readSharedReactions, settleSharedReactions, SHARED_REACTIONS_REV_MAX, sharedReactionsNewer, type SharedReactions } from "./inbox-reactions-shared";

const bro: InboxReaction = { emoji: "😵‍💫", skill: "bro" };
const ship: InboxReaction = { emoji: "🎉", label: "Ship it" };

/** One machine's copy, and what it does with a far one, as inbox.ts does (adopt when newer). */
function machine(held: SharedReactions) {
  let copy = held;
  return {
    get: () => copy,
    save: (reactions: InboxReaction[], far: SharedReactions[]) => (copy = { reactions, rev: nextSharedReactionsRev(copy.rev, far) }),
    adopt: (far: SharedReactions) => (sharedReactionsNewer(far, copy) ? ((copy = far), true) : false),
  };
}

describe("saved reactions across linked machines", () => {
  test("a save goes one past the newest revision any machine holds, so the next read keeps it", () => {
    const a = machine({ reactions: [ship], rev: 2 });
    const farB: SharedReactions = { reactions: [bro], rev: 9 };
    const saved = a.save([ship, bro], [farB]);
    expect(saved.rev).toBe(10);
    // B reads A's list and takes it; A reads B's older one and keeps its own.
    const b = machine(farB);
    expect(b.adopt(a.get())).toBe(true);
    expect(b.get().reactions).toEqual([ship, bro]);
    expect(a.adopt(farB)).toBe(false);
    expect(nextSharedReactionsRev(SHARED_REACTIONS_REV_MAX, [])).toBe(SHARED_REACTIONS_REV_MAX);
  });

  test("two machines that saved the same revision settle on the same set, whichever reads first", () => {
    const a = machine({ reactions: [ship], rev: 4 });
    const b = machine({ reactions: [bro], rev: 4 });
    const fromA = a.get();
    const fromB = b.get();
    a.adopt(fromB);
    b.adopt(fromA);
    expect(a.get()).toEqual(b.get());
    // The same set at the same revision is not newer: reading it back writes nothing.
    expect(a.adopt(b.get())).toBe(false);
  });

  test("a far set keeps its names and skills; one that does not read is none", () => {
    expect(readSharedReactions({ reactions: [bro, ship], rev: 3 })).toEqual({ reactions: [bro, ship], rev: 3 });
    expect(readSharedReactions(undefined)).toBeNull();
    expect(readSharedReactions({ reactions: [bro], rev: -1 })).toBeNull();
    expect(readSharedReactions({ reactions: [bro], rev: SHARED_REACTIONS_REV_MAX + 1 })).toBeNull();
    expect(readSharedReactions({ reactions: "🎉", rev: 3 })).toBeNull();
    expect(readSharedReactions({ reactions: [bro], rev: 3, synced: true })).toEqual({ reactions: [bro], rev: 3, synced: true });
  });
});

/** One Inbox as inbox.ts runs it: a save here, and a linked machine's set read (`adoptReactions`). */
function inbox(reactions: InboxReaction[], rev: number, synced = false) {
  let copy: SharedReactions = { reactions, rev, ...(synced ? { synced: true } : {}) };
  return {
    get: () => copy,
    save: (list: InboxReaction[], far: SharedReactions[] = []) => (copy = { ...copy, reactions: list, rev: nextSharedReactionsRev(copy.rev, far) }),
    read: (far: SharedReactions) => {
      const next = settleSharedReactions(copy, far);
      copy = { ...(next ?? copy), synced: true };
    },
  };
}

/** Both read each other until nothing changes; returns how many rounds it took. */
function sync(a: ReturnType<typeof inbox>, b: ReturnType<typeof inbox>): number {
  for (let round = 1; round <= 6; round++) {
    const [fromA, fromB] = [a.get(), b.get()];
    a.read(fromB);
    b.read(fromA);
    if (JSON.stringify(a.get()) === JSON.stringify(fromA) && JSON.stringify(b.get()) === JSON.stringify(fromB)) return round;
  }
  throw new Error("the two never settled");
}

describe("the first sync merges the two sets; after that, newest wins", () => {
  const rocket: InboxReaction = { emoji: "🚀" };
  const eyes: InboxReaction = { emoji: "👀", label: "Looking" };

  test("a fresh computer's saves before linking (a higher revision) wipe nothing: the two sets are merged", () => {
    const desk = inbox([ship, eyes], 3);
    const laptop = inbox([], 0);
    for (let i = 0; i < 6; i++) laptop.save(i % 2 ? [rocket] : [rocket, { emoji: "🧪" }]);
    expect(laptop.get().rev).toBeGreaterThan(desk.get().rev);
    sync(desk, laptop);
    expect(desk.get().reactions).toEqual(laptop.get().reactions);
    expect(desk.get().reactions.map((r) => r.emoji)).toEqual(["🎉", "👀", "🚀"]);
    expect(desk.get().reactions[0]).toEqual(ship);
  });

  test("a fresh computer that saved and then emptied its tray wipes nothing", () => {
    const desk = inbox([ship, bro], 1);
    const laptop = inbox([], 0);
    laptop.save([rocket]);
    laptop.save([]);
    sync(desk, laptop);
    expect(desk.get().reactions).toEqual([ship, bro]);
    expect(laptop.get().reactions).toEqual([ship, bro]);
  });

  test("a skill is kept where either set has one", () => {
    const desk = inbox([{ emoji: "😵‍💫", label: "Bro" }, ship], 2);
    const laptop = inbox([bro], 1);
    sync(desk, laptop);
    expect(laptop.get().reactions).toEqual([{ emoji: "😵‍💫", label: "Bro", skill: "bro" }, ship]);
    expect(desk.get().reactions).toEqual(laptop.get().reactions);
    expect(mergeSharedReactions([bro], [{ emoji: "😵‍💫", label: "Bro" }, ship])).toEqual(mergeSharedReactions([{ emoji: "😵‍💫", label: "Bro" }, ship], [bro]));
  });

  test("on a pair that synced already, removing every emoji on one removes them on both", () => {
    const desk = inbox([ship, bro], 1);
    const laptop = inbox([rocket], 1);
    sync(desk, laptop);
    expect(desk.get().synced && laptop.get().synced).toBe(true);
    desk.save([], [laptop.get()]);
    sync(desk, laptop);
    expect(desk.get().reactions).toEqual([]);
    expect(laptop.get().reactions).toEqual([]);
    // And one removed emoji stays removed.
    laptop.save([ship], [desk.get()]);
    sync(desk, laptop);
    desk.save([], [laptop.get()]);
    sync(desk, laptop);
    expect(laptop.get().reactions).toEqual([]);
  });

  test("a third, fresh computer linked to a synced pair is merged in, and the pair takes the merge", () => {
    const desk = inbox([ship], 4, true);
    const laptop = inbox([ship], 4, true);
    const phone = inbox([rocket], 9);
    sync(desk, phone);
    sync(desk, laptop);
    expect(laptop.get().reactions.map((r) => r.emoji).sort()).toEqual(["🎉", "🚀"].sort());
    expect(phone.get().reactions).toEqual(desk.get().reactions);
  });
});
