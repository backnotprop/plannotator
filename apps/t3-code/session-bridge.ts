import type { SessionBridge, SessionBridgeAskRequest, SessionBridgeSink, SessionBridgeStatus } from "@plannotator/ai/session-bridge";
import { T3_TERMINAL, T3Thread, pause, type T3ThreadRead } from "./t3-client";

function snapshotStatus(snapshot: T3ThreadRead): SessionBridgeStatus {
  if (snapshot.thread.archived) return "gone";
  if (snapshot.thread.pendingRequestCount > 0) return "blocked";
  if (snapshot.thread.activeRunId || (!T3_TERMINAL.has(snapshot.thread.status) && snapshot.thread.status !== "idle")) return "busy";
  return "ready";
}

export class T3SessionBridge implements SessionBridge {
  readonly host = "t3" as const;
  readonly modes = { turn: true, transient: false };
  private currentStatus: SessionBridgeStatus = "gone";
  private active: AbortController | undefined;
  private generation = 0;

  constructor(readonly thread: T3Thread, private readonly pollMs = 1000, private readonly deadlineMs = 30 * 60_000) {}

  status(): SessionBridgeStatus { return this.active ? "busy" : this.currentStatus; }

  async refresh(): Promise<void> {
    try { this.currentStatus = snapshotStatus(await this.thread.read({ limit: 1, runLimit: 1, maxCharsPerItem: 1 })); }
    catch { this.currentStatus = "gone"; }
  }

  ask(request: SessionBridgeAskRequest, sink: SessionBridgeSink, signal: AbortSignal): void {
    if (this.active) { sink.error("busy"); return; }
    if (request.mode !== "turn") { sink.error("failed", "T3 does not expose transient answers."); return; }
    const controller = new AbortController();
    this.active = controller;
    const generation = ++this.generation;
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void this.answer(request, sink, controller.signal).catch((error: unknown) => {
      sink.error(controller.signal.aborted ? "aborted" : "failed", controller.signal.aborted ? "Stopped listening. The submitted question can continue in T3." : error instanceof Error ? error.message : String(error));
    }).finally(() => {
      signal.removeEventListener("abort", abort);
      if (generation === this.generation) this.active = undefined;
      void this.refresh();
    });
  }

  private async answer(request: SessionBridgeAskRequest, sink: SessionBridgeSink, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const before = await this.thread.read({ limit: 1 }, signal);
    const status = snapshotStatus(before);
    if (status !== "ready") { sink.error(status === "gone" ? "gone" : status === "blocked" ? "blocked" : "busy"); return; }
    // Timeline positions include activity hidden by the messages view.
    let position = before.thread.itemCount > 0 ? before.thread.itemCount - 1 : undefined;
    const sent = await this.thread.send(request.text, `plannotator-ask:${request.askId}`, signal);
    const deadline = Date.now() + this.deadlineMs;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const snapshot = await this.thread.itemsAfter(position, signal);
      const local = snapshot.items.filter((item) => item.sourceThreadId === this.thread.id && item.visibility !== "inherited" && item.visibility !== "synthetic");
      const ours = local.find((item) => item.type === "user_message" && item.messageId === sent.messageId);
      if (ours && ours.runId !== sent.runId) { sink.error("taken_over"); return; }
      const foreign = local.find((item) => item.type === "user_message" && item.runId === sent.runId && item.messageId !== sent.messageId);
      const answerItems = local.filter((item) => item.type === "assistant_message" && item.runId === sent.runId && (!ours || item.position > ours.position));
      if (foreign) {
        // Fetching mutable or truncated text after takeover can include the new prompt's answer.
        const partial = answerItems.filter((item) => item.position < foreign.position && item.status === "completed" && !item.textTruncated)
          .map((item) => item.text).filter(Boolean).join("\n\n");
        if (partial) sink.delta(partial);
        sink.error("taken_over");
        return;
      }
      const status = snapshot.recentRuns.find((item) => item.runId === sent.runId)?.status ?? await this.thread.runStatus(sent.runId, signal);
      if (T3_TERMINAL.has(status)) {
        if (status !== "completed") { sink.error("failed", `The T3 question ended with status ${status}.`); return; }
        // A recovered pull command can receive T3's original idempotent receipt.
        if (!ours && position !== undefined) { position = undefined; continue; }
        if (!ours) throw new Error("T3 completed the run without its correlated question.");
        const answer = (await Promise.all(answerItems.map((item) => this.thread.fullText(item, signal)))).filter(Boolean).join("\n\n");
        if (!answer) throw new Error("T3 completed the question without an assistant answer.");
        sink.done(answer);
        return;
      }
      if (snapshot.thread.archived) { sink.error("gone"); return; }
      await pause(this.pollMs, signal);
    }
    throw new Error("The T3 question did not settle in time. Check the T3 conversation.");
  }

  dispose(): void { this.active?.abort(); this.currentStatus = "gone"; }
}
