/**
 * The Files sidebar and Obsidian routes (`/api/reference/files`,
 * `/api/reference/files/stream`, `/api/reference/obsidian/files`,
 * `/api/reference/obsidian/doc`, `/api/obsidian/vaults`), driven over HTTP
 * against real plan and annotate servers. Shared by the Bun suite
 * (reference-readers.test.ts) and the Pi mirror
 * (apps/pi-extension/server/reference-readers.test.ts).
 *
 * Another site's page is refused on every one of them. A page on this machine
 * lists any folder and vault, as before; every reader that may be on another
 * machine (remote mode, a proxy's mark) lists only the session's roots and the
 * vaults Obsidian itself lists here. For every reader, a vault document must
 * be inside the vault after symlink resolution, be Markdown by its real path
 * and fit the 2MB cap.
 *
 * Every test runs under a temp PLANNOTATOR_DATA_DIR and HOME; nothing touches
 * the real ~/.plannotator or the real Obsidian config.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { closeServer, occupyConsecutivePorts } from "../../tests/helpers/ports";

export interface ReferenceScenarioServer {
  url: string;
  stop: () => void;
}

export type ReferenceScenarioKind = "plan" | "annotate";

export type StartReferenceScenarioServer = (
  kind: ReferenceScenarioKind,
  options: { docPath: string; htmlContent: string },
) => Promise<ReferenceScenarioServer>;

const HTML = "<!doctype html><html><body>reference-readers-app</body></html>";

interface Answer {
  status: number;
  body: Record<string, unknown> | null;
  text: string;
}

/** One request; a stream is read only until its first event, then dropped. */
function get(server: ReferenceScenarioServer, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  const port = new URL(server.url).port;
  return new Promise((resolve, reject) => {
    const req = request(
      `http://127.0.0.1:${port}${path}`,
      { method: "GET", headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        const finish = () => {
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, text: raw });
        };
        if (String(res.headers["content-type"] ?? "").includes("text/event-stream")) {
          res.once("data", (chunk) => {
            raw += chunk;
            req.destroy();
            finish();
          });
          return;
        }
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", finish);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const q = (value: string) => encodeURIComponent(value);
const SECRET = /SECRET-/;

export function defineReferenceReaderScenarios(runtime: string, start: StartReferenceScenarioServer): void {
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
      "CODESPACES",
      "SSH_TTY",
      "SSH_CONNECTION",
    ],
    "plannotator-reference-readers-",
  );

  let home = "";
  let project = "";
  let docPath = "";
  /** A folder outside the session's roots (the person's home, say). */
  let elsewhere = "";
  /** A vault Obsidian lists in its own config on this machine. */
  let vault = "";
  /** A folder named as a vault that Obsidian does not list. */
  let stranger = "";
  const servers: ReferenceScenarioServer[] = [];

  async function isolate(options: { remote?: boolean; codespace?: boolean } = {}): Promise<void> {
    environment.reset();
    const dir = realpathSync(environment.makeTempDir());
    home = join(dir, "home");
    process.env.HOME = home;
    process.env.PLANNOTATOR_DATA_DIR = join(dir, "data");
    process.env.PLANNOTATOR_AI = "disabled";
    process.env.PLANNOTATOR_INBOX_CONNECT = "0";
    process.env.PLANNOTATOR_REMOTE = options.remote ? "1" : "0";
    if (options.codespace) process.env.CODESPACES = "true";
    else delete process.env.CODESPACES;
    if (options.remote) {
      // Remote mode would otherwise bind the fixed 19432.
      const { start: port, servers: held } = await occupyConsecutivePorts(1);
      await closeServer(held[0]);
      process.env.PLANNOTATOR_PORT = String(port);
    }
    project = join(dir, "demo-app");
    elsewhere = join(home, "private");
    vault = join(dir, "vault");
    stranger = join(home, "stranger-vault");
    for (const folder of [project, elsewhere, join(vault, "notes"), stranger, join(home, ".ssh")]) {
      mkdirSync(folder, { recursive: true });
    }
    docPath = join(project, "notes.md");
    writeFileSync(docPath, "# Notes\n\nPROJECT-BODY\n");
    writeFileSync(join(project, "guide.md"), "# Guide\n\nPROJECT-GUIDE\n");
    writeFileSync(join(elsewhere, "diary.md"), "# Diary\n\nSECRET-DIARY\n");
    writeFileSync(join(vault, "notes/idea.md"), "# Idea\n\nVAULT-BODY\n");
    writeFileSync(join(stranger, "plans.md"), "# Plans\n\nSECRET-STRANGER\n");
    writeFileSync(join(home, ".ssh/id_ed25519"), "SECRET-SSH-KEY\n");
    writeFileSync(join(vault, "notes/creds.txt"), "SECRET-VAULT-TXT\n");
    writeFileSync(join(vault, "big.md"), `# Big\n\n${"x".repeat(2 * 1024 * 1024 + 16)}\n`);
    // Vault document names whose real file is outside the vault or not Markdown.
    symlinkSync(join(home, ".ssh/id_ed25519"), join(vault, "key.md"));
    symlinkSync(join(elsewhere, "diary.md"), join(vault, "diary.md"));
    symlinkSync(join(vault, "notes/creds.txt"), join(vault, "creds.md"));
    // Obsidian's own vault list, where detectObsidianVaults reads it.
    const config = JSON.stringify({ vaults: { a: { path: vault } } });
    for (const configDir of [join(home, "Library/Application Support/obsidian"), join(home, ".config/obsidian")]) {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "obsidian.json"), config);
    }
  }

  async function open(kind: ReferenceScenarioKind): Promise<ReferenceScenarioServer> {
    const server = await start(kind, { docPath, htmlContent: HTML });
    servers.push(server);
    return server;
  }

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
    environment.restore();
  });

  const FORWARDED = { "x-forwarded-for": "192.0.2.10" };

  for (const kind of ["plan", "annotate"] as const) {
    describe(`${runtime} ${kind} server: Files sidebar and Obsidian readers`, () => {
      test("refuses another site's page on every route", async () => {
        await isolate();
        const server = await open(kind);
        const routes = [
          "/api/obsidian/vaults",
          `/api/reference/files?dirPath=${q(elsewhere)}`,
          `/api/reference/files/stream?dirPath=${q(elsewhere)}`,
          `/api/reference/obsidian/files?vaultPath=${q(vault)}`,
          `/api/reference/obsidian/doc?vaultPath=${q(vault)}&path=${q("notes/idea.md")}`,
        ];
        for (const path of routes) {
          for (const headers of <Record<string, string>[]>[
            { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
            { origin: "https://evil.example" },
            { "sec-fetch-site": "same-site" },
          ]) {
            const answer = await get(server, path, headers);
            expect([path, headers, answer.status]).toEqual([path, headers, 403]);
            expect(answer.body?.code).toBe("cross_origin");
            expect(answer.text).not.toContain(vault);
          }
          // The session's own page still reads it.
          expect([path, (await get(server, path, { "sec-fetch-site": "same-origin" })).status]).toEqual([path, 200]);
        }
      });

      test("a page on this machine lists any folder and vault, as before", async () => {
        await isolate();
        const server = await open(kind);
        const folder = await get(server, `/api/reference/files?dirPath=${q(elsewhere)}`);
        expect(folder.status).toBe(200);
        expect(folder.text).toContain("diary.md");
        const strangerVault = await get(server, `/api/reference/obsidian/files?vaultPath=${q(stranger)}`);
        expect(strangerVault.status).toBe(200);
        expect(strangerVault.text).toContain("plans.md");
        const doc = await get(server, `/api/reference/obsidian/doc?vaultPath=${q(stranger)}&path=plans.md`);
        expect(doc.status).toBe(200);
        expect(String(doc.body?.markdown)).toContain("SECRET-STRANGER");
        expect((await get(server, `/api/reference/files/stream?dirPath=${q(elsewhere)}`)).status).toBe(200);
      });

      for (const mode of ["forwarded", "remote", "codespace"] as const) {
        test(`a ${mode} reader lists only the session's roots and the vaults Obsidian lists`, async () => {
          await isolate({ remote: mode === "remote", codespace: mode === "codespace" });
          const server = await open(kind);
          const headers = mode === "forwarded" ? FORWARDED : {};
          for (const path of [
            `/api/reference/files?dirPath=${q(elsewhere)}`,
            `/api/reference/files?dirPath=${q(home)}`,
            `/api/reference/files/stream?dirPath=${q(elsewhere)}`,
            `/api/reference/files/stream?filePath=${q(join(elsewhere, "diary.md"))}`,
            `/api/reference/obsidian/files?vaultPath=${q(stranger)}`,
            `/api/reference/obsidian/doc?vaultPath=${q(stranger)}&path=plans.md`,
          ]) {
            const answer = await get(server, path, headers);
            expect([path, answer.status]).toEqual([path, 403]);
            expect(answer.text).not.toMatch(/diary|plans\.md|SECRET-/);
          }
          // A vault Obsidian lists on this machine still opens.
          const listed = await get(server, `/api/reference/obsidian/files?vaultPath=${q(vault)}`, headers);
          expect(listed.status).toBe(200);
          expect(listed.text).toContain("idea.md");
          const doc = await get(server, `/api/reference/obsidian/doc?vaultPath=${q(vault)}&path=${q("notes/idea.md")}`, headers);
          expect(doc.status).toBe(200);
          expect(String(doc.body?.markdown)).toContain("VAULT-BODY");
          if (kind === "annotate") {
            // The session's own roots still list.
            const own = await get(server, `/api/reference/files?dirPath=${q(project)}`, headers);
            expect(own.status).toBe(200);
            expect(own.text).toContain("guide.md");
            expect((await get(server, `/api/reference/files/stream?dirPath=${q(project)}`, headers)).status).toBe(200);
          }
        });
      }

      test("a vault document must be a Markdown file inside the vault and fit 2MB", async () => {
        await isolate();
        const server = await open(kind);
        for (const [path, status] of [
          ["key.md", 403],
          ["creds.md", 403],
          ["../home/private/diary.md", 403],
          ["big.md", 413],
        ] as const) {
          const answer = await get(server, `/api/reference/obsidian/doc?vaultPath=${q(vault)}&path=${q(path)}`);
          expect([path, answer.status]).toEqual([path, status]);
          expect(SECRET.test(answer.text)).toBe(false);
          expect(answer.text).not.toContain("xxxxxxxx");
        }
        // A forwarded reader of a listed vault gets the same refusals.
        const forwarded = await get(server, `/api/reference/obsidian/doc?vaultPath=${q(vault)}&path=key.md`, FORWARDED);
        expect(forwarded.status).toBe(403);
        expect(SECRET.test(forwarded.text)).toBe(false);
      });

      test("a symlink out of the vault opens for a page on this machine only", async () => {
        await isolate();
        const server = await open(kind);
        const url = `/api/reference/obsidian/doc?vaultPath=${q(vault)}&path=diary.md`;
        const local = await get(server, url);
        expect(local.status).toBe(200);
        expect(String(local.body?.markdown)).toContain("SECRET-DIARY");
        const forwarded = await get(server, url, FORWARDED);
        expect(forwarded.status).toBe(403);
        expect(SECRET.test(forwarded.text)).toBe(false);
      });

      test("a FIFO named .md in a vault is refused without blocking the server", async () => {
        await isolate();
        execFileSync("mkfifo", [join(vault, "fifo.md")]);
        const server = await open(kind);
        for (const headers of [{}, FORWARDED]) {
          const answer = await get(server, `/api/reference/obsidian/doc?vaultPath=${q(vault)}&path=fifo.md`, headers);
          expect(answer.status).toBe(403);
        }
        // The server still answers the next request.
        const next = await get(server, `/api/reference/obsidian/doc?vaultPath=${q(vault)}&path=${q("notes/idea.md")}`);
        expect(next.status).toBe(200);
      });
    });
  }
}
