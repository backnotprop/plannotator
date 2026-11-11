/** The host id a T3 Code thread is recorded under. */
export const INBOX_T3_HOST = "t3";

/** How the person sees a T3 Code thread. */
export const INBOX_T3_NAME = "T3 Code";

/** The variable T3 Code sets in every process an agent of the thread starts. */
export const INBOX_T3_THREAD_ENV = "T3CODE_THREAD_ID";

const T3_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isT3ThreadId(value: unknown): value is string {
  return typeof value === "string" && T3_THREAD_ID.test(value);
}
