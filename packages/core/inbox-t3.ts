export const INBOX_T3_HOST = "t3";

export const INBOX_T3_NAME = "T3 Code";

export const INBOX_T3_THREAD_ENV = "T3CODE_THREAD_ID";

const T3_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isT3ThreadId(value: unknown): value is string {
  return typeof value === "string" && T3_THREAD_ID.test(value);
}
