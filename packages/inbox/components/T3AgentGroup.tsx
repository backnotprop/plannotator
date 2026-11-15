/**
 * Settings → Agents' T3 Code group (the owner's "A · One row", 2026-11-15),
 * shown only when T3 Code is on this computer (`InboxAgentsModel.t3`). One
 * row, Your replies: they arrive as a new turn when this computer's `t3`
 * command or a saved sign-in can send them, with a quiet line while T3 is
 * closed; otherwise they are seen when the thread checks the Inbox, and the
 * sign-in fix sits under it, the T3 waiting line's sentence and command. It
 * lights no dot on Settings' Agents item: the row says it.
 */

import { INBOX_T3_HOST, INBOX_T3_LOGIN_COMMAND, INBOX_T3_NAME, INBOX_T3_SIGN_IN_TEXT, INBOX_T3_URL_WHERE, type InboxT3Status } from '@plannotator/core/inbox-types';
import { HostMark } from '../icons';
import { agentWords, Row } from './AgentsSettings';
import { CopyCommand } from './RestartNote';
import { T3_SIGN_IN_COPY } from './T3WaitLine';
import { Tip } from './Tip';

/** Whether a reply wakes a T3 thread from here: the local `t3` command, or a saved sign-in that can send. */
export function t3RepliesWake(t3: InboxT3Status): boolean {
  return t3.local || t3.sign_in === 'ok';
}

export function T3AgentGroup({ t3 }: { t3: InboxT3Status }) {
  const wakes = t3RepliesWake(t3);
  const closed = t3.local && !t3.open;
  return (
    <div className="ib-agent" data-agent={INBOX_T3_HOST} data-t3-state={wakes ? (closed ? 'closed' : 'wakes') : 'sign_in'}>
      <div className="ib-aghead">
        <HostMark host={INBOX_T3_HOST} big />
        <b>{INBOX_T3_NAME}</b>
        <span className="ib-agvia">Claude and Codex threads</span>
        <span className={`ib-agstate${wakes ? '' : ' ib-agoff'}`}>
          <span className="ib-agdot" />
          {wakes ? agentWords.connected : agentWords.notConnected}
        </span>
      </div>
      <Row
        k={agentWords.replies}
        v={wakes ? agentWords.repliesWake : agentWords.repliesCheck}
        data={{ 'data-agent-replies': wakes ? 'wake' : 'check' }}
        warn={!wakes}
        sub={
          wakes ? (
            closed ? (
              "T3 isn't open. They go in when you open it."
            ) : null
          ) : (
            <span data-t3-sign-in="">
              {INBOX_T3_SIGN_IN_TEXT}{' '}
              <span className="mt-1 flex flex-wrap items-center gap-2">
                <Tip content={INBOX_T3_URL_WHERE} side="bottom">
                  <code className="text-foreground" data-t3-command="">
                    {INBOX_T3_LOGIN_COMMAND}
                  </code>
                </Tip>
                <CopyCommand text={INBOX_T3_LOGIN_COMMAND} label={T3_SIGN_IN_COPY.label} announcement={T3_SIGN_IN_COPY.announcement} />
              </span>
            </span>
          )
        }
      />
    </div>
  );
}
