import { isAbsolute, relative } from "path";
import {
	createFileBrowserWatchRegistry,
	type FileBrowserChangeEvent,
	type FileBrowserWatchRegistry,
} from "@plannotator/shared/file-browser-watch-core";
import {
	REPO_LIVE_POLL_MS,
	nextRepoPollDelay,
	createRepoChangeGate,
	isRepoWatchIgnored,
	isUnderIgnoredEntry,
	type RepoChangeGate,
	type RepoLiveMode,
} from "@plannotator/shared/repo-files";
import { getGitMetadataWatchPaths } from "@plannotator/shared/workspace-status";

const HEARTBEAT_MS = 30_000;
/** Live updates are debounced so a burst of writes lists the tree once. */
const REPO_WATCH_DEBOUNCE_MS = 500;
const encoder = new TextEncoder();

interface Subscriber {
	controller: ReadableStreamDefaultController;
	notify: () => void;
	deliver: (version: number) => void;
}

export interface RepoLiveOptions {
	mode: RepoLiveMode;
	signature: () => Promise<string | null>;
	ignored?: () => Promise<string[]>;
	onChange: () => void;
	pollMs?: number;
	signal?: AbortSignal;
}

export interface ReviewRepoWatch {
	stream(root: string, options: RepoLiveOptions, disableIdleTimeout?: () => void): Promise<Response>;
	closeAll(): void;
	stats(): { lives: number; subscribers: number; heartbeats: number };
	configureForTests: FileBrowserWatchRegistry<Subscriber>["configureForTests"];
}

function serialize(event: Pick<FileBrowserChangeEvent, "type" | "reason" | "timestamp">): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify({ type: event.type, reason: event.reason, timestamp: event.timestamp })}\n\n`);
}

interface Live {
	gate: RepoChangeGate;
	subscribers: Set<Subscriber>;
	releases: Set<() => void>;
	poll: ReturnType<typeof setTimeout> | null;
}

export function createReviewRepoWatch(): ReviewRepoWatch {
	const registry = createFileBrowserWatchRegistry<Subscriber>({
		send: (subscriber) => {
			subscriber.notify();
			return true;
		},
		getGitMetadataWatchPaths,
		debounceMs: REPO_WATCH_DEBOUNCE_MS,
	});
	const lives = new Map<string, Live>();
	let heartbeats = 0;

	return {
		async stream(root, options, disableIdleTimeout) {
			disableIdleTimeout?.();
			// What git ignores is read before anything is attached: a page that
			// goes away meanwhile leaves nothing behind.
			const ignoredSet = options.mode === "watch" && options.ignored
				? new Set(await options.ignored().catch(() => []))
				: new Set<string>();
			if (options.signal?.aborted) return new Response(null, { status: 204 });
			let live = lives.get(root);
			if (!live) {
				live = { gate: createRepoChangeGate(options.signature), subscribers: new Set(), releases: new Set(), poll: null };
				lives.set(root, live);
			}
			const shared = live;
			let subscriber: Subscriber | null = null;
			let heartbeat: ReturnType<typeof setInterval> | null = null;
			let handle: ReturnType<typeof registry.ensure> | null = null;
			let seen = shared.gate.version;
			const release = () => {
				if (heartbeat) {
					clearInterval(heartbeat);
					heartbeat = null;
					heartbeats -= 1;
				}
				shared.releases.delete(release);
				options.signal?.removeEventListener("abort", release);
				if (!subscriber) return;
				if (handle) registry.release(handle, subscriber);
				shared.subscribers.delete(subscriber);
				if (shared.subscribers.size === 0) {
					if (shared.poll) clearTimeout(shared.poll);
					shared.poll = null;
					if (lives.get(root) === shared) lives.delete(root);
					// Nothing watches the disk any more, so the cached listing could go
					// stale unseen (a hidden tree, a closed page): the next list reads again.
					options.onChange();
				}
				subscriber = null;
			};
			shared.releases.add(release);
			options.signal?.addEventListener("abort", release, { once: true });
			const stream = new ReadableStream({
				start(controller) {
					subscriber = {
						controller,
						notify: () => {
							void shared.gate.check().then((version) => subscriber?.deliver(version));
						},
						deliver: (version) => {
							if (version === seen || !subscriber) return;
							seen = version;
							options.onChange();
							try {
								controller.enqueue(serialize({ type: "changed", reason: "files", timestamp: Date.now() }));
							} catch {
								release();
							}
						},
					};
					shared.subscribers.add(subscriber);
					if (options.mode === "watch") {
						handle = registry.ensure({
							key: `repo:${root}`,
							watchPath: root,
							watchGit: true,
							ignored: (path) => {
								const rel = relative(root, path);
								if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
								return isRepoWatchIgnored(rel) || isUnderIgnoredEntry(rel, ignoredSet);
							},
						});
						registry.attach(handle, subscriber, root);
					} else if (!shared.poll) {
						// A poll that keeps finding nothing backs off (to 30 s); a change brings it back.
						const start = options.pollMs ?? REPO_LIVE_POLL_MS;
						let delay = start;
						const tick = () => {
							const before = shared.gate.version;
							void shared.gate.check().then((version) => {
								for (const each of shared.subscribers) each.deliver(version);
								delay = nextRepoPollDelay(delay, version !== before, start);
								if (shared.poll) shared.poll = setTimeout(tick, delay);
							});
						};
						shared.poll = setTimeout(tick, delay);
					}
					controller.enqueue(serialize({ type: "ready", reason: "initial", timestamp: Date.now() }));
					heartbeats += 1;
					heartbeat = setInterval(() => {
						try {
							controller.enqueue(encoder.encode(": heartbeat\n\n"));
						} catch {
							release();
						}
					}, HEARTBEAT_MS);
				},
				cancel() {
					release();
				},
			});
			return new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
			});
		},
		closeAll() {
			for (const live of [...lives.values()]) {
				for (const release of [...live.releases]) release();
				if (live.poll) clearTimeout(live.poll);
			}
			lives.clear();
			registry.closeAll();
		},
		stats() {
			let subscribers = 0;
			for (const live of lives.values()) subscribers += live.subscribers.size;
			return { lives: lives.size, subscribers, heartbeats };
		},
		configureForTests(overrides) {
			registry.configureForTests(overrides);
		},
	};
}
