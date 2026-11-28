/**
 * Rex as a terminal place (inbox-terminal-place.ts): what the launch engine asks of a place, answered by this
 * computer's Rex (inbox-rex.ts) exactly as the engine used to ask it, call for call.
 */
import type { InboxRex } from "./inbox-rex";
import type { InboxTerminalPlace, InboxTerminalPlaceReads } from "./inbox-terminal-place";

/** What the engine needs of Rex (a test stands in with only this). */
export type InboxRexForLaunch = Pick<InboxRex, "open" | "appAttachedNow" | "paneGone" | "closePane"> & Partial<Pick<InboxRex, "shared">> & { headless?: boolean };

export function inboxRexPlace(rex: InboxRexForLaunch): InboxTerminalPlace {
  const headless = rex.headless === true;
  return {
    kind: "rex",
    headless,
    async here() {
      if ((await rex.appAttachedNow()) === true) return { here: true };
      return { here: false, why: rex.shared?.() === true ? "shared" : headless ? "server" : "absent" };
    },
    async open(request) {
      const opened = await rex.open(request);
      return opened.opened ? { opened: true, line: opened.line, pane: opened.block ? { kind: "rex", session: opened.session, block: opened.block } : null } : opened;
    },
    paneGone: (pane) => rex.paneGone(pane),
    closePane: (pane) => rex.closePane(pane),
  };
}

// Rex's own reads (inbox.ts asks them of it directly) are a place's as they are: this stops compiling once they part.
const rexReadsArePlaceReads = (rex: InboxRex): InboxTerminalPlaceReads => rex;
void rexReadsArePlaceReads;
