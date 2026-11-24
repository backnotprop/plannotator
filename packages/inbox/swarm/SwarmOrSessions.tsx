import { useCallback, useEffect, useState } from 'react';
import type { InboxSwarm } from '@plannotator/core/inbox-types';
import type { ThreadSession } from '../agents/model';
import type { MachinesModel } from '../machines';
import { ThreadSessions, type ThreadSessionsProps } from '../components/ThreadSessions';
import { SwarmLine } from './SwarmLine';
import { swarmApi } from './swarmApi';

const NO_NAMES: ReadonlyMap<string, string> = new Map();

/**
 * The thread header's who-is-here line: a swarm thread's line (SwarmLine), else today's sessions line
 * (ThreadSessions). A thread that never was a swarm draws exactly as before; one turned off shows the quiet badge
 * before today's line.
 */
export function SwarmOrSessions({
  threadId,
  swarm: given,
  machine,
  machines,
  ...rest
}: ThreadSessionsProps & { threadId: string; swarm: InboxSwarm | undefined; machine: string | null; machines: MachinesModel | null | undefined }) {
  const [swarm, setSwarm] = useState(given);
  useEffect(() => setSwarm(given), [given]);
  const onSet = useCallback(async (on: boolean) => (await swarmApi.set(threadId, on, machine)).swarm, [threadId, machine]);
  const onRead = useCallback(async () => (await swarmApi.read(threadId, machine)).swarm, [threadId, machine]);
  if (!swarm) return <ThreadSessions {...rest} />;
  return (
    <>
      <SwarmLine
        threadId={threadId}
        swarm={swarm}
        sessions={rest.sessions as readonly ThreadSession[]}
        machine={machine}
        machineNames={machines?.names ?? NO_NAMES}
        self={machines?.self ?? null}
        phone={rest.phone ?? false}
        onSet={onSet}
        onRead={onRead}
        onChange={setSwarm}
      />
      {!swarm.on && <ThreadSessions {...rest} />}
    </>
  );
}
