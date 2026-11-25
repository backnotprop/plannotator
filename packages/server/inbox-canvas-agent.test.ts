/**
 * `plannotator inbox canvas` on the Inbox's side (inbox-canvas-agent.ts), against the real canvas module on a
 * stand-in store in a temp folder: no Inbox runs. What regresses: the route answering while the canvas is off, to a
 * device door or another site's page; an ask of the wrong shape reaching the canvas; the session not being
 * remembered (so a change on what the person just changed lands unseen); a paired agent naming someone else.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitCanvas, readCanvasScene } from "@plannotator/shared/inbox/canvas/store";
import { INBOX_AGENT_ROUTE } from "@plannotator/shared/inbox/agent-pairing";
import { createInboxCanvas } from "./inbox-canvas";
import { canvasAgentRoute, INBOX_CANVAS_AGENT_ROUTE } from "./inbox-canvas-agent";
import { inboxAgentRouteAction } from "./inbox-agent-routes";

const THREAD = "msg_T1";

function world() {
  const dir = mkdtempSync(join(tmpdir(), "canvas-agent-route-"));
  const store = { dir, message: (id: string) => (id === THREAD ? { thread_id: THREAD } : null), onDeletion: () => () => {} } as never;
  const canvas = createInboxCanvas({
    store,
    serverSession: "srv",
    json: (data, status) => new Response(JSON.stringify(data), { status: status ?? 200 }),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    sessionMismatch: () => null,
  });
  let on = true;
  const ask = async (body: unknown, init: { origin?: string; door?: boolean } = {}) => {
    const req = new Request(`http://127.0.0.1${INBOX_CANVAS_AGENT_ROUTE}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Host: "127.0.0.1", ...(init.origin ? { Origin: init.origin } : {}) },
      body: JSON.stringify(body),
    });
    const answer = (await canvasAgentRoute(req, new URL(req.url), { canvas, on: () => on, readBody: async (r) => (await r.json()) as Record<string, unknown>, fromDeviceDoor: init.door ?? false }))!;
    return { status: answer.status, body: (await answer.json()) as Record<string, unknown> };
  };
  return { dir, ask, setOn: (value: boolean) => (on = value) };
}

const by = { host: "claude-code", session: "sess-1", name: "Claude Code" };

describe("the canvas command's route", () => {
  test("off: canvas_off, and nothing is read or written", async () => {
    const w = world();
    w.setOn(false);
    const answer = await w.ask({ thread_id: THREAD, base: 0, do: [{ add: "box", text: "Ledger" }], by });
    expect(answer.status).toBe(409);
    expect(answer.body.code).toBe("canvas_off");
    expect(existsSync(join(w.dir, "canvas", THREAD))).toBe(false);
  });

  test("not this computer's agent: a device door finds nothing, another site's page is refused", async () => {
    const w = world();
    expect((await w.ask({ thread_id: THREAD, by }, { door: true })).status).toBe(404);
    expect((await w.ask({ thread_id: THREAD, by }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect(existsSync(join(w.dir, "canvas", THREAD))).toBe(false);
  });

  test("an ask of the wrong shape is refused before the canvas is read, naming the field", async () => {
    const w = world();
    for (const [body, field] of [
      [{ thread_id: THREAD, agent_session: "x" }, "agent_session"],
      [{ base: 0 }, "thread_id"],
      [{ thread_id: THREAD, base: 0, do: { add: "box" } }, "do"],
      [{ thread_id: THREAD, base: "4", do: [] }, "base"],
      [{ thread_id: THREAD, picture: 3 }, "picture"],
    ] as const) {
      const answer = await w.ask(body);
      expect([field, answer.status]).toEqual([field, 422]);
      expect(String(answer.body.error).startsWith(`${field}:`)).toBe(true);
    }
    expect((await w.ask({ thread_id: "msg_NOPE" })).body.code).toBe("thread_not_found");
  });

  test("on: a read, a change on its rev, and a change on what the person changed since is refused whole, with their change shown", async () => {
    const w = world();
    const empty = await w.ask({ thread_id: THREAD, by });
    expect(empty.status).toBe(200);
    expect(empty.body.rev).toBe(0);
    const made = await w.ask({ thread_id: THREAD, base: 0, do: [{ add: "box", text: "Ledger", at: [0, 0] }, { add: "box", text: "Mailer", at: [400, 0] }], by });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ thread_id: THREAD, rev: 1, changed: true });
    // The person renames Ledger.
    const scene = readCanvasScene(w.dir, THREAD);
    for (const el of scene.elements) if (el.type === "text" && el.text === "Ledger") Object.assign(el, { text: "Ledger v2", originalText: "Ledger v2", version: (el.version ?? 1) + 1, versionNonce: 7 });
    const rev = commitCanvas(w.dir, THREAD, scene, { kind: "person" }, new Date()).rev;
    const clash = await w.ask({ thread_id: THREAD, base: rev, do: [{ set: "Ledger v2", text: "Ledger (agent)" }, { set: "Mailer", text: "Mailer (agent)" }], by });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("canvas_unchanged");
    expect(String(clash.body.error)).toContain("Ledger v2");
    const texts = readCanvasScene(w.dir, THREAD).elements.filter((e) => e.type === "text" && !e.isDeleted).map((e) => e.text);
    expect(texts).toEqual(expect.arrayContaining(["Ledger v2", "Mailer"]));
    // Shown now, the same change goes through.
    expect((await w.ask({ thread_id: THREAD, base: rev, do: [{ set: "Ledger v2", text: "Ledger (agent)" }], by })).status).toBe(200);
  });

  test("a paired agent's ask through the agent door: only the command's fields, and the door names who asks", async () => {
    let seen: Record<string, unknown> | null = null;
    const handle = async (req: Request) => {
      seen = (await req.json()) as Record<string, unknown>;
      return Response.json({ text: "ok", rev: 0 });
    };
    const door = { host: "codex", session: "paired-1", name: "Codex" };
    const routeOf = (body: Record<string, unknown>) => inboxAgentRouteAction(handle, door, INBOX_AGENT_ROUTE, { method: "POST", path: INBOX_CANVAS_AGENT_ROUTE, body });
    await routeOf({ thread_id: THREAD });
    expect(seen).toEqual({ thread_id: THREAD, by: { ...door, away: true } });
    await expect(routeOf({ thread_id: THREAD, by: { session: "someone-else" } })).rejects.toThrow(/by: not taken here/);
  });

  test("a paired agent's picture: no path on the person's computer, said plainly, with the canvas as text", async () => {
    const w = world();
    await w.ask({ thread_id: THREAD, base: 0, do: [{ add: "box", text: "Ledger" }], by });
    const answer = await w.ask({ thread_id: THREAD, picture: true, by: { ...by, away: true } });
    expect(answer.status).toBe(200);
    const body = answer.body as { text: string; picture: unknown };
    expect(body.picture).toBeNull();
    expect(body.text).toMatch(/^No picture: /);
    expect(body.text).toContain("Ledger");
    expect(body.text).not.toMatch(/\.png/);
  });
});
