import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { InboxApiError, inboxApi, type MachineOffer, type MachineView, type OutboxView } from '../api';
import { shortTime } from '../format';
import { Icon } from '../icons';
import { machineStatus } from '../machines';
import { CodeBox, CopyButton } from './ConnectPicker';
import { UnlinkLink } from './Devices';

/**
 * What a refused link means, in the window's words. The server's messages
 * name CLI flags (`--back`, `--address`), so the codes the person can act on
 * are said here; anything else shows the server's own sentence.
 */
export function linkErrorText(error: unknown): string {
  if (!(error instanceof InboxApiError)) return error instanceof Error ? error.message : 'The link did not go through.';
  if (error.code === 'validation_error') {
    if (error.message.startsWith('address:')) return "Type the other machine's address on your tailnet, like mini.tail1234.ts.net:8443.";
    if (error.message.startsWith('link:')) return 'That is not a link code. A link code starts with plannotator://link.';
    return "Paste the other machine's link code, or type its address and six digits.";
  }
  if (error.code === 'no_way_back') return 'The other machine needs a way back to this one, and Tailscale could not publish this machine. Check Tailscale here, then link again.';
  if (error.code === 'local_only') return "Linking works only on this computer's own screen.";
  return error.message;
}

/** "2 waiting to send": what the outbox holds for a machine, said the same way in its line and in Unlink. */
function waitingText(waiting: number): string {
  return `${waiting} waiting to send`;
}

/** The line under a linked machine: its state, then the answers waiting for it. */
function machineLine(machine: MachineView): string {
  const status = machineStatus(machine);
  return machine.waiting > 0 ? `${status} · ${waitingText(machine.waiting)}` : status;
}

export interface MachinesSectionProps {
  /** Every machine the merged view knows, this one included. */
  machines: MachineView[];
  via: 'local' | 'tailnet';
  /** After a link or an Unlink: read the machines again. */
  onChanged: () => void;
}

/**
 * Settings → Machines: the other computers whose threads this Inbox shows.
 * Each one keeps its own Inbox; a link works both ways, over the tailnet.
 * Built like Devices → Phones: one card, a row per machine with Unlink
 * (asked twice), then the row that starts a link. Linking is local only,
 * like Pair a phone, so a code never shows on another device.
 */
export function MachinesSection({ machines, via, onChanged }: MachinesSectionProps) {
  const remote = via !== 'local';
  const linked = machines.filter((machine) => !machine.self);
  // Why this Inbox's own door is not on the tailnet (its port held by another mapping): linked machines cannot reach it until that is fixed.
  const doorError = machines.find((machine) => machine.self)?.reason ?? null;
  const [linking, setLinking] = useState(false);
  const [offer, setOffer] = useState<MachineOffer | null>(null);
  const [offering, setOffering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justLinked, setJustLinked] = useState<string | null>(null);
  // After an Unlink the other machine could not hear (asleep): it drops the link at its next contact, said here.
  const [unlinkedNote, setUnlinkedNote] = useState<string | null>(null);
  const linkButton = useRef<HTMLButtonElement>(null);
  // A code someone used is spent: once a new machine shows up, the code goes away.
  const linkedCount = useRef(linked.length);
  useEffect(() => {
    if (linked.length > linkedCount.current) setOffer(null);
    linkedCount.current = linked.length;
  }, [linked.length]);

  const showOffer = async () => {
    setOffering(true);
    setError(null);
    try {
      setOffer(await inboxApi.offerMachine());
    } catch (cause) {
      setError(linkErrorText(cause));
    } finally {
      setOffering(false);
    }
  };

  return (
    <section className="ib-sgroup" data-settings-machines="" aria-labelledby="ib-g-machines">
      <h2 id="ib-g-machines">Linked machines</h2>
      <p>A link works both ways, over your tailnet. Unlink removes it on both machines.</p>
      {remote && (
        <div className="ib-callout" data-machines-remote="">
          <Icon name="lock" />
          <span>You opened this page over your tailnet. Linking and Unlink work only on this computer&apos;s own screen, so a code is never shown to another device.</span>
        </div>
      )}
      {doorError && (
        <div className="ib-callout ib-warn" role="alert" data-machines-door-error="">
          <Icon name="warn" />
          <span>This machine is not on your tailnet, so linked machines cannot reach it: {doorError}</span>
        </div>
      )}
      <div className="ib-card" aria-label="Linked machines">
        {linked.map((machine) => (
          <div className="ib-prow" key={machine.id} data-machine-row={machine.id} data-machine-state={machine.state}>
            <span className="ib-tile">
              <Icon name="system" />
            </span>
            <span className="ib-txt">
              <span className="ib-l">{machine.name}</span>
              <span className="ib-desc">{machineLine(machine)}</span>
            </span>
            <span className="ib-ctl">
              {!remote && (
                <UnlinkLink
                  name={machine.name}
                  warning={machine.waiting > 0 ? `${waitingText(machine.waiting)} will be lost.` : undefined}
                  onRemove={async () => {
                    setError(null);
                    setUnlinkedNote(null);
                    try {
                      const answer = await inboxApi.unlinkMachine(machine.id);
                      if (!answer.told) setUnlinkedNote(`Unlinked here. ${machine.name} could not be reached, so it drops the link the next time it is in touch. This computer stays reachable on your tailnet for it for up to 7 days, until it hears.`);
                    } catch (cause) {
                      setError(linkErrorText(cause));
                    }
                    onChanged();
                  }}
                />
              )}
            </span>
          </div>
        ))}
        {linking && !remote ? (
          <LinkForm
            onCancel={() => {
              setLinking(false);
              linkButton.current?.focus();
            }}
            onLinked={(name) => {
              setLinking(false);
              setJustLinked(name);
              onChanged();
            }}
          />
        ) : (
          <div className="ib-prow" data-machine-start="">
            <span className="ib-txt">
              <span className="ib-l">{linked.length > 0 ? 'Link another machine' : 'No machine linked yet'}</span>
              {linked.length === 0 && <span className="ib-desc">Make a link code on the other computer, then paste it here.</span>}
              {unlinkedNote && (
                <span className="ib-desc" data-machine-unlinked="" role="status">
                  {unlinkedNote}
                </span>
              )}
              {justLinked && (
                <span className="ib-desc ib-paired" data-machine-linked="" role="status">
                  <Icon name="check" size={13} /> Linked with {justLinked}.
                </span>
              )}
            </span>
            <span className="ib-ctl">
              <button
                ref={linkButton}
                type="button"
                className={`ib-btn${linked.length === 0 ? ' ib-pri' : ''}`}
                disabled={remote}
                onClick={() => {
                  setJustLinked(null);
                  setUnlinkedNote(null);
                  setError(null);
                  setLinking(true);
                }}
                data-machine-link=""
              >
                Link a machine
              </button>
            </span>
          </div>
        )}
        <div className="ib-prow" data-machine-offer-row="">
          <span className="ib-txt">
            <span className="ib-l">This machine&apos;s link code</span>
            <span className="ib-desc">
              {offer
                ? `Paste it in Settings → Machines on the other computer before ${shortTime(offer.expires_at)}. Each code works once. This Inbox stays on your tailnet while a code is open or a machine is linked.`
                : 'Showing a code puts this Inbox on your tailnet with Tailscale Serve, so the other computer can reach it.'}
            </span>
          </span>
          <span className="ib-ctl">
            <button type="button" className="ib-btn" disabled={remote || offering} onClick={() => void showOffer()} data-machine-offer-start="">
              {offer ? 'New code' : 'Show link code'}
            </button>
          </span>
        </div>
        {offer && !remote && (
          <div className="ib-mcode" data-machine-offer="">
            {offer.tailnet_error && (
              <div className="ib-callout ib-warn" data-machine-offer-tailnet="">
                <Icon name="warn" />
                <span>
                  Tailscale did not publish this machine, so the other computer cannot reach it yet: {offer.tailnet_error}
                </span>
              </div>
            )}
            <CodeBox text={offer.link} />
            {offer.tailnet && (
              <p className="ib-cnote">
                Or type this machine&apos;s address, <code>{offer.tailnet}</code>, and <code className="ib-mcode-digits">{offer.code}</code>.
              </p>
            )}
          </div>
        )}
      </div>
      {error && (
        <div className="ib-callout ib-err" role="alert" data-machines-error="">
          <Icon name="xCircle" />
          <span>{error}</span>
        </div>
      )}
      <UnsentWrites linked={machines} />
    </section>
  );
}

/**
 * What was waiting for a machine when its link went (an Unlink here, or one done on that machine): never dropped
 * silently. Its words stay here to copy, until the person dismisses them. Read from the outbox when the page opens,
 * and again when a machine leaves the list.
 */
function UnsentWrites({ linked }: { linked: readonly MachineView[] }) {
  const [entries, setEntries] = useState<OutboxView[]>([]);
  const ids = linked.map((m) => m.id).join('|');
  useEffect(() => {
    let live = true;
    inboxApi.outbox().then(
      ({ notices }) => {
        if (live) setEntries(notices ?? []);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [ids]);
  const known = new Set(linked.map((m) => m.id));
  const unsent = entries.filter((entry) => entry.notice !== null && !entry.dismissed && !known.has(entry.machine));
  if (unsent.length === 0) return null;
  return (
    <>
      <p className="ib-mnote">Not sent: these were waiting for a machine that is no longer linked. Copy the words to send them another way.</p>
      <div className="ib-card" aria-label="Not sent" data-machines-unsent="">
        {unsent.map((entry) => (
          <div className="ib-prow" key={entry.key} data-unsent={entry.key}>
            <span className="ib-txt">
              <span className="ib-l">
                {entry.notice?.kind === 'may_have_been_delivered' ? 'May have reached' : 'Not sent to'} {entry.machine_name ?? 'a machine no longer linked'} · {shortTime(entry.queued_at)}
              </span>
              {entry.words ? (
                <span className="ib-desc ib-held-words" dir="auto">
                  {entry.words}
                </span>
              ) : (
                <span className="ib-desc">{unsentWhat(entry.route)}</span>
              )}
            </span>
            <span className="ib-ctl">
              {entry.words && <CopyButton text={entry.words} />}
              <button
                type="button"
                className="ib-btn ib-ghost"
                data-unsent-dismiss=""
                onClick={() => {
                  setEntries((current) => current.filter((e) => e.key !== entry.key));
                  void inboxApi.dismissOutbox(entry.key).catch(() => {});
                }}
              >
                Dismiss
              </button>
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/** A held write with no words, said by what it did. */
function unsentWhat(route: string): string {
  if (/\/picks$/.test(route)) return 'A pick';
  if (/\/(read|seen)$/.test(route)) return 'Mark read';
  if (/\/resolve$/.test(route)) return 'Archive';
  return 'A change';
}

/** Link a machine: paste its link code, or type its address and six digits. Only the Link button sends. */
function LinkForm({ onCancel, onLinked }: { onCancel: () => void; onLinked: (name: string) => void }) {
  const [link, setLink] = useState('');
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  const pasted = link.trim();
  const typed = address.trim() && /^\d{6}$/.test(code.trim());
  const ready = !busy && (pasted !== '' || !!typed);

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await inboxApi.linkMachine(pasted ? { link: pasted } : { address: address.trim(), code: code.trim() });
      onLinked(answer.machine.name);
    } catch (cause) {
      setError(linkErrorText(cause));
      setBusy(false);
    }
  };
  // Enter does not link (no new keys in the Inbox): only the Link button does.
  const noEnter = (event: KeyboardEvent) => {
    if (event.key === 'Enter') event.preventDefault();
  };

  return (
    <div className="ib-mform" data-machine-link-form="">
      <label className="ib-mfield">
        <span className="ib-l">Link code from the other computer</span>
        <input
          ref={first}
          type="text"
          className="ib-fbk-contact ib-mono"
          placeholder="plannotator://link?…"
          spellCheck={false}
          autoComplete="off"
          value={link}
          readOnly={busy}
          onChange={(event) => setLink(event.target.value)}
          onKeyDown={noEnter}
          data-machine-link-code=""
        />
      </label>
      <div className="ib-mor">Or its address and six digits</div>
      <div className="ib-mpair">
        <label className="ib-mfield">
          <span className="ib-sr">Address</span>
          <input
            type="text"
            className="ib-fbk-contact"
            placeholder="Its address, like mini.tail1234.ts.net:8443"
            spellCheck={false}
            autoComplete="off"
            value={address}
            readOnly={busy || pasted !== ''}
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={noEnter}
            data-machine-link-address=""
          />
        </label>
        <label className="ib-mfield ib-mdigits">
          <span className="ib-sr">Six digits</span>
          <input
            type="text"
            className="ib-fbk-contact ib-mono"
            inputMode="numeric"
            maxLength={6}
            placeholder="Six digits"
            autoComplete="one-time-code"
            value={code}
            readOnly={busy || pasted !== ''}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
            onKeyDown={noEnter}
            data-machine-link-digits=""
          />
        </label>
      </div>
      {error && (
        <div className="ib-callout ib-err" role="alert" data-machine-link-error="">
          <Icon name="xCircle" />
          <span>{error}</span>
        </div>
      )}
      <div className="ib-mform-f">
        <button type="button" className="ib-btn ib-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={`ib-btn ib-pri${ready ? '' : ' ib-dim'}`} aria-disabled={!ready} onClick={() => void submit()} data-machine-link-submit="">
          {busy ? 'Linking…' : 'Link'}
        </button>
      </div>
    </div>
  );
}
