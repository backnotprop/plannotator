/**
 * In-app CallDiff runtime install coordination.
 *
 * The runtime is strictly opt-in and is not installed by default. A review
 * session installs it on demand through POST /api/call-flow/install, which
 * this coordinator single-flights: concurrent POSTs (double-click, second
 * tab) join the one in-flight install and never start a second download.
 */
import { installCallFlowRuntime, preflightCallFlowNode } from "./call-flow";
import type { CallFlowNodePreflight, CallFlowRuntimeInstallResult } from "./call-flow";
import type { CallFlowInstallStage, CallFlowInstallStatus } from "./call-flow-types";

export type { CallFlowInstallStatus };

/** Injectable boundaries used by tests; production callers omit them. */
export interface CallFlowInstallCoordinatorOptions {
  readonly install?: (onStage: (stage: CallFlowInstallStage) => void) => Promise<CallFlowRuntimeInstallResult>;
  readonly preflight?: () => Promise<CallFlowNodePreflight>;
  /** Fires once per settled install attempt; ok is true only on success. */
  readonly onSettled?: (ok: boolean) => void;
}

export class CallFlowInstallCoordinator {
  private status: CallFlowInstallStatus = { state: "idle" };
  private startGate: Promise<CallFlowInstallStatus> | null = null;
  private readonly install: NonNullable<CallFlowInstallCoordinatorOptions["install"]>;
  private readonly preflight: NonNullable<CallFlowInstallCoordinatorOptions["preflight"]>;
  private readonly onSettled: CallFlowInstallCoordinatorOptions["onSettled"];

  constructor(options: CallFlowInstallCoordinatorOptions = {}) {
    this.install = options.install ?? installCallFlowRuntime;
    this.preflight = options.preflight ?? preflightCallFlowNode;
    this.onSettled = options.onSettled;
  }

  /**
   * Current install status. done persists after a successful install (the
   * next capability advert resolves the runtime as available); error
   * persists until the next start() retries.
   */
  getStatus(): CallFlowInstallStatus {
    return this.status;
  }

  /**
   * Start the runtime install in the background, or join the one already
   * running. Resolves as soon as the install is running (or has failed its
   * preflight), never when the download completes.
   */
  start(): Promise<CallFlowInstallStatus> {
    if (this.startGate) return this.startGate;
    const gate = (async (): Promise<CallFlowInstallStatus> => {
      const node = await this.preflight();
      if (!node.ok) {
        this.status = { state: "error", error: node.message, reason: node.reason };
        this.startGate = null;
        this.onSettled?.(false);
        return this.status;
      }
      this.status = { state: "running", stage: "downloading" };
      void this.runInstall();
      return this.status;
    })();
    this.startGate = gate;
    return gate;
  }

  private async runInstall(): Promise<void> {
    let ok = false;
    try {
      const result = await this.install((stage) => {
        if (this.status.state === "running") this.status = { state: "running", stage };
      });
      ok = result.ok;
      this.status = result.ok
        ? { state: "done" }
        : { state: "error", error: result.message };
    } catch (error) {
      this.status = { state: "error", error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.startGate = null;
      this.onSettled?.(ok);
    }
  }
}

/**
 * Cheap cross-origin guard for the install endpoint. Starting the install
 * triggers a large download and build, so a drive-by cross-origin POST must
 * not be able to start it: when an Origin header is present it must match
 * the request host. Same-origin requests and non-browser clients (no Origin
 * header) pass.
 */
export function callFlowInstallOriginAllowed(originHeader: string | null | undefined, requestHost: string): boolean {
  if (!originHeader) return true;
  try {
    return new URL(originHeader).host === requestHost;
  } catch {
    return false;
  }
}
