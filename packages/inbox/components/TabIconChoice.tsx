import { useEffect, useState, useSyncExternalStore } from 'react';
import { FAVICON_STYLE_CHOICES, faviconDataUrl, faviconPngDataUrl, type FaviconStyle } from '@plannotator/core/favicon';
import { previewFavicon } from '../faviconChoice';
import { Modal } from './Updates';

export const TAB_ICON_CHOICE_WORDS = {
  title: 'Which favicon do you prefer?',
  note: 'You can change this in Settings.',
  inUse: 'In use',
} as const;

export interface TabIconChoiceProps {
  phone: boolean;
  current: FaviconStyle;
  title: string;
  onUse: (style: FaviconStyle) => void;
  onDismiss: () => void;
}

export function TabIconChoice({ phone, current, title, onUse, onDismiss }: TabIconChoiceProps) {
  const words = TAB_ICON_CHOICE_WORDS;
  const [picked, setPicked] = useState<FaviconStyle>(current);
  const art = useTabIconArt();
  const tabIcon = useDocumentIcon();
  const pickedLabel = FAVICON_STYLE_CHOICES.find((choice) => choice.id === picked)?.label ?? '';
  const pick = (style: FaviconStyle) => {
    setPicked(style);
    previewFavicon(style === current ? null : style);
  };
  const dismiss = () => {
    previewFavicon(null);
    onDismiss();
  };
  return (
    <Modal labelledBy="ib-tic-title" describedBy="ib-tic-note" testId="tab-icon-choice" onClose={dismiss} ownKeys initialFocus="#ib-tic-title" className={`ib-cro ib-tic${phone ? ' ib-cro-phone' : ''}`}>
      <div className="ib-tic-strip" aria-hidden="true">
        <span className="ib-tic-tab" data-on="">
          <span className="ib-tic-foot" />
          <img alt="" width={16} height={16} src={tabIcon ?? faviconPngDataUrl(picked)} data-tab-icon-strip="inbox" />
          <span className="ib-tic-title">{title}</span>
          <TabClose />
        </span>
        <span className="ib-tic-tab">
          <img alt="" width={16} height={16} src={faviconDataUrl(picked)} data-tab-icon-strip="plan" />
          <span className="ib-tic-title">Plan review</span>
          <TabClose />
        </span>
        <span className="ib-tic-tab">
          <img alt="" width={16} height={16} src={faviconDataUrl(picked)} data-tab-icon-strip="review" />
          <span className="ib-tic-title">Code Review</span>
          <TabClose />
        </span>
      </div>
      <div className="ib-cro-body">
        <h2 id="ib-tic-title" tabIndex={-1}>
          {words.title}
        </h2>
        <div className="ib-tic-opts" role="radiogroup" aria-labelledby="ib-tic-title">
          {FAVICON_STYLE_CHOICES.map((choice) => (
            <label key={choice.id} className="ib-tic-opt" data-on={picked === choice.id ? '' : undefined} data-tab-icon-choice={choice.id}>
              <input type="radio" name="ib-tic" value={choice.id} checked={picked === choice.id} onChange={() => pick(choice.id)} />
              <img className="ib-tic-big" alt="" src={art?.[choice.id] ?? faviconPngDataUrl(choice.id)} />
              <span className="ib-tic-name">
                <img alt="" width={16} height={16} src={faviconDataUrl(choice.id)} />
                {choice.label}
                {choice.id === current && <span className="ib-lvc-tag ib-lvc-inuse">{words.inUse}</span>}
              </span>
            </label>
          ))}
        </div>
        <div className="ib-cro-acts">
          <p className="ib-cro-note" id="ib-tic-note">
            {words.note}
          </p>
          <span className="ib-bsp" />
          <button type="button" className="ib-btn ib-pri" onClick={() => onUse(picked)} data-tab-icon-use={picked}>
            {picked === current ? `Keep ${pickedLabel}` : `Use ${pickedLabel}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function useTabIconArt(): Readonly<Record<FaviconStyle, string>> | null {
  const [art, setArt] = useState<Readonly<Record<FaviconStyle, string>> | null>(null);
  useEffect(() => {
    let gone = false;
    import('../tabIconArt').then(
      (mod) => !gone && setArt(mod.TAB_ICON_ART),
      () => {},
    );
    return () => {
      gone = true;
    };
  }, []);
  return art;
}

function useDocumentIcon(): string | null {
  return useSyncExternalStore(
    (changed) => {
      const observer = new MutationObserver(changed);
      observer.observe(document.head, { subtree: true, childList: true, attributes: true, attributeFilter: ['href'] });
      return () => observer.disconnect();
    },
    () => document.head.querySelector<HTMLLinkElement>('link[rel="icon"]')?.getAttribute('href') ?? null,
  );
}

function TabClose() {
  return (
    <svg className="ib-tic-x" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5 5l6 6M11 5l-6 6" />
    </svg>
  );
}
