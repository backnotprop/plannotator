/**
 * "Ask your agent to look", the Inbox's facts. What this catches: the report
 * hiding the forge host the person saw (a run that named no --hostname), or a
 * private host, a token or the home path leaving the Inbox; `gh auth token`'s
 * output (a token) ever kept; the report going to the wrong session.
 */
import { describe, expect, test } from "bun:test";
import { createProblemFacts, createToolLog, recordingRunner, threadOwnerSession } from "./inbox-problem-facts";
import type { RefRunner } from "./ref-cards";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("problem facts", () => {
  test("a failed run's line: the forge host kept, private hosts, tokens and the home path never leave; auth token never kept", async () => {
    const fake: RefRunner = async (cli, args) => {
      if (args[0] === "--version") return { stdout: "glab 1.46.1 (2026-09-30)\n", stderr: "", exitCode: 0 };
      if (args[0] === "auth" && args[1] === "token") return { stdout: "glpat-SECRETSECRETSECRET\n", stderr: "", exitCode: 1 };
      return { stdout: "", stderr: `x gitlab.example.dev: 401 via proxy.corp.internal reading /home/dana/.config/glab-cli/config.yml token glpat-AbCdEfGhIjKlMnOp\n`, exitCode: 1 };
    };
    const log = createToolLog();
    const run = recordingRunner(fake, log, { home: "/home/dana" });
    await run("glab", ["auth", "status"]);
    await run("glab", ["auth", "token", "--hostname", "gitlab.example.dev"]);
    const store = { threadMessageIds: () => [] as string[], message: () => null };
    const facts = createProblemFacts({ version: "0.28.62", run: fake, log, store, json, baseUrl: () => "http://localhost:1/" });
    const res = await facts.route(new Request("http://x/api/inbox/problem-facts?cli=glab&host=gitlab.example.dev"), new URL("http://x/api/inbox/problem-facts?cli=glab&host=gitlab.example.dev"));
    const body = (await res!.json()) as { tools: { version: string }[]; runs: { command: string; line: string | null }[] };
    const text = JSON.stringify(body);
    expect(body.tools[0]!.version).toBe("1.46.1");
    expect(body.runs.map((r) => r.command)).toEqual(["glab auth status", "glab auth token"]);
    expect(body.runs[0]!.line).toContain("gitlab.example.dev");
    expect(body.runs[0]!.line).toContain("~/.config/glab-cli/config.yml");
    for (const secret of ["proxy.corp", "/home/dana", "glpat-"]) expect(text).not.toContain(secret);
    expect(body.runs[1]!.line).toBeNull();
  });

  test("the thread's agent: the last agent that wrote, else where the person's first message went", () => {
    expect(threadOwnerSession([{ author: { kind: "agent", session: "ses_a" } as never }, { author: { kind: "person" } as never }, { author: { kind: "agent", session: "ses_b" } as never }])).toBe("ses_b");
    expect(threadOwnerSession([{ author: { kind: "person" } as never, to: { host: "claude-code", session: "ses_c" } as never }])).toBe("ses_c");
  });
});
