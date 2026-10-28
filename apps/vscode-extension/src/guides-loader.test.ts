import { describe, expect, it } from "bun:test";
import { dashboardAutoOpener } from "./guides-loader";

describe("opening the dashboard when the view is shown", () => {
  const run = (initiallyVisible: boolean, changes: boolean[]) => {
    let opens = 0;
    const on = dashboardAutoOpener(initiallyVisible, () => opens++);
    const at: number[] = [];
    for (const v of changes) {
      on(v);
      at.push(opens);
    }
    return at;
  };

  it("opens on the first click that shows the view", () => {
    expect(run(false, [true, false, true])).toEqual([1, 1, 1]);
  });

  it("does not open for a view VS Code restored at startup, but does on a later click", () => {
    expect(run(true, [true, false, true, false, true])).toEqual([0, 0, 1, 1, 1]);
  });

  it("ignores repeated visible events without a hide between them", () => {
    expect(run(false, [false, false, true, true])).toEqual([0, 0, 1, 1]);
  });
});
