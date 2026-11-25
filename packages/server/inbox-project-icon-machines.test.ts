/**
 * A project's picture across linked machines, on two real Inboxes linked both ways (docs/agent-guides/inbox-machines.md:
 * every Inbox feature works on a linked machine's project as on this one's). The picture lives on the project's own
 * machine: a window sets it through the forward and that machine's door, and a request to animate it is kept
 * there; an agent on either computer hands the picture back to its own Inbox, which asks the other for a request it
 * does not keep. Starts two Inboxes: CI runs it.
 *
 * What this catches: a picture set from the other computer's window refused at the forward or the door, or kept on
 * the wrong computer; the other computer's list not hearing the change; an animate request about a linked machine's
 * project refused or kept here; a hand-back from the other computer's agent lost (`no_request`) or applied to the wrong
 * computer; an agent's or a script's bare call setting a linked machine's picture; either direction working without
 * the other.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer } from "./inbox";
import { waitFor } from "../../tests/helpers/inbox-world";

type Json = Record<string, any>;

/** No real tailscale ever runs: the loopback transport is the test sandbox's, and serve holds nothing. */
const tailscale: TailscaleRunner = (args) => ({ status: 0, stdout: args[1] === "status" ? "{}" : "", stderr: "" });

const svg = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="${fill}"/></svg>`;
const dataUrl = (text: string) => `data:image/svg+xml;base64,${Buffer.from(text).toString("base64")}`;

describe("a project's picture across linked machines", () => {
  const dirs: string[] = [];
  const sandboxWas = process.env.PLANNOTATOR_TEST_SANDBOX;
  beforeAll(() => {
    process.env.PLANNOTATOR_TEST_SANDBOX = "1";
  });
  afterAll(() => {
    if (sandboxWas === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
    else process.env.PLANNOTATOR_TEST_SANDBOX = sandboxWas;
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = (prefix: string) => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    dirs.push(dir);
    return dir;
  };
  const start = (dataDir: string) => startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale, readProjectRepo: async () => null });
  const at = (port: number) => `http://127.0.0.1:${port}`;
  const get = async (port: number, path: string) => (await (await fetch(`${at(port)}${path}`)).json()) as Json;
  let keys = 0;
  /** A press in this Inbox's window (its own Origin and page session), keyed as the window keys a write to another machine. */
  const press = async (port: number, path: string, body: Json) => {
    const health = await get(port, "/api/inbox/health");
    const res = await fetch(`${at(port)}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: at(port) },
      body: JSON.stringify({ serverSession: health.serverSession, idempotency_key: `window-picture-${++keys}`, ...body }),
    });
    return { status: res.status, body: (await res.json()) as Json };
  };
  /** An agent's `plannotator inbox icon set` on that computer: a bare call to its own Inbox. */
  const handBack = async (port: number, request: string, picture: string) => {
    const res = await fetch(`${at(port)}/api/inbox/icon-animate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ request, picture }) });
    return { status: res.status, body: (await res.json()) as Json };
  };
  const pictureOf = async (port: number, project: string) => {
    const res = await fetch(`${at(port)}/api/inbox/projects/${project}/picture`);
    return res.status === 200 ? await res.text() : null;
  };
  /** The picture key a window learns from the merged list for a project. */
  const keyOn = async (port: number, project: string) => ((await get(port, "/api/inbox/threads?machines=1")).projects as Json[] | undefined)?.find((p) => p.id === project)?.picture ?? null;

  test("set and animated from either computer, kept on the project's own; a bare call is refused", async () => {
    const dataA = scratch("plannotator-project-icon-linked-a-");
    const dataB = scratch("plannotator-project-icon-linked-b-");
    const a = await start(dataA);
    const b = await start(dataB);
    try {
      const offered = (await (await fetch(`${at(b.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(a.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(b.port), back: at(a.port) }) });
      expect(linked.status).toBe(201);
      const bId = (JSON.parse(readFileSync(join(dataA, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;
      const aId = (JSON.parse(readFileSync(join(dataB, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;
      await waitFor("A sees B online", async () => ((await get(a.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === bId)?.state === "online", 15_000);
      await waitFor("B sees A online", async () => ((await get(b.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === aId)?.state === "online", 15_000);

      const onB = b.store.ensureProject({ name: "macbook-site", root: "/work/macbook-site" });
      const onA = a.store.ensureProject({ name: "studio-api", root: "/work/studio-api" });

      // A's window sets B's project's picture: kept on B, not on A, and A's list hears it.
      const blue = svg("#2563eb");
      expect((await press(a.port, `/api/inbox/m/${bId}/projects/${onB.id}/picture`, { picture: dataUrl(blue) })).status).toBe(200);
      expect(await pictureOf(b.port, onB.id)).toBe(blue);
      expect(await pictureOf(a.port, `${onB.id}`)).toBeNull();
      await waitFor("B's picture key on A", async () => typeof (await keyOn(a.port, onB.id)) === "number", 15_000);

      // A bare call (an agent's, a script's) through A's forward never sets B's picture.
      const bare = await fetch(`${at(a.port)}/api/inbox/m/${bId}/projects/${onB.id}/picture`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ picture: dataUrl(svg("#000000")), idempotency_key: "bare-1" }) });
      expect(bare.status).toBe(403);
      expect(await pictureOf(b.port, onB.id)).toBe(blue);

      // Animate it, from A's window, about B's project: the request is kept on B.
      const asked = await press(a.port, `/api/inbox/m/${bId}/icon-animate`, { animate: { icon: "totman", project: onB.id } });
      expect(asked.status).toBe(200);
      expect(readFileSync(join(dataB, "inbox", "icon-animate.json"), "utf8")).toContain(asked.body.request);
      // The agent the person picked runs on A: its hand-back reaches A, which asks B.
      const animatedOnA = svg("#16a34a");
      const back = await handBack(a.port, asked.body.request, dataUrl(animatedOnA));
      expect(back).toMatchObject({ status: 200, body: { applied: true, target: "project" } });
      expect(await pictureOf(b.port, onB.id)).toBe(animatedOnA);

      // And the other way: B's window asks about A's project; an agent on B hands it back to B, which asks A.
      const other = await press(b.port, `/api/inbox/m/${aId}/icon-animate`, { animate: { icon: "totman", project: onA.id } });
      expect(other.status).toBe(200);
      const animatedOnB = svg("#dc2626");
      expect((await handBack(b.port, other.body.request, dataUrl(animatedOnB))).body).toMatchObject({ applied: true, target: "project" });
      expect(await pictureOf(a.port, onA.id)).toBe(animatedOnB);
      await waitFor("A's picture key on B", async () => typeof (await keyOn(b.port, onA.id)) === "number", 15_000);

      // Remove picture from B's window on A's project: gone on A.
      expect((await press(b.port, `/api/inbox/m/${aId}/projects/${onA.id}/picture`, { picture: null })).status).toBe(200);
      expect(await pictureOf(a.port, onA.id)).toBeNull();

      // A made-up request is no computer's.
      expect((await handBack(a.port, `ia_${"cd".repeat(12)}`, dataUrl(svg("#111111")))).body.code).toBe("no_request");
    } finally {
      a.stop();
      b.stop();
    }
  }, 120_000);
});
