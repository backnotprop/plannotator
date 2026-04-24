/**
 * Plannotator Pi Extension — File-based plan mode with visual browser review.
 *
 * During planning the agent writes any markdown file anywhere inside cwd and
 * calls plannotator_submit_plan with the path. The user reviews in the
 * browser UI and can approve, deny with annotations, or request changes.
 *
 * Features:
 * - /plannotator command or Ctrl+Alt+P to toggle
 * - --plan flag to start in planning mode
 * - Bash unrestricted during planning (prompt-guided)
 * - Writes restricted to markdown files inside cwd during planning
 * - plannotator_submit_plan tool with browser-based visual approval
 * - [DONE:n] markers for execution progress tracking
 * - /plannotator-review command for code review
 * - /plannotator-annotate command for markdown annotation
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { buildPromptVariables, formatTodoList, loadPlannotatorConfig, renderTemplate, resolvePhaseProfile } from "./config.js";
import {
	type ChecklistItem,
	markCompletedSteps,
	parseChecklist,
} from "./generated/checklist.js";
import { planDenyFeedback } from "./generated/feedback-templates.js";
import { hasMarkdownFiles, resolveUserPath } from "./generated/resolve-file.js";
import { FILE_BROWSER_EXCLUDED } from "./generated/reference-common.js";
import { htmlToMarkdown } from "./generated/html-to-markdown.js";
import { urlToMarkdown } from "./generated/url-to-markdown.js";
import { loadConfig, resolveUseJina } from "./generated/config.js";
import { parseAnnotateArgs } from "./generated/annotate-args.js";
import { resolveAtReference } from "./generated/at-reference.js";
import {
	getLastAssistantMessageText,
	hasPlanBrowserHtml,
	hasReviewBrowserHtml,
	getStartupErrorMessage,
	openArchiveBrowserAction,
	openCodeReview,
	openLastMessageAnnotation,
	openMarkdownAnnotation,
	openPlanReviewBrowser,
	registerPlannotatorEventListeners,
} from "./plannotator-events.js";
import {
	getToolsForPhase,
	isPlanWritePathAllowed,
	PLAN_SUBMIT_TOOL,
	type Phase,
	stripPlanningOnlyTools,
} from "./tool-scope.ts";

// ── Types ──────────────────────────────────────────────────────────────


type SavedPhaseState = {
	activeTools: string[];
	model?: { provider: string; id: string };
	thinkingLevel: ThinkingLevel;
};

type PersistedPlannotatorState = {
	phase: Phase;
	lastSubmittedPath?: string;
	savedState?: SavedPhaseState;
};

type AssistantTextBlock = { type?: string; text?: string };

type AssistantMessageLike = {
	role?: unknown;
	content?: unknown;
};

function isAssistantMessage(m: AssistantMessageLike): m is { role: "assistant"; content: AssistantTextBlock[] } {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: { content: AssistantTextBlock[] }): string {
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function getPlanReviewAvailabilityWarning(options: { hasUI: boolean; hasPlanHtml: boolean }): string | null {
	const { hasUI, hasPlanHtml } = options;
	if (hasUI && hasPlanHtml) return null;
	if (!hasUI && !hasPlanHtml) {
		return "Plannotator: interactive plan review is unavailable in this session (no UI support and missing built assets). Plans will auto-approve on exit_plan_mode.";
	}
	if (!hasUI) {
		return "Plannotator: interactive plan review is unavailable in this session (no UI support). Plans will auto-approve on exit_plan_mode.";
	}
	return "Plannotator: interactive plan review assets are missing. Rebuild the extension to restore the browser UI. Plans will auto-approve on exit_plan_mode.";
}

export default function plannotator(pi: ExtensionAPI): void {
	let phase: Phase = "idle";
	void registerPlannotatorEventListeners(pi);
	let lastSubmittedPath: string | null = null;
	let checklistItems: ChecklistItem[] = [];
	let savedState: SavedPhaseState | null = null;
	let plannotatorConfig = {};

	// ── Flags ────────────────────────────────────────────────────────────

	pi.registerFlag("plan", {
		description: "Start in plan mode (restricted exploration and planning)",
		type: "boolean",
		default: false,
	});

	// ── Helpers ──────────────────────────────────────────────────────────

	function getPhaseProfile(): ReturnType<typeof resolvePhaseProfile> | undefined {
		if (phase === "planning" || phase === "executing") {
			return resolvePhaseProfile(plannotatorConfig, phase);
		}
		return undefined;
	}

	function updateStatus(ctx: ExtensionContext): void {
		const profile = getPhaseProfile();
		if (phase === "executing" && checklistItems.length > 0) {
			const completed = checklistItems.filter((t) => t.completed).length;
			ctx.ui.setStatus(
				"plannotator",
				ctx.ui.theme.fg("accent", `📋 ${completed}/${checklistItems.length}`),
			);
		} else if (phase === "planning" && profile?.statusLabel) {
			ctx.ui.setStatus("plannotator", ctx.ui.theme.fg("warning", profile.statusLabel));
		} else if (phase === "executing" && profile?.statusLabel) {
			ctx.ui.setStatus("plannotator", ctx.ui.theme.fg("accent", profile.statusLabel));
		} else {
			ctx.ui.setStatus("plannotator", undefined);
		}
	}

	function updateWidget(ctx: ExtensionContext): void {
		if (phase === "executing" && checklistItems.length > 0) {
			const lines = checklistItems.map((item) => {
				if (item.completed) {
					return (
						ctx.ui.theme.fg("success", "☑ ") +
						ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(item.text))
					);
				}
				return `${ctx.ui.theme.fg("muted", "☐ ")}${item.text}`;
			});
			ctx.ui.setWidget("plannotator-progress", lines);
		} else {
			ctx.ui.setWidget("plannotator-progress", undefined);
		}
	}

	function captureSavedState(ctx: ExtensionContext): void {
		savedState = {
			activeTools: pi.getActiveTools(),
			model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined,
			thinkingLevel: pi.getThinkingLevel(),
		};
	}

	function persistState(): void {


		pi.appendEntry("plannotator", { phase, lastSubmittedPath, savedState });
	}

	async function applyModelRef(
		ref: { provider: string; id: string },
		ctx: ExtensionContext,
		reason: string,
	): Promise<void> {
		const model = ctx.modelRegistry.find(ref.provider, ref.id);
		if (!model) {
			ctx.ui.notify(`Plannotator: ${reason} model ${ref.provider}/${ref.id} not found.`, "warning");
			return;
		}

		const success = await pi.setModel(model);
		if (!success) {
			ctx.ui.notify(`Plannotator: no API key for ${ref.provider}/${ref.id}.`, "warning");
		}
	}

	async function restoreSavedState(ctx: ExtensionContext): Promise<void> {
		if (!savedState) return;

		pi.setActiveTools(savedState.activeTools);
		if (savedState.model) {
			await applyModelRef(savedState.model, ctx, "restore");
		}
		pi.setThinkingLevel(savedState.thinkingLevel);
	}

	async function applyPhaseConfig(ctx: ExtensionContext, opts: { restoreSavedState?: boolean } = {}): Promise<void> {
		const profile = getPhaseProfile();
		if (opts.restoreSavedState !== false && savedState) {
			await restoreSavedState(ctx);
		}

		if (phase === "planning" || phase === "executing") {
			const baseTools = stripPlanningOnlyTools(savedState?.activeTools ?? pi.getActiveTools());
			const toolSet = new Set(baseTools);
			for (const tool of profile?.activeTools ?? []) toolSet.add(tool);
			if (phase === "planning") {
				pi.setActiveTools(getToolsForPhase([...toolSet], phase));
			} else {
				pi.setActiveTools([...toolSet]);
			}
		}

		if (profile?.model) {
			await applyModelRef(profile.model, ctx, phase);
		}

		if (profile?.thinking) {
			pi.setThinkingLevel(profile.thinking);
		}

		updateStatus(ctx);
		updateWidget(ctx);
	}

	async function enterPlanning(ctx: ExtensionContext): Promise<void> {
		phase = "planning";
		checklistItems = [];
		captureSavedState(ctx);
		await applyPhaseConfig(ctx, { restoreSavedState: false });
		persistState();
		ctx.ui.notify(
			"Plannotator: planning mode enabled. Write a markdown plan, then submit it for review.",
		);
		const warning = getPlanReviewAvailabilityWarning({ hasUI: ctx.hasUI, hasPlanHtml: hasPlanBrowserHtml() });
		if (warning) {
			ctx.ui.notify(warning, "warning");
		}
	}

	async function exitToIdle(ctx: ExtensionContext): Promise<void> {
		phase = "idle";
		checklistItems = [];
		lastSubmittedPath = null;

		await restoreSavedState(ctx);
		savedState = null;
		updateStatus(ctx);
		updateWidget(ctx);
		persistState();
		ctx.ui.notify("Plannotator: disabled. Full access restored.");
	}

	async function togglePlanMode(ctx: ExtensionContext): Promise<void> {
		if (phase === "idle") {
			await enterPlanning(ctx);
		} else {
			await exitToIdle(ctx);
		}
	}

	// ── Commands & Shortcuts ─────────────────────────────────────────────

	pi.registerCommand("plannotator", {
		description: "Toggle plannotator planning mode",
		handler: async (_args, ctx) => {
			await togglePlanMode(ctx);
		},
	});

	pi.registerCommand("plannotator-status", {
		description: "Show plannotator status",
		handler: async (_args, ctx) => {
			const parts = [`Phase: ${phase}`];
			if (lastSubmittedPath) {
				parts.push(`Plan file: ${lastSubmittedPath}`);
			}
			if (checklistItems.length > 0) {
				const done = checklistItems.filter((t) => t.completed).length;
				parts.push(`Progress: ${done}/${checklistItems.length}`);
			}
			ctx.ui.notify(parts.join("\n"), "info");
		},
	});

	pi.registerCommand("plannotator-review", {
		description: "Open interactive code review for current changes or a PR URL",
		handler: async (args, ctx) => {
			if (!hasReviewBrowserHtml()) {
				ctx.ui.notify(
					"Code review UI not available. Run 'bun run build' in the pi-extension directory.",
					"error",
				);
				return;
			}

			try {
				const prUrl = args?.trim() || undefined;
				const isPRReview = prUrl?.startsWith("http://") || prUrl?.startsWith("https://");
				const result = await openCodeReview(ctx, { prUrl });
				if (result.exit) {
					ctx.ui.notify("Code review session closed.", "info");
				} else if (result.feedback) {
					if (result.approved) {
						pi.sendUserMessage(
							`# Code Review\n\nCode review completed — no changes requested.`,
						);
					} else if (isPRReview) {
						// Platform PR actions (approve/comment) return approved:false with a
						// status message — don't tell the agent to "address" a platform action.
						pi.sendUserMessage(result.feedback);
					} else {
						pi.sendUserMessage(
							`${result.feedback}\n\nPlease address this feedback.`,
						);
					}
				} else {
					ctx.ui.notify("Code review closed (no feedback).", "info");
				}
			} catch (err) {
				ctx.ui.notify(
					`Failed to start code review UI: ${getStartupErrorMessage(err)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("plannotator-annotate", {
		description: "Open markdown file or folder in annotation UI",
		handler: async (args, ctx) => {
			// #570: split --gate / --json from the path. --json is silently
			// accepted (Pi writes back via sendUserMessage, not stdout).
			// `rawFilePath` keeps any leading `@` for the literal-@ fallback
			// (scoped-package-style names).
			const { filePath, rawFilePath, gate } = parseAnnotateArgs(args ?? "");
			if (!filePath) {
				ctx.ui.notify("Usage: /plannotator-annotate <file.md | file.html | https://... | folder/> [--gate] [--json]", "error");
				return;
			}
			if (!hasPlanBrowserHtml()) {
				ctx.ui.notify(
					"Annotation UI not available. Run 'bun run build' in the pi-extension directory.",
					"error",
				);
				return;
			}

			let markdown: string;
			let absolutePath: string;
			let folderPath: string | undefined;
			let mode: "annotate" | "annotate-folder" | undefined;
			let sourceInfo: string | undefined;
			let isFolder = false;

			// --- URL annotation ---
			const isUrl = /^https?:\/\//i.test(filePath);

			if (isUrl) {
				const useJina = resolveUseJina(false, loadConfig());
				ctx.ui.notify(`Fetching: ${filePath}${useJina ? " (via Jina Reader)" : " (via fetch+Turndown)"}...`, "info");
				try {
					const result = await urlToMarkdown(filePath, { useJina });
					markdown = result.markdown;
				} catch (err) {
					ctx.ui.notify(`Failed to fetch URL: ${err instanceof Error ? err.message : String(err)}`, "error");
					return;
				}
				absolutePath = filePath;
				sourceInfo = filePath;
			} else {
				// Pick the interpretation of the user input that actually exists:
				// stripped form first (reference-mode primary), literal as fallback
				// for scoped-package-style names. Falls back to the stripped form
				// for the error message if neither exists.
				const resolvedCandidate = resolveAtReference(rawFilePath, (c) => {
					const abs = resolveUserPath(c, ctx.cwd);
					return existsSync(abs);
				});
				if (resolvedCandidate === null) {
					absolutePath = resolveUserPath(filePath, ctx.cwd);
					ctx.ui.notify(`File not found: ${absolutePath}`, "error");
					return;
				}
				absolutePath = resolveUserPath(resolvedCandidate, ctx.cwd);

				try {
					isFolder = statSync(absolutePath).isDirectory();
				} catch {
					ctx.ui.notify(`Cannot access: ${absolutePath}`, "error");
					return;
				}

				if (isFolder) {
					if (!hasMarkdownFiles(absolutePath, FILE_BROWSER_EXCLUDED, /\.(mdx?|html?)$/i)) {
						ctx.ui.notify(`No markdown or HTML files found in ${absolutePath}`, "error");
						return;
					}
					markdown = "";
					folderPath = absolutePath;
					mode = "annotate-folder";
					ctx.ui.notify(`Opening annotation UI for folder ${filePath}...`, "info");
				} else if (/\.html?$/i.test(absolutePath)) {
					// HTML file annotation — convert to markdown via Turndown
					const fileSize = statSync(absolutePath).size;
					if (fileSize > 10 * 1024 * 1024) {
						ctx.ui.notify(`File too large (${Math.round(fileSize / 1024 / 1024)}MB, max 10MB)`, "error");
						return;
					}
					const html = readFileSync(absolutePath, "utf-8");
					markdown = htmlToMarkdown(html);
					sourceInfo = basename(absolutePath);
					ctx.ui.notify(`Opening annotation UI for ${filePath}...`, "info");
				} else {
					markdown = readFileSync(absolutePath, "utf-8");
					ctx.ui.notify(`Opening annotation UI for ${filePath}...`, "info");
				}
			}

			try {
				const result = await openMarkdownAnnotation(ctx, absolutePath, markdown, mode ?? "annotate", folderPath, sourceInfo, gate);
				if (result.approved) {
					ctx.ui.notify("Annotation approved.", "info");
				} else if (result.exit) {
					ctx.ui.notify("Annotation session closed.", "info");
				} else if (result.feedback) {
					const header = isFolder
						? `# Markdown Annotations\n\nFolder: ${absolutePath}\n\n`
						: `# Markdown Annotations\n\nFile: ${absolutePath}\n\n`;
					pi.sendUserMessage(
						`${header}${result.feedback}\n\nPlease address the annotation feedback above.`,
					);
				} else {
					ctx.ui.notify("Annotation closed (no feedback).", "info");
				}
			} catch (err) {
				ctx.ui.notify(
					`Failed to start annotation UI: ${getStartupErrorMessage(err)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("plannotator-last", {
		description: "Annotate the last assistant message",
		handler: async (args, ctx) => {
			// #570: support --gate on /plannotator-last for Stop-hook review gate.
			const { gate } = parseAnnotateArgs(args ?? "");

			if (!hasPlanBrowserHtml()) {
				ctx.ui.notify(
					"Annotation UI not available. Run 'bun run build' in the pi-extension directory.",
					"error",
				);
				return;
			}

			const lastText = await getLastAssistantMessageText(ctx);
			if (!lastText) {
				ctx.ui.notify("No assistant message found in session.", "error");
				return;
			}

			ctx.ui.notify("Opening annotation UI for last message...", "info");

			try {
				const result = await openLastMessageAnnotation(ctx, lastText, gate);
				if (result.approved) {
					ctx.ui.notify("Message approved.", "info");
				} else if (result.exit) {
					ctx.ui.notify("Annotation session closed.", "info");
				} else if (result.feedback) {
					pi.sendUserMessage(
						`# Message Annotations\n\n${result.feedback}\n\nPlease address the annotation feedback above.`,
					);
				} else {
					ctx.ui.notify("Annotation closed (no feedback).", "info");
				}
			} catch (err) {
				ctx.ui.notify(
					`Failed to start annotation UI: ${getStartupErrorMessage(err)}`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("plannotator-archive", {
		description: "Browse saved plan decisions",
		handler: async (_args, ctx) => {
			if (!hasPlanBrowserHtml()) {
				ctx.ui.notify(
					"Archive UI not available. Run 'bun run build' in the pi-extension directory.",
					"error",
				);
				return;
			}

			ctx.ui.notify("Opening plan archive...", "info");

			try {
				await openArchiveBrowserAction(ctx);
				ctx.ui.notify("Archive browser closed.", "info");
			} catch (err) {
				ctx.ui.notify(
					`Failed to start archive: ${getStartupErrorMessage(err)}`,
					"error",
				);
			}
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plannotator",
		handler: async (ctx) => {
			await togglePlanMode(ctx);
		},
	});

	// ── plannotator_submit_plan Tool ────────────────────────────────────

	pi.registerTool({
		name: PLAN_SUBMIT_TOOL,
		label: "Submit Plan",
		description:
			"Submit your Plannotator plan for user review. " +
			"Call this only while Plannotator planning mode is active, after writing your plan as a markdown file anywhere inside the working directory. " +
			"Pass the path to the plan file (e.g. PLAN.md or plans/auth.md). " +
			"The user will review the plan in a visual browser UI and can approve, deny with feedback, or annotate it. " +
			"If denied, edit the same file in place, then call this again with the same path.",
		parameters: Type.Object({
			filePath: Type.String({
				description:
					"Path to the markdown plan file, relative to the working directory. Must end in .md or .mdx and resolve inside cwd.",
			}),
		}) as any,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Guard: must be in planning phase
			if (phase !== "planning") {
				return {
					content: [
						{
							type: "text",
							text: "Error: Not in plan mode. Use /plannotator to enter planning mode first.",
						},
					],
					details: { approved: false },
				};
			}

			const inputPath = (params as { filePath?: string })?.filePath?.trim();
			if (!inputPath) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${PLAN_SUBMIT_TOOL} requires a filePath argument pointing to your markdown plan file (e.g. "PLAN.md" or "plans/auth.md").`,
						},
					],
					details: { approved: false },
				};
			}

			if (!isPlanWritePathAllowed(inputPath, ctx.cwd)) {
				return {
					content: [
						{
							type: "text",
							text: `Error: plan file must be a markdown file (.md or .mdx) inside the working directory. Rejected: ${inputPath}`,
						},
					],
					details: { approved: false },
				};
			}

			const fullPath = resolve(ctx.cwd, inputPath);

			try {
				if (!statSync(fullPath).isFile()) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${inputPath} is not a regular file. Write your plan to a markdown file first, then call ${PLAN_SUBMIT_TOOL} with its path.`,
							},
						],
						details: { approved: false },
					};
				}
			} catch {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${inputPath} does not exist. Write your plan using the write tool first, then call ${PLAN_SUBMIT_TOOL} again.`,
						},
					],
					details: { approved: false },
				};
			}

			let planContent: string;
			try {
				planContent = readFileSync(fullPath, "utf-8");
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text: `Error: failed to read ${inputPath}: ${err instanceof Error ? err.message : String(err)}`,
						},
					],
					details: { approved: false },
				};
			}

			if (planContent.trim().length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${inputPath} is empty. Write your plan first, then call ${PLAN_SUBMIT_TOOL} again.`,
						},
					],
					details: { approved: false },
				};
			}

			lastSubmittedPath = inputPath;
			checklistItems = parseChecklist(planContent);

			// Non-interactive or no HTML: auto-approve
			if (!ctx.hasUI || !hasPlanBrowserHtml()) {
				phase = "executing";
				await applyPhaseConfig(ctx, { restoreSavedState: true });
				pi.appendEntry("plannotator-execute", { lastSubmittedPath });
				persistState();
				return {
					content: [
						{
							type: "text",
							text: "Plan auto-approved (non-interactive mode). Execute the plan now.",
						},
					],
					details: { approved: true },
				};
			}

			let result: Awaited<ReturnType<typeof openPlanReviewBrowser>>;
			try {
				result = await openPlanReviewBrowser(ctx, planContent);
			} catch (err) {
				const message = `Failed to start plan review UI: ${getStartupErrorMessage(err)}`;
				ctx.ui.notify(message, "error");
				return {
					content: [{ type: "text", text: message }],
					details: { approved: false },
				};
			}

			if (result.approved) {
				phase = "executing";
				await applyPhaseConfig(ctx, { restoreSavedState: true });
				pi.appendEntry("plannotator-execute", { lastSubmittedPath });
				persistState();

				const doneMsg =
					checklistItems.length > 0
						? `After completing each step, include [DONE:n] in your response where n is the step number.`
						: "";

				if (result.feedback) {
					return {
						content: [
							{
								type: "text",
								text: `Plan approved with notes! You now have full tool access (read, bash, edit, write). Execute the plan in ${inputPath}. ${doneMsg}\n\n## Implementation Notes\n\nThe user approved your plan but added the following notes to consider during implementation:\n\n${result.feedback}\n\nProceed with implementation, incorporating these notes where applicable.`,
							},
						],
						details: { approved: true, feedback: result.feedback },
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `Plan approved. You now have full tool access (read, bash, edit, write). Execute the plan in ${inputPath}. ${doneMsg}`,
						},
					],
					details: { approved: true },
				};
			}

			// Denied
			persistState();
			const feedbackText = result.feedback || "Plan rejected. Please revise.";
			return {
				content: [
					{
						type: "text",
						text: planDenyFeedback(feedbackText, PLAN_SUBMIT_TOOL, {
							planFilePath: inputPath,
						}),
					},
				],
				details: { approved: false, feedback: feedbackText },
			};
		},
	});

	// ── Event Handlers ───────────────────────────────────────────────────

	// Gate writes during planning — only markdown files inside cwd.
	pi.on("tool_call", async (event, ctx) => {
		if (phase !== "planning") return;
		if (event.toolName !== "write" && event.toolName !== "edit") return;

		const inputPath = event.input.path as string;
		if (!isPlanWritePathAllowed(inputPath, ctx.cwd)) {
			const verb = event.toolName === "write" ? "writes" : "edits";
			return {
				block: true,
				reason: `Plannotator: during planning, ${verb} are limited to markdown files (.md, .mdx) inside the working directory. Blocked: ${inputPath}`,
			};
		}
	});

	// Inject phase-specific context
	pi.on("before_agent_start", async (_event, ctx) => {
		const profile = getPhaseProfile();
		const planRef = lastSubmittedPath ?? "your plan file";

		if (phase === "executing" && lastSubmittedPath) {
			// Re-read from disk each turn to stay current
			const fullPath = resolve(ctx.cwd, lastSubmittedPath);
			try {
				const planContent = readFileSync(fullPath, "utf-8");
				checklistItems = parseChecklist(planContent);
			} catch {
				// File deleted during execution — degrade gracefully
			}
		}

		const todoStats = phase === "executing" ? formatTodoList(checklistItems) : formatTodoList([]);
		if (profile?.systemPrompt) {
			const rendered = renderTemplate(
				profile.systemPrompt,
				buildPromptVariables({
					planFilePath: planRef,
					phase,
					todoList: todoStats.todoList,
					completedCount: todoStats.completedCount,
					totalCount: todoStats.totalCount,
					remainingCount: todoStats.remainingCount,
				}),
			);
			if (rendered.unknownVariables.length > 0) {
				ctx.ui.notify(
					"Plannotator: unknown template variables in " + phase + " prompt: " + rendered.unknownVariables.join(", "),
					"warning",
				);
			}

			return { systemPrompt: rendered.text };
		}

		if (phase === "planning") {
			return {
				message: {
					customType: "plannotator-context",
					content: `[PLANNOTATOR - PLANNING PHASE]
You are in plan mode. You MUST NOT make any changes to the codebase — no edits, no commits, no installs, no destructive commands. During planning you may only write or edit markdown files (.md, .mdx) inside the working directory.

Available tools: read, bash, grep, find, ls, write (markdown only), edit (markdown only), ${PLAN_SUBMIT_TOOL}

Do not run destructive bash commands (rm, git push, npm install, etc.) — focus on reading and exploring the codebase. Web fetching (curl, wget) is fine.

## Iterative Planning Workflow

You are pair-planning with the user. Explore the code to build context, then write your findings into a markdown plan file as you go. The plan starts as a rough skeleton and gradually becomes the final plan.

### Picking a plan file

Choose a descriptive filename for your plan. Convention: \`PLAN.md\` at the repo root for a single focused plan, or \`plans/<short-name>.md\` for projects that keep multiple plans. Reuse the same filename across revisions of the same plan so version history links up.

### The Loop

Repeat this cycle until the plan is complete:

1. **Explore** — Use read, grep, find, ls, and bash to understand the codebase. Actively search for existing functions, utilities, and patterns that can be reused — avoid proposing new code when suitable implementations already exist.
2. **Update the plan file** — After each discovery, immediately capture what you learned in the plan. Don't wait until the end. Use write for the initial draft, then edit for all subsequent updates.
3. **Ask the user** — When you hit an ambiguity or decision you can't resolve from code alone, ask. Then go back to step 1.

### First Turn

Start by quickly scanning key files to form an initial understanding of the task scope. Then write a skeleton plan (headers and rough notes) and ask the user your first round of questions. Don't explore exhaustively before engaging the user.

### Asking Good Questions

- Never ask what you could find out by reading the code.
- Batch related questions together.
- Focus on things only the user can answer: requirements, preferences, tradeoffs, edge-case priorities.
- Scale depth to the task — a vague feature request needs many rounds; a focused bug fix may need one or none.

### Plan File Structure

Your plan file should use markdown with clear sections:
- **Context** — Why this change is being made: the problem, what prompted it, the intended outcome.
- **Approach** — Your recommended approach only, not all alternatives considered.
- **Files to modify** — List the critical file paths that will be changed.
- **Reuse** — Reference existing functions and utilities you found, with their file paths.
- **Steps** — Implementation checklist:
  - [ ] Step 1 description
  - [ ] Step 2 description
- **Verification** — How to test the changes end-to-end (run the code, run tests, manual checks).

Keep the plan concise enough to scan quickly, but detailed enough to execute effectively.

### When to Submit

Your plan is ready when you've addressed all ambiguities and it covers: what to change, which files to modify, what existing code to reuse, and how to verify. Call ${PLAN_SUBMIT_TOOL} with the path to your plan file to submit for review.

### Revising After Feedback

When the user denies a plan with feedback:
1. Read the plan file to see the current plan.
2. Use the edit tool to make targeted changes addressing the feedback — do NOT rewrite the entire file.
3. Call ${PLAN_SUBMIT_TOOL} again with the same filePath to resubmit.

### Ending Your Turn

Your turn should only end by either:
- Asking the user a question to gather more information.
- Calling ${PLAN_SUBMIT_TOOL} when the plan is ready for review.

Do not end your turn without doing one of these two things.`,
					display: false,
				},
			};
		}

		if (phase === "executing" && checklistItems.length > 0) {
			const remaining = checklistItems.filter((t) => !t.completed);
			if (remaining.length > 0) {
				const todoList = remaining
					.map((t) => `- [ ] ${t.step}. ${t.text}`)
					.join("\n");
				return {
					message: {
						customType: "plannotator-context",
						content: `[PLANNOTATOR - EXECUTING PLAN]
Full tool access is enabled. Execute the plan from ${planRef}.

Remaining steps:
${todoList}

Execute each step in order. After completing a step, include [DONE:n] in your response where n is the step number.`,
						display: false,
					},
				};
			}
		}
	});

	// Filter stale context when idle
	pi.on("context", async (event) => {
		if (phase !== "idle") return;

		return {
			messages: event.messages.filter((m) => {
				const msg = m as { customType?: string; role?: string; content?: unknown };
				if (msg.customType === "plannotator-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
				if (typeof content === "string") {
					return !content.includes("[PLANNOTATOR -");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) =>
							c.type === "text" &&
							(c as { text?: string }).text?.includes("[PLANNOTATOR -"),
					);
				}
				return true;
			}),
		};
	});

	// Track execution progress
	pi.on("turn_end", async (event, ctx) => {
		if (phase !== "executing" || checklistItems.length === 0) return;
		if (!isAssistantMessage(event.message as AssistantMessageLike)) return;

		const text = getTextContent(event.message as { content: AssistantTextBlock[] });
		if (markCompletedSteps(text, checklistItems) > 0) {
			updateStatus(ctx);
			updateWidget(ctx);
		}
		persistState();
	});

	// Detect execution completion
	pi.on("agent_end", async (_event, ctx) => {
		if (phase !== "executing" || checklistItems.length === 0) return;

		if (checklistItems.every((t) => t.completed)) {
			const completedList = checklistItems
				.map((t) => `- [x] ~~${t.text}~~`)
				.join("\n");
			pi.sendMessage(
				{
					customType: "plannotator-complete",
					content: `**Plan Complete!** ✓\n\n${completedList}`,
					display: true,
				},
				{ triggerTurn: false },
			);
			phase = "idle";
			checklistItems = [];
			lastSubmittedPath = null;

			await restoreSavedState(ctx);
			savedState = null;
			updateStatus(ctx);
			updateWidget(ctx);
			persistState();
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		const loadedConfig = loadPlannotatorConfig(ctx.cwd);
		plannotatorConfig = loadedConfig.config;
		for (const warning of loadedConfig.warnings) {
			ctx.ui.notify(`Plannotator config: ${warning}`, "warning");
		}

		// Check --plan flag
		if (pi.getFlag("plan") === true) {
			phase = "planning";
		}

		// Restore persisted state
		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "plannotator",
			)
			.pop() as { data?: PersistedPlannotatorState } | undefined;

		if (stateEntry?.data) {
			phase = stateEntry.data.phase ?? phase;
			lastSubmittedPath = stateEntry.data.lastSubmittedPath ?? lastSubmittedPath;
			savedState = stateEntry.data.savedState ?? savedState;
		}

		// Rebuild execution state from disk + session messages
		if (phase === "executing") {
			if (lastSubmittedPath) {
				const fullPath = resolve(ctx.cwd, lastSubmittedPath);
				if (existsSync(fullPath)) {
					const content = readFileSync(fullPath, "utf-8");
					checklistItems = parseChecklist(content);

					// Find last execution marker and scan messages after it for [DONE:n]
					let executeIndex = -1;
					for (let i = entries.length - 1; i >= 0; i--) {
						const entry = entries[i] as { type: string; customType?: string };
						if (entry.customType === "plannotator-execute") {
							executeIndex = i;
							break;
						}
					}

					for (let i = executeIndex + 1; i < entries.length; i++) {
						const entry = entries[i];
						if (
							entry.type === "message" &&
							"message" in entry &&
							isAssistantMessage(entry.message as AssistantMessageLike)
						) {
							const text = getTextContent(entry.message as { content: AssistantTextBlock[] });
							markCompletedSteps(text, checklistItems);
						}
					}
				} else {
					// Plan file gone — fall back to idle
					phase = "idle";
					lastSubmittedPath = null;
				}
			} else {
				// No path recorded — can't rebuild, fall back to idle
				phase = "idle";
			}
		}



		if (phase === "planning") {
			checklistItems = [];
			const warning = getPlanReviewAvailabilityWarning({ hasUI: ctx.hasUI, hasPlanHtml: hasPlanBrowserHtml() });
			if (warning) {
				ctx.ui.notify(warning, "warning");
			}
		}

		if (phase === "idle") {
			if (savedState) {
				await restoreSavedState(ctx);
				savedState = null;
			} else {
				// Strip planning-only tools on fresh sessions where savedState is null.
				// Without this, plannotator_submit_plan stays in the active tool set
				// even though plan mode hasn't been activated. See #387.
				pi.setActiveTools(stripPlanningOnlyTools(pi.getActiveTools()));
			}
		} else if (phase === "planning" || phase === "executing") {
			await applyPhaseConfig(ctx, { restoreSavedState: true });
		}

		updateStatus(ctx);
		updateWidget(ctx);
		persistState();
	});
}
