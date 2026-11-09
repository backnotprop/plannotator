/**
 * Pi's hover-card runner (generated/ref-cards-node.ts, from
 * packages/shared/ref-cards-node.ts) against a scripted `gh` / `glab` that is
 * the only thing on PATH: never the real CLIs. What it must keep: the
 * arguments reach the program as they are (no shell), no prompt and no color,
 * a per-call token only for that child, exit 127 for a CLI that is not
 * installed, and the time limit even when the CLI never ends.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRefCards } from "../generated/ref-cards.ts";
import { createNodeRefCliRunner, nodeRefCliRunner } from "../generated/ref-cards-node.ts";

const posix = process.platform !== "win32";

const ANSWER = {
	data: {
		repository: {
			nameWithOwner: "acme/widgets",
			issueOrPullRequest: {
				__typename: "Issue",
				number: 9,
				title: "Widgets wobble",
				url: "https://github.com/acme/widgets/issues/9",
				state: "OPEN",
				createdAt: "2026-10-01T00:00:00Z",
				updatedAt: "2026-10-02T00:00:00Z",
				body: "",
				author: { login: "ada", avatarUrl: null },
				labels: { nodes: [] },
				assignees: { nodes: [] },
				comments: { totalCount: 0, nodes: [] },
				closedByPullRequestsReferences: { nodes: [] },
			},
		},
	},
};

describe.if(posix)("Pi's gh / glab runner", () => {
	const savedPath = process.env.PATH;
	let root = "";

	afterEach(() => {
		process.env.PATH = savedPath;
		if (root) rmSync(root, { recursive: true, force: true });
		root = "";
	});

	/** A scratch PATH holding only the scripted CLIs; returns where they log. */
	function scratch(): { bin: string; args: string; env: string } {
		root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-ref-node-")));
		const bin = join(root, "bin");
		mkdirSync(bin);
		const args = join(root, "args.log");
		const env = join(root, "env.log");
		const answer = join(root, "answer.json");
		writeFileSync(answer, JSON.stringify(ANSWER));
		writeFileSync(
			join(bin, "gh"),
			[
				"#!/bin/sh",
				`for a in "$@"; do printf '%s\\n' "$a"; done > '${args}'`,
				`printf 'prompt=%s color=%s token=%s\\n' "$GH_PROMPT_DISABLED" "$NO_COLOR" "$GH_TOKEN" > '${env}'`,
				`if [ "$1" = api ]; then /bin/cat '${answer}'; exit 0; fi`,
				"echo 'You are not logged into any GitHub hosts.' >&2",
				"exit 1",
				"",
			].join("\n"),
		);
		writeFileSync(join(bin, "glab"), "#!/bin/sh\nexec /bin/sleep 30\n");
		chmodSync(join(bin, "gh"), 0o755);
		chmodSync(join(bin, "glab"), 0o755);
		process.env.PATH = bin;
		return { bin, args, env };
	}

	test("arguments reach gh as they are, with no prompt, no color and the per-call token", async () => {
		const log = scratch();
		const result = await nodeRefCliRunner("gh", ["api", "graphql", "-f", "q=$(touch pwned) a b", "--hostname", "github.com"], { GH_TOKEN: "per-call" });
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual(ANSWER);
		expect(readFileSync(log.args, "utf8").split("\n").slice(0, 6)).toEqual(["api", "graphql", "-f", "q=$(touch pwned) a b", "--hostname", "github.com"]);
		expect(existsSync(join(root, "pwned"))).toBe(false);
		expect(readFileSync(log.env, "utf8").trim()).toBe("prompt=1 color=1 token=per-call");
		// A failing CLI's stderr and code come back as they are.
		const refused = await nodeRefCliRunner("gh", ["auth", "status"]);
		expect(refused.exitCode).toBe(1);
		expect(refused.stderr).toContain("not logged into");
	});

	test("a CLI that is not installed answers 127; one that never ends is stopped at the limit", async () => {
		const { bin } = scratch();
		process.env.PATH = join(root, "nothing-here");
		expect((await nodeRefCliRunner("gh", ["api", "graphql"])).exitCode).toBe(127);
		process.env.PATH = bin;
		const started = Date.now();
		const slow = await createNodeRefCliRunner(300)("glab", ["api", "graphql"]);
		expect(slow.exitCode).not.toBe(0);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	test("the card through the Node runner: one query, --hostname github.com, the issue's data", async () => {
		const log = scratch();
		const cards = createRefCards({ run: nodeRefCliRunner, avatar: async () => null });
		const card = await cards.get("https://github.com/acme/widgets/issues/9");
		expect(card).toMatchObject({ ok: true, data: { kind: "issue", title: "Widgets wobble", number: 9 } });
		const args = readFileSync(log.args, "utf8").split("\n");
		expect(args[args.indexOf("--hostname") + 1]).toBe("github.com");
		expect(args).toContain("owner=acme");
	});
});
