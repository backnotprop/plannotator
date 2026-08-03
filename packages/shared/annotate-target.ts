/**
 * Tolerant annotate target selection.
 *
 * The host slash commands invoke the CLI through a bash-substitution prefix
 * (`` !`plannotator annotate $ARGUMENTS` ``), so `$ARGUMENTS` reaches argv
 * unquoted and unparsed. Any trailing natural language used to be fatal:
 *
 *   /plannotator-annotate and give me the URL for it  ->  File not found: and
 *   /plannotator-annotate the aim doc                 ->  File not found: the
 *
 * Fixing that in argument resolution (rather than in the skill templates)
 * means every host gets the forgiving behavior at once. The rule is
 * deliberately conservative: resolve every candidate token and proceed only
 * when EXACTLY ONE resolves. Two resolving tokens are ambiguous and error
 * naming both — we never guess, and never pick the first.
 *
 * Callers keep their own resolution logic for the token that wins; this
 * module only decides WHICH token is the target, and formats the two new
 * errors so every runtime words them identically.
 */

import { existsSync, statSync } from "node:fs";

import { resolveAtReference, stripAtPrefix } from "./at-reference";
import { resolveMarkdownFile, resolveUserPath } from "./resolve-file";

export type AnnotateTargetSelection =
	/** Exactly one candidate resolved — annotate it. */
	| { kind: "resolved"; token: string }
	/** Two or more candidates resolved — refuse to guess. */
	| { kind: "ambiguous"; candidates: string[] }
	/** Nothing resolved. `tried` is every token we tested, in order. */
	| { kind: "none"; tried: string[] };

/** A `https://` / `http://` target, `@`-prefix tolerant. */
export function isAnnotateUrlToken(token: string): boolean {
	return /^https?:\/\//i.test(stripAtPrefix(token));
}

/**
 * Tokens worth testing as a target. Flag-shaped tokens are excluded so an
 * unrecognized `--foo` never becomes a candidate (and so the "tried" list in
 * the error message stays prose, not flags).
 */
export function isAnnotateTargetCandidate(token: string): boolean {
	return token.trim().length > 0 && !token.startsWith("-");
}

/**
 * Does this token name something `annotate` can actually open — a URL, a
 * directory, an HTML file, or an annotatable plain-text file?
 *
 * Mirrors the three resolution branches at the call sites (URL / folder /
 * HTML / markdown-and-friends), including their `@`-reference semantics:
 * stripped form first, literal form as the scoped-package fallback.
 *
 * Cheap for prose. `resolveMarkdownFile` rejects anything without an
 * annotatable extension before it walks the project, so a bare word like
 * `the` costs two failed `stat` calls, not a tree walk.
 *
 * An in-project name matching several files counts as resolved: the user
 * clearly meant it as the target, and the existing "Ambiguous filename"
 * error is a better message than "no target found".
 */
export function annotateTokenResolves(
	token: string,
	projectRoot: string,
): boolean {
	if (isAnnotateUrlToken(token)) return true;

	return (
		resolveAtReference(token, (candidate) => {
			const absolute = resolveUserPath(candidate, projectRoot);
			if (!absolute) return false;
			try {
				if (statSync(absolute).isDirectory()) return true;
			} catch {
				/* not a directory (or unreadable) — keep checking */
			}
			if (/\.html?$/i.test(absolute) && existsSync(absolute)) return true;
			const resolved = resolveMarkdownFile(candidate, projectRoot);
			return resolved.kind === "found" || resolved.kind === "ambiguous";
		}) !== null
	);
}

/**
 * Does the literal argument point at something that already exists on disk?
 *
 * When it does, the caller's own type-specific errors ("File type not
 * supported: .pdf", "No annotatable files … found in …") say more than the
 * tolerant "no target found" hint, so callers use this to stay out of the
 * way. `@`-reference semantics apply, same as resolution.
 */
export function annotateInputExists(
	input: string,
	projectRoot: string,
): boolean {
	return (
		resolveAtReference(input, (candidate) => {
			const absolute = resolveUserPath(candidate, projectRoot);
			return !!absolute && existsSync(absolute);
		}) !== null
	);
}

/**
 * Pick the single annotate target out of already-tokenized args.
 *
 * `resolves` is injected so this stays pure and table-testable; production
 * callers pass a closure over `annotateTokenResolves`. Duplicate tokens
 * collapse — `annotate spec.md spec.md` is one target, not an ambiguity.
 */
export function selectAnnotateTarget(
	tokens: readonly string[],
	resolves: (token: string) => boolean,
): AnnotateTargetSelection {
	const candidates = tokens.filter(isAnnotateTargetCandidate);
	const hits: string[] = [];
	for (const candidate of candidates) {
		if (hits.includes(candidate)) continue;
		if (resolves(candidate)) hits.push(candidate);
	}

	if (hits.length === 1) return { kind: "resolved", token: hits[0] };
	if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
	return { kind: "none", tried: candidates };
}

/**
 * Pick the target out of a raw args string (OpenCode and Pi receive the
 * whole slash-command remainder pre-joined).
 *
 * The un-split string is tried first, so an unquoted path containing spaces
 * still wins over its own tokens — that's existing supported behavior on
 * those hosts. Only when the whole string doesn't resolve do we fall back to
 * per-token selection.
 */
export function selectAnnotateTargetFromRaw(
	rawFilePath: string,
	resolves: (token: string) => boolean,
): AnnotateTargetSelection {
	const raw = rawFilePath.trim();
	if (isAnnotateTargetCandidate(raw) && resolves(raw)) {
		return { kind: "resolved", token: raw };
	}
	return selectAnnotateTarget(raw.split(/\s+/), resolves);
}

const ANNOTATE_TARGET_SHAPE_HINT =
	"plannotator annotate accepts a path, URL, or folder — e.g. docs/spec.md, ./docs/, or https://example.com/page.";

/** Name both candidates rather than guessing between them. */
export function formatAmbiguousAnnotateTargetError(
	candidates: readonly string[],
): string {
	return [
		`Ambiguous annotate target — ${candidates.length} arguments name something annotatable:`,
		...candidates.map((candidate) => `  ${candidate}`),
		"Pass exactly one path, URL, or folder.",
	].join("\n");
}

/** Name what was tried, and state the shape the command wants. */
export function formatNoAnnotateTargetError(tried: readonly string[]): string {
	return [
		`No annotate target found. Tried: ${tried.join(", ")}`,
		ANNOTATE_TARGET_SHAPE_HINT,
	].join("\n");
}

export type AnnotateTargetDecision =
	/** Annotate this argument. Callers keep their own per-type resolution. */
	| { kind: "target"; token: string }
	/** Refuse with this message — already formatted for the host. */
	| { kind: "error"; message: string };

export interface AnnotateTargetRequest {
	/**
	 * The literal argument as the user gave it — `argv[1]` for the Claude Code
	 * binary, or the whole joined slash-command remainder for OpenCode/Pi.
	 * Also the fallback target, so a caller's own downstream errors stay
	 * reachable.
	 */
	raw: string;
	/**
	 * Pre-tokenized argument tail, for hosts that get real argv. Omit on hosts
	 * that receive the remainder pre-joined: `raw` is then tried whole first
	 * (so an unquoted path with spaces still wins) before being split.
	 */
	tokens?: readonly string[];
	/**
	 * Strict invocations (`--require-approval` / `--result-file`, which the CLI
	 * already requires `--gate --json` alongside) own an exit-code contract, so
	 * tolerance is bypassed for them: a typo must keep exiting 2 rather than
	 * quietly annotating a later argument and reporting "approved" for a
	 * document the caller never named.
	 */
	strict?: boolean;
	resolves: (token: string) => boolean;
	inputExists: (input: string) => boolean;
}

/**
 * The one tolerant-resolution decision, shared by every host so the behavior
 * and both error messages are identical everywhere.
 */
export function resolveAnnotateTargetArg(
	request: AnnotateTargetRequest,
): AnnotateTargetDecision {
	const { raw, tokens, strict, resolves, inputExists } = request;
	if (strict) return { kind: "target", token: raw };

	const selection = tokens
		? selectAnnotateTarget(tokens, resolves)
		: selectAnnotateTargetFromRaw(raw, resolves);

	if (selection.kind === "resolved") {
		return { kind: "target", token: selection.token };
	}
	if (selection.kind === "ambiguous") {
		return {
			kind: "error",
			message: formatAmbiguousAnnotateTargetError(selection.candidates),
		};
	}
	// Nothing resolved. Only speak up when there was genuinely prose to sift:
	// a single unresolvable token, or a literal argument that does exist but
	// isn't annotatable, keeps the caller's more specific downstream error
	// ("File not found: …", "File type not supported: .pdf").
	if (selection.tried.length > 1 && !inputExists(raw)) {
		return { kind: "error", message: formatNoAnnotateTargetError(selection.tried) };
	}
	return { kind: "target", token: raw };
}
