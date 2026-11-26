/**
 * A decision sent to a review whose agent is gone (packages/shared/review-agent-gone.ts).
 *
 * What regresses if this fails: the page shows a gone agent's refusal as a
 * generic server error, offers a Retry that can never reach anyone, or, after
 * the review ended because its agent left, blames an unreachable Plannotator
 * instead of saying the agent is gone.
 */
import { describe, expect, test } from 'bun:test';
// The servers' codes, from the module both servers use. @plannotator/ui is
// published and @plannotator/shared is not, so it keeps its own copies; this pins them.
import {
  AGENT_AWAY_CODE as SERVER_AGENT_AWAY_CODE,
  AGENT_GONE_CODE as SERVER_AGENT_GONE_CODE,
  NO_SESSION_CODE as SERVER_NO_SESSION_CODE,
} from '../../shared/review-agent-gone';
import {
  AGENT_AWAY_CODE,
  AGENT_GONE_CODE,
  NO_SESSION_CODE,
  assertSendOk,
  canRetrySend,
  DecisionSendError,
  describeSendFailure,
  sendErrorAfterAgentGone,
  sendFailureOf,
} from './sendFailure';

async function failureFor(res: Response) {
  try {
    await assertSendOk(res);
    return null;
  } catch (error) {
    return sendFailureOf(error);
  }
}

describe('agent gone', () => {
  test("the server's refusal reads as agent-gone: no Retry, and a reason that is not an outage", async () => {
    // What both review servers answer (packages/shared/review-agent-gone.ts).
    const failure = await failureFor(Response.json({ error: 'gone', code: SERVER_AGENT_GONE_CODE }, { status: 410 }));
    expect(failure).toEqual({ kind: 'agent-gone' });
    expect(canRetrySend(failure!)).toBe(false);
    // Not an outage: the server answered.
    expect(describeSendFailure(failure!)).not.toBe(describeSendFailure({ kind: 'unreachable' }));
  });

  // L2: Pi between sessions answers 409 agent_away: Retry stays, since a session may be back a moment later.
  test("no session right now (Pi between sessions): Retry stays, and the reason says so", async () => {
    const failure = await failureFor(Response.json({ error: 'away', code: SERVER_AGENT_AWAY_CODE }, { status: 409 }));
    expect(failure).toEqual({ kind: 'agent-away' });
    expect(canRetrySend(failure!)).toBe(true);
  });

  // L1: OpenCode with no session never had an agent to lose.
  test('a review with no session: no Retry, and it never claims an agent is gone', async () => {
    const failure = await failureFor(Response.json({ error: 'none', code: SERVER_NO_SESSION_CODE }, { status: 410 }));
    expect(failure).toEqual({ kind: 'no-session' });
    expect(canRetrySend(failure!)).toBe(false);
  });

  test("the page's codes are the servers' codes", () => {
    expect([AGENT_GONE_CODE, AGENT_AWAY_CODE, NO_SESSION_CODE]).toEqual([SERVER_AGENT_GONE_CODE, SERVER_AGENT_AWAY_CODE, SERVER_NO_SESSION_CODE]);
  });

  test('any other 410 stays a plain rejection', async () => {
    expect(await failureFor(Response.json({ error: 'x' }, { status: 410 }))).toEqual({ kind: 'rejected', status: 410 });
  });

  test('a send after the page heard the agent is gone: an unreachable server reads as agent-gone, any other answer as itself', () => {
    const unreachable = new DecisionSendError({ kind: 'unreachable' });
    expect(sendFailureOf(sendErrorAfterAgentGone(unreachable, true))).toEqual({ kind: 'agent-gone' });
    expect(sendErrorAfterAgentGone(unreachable, false)).toBe(unreachable);
    const decided = new DecisionSendError({ kind: 'decided' });
    expect(sendErrorAfterAgentGone(decided, true)).toBe(decided);
  });
});
