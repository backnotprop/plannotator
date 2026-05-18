import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import {
  daemonApiClient,
  type DaemonApiClient,
  type ShellSessionAction,
} from "../daemon/api/client";
import type { ShellSessionBootstrap, ShellSessionSummary } from "../daemon/contracts";

interface SessionDebugPanelProps {
  bootstrap: ShellSessionBootstrap;
  client?: DaemonApiClient;
}

type ActionRole = "approve" | "deny" | "secondary";

interface SessionActionDef {
  action: ShellSessionAction;
  label: string;
  role: ActionRole;
}

const SESSION_ACTIONS: Partial<Record<ShellSessionSummary["mode"], SessionActionDef[]>> = {
  plan: [
    { action: "plan-approve", label: "Approve", role: "approve" },
    { action: "plan-deny", label: "Deny", role: "deny" },
  ],
  review: [
    { action: "review-approve", label: "LGTM", role: "approve" },
    { action: "review-feedback", label: "Feedback", role: "secondary" },
    { action: "review-exit", label: "Exit", role: "secondary" },
  ],
  annotate: [
    { action: "annotate-approve", label: "Approve", role: "approve" },
    { action: "annotate-feedback", label: "Feedback", role: "secondary" },
    { action: "annotate-exit", label: "Exit", role: "secondary" },
  ],
  archive: [{ action: "archive-done", label: "Close", role: "secondary" }],
  "setup-goal": [
    { action: "plan-approve", label: "Approve", role: "approve" },
    { action: "plan-deny", label: "Deny", role: "deny" },
  ],
};

export function SessionDebugPanel({ bootstrap, client = daemonApiClient }: SessionDebugPanelProps) {
  const navigate = useNavigate();
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ label: string; payload: unknown } | null>(null);
  const probePath = useMemo(() => probePathForSession(bootstrap.session), [bootstrap.session]);
  const actions = SESSION_ACTIONS[bootstrap.session.mode] ?? [];

  const runProbe = async () => {
    setBusyLabel("Probe");
    try {
      const response = await client.probeSessionApi(bootstrap.session.id, probePath);
      setLastResult({ label: `GET ${probePath}`, payload: response });
    } catch (err) {
      setLastResult({ label: `GET ${probePath}`, payload: formatError(err) });
    } finally {
      setBusyLabel(null);
    }
  };

  const runAction = async (action: ShellSessionAction, label: string) => {
    setBusyLabel(label);
    try {
      await client.runSessionAction(bootstrap.session, action);
      void navigate({ to: "/" });
    } catch (err) {
      setLastResult({ label, payload: formatError(err) });
      setBusyLabel(null);
    }
  };

  return (
    <section className="session-debug">
      <div className="session-actions">
        {actions.map(({ action, label, role }) => (
          <button
            type="button"
            key={action}
            className={`action-btn action-${role}`}
            onClick={() => void runAction(action, label)}
            disabled={busyLabel !== null}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="debug-actions">
        <button type="button" onClick={() => void runProbe()} disabled={busyLabel !== null}>
          Probe {probePath}
        </button>
      </div>

      {lastResult ? (
        <details className="debug-result" open>
          <summary>{lastResult.label}</summary>
          <pre className="json-block">{JSON.stringify(lastResult.payload, null, 2)}</pre>
        </details>
      ) : null}

      <details className="debug-result">
        <summary>Session bootstrap</summary>
        <pre className="json-block">{JSON.stringify(bootstrap, null, 2)}</pre>
      </details>
    </section>
  );
}

function probePathForSession(session: ShellSessionSummary): string {
  if (session.mode === "review") return "/api/diff";
  return "/api/plan";
}

function formatError(err: unknown): { ok: false; message: string } {
  return {
    ok: false,
    message: err instanceof Error ? err.message : "Unexpected error.",
  };
}
