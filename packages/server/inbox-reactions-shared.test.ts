/**
 * The reaction tray's saved emoji, one set on every linked machine (inbox-reactions-shared.ts). What this catches: a
 * save that does not outrank a far machine's newer set (the set flips back on the next read), two machines that saved
 * the same revision settling on different sets, a far copy that is not newer taken over this one, and a far set that
 * loses its skills or reads garbage as a set.
 */
import { describe, expect, test } from "bun:test";
import type { InboxReaction } from "@plannotator/core/inbox-types";
import { nextSharedReactionsRev, readSharedReactions, SHARED_REACTIONS_REV_MAX, sharedReactionsNewer, type SharedReactions } from "./inbox-reactions-shared";

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
  });
});
