/** Options for waiting on a plan-review decision with bounded lifetime signals. */
export interface PlanReviewWaitOptions<T> {
  /** The browser decision owned by the running plan server. */
  waitForDecision: () => Promise<T>;
  /** Optional configured timeout. `null` keeps the review open indefinitely. */
  timeoutMs: number | null;
  /** Result returned when the configured timeout expires. */
  timeoutResult: T;
  /** Optional host cancellation signal for the tool invocation. */
  signal?: AbortSignal;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/**
 * Wait for a plan decision, configured timeout, or host cancellation.
 *
 * The caller retains ownership of the server and must stop it in `finally`.
 * This function owns and removes the timeout and abort listener it creates.
 */
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

/**
 * Keep the browser response visible briefly after a decision while still
 * allowing host cancellation to release the server immediately.
 */
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
