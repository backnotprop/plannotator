/**
 * Editor-side client-lease helper.
 *
 * The annotate server advertises a last-client abandonment lease (see
 * packages/shared/annotate-client-lease.ts) via `/api/plan`'s `clientLease`
 * field for local direct structured annotate gates. When enabled, this tab
 * opens a single EventSource against the shared stream path so the server
 * can detect the tab going away and dismiss the pending gate after a grace
 * period — no pagehide/beforeunload/sendBeacon involved; presence is
 * inferred purely from the open connection.
 */

import { ANNOTATE_CLIENT_LEASE_STREAM_PATH } from '@plannotator/shared/annotate-client-lease';

export { ANNOTATE_CLIENT_LEASE_STREAM_PATH };

export interface AnnotateClientLeaseConfig {
  enabled: boolean;
  reconnectGraceMs?: number;
}

export interface ShouldConnectAnnotateClientLeaseInput {
  annotateMode: boolean;
  isSharedSession: boolean;
  /** Decision already taken, if any. Nullish means the session is still open. */
  submitted: string | null | undefined;
  clientLease: AnnotateClientLeaseConfig | null | undefined;
}

/**
 * Whether this tab should open the client-lease stream right now. Only one
 * live annotate session — not shared/static, not already decided — with the
 * server-advertised capability enabled should ever connect.
 */
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
  /** Idempotent — safe to call more than once (e.g. cleanup + explicit completion both fire it). */
  close: () => void;
}

/**
 * Open the single client-lease EventSource for this tab. No message payload
 * is read — the connection itself (open vs. closed) is the entire signal;
 * the server's ready/heartbeat comments only keep the stream alive.
 */
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
