export interface ReferencePickerPresentation {
	readonly objects: string;
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

export function integrationPickerPresentation(provider: {
	readonly id: string;
	readonly picker?: ReferencePickerPresentation;
}): ReferencePickerPresentation {
	return provider.picker ?? DISCOVERY_PRESENTATIONS[provider.id] ?? PASTE_PRESENTATION;
}
