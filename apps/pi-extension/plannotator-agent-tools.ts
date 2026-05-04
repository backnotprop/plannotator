import { Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PLANNOTATOR_REQUEST_CHANNEL = "plannotator:request";

type PlannotatorAnnotationResult = {
	feedback: string;
	exit?: boolean;
	approved?: boolean;
};

type PlannotatorResponse<T> =
	| { status: "handled"; result: T }
	| { status: "unavailable"; error?: string }
	| { status: "error"; error: string };

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
};

type AnnotateParams = {
	filePath?: string;
	gate?: boolean;
};

type AnnotateLastParams = {
	gate?: boolean;
};

const RESPONSE_TIMEOUT_MS = 10 * 60 * 1_000;

function textResult(text: string, details?: unknown): ToolResult {
	return {
		content: [{ type: "text", text }],
		details: details ?? {},
	};
}

function formatAnnotationResult(result: PlannotatorAnnotationResult): string {
	if (result.feedback?.trim()) return result.feedback.trim();
	if (result.approved) return "Approved.";
	if (result.exit) return "Annotation session closed.";
	return "Annotation closed without feedback.";
}

function formatUnavailable(response: PlannotatorResponse<PlannotatorAnnotationResult>): string {
	if (response.status === "unavailable") return `Plannotator unavailable: ${response.error || "unknown reason"}`;
	if (response.status === "error") return `Plannotator error: ${response.error}`;
	return "Plannotator unavailable: unknown reason";
}

function requestAnnotation(
	pi: ExtensionAPI,
	action: "annotate" | "annotate-last",
	payload: { filePath: string; gate?: boolean },
): Promise<ToolResult> {
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(textResult("Plannotator unavailable: request timed out."));
		}, RESPONSE_TIMEOUT_MS);

		function finish(result: ToolResult): void {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		}

		try {
			pi.events.emit(PLANNOTATOR_REQUEST_CHANNEL, {
				requestId: `agent-tool-${action}-${Date.now()}`,
				action,
				payload,
				respond(response: PlannotatorResponse<PlannotatorAnnotationResult>) {
					if (response.status !== "handled") {
						finish(textResult(formatUnavailable(response)));
						return;
					}
					finish(textResult(formatAnnotationResult(response.result), response.result));
				},
			});
		} catch (error) {
			finish(textResult(`Plannotator error: ${error instanceof Error ? error.message : String(error)}`));
		}
	});
}

export function registerPlannotatorAgentTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "plannotator_annotate",
		label: "Plannotator Annotate",
		description: "Open a file, folder, HTML file, or URL in Plannotator annotation UI and return reviewer feedback.",
		parameters: Type.Object({
			filePath: Type.String({ description: "File, folder, HTML file, or URL to annotate." }),
			gate: Type.Optional(Type.Boolean({ description: "Show approve/annotate/close review-gate controls." })),
		}) as any,
		async execute(_toolCallId, params) {
			const filePath = (params as AnnotateParams).filePath?.trim();
			if (!filePath) return textResult("Error: plannotator_annotate requires a filePath.");
			return requestAnnotation(pi, "annotate", {
				filePath,
				...((params as AnnotateParams).gate !== undefined ? { gate: (params as AnnotateParams).gate } : {}),
			});
		},
	});

	pi.registerTool({
		name: "plannotator_annotate_last",
		label: "Plannotator Annotate Last",
		description: "Open the latest assistant message in Plannotator annotation UI and return reviewer feedback.",
		parameters: Type.Object({
			gate: Type.Optional(Type.Boolean({ description: "Show approve/annotate/close review-gate controls." })),
		}) as any,
		async execute(_toolCallId, params) {
			return requestAnnotation(pi, "annotate-last", {
				filePath: "",
				...((params as AnnotateLastParams).gate !== undefined ? { gate: (params as AnnotateLastParams).gate } : {}),
			});
		},
	});
}
