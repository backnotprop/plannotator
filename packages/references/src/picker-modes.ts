// Source: apps/web/src/lib/integration-providers.ts (ReferencePickerPresentation, PASTE_PRESENTATION, the github and linear rows of DISCOVERY_PRESENTATIONS, integrationPickerPresentation) (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// Cut: the other providers' rows and ReferenceProviderEntry's connect copy; the function takes only { id, picker? }.
//
// Picker presentation for the three providers: what the picker calls the
// objects and which discovery control it shows. A provider's live catalog
// still decides whether discovery is callable. GitLab has no row and falls
// to the paste default, exactly as in Workspaces.

/** Frontend copy and controls. API catalog methods still determine availability. */
export interface ReferencePickerPresentation {
	readonly objects: string;
	/** The adapter's actual order; never sort only the rows already loaded. */
	readonly orderLabel?: string;
	readonly discovery:
		| { readonly kind: "search" | "branch"; readonly label: string; readonly action: string }
		| { readonly kind: "browse"; readonly filterLoadedResults?: boolean }
		| { readonly kind: "paste" };
	readonly exact?: {
		readonly label: string;
		readonly action: string;
		readonly identifier: "digits";
	};
	readonly scope?: {
		readonly requirement: "optional" | "required";
		readonly label: string;
		readonly factLabel: string;
		readonly allLabel?: string;
	};
	readonly pastePlaceholder?: string;
}

const PASTE_PRESENTATION: ReferencePickerPresentation = {
	objects: "References",
	discovery: { kind: "paste" },
};

const DISCOVERY_PRESENTATIONS: Readonly<Record<string, ReferencePickerPresentation>> = {
	github: { objects: "Issues and pull requests", discovery: { kind: "paste" } },
	linear: { objects: "Issues, projects and documents", discovery: { kind: "paste" } },
};

/** Resolve display controls; the live catalog still decides whether discovery is callable. */
export function integrationPickerPresentation(provider: {
	readonly id: string;
	readonly picker?: ReferencePickerPresentation;
}): ReferencePickerPresentation {
	return provider.picker ?? DISCOVERY_PRESENTATIONS[provider.id] ?? PASTE_PRESENTATION;
}
