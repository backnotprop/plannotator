/**
 * `plannotator inbox canvas`, shared by the command (apps/hook/server/inbox-canvas-command.ts) and the Inbox
 * (packages/server/inbox-canvas-agent.ts, inbox-canvas.ts): the route the command calls, and the command an answer
 * offers for the next read, so what an answer says to run is what the command takes.
 */

/** The route the command calls (POST, one ask). */
export const INBOX_CANVAS_AGENT_ROUTE = "/api/inbox/canvas/agent";

/** A word for a shell: as it is when nothing in it needs quoting, else in single quotes. */
const shellWord = (value: string): string => (/^[A-Za-z0-9_.,:/@=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/** The command for the next read: the canvas of a thread, one frame of it (`in`), the rest of a cut reading (`after_thing`), or exactly some things (`things`). */
export function canvasReadCommand(threadId: string, more: { in?: string; after_thing?: string; things?: readonly string[] } = {}): string {
  const parts = ["plannotator inbox canvas", shellWord(threadId)];
  if (more.in) parts.push("--in", shellWord(more.in));
  if (more.after_thing) parts.push("--after", shellWord(more.after_thing));
  if (more.things && more.things.length > 0) parts.push("--things", shellWord(more.things.join(",")));
  return parts.join(" ");
}
