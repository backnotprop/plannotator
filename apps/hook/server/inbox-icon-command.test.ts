/**
 * "Animate it"'s hand-back: `plannotator inbox icon set <file> --request <id>` (inbox-icon-command.ts) against a real
 * Inbox (packages/server/inbox-icon-animate.ts) in a temp data dir and HOME, on loopback; nothing real is read.
 *
 * What this catches: the one door agents have to an icon opening wider than asked (a made-up request, another agent
 * showing the same picture, an agent the person moved on from since); a hand-back that skips the upload's checks (a
 * page dressed as an SVG, a file past the cap); the happy path not changing the icon every window reads, or losing the
 * way back to the original.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAgentFacesWire } from "@plannotator/core/inbox-types";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { startInboxServer, type InboxServer } from "@plannotator/server/inbox";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { runInboxIconCommand } from "./inbox-icon-command";

const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TAILSCALE", "PLANNOTATOR_BROWSER", "HOME"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const svg = (fill: string, extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><style>@keyframes b{50%{transform:translateY(-3px)}}g{animation:b 2s infinite}</style><g><circle cx="32" cy="32" r="24" fill="${fill}"/></g>${extra}</svg>`;
const dataUrl = (text: string) => `data:image/svg+xml;base64,${Buffer.from(text).toString("base64")}`;
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-icon-animate-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const work = join(root, "agent");
  for (const dir of [dataDir, home, work]) mkdirSync(dir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.HOME = home;
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
  delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
  writeFileSync(join(dataDir, "config.json"), "{}");
  const server: InboxServer = await startInboxServer({ dataDir, binaryPath: null, phones: false });
  cleanup.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  const post = async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/api/inbox/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await response.json()) as Record<string, unknown>;
  };
  const faces = async () => ((await (await fetch(`${base}/api/inbox/agent-faces`)).json()) as InboxAgentFacesWire).faces;
  const faceOf = async (agent: string) => (await faces())[agent]?.face;
  /** The person's picture, shown by two agents; "Animate it" pressed on the first. */
  const original = svg("#f97316");
  const icon = ((await post("agent-icons", { picture: dataUrl(original) })).icon as { id: string }).id;
  await post("agent-faces", { agent: "agent-a", face: `own:${icon}` });
  await post("agent-faces", { agent: "agent-b", face: `own:${icon}` });
  const request = (await post("icon-animate", { animate: { icon, agent: "agent-a", sessions: ["ses-a"] } })).request as string;
  /** The agent's side: its file in its own folder, then the command. */
  const handBack = async (name: string, contents: string | Uint8Array, id = request) => {
    writeFileSync(join(work, name), contents);
    let out = "";
    let err = "";
    const code = await runInboxIconCommand(["set", name, "--request", id], {
      json: false,
      cwd: work,
      ensureRunning: async () => ({ port: server.port }) as InboxRegistryEntry,
      out: (text) => void (out += text),
      err: (text) => void (err += text),
    });
    return { code, out, err };
  };
  const pictures = () => readdirSync(join(dataDir, "inbox", "agent-icons")).filter((f) => !f.includes(".still."));
  return { base, post, faceOf, icon, request, handBack, pictures };
}

test("the hand-back replaces only the icon it was asked about, and the original stays one click away", async () => {
  const w = await world();
  expect(w.request).toMatch(/^ia_[0-9a-f]{24}$/);
  const animated = svg("#f97316", '<circle cx="24" cy="28" r="3"/>');
  const done = await w.handBack("icon.svg", animated);
  expect(done).toEqual({ code: 0, out: "Done: the agent's icon is now your picture, in every Inbox window.\n", err: "" });
  expect(await w.faceOf("agent-a")).toBe(`own:${hash(animated)}`);
  // Another agent showing the same picture is not the one asked about.
  expect(await w.faceOf("agent-b")).toBe(`own:${w.icon}`);
  // The window's way back: the result names the original.
  const results = (await (await fetch(`${w.base}/api/inbox/icon-animate`)).json()) as { results: unknown[] };
  expect(results.results).toEqual([{ icon: w.icon, result: hash(animated) }]);
  expect(JSON.stringify(results)).not.toContain(w.request);
  // A better version, in the same thread: replaces the agent's own earlier result.
  const better = svg("#ea580c");
  expect((await w.handBack("icon-2.svg", better)).code).toBe(0);
  expect(await w.faceOf("agent-a")).toBe(`own:${hash(better)}`);
  // The person moved on (picked another picture): a later hand-back is kept but shown nowhere.
  await w.post("agent-faces", { agent: "agent-a", face: "transparent" });
  const late = await w.handBack("icon-3.svg", svg("#16a34a"));
  expect([late.code, late.out.startsWith("Kept with the person's pictures, but not shown")]).toEqual([0, true]);
  expect(await w.faceOf("agent-a")).toBe("transparent");
});

test("the door refuses a made-up request and anything the upload refuses, and changes nothing", async () => {
  const w = await world();
  const before = w.pictures();
  // A request id it was never given (the right shape, and not).
  for (const id of ["ia_000000000000000000000000", "own:" + w.icon, ""]) {
    const refused = await w.handBack("icon.svg", svg("#000"), id);
    expect(refused.code).not.toBe(0);
  }
  const unknown = await w.handBack("icon.svg", svg("#000"), "ia_000000000000000000000000");
  expect([unknown.code, unknown.err]).toEqual([1, "no_request: No such request. Use the request id from the Inbox message that asked you to animate the icon.\n"]);
  // A page dressed as an SVG, and a file past the cap: the upload's own words.
  const page = await w.handBack("icon.svg", '<!doctype html><html><script>fetch("/x")</script><svg></svg></html>');
  expect([page.code, page.err]).toEqual([1, "validation_error: Picture: a PNG, JPEG, GIF, WebP or SVG image.\n"]);
  const big = await w.handBack("big.svg", svg("#000", `<!--${"x".repeat(600 * 1024)}-->`));
  expect([big.code, big.err]).toEqual([1, "validation_error: Picture: at most 512 KB.\n"]);
  expect(w.pictures()).toEqual(before);
  expect(await w.faceOf("agent-a")).toBe(`own:${w.icon}`);
});
