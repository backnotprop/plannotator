import { randomBytes } from "node:crypto";

export const PLANNOTATOR_SESSION_OPENED_CHANNEL = "plannotator:session-opened" as const;
export const PLANNOTATOR_SESSION_CLOSED_CHANNEL = "plannotator:session-closed" as const;

export type PlannotatorSessionAction = "plan-review" | "code-review" | "annotate" | "annotate-last";

export interface PlannotatorSessionOpenedEvent {
	id: string;
	action: PlannotatorSessionAction;
	url: string;
	openedAt: number;
	piSessionId?: string;
	reviewId?: string;
	requestId?: string;
}

export type PlannotatorSessionOutcome = "approved" | "submitted" | "closed";

export type PlannotatorSessionClosedBy = "reviewer" | "agent" | "stopped" | "error";

export interface PlannotatorSessionClosedEvent extends PlannotatorSessionOpenedEvent {
	outcome: PlannotatorSessionOutcome;
	closedBy?: PlannotatorSessionClosedBy;
	closedAt: number;
}

interface EventBusOwner {
	events: { emit: (channel: string, data: unknown) => void };
}

interface LiveBusSlot {
	owner: EventBusOwner | null;
}

const SLOT_KEY = "__plannotatorPiSessionEventBus_v1";

function slot(): LiveBusSlot {
	const store = globalThis as typeof globalThis & Record<string, unknown>;
	const existing = store[SLOT_KEY];
	if (typeof existing === "object" && existing !== null && "owner" in existing) return existing as LiveBusSlot;
	const created: LiveBusSlot = { owner: null };
	store[SLOT_KEY] = created;
	return created;
}

export function claimSessionEventBus(pi: EventBusOwner): void {
	slot().owner = pi;
}

export function releaseSessionEventBus(pi: EventBusOwner): void {
	const current = slot();
	if (current.owner === pi) current.owner = null;
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function liveNow(isLive: () => boolean): boolean {
	try {
		return isLive();
	} catch {
		return false;
	}
}

function emitSafely(opener: EventBusOwner, useOpener: boolean, channel: string, payload: object): void {
	queueMicrotask(() => {
		if (useOpener) {
			try {
				opener.events.emit(channel, payload);
				return;
			} catch (err) {
				console.error(`Plannotator: could not emit ${channel}: ${describeError(err)}`);
			}
		}
		const current = slot();
		const live = current.owner;
		if (!live || live === opener) return;
		try {
			live.events.emit(channel, payload);
		} catch {
			if (current.owner === live) current.owner = null;
		}
	});
}

const OPEN_IDS_KEY = "__plannotatorPiSessionEventOpenIds_v1";

function openIds(): Set<string> {
	const store = globalThis as typeof globalThis & Record<string, unknown>;
	const existing = store[OPEN_IDS_KEY];
	if (existing instanceof Set) return existing as Set<string>;
	const created = new Set<string>();
	store[OPEN_IDS_KEY] = created;
	return created;
}

export function isSessionEventIdOpen(id: string): boolean {
	return openIds().has(id);
}

export function newSessionEventId(
	taken: (id: string) => boolean = () => false,
	randomHex: () => string = () => randomBytes(3).toString("hex"),
): string {
	const open = openIds();
	let value = Number.parseInt(randomHex(), 16) || 0;
	for (let attempt = 0; attempt < 0x1000000; attempt += 1) {
		const id = `pn-${value.toString(16).padStart(6, "0")}`;
		let clash = open.has(id);
		if (!clash) {
			try {
				clash = taken(id);
			} catch {
				clash = false;
			}
		}
		if (!clash) return id;
		value = (value + 1) % 0x1000000;
	}
	return `pn-${randomBytes(3).toString("hex")}`;
}

export interface SessionEventHandle {
	readonly event: PlannotatorSessionOpenedEvent;
	close(end: { outcome: PlannotatorSessionOutcome; closedBy?: PlannotatorSessionClosedBy }): void;
}

export function openSessionEvent(
	pi: EventBusOwner,
	isLive: () => boolean,
	identity: Omit<PlannotatorSessionOpenedEvent, "openedAt"> & { openedAt?: number },
): SessionEventHandle {
	const event: PlannotatorSessionOpenedEvent = {
		id: identity.id,
		action: identity.action,
		url: identity.url,
		openedAt: identity.openedAt ?? Date.now(),
		...(identity.piSessionId ? { piSessionId: identity.piSessionId } : {}),
		...(identity.reviewId ? { reviewId: identity.reviewId } : {}),
		...(identity.requestId ? { requestId: identity.requestId } : {}),
	};
	openIds().add(event.id);
	emitSafely(pi, liveNow(isLive), PLANNOTATOR_SESSION_OPENED_CHANNEL, { ...event });
	let closed = false;
	return {
		event,
		close(end) {
			if (closed) return;
			closed = true;
			openIds().delete(event.id);
			const closedEvent: PlannotatorSessionClosedEvent = {
				...event,
				outcome: end.outcome,
				...(end.outcome === "closed" ? { closedBy: end.closedBy ?? "reviewer" } : {}),
				closedAt: Date.now(),
			};
			emitSafely(pi, liveNow(isLive), PLANNOTATOR_SESSION_CLOSED_CHANNEL, closedEvent);
		},
	};
}

export function sessionEndOf(result: {
	approved?: boolean;
	exit?: boolean;
	closedBy?: string;
} | null | undefined): { outcome: PlannotatorSessionOutcome; closedBy?: PlannotatorSessionClosedBy } {
	if (result?.closedBy === "agent") return { outcome: "closed", closedBy: "agent" };
	if (result?.exit) return { outcome: "closed", closedBy: "reviewer" };
	if (result?.approved) return { outcome: "approved" };
	return { outcome: "submitted" };
}

export function sessionEndOfError(stopped: boolean): { outcome: "closed"; closedBy: PlannotatorSessionClosedBy } {
	return { outcome: "closed", closedBy: stopped ? "stopped" : "error" };
}
