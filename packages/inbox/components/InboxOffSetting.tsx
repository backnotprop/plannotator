/**
 * Settings → General's "Turn the Inbox off" (packages/shared/inbox/inbox-on.ts):
 * the Inbox is on only once the person turned it on here, and this is where
 * they turn it off. No confirmation (turning it back on is one command): the
 * click records off, removes Plannotator's untouched notes in agents'
 * instruction files, and stops this Inbox (`POST /api/inbox/off`). What is
 * left on screen says so, and how to turn it back on.
 */
import { useState } from 'react';
import { apiPost } from '../api';
import { inboxUrl } from '../inboxUrl';

/** What the person reads after turning it off: the server's lines (the first says it is off, the last how to turn it back on). */
export function InboxOffScreen({ lines }: { lines: readonly string[] }) {
  const [first, ...rest] = lines;
  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-background p-6"
      role="status"
      aria-live="polite"
      data-inbox-off-screen=""
    >
      <div className="w-full max-w-[460px] space-y-3 text-[14px] leading-relaxed text-foreground">
        <h1 className="text-[18px] font-semibold">The Inbox is off</h1>
        {first ? <p>{first.replace(/^The Plannotator Inbox is off on this computer: /, 'On this computer, ')}</p> : null}
        {rest.map((line) => (
          <p key={line} className="text-muted-foreground">
            {withCode(line)}
          </p>
        ))}
        <p className="text-muted-foreground">You can close this tab.</p>
      </div>
    </div>
  );
}

/** `plannotator inbox` and `plannotator inbox stop` in a line, as code. */
function withCode(line: string) {
  const parts = line.split(/(plannotator inbox(?: stop)?)/);
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[12.5px] text-foreground">
        {part}
      </code>
    ) : (
      part
    ),
  );
}

export function InboxOffSetting({ post = apiPost }: { post?: typeof apiPost }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [off, setOff] = useState<readonly string[] | null>(null);
  const turnOff = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const answer = await post<{ ok: boolean; lines?: string[] }>(inboxUrl('/off'), {});
      setOff(answer.lines ?? ['The Plannotator Inbox is off on this computer.']);
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  };
  return (
    <section className="ib-sgroup" data-settings-inbox-off="" aria-labelledby="ib-g-inbox-on">
      <h2 id="ib-g-inbox-on">This computer</h2>
      <div className="ib-card">
        <div className="ib-prow">
          <span className="ib-txt">
            <span className="ib-l">The Inbox is on</span>
            <span className="ib-desc">
              Agents on this computer can leave you messages and questions here. Turn it off and they stop: nothing starts it again until you run <code>plannotator inbox</code>.
            </span>
            {failed ? (
              <span className="ib-desc" role="alert" data-inbox-off-failed="">
                {failed}
              </span>
            ) : null}
          </span>
          <span className="ib-ctl">
            <button type="button" className="ib-btn" onClick={turnOff} disabled={busy} data-settings-turn-off="">
              {busy ? 'Turning off…' : 'Turn the Inbox off'}
            </button>
          </span>
        </div>
      </div>
      {off ? <InboxOffScreen lines={off} /> : null}
    </section>
  );
}
