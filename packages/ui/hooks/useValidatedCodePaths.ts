import { useEffect, useMemo, useState } from "react";
import { extractCandidateCodePaths } from "@plannotator/shared/extract-code-paths";

export type ValidationEntry =
	| { status: "found"; resolved: string }
	| { status: "ambiguous"; matches: string[] }
	| { status: "missing" }
	| { status: "unavailable" };

export type ValidatedMap = Map<string, ValidationEntry>;

/**
 * Extracts code-file path candidates from `markdown` and posts them to
 * `/api/doc/exists` once per markdown change. The server has typically
 * pre-warmed the file walk at plan/annotate load, so the response is fast.
 *
 * `validated` is empty until `ready` flips to true, at which point it holds
 * an entry for every candidate (including missing/unavailable ones). The
 * renderer dispatches on status — see InlineMarkdown.
 *
 * Empty candidate set short-circuits — no fetch, ready: true immediately.
 *
 * `baseDir` is the directory the active document lives in (linked-doc parent
 * or the annotate source file's parent). When set, the server tries
 * `<baseDir>/<input>` literal-resolve before its cwd walk so out-of-tree
 * relative references (e.g. `../script.ts` in `~/notes/foo.md`) don't get
 * demoted to plain text.
 */
export function useValidatedCodePaths(
	markdown: string,
	baseDir?: string,
): { validated: ValidatedMap; ready: boolean } {
	const [validated, setValidated] = useState<ValidatedMap>(new Map());
	const [ready, setReady] = useState<boolean>(false);

	useEffect(() => {
		setValidated(new Map());
		setReady(false);

		const candidates = extractCandidateCodePaths(markdown);
		if (candidates.length === 0) {
			setReady(true);
			return;
		}

		let cancelled = false;
		(async () => {
			try {
				const res = await fetch("/api/doc/exists", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(
						baseDir ? { paths: candidates, base: baseDir } : { paths: candidates },
					),
				});
				if (cancelled) return;
				if (!res.ok) {
					setReady(true);
					return;
				}
				const data = (await res.json()) as {
					results: Record<string, ValidationEntry>;
				};
				if (cancelled) return;
				const next: ValidatedMap = new Map();
				for (const [k, v] of Object.entries(data.results ?? {})) {
					next.set(k, v);
				}
				setValidated(next);
				setReady(true);
			} catch {
				if (!cancelled) setReady(true);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [markdown, baseDir]);

	// Stable reference: only changes when validated/ready actually change.
	// Without memoization, the parent provider's value is a fresh object every
	// render, forcing all context consumers (every InlineMarkdown) to re-render.
	return useMemo(() => ({ validated, ready }), [validated, ready]);
}
