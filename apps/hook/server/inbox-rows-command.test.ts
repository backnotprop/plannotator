/**
 * `plannotator inbox rows …` (inbox-rows-command.ts) against a stand-in for the Inbox's settings route (a local
 * listener that keeps a look in memory; no Inbox is started, nothing is read from the person's data).
 * What this catches: the command reaching any setting but rows (it must send only `rows`, `rows_by`, `rows_undo`); a
 * change sent without who made it, so the window cannot say "<agent> changed"; a refused value that still saves;
 * a set that changes nothing writing anyway (a pointless Undo step); undo's answer read as a change when there was
 * nothing to put back; usage mistakes that exit 0; the command missing from `plannotator inbox`'s usage (the guide's
 * section is inbox-help.test.ts's).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { INBOX_ROWS_USAGE, INBOX_ROWS_USAGE_LINE, INBOX_ROWS_WORDS } from "@plannotator/core/inbox-types";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { INBOX_COMMAND_USAGE, isSubcommandHelpInvocation } from "./cli";
import { parseRowsCommand, runInboxRowsCommand } from "./inbox-rows-command";

let rows: string[] | null = null;
let prev: string[] | null = null;
const posts: Record<string, unknown>[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/api/inbox/settings") return new Response("no", { status: 404 });
      if (req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        posts.push(body);
        if (body.rows_undo === true) {
          const undone = prev !== null && prev.join() !== (rows ?? []).join();
          if (undone) [rows, prev] = [prev, rows ?? ["smallNames"]];
          return Response.json({ rows, rows_undone: undone });
        }
        prev = rows ?? ["smallNames"];
        rows = body.rows as string[];
      }
      return Response.json({ rows });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  rows = null;
  prev = null;
  posts.length = 0;
});

async function run(argv: string[], by: { host: string; session: string } | null = { host: "claude-code", session: "ses_1" }, json = false) {
  let out = "";
  let err = "";
  const code = await runInboxRowsCommand(argv, { json, by, ensureRunning: async () => ({ port: server.port }) as InboxRegistryEntry, out: (text) => void (out += text), err: (text) => void (err += text) });
  return { code, out, err };
}

describe("plannotator inbox rows", () => {
  test("lists the look as the windows read it (never saved: the defaults) and writes nothing", async () => {
    const { code, out } = await run([]);
    expect([code, posts.length, out.startsWith(INBOX_ROWS_WORDS.listHead), out.includes("\nnew-threads=bold "), out.includes("\nlook=balanced ")]).toEqual([0, 0, true, true, true]);
    const json = JSON.parse((await run([], null, true)).out) as { options: { name: string; value: string }[]; look: string };
    expect([json.look, json.options.find((option) => option.name === "spacing")!.value]).toEqual(["balanced", "comfortable"]);
  });

  test("set: one save of rows only, with who made it, and before -> after in the page's words", async () => {
    const { code, out } = await run(["set", "spacing=compact", "time=ago"]);
    expect([code, posts]).toEqual([0, [{ rows: ["compact", "smallNames", "relativeTime"], rows_by: { host: "claude-code", session: "ses_1" } }]]);
    expect(out).toBe(`${INBOX_ROWS_WORDS.changedHead}\n  Spacing: Comfortable -> Compact\n  Time: 9:12 PM -> 10m ago\n${INBOX_ROWS_WORDS.changedFoot}\n`);
    // A shell that names no session still works; the save carries no one.
    await run(["set", "spacing=roomy"], null);
    expect(posts.at(-1)).toEqual({ rows: ["smallNames", "roomy", "relativeTime"] });
  });

  test("a refused name or value saves nothing and exits 1; a set that changes nothing does not write", async () => {
    for (const pairs of [["spacing=compact", "density=1"], ["spacing=tight"], ["time=ago", "time=clock"]]) {
      const { code, err } = await run(["set", ...pairs]);
      expect([pairs, code, err.startsWith("validation_error: "), err.trimEnd().endsWith("Nothing changed.")]).toEqual([pairs, 1, true, true]);
    }
    const same = await run(["set", "spacing=comfortable", "look=balanced"]);
    expect([same.code, same.out, posts.length]).toEqual([0, `${INBOX_ROWS_WORDS.nothingChanged}\n`, 0]);
  });

  test("undo puts the last change back and says what moved; with nothing to put back it says so", async () => {
    expect((await run(["undo"])).out).toBe(`${INBOX_ROWS_WORDS.nothingToUndo}\n`);
    await run(["set", "pull-requests=off"]);
    const undone = await run(["undo"]);
    expect([undone.code, undone.out, rows, posts.at(-1)]).toEqual([0, `${INBOX_ROWS_WORDS.undoneHead}\n  Pull requests: off -> on\n`, ["smallNames"], { rows_undo: true, rows_by: { host: "claude-code", session: "ses_1" } }]);
  });

  test("usage: bad commands exit 2 with the usage, --help prints it, and the Inbox's usage names the command", async () => {
    expect(parseRowsCommand(["set"]).ok).toBe(false);
    expect(parseRowsCommand(["undo", "now"]).ok).toBe(false);
    const wrong = await run(["reset"]);
    expect([wrong.code, wrong.err.includes(INBOX_ROWS_USAGE), posts.length]).toEqual([2, true, 0]);
    expect((await run(["--help"])).out).toBe(`${INBOX_ROWS_USAGE}\n`);
    // `inbox rows --help` is the command's own usage, not the whole guide.
    expect(isSubcommandHelpInvocation(["inbox", "rows", "--help"])).toBeNull();
    expect(INBOX_COMMAND_USAGE).toContain(INBOX_ROWS_USAGE_LINE);
  });
});
