/** A far thread opened before its machine's marks were read asked nothing: its checklist reads again once they are. */
import { useEffect } from 'react';
import { onLinkedMachine, useLinkedReadsRev } from '../linkedReads';

export function useFarStepsReread(threadId: string | null | undefined, emit: (threadId: string) => void): void {
  const linkedRev = useLinkedReadsRev();
  const farThread = threadId && onLinkedMachine(threadId) ? threadId : null;
  useEffect(() => {
    if (farThread && linkedRev > 0) emit(farThread);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- read again when the marks move, not when the thread does.
  }, [linkedRev]);
}
