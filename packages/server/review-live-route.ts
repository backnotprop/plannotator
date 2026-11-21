import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { handleReviewLiveRequest, isReviewLivePath, type ReviewLiveContext } from "@plannotator/shared/review-live";

export function createReviewLiveRoute(context: Omit<ReviewLiveContext, "dataDir"> & { dataDir?: string }) {
  return async (req: Request, url: URL): Promise<Response | null> => {
    if (!isReviewLivePath(url.pathname)) return null;
    const answer = await handleReviewLiveRequest(
      {
        method: req.method,
        pathname: url.pathname,
        signal: req.signal,
        readJson: async () => {
          const value = await req.json().catch(() => ({}));
          return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
        },
      },
      { ...context, dataDir: context.dataDir ?? getPlannotatorDataDir() },
    );
    if (!answer) return null;
    if ("stream" in answer) {
      return new Response(answer.stream, { status: answer.status, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
    }
    return Response.json(answer.json, { status: answer.status });
  };
}
