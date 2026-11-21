/**
 * `plannotator routine …` (routine-command.ts) without an Inbox: how options become the `routine` tool's arguments,
 * what is refused as bad usage before anything is sent, where each help is reached from, and what reaches stdout and
 * stderr. The calls go to a stand-in `/mcp` in this process that records them and answers as the tool does, so no
 * Inbox, agent or routine is ever started. routine-command-cli.test.ts runs the command against a real sandboxed Inbox.
 *
 * What can regress: a flag filling the wrong field (or none), a relative folder or file reaching the server as typed,
 * a help that no longer names an option the parser takes, the lineage from `plannotator inbox --help` breaking, the
 * command's ops drifting from the tool's, a refusal printed as a result, or text mode and --json swapped.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SCHEDULED_THREAD_OPS } from "../../../packages/server/inbox-mcp-scheduled";
import { createAgentEnvironmentFor } from "@plannotator/server/inbox-agents";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { formatTopLevelHelp, ROUTINE_COMMAND_USAGE, ROUTINE_OP_USAGE, ROUTINE_OPS, SUBCOMMAND_HELP } from "./cli";
import { CREATE_ROUTINE_SKILL } from "@plannotator/core/create-routine-skill";
import { formatInboxHelp, INBOX_ROUTINE_COMMAND_LINE } from "./inbox-help";
import { parseRoutineCommand, ROUTINE_AGENT_HINT, ROUTINE_OP_FLAGS, runRoutineCommand } from "./routine-command";

const CWD = "/work/acme-api";
const HOME = "/home/maya";
const parse = (argv: string[]) => parseRoutineCommand(argv, CWD, HOME);
const call = (argv: string[]) => {
  const parsed = parse(argv);
  if (parsed.kind !== "call") throw new Error(`not a call: ${JSON.stringify(parsed)}`);
  return parsed;
};
const usage = (argv: string[]) => {
  const parsed = parse(argv);
  if (parsed.kind !== "usage") throw new Error(`not refused: ${JSON.stringify(parsed)}`);
  return parsed.error;
};

describe("options become the routine tool's fields", () => {
  test("create: every option fills its field; folder and files are made whole from the shell's folder and home", () => {
    const parsed = call([
      "create",
      "--name", "Dependency check",
      "--prompt", "Check for outdated dependencies.",
      "--cron", "0 9 * * 1-5",
      "--tz", "America/New_York",
      "--if-missed", "skip",
      "--folder", "../acme-web",
      "--agent", "codex",
      "--model", "gpt-5",
      "--effort", "high",
      "--file", "notes/deps.md",
      "--file", "~/checklists/deps.md",
      "--thread", "thr_1",
    ]);
    expect(parsed.args).toEqual({
      op: "create",
      name: "Dependency check",
      prompt: "Check for outdated dependencies.",
      schedule: { cron: "0 9 * * 1-5", tz: "America/New_York" },
      if_missed: "skip",
      folder: { path: "/work/acme-web" },
      agent: "codex",
      model: "gpt-5",
      effort: "high",
      attachments: ["/work/acme-api/notes/deps.md", "/home/maya/checklists/deps.md"],
      thread_id: "thr_1",
    });
    expect(parsed).toMatchObject({ promptFromStdin: false, json: false, session: null });
  });

  test("create sends only what was given: no schedule is no schedule field, so the server's default (none) holds", () => {
    expect(call(["create", "--name", "Ad hoc", "--prompt", "Tidy the notes."]).args).toEqual({ op: "create", name: "Ad hoc", prompt: "Tidy the notes." });
    expect(call(["create", "--name", "Once", "--prompt", "p", "--at", "2099-11-20T17:00"]).args.schedule).toEqual({ at: "2099-11-20T17:00" });
    expect(call(["create", "--name", "Scratch", "--prompt", "p", "--scratch"]).args.folder).toEqual({ scratch: true });
    expect(call(["create", "--name", "Home", "--prompt", "p", "--folder", "~"]).args.folder).toEqual({ path: HOME });
  });

  test("--prompt - reads the prompt from stdin: no prompt field until it is read", () => {
    const parsed = call(["create", "--name", "Notes", "--prompt", "-"]);
    expect(parsed.promptFromStdin).toBe(true);
    expect("prompt" in parsed.args).toBe(false);
  });

  test("update clears with --no-schedule, --no-files and an empty --model, and sends only what changed", () => {
    expect(call(["update", "sch_1", "--no-schedule"]).args).toEqual({ op: "update", id: "sch_1", schedule: null });
    expect(call(["update", "sch_1", "--no-files"]).args).toEqual({ op: "update", id: "sch_1", attachments: [] });
    expect(call(["update", "sch_1", "--model", ""]).args).toEqual({ op: "update", id: "sch_1", model: "" });
    expect(call(["update", "sch_1", "--cron", "0 7 * * *"]).args).toEqual({ op: "update", id: "sch_1", schedule: { cron: "0 7 * * *" } });
  });

  test("the other commands take an id, --thread, --json and --session", () => {
    expect(call(["list"]).args).toEqual({ op: "list" });
    expect(call(["get", "sch_1", "--json"])).toMatchObject({ args: { op: "get", id: "sch_1" }, json: true });
    for (const op of ["on", "off", "run", "delete"]) {
      expect(call([op, "sch_1", "--thread", "thr_9", "--session", "claude-code:ses_a"])).toMatchObject({ args: { op, id: "sch_1", thread_id: "thr_9" }, session: "claude-code:ses_a" });
    }
  });

  test("the routine tool's fields as one JSON object stand in for options, with the command's op", () => {
    expect(call(["update", '{"id":"sch_1","name":"Nightly check"}', "--json"])).toMatchObject({ args: { op: "update", id: "sch_1", name: "Nightly check" }, json: true });
    expect(call(["list", "{}"]).args).toEqual({ op: "list" });
    expect(usage(["update", '{"op":"delete","id":"sch_1"}'])).toContain("op");
    expect(usage(["update", '{"id":"sch_1"}', "--name", "x"])).toContain("not both");
    expect(usage(["update", "{nope"])).toContain("JSON");
  });

  test("the JSON object's folder and files are made whole as the options' are; a value the tool must refuse is left as is", () => {
    expect(call(["create", '{"name":"n","prompt":"p","folder":{"path":"../acme-web"},"attachments":["notes/deps.md","~/a.md"]}']).args).toMatchObject({
      folder: { path: "/work/acme-web" },
      attachments: ["/work/acme-api/notes/deps.md", "/home/maya/a.md"],
    });
    expect(call(["update", '{"id":"sch_1","folder":{"scratch":true},"attachments":[3]}']).args).toMatchObject({ folder: { scratch: true }, attachments: [3] });
  });
});

describe("bad usage is refused before anything is sent", () => {
  test("each refusal names what is wrong", () => {
    expect(usage(["make"])).toContain("not a routine command");
    expect(usage(["--json", "list"])).toContain("comes after the command");
    expect(usage(["get"])).toContain("routine id");
    expect(usage(["get", "sch_1", "sch_2"])).toContain("one routine id");
    expect(usage(["create", "--name", "x", "Check deps"])).toContain("--prompt");
    expect(usage(["list", "--cron", "0 9 * * *"])).toContain("does not take --cron");
    expect(usage(["on", "sch_1", "--name", "x"])).toContain("does not take --name");
    expect(usage(["create", "--no-schedule"])).toContain("does not take --no-schedule");
    expect(usage(["create", "--name"])).toContain("takes a value");
    expect(usage(["create", "--name", "a", "--name", "b"])).toContain("given twice");
    expect(usage(["create", "--cron", "0 9 * * *", "--at", "2099-11-20T17:00"])).toContain("one of --cron, --at");
    expect(usage(["update", "sch_1", "--tz", "Europe/Paris"])).toContain("--tz goes with");
    expect(usage(["create", "--folder", ".", "--scratch"])).toContain("not both");
    expect(usage(["update", "sch_1", "--file", "a.md", "--no-files"])).toContain("not both");
    expect(usage(["create", "--every", "day"])).toContain("Unknown routine option");
  });

  test("a value that looks like a flag is still the value, and --help after a value-flag is that value", () => {
    expect(call(["create", "--name", "-h", "--prompt", "--help"]).args).toMatchObject({ name: "-h", prompt: "--help" });
  });
});

describe("help", () => {
  test("bare, --help and -h give the overview; <command> --help gives that command's", () => {
    for (const argv of [[], ["--help"], ["-h"]]) expect(parse(argv)).toEqual({ kind: "help", text: ROUTINE_COMMAND_USAGE });
    for (const op of ROUTINE_OPS) {
      expect(parse([op, "--help"])).toEqual({ kind: "help", text: ROUTINE_OP_USAGE[op] });
      expect(parse([op, "sch_1", "--cron", "x", "-h"])).toEqual({ kind: "help", text: ROUTINE_OP_USAGE[op] });
    }
  });

  test("the command's ops are the routine tool's ops", () => {
    expect([...ROUTINE_OPS]).toEqual([...SCHEDULED_THREAD_OPS]);
  });

  test("the overview has a usage line for every command and points at each command's own help", () => {
    for (const op of ROUTINE_OPS) expect(ROUTINE_COMMAND_USAGE).toMatch(new RegExp(`^  plannotator routine ${op}\\b`, "m"));
    expect(ROUTINE_COMMAND_USAGE).toContain("plannotator routine <command> --help");
    expect(SUBCOMMAND_HELP.routine).toBe(ROUTINE_COMMAND_USAGE);
  });

  test("every option a command takes is in its own help (update's through create's), and every help names --json and --session", () => {
    for (const op of ROUTINE_OPS) {
      const help = op === "update" ? `${ROUTINE_OP_USAGE.update}\n${ROUTINE_OP_USAGE.create}` : ROUTINE_OP_USAGE[op];
      for (const flag of ROUTINE_OP_FLAGS[op]) expect({ op, flag, named: help.includes(flag) }).toEqual({ op, flag, named: true });
      expect(ROUTINE_COMMAND_USAGE).toContain("--json");
      expect(ROUTINE_COMMAND_USAGE).toContain("--session <id>");
      expect(ROUTINE_OP_USAGE[op]).toContain("'plannotator routine --help'");
    }
    // And every example in a help parses as a call: an example that no longer runs would teach a broken command.
    let examples = 0;
    for (const op of ROUTINE_OPS) {
      // A line ending in a backslash goes on in the next one, as in a shell.
      for (const line of ROUTINE_OP_USAGE[op].replace(/ \\\n\s+/g, " ").split("\n")) {
        const example = /^ {2}plannotator routine (create|update|get) (.+)$/.exec(line);
        if (!example || example[2]!.includes("<")) continue;
        examples++;
        const words = [...example[2]!.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
        expect({ line, parsed: parse([example[1]!, ...words]).kind }).toEqual({ line, parsed: "call" });
      }
    }
    // A placeholder line (`--at <YYYY-MM-DDTHH:MM>`) is not counted: a dated example would go stale.
    expect(examples).toBeGreaterThanOrEqual(3);
  });

  test("the lineage: plannotator inbox --help names the command with Routines on or off (not on Windows), and its help says who turns them on", () => {
    const home = join(tmpdir(), "plannotator-routine-help-no-home");
    const guide = (scheduled: boolean, platform: "linux" | "mac" | "windows" = "linux") =>
      formatInboxHelp({ command: ["plannotator"], dataDir: "/home/someone/.plannotator", platform, scheduled, agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: { HOME: home, PATH: "" } }) });
    for (const scheduled of [true, false]) {
      expect(guide(scheduled).split("\n")).toContain(INBOX_ROUTINE_COMMAND_LINE);
      expect(guide(scheduled, "mac").split("\n")).toContain(INBOX_ROUTINE_COMMAND_LINE);
    }
    // Windows has no routines, so its help is never asked with them on.
    expect(guide(false, "windows")).not.toContain("plannotator routine");
    expect(INBOX_ROUTINE_COMMAND_LINE).toContain("plannotator routine --help");
    // Off, only that line: the routine section and the command's ops stay hidden.
    expect(guide(true)).toContain("`plannotator routine --help`");
    expect(guide(false)).not.toContain("`plannotator routine --help`");
    expect(guide(false)).not.toContain("plannotator routine create");
    expect(ROUTINE_COMMAND_USAGE).toContain("Settings → Capabilities");
    expect(formatTopLevelHelp({ scheduled: true })).toContain("plannotator routine --help");
    expect(formatTopLevelHelp({ scheduled: false })).not.toContain("plannotator routine");
    expect(formatTopLevelHelp()).not.toContain("plannotator routine");
  });

  test("a heredoc example in a help runs as printed: copied into a shell, its prompt is read whole and its EOF closes it", async () => {
    let heredocs = 0;
    for (const op of ROUTINE_OPS) {
      const lines = ROUTINE_OP_USAGE[op].split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]!.endsWith("<<'EOF'")) continue;
        let start = i;
        while (start > 0 && lines[start - 1]!.endsWith("\\")) start--;
        const end = lines.indexOf("EOF", i);
        expect({ op, closes: end > i }).toEqual({ op, closes: true });
        const example = lines.slice(start, end + 1).join("\n");
        const body = lines.slice(i + 1, end).join("\n");
        // `plannotator` here prints its stdin, so what the shell reads as the prompt is what comes back.
        const shell = Bun.spawn(["/bin/sh", "-c", `plannotator() { cat; }\n${example}\necho END`], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
        expect({ op, out: await new Response(shell.stdout).text() }).toEqual({ op, out: `${body}\nEND\n` });
        heredocs++;
      }
    }
    expect(heredocs).toBeGreaterThanOrEqual(2);
  });

  test("every command in the Inbox's /create-routine skill parses as a call, with flags its command takes", () => {
    const blocks = [...CREATE_ROUTINE_SKILL.body.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
    let commands = 0;
    for (const block of blocks) {
      for (const line of block.replace(/ \\\n\s+/g, " ").split("\n")) {
        const command = /^plannotator routine (\S+)(.*)$/.exec(line);
        if (!command) continue;
        const rest = command[2]!.replace(/ <<'EOF'$/, "");
        if (rest.includes("<")) {
          // A template line: its flags are still the command's.
          for (const flag of rest.match(/--[a-z-]+/g) ?? []) expect({ line, flag, takes: (ROUTINE_OP_FLAGS as Record<string, readonly string[]>)[command[1]!]?.includes(flag) }).toEqual({ line, flag, takes: true });
          continue;
        }
        const words = [...rest.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]!);
        expect({ line, parsed: parse([command[1]!, ...words]).kind }).toEqual({ line, parsed: "call" });
        commands++;
      }
    }
    expect(commands).toBeGreaterThanOrEqual(1);
    // Its one create names the thread, so the routine it makes is the one the person's Send turned on.
    expect(blocks.join("\n")).toMatch(/plannotator routine create .*--thread \S+/);
  });
});

describe("runRoutineCommand", () => {
  type Seen = { name: string; arguments: Record<string, unknown> };
  const servers: { stop: (force?: boolean) => void }[] = [];
  afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
  });

  /** A stand-in for the Inbox's /mcp: records each tools/call and answers with `answer`. */
  function standIn(answer: (seen: Seen) => { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }) {
    const seen: Seen[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { id: number; params: Seen };
        seen.push(body.params);
        return Response.json({ jsonrpc: "2.0", id: body.id, result: answer(body.params) });
      },
    });
    servers.push(server);
    const entry = { port: server.port } as InboxRegistryEntry;
    return { seen, entry };
  }

  function run(argv: string[], stand: ReturnType<typeof standIn> | null, stdin = "") {
    const out: string[] = [];
    const err: string[] = [];
    let started = 0;
    const code = runRoutineCommand(argv, {
      cwd: CWD,
      env: {},
      ensureRunning: async () => {
        started++;
        if (!stand) throw new Error("no Inbox in this test");
        return stand.entry;
      },
      stdin: async () => stdin,
      out: (text) => void out.push(text),
      err: (text) => void err.push(text),
    });
    return code.then((exit) => ({ exit, out: out.join(""), err: err.join(""), started }));
  }

  test("help answers on stdout with exit 0 and starts no Inbox; bare is the overview on stderr, exit 2", async () => {
    expect(await run(["create", "--help"], null)).toEqual({ exit: 0, out: `${ROUTINE_OP_USAGE.create}\n`, err: "", started: 0 });
    expect(await run([], null)).toEqual({ exit: 2, out: "", err: `${ROUTINE_COMMAND_USAGE}\n`, started: 0 });
  });

  test("bad usage exits 2 with one usage line and the help to read, and starts no Inbox", async () => {
    const refused = await run(["get"], null);
    expect(refused).toMatchObject({ exit: 2, out: "", started: 0 });
    expect(refused.err).toStartWith("usage: routine get takes a routine id");
    expect(refused.err).toContain("Run 'plannotator routine get --help'");
  });

  test("a call sends the routine tool its fields, prints the tool's lines, and with --json its structured result", async () => {
    const stand = standIn(() => ({ content: [{ type: "text", text: 'Made sch_1 "Dependency check": off.' }], structuredContent: { scheduled: { id: "sch_1", enabled: false } } }));
    const made = await run(["create", "--name", "Dependency check", "--cron", "0 9 * * 1-5", "--prompt", "-"], stand, "Check for outdated dependencies.\n");
    expect(made).toMatchObject({ exit: 0, out: 'Made sch_1 "Dependency check": off.\n', err: "" });
    expect(stand.seen[0]!.name).toBe("routine");
    expect(stand.seen[0]!.arguments).toMatchObject({ op: "create", name: "Dependency check", schedule: { cron: "0 9 * * 1-5" }, prompt: "Check for outdated dependencies.\n", project_path: CWD });
    const listed = await run(["list", "--json"], stand);
    expect(JSON.parse(listed.out)).toEqual({ scheduled: { id: "sch_1", enabled: false } });
  });

  test("the server's refusal is the command's: its code and words on stderr, nothing on stdout, exit 1", async () => {
    const stand = standIn(() => ({ isError: true, content: [{ type: "text", text: "routine_not_approved: The person turns Dependency check on the first time, in the Inbox. Nothing was changed." }] }));
    const refused = await run(["on", "sch_1"], stand);
    expect(refused).toMatchObject({ exit: 1, out: "" });
    expect(refused.err).toStartWith("routine_not_approved: ");
    expect(refused.err).not.toContain(ROUTINE_AGENT_HINT);
  });

  test("the agent refusal (a shell that names no session, a create without --agent) says to ask the person, under the server's words", async () => {
    const stand = standIn(() => ({ isError: true, content: [{ type: "text", text: "validation_error: agent: claude-code, codex, opencode or pi." }] }));
    const refused = await run(["create", "--name", "Dependency check", "--cron", "0 9 * * 1-5", "--prompt", "Check deps."], stand);
    expect(refused).toMatchObject({ exit: 1, out: "", err: `validation_error: agent: claude-code, codex, opencode or pi.\n${ROUTINE_AGENT_HINT}\n` });
    expect(ROUTINE_AGENT_HINT).toContain("--agent");
    expect(ROUTINE_AGENT_HINT).toContain("Ask the person");
  });
});
