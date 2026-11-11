/** Uploaded agent icon pictures and their stills, through the Inbox's real door (temp data dir and HOME, loopback; nothing real is asked). */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_AGENT_ICONS_KEPT, isInboxAgentFace, readInboxAgentFaces, type InboxAgentFacesWire } from "@plannotator/core/inbox-types";
import { createInboxAgentFacesFile, INBOX_AGENT_FACES_FILE } from "@plannotator/shared/inbox/agent-faces";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { startInboxServer, type InboxServer } from "./inbox";
import { agentIconStill } from "./inbox-agent-icon-still";
import { createAgentIcons } from "./inbox-agent-icons";

const FIXTURES = join(import.meta.dir, "fixtures", "agent-icons");
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const PNG = fixture("still.png");
const dataUrl = (bytes: Uint8Array, type: string) => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
const text = (value: string) => new TextEncoder().encode(value);
const ICO = new Uint8Array([0, 0, 1, 0, ...new Array(30).fill(7)]);

const ENV_KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TAILSCALE", "PLANNOTATOR_BROWSER", "HOME"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const roots: string[] = [];
const servers: InboxServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const scratch = (prefix: string) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
};

function scriptedTailscale(magic: string, owner: string): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${magic}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: owner } } }));
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      return ok(
        JSON.stringify({
          TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])),
          Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${magic}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
        }),
      );
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return ok(`https://${magic}:${httpsPort}/\n`);
  };
}

async function world(config: Record<string, unknown> = {}, tailscale?: { magic: string; owner: string }) {
  const root = scratch("plannotator-inbox-agent-icons-");
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.HOME = home;
  process.env.PLANNOTATOR_BROWSER = NO_BROWSER;
  delete process.env.PLANNOTATOR_INBOX_TAILSCALE;
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, ...(tailscale ? { tailscale: scriptedTailscale(tailscale.magic, tailscale.owner) } : {}) });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const post = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/inbox/agent-icons`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const get = (id: string, query = "", headers: Record<string, string> = {}) => fetch(`${base}/api/inbox/agent-icons/${id}${query}`, { headers });
  const faces = async () => (await (await fetch(`${base}/api/inbox/agent-faces`)).json()) as InboxAgentFacesWire;
  const setFace = (agent: string, face: string) =>
    fetch(`${base}/api/inbox/agent-faces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agent, face }) });
  return { server, dataDir, base, post, get, faces, setFace };
}

const errorOf = async (response: Response) => (await response.json()) as { error: string; code: string };
const iconOf = async (response: Response) => ((await response.json()) as { icon: { id: string; type: string } } & InboxAgentFacesWire);

describe("POST /api/inbox/agent-icons", () => {
  test("a picture is kept once by its hash, carried with the faces; refusals are Set picture…'s words", async () => {
    const w = await world();
    const added = await w.post({ picture: dataUrl(PNG, "image/png") });
    expect(added.status).toBe(200);
    const answer = await iconOf(added);
    const id = new Bun.CryptoHasher("sha256").update(PNG).digest("hex");
    expect(answer.icon).toMatchObject({ id, type: "image/png" });
    expect(answer.icons!.map((icon) => icon.id)).toEqual([id]);
    expect(readdirSync(join(w.dataDir, "inbox", "agent-icons"))).toEqual([`${id}.png`]);
    const again = await iconOf(await w.post({ picture: dataUrl(PNG, "application/octet-stream") }));
    expect(again.icon.id).toBe(id);
    expect(again.icons).toHaveLength(1);
    expect((await w.faces()).icons!.map((icon) => icon.id)).toEqual([id]);

    for (const big of [`data:image/jpeg;base64,${"A".repeat(900_000)}`, dataUrl(new Uint8Array(512 * 1024 + 1).fill(0x89), "image/png")]) {
      const refused = await w.post({ picture: big });
      expect(refused.status).toBe(422);
      expect((await errorOf(refused)).error).toBe("Picture: at most 512 KB.");
    }
    const atCap = new Uint8Array(512 * 1024);
    atCap.set(PNG);
    expect((await w.post({ picture: dataUrl(atCap, "image/png") })).status).toBe(200);
    for (const bad of [dataUrl(ICO, "image/x-icon"), dataUrl(text("<html><script>1</script></html>"), "image/png"), dataUrl(new Uint8Array(0), "image/png"), "hello", 42]) {
      const refused = await w.post({ picture: bad });
      expect(refused.status).toBe(422);
      expect((await errorOf(refused)).error).toBe("Picture: a PNG, JPEG, GIF, WebP or SVG image.");
    }
    expect((await w.faces()).icons).toHaveLength(2);
  });

  test("another site and another session's tab are refused, and nothing is kept", async () => {
    const w = await world();
    expect((await w.post({ picture: dataUrl(PNG, "image/png") }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await w.post({ picture: dataUrl(PNG, "image/png") }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await w.post({ picture: dataUrl(PNG, "image/png"), serverSession: "not-this-one" })).status).toBe(409);
    expect((await w.faces()).icons).toEqual([]);
  });

  test("removing a picture sends every agent showing it back to its own mark, in one save every window hears", async () => {
    const w = await world();
    const { icon } = await iconOf(await w.post({ picture: dataUrl(PNG, "image/png") }));
    const other = (await iconOf(await w.post({ picture: dataUrl(fixture("still.gif"), "image/gif") }))).icon;
    await w.setFace("ses_a", `own:${icon.id}`);
    await w.setFace("ses_b", `own:${icon.id}`);
    await w.setFace("ses_c", `own:${other.id}`);
    const before = (await w.faces()).rev;
    const removed = (await (await w.post({ remove: icon.id })).json()) as InboxAgentFacesWire;
    expect(removed.rev).toBe(before + 1);
    expect(Object.keys(removed.faces)).toEqual(["ses_c"]);
    expect(removed.icons!.map((kept) => kept.id)).toEqual([other.id]);
    expect((await w.get(icon.id)).status).toBe(404);
    const lone = (await (await w.post({ remove: other.id })).json()) as InboxAgentFacesWire;
    expect(lone.rev).toBe(before + 2);
    expect(lone.icons).toEqual([]);
    expect(readdirSync(join(w.dataDir, "inbox", "agent-icons"))).toEqual([]);
    expect((await w.post({ remove: "../agent-faces" })).status).toBe(422);
  });
});

describe("GET /api/inbox/agent-icons/:hash", () => {
  test("served from the Inbox's origin with Set picture…'s sandbox headers; a hostile SVG comes back as uploaded, as an attachment", async () => {
    const w = await world();
    const hostile = text(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10" onload="fetch(\'http://127.0.0.1:9/onload\')">' +
        "<script>fetch('http://127.0.0.1:9/script')</script>" +
        '<image href="http://127.0.0.1:9/external.png" width="10" height="10"/>' +
        '<foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml"><img src="http://127.0.0.1:9/fo.png"/></div></foreignObject>' +
        '<rect width="10" height="10" fill="teal"/></svg>',
    );
    const { icon } = await iconOf(await w.post({ picture: dataUrl(hostile, "image/svg+xml") }));
    const served = await w.get(icon.id);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/svg+xml");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(served.headers.get("content-security-policy")).toContain("sandbox");
    expect(served.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(served.headers.get("content-disposition")).toBe("attachment");
    expect(served.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(hostile);
    expect(new Uint8Array(await (await w.get(icon.id, "?still=1")).arrayBuffer())).toEqual(hostile);

    expect((await w.get(icon.id, "", { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await w.get("0".repeat(64))).status).toBe(404);
    expect((await w.get("..%2Fagent-faces.json")).status).toBe(404);
  });

  test("over the tailnet: the owner's window reads and adds pictures, a guest's does neither", async () => {
    const MAGIC = "macbook-pro.tail0000.ts.net";
    const OWNER = "ramos@example.com";
    const GUEST = "guest@example.com";
    const w = await world({ inboxTailscale: true, inboxTailscaleAllow: [GUEST] }, { magic: MAGIC, owner: OWNER });
    const listener = w.server.tailscale.listenerPort();
    expect(listener).not.toBeNull();
    const headers = (login: string) => ({ Host: `${MAGIC}:${w.server.port}`, "Tailscale-User-Login": login, Origin: `https://${MAGIC}:${w.server.port}`, "Content-Type": "application/json" });
    const at = (path: string) => `http://127.0.0.1:${listener}${path}`;
    const body = JSON.stringify({ picture: dataUrl(PNG, "image/png") });

    const guestAdd = await fetch(at("/api/inbox/agent-icons"), { method: "POST", headers: headers(GUEST), body });
    expect(guestAdd.status).toBe(403);
    const ownerAdd = await fetch(at("/api/inbox/agent-icons"), { method: "POST", headers: headers(OWNER), body });
    expect(ownerAdd.status).toBe(200);
    const { icon } = await iconOf(ownerAdd);
    const read = (login: string) => fetch(at(`/api/inbox/agent-icons/${icon.id}`), { headers: { ...headers(login), "Sec-Fetch-Site": "same-origin" } });
    expect((await read(GUEST)).status).toBe(403);
    expect((await read(OWNER)).status).toBe(200);
  });
});

describe("stills: a picture that moves shows its first frame outside the sidebar", () => {
  test("GIF, APNG and animated WebP: the first frame alone, the same type; a picture that never moved has none", () => {
    const gif = agentIconStill("image/gif", fixture("anim.gif"))!;
    expect(gif).not.toBeNull();
    const frames = (bytes: Uint8Array) => {
      let count = 0;
      let at = 13 + (bytes[10]! & 0x80 ? 3 * (1 << ((bytes[10]! & 7) + 1)) : 0);
      while (at < bytes.length && bytes[at] !== 0x3b) {
        if (bytes[at] === 0x21) at += 2;
        else {
          count++;
          at += 10 + (bytes[at + 9]! & 0x80 ? 3 * (1 << ((bytes[at + 9]! & 7) + 1)) : 0) + 1;
        }
        while (bytes[at]! !== 0) at += bytes[at]! + 1;
        at++;
      }
      return count;
    };
    expect(frames(fixture("anim.gif"))).toBe(2);
    expect(frames(gif)).toBe(1);
    expect(new TextDecoder().decode(gif)).not.toContain("NETSCAPE2.0");

    const png = agentIconStill("image/png", fixture("anim.png"))!;
    const chunks = (bytes: Uint8Array) => {
      const out: string[] = [];
      for (let at = 8; at + 8 <= bytes.length; ) {
        const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
        out.push(new TextDecoder().decode(bytes.subarray(at + 4, at + 8)));
        at += 12 + length;
      }
      return out;
    };
    expect(chunks(fixture("anim.png"))).toContain("acTL");
    expect(chunks(png)).not.toContain("acTL");
    expect(chunks(png)).not.toContain("fdAT");
    expect(chunks(png)).toContain("IDAT");

    const webp = agentIconStill("image/webp", fixture("anim.webp"))!;
    const riff = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    expect(riff(webp).startsWith("RIFF")).toBe(true);
    expect(new DataView(webp.buffer).getUint32(4, true)).toBe(webp.length - 8);
    expect(riff(webp)).not.toContain("ANIM");
    expect(riff(webp)).not.toContain("ANMF");
    expect(webp[20]! & 0x02).toBe(0);
    expect(riff(webp)).toMatch(/VP8L|VP8 /);

    for (const [type, name] of [["image/png", "still.png"], ["image/gif", "still.gif"], ["image/webp", "still.webp"]] as const) expect(agentIconStill(type, fixture(name))).toBeNull();
    expect(agentIconStill("image/svg+xml", text('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'))).toBeNull();
  });

  test("SVG: CSS animation off and SMIL taken out; the rest of the drawing kept", () => {
    const moving = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>@keyframes s{to{transform:rotate(1turn)}} g{animation:s 2s infinite}</style><g><rect width="4" height="4"><animate attributeName="x" from="0" to="6" dur="1s" repeatCount="indefinite"/></rect><circle r="1"><animateTransform attributeName="transform" type="scale" values="1;2" dur="1s"></animateTransform><set attributeName="fill" to="red" begin="1s"/></circle></g></svg>';
    const still = new TextDecoder().decode(agentIconStill("image/svg+xml", text(moving))!);
    expect(still).toContain("animation:none!important");
    expect(still).not.toMatch(/<animate|<set\b/);
    expect(still).toContain('<rect width="4" height="4"></rect>');
    expect(still).toContain('<circle r="1"></circle>');
  });

  test("served: a moving picture's still at ?still=1, the picture itself without", async () => {
    const w = await world();
    const { icon } = await iconOf(await w.post({ picture: dataUrl(fixture("anim.gif"), "image/gif") }));
    expect(new Uint8Array(await (await w.get(icon.id)).arrayBuffer())).toEqual(fixture("anim.gif"));
    const still = await w.get(icon.id, "?still=1");
    expect(still.headers.get("content-type")).toBe("image/gif");
    expect(new Uint8Array(await still.arrayBuffer())).toEqual(agentIconStill("image/gif", fixture("anim.gif"))!);
  });
});

describe("the faces file with uploaded pictures", () => {
  test("an `own:` face round-trips at v: 1; an older reader skips it and keeps the rest", () => {
    const dir = join(scratch("pn-agent-icon-faces-"), "inbox");
    const id = "a".repeat(64);
    const faces = createInboxAgentFacesFile(dir, () => {});
    faces.change({ agent: "ses_own", face: `own:${id}` });
    faces.change({ agent: "ses_glass", face: "glass-blue" });
    const raw = JSON.parse(readFileSync(join(dir, INBOX_AGENT_FACES_FILE), "utf8"));
    expect(raw.v).toBe(1);
    expect(createInboxAgentFacesFile(dir, () => {}).wire().faces.ses_own).toEqual({ face: `own:${id}`, sessions: [] });
    for (const bad of ["own:", `own:${"A".repeat(64)}`, `own:${id}0`, "own:../x"]) expect(isInboxAgentFace(bad)).toBe(false);
    expect(readInboxAgentFaces({ x: { face: "own:nothex", sessions: [] } })).toEqual({});

    const RELEASED = ["agent", "glass", "glass-red", "glass-orange", "yellow", "glass-green", "glass-teal", "glass-blue", "glass-purple", "glass-pink", "glass-ice", "transparent", "totman"];
    const releasedRead = (file: { v?: unknown; faces?: unknown }) => {
      if (typeof file.v === "number" && file.v > 1) return "newer";
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(file.faces as Record<string, { face: string }>)) if (RELEASED.includes(entry.face) && entry.face !== "agent") out[key] = entry;
      return out;
    };
    expect(releasedRead(raw)).toEqual({ ses_glass: { face: "glass-blue", sessions: [] } });
  });

  test("past the cap the oldest picture no agent shows goes; one an agent shows stays", () => {
    let clock = 1_000;
    const dir = join(scratch("pn-agent-icon-cap-"), "icons");
    const icons = createAgentIcons({ dir, now: () => (clock += 1000) });
    const ids: string[] = [];
    for (let i = 0; i <= INBOX_AGENT_ICONS_KEPT; i++) {
      const svg = text(`<svg xmlns="http://www.w3.org/2000/svg"><text>${i}</text></svg>`);
      const added = icons.add(svg);
      if (!added.ok) throw new Error(added.reason);
      ids.push(added.icon.id);
    }
    icons.prune(new Set([`own:${ids[0]}`]));
    const kept = icons.list().map((icon) => icon.id);
    expect(kept).toHaveLength(INBOX_AGENT_ICONS_KEPT);
    expect(kept).toContain(ids[0]!);
    expect(kept).not.toContain(ids[1]!);
    expect(createAgentIcons({ dir }).list().map((icon) => icon.id)).toEqual(kept);
  });
});
