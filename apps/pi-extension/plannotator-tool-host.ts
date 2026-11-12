import { randomBytes } from "node:crypto";
import type { HostControl } from "./generated/host-control.ts";
import { isSessionEventIdOpen } from "./session-events.ts";
import {
	plannotatorDistinctSubjects,
	plannotatorSessionId,
	plannotatorToolCloseText,
	plannotatorToolListText,
	plannotatorUnknownSessionText,
	type PlannotatorCloseOutcome,
	type PlannotatorSessionSummary,
	type PlannotatorTarget,
} from "./generated/plannotator-tool.ts";

export type PiReviewKind = PlannotatorSessionSummary["kind"];

export interface PiOpenReview {
	id: string;
	kind: PiReviewKind;
	subject: string;
	baseSubject?: string;
	target?: PlannotatorTarget;
	userSubject?: string;
	url: string;
	startedAt: number;
	owner: string | undefined;
	hostControl?: HostControl;
	closedByAgent: boolean;
}

export interface PiReviewRegistry {
	add(entry: Pick<PiOpenReview, "kind" | "subject" | "userSubject" | "url" | "owner" | "hostControl" | "target">): PiOpenReview;
	remove(review: PiOpenReview): void;
	openFor(owner: string | undefined): PiOpenReview[];
	openAll(): PiOpenReview[];
	listText(owner: string | undefined): string;
	close(owner: string | undefined, session: string): { ok: boolean; text: string };
}

export function createPiReviewRegistry(
	options: {
		now?: () => number;
		randomHex?: () => string;
		isTaken?: (id: string) => boolean;
	} = {},
): PiReviewRegistry {
	const now = options.now ?? Date.now;
	const randomHex = options.randomHex ?? (() => randomBytes(3).toString("hex"));
	const isTaken = options.isTaken ?? (() => false);
	const reviews = new Map<string, PiOpenReview>();

	const newId = (): string => {
		let value = Number.parseInt(randomHex(), 16) || 0;
		let id = plannotatorSessionId(value.toString(16).padStart(6, "0"));
		while (reviews.has(id) || isTaken(id)) {
			value = (value + 1) % 0x1000000;
			id = plannotatorSessionId(value.toString(16).padStart(6, "0"));
		}
		return id;
	};

	const openAll = (): PiOpenReview[] => [...reviews.values()].filter((review) => !review.closedByAgent);
	const openFor = (owner: string | undefined): PiOpenReview[] => openAll().filter((review) => review.owner === owner);

	const statusOf = (review: PiOpenReview) => {
		try {
			return review.hostControl?.status() ?? null;
		} catch {
			return null;
		}
	};

	const closeOne = (review: PiOpenReview): PlannotatorCloseOutcome => {
		const { id, subject } = review;
		if (review.kind === "plan") return { id, subject, closed: false, reason: "plan" };
		const close = review.hostControl?.close;
		if (!close) {
			return { id, subject, closed: false, reason: "failed", detail: "this review cannot be closed from here; close it from the tab" };
		}
		try {
			const outcome = close();
			if (outcome.closed) {
				review.closedByAgent = true;
				return { id, subject, closed: true, unsent: outcome.unsentAnnotations };
			}
			return outcome.reason === "decided"
				? { id, subject, closed: false, reason: "decided" }
				: { id, subject, closed: false, reason: "failed", detail: "it ends only with the reviewer's decision" };
		} catch (err) {
			return { id, subject, closed: false, reason: "failed", detail: err instanceof Error ? err.message : String(err) };
		}
	};

	return {
		add(entry) {
			const review: PiOpenReview = { ...entry, baseSubject: entry.subject, id: newId(), startedAt: now(), closedByAgent: false };
			reviews.set(review.id, review);
			const open = openFor(review.owner);
			const subjects = plannotatorDistinctSubjects(
				open.map((item) => ({ subject: item.baseSubject ?? item.subject, ...(item.target !== undefined ? { target: item.target } : {}) })),
			);
			open.forEach((item, index) => {
				item.subject = subjects[index] ?? item.subject;
			});
			return review;
		},
		remove(review) {
			if (reviews.get(review.id) === review) reviews.delete(review.id);
		},
		openFor,
		openAll,
		listText(owner) {
			const at = now();
			const sessions: PlannotatorSessionSummary[] = openFor(owner).map((review) => {
				const status = statusOf(review);
				return {
					id: review.id,
					kind: review.kind,
					subject: review.subject,
					url: review.url,
					ageMs: at - review.startedAt,
					state: status?.decided ? "decided" : "open",
					unsent: status ? status.unsentAnnotations : null,
				};
			});
			return plannotatorToolListText(sessions);
		},
		close(owner, session) {
			if (session === "all") {
				return { ok: true, text: plannotatorToolCloseText(openFor(owner).map(closeOne)) };
			}
			const review = openFor(owner).find((candidate) => candidate.id === session);
			if (!review) return { ok: false, text: plannotatorUnknownSessionText(session) };
			const outcome = closeOne(review);
			return { ok: outcome.closed, text: plannotatorToolCloseText([outcome]) };
		},
	};
}

const REGISTRY_KEY = "__plannotatorPiReviewRegistry_v1";
const REGISTRY_METHODS = ["add", "remove", "openFor", "openAll", "listText", "close"] as const;

function isPiReviewRegistry(value: unknown): value is PiReviewRegistry {
	return typeof value === "object" && value !== null
		&& REGISTRY_METHODS.every((method) => typeof (value as Record<string, unknown>)[method] === "function");
}

export function getProcessPiReviewRegistry(): PiReviewRegistry {
	const store = globalThis as typeof globalThis & Record<string, unknown>;
	const existing = store[REGISTRY_KEY];
	if (isPiReviewRegistry(existing)) return existing;
	const registry = createPiReviewRegistry({ isTaken: isSessionEventIdOpen });
	store[REGISTRY_KEY] = registry;
	return registry;
}

export function fixedPortBusyText(open: PiOpenReview, ownedByCaller: boolean): string {
	const lead = "Plannotator did not open: this Pi runs Plannotator on one fixed port (remote mode or PLANNOTATOR_PORT), so only one review can be open at a time.";
	if (!ownedByCaller) {
		return `${lead} A review that another Pi session opened is still open at ${open.url}. You cannot close it from here: ask the user to finish or close that review in its browser tab, then try again.`;
	}
	if (open.kind === "plan") return `${lead} The plan review ${open.id} is open; wait for the reviewer's decision.`;
	return `${lead} ${open.subject} (${open.id}) is open: wait for the reviewer's decision, or close it first with action "close" and session "${open.id}".`;
}

function baseName(path: string): string {
	const trimmed = path.replace(/[\\/]+$/, "");
	const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return trimmed.slice(slash + 1) || trimmed;
}

const PR_URL = /^https?:\/\/[^\s/]+\/.+\/(?:pull|pull-requests|merge_requests)\/(\d+)\b/i;

export function annotateSubject(target: string): string {
	if (/^https?:\/\//i.test(target)) {
		try {
			return new URL(target).host;
		} catch {
			return target;
		}
	}
	return baseName(target) || "document";
}

export function reviewSubject(prUrl: string | undefined, directory: string | undefined): string {
	if (prUrl) {
		const match = PR_URL.exec(prUrl);
		if (match) return /merge_requests/i.test(prUrl) ? `MR !${match[1]}` : `PR #${match[1]}`;
		return prUrl;
	}
	return directory ? `changes in ${baseName(directory)}` : "local changes";
}

export function planSubject(version: number | undefined): string {
	return version && version > 0 ? `Plan v${version}` : "Plan";
}

export function lastMessageSubject(messageCount: number): string {
	return messageCount > 1 ? "your recent messages" : "your last message";
}

export function lastMessageUserSubject(messageCount: number): string {
	return messageCount > 1 ? "the agent's recent messages" : "the agent's last message";
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

export function commentCountSuffix(annotations: unknown): string {
	const count = Array.isArray(annotations) ? annotations.length : 0;
	return count > 0 ? ` · ${plural(count, "comment", "comments")}` : "";
}

export function agentClosedNotice(review: Pick<PiOpenReview, "id" | "subject" | "userSubject">, unsent: number | undefined): string {
	const saved = typeof unsent === "number" && unsent > 0
		? ` ${plural(unsent, "unsent comment", "unsent comments")} kept in the draft.`
		: "";
	return `Plannotator: the agent closed ${review.userSubject ?? review.subject} (${review.id}).${saved} Nothing was sent to the agent.`;
}
