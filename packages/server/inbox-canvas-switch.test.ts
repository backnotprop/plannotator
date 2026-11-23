/**
 * The canvas as a capability (Settings → Capabilities → Canvas, config.json `inboxCanvas`, off by default):
 * the switch's save, the agent's tool listed only while it is on, and an off Inbox that touches no stored canvas.
 * The routes' refusal and the tool call's refusal on a running Inbox: inbox-canvas-capability.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CANVAS_GONE_KEEP_MS } from "@plannotator/shared/inbox/canvas/store";
import { createInboxCanvas } from "./inbox-canvas";
import { canvasSwitch } from "./inbox-canvas-switch";
import { createInboxMcpServer, INBOX_DEFAULT_SERVED_TOOLS, INBOX_SERVED_TOOLS, inboxServedTools, type InboxMcpContext } from "./inbox-mcp";

function canvasIn(dir: string, on: () => boolean) {
  let deleted: () => void = () => {};
  const store = { dir, message: () => null, onDeletion: (listener: () => void) => ((deleted = listener), () => {}) } as never;
  const canvas = createInboxCanvas({
    store,
    serverSession: "srv",
    json: (data, status) => new Response(JSON.stringify(data), { status: status ?? 200 }),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    sessionMismatch: () => null,
    on,
  });
  return { canvas, deleted: () => deleted() };
}

describe("the canvas switch", () => {
  const harness = (start: boolean | undefined, fixed?: boolean) => {
    let saved = start === true;
    let changes = 0;
    const sw = canvasSwitch({ saved: () => saved, fixed, save: (on) => (saved = on), changed: () => changes++ });
    return { sw, changes: () => changes, saved: () => saved };
  };

  test("off unless turned on; a save answers the switch and tells every window only when it changed", () => {
    const h = harness(undefined);
    expect(h.sw.on()).toBe(false);
    expect(h.sw.answer({})).toEqual({ canvas: { on: false } });
    expect(h.sw.answer({ canvas: { on: true } })).toEqual({ canvas: { on: true } });
    expect(h.saved()).toBe(true);
    expect(h.changes()).toBe(1);
    h.sw.answer({ canvas: { on: true } });
    expect(h.changes()).toBe(1);
    expect(h.sw.answer({ canvas: { on: false } })).toEqual({ canvas: { on: false } });
    expect(h.changes()).toBe(2);
  });

  test("anything but { on: boolean } is refused before anything is saved, naming the field", () => {
    const h = harness(false);
    for (const bad of [true, { on: "yes" }, { on: true, extra: 1 }, [], null]) {
      expect(() => h.sw.check({ canvas: bad })).toThrow(expect.objectContaining({ code: "validation_error", details: { field: "canvas" } }));
    }
    expect(h.saved()).toBe(false);
  });

  test("a save config.json did not keep is refused as not saved", () => {
    const sw = canvasSwitch({ saved: () => false, save: () => {}, changed: () => {} });
    expect(() => sw.answer({ canvas: { on: true } })).toThrow(expect.objectContaining({ code: "config_not_saved" }));
  });

  test("a test's fixed value decides over config.json", () => {
    expect(harness(false, true).sw.on()).toBe(true);
    expect(harness(true, false).sw.on()).toBe(false);
  });
});

describe("the agent's canvas tool, only while the canvas is on", () => {
  test("not served by default; with the switch on it is listed right after thread_pulls", () => {
    expect(INBOX_SERVED_TOOLS).not.toContain("canvas");
    expect(INBOX_DEFAULT_SERVED_TOOLS).not.toContain("canvas");
    expect(inboxServedTools({ board: false, steps: false })).not.toContain("canvas");
    const on = inboxServedTools({ board: false, steps: false, canvas: true });
    expect(on[on.indexOf("thread_pulls") + 1]).toBe("canvas");
    expect(on.filter((name) => name === "canvas")).toHaveLength(1);
  });

  test("a session made while it is off has no canvas tool; one made while it is on has it", () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-switch-"));
    const { canvas } = canvasIn(dir, () => true);
    const tools = (on: boolean) => Object.keys((createInboxMcpServer({ canvas, canvasOn: () => on } as unknown as InboxMcpContext) as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(tools(false)).not.toContain("canvas");
    expect(tools(true)).toContain("canvas");
  });
});

describe("an Inbox with the canvas off touches no stored canvas", () => {
  const seed = (dir: string) => {
    const root = join(dir, "canvas");
    mkdirSync(join(root, "msg_DELETED"), { recursive: true });
    const old = join(root, ".gone", `msg_OLD-${Date.now() - CANVAS_GONE_KEEP_MS - 1000}`);
    mkdirSync(old, { recursive: true });
    return { root, old };
  };

  test("off: a deleted thread's canvas stays where it is and an old deleted one is not swept, at start or on a deletion", () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-switch-off-"));
    const { root, old } = seed(dir);
    const { deleted } = canvasIn(dir, () => false);
    deleted();
    expect(existsSync(join(root, "msg_DELETED"))).toBe(true);
    expect(existsSync(old)).toBe(true);
  });

  test("on: the same start sweeps the old one, and a deletion moves the deleted thread's canvas aside", () => {
    const dir = mkdtempSync(join(tmpdir(), "canvas-switch-on-"));
    const { root, old } = seed(dir);
    const { deleted } = canvasIn(dir, () => true);
    expect(existsSync(old)).toBe(false);
    deleted();
    expect(existsSync(join(root, "msg_DELETED"))).toBe(false);
    expect(readdirSync(join(root, ".gone")).some((name) => name.startsWith("msg_DELETED-"))).toBe(true);
  });
});
