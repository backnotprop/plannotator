/** Single-flights in-app CallDiff runtime installs: concurrent POSTs join the active install and never start a second download. The install is opt-in; enabling Call flow is the consent. */
import { isSameOriginOrNoOrigin } from "./request-origin";
import { installCallFlowLanguagePack, installCallFlowRuntime, preflightCallFlowNode } from "./call-flow";
import type { CallFlowNodePreflight, CallFlowRuntimeInstallResult } from "./call-flow";
import type { CallFlowLanguageId } from "./call-flow-languages";
import type { CallFlowInstallStage, CallFlowInstallStatus } from "./call-flow-types";

export type { CallFlowInstallStatus };

export interface CallFlowInstallCoordinatorOptions {
  readonly install?: (id: CallFlowLanguageId, onStage: (stage: CallFlowInstallStage) => void) => Promise<CallFlowRuntimeInstallResult>;
  readonly preflight?: () => Promise<CallFlowNodePreflight>;
  readonly onSettled?: (ok: boolean) => void;
}

export class CallFlowInstallCoordinator {
  private status: CallFlowInstallStatus = { state: "idle" };
  private startGate: Promise<CallFlowInstallStatus> | null = null;
  private readonly pending = new Set<CallFlowLanguageId>();
  private readonly requested = new Set<CallFlowLanguageId>();
  private readonly install: NonNullable<CallFlowInstallCoordinatorOptions["install"]>;
  private readonly preflight: NonNullable<CallFlowInstallCoordinatorOptions["preflight"]>;
  private readonly onSettled: CallFlowInstallCoordinatorOptions["onSettled"];

  constructor(options: CallFlowInstallCoordinatorOptions = {}) {
    this.install = options.install ?? ((id, onStage) => id === "javascript-typescript"
      ? installCallFlowRuntime(onStage)
      : installCallFlowLanguagePack(id, onStage));
    this.preflight = options.preflight ?? preflightCallFlowNode;
    this.onSettled = options.onSettled;
  }

  getStatus(): CallFlowInstallStatus {
    return this.status;
  }

  /** Resolves once the install is running (or failed its preflight), not when the download completes. */
  start(languageIds: readonly CallFlowLanguageId[]): Promise<CallFlowInstallStatus> {
    for (const id of languageIds) {
      // `requested` spans the whole active flight; repeated POSTs must not requeue a target runInstall already removed from pending.
      if (!this.requested.has(id)) this.pending.add(id);
      this.requested.add(id);
    }
    if (languageIds.length === 0) return Promise.resolve(this.status);
    if (this.status.state === "running") {
      this.status = { ...this.status, languageIds: [...this.requested] };
      return Promise.resolve(this.status);
    }
    if (this.startGate) return this.startGate;
    const gate = (async (): Promise<CallFlowInstallStatus> => {
      const node = await this.preflight();
      if (!node.ok) {
        this.status = { state: "error", error: node.message, reason: node.reason, languageIds: [...this.requested] };
        this.startGate = null;
        // The failed attempt belongs to the review that requested it. A later
        // retry may come from a different view with a different language set.
        this.pending.clear();
        this.requested.clear();
        this.onSettled?.(false);
        return this.status;
      }
      this.status = { state: "running", stage: "downloading", languageIds: [...this.requested] };
      void this.runInstall();
      return this.status;
    })();
    this.startGate = gate;
    return gate;
  }

  private async runInstall(): Promise<void> {
    let ok = false;
    let currentLanguageId: CallFlowLanguageId | undefined;
    try {
      while (this.pending.size > 0) {
        const id = this.pending.values().next().value;
        if (!id) break;
        currentLanguageId = id;
        this.pending.delete(id);
        const result = await this.install(id, (stage) => {
          if (this.status.state === "running") {
            this.status = { state: "running", stage, languageIds: [...this.requested], currentLanguageId: id };
          }
        });
        if (!result.ok) {
          this.status = { state: "error", error: result.message, languageIds: [...this.requested], currentLanguageId: id };
          return;
        }
      }
      ok = true;
      this.status = { state: "done", languageIds: [...this.requested] };
    } catch (error) {
      this.status = {
        state: "error",
        error: error instanceof Error ? error.message : String(error),
        languageIds: [...this.requested],
        ...(currentLanguageId && { currentLanguageId }),
      };
    } finally {
      this.startGate = null;
      this.pending.clear();
      this.requested.clear();
      this.onSettled?.(ok);
    }
  }
}

/** Starting the install triggers a native download and build, so a cross-origin POST must not start it: an Origin header, when present, must match the request host. Non-browser clients pass. */
export function callFlowInstallOriginAllowed(
  originHeader: string | null | undefined,
  requestHost: string,
  fetchSite?: string | string[] | null,
): boolean {
  return isSameOriginOrNoOrigin(originHeader, requestHost, fetchSite);
}
