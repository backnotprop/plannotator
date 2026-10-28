/**
 * `plannotator feedback` as real processes against a local fake endpoint
 * (PLANNOTATOR_FEEDBACK_URL; never the real Worker): it sends the message,
 * the category and contact when given, the version, the OS name and
 * `surface: "cli"`, and nothing else; prints "Sent"; exits 1 with the
 * Worker's reason when it refuses, and with one plain line (no stack) when it
 * is unreachable, not deployed or silent past the time limit; 2 on bad usage (sending
 * nothing), and answers --help without sending. Every process gets a temp
 * HOME and data dir, no browser, no update check and no Inbox connect.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { FEEDBACK_PROMPT_TEXT_LINE, feedbackPrompt } from "../../../packages/inbox/feedbackPrompt";
import { FEEDBACK_COMMAND_USAGE, formatTopLevelHelp } from "./cli";
import { FEEDBACK_HEREDOC_END, FEEDBACK_TIMEOUT_MS, FEEDBACK_UNAVAILABLE, PRODUCT_FEEDBACK_URL } from "@plannotator/core/product-feedback";
import { parseFeedbackCommand, runFeedbackCommand } from "./feedback-command";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
const fakes: ReturnType<typeof Bun.serve>[] = [];
let stubs: string[] = [];

beforeAll(() => {
  // The CLI imports the built HTML; these tests never read the pages.
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});
afterEach(() => {
  for (const fake of fakes.splice(0)) fake.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeEndpoint(status = 201) {
  const received: { method: string; path: string; body: unknown }[] = [];
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      received.push({ method: req.method, path: new URL(req.url).pathname, body: await req.json().catch(() => null) });
      return Response.json(status < 300 ? { ok: true } : { error: "message is required" }, { status });
    },
  });
  fakes.push(fake);
  return { url: `http://127.0.0.1:${fake.port}/feedback`, received };
}

function sandbox(feedbackUrl: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-feedback-cli-")));
  roots.push(root);
  const home = join(root, "home");
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: tmpdir(),
    PLANNOTATOR_DATA_DIR: join(home, ".plannotator"),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    BROWSER: NO_BROWSER,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_UPDATE_CHECK: "0",
    PLANNOTATOR_FEEDBACK_URL: feedbackUrl,
  };
  return { root, home, env };
}

async function run(args: string[], feedbackUrl: string, stdin?: string) {
  const { root, env } = sandbox(feedbackUrl);
  const proc = Bun.spawn([process.execPath, entry, "feedback", ...args], {
    cwd: root,
    env,
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe("plannotator feedback (processes)", () => {
  test("sends the words, category, contact, version, OS and surface; prints Sent", async () => {
    const endpoint = fakeEndpoint();
    const result = await run(["The Inbox is great, but the list jumps on reload", "--category", "bug", "--contact=me@example.com"], endpoint.url);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("Sent");
    expect(endpoint.received).toHaveLength(1);
    expect(endpoint.received[0]!.method).toBe("POST");
    const body = endpoint.received[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["category", "contact", "message", "os", "surface", "version"]);
    // A source run has no baked version: `dev`.
    expect(body).toMatchObject({ message: "The Inbox is great, but the list jumps on reload", category: "bug", contact: "me@example.com", version: "dev", surface: "cli" });
  }, 30_000);

  // What a person might approve: shell syntax quoted from their own work, including a heredoc of
  // their own (a line that is exactly EOF) and the end word inside a longer line.
  const HOSTILE = [
    "Setting $HOME breaks it, and `touch INJECTED` should not run; $(touch INJECTED2) neither.",
    "Use <<'EOF' in your docs:",
    "EOF",
    "touch INJECTED3",
    `The "double" and 'single' quotes, a back\\slash, \${PATH}, ${FEEDBACK_HEREDOC_END}-ish and a tab\there stay.`,
    "'@ and ünïcødé 🎉 too.",
  ].join("\n");

  /** The bash forms as shipped: the copied prompt, the CLI help's example, the skill and the README's curl. */
  function shippedTemplates(fakeUrl: string): { name: string; script: string; json: boolean }[] {
    const fence = (text: string, after: string) => {
      const start = text.indexOf("```", text.indexOf(after)) + 3;
      return text.slice(text.indexOf("\n", start) + 1, text.indexOf("```", start)).trimEnd();
    };
    const prompt = fence(feedbackPrompt(null), "In bash");
    const helpBlock = FEEDBACK_COMMAND_USAGE.split("Example (bash, zsh, sh):\n")[1]!.split("\n\n")[0]!;
    const help = helpBlock
      .split("\n")
      .map((line) => line.replace(/^ {2}/, ""))
      .join("\n");
    const skillText = readFileSync(resolve(import.meta.dir, "../../skills/core/plannotator/SKILL.md"), "utf-8");
    const skill = skillText.slice(skillText.indexOf("plannotator feedback --stdin"), skillText.indexOf(`\n${FEEDBACK_HEREDOC_END}`) + FEEDBACK_HEREDOC_END.length + 1);
    const readme = fence(readFileSync(resolve(import.meta.dir, "../../feedback-service/README.md"), "utf-8"), "### Fallback for agents without the CLI");
    const asCli = (template: string) =>
      template
        .replace(/^plannotator feedback/m, '"$PN_BUN" "$PN_ENTRY" feedback')
        .replace(/ \[--category <bug\|idea\|other>\] \[--contact '<[^>]*>'\]/, " --category idea");
    return [
      { name: "prompt", script: asCli(prompt).replace(FEEDBACK_PROMPT_TEXT_LINE, HOSTILE), json: false },
      { name: "help", script: asCli(help).replace("The list jumps to the top after a reload.", HOSTILE), json: false },
      { name: "skill", script: asCli(skill).replace("<the message, exactly as the person approved it>", HOSTILE), json: false },
      {
        name: "readme",
        script: readme.replace(PRODUCT_FEEDBACK_URL, fakeUrl).replace("<the person's words, JSON-escaped>", JSON.stringify(HOSTILE).slice(1, -1)),
        json: true,
      },
    ];
  }

  test("each shipped template, run by bash as written: the approved text arrives byte for byte, and nothing in it runs", async () => {
    const endpoint = fakeEndpoint();
    const templates = shippedTemplates(endpoint.url);
    // Every template was found and filled (none silently empty).
    for (const t of templates) {
      expect(t.script, t.name).toContain(t.json ? JSON.stringify(HOSTILE).slice(1, -1) : HOSTILE);
      expect(t.script, t.name).toContain(`<<'${FEEDBACK_HEREDOC_END}'`);
    }
    for (const t of templates) {
      const { root, home, env } = sandbox(endpoint.url);
      const before = endpoint.received.length;
      const proc = Bun.spawn(["/bin/bash", "-c", t.script], {
        cwd: root,
        env: { ...env, PN_BUN: process.execPath, PN_ENTRY: entry, LANG: "en_US.UTF-8" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect({ name: t.name, code, stderr }).toEqual({ name: t.name, code: 0, stderr: "" });
      if (!t.json) expect(stdout.trim(), t.name).toBe("Sent");
      expect(endpoint.received.length, t.name).toBe(before + 1);
      const body = endpoint.received.at(-1)!.body as { message: string; category?: string };
      expect(body.message, t.name).toBe(HOSTILE);
      expect(body.category, t.name).toBe("idea");
      expect(body.message).not.toContain(home);
      for (const file of ["INJECTED", "INJECTED2", "INJECTED3"]) expect(existsSync(join(root, file)), `${t.name}: ${file}`).toBe(false);
    }
  }, 60_000);

  test("`-` reads stdin too; stdin plus words, or an empty stdin, is a usage error that sends nothing", async () => {
    const endpoint = fakeEndpoint();
    const piped = await run(["-"], endpoint.url, "Piped in\n");
    expect(piped.code).toBe(0);
    expect((endpoint.received[0]!.body as { message: string }).message).toBe("Piped in");
    expect((await run(["--stdin", "and", "words"], endpoint.url, "hi\n")).code).toBe(2);
    const empty = await run(["--stdin"], endpoint.url, "");
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain("stdin was empty");
    expect((await run(["--stdin"], endpoint.url, "x".repeat(4001))).code).toBe(2);
    expect(endpoint.received).toHaveLength(1);
  }, 60_000);

  test("a refusal exits 1 with the reason on stderr", async () => {
    const endpoint = fakeEndpoint(400);
    const result = await run(["hi"], endpoint.url);
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("Sent");
    expect(result.stderr).toContain("Not sent: message is required");
  }, 30_000);

  test("unreachable or not deployed: exit 1 with one plain line, no stack", async () => {
    const endpoint = fakeEndpoint();
    fakes.pop()!.stop(true);
    const notDeployed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<html>There is nothing here yet</html>", { status: 404, headers: { "Content-Type": "text/html" } }) });
    fakes.push(notDeployed);
    for (const url of [endpoint.url, `http://127.0.0.1:${notDeployed.port}/feedback`]) {
      const result = await run(["hi"], url);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(`${FEEDBACK_UNAVAILABLE}\n`);
    }
  }, 30_000);

  test("bad usage exits 2 and sends nothing; --help sends nothing", async () => {
    const endpoint = fakeEndpoint();
    expect((await run([], endpoint.url)).code).toBe(2);
    expect((await run(["hi", "--category", "rant"], endpoint.url)).code).toBe(2);
    expect((await run(["hi", "--unknown"], endpoint.url)).code).toBe(2);
    const help = await run(["--help"], endpoint.url);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("plannotator feedback --stdin");
    expect(help.stdout).toContain(`<<'${FEEDBACK_HEREDOC_END}'`);
    expect(help.stdout).not.toContain('feedback "');
    expect(endpoint.received).toHaveLength(0);
  }, 60_000);
});

describe("runFeedbackCommand: a service that never answers", () => {
  test("gives up at the time limit with the plain line; the default limit is under 10 s", async () => {
    expect(FEEDBACK_TIMEOUT_MS).toBeLessThan(10_000);
    const silent = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
    fakes.push(silent);
    const out: string[] = [];
    const err: string[] = [];
    const started = performance.now();
    const code = await runFeedbackCommand(["hi"], {
      env: { PLANNOTATOR_FEEDBACK_URL: `http://127.0.0.1:${silent.port}/feedback` },
      version: "dev",
      timeoutMs: 300,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(out).toEqual([]);
    expect(err).toEqual([FEEDBACK_UNAVAILABLE]);
  });

  test("a fetch that throws is the same plain line, never a stack", async () => {
    const err: string[] = [];
    const code = await runFeedbackCommand(["hi"], {
      // A refusing loopback URL, never the live default, even though fetch is stubbed.
      env: { PLANNOTATOR_FEEDBACK_URL: "http://127.0.0.1:9/feedback" },
      version: "dev",
      fetch: (async () => {
        throw new Error("getaddrinfo ENOTFOUND feedback.invalid");
      }) as unknown as typeof fetch,
      out: () => {},
      err: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(err).toEqual([FEEDBACK_UNAVAILABLE]);
  });
});

describe("parseFeedbackCommand", () => {
  test("joins loose words into one message and reads both flag forms", () => {
    expect(parseFeedbackCommand(["two", "words", "--category=idea"])).toEqual({ ok: true, help: false, stdin: false, message: "two words", category: "idea", contact: null });
    expect(parseFeedbackCommand(["--contact", "@me", "hi"])).toEqual({ ok: true, help: false, stdin: false, message: "hi", category: null, contact: "@me" });
    expect(parseFeedbackCommand(["--stdin", "--category", "bug"])).toEqual({ ok: true, help: false, stdin: true, message: "", category: "bug", contact: null });
    expect(parseFeedbackCommand(["-"])).toMatchObject({ ok: true, stdin: true });
  });

  test("after --, a flag-looking word is part of the message", () => {
    expect(parseFeedbackCommand(["--", "--help", "is", "confusing"])).toEqual({ ok: true, help: false, stdin: false, message: "--help is confusing", category: null, contact: null });
  });

  test("refuses an empty or over-long message and a flag with no value", () => {
    expect(parseFeedbackCommand(["   "]).ok).toBe(false);
    expect(parseFeedbackCommand(["x".repeat(4001)]).ok).toBe(false);
    expect(parseFeedbackCommand(["hi", "--category"]).ok).toBe(false);
    expect(parseFeedbackCommand(["hi", "--contact"]).ok).toBe(false);
  });

  test("is listed in the top-level help", () => {
    expect(formatTopLevelHelp()).toContain("plannotator feedback");
  });
});
