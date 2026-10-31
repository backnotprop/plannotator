/**
 * A page an attached HTML page links to, shown read-only in its pane
 * (`GET /api/inbox/attachments/:id/linked-page?path=`): the attached page's
 * own folder only, the asset route's rules, the page served with its
 * `<base href>`. Real Inbox on loopback, the agent through the MCP SDK.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startInboxServer, type InboxServer } from "./inbox";
import { readInboxLinkedPage } from "./inbox-attachments";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-linked-")));
  roots.push(root);
  const project = join(root, "design");
  mkdirSync(join(project, "sub"), { recursive: true });
  mkdirSync(join(project, ".private"), { recursive: true });
  writeFileSync(join(project, "SHEET.html"), '<h1>Sheet</h1><a href="B-cards.html">B</a><img src="frames/a.png">');
  writeFileSync(join(project, "B-cards.html"), '<h1 id="pr1">Cards</h1><img src="frames/b.png">');
  writeFileSync(join(project, "sub", "deep.htm"), "<p>Deep</p>");
  writeFileSync(join(project, ".private", "x.html"), "<p>hidden</p>");
  writeFileSync(join(project, "notes.md"), "# Notes");
  writeFileSync(join(project, "huge.html"), `<p>${"x".repeat(2 * 1024 * 1024 + 10)}</p>`);
  writeFileSync(join(root, "outside.html"), "<p>outside</p>");
  symlinkSync(join(root, "outside.html"), join(project, "escape.html"));
  const server = await startInboxServer({ dataDir: join(root, "data") });
  servers.push(server);
  const client = new Client({ name: "inbox-linked-page-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const result = (await client.callTool({
    name: "send_message",
    arguments: { project_path: project, body: "The sheet.", attachments: ["SHEET.html", "notes.md"], agent_session: "ses_A" },
  })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  if (result.isError) throw new Error(result.content[0]!.text);
  const [sheet, notes] = result.structuredContent.attachments as { id: string }[];
  return { server, project, sheet: sheet!.id, notes: notes!.id };
}

const get = (server: InboxServer, path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${server.port}${path}`, { headers });
const linked = (server: InboxServer, id: string, rel: string, headers: Record<string, string> = {}) =>
  get(server, `/api/inbox/attachments/${id}/linked-page?path=${encodeURIComponent(rel)}`, headers);

test("a sibling page comes back with its <base href>, its asset URL, and its images load through it", async () => {
  const { server, project, sheet } = await world();
  const answer = await linked(server, sheet, "B-cards.html");
  expect(answer.status).toBe(200);
  const page = (await answer.json()) as { path: string; name: string; html: string; url: string };
  expect(page.path).toBe(join(project, "B-cards.html"));
  expect(page.name).toBe("B-cards.html");
  const base = /<base href="(\/api\/html-assets\/[A-Za-z0-9_-]+\/)"/.exec(page.html)?.[1];
  expect(base).toBeTruthy();
  expect(page.html).toContain('<h1 id="pr1">Cards</h1>');
  // Open in new tab: the page itself at its folder's asset URL, under the document CSP.
  const tab = await get(server, page.url);
  expect(tab.status).toBe(200);
  expect(tab.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
  expect(await tab.text()).toContain("Cards");
  // A page in a subfolder of the attached page's folder.
  expect((await linked(server, sheet, "sub/deep.htm")).status).toBe(200);
});

test("refusals: outside the folder, hidden, not HTML, missing, too large, another site, unsupported document type", async () => {
  const { server, sheet, notes } = await world();
  const code = async (res: Response) => [res.status, ((await res.json()) as { code: string }).code];
  expect(await code(await linked(server, sheet, "../outside.html"))).toEqual([403, "linked_page_outside"]);
  // A link inside the folder that leads outside it.
  expect(await code(await linked(server, sheet, "escape.html"))).toEqual([403, "linked_page_outside"]);
  expect(await code(await linked(server, sheet, "/etc/passwd.html"))).toEqual([422, "validation_error"]);
  expect(await code(await linked(server, sheet, ".private/x.html"))).toEqual([403, "linked_page_refused"]);
  expect(await code(await linked(server, sheet, "notes.md"))).toEqual([415, "linked_page_not_html"]);
  expect(await code(await linked(server, sheet, "gone.html"))).toEqual([404, "linked_page_missing"]);
  expect(await code(await linked(server, sheet, "huge.html"))).toEqual([413, "linked_page_too_large"]);
  expect(await code(await linked(server, sheet, ""))).toEqual([422, "validation_error"]);
  expect(await code(await linked(server, notes, "B-cards.html"))).toEqual([415, "linked_page_not_html"]);
  expect(await code(await linked(server, sheet, "B-cards.html", { "Sec-Fetch-Site": "cross-site" }))).toEqual([403, "cross_origin"]);
  const post = await fetch(`http://127.0.0.1:${server.port}/api/inbox/attachments/${sheet}/linked-page?path=B-cards.html`, { method: "POST" });
  expect(post.status).toBe(405);
});

test("a parent folder swapped for a symlink between the realpath and the open never serves the file outside", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-linked-race-")));
  roots.push(root);
  const project = join(root, "design");
  mkdirSync(join(project, "sub"), { recursive: true });
  mkdirSync(join(root, "outdir"));
  writeFileSync(join(project, "SHEET.html"), "<p>Sheet</p>");
  writeFileSync(join(project, "sub", "deep.htm"), "<p>inside</p>");
  writeFileSync(join(root, "outdir", "deep.htm"), "<p>OUTSIDE</p>");
  // Another process swaps `sub` for a symlink to a folder outside and back, as fast as it can.
  const swapper = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const fs = require("node:fs"); const [p, o] = process.argv.slice(1); const end = Date.now() + 15000;
       while (Date.now() < end) {
         try { fs.renameSync(p + "/sub", p + "/sub_real"); fs.symlinkSync(o, p + "/sub"); } catch {}
         try { fs.rmSync(p + "/sub"); fs.renameSync(p + "/sub_real", p + "/sub"); } catch {}
       }`,
      project,
      join(root, "outdir"),
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  try {
    await new Promise((r) => setTimeout(r, 100));
    let outside = 0;
    for (let i = 0; i < 20000; i++) {
      try {
        const page = await readInboxLinkedPage(join(project, "SHEET.html"), "sub/deep.htm");
        if (page.text.includes("OUTSIDE")) outside++;
      } catch {
        // Refused while the folder is a symlink: what should happen.
      }
    }
    expect(outside).toBe(0);
  } finally {
    swapper.kill();
    await swapper.exited;
  }
}, 30000);


test("Markdown siblings open as text under the same folder and origin guards", async () => {
  const { server, project, notes } = await world();
  writeFileSync(join(project, "peer.md"), "# Linked document\n\n[Next](sub/deep.mdx)");
  writeFileSync(join(project, "sub", "deep.mdx"), "# Deep document");
  writeFileSync(join(project, ".private", "secret.md"), "# Hidden");
  writeFileSync(join(project, "huge.md"), "x".repeat(2 * 1024 * 1024 + 1));
  writeFileSync(join(project, "image.png"), "not Markdown");
  symlinkSync(join(project, "..", "outside.html"), join(project, "escape.md"));
  const answer = await linked(server, notes, "peer.md");
  expect(answer.status).toBe(200);
  expect(await answer.json()).toMatchObject({ path: join(project, "peer.md"), name: "peer.md", html: null, text: "# Linked document\n\n[Next](sub/deep.mdx)", url: null });
  expect((await linked(server, notes, "sub/deep.mdx")).status).toBe(200);
  for (const path of ["../outside.md", "escape.md", ".private/secret.md"]) expect((await linked(server, notes, path)).status).toBe(403);
  expect((await linked(server, notes, "huge.md")).status).toBe(413);
  expect((await linked(server, notes, "missing.md")).status).toBe(404);
  expect((await linked(server, notes, "image.png")).status).toBe(415);
  expect((await linked(server, notes, "peer.md", { "Sec-Fetch-Site": "same-site" })).status).toBe(403);
});

test("a link named like a document but leading to another kind of file is refused by where it leads", async () => {
  const { server, project, sheet, notes } = await world();
  writeFileSync(join(project, "data.json"), '{"token":"x"}');
  symlinkSync(join(project, "data.json"), join(project, "alias.md"));
  symlinkSync(join(project, "data.json"), join(project, "alias.html"));
  const code = async (res: Response) => [res.status, ((await res.json()) as { code: string }).code];
  expect(await code(await linked(server, notes, "alias.md"))).toEqual([415, "linked_page_not_html"]);
  expect(await code(await linked(server, sheet, "alias.html"))).toEqual([415, "linked_page_not_html"]);
  // The image route reads a linked document the same way.
  const image = await fetch(`http://127.0.0.1:${server.port}/api/inbox/attachments/${notes}/markdown-image?document=alias.md&path=a.png`);
  expect(image.status).toBe(415);
});
