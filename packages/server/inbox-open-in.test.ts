/**
 * "Open in" for Inbox attachments (packages/server/inbox-open-in.ts, the
 * page route in inbox-attachments.ts), proved against a real Inbox on
 * loopback with real `fetch`. No real app ever starts: the launch tests pass
 * a recording launcher (`openInLauncher`), and the one test of the real
 * launcher puts ONLY a scratch folder of stubs (`open`, `xdg-open`) on PATH
 * while it runs, so a launcher that is not a stub cannot be found. Every test
 * has its own temp data dir; Tailscale is a scripted runner, never the CLI.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenInApp, OpenInPlatform } from "@plannotator/core/open-in-apps";
import { recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { systemOpenInLauncher, type InboxOpenInLauncher } from "./inbox-open-in";
import type { AvailableOpenInApp } from "./open-in";

type Json = Record<string, any>;

const roots: string[] = [];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const restore of restoreEnv.splice(0)) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");

/** A project folder with one file of every kind the policy distinguishes. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-openin-")));
  roots.push(root);
  const dataDir = join(root, "data");
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  const files: Record<string, string | Buffer> = {
    "plan.md": "# Plan\n",
    "notes.txt": "notes\n",
    "rows.csv": "a,b\n1,2\n",
    "deploy.sh": "#!/bin/sh\necho deploy\n",
    "page.html": "<!doctype html><title>Checkout</title><img src=\"shot.png\"><h1 id=\"top\">Checkout</h1>\n",
    ".draft.html": "<!doctype html><title>Draft</title><p>draft</p>\n",
    "shot.png": PNG,
    "run.command": PNG,
    "spec.pdf": PDF,
    "build.zip": Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0xff, 0xfe]),
  };
  for (const [name, bytes] of Object.entries(files)) writeFileSync(join(project, name), bytes);
  return { root, dataDir, project };
}

type Launch = { how: "reveal" | "app" | "default"; path: string; app?: string };

/** A launcher that records instead of starting anything. */
function recordingLauncher(platform: OpenInPlatform, apps: string[] = ["reveal", "vscode", "cursor", "terminal"], answer: { ok: true } | { ok: false; error: string } = { ok: true }) {
  const launches: Launch[] = [];
  const catalog: Record<string, AvailableOpenInApp> = {
    reveal: { id: "reveal", label: "Finder", kind: "file-manager", icon: "finder" },
    vscode: { id: "vscode", label: "VS Code", kind: "editor", icon: "vscode" },
    cursor: { id: "cursor", label: "Cursor", kind: "editor", icon: "cursor" },
    terminal: { id: "terminal", label: "Terminal", kind: "terminal", icon: "terminal" },
  };
  const launcher: InboxOpenInLauncher = {
    platform,
    apps: () => apps.map((id) => catalog[id]!),
    reveal: async (path) => (launches.push({ how: "reveal", path }), answer),
    openWithApp: async (app: OpenInApp, path) => (launches.push({ how: "app", path, app: app.id }), answer),
    openWithSystemDefault: async (path) => (launches.push({ how: "default", path }), answer),
  };
  return { launcher, launches };
}

async function start(dataDir: string, extra: Parameters<typeof startInboxServer>[0] = {}): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, ...extra });
  servers.push(server);
  return server;
}

/** One message carrying every file of the project; their ids by name. */
async function attach(server: InboxServer, project: string, names: string[]): Promise<Record<string, string>> {
  const prj = server.store.ensureProject({ name: "billing", root: project });
  const attachments = await recordInboxAttachments(server.store.dir, names, { base: project, at: new Date().toISOString() });
  server.store.sendMessage({ project_id: prj.id, author: { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" }, body: "Files.", attachments });
  // Keyed by the name the agent gave (a symlink's own name), as `names` lists them.
  return Object.fromEntries(attachments.map((a, i) => [names[i]!, a.id]));
}

function openIn(server: InboxServer, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/api/inbox/open-in`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const answerOf = async (response: Response): Promise<[number, string | undefined]> => [response.status, ((await response.json()) as Json).code];

const ALL = ["plan.md", "notes.txt", "rows.csv", "deploy.sh", "page.html", ".draft.html", "shot.png", "run.command", "spec.pdf", "build.zip"];

describe("Inbox Open in: the launch route", () => {
  test("the apps route lists the file manager and the editors (never a terminal), with the platform", async () => {
    const { dataDir } = world();
    const { launcher } = recordingLauncher("mac");
    const server = await start(dataDir, { openInLauncher: launcher });
    const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox/open-in/apps`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Json;
    expect(body.available).toBe(true);
    expect(body.platform).toBe("mac");
    expect(body.apps.map((a: Json) => a.id)).toEqual(["reveal", "vscode", "cursor"]);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/inbox/open-in/apps`, { method: "POST", body: "{}" })).status).toBe(405);
  });

  test("the per-kind policy: what each kind opens in, and every launch gets the record's realpath", async () => {
    const { dataDir, project } = world();
    const { launcher, launches } = recordingLauncher("mac");
    const server = await start(dataDir, { openInLauncher: launcher });
    const ids = await attach(server, project, ALL);
    const allowed = async (name: string, app: string) => (await openIn(server, { attachment_id: ids[name], app_id: app })).status;
    const table: [string, string, number][] = [
      // Markdown, text and code: editors; the default app only for md/txt/json/yaml/toml/log (macOS, Windows).
      ["plan.md", "vscode", 200],
      ["plan.md", "default", 200],
      ["notes.txt", "default", 200],
      ["rows.csv", "vscode", 200],
      ["rows.csv", "default", 422],
      ["deploy.sh", "cursor", 200],
      ["deploy.sh", "default", 422],
      // HTML: editors and the file manager; never the OS default (Browser is the window's link).
      ["page.html", "vscode", 200],
      ["page.html", "default", 422],
      ["page.html", "browser", 422],
      // Images and PDFs: their viewer when the bytes and the extension agree; no editor.
      ["shot.png", "default", 200],
      ["shot.png", "vscode", 422],
      ["run.command", "default", 422],
      ["spec.pdf", "default", 200],
      // Anything else: the file manager only.
      ["build.zip", "reveal", 200],
      ["build.zip", "default", 422],
      ["build.zip", "vscode", 422],
      // Never a terminal, whatever the kind.
      ["plan.md", "terminal", 422],
      ["plan.md", "reveal", 200],
    ];
    const answered: [string, string, number][] = [];
    for (const [name, app] of table) answered.push([name, app, await allowed(name, app)]);
    expect(answered).toEqual(table);
    // run.command is a PNG by its bytes, so the Inbox calls it an image; its name would still run it.
    expect(server.store.attachment(ids["run.command"]!)!.attachment.kind).toBe("image");
    // Every launch went to the realpath the record holds.
    expect(launches.every((launch) => launch.path === realpathSync(join(project, launch.path.split("/").pop()!)))).toBe(true);
    expect(launches.filter((l) => l.how === "default").map((l) => l.path.split("/").pop())).toEqual(["plan.md", "notes.txt", "shot.png", "spec.pdf"]);
    expect(launches.filter((l) => l.how === "app").map((l) => `${l.app}:${l.path.split("/").pop()}`)).toEqual(["vscode:plan.md", "vscode:rows.csv", "cursor:deploy.sh", "vscode:page.html"]);
  });

  test("on Linux no text kind gets the default app; images and PDFs still do", async () => {
    const { dataDir, project } = world();
    const { launcher } = recordingLauncher("linux");
    const server = await start(dataDir, { openInLauncher: launcher });
    const ids = await attach(server, project, ["plan.md", "notes.txt", "shot.png", "spec.pdf"]);
    const statuses = [];
    for (const name of ["plan.md", "notes.txt", "shot.png", "spec.pdf"]) statuses.push((await openIn(server, { attachment_id: ids[name], app_id: "default" })).status);
    expect(statuses).toEqual([422, 422, 200, 200]);
  });

  test("refusals: another site, a sandboxed page, a stale tab, a bad body, an unknown id or app, an editor not installed; nothing launches", async () => {
    const { dataDir, project } = world();
    const { launcher, launches } = recordingLauncher("mac", ["reveal", "vscode"]);
    const server = await start(dataDir, { openInLauncher: launcher });
    const ids = await attach(server, project, ["plan.md"]);
    const id = ids["plan.md"]!;
    expect(await answerOf(await openIn(server, { attachment_id: id, app_id: "vscode" }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }))).toEqual([403, "cross_origin"]);
    // An attached page runs at an opaque origin: Origin null is another site.
    expect(await answerOf(await openIn(server, { attachment_id: id, app_id: "vscode" }, { Origin: "null" }))).toEqual([403, "cross_origin"]);
    // A preflight-free text/plain POST from another localhost port is refused too.
    expect(await answerOf(await openIn(server, JSON.stringify({ attachment_id: id, app_id: "vscode" }), { "Content-Type": "text/plain", "Sec-Fetch-Site": "same-site", Origin: "http://localhost:1" }))).toEqual([403, "cross_origin"]);
    expect(await answerOf(await openIn(server, { attachment_id: id, app_id: "vscode", serverSession: "an-older-inbox" }))).toEqual([409, "session_mismatch"]);
    expect(await answerOf(await openIn(server, { app_id: "vscode" }))).toEqual([422, "validation_error"]);
    expect(await answerOf(await openIn(server, { attachment_id: "../../etc/passwd", app_id: "vscode" }))).toEqual([422, "validation_error"]);
    expect(await answerOf(await openIn(server, { attachment_id: id }))).toEqual([422, "validation_error"]);
    expect(await answerOf(await openIn(server, "not json"))).toEqual([422, "validation_error"]);
    expect(await answerOf(await openIn(server, { attachment_id: "att_01K7ZZZZZZZZZZZZZZZZZZZZZZ", app_id: "vscode" }))).toEqual([404, "attachment_not_found"]);
    expect(await answerOf(await openIn(server, { attachment_id: id, app_id: "not-an-app" }))).toEqual([422, "open_not_allowed"]);
    expect(await answerOf(await openIn(server, { attachment_id: id, app_id: "cursor" }))).toEqual([422, "app_not_available"]);
    expect((await fetch(`http://127.0.0.1:${server.port}/api/inbox/open-in`)).status).toBe(405);
    expect(launches).toEqual([]);
    // A path in the body is never read: the record's realpath is what launches.
    const ok = await openIn(server, { attachment_id: id, app_id: "vscode", path: "/etc/passwd", filePath: "/etc/passwd" });
    expect(await ok.json()).toEqual({ ok: true });
    expect(launches).toEqual([{ how: "app", app: "vscode", path: join(project, "plan.md") }]);
  });

  test("the file is checked again at launch: gone, a symlink that now points elsewhere, an image that is no longer an image", async () => {
    const { dataDir, project } = world();
    const { launcher, launches } = recordingLauncher("mac");
    writeFileSync(join(project, "real.md"), "# Real\n");
    symlinkSync(join(project, "real.md"), join(project, "link.md"));
    const server = await start(dataDir, { openInLauncher: launcher });
    const ids = await attach(server, project, ["plan.md", "link.md", "shot.png"]);
    unlinkSync(join(project, "plan.md"));
    expect(await answerOf(await openIn(server, { attachment_id: ids["plan.md"], app_id: "reveal" }))).toEqual([404, "attachment_missing"]);
    writeFileSync(join(project, "other.md"), "# Other\n");
    unlinkSync(join(project, "link.md"));
    symlinkSync(join(project, "other.md"), join(project, "link.md"));
    expect(await answerOf(await openIn(server, { attachment_id: ids["link.md"], app_id: "vscode" }))).toEqual([409, "attachment_changed_type"]);
    writeFileSync(join(project, "shot.png"), "#!/bin/sh\necho not an image\n");
    expect(await answerOf(await openIn(server, { attachment_id: ids["shot.png"], app_id: "default" }))).toEqual([409, "attachment_changed_type"]);
    expect(launches).toEqual([]);
  });

  test("a launch that fails answers 200 with the reason, as /api/open-in does", async () => {
    const { dataDir, project } = world();
    const { launcher } = recordingLauncher("mac", ["reveal", "vscode"], { ok: false, error: "VS Code not found" });
    const server = await start(dataDir, { openInLauncher: launcher });
    const ids = await attach(server, project, ["plan.md"]);
    const response = await openIn(server, { attachment_id: ids["plan.md"], app_id: "vscode" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, error: "VS Code not found" });
  });
});

describe("Inbox Open in: the real launcher, with stubs on PATH", () => {
  const launchTest = process.platform === "win32" ? test.skip : test;
  launchTest("reveal and the default app run the platform's own launcher with the realpath, nothing else", async () => {
    const { root, dataDir, project } = world();
    const stubs = join(root, "stubs");
    mkdirSync(stubs);
    const log = join(stubs, "launches.log");
    for (const name of ["open", "xdg-open", "code", "explorer"]) {
      writeFileSync(join(stubs, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\nexit 0\n`);
      chmodSync(join(stubs, name), 0o755);
    }
    const server = await start(dataDir, { openInLauncher: systemOpenInLauncher() });
    const ids = await attach(server, project, ["shot.png", "build.zip"]);
    setEnv("PATH", stubs);
    expect(await (await openIn(server, { attachment_id: ids["shot.png"], app_id: "default" })).json()).toEqual({ ok: true });
    expect(await (await openIn(server, { attachment_id: ids["build.zip"], app_id: "reveal" })).json()).toEqual({ ok: true });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    if (process.platform === "darwin") {
      expect(lines).toEqual([`open ${join(project, "shot.png")}`, `open -R ${join(project, "build.zip")}`]);
    } else {
      expect(lines).toEqual([`xdg-open ${join(project, "shot.png")}`, `xdg-open ${project}`]);
    }
  });
});

describe("Inbox Open in: the new-tab page", () => {
  test("now: a 303 to the page at its own folder's asset URL, served there with the attached-page sandbox; its images load from the folder", async () => {
    const { dataDir, project } = world();
    const server = await start(dataDir);
    const ids = await attach(server, project, ["page.html"]);
    const base = `http://127.0.0.1:${server.port}`;
    const page = await fetch(`${base}/api/inbox/attachments/${ids["page.html"]}/page`, { redirect: "manual" });
    expect(page.status).toBe(303);
    const location = page.headers.get("location")!;
    expect(location).toMatch(/^\/api\/html-assets\/[0-9a-f]{16}\/page\.html$/);
    const served = await fetch(`${base}${location}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-security-policy")).toBe("sandbox allow-scripts; connect-src 'none'");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await served.text()).toContain("<h1 id=\"top\">Checkout</h1>");
    const image = await fetch(`${base}${location.replace("page.html", "shot.png")}`);
    expect(image.status).toBe(200);
    // A hidden file next to it is never served from the folder.
    expect((await fetch(`${base}${location.replace("page.html", ".draft.html")}`)).status).toBe(404);
  });

  test("the page cannot leave its sandbox by navigating its tab to a sibling SVG or XML: every non-HTML asset is sandboxed too", async () => {
    // Top-level, the response CSP is the page's only sandbox. A sibling .svg
    // (or XHTML .xml) opened as a document would otherwise run script on the
    // Inbox's origin and reach its API; it carries its own sandbox with no script.
    const { dataDir, project } = world();
    writeFileSync(join(project, "chart.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/inbox/threads")</script></svg>');
    writeFileSync(join(project, "data.xml"), '<html xmlns="http://www.w3.org/1999/xhtml"><script>fetch("/api/inbox/threads")</script></html>');
    const server = await start(dataDir);
    const ids = await attach(server, project, ["page.html"]);
    const base = `http://127.0.0.1:${server.port}`;
    const location = (await fetch(`${base}/api/inbox/attachments/${ids["page.html"]}/page`, { redirect: "manual" })).headers.get("location")!;
    for (const name of ["chart.svg", "data.xml", "shot.png"]) {
      const asset = await fetch(`${base}${location.replace("page.html", name)}`, { headers: { "Sec-Fetch-Dest": "document", "Sec-Fetch-Site": "same-origin" } });
      expect([name, asset.status, asset.headers.get("content-security-policy")]).toEqual([
        name,
        200,
        "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
      ]);
      expect(asset.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("sent: the bytes the agent sent, with a <base href> at its folder, under the same sandbox", async () => {
    const { dataDir, project } = world();
    const server = await start(dataDir);
    const ids = await attach(server, project, ["page.html"]);
    writeFileSync(join(project, "page.html"), "<!doctype html><h1>Edited later</h1>\n");
    const sent = await fetch(`http://127.0.0.1:${server.port}/api/inbox/attachments/${ids["page.html"]}/page?version=sent`, { redirect: "manual" });
    expect(sent.status).toBe(200);
    expect(sent.headers.get("content-type")).toContain("text/html");
    expect(sent.headers.get("content-security-policy")).toBe("sandbox allow-scripts; connect-src 'none'");
    const html = await sent.text();
    expect(html).toContain("Checkout");
    expect(html).not.toContain("Edited later");
    expect(html).toMatch(/<base href="\/api\/html-assets\/[0-9a-f]{16}\/">/);
  });

  test("a hidden page is served directly; refusals: another site, not HTML, gone", async () => {
    const { dataDir, project } = world();
    const server = await start(dataDir);
    const ids = await attach(server, project, [".draft.html", "plan.md", "page.html"]);
    const base = `http://127.0.0.1:${server.port}`;
    const hidden = await fetch(`${base}/api/inbox/attachments/${ids[".draft.html"]}/page`, { redirect: "manual" });
    expect(hidden.status).toBe(200);
    expect(hidden.headers.get("content-security-policy")).toBe("sandbox allow-scripts; connect-src 'none'");
    expect(await hidden.text()).toContain("draft");
    const page = `${base}/api/inbox/attachments/${ids["page.html"]}/page`;
    expect(await answerOf(await fetch(page, { headers: { "Sec-Fetch-Site": "cross-site" } }))).toEqual([403, "cross_origin"]);
    expect(await answerOf(await fetch(`${base}/api/inbox/attachments/${ids["plan.md"]}/page`))).toEqual([415, "attachment_not_html"]);
    expect((await fetch(page, { method: "POST", body: "{}" })).status).toBe(405);
    unlinkSync(join(project, "page.html"));
    expect(await answerOf(await fetch(page, { redirect: "manual" }))).toEqual([404, "attachment_missing"]);
  });
});

describe("Inbox Open in: over the tailnet", () => {
  const MAGIC = "macbook-pro.tail0000.ts.net";
  const OWNER = "ramos@example.com";
  const tailscale: TailscaleRunner = (() => {
    const serve = new Map<number, string>();
    return (args) => {
      const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
      if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER } } }));
      if (args[1] === "status") {
        const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
        return ok(serve.size === 0 ? "{}" : JSON.stringify({ TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])), Web }));
      }
      const port = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
      if (args.includes("off")) serve.delete(port);
      else serve.set(port, args.at(-1)!);
      return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${port}/\n`);
    };
  })();

  test("the launch and the app list answer local_only; the owner opens the new-tab page", async () => {
    const { dataDir, project } = world();
    const { launcher, launches } = recordingLauncher("mac");
    const server = await start(dataDir, { openInLauncher: launcher, tailscale, publishTailnet: true });
    const ids = await attach(server, project, ["plan.md", "page.html"]);
    const listener = server.tailscale.listenerPort()!;
    expect(listener).not.toBeNull();
    const through = (path: string, init: { method?: string; body?: string } = {}) =>
      fetch(`http://127.0.0.1:${listener}${path}`, {
        method: init.method ?? "GET",
        redirect: "manual",
        headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": OWNER, "Content-Type": "application/json", Origin: `https://${MAGIC}:${server.port}` },
        body: init.body,
      });
    expect(await answerOf(await through("/api/inbox/open-in/apps"))).toEqual([403, "local_only"]);
    expect(await answerOf(await through("/api/inbox/open-in", { method: "POST", body: JSON.stringify({ attachment_id: ids["plan.md"], app_id: "vscode" }) }))).toEqual([403, "local_only"]);
    expect(launches).toEqual([]);
    const page = await through(`/api/inbox/attachments/${ids["page.html"]}/page`);
    expect(page.status).toBe(303);
    const served = await through(page.headers.get("location")!);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-security-policy")).toBe("sandbox allow-scripts; connect-src 'none'");
  });
});
