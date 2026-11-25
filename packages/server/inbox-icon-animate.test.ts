/**
 * "Animate it" for any icon an agent shows (inbox-icon-animate.ts): its own picture, a set's icon or one of our faces.
 * The route on a temp folder, called directly: no Inbox is started.
 *
 * What this catches: a request about a set icon or one of our faces refused, or one about an icon that cannot be shown
 * here (no such set icon, the agent's own mark, Transparent) kept; a hand-back that replaces an agent no longer showing
 * the icon asked about; the way back naming something other than the face it replaced; a set icon's request keeping a
 * made-up upload from the pictures' cap. Projects: a project's hand-back not becoming its picture, landing after the
 * person changed the picture, skipping the picture's checks, or the windows not told; a request about a project this
 * Inbox does not have kept; a request this Inbox does not keep not asked of the linked machines, or asked again when a
 * linked machine handed it here.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxAgentFacesFile } from "@plannotator/shared/inbox/agent-faces";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { createAgentIcons } from "./inbox-agent-icons";
import { createInboxIconAnimate } from "./inbox-icon-animate";
import { createProjectPictures } from "./inbox-project-pictures";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const svg = (fill: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="24" fill="${fill}"/></svg>`;
const dataUrl = (text: string) => `data:image/svg+xml;base64,${Buffer.from(text).toString("base64")}`;
const PROJECT = "prj_01JZ00000000000000000000P1";
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

function world() {
  const root = mkdtempSync(join(tmpdir(), "pn-icon-animate-"));
  roots.push(root);
  const inboxDir = join(root, "inbox");
  const icons = createAgentIcons({ dir: join(inboxDir, "agent-icons") });
  const faces = createInboxAgentFacesFile(inboxDir, () => {});
  const pictures = createProjectPictures({ dir: join(root, "project-pictures"), env: {} });
  const changes: string[] = [];
  const farAsked: string[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const animate = createInboxIconAnimate({
    inboxDir,
    icons,
    faces,
    serverSession: "srv",
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json,
    touch: () => {},
    setIconKept: async (set, icon) => set === "dcss" && icon === "orc",
    projects: {
      has: (projectId) => projectId === PROJECT,
      uploadedAt: (projectId) => pictures.uploadedAt(projectId),
      setUpload: (projectId, bytes) => pictures.setUpload(projectId, bytes),
      changed: () => void changes.push("project"),
    },
    far: async (handBack) => {
      farAsked.push(handBack.request);
      return null;
    },
  });
  const call = async (method: "GET" | "POST", body?: Record<string, unknown>) => {
    const url = new URL("http://127.0.0.1/api/inbox/icon-animate");
    try {
      const res = await animate.route(new Request(url, { method, ...(body ? { body: JSON.stringify(body) } : {}) }), url);
      return { status: res!.status, body: (await res!.json()) as Record<string, unknown> };
    } catch (err) {
      if (err instanceof InboxError) return { status: 400, body: { code: err.code } };
      throw err;
    }
  };
  const ask = (icon: string, agent = "agent-a") => call("POST", { animate: { icon, agent, sessions: [] } });
  const show = (agent: string, face: string) => faces.change({ agent, sessions: [], face } as never);
  const faceOf = (agent: string) => faces.wire().faces[agent]?.face;
  return { call, ask, show, faceOf, animate, icons, pictures, changes, farAsked };
}

test("a set's icon and one of our faces can be animated; the hand-back replaces only the agent asked about, and the way back names the face", async () => {
  const w = world();
  w.show("agent-a", "set:dcss/orc");
  w.show("agent-b", "set:dcss/orc");
  const asked = await w.ask("set:dcss/orc");
  expect(asked.status).toBe(200);
  const animated = svg("#16a34a");
  const back = await w.call("POST", { request: asked.body.request, picture: dataUrl(animated) });
  expect(back.body).toMatchObject({ applied: true, icon: hash(animated) });
  expect(w.faceOf("agent-a")).toBe(`own:${hash(animated)}`);
  // Another agent showing the same set icon is not the one asked about.
  expect(w.faceOf("agent-b")).toBe("set:dcss/orc");
  expect((await w.call("GET")).body.results).toEqual([{ icon: "set:dcss/orc", result: hash(animated) }]);
  // A request names no upload for a set icon: only the result is kept from the cap.
  expect([...w.animate.kept()]).toEqual([`own:${hash(animated)}`]);

  // One of our faces: the same, and not after the person moved on.
  w.show("agent-c", "glass-red");
  const ours = await w.ask("glass-red", "agent-c");
  expect(ours.status).toBe(200);
  w.show("agent-c", "totman");
  const late = await w.call("POST", { request: ours.body.request, picture: dataUrl(svg("#dc2626")) });
  expect(late.body.applied).toBe(false);
  expect(w.faceOf("agent-c")).toBe("totman");
});

test("a request about an icon that cannot be shown here is refused and kept nowhere", async () => {
  const w = world();
  const own = w.icons.add(new TextEncoder().encode(svg("#f97316")));
  if (!own.ok) throw new Error("upload refused");
  for (const icon of ["set:dcss/dragon", "set:../x", "agent", "transparent", "a".repeat(64), "own:" + own.icon.id, ""]) {
    expect({ icon, status: (await w.ask(icon)).status }).toEqual({ icon, status: 400 });
  }
  expect((await w.call("GET")).body.results).toEqual([]);
  // An uploaded picture still works as before, and its request keeps it from the cap.
  expect((await w.ask(own.icon.id)).status).toBe(200);
  expect([...w.animate.kept()]).toEqual([`own:${own.icon.id}`]);
});

test("a project's animation becomes its picture through Set picture's checks, until the person changes the picture", async () => {
  const w = world();
  const animated = svg("#9333ea");
  const asked = await w.call("POST", { animate: { icon: "totman", project: PROJECT } });
  expect(asked.status).toBe(200);
  const back = await w.call("POST", { request: asked.body.request, picture: dataUrl(animated) });
  expect(back.body).toMatchObject({ applied: true, icon: hash(animated), target: "project" });
  const kept = await w.pictures.get({ id: PROJECT, root: "/nowhere" }, { logo: false, github: false, repo: () => null });
  expect(new TextDecoder().decode(kept!.body)).toBe(animated);
  // The windows read the projects again, and the picture joins "Your own…".
  expect(w.changes).toEqual(["project"]);
  expect(w.icons.read(hash(animated), true)).toBeTruthy();
  // Again in the same thread: still this request's picture showing, so the better one lands.
  const better = svg("#7e22ce");
  expect((await w.call("POST", { request: asked.body.request, picture: dataUrl(better) })).body.applied).toBe(true);

  // Animate it again on a set icon for the project, then the person sets another picture before the agent is done.
  const animate = await w.call("POST", { animate: { icon: "set:dcss/orc", project: PROJECT } });
  expect(animate.status).toBe(200);
  w.pictures.setUpload(PROJECT, new TextEncoder().encode(svg("#000000")));
  const late = await w.call("POST", { request: animate.body.request, picture: dataUrl(svg("#facc15")) });
  expect(late.body).toMatchObject({ applied: false, target: "project" });
  const after = await w.pictures.get({ id: PROJECT, root: "/nowhere" }, { logo: false, github: false, repo: () => null });
  expect(new TextDecoder().decode(after!.body)).toBe(svg("#000000"));

  // A page dressed as an SVG changes nothing.
  const page = await w.call("POST", { request: asked.body.request, picture: `data:image/svg+xml;base64,${Buffer.from("<html><script>1</script></html>").toString("base64")}` });
  expect(page.status).toBe(400);
});

test("a request about a project this Inbox does not have is refused; a request it does not keep is asked of the linked machines, once", async () => {
  const w = world();
  expect((await w.call("POST", { animate: { icon: "set:dcss/orc", project: "prj_01JZ00000000000000000000X9" } })).body.code).toBe("project_not_found");
  const id = `ia_${"ab".repeat(12)}`;
  expect((await w.call("POST", { request: id, picture: dataUrl(svg("#111111")) })).body.code).toBe("no_request");
  expect(w.farAsked).toEqual([id]);
  // Handed here by a linked machine that does not keep it either: never asked back.
  expect((await w.call("POST", { request: id, picture: dataUrl(svg("#111111")), relayed: true })).body.code).toBe("no_request");
  expect(w.farAsked).toEqual([id]);
});
