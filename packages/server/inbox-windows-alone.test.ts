/**
 * Which window `plannotator inbox --open <thread>` moves once windows can show one thread alone (Thread tabs,
 * inbox-windows.ts `lastUsed(thread)`): the thread's own tab first, then a main tab, never another thread's tab.
 */
import { expect, test } from "bun:test";
import { createInboxWindows, parseWindowAloneThread } from "./inbox-windows";

function setup() {
  let clock = 1_000;
  const windows = createInboxWindows({ now: () => clock });
  const open = (id: string, aloneThread: string | null = null, used = true) => {
    windows.connect(id, { permission: "default", origin: null, via: "local", aloneThread });
    clock += 10;
    windows.report(id, { permission: "default", origin: null, via: "local", used, aloneThread });
  };
  return { windows, open, tick: () => (clock += 10), at: () => clock };
}

test("a thread with a thread tab goes to that tab, even when a main tab was used later", () => {
  const { windows, open } = setup();
  open("w-thread-a01", "thr_a");
  open("w-main-0001");
  expect(windows.lastUsed("thr_a")).toBe("w-thread-a01");
  windows.stop();
});

test("the most recently used of two tabs of the same thread wins", () => {
  const { windows, open, tick } = setup();
  open("w-thread-a01", "thr_a");
  open("w-thread-a02", "thr_a");
  tick();
  windows.report("w-thread-a01", { permission: "default", origin: null, via: "local", used: true, aloneThread: "thr_a" });
  expect(windows.lastUsed("thr_a")).toBe("w-thread-a01");
  windows.stop();
});

test("a thread with no thread tab goes to the last used main tab, never to another thread's tab", () => {
  const { windows, open } = setup();
  open("w-main-0001");
  open("w-thread-b01", "thr_b");
  expect(windows.lastUsed("thr_a")).toBe("w-main-0001");
  windows.stop();
});

test("with only other threads' tabs open there is no window: the CLI opens one", () => {
  const { windows, open } = setup();
  open("w-thread-b01", "thr_b");
  expect(windows.lastUsed("thr_a")).toBeNull();
  windows.stop();
});

test("a page (plans) never goes to a thread tab", () => {
  const { windows, open } = setup();
  open("w-main-0001");
  open("w-thread-a01", "thr_a");
  expect(windows.lastUsed()).toBe("w-main-0001");
  windows.stop();
});

test("a thread tab that closed, or turned into a main tab, is not picked for its thread", () => {
  const { windows, open, tick } = setup();
  open("w-main-0001");
  open("w-thread-a01", "thr_a");
  windows.leave("w-thread-a01");
  expect(windows.lastUsed("thr_a")).toBe("w-main-0001");
  tick();
  windows.report("w-thread-a01", { permission: "default", origin: null, via: "local", used: true, aloneThread: null });
  expect(windows.lastUsed("thr_a")).toBe("w-thread-a01");
  windows.stop();
});

test("a stream's URL names the thread only until the window reports; a tailnet thread tab is never picked", () => {
  const { windows, tick } = setup();
  windows.connect("w-thread-a01", { permission: "default", origin: null, via: "local", aloneThread: "thr_a" });
  expect(windows.lastUsed("thr_a")).toBe("w-thread-a01");
  tick();
  windows.report("w-thread-a01", { permission: "default", origin: null, via: "local", aloneThread: null });
  windows.connect("w-thread-a01", { permission: "default", origin: null, via: "local", aloneThread: "thr_a" });
  expect(windows.lastUsed("thr_a")).toBe("w-thread-a01");
  expect(windows.lastUsed("thr_a")).not.toBeNull();
  windows.connect("w-tailnet-01", { permission: "default", origin: null, via: "tailnet", aloneThread: "thr_t" });
  expect(windows.lastUsed("thr_t")).toBe("w-thread-a01");
  windows.stop();
});

test("the reported thread id is validated", () => {
  expect(parseWindowAloneThread("thr_abc123")).toBe("thr_abc123");
  expect(parseWindowAloneThread("")).toBeNull();
  expect(parseWindowAloneThread("a b")).toBeNull();
  expect(parseWindowAloneThread(7)).toBeNull();
});
