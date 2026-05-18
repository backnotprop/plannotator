import { SessionFacts } from "../shared/ui/SessionFacts";
import type { ShellSessionBootstrap } from "./types";

interface UnsupportedSessionViewProps {
  bootstrap: ShellSessionBootstrap;
}

export function UnsupportedSessionView({ bootstrap }: UnsupportedSessionViewProps) {
  return (
    <section className="session-panel" aria-label="Unsupported session">
      <header>
        <p className="eyebrow">Unsupported session</p>
        <h2>{bootstrap.session.label}</h2>
        <p>
          This shell received mode <code>{bootstrap.session.mode}</code>. The route and bootstrap
          contract are working, but no product view owns this mode yet.
        </p>
      </header>
      <SessionFacts bootstrap={bootstrap} />
    </section>
  );
}
