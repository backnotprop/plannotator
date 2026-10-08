import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { inboxApi, type LanState, type PairedDevice, type PairingOffer, type TailnetState } from '../api';
import { shortTime } from '../format';
import { Icon } from '../icons';
import { qrModules } from '../qr';

/** How often the open pairing panel looks for the phone that scanned it. */
const PAIRED_POLL_MS = 2000;

const PLATFORM: Record<string, string> = { ios: 'iPhone' };

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

/** The certificate's SHA-256 in groups of four, for a person comparing it by eye. */
function grouped(hex: string): string {
  return hex.match(/.{1,4}/g)?.join(' ') ?? hex;
}

function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Remove, asked twice like Delete thread: "Remove? Click again", then the phone's token stops working. */
function RemoveLink({ name, onRemove }: { name: string; onRemove: () => Promise<void> }) {
  const [state, setState] = useState<'idle' | 'confirm' | 'busy'>('idle');
  useEffect(() => {
    if (state !== 'confirm') return;
    const timer = setTimeout(() => setState('idle'), 4000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className={`ib-del-l${state === 'confirm' ? ' ib-confirm' : ''}`}
      disabled={state === 'busy'}
      aria-label={state === 'confirm' ? `Remove ${name}: click again to remove` : `Remove ${name}`}
      onClick={() => {
        if (state === 'idle') return setState('confirm');
        if (state !== 'confirm') return;
        setState('busy');
        onRemove().finally(() => setState('idle'));
      }}
    >
      {state === 'confirm' ? 'Remove? Click again' : 'Remove'}
    </button>
  );
}

/**
 * Phones (not in the window's design record: OWNER-ITEMS item 23, built in
 * Settings' own style): "Reach from this Wi-Fi" and "Reach from my tailnet",
 * in the order the iPhone's 9.2 lists them, "Pair a phone" with the QR
 * code and the six digits (the panel the iPhone's 1.2 render points at), and
 * the paired phones with Remove.
 */
export function PhonesBlock() {
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [tailnet, setTailnet] = useState<TailnetState | null>(null);
  const [lan, setLan] = useState<LanState | null>(null);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [paired, setPaired] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = useRef<Set<string> | null>(null);

  const readDevices = useCallback(async () => {
    const { devices: next } = await inboxApi.devices();
    setDevices(next);
    return next;
  }, []);

  useEffect(() => {
    readDevices()
      .then((list) => (known.current = new Set(list.map((d) => d.id))))
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
    inboxApi
      .tailnet()
      .then(({ tailnet: state }) => setTailnet(state))
      .catch(() => {});
    inboxApi
      .lan()
      .then(({ lan: state }) => setLan(state))
      .catch(() => {});
  }, [readDevices]);

  // While the code shows: the countdown, and the phone that redeems it closes the panel.
  useEffect(() => {
    if (!offer) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => {
      readDevices()
        .then((list) => {
          const fresh = list.find((d) => !known.current?.has(d.id));
          known.current = new Set(list.map((d) => d.id));
          if (fresh) {
            setOffer(null);
            setPaired(fresh.name);
          }
        })
        .catch(() => {});
    }, PAIRED_POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [offer, readDevices]);

  const pair = async () => {
    setError(null);
    setPaired(null);
    setBusy(true);
    try {
      known.current = new Set((await readDevices()).map((d) => d.id));
      setOffer(await inboxApi.pairPhone());
      setNow(Date.now());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No pairing code was made.');
    } finally {
      setBusy(false);
    }
  };

  const switchTailnet = async (on: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const { tailnet: state } = await inboxApi.setTailnet(on);
      setTailnet(state);
      // The QR carries the address: a code made before the switch moved is made again.
      if (offer) {
        setOffer(await inboxApi.pairPhone());
        setNow(Date.now());
      }
    } catch (cause) {
      setTailnet((current) => (current ? { ...current, on: false, address: null } : current));
      setError(cause instanceof Error ? cause.message : 'The switch was not saved.');
    } finally {
      setBusy(false);
    }
  };

  const switchLan = async (on: boolean) => {
    setError(null);
    setBusy(true);
    try {
      const { lan: state } = await inboxApi.setLan(on);
      setLan(state);
      // The QR carries the address and the fingerprint: a code made before the switch moved is made again.
      if (offer) {
        setOffer(await inboxApi.pairPhone());
        setNow(Date.now());
      }
    } catch (cause) {
      setLan((current) => (current ? { ...current, on: false, address: null, fingerprint: null, bonjour: false } : current));
      setError(cause instanceof Error ? cause.message : 'The switch was not saved.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError(null);
    try {
      await inboxApi.removeDevice(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The phone was not removed.');
    }
    await readDevices().catch(() => {});
  };

  const left = offer ? Date.parse(offer.offer.expires_at) - now : 0;
  const expired = offer !== null && left <= 0;
  const tailnetOn = tailnet?.on === true && tailnet.address !== null;
  // On while the listener runs, even with no network address for a moment (the error says so).
  const lanOn = lan?.on === true && lan.fingerprint !== null;

  return (
    <div className="ib-sblock" data-settings-phones="">
      <h2>Phones</h2>
      <p>Read and answer the Inbox from Plannotator on your iPhone. Each phone gets its own key, and Remove takes it back.</p>
      <div className="ib-srow" data-lan={lanOn ? 'on' : 'off'}>
        Reach from this Wi-Fi
        <span className="ib-d" data-lan-address={lan?.address ?? ''}>
          {lanOn ? (lan!.address ?? 'No network address') : 'Phones on the same network, over an encrypted connection they check'}
        </span>
        <span className="ib-r">
          <button
            type="button"
            role="switch"
            className="ib-sw"
            aria-checked={lanOn}
            aria-label="Reach from this Wi-Fi"
            disabled={!lan || busy}
            onClick={() => void switchLan(!lanOn)}
          />
        </span>
      </div>
      {lanOn && (
        <div className="ib-fp" data-lan-fingerprint={lan!.fingerprint!}>
          Certificate SHA-256 <span>{grouped(lan!.fingerprint!)}</span>
        </div>
      )}
      {lanOn && !lan!.bonjour && (
        <div className="ib-note" data-lan-no-bonjour="">
          <Icon name="info" />
          Phones will not see this computer in their nearby list (no dns-sd or avahi-publish). Scanning the code still pairs them.
        </div>
      )}
      {lan?.on && lan.error && <div className="ib-error">{lan.error}</div>}
      <div className="ib-srow" data-tailnet={tailnetOn ? 'on' : 'off'}>
        Reach from my tailnet
        <span className="ib-d" data-tailnet-address={tailnet?.address ?? ''}>
          {tailnetOn ? tailnet!.address : 'Through Tailscale, without opening this computer to the internet'}
        </span>
        <span className="ib-r">
          <button
            type="button"
            role="switch"
            className="ib-sw"
            aria-checked={tailnetOn}
            aria-label="Reach from my tailnet"
            disabled={!tailnet || busy}
            onClick={() => void switchTailnet(!tailnetOn)}
          />
        </span>
      </div>
      {tailnet?.on && tailnet.error && <div className="ib-error">{tailnet.error}</div>}

      {offer ? (
        <div className="ib-pair" data-pair-offer="" data-expired={expired ? 'true' : 'false'}>
          <div className={`ib-qr-wrap${expired ? ' ib-stale' : ''}`}>
            <QrCode link={offer.link} />
          </div>
          <div className="ib-pair-t">
            <h3>Pair a phone</h3>
            {/* Over the Wi-Fi the phone pairs by the scan only (contract section 3); the digits serve the tailnet. */}
            <p>{offer.addresses.tailnet ? 'Scan with Plannotator on your iPhone, or enter the code.' : 'Scan with Plannotator on your iPhone.'}</p>
            <div className="ib-pair-code" data-pair-code={offer.offer.code} aria-label={`Pairing code ${offer.offer.code.split('').join(' ')}`}>
              {offer.offer.code.slice(0, 3)} {offer.offer.code.slice(3)}
            </div>
            <div className="ib-pair-foot">
              {expired ? <span>This code expired.</span> : <span data-pair-left="">Expires in {countdown(left)}</span>}
              <button type="button" className="ib-btn ib-sm" disabled={busy} onClick={() => void pair()}>
                New code
              </button>
              <button type="button" className="ib-btn ib-sm ib-ghost" onClick={() => setOffer(null)}>
                Done
              </button>
            </div>
            {!offer.addresses.tailnet && !offer.addresses.lan && (
              <div className="ib-note" data-pair-no-path="">
                <Icon name="info" />
                Your phone needs a way to reach this computer.
                <button type="button" className="ib-btn ib-sm" disabled={busy || !lan} onClick={() => void switchLan(true)}>
                  Turn on Reach from this Wi-Fi
                </button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="ib-srow">
          <button type="button" className="ib-btn" disabled={busy} onClick={() => void pair()} data-pair-start="">
            Pair a phone
          </button>
          {paired && (
            <span className="ib-d ib-paired" data-paired="">
              <Icon name="check" size={13} /> Paired with {paired}.
            </span>
          )}
        </div>
      )}
      {error && <div className="ib-error">{error}</div>}

      {devices && devices.length > 0 && (
        <div className="ib-devices" aria-label="Paired phones">
          {devices.map((device) => (
            <div className="ib-srow" key={device.id} data-device={device.id}>
              <Icon name="phone" size={16} />
              {device.name}
              <span className="ib-d">
                {PLATFORM[device.platform] ?? device.platform} · last seen {shortTime(device.last_seen_at)}
              </span>
              <span className="ib-r">
                <RemoveLink name={device.name} onRemove={() => remove(device.id)} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
