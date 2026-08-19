import { describe, expect, test } from 'bun:test';
import {
  ANNOTATE_CLIENT_LEASE_STREAM_PATH,
  shouldConnectAnnotateClientLease,
  openAnnotateClientLeaseStream,
  type AnnotateClientLeaseConfig,
} from './annotateClientLease';

/** Minimal fake EventSource — just enough to observe construction and close(). */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
}

describe('shouldConnectAnnotateClientLease', () => {
  const enabled: AnnotateClientLeaseConfig = { enabled: true, reconnectGraceMs: 30_000 };
  const disabled: AnnotateClientLeaseConfig = { enabled: false };

  test('connects when annotate mode is active, not shared, not yet submitted, and the server enabled it', () => {
    expect(
      shouldConnectAnnotateClientLease({
        annotateMode: true,
        isSharedSession: false,
        submitted: null,
        clientLease: enabled,
      }),
    ).toBe(true);
  });

  test('treats an undefined decision the same as null: the session is still open', () => {
    expect(
      shouldConnectAnnotateClientLease({
        annotateMode: true,
        isSharedSession: false,
        submitted: undefined,
        clientLease: enabled,
      }),
    ).toBe(true);
  });

  test('does not connect when the server capability is disabled', () => {
    expect(
      shouldConnectAnnotateClientLease({
        annotateMode: true,
        isSharedSession: false,
        submitted: null,
        clientLease: disabled,
      }),
    ).toBe(false);
  });

  test('does not connect when clientLease is unavailable (undefined/null — e.g. plan review mode, or /api/plan fetch failed)', () => {
    expect(
      shouldConnectAnnotateClientLease({
        annotateMode: true,
        isSharedSession: false,
        submitted: null,
        clientLease: undefined,
      }),
    ).toBe(false);
    expect(
      shouldConnectAnnotateClientLease({
        annotateMode: true,
        isSharedSession: false,
        submitted: null,
        clientLease: null,
      }),
    ).toBe(false);
  });

  test('does not connect outside annotate mode (e.g. plan review)', () => {
    expect(
      shouldConnectAnnotateClientLease({
        annotateMode: false,
        isSharedSession: false,
        submitted: null,
        clientLease: enabled,
      }),
    ).toBe(false);
  });

  test('does not connect for a shared/static session (no live server to lease against)', () => {
    expect(
      shouldConnectAnnotateClientLease({
        annotateMode: true,
        isSharedSession: true,
        submitted: null,
        clientLease: enabled,
      }),
    ).toBe(false);
  });

  test('does not connect once a decision has already been submitted', () => {
    for (const submitted of ['approved', 'denied', 'exited'] as const) {
      expect(
        shouldConnectAnnotateClientLease({
          annotateMode: true,
          isSharedSession: false,
          submitted,
          clientLease: enabled,
        }),
      ).toBe(false);
    }
  });
});

describe('openAnnotateClientLeaseStream', () => {
  test('opens exactly one EventSource against the shared client-lease path', () => {
    FakeEventSource.instances = [];
    const stream = openAnnotateClientLeaseStream(FakeEventSource as unknown as typeof EventSource);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]!.url).toBe(ANNOTATE_CLIENT_LEASE_STREAM_PATH);

    stream.close();
  });

  test('close() is idempotent and actually closes the underlying EventSource', () => {
    FakeEventSource.instances = [];
    const stream = openAnnotateClientLeaseStream(FakeEventSource as unknown as typeof EventSource);
    const instance = FakeEventSource.instances[0]!;

    expect(instance.closed).toBe(false);
    stream.close();
    expect(instance.closed).toBe(true);

    // Calling close() again must not throw or reopen/reconstruct anything.
    expect(() => stream.close()).not.toThrow();
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
