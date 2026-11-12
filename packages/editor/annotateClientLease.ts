import { ANNOTATE_CLIENT_LEASE_STREAM_PATH } from '@plannotator/shared/annotate-client-lease';

export { ANNOTATE_CLIENT_LEASE_STREAM_PATH };

export interface AnnotateClientLeaseConfig {
  enabled: boolean;
  reconnectGraceMs?: number;
}

export interface ShouldConnectAnnotateClientLeaseInput {
  annotateMode: boolean;
  isSharedSession: boolean;
  submitted: string | null | undefined;
  clientLease: AnnotateClientLeaseConfig | null | undefined;
}

export function shouldConnectAnnotateClientLease(
  input: ShouldConnectAnnotateClientLeaseInput,
): boolean {
  return (
    input.annotateMode &&
    !input.isSharedSession &&
    input.submitted == null &&
    !!input.clientLease?.enabled
  );
}

export interface AnnotateClientLeaseStream {
  close: () => void;
}

export function openAnnotateClientLeaseStream(
  EventSourceCtor: typeof EventSource,
): AnnotateClientLeaseStream {
  const source = new EventSourceCtor(ANNOTATE_CLIENT_LEASE_STREAM_PATH);
  let closed = false;
  return {
    close: () => {
      if (closed) return;
      closed = true;
      source.close();
    },
  };
}
