export interface PlanReviewWaitOptions<T> {
  waitForDecision: () => Promise<T>;
  timeoutMs: number | null;
  timeoutResult: T;
  signal?: AbortSignal;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export async function waitForPlanReviewDecision<T>(
  options: PlanReviewWaitOptions<T>,
): Promise<T> {
  const { signal } = options;
  if (signal?.aborted) throw abortReason(signal);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const contenders: Promise<T>[] = [options.waitForDecision()];

  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== null) {
    contenders.push(new Promise<T>((resolve) => {
      timeoutId = setTimeout(() => resolve(options.timeoutResult), timeoutMs);
    }));
  }

  if (signal) {
    contenders.push(new Promise<T>((_resolve, reject) => {
      abortListener = () => reject(abortReason(signal));
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    }));
  }

  try {
    return await Promise.race(contenders);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

export async function waitForPlanReviewCloseDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortReason(signal);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      timeoutId = setTimeout(resolve, delayMs);
      if (!signal) return;
      abortListener = () => reject(abortReason(signal));
      signal.addEventListener("abort", abortListener, { once: true });
      if (signal.aborted) abortListener();
    });
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}
