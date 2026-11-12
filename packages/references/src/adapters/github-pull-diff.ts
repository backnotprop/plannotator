import { formatDiffMetadataPathToken, formatPatchPathToken } from "@plannotator/core/diff-paths";

import type { ExternalRefFailure, PullReads, PullRef } from "../contract.ts";
import { GITHUB_PUBLIC_HOST } from "../grammars/github.ts";
import { readHost, servedHosts, type ServedHosts } from "../hosts.ts";
import type { ReferencePort } from "../port.ts";
import { failure, get, type GithubApi, githubApi, githubAuth, REPO, str } from "./github-pulls.ts";

export const GITHUB_DIFF_FILE_CEILING = 300;

export interface PullSummary {
	readonly title: string;
	readonly url: string;
	readonly state: "open" | "closed" | "merged";
	readonly author: string | null;
	readonly baseRef: string;
	readonly headRef: string;
	readonly baseSha: string;
	readonly headSha: string;
	readonly additions: number;
	readonly deletions: number;
	readonly changedFiles: number;
}

export type PullSummaryResult = ({ readonly ok: true } & PullSummary) | ExternalRefFailure;

export type PullDiffResult =
	| ({ readonly ok: true; readonly diff: string } & PullSummary)
	| ExternalRefFailure
	| { readonly ok: false; readonly reason: "too_large" | "moved" };

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

async function read(
	path: string,
	repo: string,
	number: number,
	authorization: string,
	api: GithubApi,
): Promise<PullSummaryResult> {
	const answer = await get(api, path, authorization);
	if (!answer.ok) {
		return answer.status === null
			? { ok: false, reason: "not_resolvable" }
			: failure(answer.status);
	}
	const body = (await answer.response.json().catch(() => null)) as {
		title?: unknown;
		state?: unknown;
		merged?: unknown;
		user?: { login?: unknown } | null;
		base?: { ref?: unknown; sha?: unknown } | null;
		head?: { ref?: unknown; sha?: unknown } | null;
		additions?: unknown;
		deletions?: unknown;
		changed_files?: unknown;
	} | null;
	const title = str(body?.title);
	const baseRef = str(body?.base?.ref);
	const headRef = str(body?.head?.ref);
	const baseSha = str(body?.base?.sha);
	const headSha = str(body?.head?.sha);
	const additions = count(body?.additions);
	const deletions = count(body?.deletions);
	const changedFiles = count(body?.changed_files);
	if (
		title === undefined ||
		baseRef === undefined ||
		headRef === undefined ||
		baseSha === undefined ||
		headSha === undefined ||
		additions === undefined ||
		deletions === undefined ||
		changedFiles === undefined
	) {
		return { ok: false, reason: "not_resolvable" };
	}
	return {
		ok: true,
		title,
		url: `https://${api.host}/${repo}/pull/${number}`,
		state: body?.merged === true ? "merged" : body?.state === "open" ? "open" : "closed",
		author: str(body?.user?.login) ?? null,
		baseRef,
		headRef,
		baseSha,
		headSha,
		additions,
		deletions,
		changedFiles,
	};
}

function pullHost(served: ServedHosts, pull: PullRef): string | null {
	if (!REPO.test(pull.repo) || !Number.isInteger(pull.number) || pull.number < 1) return null;
	return readHost(served, pull.host);
}

async function summaryOn(
	served: ServedHosts,
	pull: PullRef,
	port: ReferencePort,
): Promise<PullSummaryResult> {
	const host = pullHost(served, pull);
	if (host === null) return { ok: false, reason: "not_linked" };
	const auth = await githubAuth(port, host);
	if (!auth.ok) return auth;
	const api = githubApi(port, host);
	return read(
		`/repos/${pull.repo}/pulls/${pull.number}`,
		pull.repo,
		pull.number,
		auth.authorization,
		api,
	);
}

async function diffOn(
	served: ServedHosts,
	pull: PullRef,
	port: ReferencePort,
): Promise<PullDiffResult> {
	const host = pullHost(served, pull);
	if (host === null) return { ok: false, reason: "not_linked" };
	const auth = await githubAuth(port, host);
	if (!auth.ok) return auth;
	const api = githubApi(port, host);
	const path = `/repos/${pull.repo}/pulls/${pull.number}`;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const before = await read(path, pull.repo, pull.number, auth.authorization, api);
		if (!before.ok) return before;
		if (before.changedFiles > GITHUB_DIFF_FILE_CEILING)
			return { ok: false, reason: "too_large" };
		const files = await readFilePages(path, auth.authorization, api);
		if (!files.ok) return files;
		const diff = files.items.map(fileDiff).join("");
		const after = await read(path, pull.repo, pull.number, auth.authorization, api);
		if (!after.ok) return after;
		if (after.headSha === before.headSha && after.baseSha === before.baseSha) {
			return { ...after, diff };
		}
	}
	return { ok: false, reason: "moved" };
}

interface PullFileItem {
	readonly filename?: unknown;
	readonly previous_filename?: unknown;
	readonly status?: unknown;
	readonly additions?: unknown;
	readonly deletions?: unknown;
	readonly sha?: unknown;
	readonly patch?: unknown;
}

const EMPTY_BLOB_SHA = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";

function fileDiff(item: PullFileItem): string {
	const name = str(item.filename);
	if (name === undefined) return "";
	const status = str(item.status) ?? "modified";
	const moved = status === "renamed" || status === "copied";
	const oldName = moved ? (str(item.previous_filename) ?? name) : name;
	const added = status === "added";
	const removed = status === "removed";
	const lines = [
		`diff --git ${formatPatchPathToken("a", oldName)} ${formatPatchPathToken("b", name)}`,
	];
	if (added) lines.push("new file mode 100644");
	if (removed) lines.push("deleted file mode 100644");
	if (moved && oldName !== name) {
		const verb = status === "renamed" ? "rename" : "copy";
		lines.push(`${verb} from ${formatDiffMetadataPathToken(oldName)}`);
		lines.push(`${verb} to ${formatDiffMetadataPathToken(name)}`);
	}
	const from = added ? "/dev/null" : formatPatchPathToken("a", oldName);
	const to = removed ? "/dev/null" : formatPatchPathToken("b", name);
	const patch = str(item.patch);
	if (patch !== undefined) {
		lines.push(`--- ${from}`, `+++ ${to}`, patch.endsWith("\n") ? patch.slice(0, -1) : patch);
		return `${lines.join("\n")}\n`;
	}
	const additions = count(item.additions) ?? 0;
	const deletions = count(item.deletions) ?? 0;
	const empty = str(item.sha) === EMPTY_BLOB_SHA;
	if (additions > 0 || deletions > 0) {
		lines.push(
			`GitHub did not include this file's diff (too large to show): ${additions} additions, ${deletions} deletions`,
		);
	} else if (!empty && !(moved && oldName !== name) && status !== "changed") {
		lines.push(`Binary files ${from} and ${to} differ`);
	}
	return `${lines.join("\n")}\n`;
}

const FILE_LIST_PAGES = 30;

async function readFilePages(
	path: string,
	authorization: string,
	api: GithubApi,
): Promise<{ readonly ok: true; readonly items: readonly PullFileItem[] } | ExternalRefFailure> {
	const items: PullFileItem[] = [];
	for (let page = 1; page <= FILE_LIST_PAGES; page += 1) {
		const answer = await get(api, `${path}/files?per_page=100&page=${page}`, authorization);
		if (!answer.ok) {
			return answer.status === null
				? { ok: false, reason: "not_resolvable" }
				: failure(answer.status);
		}
		const body: unknown = await answer.response.json().catch(() => null);
		if (!Array.isArray(body)) return { ok: false, reason: "not_resolvable" };
		for (const item of body as unknown[]) {
			if (typeof item === "object" && item !== null) items.push(item as PullFileItem);
		}
		if (body.length < 100) break;
	}
	return { ok: true, items };
}

export type PullFilesResult =
	| { readonly ok: true; readonly files: readonly string[]; readonly headSha: string }
	| ExternalRefFailure;

async function filesOn(
	served: ServedHosts,
	pull: PullRef,
	port: ReferencePort,
): Promise<PullFilesResult> {
	const host = pullHost(served, pull);
	if (host === null) return { ok: false, reason: "not_linked" };
	const auth = await githubAuth(port, host);
	if (!auth.ok) return auth;
	const api = githubApi(port, host);
	const path = `/repos/${pull.repo}/pulls/${pull.number}`;
	const summary = await read(path, pull.repo, pull.number, auth.authorization, api);
	if (!summary.ok) return summary;
	const listed = await readFilePages(path, auth.authorization, api);
	if (!listed.ok) return listed;
	const files: string[] = [];
	for (const item of listed.items) {
		const name = str(item.filename);
		if (name !== undefined) files.push(name);
	}
	return { ok: true, files, headSha: summary.headSha };
}

export function githubPullReads(served: ServedHosts): PullReads {
	return {
		summary: (pull, port) => summaryOn(served, pull, port),
		diff: (pull, port) => diffOn(served, pull, port),
		files: (pull, port) => filesOn(served, pull, port),
	};
}

const DEFAULT_PULL_READS = githubPullReads(servedHosts(GITHUB_PUBLIC_HOST));

export const readPullSummary: PullReads["summary"] = DEFAULT_PULL_READS.summary;

export const fetchPullDiff: PullReads["diff"] = DEFAULT_PULL_READS.diff;

export const listPullFiles: PullReads["files"] = DEFAULT_PULL_READS.files;
