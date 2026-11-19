/**
 * What an agent's Rex pane says it is doing (inbox-rex.ts `statuses`: OSC 7501's root record, state and kind only),
 * folded into what the Inbox already says of it. The Inbox's own knowledge comes first: a thread waiting on the person
 * stays `waiting`, an ended session stays `ended`. Rex fills in what the Inbox cannot know: a pane blocked on the
 * person (a permission prompt, a question, a sign-in in the terminal) is `waiting`, with its kind; a pane working is
 * `working` though the Inbox heard nothing of a turn; a pane that says it is done or failed keeps the Inbox's `idle`
 * and says so in its card. A pane at rest says nothing new.
 */
import type { InboxAgent, InboxRexMark } from "@plannotator/core/inbox-types";
import type { InboxRexStatus } from "./inbox-rex";

export function withRexStatus(given: InboxAgent, status: InboxRexStatus | null | undefined): InboxAgent {
  if (!status) return given;
  // Its pane reports its turns, whatever its connection does: never "turns unknown" (inbox-agent-mark.ts).
  const { turns_unknown: _unknown, ...agent } = given;
  if (agent.state === "waiting" || agent.state === "ended") return agent;
  if (status.state === "blocked") return { ...agent, state: "waiting", rex_status: { state: "blocked", ...(status.kind ? { kind: status.kind } : {}) } };
  if (status.state === "working") return agent.state === "working" ? agent : { ...agent, state: "working" };
  if ((status.state === "done" || status.state === "error") && agent.state === "idle") return { ...agent, rex_status: { state: status.state } };
  return agent;
}

/**
 * The mark an agent's icon carries (the owner's "jelly" marks), for a session the Inbox started in Rex while "Start
 * new agents in" is Rex: its pane's status record as read in the last few seconds, as it is (state, and for
 * `blocked` its kind). An agent ended, or with no fresh record, carries none: today's icon.
 */
export function withRexMark(agent: InboxAgent, status: InboxRexStatus | null | undefined): InboxAgent {
  if (!status || agent.state === "ended") return agent;
  const mark: InboxRexMark = { state: status.state, ...(status.state === "blocked" && status.kind ? { kind: status.kind } : {}) };
  // A fresh Rex record wins over the mark the Inbox worked out itself (inbox-agent-mark.ts): Rex knows more (done,
  // blocked in the pane). One mark per agent.
  const { status_mark: _own, ...rest } = agent;
  return { ...rest, rex_mark: mark };
}
