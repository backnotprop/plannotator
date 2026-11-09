/**
 * `/api/doc` outside the project (#2291), driven over HTTP against real plan
 * and annotate servers. Shared by the Bun suite (doc-any-path.test.ts) and
 * the Pi mirror (apps/pi-extension/server/doc-any-path.test.ts), so both
 * runtimes answer the same scenarios.
 *
 * A tab on this machine opens a document anywhere: one in a folder added
 * under Settings → Files, and one the current document links outside the
 * project, and its comments are saved as a per-document draft. Only document
 * types: a code file or a data/config file (an OAuth token in a .yml, a .json
 * of credentials) keeps the roots, and a document name whose real file is
 * something else (`key.md -> ~/.ssh/id_ed25519`) is refused for every reader.
 * Another site's page is refused, and every reader that may be on another
 * machine keeps the roots: remote mode, PLANNOTATOR_ALLOWED_HOSTS, a Host that
 * is not loopback, and any proxy mark (non-loopback X-Forwarded-For or
 * X-Forwarded-Host, Forwarded, X-Real-IP, a `tailscale serve` header).
 *
 * Requests go through node:http so every header is exactly the one under
 * test. Every test runs under a temp PLANNOTATOR_DATA_DIR and HOME; nothing
 * touches the real ~/.plannotator.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { dirname, join } from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { closeServer, occupyConsecutivePorts } from "../../tests/helpers/ports";

export interface DocScenarioServer {
  url: string;
  stop: () => void;
}

export type DocScenarioKind = "plan" | "annotate";

export type StartDocScenarioServer = (
  kind: DocScenarioKind,
  options: {
    docPath: string;
    htmlContent: string;
    /** Annotate: a folder session on this folder. */
    folderPath?: string;
    /** Annotate: the session's own file is this HTML, rendered as a page. */
    rawHtml?: string;
  },
) => Promise<DocScenarioServer>;

export interface DocScenarioRuntime {
  /**
   * Let the Host guard answer `hostname` the way a `--tailscale` session
   * answers its served MagicDNS name; returns the undo. Absent on a runtime
   * with no `--tailscale` (Pi).
   */
  allowServedHost?: (hostname: string) => () => void;
}

const HTML = "<!doctype html><html><body>doc-any-path-app</body></html>";

interface Answer {
  status: number;
  body: Record<string, unknown> | null;
  text: string;
  headers: Record<string, string | string[] | undefined>;
}

function send(
  server: DocScenarioServer,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Answer> {
  const port = new URL(server.url).port;
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      `http://127.0.0.1:${port}${path}`,
      {
        method,
        headers: {
          host: `127.0.0.1:${port}`,
          ...(text !== undefined ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } : {}),
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, text: raw, headers: res.headers });
        });
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

const get = (server: DocScenarioServer, path: string, headers: Record<string, string> = {}) =>
  send(server, "GET", path, headers);

const docUrl = (path: string, base?: string, doc = true) =>
  `/api/doc?path=${encodeURIComponent(path)}${base ? `&base=${encodeURIComponent(base)}` : ""}${doc ? "&doc=1" : ""}`;

/** No secret's bytes in an answer, whatever its status. */
const leaks = (answer: Answer) => /SECRET-/.test(JSON.stringify(answer.body));

export function defineDocAnyPathScenarios(
  runtime: string,
  start: StartDocScenarioServer,
  runtimeOptions: DocScenarioRuntime = {},
): void {
  const environment = createTestEnvironment(
    [
      "HOME",
      "PLANNOTATOR_PORT",
      "PLANNOTATOR_REMOTE",
      "PLANNOTATOR_DATA_DIR",
      "PLANNOTATOR_AI",
      "PLANNOTATOR_INBOX_CONNECT",
      "PLANNOTATOR_URL_HOST",
      "PLANNOTATOR_PUBLIC_URL",
      "PLANNOTATOR_ALLOWED_HOSTS",
      "VSCODE_PROXY_URI",
      "CODESPACES",
      "SSH_TTY",
      "SSH_CONNECTION",
    ],
    "plannotator-doc-any-path-",
  );

  let home = "";
  /** The session's own document, inside the project. */
  let docPath = "";
  let project = "";
  /** A folder added under Settings → Files, outside the project. */
  let added = "";
  /** A folder beside the project that the session's document links into. */
  let shared = "";
  const servers: DocScenarioServer[] = [];
  const undo: (() => void)[] = [];

  async function isolate(options: { remote?: boolean; allowedHosts?: string; proxyUri?: string; codespace?: boolean } = {}): Promise<void> {
    environment.reset();
    const dir = realpathSync(environment.makeTempDir());
    home = join(dir, "home");
    process.env.HOME = home;
    process.env.PLANNOTATOR_DATA_DIR = join(dir, "data");
    process.env.PLANNOTATOR_AI = "disabled";
    process.env.PLANNOTATOR_INBOX_CONNECT = "0";
    process.env.PLANNOTATOR_REMOTE = options.remote ? "1" : "0";
    if (options.allowedHosts !== undefined) process.env.PLANNOTATOR_ALLOWED_HOSTS = options.allowedHosts;
    if (options.proxyUri !== undefined) process.env.VSCODE_PROXY_URI = options.proxyUri;
    if (options.codespace) process.env.CODESPACES = "true";
    else delete process.env.CODESPACES;
    if (options.remote) {
      // Remote mode would otherwise bind the fixed 19432.
      const { start: port, servers: held } = await occupyConsecutivePorts(1);
      await closeServer(held[0]);
      process.env.PLANNOTATOR_PORT = String(port);
    }
    project = join(dir, "demo-app");
    added = join(dir, "reference-docs");
    shared = join(dir, "shared");
    for (const folder of [project, join(added, "guides"), shared, join(home, ".config/gh"), join(home, ".codex"), join(home, ".ssh")]) {
      mkdirSync(folder, { recursive: true });
    }
    docPath = join(project, "notes.md");
    writeFileSync(docPath, "# Notes\n\nSee [linked](../shared/linked.md).\n");
    writeFileSync(join(added, "intro.md"), "# Reference intro\n\nADDED-FOLDER-BODY\n");
    writeFileSync(join(added, "guides/setup.md"), "# Setup\n\nADDED-SIBLING-BODY\n");
    writeFileSync(join(shared, "linked.md"), "# Linked\n\nLINKED-OUTSIDE-BODY\n");
    // What a document read must never reach.
    writeFileSync(join(home, ".config/gh/hosts.yml"), "github.com:\n  oauth_token: SECRET-GH-TOKEN\n");
    writeFileSync(join(home, ".codex/auth.json"), '{"token":"SECRET-CODEX"}\n');
    writeFileSync(join(home, ".ssh/id_ed25519"), "SECRET-SSH-KEY\n");
    writeFileSync(join(home, "tool.ts"), "export const key = 'SECRET-TS';\n");
    writeFileSync(join(project, "id_rsa"), "SECRET-PROJECT-KEY\n");
    // Document names whose real file is something else.
    symlinkSync(join(home, ".ssh/id_ed25519"), join(added, "key.md"));
    symlinkSync(join(home, ".config/gh/hosts.yml"), join(added, "token.md"));
    symlinkSync(join(project, "id_rsa"), join(project, "key.md"));
    // A document name that is a document: still served.
    symlinkSync(join(added, "intro.md"), join(added, "alias.md"));
  }

  async function open(kind: DocScenarioKind, extra: { folderPath?: string; rawHtml?: string } = {}): Promise<DocScenarioServer> {
    const server = await start(kind, { docPath, htmlContent: HTML, ...extra });
    servers.push(server);
    return server;
  }

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
    for (const fn of undo.splice(0)) fn();
    environment.restore();
  });

  for (const kind of ["plan", "annotate"] as const) {
    describe(`${runtime} ${kind} server: /api/doc outside the project (#2291)`, () => {
      test("opens a document in a folder added under Settings → Files, and one it links", async () => {
        await isolate();
        const server = await open(kind);
        // What the Files sidebar sends: the absolute path, its folder as base.
        const doc = await get(server, docUrl(join(added, "intro.md"), added));
        expect(doc.status).toBe(200);
        expect(String(doc.body?.markdown)).toContain("ADDED-FOLDER-BODY");
        // A relative link inside that document resolves from its folder.
        const sibling = await get(server, docUrl("guides/setup.md", added));
        expect(sibling.status).toBe(200);
        expect(String(sibling.body?.markdown)).toContain("ADDED-SIBLING-BODY");
        // A document name that is a link to another document is still one.
        const alias = await get(server, docUrl(join(added, "alias.md"), added));
        expect(alias.status).toBe(200);
        expect(String(alias.body?.markdown)).toContain("ADDED-FOLDER-BODY");
      });

      test("opens a document the current one links by a relative path outside the project", async () => {
        await isolate();
        const server = await open(kind);
        const linked = await get(server, docUrl("../shared/linked.md", project));
        expect(linked.status).toBe(200);
        expect(String(linked.body?.markdown)).toContain("LINKED-OUTSIDE-BODY");
        expect(linked.body?.filepath).toBe(join(shared, "linked.md"));
      });

      test("code, data and config files outside the project keep the roots, for this machine too", async () => {
        await isolate();
        const server = await open(kind);
        for (const path of [
          join(home, ".config/gh/hosts.yml"),
          join(home, ".codex/auth.json"),
          join(home, ".ssh/id_ed25519"),
          join(home, "tool.ts"),
        ]) {
          for (const doc of [true, false]) {
            const answer = await get(server, docUrl(path, undefined, doc));
            expect([path, doc, answer.status]).toEqual([path, doc, 403]);
            expect(leaks(answer)).toBe(false);
          }
        }
        // The same names reached relative to a trusted base outside the project.
        const relative = await get(server, docUrl("../home/.config/gh/hosts.yml", added));
        expect(relative.status).not.toBe(200);
        expect(leaks(relative)).toBe(false);
      });

      test("a document name whose real file is not a document is refused", async () => {
        await isolate();
        const server = await open(kind);
        for (const url of [
          docUrl(join(added, "key.md"), added),
          docUrl("key.md", added),
          docUrl(join(added, "key.md"), added, false),
          // A data file the doc viewer would render is still not a document anywhere.
          docUrl(join(added, "token.md"), added),
        ]) {
          const answer = await get(server, url);
          expect([url, answer.status]).toEqual([url, 403]);
          expect(leaks(answer)).toBe(false);
        }
        if (kind === "annotate") {
          // Inside the session's roots too.
          const inRoot = await get(server, docUrl(join(project, "key.md"), project));
          expect(inRoot.status).toBe(403);
          expect(leaks(inRoot)).toBe(false);
        }
      });

      if (kind === "annotate") {
        test("an HTML document opened outside the project gets assets to render, never data or hidden files", async () => {
          await isolate();
          for (const dir of [added, project]) {
            mkdirSync(join(dir, ".hidden"), { recursive: true });
            writeFileSync(join(dir, "page.html"), '<html><body><img src="pic.png"><link rel="stylesheet" href="style.css"></body></html>');
            writeFileSync(join(dir, "pic.png"), "PNG-BYTES");
            writeFileSync(join(dir, "style.css"), "body { color: red }");
            writeFileSync(join(dir, "font.woff2"), "FONT-BYTES");
            writeFileSync(join(dir, "config.json"), '{"s":"SECRET-JSON"}');
            writeFileSync(join(dir, "data.xml"), "<s>SECRET-XML</s>");
            writeFileSync(join(dir, ".hidden/creds.json"), '{"s":"SECRET-HIDDEN"}');
            writeFileSync(join(dir, ".hidden/pic.png"), "SECRET-HIDDEN-PNG");
            // Render-type names that are links to what is refused.
            symlinkSync(join(dir, "config.json"), join(dir, "link-data.png"));
            symlinkSync(join(dir, ".hidden/pic.png"), join(dir, "link-hidden.png"));
          }
          const server = await open(kind);
          const assetBase = async (dir: string) => {
            const doc = await get(server, docUrl(join(dir, "page.html"), dir));
            expect(doc.status).toBe(200);
            const base = /\/api\/html-assets\/[0-9a-f]+\//.exec(String(doc.body?.rawHtml))?.[0];
            expect(base).toBeTruthy();
            return base!;
          };
          const outside = await assetBase(added);
          // What the page needs to render is served, but only fonts are readable by its scripts.
          const pic = await get(server, `${outside}pic.png`);
          expect(pic.status).toBe(200);
          expect(pic.headers["access-control-allow-origin"]).toBeUndefined();
          expect((await get(server, `${outside}style.css`)).status).toBe(200);
          const font = await get(server, `${outside}font.woff2`);
          expect(font.status).toBe(200);
          expect(font.headers["access-control-allow-origin"]).toBe("*");
          // Data files and hidden paths beside it are not.
          for (const asset of ["config.json", "data.xml", ".hidden/creds.json", ".hidden/pic.png", "link-data.png", "link-hidden.png"]) {
            const answer = await get(server, `${outside}${asset}`);
            expect([asset, answer.status]).toEqual([asset, 404]);
            expect(answer.text).not.toContain("SECRET-");
          }
          // The page itself, opened through the asset route, gets no network.
          const page = await get(server, `${outside}page.html`);
          expect(page.status).toBe(200);
          expect(String(page.headers["content-security-policy"])).toContain("connect-src 'none'");
          // Its root answers only a page on this machine.
          const forwarded = await get(server, `${outside}pic.png`, { "x-forwarded-for": "192.0.2.10" });
          expect(forwarded.status).toBe(404);
          expect(forwarded.text).not.toContain("PNG-BYTES");
          // An HTML document inside the project keeps its folder's assets, as before.
          const inside = await assetBase(project);
          const config = await get(server, `${inside}config.json`);
          expect(config.status).toBe(200);
          expect(config.headers["access-control-allow-origin"]).toBe("*");
          const insidePage = await get(server, `${inside}page.html`);
          expect(insidePage.status).toBe(200);
          expect(String(insidePage.headers["content-security-policy"])).not.toContain("connect-src");
          expect((await get(server, `${inside}pic.png`, { "x-forwarded-for": "192.0.2.10" })).status).toBe(200);
        });

        test("/api/share-html reads like /api/doc: the folder for a reader off this machine, a regular file within 2MB", async () => {
          await isolate();
          writeFileSync(join(shared, "statement.html"), "<p>SECRET-STATEMENT</p>");
          writeFileSync(join(added, "notes.html"), "<p>FOLDER-NOTES</p>");
          writeFileSync(join(added, "big.html"), `<p>${"x".repeat(2 * 1024 * 1024 + 16)}</p>`);
          mkdirSync(join(added, "dir.html"));
          const share = (path: string) => `/api/share-html?path=${encodeURIComponent(path)}`;
          const FORWARDED = { "x-forwarded-for": "192.0.2.10" };
          // `cd ~ && plannotator annotate ~/notes/`: the cwd holds files outside the folder.
          const cwd = process.cwd();
          process.chdir(dirname(added));
          try {
            const server = await open(kind, { folderPath: added });
            const refused = await get(server, share(join(shared, "statement.html")), FORWARDED);
            expect(refused.status).toBe(403);
            expect(refused.text).not.toContain("SECRET-STATEMENT");
            const inFolder = await get(server, share(join(added, "notes.html")), FORWARDED);
            expect(inFolder.status).toBe(200);
            expect(inFolder.text).toContain("FOLDER-NOTES");
            // A page on this machine shares a document from anywhere, as /api/doc serves it.
            const local = await get(server, share(join(shared, "statement.html")));
            expect(local.status).toBe(200);
            expect(local.text).toContain("SECRET-STATEMENT");
            expect((await get(server, share(join(added, "big.html")))).status).toBe(413);
            expect((await get(server, share(join(added, "dir.html")))).status).toBe(403);
            const crossSite = await get(server, share(join(added, "notes.html")), { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
            expect(crossSite.status).toBe(403);
            expect(crossSite.body?.code).toBe("cross_origin");
          } finally {
            process.chdir(cwd);
          }
        });
      }

      if (kind === "annotate") {
        test("the HTML file or folder passed to annotate keeps its folder's assets in full", async () => {
          await isolate();
          // Both live outside the server's cwd, as `plannotator annotate ~/site/page.html` would.
          const page = '<html><body><img src="pic.png"></body></html>';
          for (const dir of [shared, join(added, "site")]) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "page.html"), page);
            writeFileSync(join(dir, "config.json"), '{"own":"OWN-DATA"}');
          }
          writeFileSync(join(added, "data.json"), '{"own":"FOLDER-DATA"}');
          const tokenBase = (html: unknown) => {
            const base = /\/api\/html-assets\/[0-9a-f]+\//.exec(String(html))?.[0];
            expect(base).toBeTruthy();
            return base!;
          };
          // A single-file session on an HTML file: the page /api/plan serves.
          docPath = join(shared, "page.html");
          const single = await open(kind, { rawHtml: page });
          const plan = await get(single, "/api/plan");
          expect(plan.status).toBe(200);
          const own = await get(single, `${tokenBase(plan.body?.rawHtml)}config.json`);
          expect(own.status).toBe(200);
          expect(own.text).toContain("OWN-DATA");
          expect(own.headers["access-control-allow-origin"]).toBe("*");
          // A folder session: an HTML file inside the folder, and the folder's own data beside it.
          const folder = await open(kind, { folderPath: added });
          const doc = await get(folder, docUrl(join(added, "site/page.html"), added));
          expect(doc.status).toBe(200);
          const base = tokenBase(doc.body?.rawHtml);
          for (const [asset, body] of [["site/config.json", "OWN-DATA"], ["data.json", "FOLDER-DATA"]]) {
            const answer = await get(folder, `${base}${asset}`);
            expect([asset, answer.status]).toEqual([asset, 200]);
            expect(answer.text).toContain(body);
            expect(answer.headers["access-control-allow-origin"]).toBe("*");
          }
        });
      }

      test("comments on a document opened outside the project are saved, for this machine only", async () => {
        await isolate();
        const server = await open(kind);
        const path = join(added, "intro.md");
        const comment = { id: "c-added", text: "outside note" };
        const saved = await send(server, "POST", "/api/draft/document", {}, { documents: [{ path, annotations: [comment] }] });
        expect(saved.status).toBe(200);
        expect(saved.body?.written).toBe(1);
        expect(saved.body?.rejected).toBeUndefined();
        const loaded = await get(server, `/api/draft/document?path=${encodeURIComponent(path)}`);
        expect(loaded.status).toBe(200);
        expect(loaded.body?.annotations).toEqual([comment]);
        // A reader forwarded from another machine keeps the roots here as well.
        const forwarded = { "x-forwarded-for": "100.101.102.103" };
        const refused = await send(server, "POST", "/api/draft/document", forwarded, { documents: [{ path, annotations: [comment] }] });
        expect(refused.body?.rejected).toEqual([path]);
        expect((await get(server, `/api/draft/document?path=${encodeURIComponent(path)}`, forwarded)).status).toBe(403);
      });

      test("refuses another site's page", async () => {
        await isolate();
        const server = await open(kind);
        const reads = [docUrl(join(added, "intro.md"), added)];
        if (kind === "annotate") {
          reads.push(`/api/plan/versions?path=${encodeURIComponent(join(added, "intro.md"))}`);
          reads.push(`/api/plan/version?path=${encodeURIComponent(join(added, "intro.md"))}&v=1`);
        }
        for (const path of reads) {
          for (const headers of <Record<string, string>[]>[
            { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
            { origin: "https://evil.example" },
            { "sec-fetch-site": "same-site" },
          ]) {
            const answer = await get(server, path, headers);
            expect([path, headers, answer.status]).toEqual([path, headers, 403]);
            expect(answer.body?.code).toBe("cross_origin");
            expect(JSON.stringify(answer.body)).not.toContain("ADDED-FOLDER-BODY");
          }
        }
      });

      test("a request carrying a proxy's mark keeps the session's roots", async () => {
        await isolate();
        const server = await open(kind);
        const url = docUrl(join(added, "intro.md"), added);
        // Each header alone is enough: removing any one check lets its case through.
        for (const headers of <Record<string, string>[]>[
          { "x-forwarded-for": "100.101.102.103" },
          { "x-forwarded-host": "evil.example" },
          { forwarded: "for=192.0.2.1;proto=https" },
          { "x-real-ip": "192.0.2.1" },
          { "tailscale-user-login": "someone@example.com" },
        ]) {
          const answer = await get(server, url, headers);
          expect([headers, answer.status]).toEqual([headers, 403]);
          expect(JSON.stringify(answer.body)).not.toContain("ADDED-FOLDER-BODY");
        }
        const linked = await get(server, docUrl("../shared/linked.md", project), { "x-forwarded-for": "192.168.1.20" });
        // 403 where the base is a root (annotate), 404 where it is not trusted (plan).
        expect(linked.status).not.toBe(200);
        expect(JSON.stringify(linked.body)).not.toContain("LINKED-OUTSIDE-BODY");
        // A local reverse proxy (loopback hops, a loopback forwarded Host) is still this machine.
        for (const headers of <Record<string, string>[]>[
          { "x-forwarded-for": "127.0.0.1" },
          { "x-forwarded-host": "localhost:5173" },
        ]) {
          const answer = await get(server, url, headers);
          expect([headers, answer.status]).toEqual([headers, 200]);
        }
      });

      test("PLANNOTATOR_ALLOWED_HOSTS keeps the session's roots, whatever the Host", async () => {
        await isolate({ allowedHosts: "*" });
        const server = await open(kind);
        const url = docUrl(join(added, "intro.md"), added);
        const port = new URL(server.url).port;
        for (const host of ["evil.example", `127.0.0.1:${port}`]) {
          const answer = await get(server, url, { host });
          expect([host, answer.status]).toEqual([host, 403]);
          expect(JSON.stringify(answer.body)).not.toContain("ADDED-FOLDER-BODY");
        }
      });

      test("a Host that is not loopback keeps the session's roots", async () => {
        // A browser IDE's port proxy: the Host guard answers its name.
        await isolate({ proxyUri: "https://{{port}}.proxy.example/" });
        const server = await open(kind);
        const port = new URL(server.url).port;
        const url = docUrl(join(added, "intro.md"), added);
        const proxied = await get(server, url, { host: `${port}.proxy.example` });
        expect(proxied.status).toBe(403);
        expect(JSON.stringify(proxied.body)).not.toContain("ADDED-FOLDER-BODY");
        if (runtimeOptions.allowServedHost) {
          // A `--tailscale` session's served name, with no X-Forwarded-For.
          undo.push(runtimeOptions.allowServedHost("box.tail1234.ts.net"));
          const served = await get(server, url, { host: "box.tail1234.ts.net" });
          expect(served.status).toBe(403);
          expect(JSON.stringify(served.body)).not.toContain("ADDED-FOLDER-BODY");
        }
        expect((await get(server, url)).status).toBe(200);
      });

      test("a GitHub Codespace keeps the session's roots, though its forwarder sends Host: localhost", async () => {
        await isolate({ codespace: true });
        const server = await open(kind);
        const doc = await get(server, docUrl(join(added, "intro.md"), added), { host: "localhost" });
        expect(doc.status).toBe(403);
        expect(JSON.stringify(doc.body)).not.toContain("ADDED-FOLDER-BODY");
        // The document inside the session's roots still opens.
        if (kind === "annotate") expect((await get(server, docUrl(docPath, project), { host: "localhost" })).status).toBe(200);
      });

      test("remote mode keeps the session's roots", async () => {
        await isolate({ remote: true });
        const server = await open(kind);
        const doc = await get(server, docUrl(join(added, "intro.md"), added));
        expect(doc.status).toBe(403);
        expect(JSON.stringify(doc.body)).not.toContain("ADDED-FOLDER-BODY");
        const linked = await get(server, docUrl("../shared/linked.md", project));
        expect(linked.status).not.toBe(200);
        expect(JSON.stringify(linked.body)).not.toContain("LINKED-OUTSIDE-BODY");
        if (kind === "annotate") {
          // Inside the roots, a document name must still be a document.
          const inRoot = await get(server, docUrl(join(project, "key.md"), project));
          expect(inRoot.status).toBe(403);
          expect(leaks(inRoot)).toBe(false);
        }
      });
    });
  }
}
