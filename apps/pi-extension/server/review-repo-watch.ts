import type { ServerResponse } from "node:http";
import { isAbsolute, relative } from "node:path";
import {
	createFileBrowserWatchRegistry,
	type FileBrowserChangeEvent,
	type FileBrowserWatchRegistry,
} from "../generated/file-browser-watch-core.ts";
import {
	REPO_LIVE_POLL_MS,
	nextRepoPollDelay,
	createRepoChangeGate,
	isRepoWatchIgnored,
	isUnderIgnoredEntry,
	type RepoChangeGate,
	type RepoLiveMode,
} from "../generated/repo-files.ts";
import { getGitMetadataWatchPaths } from "../generated/workspace-status.ts";

const HEARTBEAT_MS = 30_000;
const REPO_WATCH_DEBOUNCE_MS = 500;

interface Subscriber {
	res: ServerResponse;
	notify: () => void;
	deliver: (version: number) => void;
}

export interface RepoLiveOptions {
	mode: RepoLiveMode;
	signature: () => Promise<string | null>;
	ignored?: () => Promise<string[]>;
	onChange: () => void;
	pollMs?: number;
}

export interface ReviewRepoWatch {
	stream(res: ServerResponse, root: string, options: RepoLiveOptions): Promise<void>;
	closeAll(): void;
	stats(): { lives: number; subscribers: number; heartbeats: number };
	configureForTests: FileBrowserWatchRegistry<Subscriber>["configureForTests"];
}

function serialize(event: Pick<FileBrowserChangeEvent, "type" | "reason" | "timestamp">): string {
	return `data: ${JSON.stringify({ type: event.type, reason: event.reason, timestamp: event.timestamp })}\n\n`;
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
		async stream(res, root, options) {
			let closed = false;
			let release: () => void = () => {
				closed = true;
			};
			res.req?.on("close", () => release());
			res.on("close", () => release());
			const ignoredSet = options.mode === "watch" && options.ignored
				? new Set(await options.ignored().catch(() => []))
				: new Set<string>();
			if (closed || res.destroyed) return;
			let live = lives.get(root);
			if (!live) {
				live = { gate: createRepoChangeGate(options.signature), subscribers: new Set(), releases: new Set(), poll: null };
				lives.set(root, live);
			}
			const shared = live;
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			let seen = shared.gate.version;
			let open = true;
			let handle: ReturnType<typeof registry.ensure> | null = null;
			const subscriber: Subscriber = {
				res,
				notify: () => {
					void shared.gate.check().then((version) => subscriber.deliver(version));
				},
				deliver: (version) => {
					if (!open || version === seen) return;
					seen = version;
					options.onChange();
					try {
						res.write(serialize({ type: "changed", reason: "files", timestamp: Date.now() }));
					} catch {
						release();
					}
				},
			};
			heartbeats += 1;
			const heartbeat = setInterval(() => {
				try {
					res.write(": heartbeat\n\n");
				} catch {
					release();
				}
			}, HEARTBEAT_MS);
			release = () => {
				if (!open) return;
				open = false;
				clearInterval(heartbeat);
				heartbeats -= 1;
				shared.releases.delete(release);
				if (handle) registry.release(handle, subscriber);
				shared.subscribers.delete(subscriber);
				if (shared.subscribers.size === 0) {
					if (shared.poll) clearTimeout(shared.poll);
					shared.poll = null;
					if (lives.get(root) === shared) lives.delete(root);
					options.onChange();
				}
			};
			shared.releases.add(release);
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
			res.write(serialize({ type: "ready", reason: "initial", timestamp: Date.now() }));
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
