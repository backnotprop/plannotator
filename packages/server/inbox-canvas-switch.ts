/**
 * Settings → Capabilities → Canvas (config.json `inboxCanvas`): a canvas in every thread (inbox-canvas.ts), off
 * unless the person turned it on. Off: no pen in the window, the canvas routes refuse (`409 canvas_off`, as Code
 * review's do), `plannotator inbox canvas` included (inbox-canvas-agent.ts), a reply's `sketch` is dropped, no canvas
 * frame reaches a window. Stored canvases stay on disk untouched. Read on every request. Bun only (the Inbox): no Pi twin.
 */

import { InboxError } from "@plannotator/shared/inbox/schema";

/** A canvas route's answer while the canvas is off (the agent's command prints it as `canvas_off: …`). */
export const INBOX_CANVAS_OFF_ANSWER = { error: "The canvas is off in this Inbox (Settings → Capabilities).", code: "canvas_off" } as const;

export interface CanvasSwitchDeps {
  /** config.json `inboxCanvas` as read now. */
  saved: () => boolean;
  /** A value the server was started with, over config (tests). */
  fixed?: boolean;
  save: (on: boolean) => void;
  /** Every window hears it (`event: capabilities`). */
  changed: () => void;
}

export function canvasSwitch(deps: CanvasSwitchDeps) {
  const on = () => deps.fixed ?? deps.saved();
  const parse = (input: unknown): boolean => {
    if (!input || typeof input !== "object" || Array.isArray(input) || typeof (input as { on?: unknown }).on !== "boolean" || Object.keys(input).some((key) => key !== "on")) {
      throw new InboxError("validation_error", "canvas: { on: boolean }.", { field: "canvas" });
    }
    return (input as { on: boolean }).on;
  };
  return {
    on,
    /** The settings POST's part: before anything is saved (a malformed value throws). */
    check(body: { canvas?: unknown }): void {
      if (body.canvas !== undefined) parse(body.canvas);
    },
    /** The answer's `canvas`, after the other fields saved. */
    answer(body: { canvas?: unknown }): { canvas: { on: boolean } } {
      if (body.canvas === undefined) return { canvas: { on: on() } };
      const next = parse(body.canvas);
      const was = on();
      deps.save(next);
      if (deps.saved() !== next) throw new InboxError("config_not_saved", "config.json could not be saved; nothing changed. A config.json that is not valid JSON is never written over: fix or remove it.");
      // Every window follows at once (its Settings switch, both pens).
      if (was !== on()) deps.changed();
      return { canvas: { on: on() } };
    },
  };
}
