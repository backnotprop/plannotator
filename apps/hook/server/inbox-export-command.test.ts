/**
 * `plannotator inbox export --jsonl <folder>` (inbox-export-command.ts) on a generated Inbox in a scratch data dir
 * (never the person's): the folder it writes reads, through today's JSONL store, exactly as the Inbox reads, whether
 * the Inbox still keeps its files or has moved into SQLite, and while a store holds the database open.
 * What this catches: an export that leaves out a record file or a line, a relative folder taken from somewhere
 * other than where the person runs it, an export into a folder that already holds files (two Inboxes mixed in one), and the command missing from `plannotator inbox`'s usage.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { jsonlInboxLog } from "../../../packages/shared/inbox/store-log/jsonl-log";
import { everyRead } from "../../../packages/shared/inbox/store-log/reads";
import { importJsonlInbox } from "../../../packages/shared/inbox/store-log/sqlite/import";
import { sqliteInboxLog } from "../../../packages/shared/inbox/store-log/sqlite/sqlite-log";
import { writeInboxWorld } from "../../../packages/shared/inbox/store-log/world";
import { INBOX_COMMAND_USAGE, isSubcommandHelpInvocation } from "./cli";
import { runInboxExportCommand } from "./inbox-export-command";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const SESSIONS = ["ses_world_a", "ses_world_b", "ses_world_c"];
const reads = (store: InboxStore) => everyRead(store, { sessions: SESSIONS, bytes: false });

async function run(argv: string[], dataDir: string, cwd: string, json = false) {
  let stdout = "";
  let stderr = "";
  const code = await runInboxExportCommand(argv, { dataDir, cwd, json, out: (text) => void (stdout += text), err: (text) => void (stderr += text) });
  return { code, stdout, stderr };
}

test(
  "the exported folder reads as the Inbox reads, from its files and from its database; a folder with files in it is refused",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "plannotator-inbox-export-"));
    roots.push(root);
    const dataDir = join(root, "data");
    const cwd = join(root, "here");
    mkdirSync(cwd, { recursive: true });
    const { now } = writeInboxWorld({ dataDir, seed: 21, steps: 220 });
    // Every kind of record file is there to be copied (initiatives cross projects, the seq floor outlives deletions).
    expect(readdirSync(join(dataDir, "inbox")).sort()).toEqual(expect.arrayContaining(["initiatives.jsonl", "projects", "seq.json"]));
    const fromFiles = reads(InboxStore.open(dataDir, { now }));
    // The seq floor: never handed out again after the export is read back, though no line may show it.
    const floor = readFileSync(join(dataDir, "inbox", "seq.json"), "utf8");

    // On files: a relative folder, taken from where it runs.
    const first = await run(["--jsonl", "copy"], dataDir, cwd);
    expect(first).toMatchObject({ code: 0, stderr: "" });
    expect(first.stdout).toContain(`from the Inbox files to ${join(cwd, "copy")}`);
    expect(reads(InboxStore.open(dataDir, { now, log: () => jsonlInboxLog(join(cwd, "copy")) }))).toEqual(fromFiles);
    expect(readFileSync(join(cwd, "copy", "seq.json"), "utf8")).toBe(floor);

    // Moved into SQLite, with a store holding the database open (a running Inbox): the export reads the database.
    expect((await importJsonlInbox(dataDir, { now })).status).toBe("imported");
    const live = InboxStore.open(dataDir, { now, log: sqliteInboxLog });
    const second = await run(["--jsonl", join(root, "from-db")], dataDir, cwd, true);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({ folder: join(root, "from-db"), from: "database" });
    expect(reads(InboxStore.open(dataDir, { now, log: () => jsonlInboxLog(join(root, "from-db")) }))).toEqual(reads(live));
    expect(reads(live)).toEqual(fromFiles);
    expect(JSON.parse(readFileSync(join(root, "from-db", "seq.json"), "utf8"))).toEqual(JSON.parse(floor));

    // A folder that already holds something: refused, and left as it was.
    const taken = join(root, "taken");
    mkdirSync(taken);
    writeFileSync(join(taken, "notes.txt"), "mine");
    const refused = await run(["--jsonl", taken], dataDir, cwd);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toStartWith("not_empty: ");
    expect(readdirSync(taken)).toEqual(["notes.txt"]);

    expect((await run([], dataDir, cwd)).code).toBe(2);
    expect((await run(["--jsonl"], dataDir, cwd)).code).toBe(2);
  },
  120_000,
);

test("export is in plannotator inbox's usage, and its --help is its own", () => {
  expect(INBOX_COMMAND_USAGE).toContain("plannotator inbox export --jsonl <folder>");
  expect(isSubcommandHelpInvocation(["inbox", "export", "--help"])).toBeNull();
});
