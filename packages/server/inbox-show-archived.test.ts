/**
 * The list's "Show archived" switch across linked machines (inbox-show-archived.ts; approval "inbox-archived-group"):
 * one answer on every machine. What this catches: a save that does not outrank a far machine's newer copy (the switch
 * flips back on the next read), two machines that saved at once settling on different answers, a copy that is not
 * newer written over this one, a broken config.json read as on, and a failed save the windows hear as done.
 */
import { describe, expect, test } from "bun:test";
import { createShowArchived, readShowArchived, SHOW_ARCHIVED_REV_MAX, showArchivedNewer, type InboxShowArchived } from "./inbox-show-archived";

const A = "ibx_01K0000000000000000000000A";
const B = "ibx_01K0000000000000000000000B";

function machine(self: string, far: InboxShowArchived[] = [], saves = true) {
  let saved: unknown = undefined;
  const heard: InboxShowArchived[] = [];
  const pref = createShowArchived({
    load: () => saved,
    save: (value) => {
      if (saves) saved = value;
      return saves;
    },
    self: () => self,
    far: () => far,
  });
  pref.subscribe((value) => heard.push(value));
  return { pref, heard, far };
}

describe("Show archived", () => {
  test("off until saved; anything that does not parse reads as off", () => {
    expect(machine(A).pref.state()).toEqual({ on: false, rev: 0, by: null });
    expect(readShowArchived({ on: "yes", rev: 3 })).toEqual({ on: false, rev: 0, by: null });
    expect(readShowArchived({ on: true, rev: -1 })).toEqual({ on: false, rev: 0, by: null });
    expect(readShowArchived({ on: true, rev: 2, by: "not-a-machine" })).toEqual({ on: true, rev: 2, by: null });
  });

  test("a save goes one past the newest revision any machine holds, and the windows hear it", () => {
    const { pref, heard, far } = machine(A, [{ on: true, rev: 6, by: B }]);
    expect(pref.set(true)).toEqual({ on: true, rev: 7, by: A });
    expect(heard).toEqual([{ on: true, rev: 7, by: A }]);
    far.length = 0;
    expect(pref.set(false).rev).toBe(8);
  });

  test("a far copy is taken only when newer; the same revision goes to the higher machine id on both sides", () => {
    const a = machine(A);
    const b = machine(B);
    const fromA = a.pref.set(true);
    const fromB = b.pref.set(false);
    expect(fromA.rev).toBe(fromB.rev);
    // Each reads the other's copy: both end on B's answer.
    expect(a.pref.adopt(fromB)).toBe(true);
    expect(b.pref.adopt(fromA)).toBe(false);
    expect(a.pref.state()).toEqual(b.pref.state());
    expect(a.pref.state().on).toBe(false);
    // An older copy never comes back.
    expect(a.pref.adopt({ on: true, rev: 0, by: B })).toBe(false);
    expect(showArchivedNewer({ on: true, rev: 1, by: null }, { on: false, rev: 1, by: A })).toBe(false);
  });

  test("a far copy with an absurd revision is not taken, and a save past one still saves", () => {
    expect(readShowArchived({ on: true, rev: Number.MAX_SAFE_INTEGER, by: B })).toEqual({ on: false, rev: 0, by: null });
    const { pref } = machine(A, [{ on: true, rev: Number.MAX_SAFE_INTEGER, by: B }]);
    expect(pref.set(true)).toEqual({ on: true, rev: SHOW_ARCHIVED_REV_MAX, by: A });
    expect(pref.set(false).on).toBe(false);
    expect(pref.state().on).toBe(false);
  });

  test("a save that could not be written throws config_not_saved and tells no window", () => {
    const { pref, heard } = machine(A, [], false);
    expect(() => pref.set(true)).toThrow(expect.objectContaining({ code: "config_not_saved" }));
    expect(heard).toEqual([]);
    expect(pref.state().on).toBe(false);
  });
});
