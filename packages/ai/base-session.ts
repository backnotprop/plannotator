/**
 * Shared session base class — extracts the common lifecycle, abort, and
 * ID-resolution logic that every AIProvider session needs.
 *
 * Concrete providers extend this and implement query().
 */

import type { AIMessage, AIQueryOptions, AISession } from "./types.ts";

export abstract class BaseSession implements AISession {
	readonly parentSessionId: string | null;
	onIdResolved?: (oldId: string, newId: string) => void;

	protected _placeholderId: string;
	protected _resolvedId: string | null = null;
	protected _isActive = false;
	protected _currentAbort: AbortController | null = null;
	protected _queryGen = 0;
	protected _firstQuerySent = false;

	constructor(opts: { parentSessionId: string | null; initialId?: string }) {
		this.parentSessionId = opts.parentSessionId;
		this._placeholderId = opts.initialId ?? crypto.randomUUID();
	}

	get id(): string {
		return this._resolvedId ?? this._placeholderId;
	}

	get isActive(): boolean {
		return this._isActive;
	}

	// ---------------------------------------------------------------------------
	// Query lifecycle helpers — call from concrete query() implementations
	// ---------------------------------------------------------------------------

	/** Error message returned when a query is already active. */
	static readonly BUSY_ERROR: AIMessage = {
		type: "error",
		error:
			"A query is already in progress. Abort the current query before sending a new one.",
		code: "session_busy",
	};

	/**
	 * Call at the start of query(). Returns the generation number and abort
	 * signal, or null if the session is busy.
	 */
	protected startQuery(): { gen: number; signal: AbortSignal } | null {
		if (this._isActive) return null;

		const gen = ++this._queryGen;
		this._isActive = true;
		this._currentAbort = new AbortController();
		return { gen, signal: this._currentAbort.signal };
	}

	/**
	 * Call in the finally block of query(). Only clears state if the
	 * generation matches (prevents a stale finally from clobbering a newer query).
	 */
	protected endQuery(gen: number): void {
		if (this._queryGen === gen) {
			this._isActive = false;
			this._currentAbort = null;
		}
	}

	/**
	 * Call when the provider resolves the real session ID from the backend.
	 * Fires the onIdResolved callback so the SessionManager can remap its key.
	 */
	protected resolveId(newId: string): void {
		if (this._resolvedId) return; // Already resolved
		const oldId = this._placeholderId;
		this._resolvedId = newId;
		this.onIdResolved?.(oldId, newId);
	}

	/**
	 * Abort the current in-flight query. Subclasses should call super.abort()
	 * after any provider-specific cleanup.
	 */
	abort(): void {
		if (this._currentAbort) {
			this._currentAbort.abort();
			this._isActive = false;
			this._currentAbort = null;
		}
	}

	abstract query(prompt: string, options?: AIQueryOptions): AsyncIterable<AIMessage>;
}
