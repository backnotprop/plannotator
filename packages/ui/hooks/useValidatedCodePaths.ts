import { useEffect, useMemo, useState } from "react";
import { extractCandidateCodePaths } from "@plannotator/core/extract-code-paths";

export type ValidationEntry =
	| { status: "found"; resolved: string }
	| { status: "ambiguous"; matches: string[] }
	| { status: "missing" }
	| { status: "unavailable" };

export type ValidatedMap = Map<string, ValidationEntry>;

/**
 * Extracts code-file path candidates from `markdown` and posts them to `/api/doc/exists` once
 * per markdown change.
 */
export function useValidatedCodePaths(
	markdown: string,
	baseDir?: string,
	disabled?: boolean,
): { validated: ValidatedMap; ready: boolean } {
	const [validated, setValidated] = useState<ValidatedMap>(new Map());
	const [ready, setReady] = useState<boolean>(false);

	useEffect(() => {
		setValidated(new Map());
		setReady(false);

		// When disabled we never probe and leave ready=false, so gateCodePath's no-validation fallback
		// renders code links optimistically (clickable) instead of demoting them to plain text.
		if (disabled) {
			return;
		}

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
	}, [markdown, baseDir, disabled]);

	return useMemo(() => ({ validated, ready }), [validated, ready]);
}
