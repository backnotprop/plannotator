/**
 * A decision sent to a review whose agent is gone (packages/shared/review-agent-gone.ts).
 *
 * What regresses if this fails: the page shows a gone agent's refusal as a
 * generic server error, offers a Retry that can never reach anyone, or, after
 * the server quit because its agent left, blames an unreachable Plannotator
 * instead of saying the agent is gone.
 */
import { describe, expect, test } from 'bun:test';
import {
  AGENT_GONE_CODE,
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
    const failure = await failureFor(Response.json({ error: 'gone', code: 'agent_gone' }, { status: 410 }));
    expect(AGENT_GONE_CODE).toBe('agent_gone');
    expect(failure).toEqual({ kind: 'agent-gone' });
    expect(canRetrySend(failure!)).toBe(false);
    expect(describeSendFailure(failure!)).toContain('gone');
    expect(describeSendFailure(failure!)).not.toBe(describeSendFailure({ kind: 'unreachable' }));
  });

  test('any other 410 stays a plain rejection', async () => {
    expect(await failureFor(Response.json({ error: 'x' }, { status: 410 }))).toEqual({ kind: 'rejected', status: 410 });
  });

  test('a send after the page heard the agent is gone reads as agent-gone, whatever it ran into', () => {
    const unreachable = new DecisionSendError({ kind: 'unreachable' });
    expect(sendFailureOf(sendErrorAfterAgentGone(unreachable, true))).toEqual({ kind: 'agent-gone' });
    expect(sendErrorAfterAgentGone(unreachable, false)).toBe(unreachable);
  });
});
