/**
 * Relay 1.1: the `live` push, a Live Activity update.
 *
 * Apple delivers a Live Activity update straight to the activity: no
 * extension can open it first, so its content is readable by the relay and by
 * Apple. It therefore carries counts only, `{ working, stopped_on_you, ended }`,
 * and the relay refuses anything else: another key, a string, a fraction. No
 * name, subject or word can ride it, whatever an Inbox sends.
 */

export interface LiveCounts {
  working: number;
  stopped_on_you: number;
  ended: boolean;
}

export interface LivePush {
  /** Seconds since 1970: Apple keeps the newest update by it. */
  timestamp: number;
  event: "update" | "end";
  "content-state": LiveCounts;
}

const COUNT_MAX = 100_000;

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= COUNT_MAX;

function exactKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

/** The `live` field of a push request, or null when it is anything but counts in this exact shape. */
export function readLive(value: unknown): LivePush | null {
  if (!exactKeys(value, ["timestamp", "event", "content-state"])) return null;
  const { timestamp, event } = value;
  const state = value["content-state"];
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  if (event !== "update" && event !== "end") return null;
  if (!exactKeys(state, ["working", "stopped_on_you", "ended"])) return null;
  if (!isCount(state.working) || !isCount(state.stopped_on_you) || typeof state.ended !== "boolean") return null;
  return { timestamp, event, "content-state": { working: state.working, stopped_on_you: state.stopped_on_you, ended: state.ended } };
}

/** What Apple gets for a Live Activity update: the counts, rebuilt from the checked values, nothing passed through. */
export function liveBody(live: LivePush): string {
  return JSON.stringify({ aps: { timestamp: live.timestamp, event: live.event, "content-state": live["content-state"] } });
}
