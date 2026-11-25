/**
 * A Grid nudge's idempotency key (approval "inbox-agent-grid", round 4): made here and read here, nowhere else.
 *
 * One press of Nudge is one write however often it is sent: a second window, a double click or a held copy carries
 * the same key, so the thread's computer writes it once. The key names the thread, the start of the quiet stretch on
 * the thread's own clock (so windows on computers whose clocks differ agree), which three-hour turn of that stretch
 * it was pressed in (a nudge is offered again three quiet hours later, under a new key), and how many of the thread's
 * nudges were taken back (after a Take back, the next press is a new write, not a replay of the one taken back).
 *
 * The window derives a held nudge from its outbox by this key (a held nudge counts as nudged in every window and after
 * a reload), and the server holds no second nudge for a thread while one waits for its computer (inbox-machines.ts).
 */
export interface GridNudgeKey {
  /** The thread's id (its root message's id). */
  thread: string;
  /** When the quiet stretch began, on the thread's own computer's clock (epoch ms). */
  quietFrom: number;
  /** The three-hour turn of the stretch it was pressed in (1 for the first three quiet hours past the first three). */
  turn: number;
  /** How many of the thread's nudges were taken back when it was pressed. */
  taken: number;
}

const PREFIX = "grid-nudge-";
const KEY = /^grid-nudge-(msg_[A-Za-z0-9]+)-(\d+)-(\d+)-(\d+)$/;

export function gridNudgeKey(key: GridNudgeKey): string {
  return `${PREFIX}${key.thread}-${Math.round(key.quietFrom)}-${key.turn}-${key.taken}`;
}

/** The key's parts, or null for any other key (a typed reply's, an older window's nudge). */
export function gridNudgeKeyRead(key: string): GridNudgeKey | null {
  const match = KEY.exec(key);
  if (!match) return null;
  return { thread: match[1]!, quietFrom: Number(match[2]), turn: Number(match[3]), taken: Number(match[4]) };
}
