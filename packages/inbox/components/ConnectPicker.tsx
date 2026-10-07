import { useState } from 'react';
import { copyTextToClipboard } from '@plannotator/ui/utils/clipboard';
import { harnessPanel, type Artefact, type ConnectContext, type Harness, type HarnessId } from '../harnesses';
import { Icon, TabGlyph } from '../icons';

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ib-copy"
      onClick={async () => {
        if (await copyTextToClipboard(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

/** A code box with Copy; `wrap` is the narrow form inside a host card. */
export function CodeBox({ text, label, wrap }: { text: string; label?: string; wrap?: boolean }) {
  return (
    <>
      {label && <div className="ib-clab">{label}</div>}
      <div className={`ib-cbox${wrap ? ' ib-wrap' : ''}`}>
        <pre>{text}</pre>
        <CopyButton text={text} />
      </div>
    </>
  );
}

function ArtefactView({ artefact }: { artefact: Artefact }) {
  if (artefact.kind === 'link') {
    return (
      <div>
        <a className="ib-btn ib-pri" href={artefact.href} style={{ textDecoration: 'none' }}>
          <Icon name="external" size={15} />
          {artefact.label}
        </a>
      </div>
    );
  }
  return <CodeBox text={artefact.text} label={artefact.label} />;
}

function Another({ summary, body }: { summary: string; body?: Artefact }) {
  const [open, setOpen] = useState(false);
  if (!body) {
    return (
      <div className="ib-another">
        <Icon name="chevR" size={13} />
        Another way<span className="ib-mut">{summary}</span>
      </div>
    );
  }
  return (
    <div>
      <button type="button" className="ib-another" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <Icon name={open ? 'chevD' : 'chevR'} size={13} />
        Another way<span className="ib-mut">{summary}</span>
      </button>
      {open && (
        <div className="ib-another-body ib-cpanel">
          <ArtefactView artefact={body} />
        </div>
      )}
    </div>
  );
}

export interface ConnectPickerProps {
  harnesses: readonly Harness[];
  initial: HarnessId;
  context: ConnectContext;
  compact?: boolean;
  icons?: boolean;
}

/** Tabs per harness, then the one verified way to add the Inbox there (Workspaces' ConnectAgentSheet shape). */
export function ConnectPicker({ harnesses, initial, context, compact, icons }: ConnectPickerProps) {
  const [selected, setSelected] = useState<HarnessId>(initial);
  const harness = harnesses.find((h) => h.id === selected) ?? harnesses[0]!;
  const panel = harnessPanel(harness.id, context);
  return (
    <div className={`ib-connect${compact ? ' ib-compact' : ''}`}>
      <div className="ib-ctabs" role="tablist" aria-label="Agent harness">
        {harnesses.map((h) => (
          <button
            key={h.id}
            type="button"
            role="tab"
            className="ib-ctab"
            aria-selected={h.id === harness.id}
            onClick={() => setSelected(h.id)}
          >
            {icons && <TabGlyph harness={h.id} />}
            {h.label}
          </button>
        ))}
      </div>
      <div className="ib-cpanel" role="tabpanel" aria-label={harness.label}>
        <div className="ib-eye">{harness.label}</div>
        <p className="ib-lead">{panel.lead}</p>
        {panel.artefacts.map((artefact, i) => (
          <ArtefactView key={i} artefact={artefact} />
        ))}
        {panel.after && <p className="ib-after">{panel.after}</p>}
        {panel.another && <Another summary={panel.another.summary} body={panel.another.body} />}
        {panel.note && (
          <div className="ib-cnote">
            <Icon name="info" size={15} />
            <span>{panel.note}</span>
          </div>
        )}
      </div>
    </div>
  );
}
