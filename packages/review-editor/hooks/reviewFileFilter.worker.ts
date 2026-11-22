import { compileReviewFileFilter, type ReviewFileFilter } from '@plannotator/shared/review-file-filter';

export interface RepoFileFilterRequest {
  id: number;
  filter: ReviewFileFilter;
  paths?: string[];
}

export interface RepoFileFilterResponse {
  id: number;
  paths: string[];
}

const BATCH_SIZE = 8192;

let paths: string[] = [];
let latestRequest = 0;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

self.onmessage = async ({ data }: MessageEvent<RepoFileFilterRequest>) => {
  const { id, filter } = data;
  latestRequest = id;

  if (data.paths) paths = data.paths;

  const source = paths;
  const matches = compileReviewFileFilter(filter);
  if (!matches) {
    self.postMessage({ id, paths: source } satisfies RepoFileFilterResponse);
    return;
  }

  const matching: string[] = [];
  for (let start = 0; start < source.length; start += BATCH_SIZE) {
    const end = Math.min(start + BATCH_SIZE, source.length);

    for (let index = start; index < end; index++) {
      const path = source[index];
      if (matches(path)) matching.push(path);
    }

    if (end < source.length) {
      // A newer filter request may have arrived while we scanned this batch.
      await yieldToEventLoop();
      if (id !== latestRequest) return;
    }
  }

  self.postMessage({ id, paths: matching } satisfies RepoFileFilterResponse);
};
