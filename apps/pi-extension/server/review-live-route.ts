import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { getPlannotatorDataDir } from "../generated/data-dir.ts";
import { handleReviewLiveRequest, isReviewLivePath, type ReviewLiveContext } from "../generated/review-live.ts";
import { json, parseBody } from "./helpers.ts";

export function createReviewLiveRoute(context: Omit<ReviewLiveContext, "dataDir"> & { dataDir?: string }) {
	return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
		if (!isReviewLivePath(url.pathname)) return false;
		const aborted = new AbortController();
		res.on("close", () => aborted.abort());
		const answer = await handleReviewLiveRequest(
			{ method: req.method ?? "GET", pathname: url.pathname, signal: aborted.signal, readJson: () => parseBody(req) },
			{ ...context, dataDir: context.dataDir ?? getPlannotatorDataDir() },
		);
		if (!answer) return false;
		if ("stream" in answer) {
			res.writeHead(answer.status, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
			Readable.fromWeb(answer.stream as unknown as WebReadableStream<Uint8Array>)
				.on("error", () => res.end())
				.pipe(res);
			return true;
		}
		json(res, answer.json, answer.status);
		return true;
	};
}
