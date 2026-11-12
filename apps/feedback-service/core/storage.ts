import type { NormalizedFeedback } from "./validation";

export interface FeedbackEntry extends NormalizedFeedback {
  created_at: string;
}

export interface FeedbackStore {
  insert(entry: FeedbackEntry): Promise<void>;
}
