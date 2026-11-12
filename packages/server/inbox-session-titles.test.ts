/**
 * A poll's generated title reaches `session_titles` for list rows, never `session_labels` (which every other place
 * shows), follows each poll, and clears.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const restore of restoreEnv.splice(0).reverse()) restore();
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

describe("a poll's generated title", () => {
  async function setup() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-session-titles-")));
    roots.push(root);
    const project = join(root, "plannotator");
    mkdirSync(project, { recursive: true });
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    setEnv("PLANNOTATOR_DATA_DIR", dataDir);
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ updateCheck: false }));
    const server = await startInboxServer({ dataDir, binaryPath: null });
    servers.push(server);
    return { server, project };
  }

  async function poll(server: InboxServer, session: string, project: string, fields: Record<string, unknown>) {
    const response = await fetch(`http://127.0.0.1:${server.port}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify({ session, host: "claude-code", waitMs: 0, project_path: project, started_at: Date.now(), busy: false, ...fields }),
    });
    expect(response.status).toBe(200);
  }

  async function list(server: InboxServer) {
    const origin = `http://127.0.0.1:${server.port}`;
    return (await (await fetch(`${origin}/api/inbox/threads`, { headers: { Origin: origin } })).json()) as { session_labels: Record<string, string>; session_titles: Record<string, string> };
  }

  test("reaches session_titles, never session_labels; it follows each poll and clears; a title reading 'You' is refused", async () => {
    const { server, project } = await setup();
    await poll(server, "ses-a", project, { label: "", title: "Plannotator usage reference" });
    await poll(server, "ses-b", project, { label: "release 0.28.61", title: "Release notes draft" });
    await poll(server, "ses-c", project, { title: "You" });
    let model = await list(server);
    expect(model.session_titles).toEqual({ "ses-a": "Plannotator usage reference", "ses-b": "Release notes draft" });
    expect(model.session_labels).toEqual({ "ses-b": "release 0.28.61" });

    await poll(server, "ses-a", project, { label: "", title: "Usage reference, take two" });
    await poll(server, "ses-b", project, { label: "release 0.28.61" });
    model = await list(server);
    expect(model.session_titles).toEqual({ "ses-a": "Usage reference, take two" });
  });
});
