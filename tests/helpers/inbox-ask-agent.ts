/**
 * A scripted agent for Ask AI, never a real agent CLI: it does what a Claude
 * Code session's connection does (long-polls the Inbox saying it can answer,
 * starts the real pull client when a question waits) and answers from a script.
 * For the window's DOM tests and its e2e spec, against any running Inbox.
 */
import type { SessionBridge, SessionBridgeHost, SessionBridgeSink, SessionBridgeStatus } from "../../packages/ai/session-bridge";
import { runPullSessionBridgeClient } from "../../packages/ai/session-bridge-pull-client";
import { INBOX_ASK_POLL_FIELD, INBOX_BRIDGE_POLL_PATH, inboxAskBridgeBase, parseInboxAskWaits } from "../../packages/shared/inbox/connection";

export interface ScriptedAskAgentOptions {
  port: number;
  /** The Inbox's token (`inbox/inbox.json`), which a real connection reads from the same place. */
  token: string;
  session: string;
  project: string;
  host?: SessionBridgeHost;
  /** The words of the answer to the message the session got (header included). Resolves when the agent has finished thinking. */
  reply: (text: string) => string | Promise<string>;
}

export interface ScriptedAskAgent {
  /** Every message that reached the session. */
  asked: string[];
  /** The next question finds the agent busy on its own work. */
  setBusy(busy: boolean): void;
  stop(): void;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export function startScriptedAskAgent(options: ScriptedAskAgentOptions): ScriptedAskAgent {
  const stopped = new AbortController();
  const asked: string[] = [];
  let status: SessionBridgeStatus = "ready";

  const answer = async (text: string, sink: SessionBridgeSink, signal: AbortSignal) => {
    const words = (await options.reply(text)).split(/(?<=\s)/);
    for (const word of words) {
      if (signal.aborted) return;
      sink.delta(word);
      await sleep(15);
    }
    if (signal.aborted) return;
    status = "ready";
    sink.done(words.join(""));
  };

  const bridge: SessionBridge = {
    host: options.host ?? "claude-code",
    modes: { turn: true, transient: false },
    status: () => status,
    ask(request, sink, signal) {
      asked.push(request.text);
      status = "busy";
      signal.addEventListener(
        "abort",
        () => {
          status = "ready";
          sink.error("aborted");
        },
        { once: true },
      );
      void answer(request.text, sink, signal);
    },
  };

  let clientRunning = false;
  const runClient = async () => {
    if (clientRunning) return;
    clientRunning = true;
    try {
      await runPullSessionBridgeClient({
        baseUrl: `http://127.0.0.1:${options.port}${inboxAskBridgeBase(options.session)}`,
        token: options.token,
        bridge,
        signal: stopped.signal,
        pollWaitMs: 400,
      });
    } catch {
      // The Inbox went away; the connection below stops with it.
    } finally {
      clientRunning = false;
    }
  };

  void (async () => {
    const body = JSON.stringify({ session: options.session, host: bridge.host, project_path: options.project, waitMs: 300, [INBOX_ASK_POLL_FIELD]: true });
    while (!stopped.signal.aborted) {
      try {
        const response = await fetch(`http://127.0.0.1:${options.port}${INBOX_BRIDGE_POLL_PATH}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.token}` },
          body,
          signal: stopped.signal,
        });
        if (parseInboxAskWaits(await response.text())) void runClient();
      } catch {
        if (stopped.signal.aborted) return;
        await sleep(100);
      }
    }
  })();

  return {
    asked,
    setBusy: (busy) => {
      status = busy ? "busy" : "ready";
    },
    stop: () => stopped.abort(),
  };
}
