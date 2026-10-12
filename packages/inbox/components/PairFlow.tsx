import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { inboxApi, type LanState, type PairedDevice, type PairingAttempt, type PairingChecks, type PairingOffer, type PairingOfferView, type TailnetState } from '../api';
import { Icon, TailscaleMark, type IconName } from '../icons';
import {
  attemptNotes,
  canShowCode,
  continueHint,
  hasFailure,
  pairedVia,
  tailscaleCheckLines,
  tailscalePhoneNeeds,
  troubleshooting,
  waysOn,
  wifiCheckLines,
  wifiPhoneNeeds,
  type CheckLine,
} from '../pairing';
import { qrModules } from '../qr';

/** How often the code's screen looks for the phone that scanned it, and for what reached the door. */
const PAIRED_POLL_MS = 2000;

/** The pairing link as a QR code: black on white whatever the theme, so every camera reads it. */
function QrCode({ link }: { link: string }) {
  const path = useMemo(() => qrModules(link), [link]);
  return (
    <svg className="ib-qr" viewBox={`-2 -2 ${path.size + 4} ${path.size + 4}`} role="img" aria-label="Pairing QR code" data-pair-qr="" shapeRendering="crispEdges">
      <rect x={-2} y={-2} width={path.size + 4} height={path.size + 4} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const CHECK_ICON: Record<CheckLine['status'], { icon: IconName; word: string }> = {
  ok: { icon: 'checkCircle', word: 'Ready' },
  warn: { icon: 'excl', word: 'Warning' },
  fail: { icon: 'xCircle', word: 'Problem' },
  later: { icon: 'minus', word: 'Not checked yet' },
};

function Checks({ lines }: { lines: CheckLine[] }) {
  return (
    <ul className="ib-checks">
      {lines.map((line) => (
        <li key={line.text} className={`ib-ck-${line.status}`} data-check={line.status}>
          <Icon name={CHECK_ICON[line.status].icon} size={14} />
          <span>
            <span className="ib-sr">{CHECK_ICON[line.status].word}: </span>
            {line.text}
            {line.fix && <span className="ib-fix">{line.fix}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Needs({ items }: { items: string[] }) {
  return (
    <ul className="ib-checks">
      {items.map((item) => (
        <li key={item} className="ib-ck-need">
          <Icon name="phone" size={14} />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export interface PairFlowProps {
  lan: LanState | null;
  tailnet: TailnetState | null;
  busy: boolean;
  /** The switches' last refusal (a way that could not be turned on), in the Inbox's words. */
  error: string | null;
  onSwitchLan: (on: boolean) => Promise<unknown>;
  onSwitchTailnet: (on: boolean) => Promise<unknown>;
  /** Read the ways again (after Check again). */
  onRefreshWays: () => void;
  readDevices: () => Promise<PairedDevice[]>;
  /** Done (step 3) or Cancel: back to Devices. */
  onClose: (paired: boolean) => void;
}

type Step = 'reach' | 'scan' | 'paired';

/**
 * Pair a phone, inline in Devices (design of record
 * `.product/approved/inbox-settings-tabs/`, section 4): always starts at
 * step 1 (owner, decision 3), "How will your phone reach this computer?",
 * then the code, then Paired. The code is shown only once a way is switched
 * on; the checks beside each way never hold the person in step 1 (pairing.ts).
 */
export function PairFlow({ lan, tailnet, busy, error, onSwitchLan, onSwitchTailnet, onRefreshWays, readDevices, onClose }: PairFlowProps) {
  const [step, setStep] = useState<Step>('reach');
  const [checks, setChecks] = useState<PairingChecks | null>(null);
  const [checking, setChecking] = useState(false);
  const [checksError, setChecksError] = useState<string | null>(null);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [view, setView] = useState<PairingOfferView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [making, setMaking] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [paired, setPaired] = useState<{ name: string; via: PairingAttempt['via'] | null } | null>(null);
  /** "Show the code" pressed with no way on: say so beside the button (the gate). */
  const [needWay, setNeedWay] = useState(false);
  /** Another window made a newer code: this one is closed. */
  const [replaced, setReplaced] = useState(false);
  const known = useRef<Set<string> | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstStep = useRef(true);

  const runChecks = useCallback(async (fresh = false) => {
    setChecking(true);
    try {
      const answer = await inboxApi.pairingChecks(fresh);
      setChecks(answer.checks);
      setChecksError(null);
    } catch (cause) {
      setChecksError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  // Each step's heading takes focus, so a keyboard or screen reader lands on what changed.
  useEffect(() => {
    heading.current?.focus({ preventScroll: firstStep.current });
    firstStep.current = false;
  }, [step]);

  const on = waysOn(lan, tailnet);
  const gateOpen = canShowCode(lan, tailnet);
  useEffect(() => {
    if (gateOpen) setNeedWay(false);
  }, [gateOpen]);

  // A ref, not state: two presses in one frame both see the state from before the first.
  const makingRef = useRef(false);
  const makeCode = async () => {
    if (makingRef.current) return;
    makingRef.current = true;
    setFlowError(null);
    setMaking(true);
    try {
      known.current = new Set((await readDevices()).map((d) => d.id));
      const made = await inboxApi.pairPhone();
      setOffer(made);
      setView(null);
      setReplaced(false);
      setNow(Date.now());
      setStep('scan');
    } catch (cause) {
      setFlowError(cause instanceof Error ? cause.message : 'No pairing code was made.');
    } finally {
      makingRef.current = false;
      setMaking(false);
    }
  };

  const showCode = () => {
    // One code at a time (makeCode's guard): a second press while the first is being made would open a
    // second offer, and the answers could land out of order, showing a code the Inbox already closed.
    if (!gateOpen) {
      setNeedWay(true);
      return;
    }
    void makeCode();
  };

  // While the code shows: the countdown, what reached the door, and the phone that redeems it.
  useEffect(() => {
    if (step !== 'scan' || !offer) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = async () => {
      try {
        const [list, read] = await Promise.all([readDevices(), inboxApi.pairingOffer().catch(() => null)]);
        // The Inbox keeps one offer: another window's New code replaces this one. Its state and attempts are not ours.
        if (read) setReplaced(read.offer !== null && read.offer.expires_at !== offer.offer.expires_at);
        if (read) setView(read.offer && read.offer.expires_at === offer.offer.expires_at ? read.offer : null);
        const fresh = list.find((d) => !known.current?.has(d.id));
        known.current = new Set(list.map((d) => d.id));
        if (fresh) {
          setPaired({ name: fresh.name, via: read?.offer ? pairedVia(read.offer.attempts) : null });
          setStep('paired');
        }
      } catch {
        // The next poll tries again.
      }
    };
    const timer = setInterval(() => void poll(), PAIRED_POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(timer);
    };
  }, [step, offer, readDevices]);

  const network = checks?.wifi.network ?? null;
  const login = checks?.tailscale.login ?? null;
  const wifiLines = checks ? wifiCheckLines(checks.wifi) : [];
  const tailscaleLines = checks ? tailscaleCheckLines(checks.tailscale) : [];
  const neitherWorks = checks !== null && !gateOpen && hasFailure(wifiLines) && hasFailure(tailscaleLines);

  const steps: { id: Step; label: string }[] = [
    { id: 'reach', label: 'How it reaches' },
    { id: 'scan', label: 'Scan' },
    { id: 'paired', label: 'Paired' },
  ];
  const stepIndex = steps.findIndex((s) => s.id === step);

  const wayCard = (kind: 'wifi' | 'tailscale') => {
    const isWifi = kind === 'wifi';
    const state = isWifi ? lan : tailnet;
    const isOn = isWifi ? on.wifi : on.tailscale;
    const lines = isWifi ? wifiLines : tailscaleLines;
    const failing = hasFailure(lines);
    const address = state?.address ?? null;
    const working = isOn && address !== null && !state?.error;
    const title = isWifi ? 'This Wi-Fi' : 'Tailscale';
    // A switch changes what the checks can see (the mapping on 8443, the listener): read them again after it.
    const switchWay = async (next: boolean) => {
      await (isWifi ? onSwitchLan : onSwitchTailnet)(next);
      void runChecks(true);
    };
    return (
      <section className={`ib-way${isOn ? ' ib-is-on' : ''}`} data-pair-way={kind} data-way-on={isOn ? 'true' : 'false'} aria-labelledby={`ib-way-${kind}`}>
        <div className="ib-way-h">
          <span className="ib-tile">{isWifi ? <Icon name="wifi" /> : <TailscaleMark />}</span>
          <span className="ib-txt">
            <b id={`ib-way-${kind}`}>{title}</b>
            <span className="ib-why">
              {isWifi ? 'Works while your phone is on the same Wi-Fi as this computer.' : 'Works from anywhere your phone has Tailscale on, at home or away.'}
            </span>
          </span>
        </div>
        <div className="ib-way-sec">
          <h5>This computer</h5>
          {checks ? <Checks lines={lines} /> : <p className="ib-mut">{checksError ? `The checks did not load: ${checksError}` : 'Checking…'}</p>}
        </div>
        <div className="ib-way-sec">
          <h5>Your phone needs</h5>
          <Needs items={isWifi ? wifiPhoneNeeds(network) : tailscalePhoneNeeds(login)} />
        </div>
        <div className="ib-way-f">
          {isOn ? (
            <>
              <span className={`ib-chip ${working ? 'ib-chip-on' : 'ib-chip-err'}`} data-way-state={working ? 'on' : 'not-working'}>
                {working ? (
                  <>
                    <Icon name="check" size={12} /> On
                  </>
                ) : (
                  'Not working'
                )}
              </span>
              <span className="ib-way-addr" title={working ? (address ?? undefined) : undefined}>
                {working ? <code>{address}</code> : (state?.error ?? 'Not reachable yet')}
              </span>
              <span className="ib-way-btns">
                <button type="button" className="ib-btn ib-sm ib-ghost" disabled={busy} onClick={() => void switchWay(false)} aria-label={`Turn off ${title}`}>
                  Turn off
                </button>
              </span>
            </>
          ) : (
            <>
              <span className="ib-way-addr">
                {failing ? 'Fix the item above, or turn it on anyway.' : isWifi ? 'Opens an encrypted listener on this network' : 'Publishes the Inbox for phones on your tailnet only'}
              </span>
              <span className="ib-way-btns">
                {failing && (
                  <button type="button" className="ib-btn ib-sm" disabled={checking} onClick={() => (onRefreshWays(), void runChecks(true))} data-check-again="">
                    <Icon name="refresh" size={14} /> Check again
                  </button>
                )}
                <button type="button" className="ib-btn ib-sm ib-pri" disabled={busy} onClick={() => void switchWay(true)} aria-label={`Turn on ${title}`} data-turn-on={kind}>
                  Turn on
                </button>
              </span>
            </>
          )}
        </div>
      </section>
    );
  };

  const left = offer ? Date.parse(offer.offer.expires_at) - now : 0;
  const expired = offer !== null && (replaced || left <= 0 || view?.state === 'expired' || view?.state === 'closed');
  const notes = view ? attemptNotes(view.attempts) : [];
  const seenNothing = expired && !replaced && (view?.attempts.length ?? 0) === 0;
  const closedByTries = view?.state === 'closed' && view.tries_left === 0;
  const tailnetAddress = offer?.addresses.tailnet ?? null;
  const lanAddress = offer?.addresses.lan && offer.addresses.fingerprint ? offer.addresses.lan : null;

  return (
    <div className="ib-flow" data-pair-flow="" data-pair-step={step}>
      <div className="ib-flow-head">
        <h3>Pair a phone</h3>
        <ol className="ib-steps" aria-label="Steps">
          {steps.map((s, i) => (
            <li key={s.id} aria-current={i === stepIndex ? 'step' : undefined} className={i < stepIndex ? 'ib-done' : undefined}>
              <span className="ib-n" aria-hidden="true">
                {i < stepIndex ? <Icon name="check" size={11} /> : i + 1}
              </span>
              {s.label}
              {i < stepIndex && <span className="ib-sr"> (done)</span>}
            </li>
          ))}
        </ol>
      </div>
      <div className="ib-flow-body">
        {step === 'reach' && (
          <>
            <h4 ref={heading} tabIndex={-1}>
              How will your phone reach this computer?
            </h4>
            <p className="ib-lead">
              The code you scan carries this computer&apos;s address, so turn on at least one way first. You can turn on both: the phone uses
              whichever works where it is.
            </p>
            <div className="ib-ways">
              {wayCard('wifi')}
              {wayCard('tailscale')}
            </div>
            {error && (
              <div className="ib-callout ib-err" role="alert">
                <Icon name="xCircle" /> <span>{error}</span>
              </div>
            )}
            {neitherWorks && (
              <div className="ib-callout ib-err" data-neither-works="">
                <Icon name="xCircle" />
                <span>
                  <b>Neither way works from this computer yet.</b> Fix one of the items above, then Check again. The code shows once a way is on.
                </span>
              </div>
            )}
            <div className="ib-flow-f">
              <span className="ib-hint" role="status" data-pair-hint={needWay ? 'need-way' : on.wifi || on.tailscale ? 'ready' : 'none'}>
                {needWay ? 'Turn on This Wi-Fi or Tailscale above first: the code carries the address your phone uses.' : continueHint(on, network)}
              </span>
              <span className="ib-right">
                <button type="button" className="ib-btn ib-ghost" onClick={() => onClose(false)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className={`ib-btn ib-pri${gateOpen ? '' : ' ib-dim'}`}
                  aria-disabled={!gateOpen || making}
                  data-show-code=""
                  onClick={showCode}
                >
                  {gateOpen ? 'Continue to the code' : 'Show the code'}
                </button>
              </span>
            </div>
            {flowError && <div className="ib-error">{flowError}</div>}
            <p className="ib-later">
              <Icon name="globe" size={14} /> Away from home without Tailscale (through Plannotator&apos;s relay) is not available yet.
            </p>
          </>
        )}

        {step === 'scan' && offer && (
          <>
            <div className="ib-scan" data-pair-offer="" data-expired={expired ? 'true' : 'false'}>
              <div className={`ib-qr-wrap${expired ? ' ib-stale' : ''}`}>
                <QrCode link={offer.link} />
                {expired && <span className="ib-qr-over">{replaced ? 'This code was replaced' : 'This code expired'}</span>}
              </div>
              <div className="ib-scan-t">
                <h4 ref={heading} tabIndex={-1}>
                  Scan with Plannotator on your iPhone
                </h4>
                {expired ? (
                  <p data-pair-closed={replaced ? 'replaced' : closedByTries ? 'tries' : 'expired'}>
                    {replaced
                      ? 'Another window made a newer code, so this one no longer pairs. Make a new code here, or scan the one in that window.'
                      : closedByTries
                        ? 'The code closed after five wrong tries. Make a new code to try again.'
                        : seenNothing
                          ? 'Make a new code to try again. Check the list below first.'
                          : 'Make a new code to try again.'}
                  </p>
                ) : tailnetAddress ? (
                  <>
                    <p>Or enter the code in the app:</p>
                    <div className="ib-pair-code" data-pair-code={offer.offer.code} aria-label={`Pairing code ${offer.offer.code.split('').join(' ')}`}>
                      {offer.offer.code.slice(0, 3)} {offer.offer.code.slice(3)}
                    </div>
                  </>
                ) : lanAddress ? (
                  <p data-pair-scan-only="">Over Wi-Fi the phone pairs by scanning only.</p>
                ) : null}
                <div className="ib-reach">
                  {lanAddress && (
                    <span data-pair-address="wifi">
                      <Icon name="wifi" size={14} /> This Wi-Fi <code>{offer.addresses.lan}</code>
                    </span>
                  )}
                  {tailnetAddress && (
                    <span data-pair-address="tailscale">
                      <TailscaleMark size={14} /> Tailscale <code>{tailnetAddress}</code>
                    </span>
                  )}
                  <button type="button" className="ib-lnk" onClick={() => setStep('reach')} data-pair-change="">
                    Change
                  </button>
                </div>
                {offer.reachable === false && (
                  <div className="ib-callout ib-warn" data-pair-unreachable="">
                    <Icon name="warn" />
                    <span>
                      <b>This code carries no address your phone can reach yet.</b> {lan?.error ?? tailnet?.error ?? 'The way you turned on is not working.'} Change how it
                      reaches this computer, then make a new code.
                    </span>
                  </div>
                )}
                {!expired && (
                  <div className="ib-before">
                    <h5>Before you scan, on your phone</h5>
                    <ul className="ib-checks">
                      {lanAddress && (
                        <li className="ib-ck-need">
                          <Icon name="wifi" size={14} />
                          <span>
                            Your iPhone is on {network ? `“${network}”` : 'the same Wi-Fi as this computer'}
                            {tailnetAddress ? ', or' : '.'}
                          </span>
                        </li>
                      )}
                      {tailnetAddress && (
                        <li className="ib-ck-need">
                          <TailscaleMark size={14} />
                          <span>Tailscale is on, signed in to the same tailnet{login ? ` (${login})` : ''}.</span>
                        </li>
                      )}
                    </ul>
                  </div>
                )}
                <div role="status" className="ib-notes" data-pair-notes="">
                  {notes.map((note) => (
                    <div key={note.key} className="ib-callout ib-warn" data-pair-note={note.kind} data-via={note.via} data-tries-left={note.triesLeft}>
                      <Icon name="warn" />
                      <span>
                        <b>{note.title}</b> {note.text}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="ib-wait">
                  {expired ? (
                    <span>{replaced ? 'Replaced by a newer code.' : closedByTries ? 'Closed after five wrong tries.' : 'Expired after 10 minutes.'}</span>
                  ) : (
                    <>
                      <span className="ib-spin" aria-hidden="true" />
                      <span data-pair-left="">Waiting for your phone · expires in {countdown(left)}</span>
                    </>
                  )}
                  <span className="ib-right">
                    <button type="button" className={`ib-btn ${expired ? 'ib-pri' : ''}`} aria-disabled={making} onClick={() => !making && void makeCode()} data-pair-new="">
                      New code
                    </button>
                    <button type="button" className="ib-btn ib-ghost" onClick={() => onClose(false)}>
                      Cancel
                    </button>
                  </span>
                </div>
                {flowError && <div className="ib-error">{flowError}</div>}
              </div>
            </div>
            {seenNothing && (
              <div className="ib-trouble" data-pair-trouble="">
                <h5>
                  <Icon name="excl" size={15} /> No phone reached this computer while the code showed
                </h5>
                <ol>
                  {troubleshooting({ wifi: lanAddress !== null, tailscale: tailnetAddress !== null }, network, login).map((item) => (
                    <li key={item.key}>
                      <b>{item.title}</b> <span className="ib-mut">{item.text}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </>
        )}

        {step === 'paired' && paired && (
          <div className="ib-done-big" data-pair-done="">
            <span className="ib-ok-ring">
              <Icon name="check" />
            </span>
            <div>
              <h4 ref={heading} tabIndex={-1}>
                Paired with {paired.name}
              </h4>
              <p>
                {paired.via === 'tailnet'
                  ? 'It reached this computer over Tailscale, at home or away.'
                  : paired.via === 'wifi'
                    ? `It reached this computer on ${network ? `“${network}”` : 'this Wi-Fi'}.${on.tailscale ? ' Away from home it uses Tailscale.' : ' It answers only on this Wi-Fi: turn on Tailscale to reach the Inbox away from home.'}`
                    : 'It reached this computer on its own address.'}
              </p>
              <button type="button" className="ib-btn ib-pri" onClick={() => onClose(true)} data-pair-finish="">
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
