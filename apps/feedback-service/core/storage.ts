import type { NormalizedFeedback } from "./validation";

/** One row as it is written: the validated fields and the time it arrived. Nothing else. */
export interface FeedbackEntry extends NormalizedFeedback {
  created_at: string;
}

/**
 * Where feedback goes. Write only, by design: there is one method and it
 * appends. Reading is the owner's, in the Cloudflare dashboard or with
 * `wrangler d1 execute` (README.md), never through this Worker.
 */
export interface FeedbackStore {
  insert(entry: FeedbackEntry): Promise<void>;
}
