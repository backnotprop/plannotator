import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDismissOnOutsideAndEscape } from "../hooks/useDismissOnOutsideAndEscape";

/**
 * Floating popover anchored to a code-file link with multiple repo matches.
 * Selecting an entry calls `onPick(path)`. Esc / outside-click dismisses.
 */
export const CodeFilePicker: React.FC<{
	anchorEl: HTMLElement | null;
	matches: string[];
	onPick: (path: string) => void;
	onDismiss: () => void;
}> = ({ anchorEl, matches, onPick, onDismiss }) => {
	const popoverRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

	useEffect(() => {
		if (!anchorEl) return;
		const rect = anchorEl.getBoundingClientRect();
		setPos({
			top: rect.bottom + 4,
			left: rect.left,
		});
	}, [anchorEl]);

	useDismissOnOutsideAndEscape({
		enabled: true,
		ref: popoverRef as React.RefObject<HTMLElement>,
		onDismiss,
	});

	if (!pos) return null;

	return createPortal(
		<div
			ref={popoverRef}
			role="menu"
			aria-label="Choose file"
			className="fixed z-[100] min-w-[240px] max-w-[480px] bg-popover text-popover-foreground border border-border/70 rounded-lg shadow-xl py-1"
			style={{ top: pos.top, left: pos.left }}
		>
			<div className="px-3 py-1.5 text-xs uppercase tracking-wide opacity-60 border-b border-border/40">
				{matches.length} matches
			</div>
			<ul className="max-h-72 overflow-y-auto">
				{matches.map((m) => (
					<li key={m}>
						<button
							type="button"
							role="menuitem"
							onClick={() => onPick(m)}
							className="w-full text-left px-3 py-1.5 text-sm font-mono hover:bg-muted hover:text-primary transition-colors truncate"
							title={m}
						>
							{m}
						</button>
					</li>
				))}
			</ul>
		</div>,
		document.body,
	);
};
