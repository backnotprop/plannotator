import { useEffect, useRef, useState } from 'react';
import { PERSONAL_AGENTS_BANNER, PERSONAL_AGENTS_BANNER_WORDS } from '@plannotator/core/inbox-personal-agents';
import { inboxApi } from '../api';
import { cloudAgentsShown } from '../cloud/useCloudAgentsGate';
import { settingsHash } from '../settingsRoute';
import { Modal } from './Updates';

/** The words (approved by the owner, 2026-11-13). */
export const PERSONAL_AGENTS_COPY = {
  title: 'Your personal agents are welcome here',
  body: 'Hermes Agent, OpenClaw, Muse and Grok Bot can message you here and ask you questions, next to your coding agents.',
  settings: 'Connect one',
  done: 'Got it',
} as const;

/** The banner probe gives up after this long: the dialog then shows without it. */
export const PERSONAL_AGENTS_BANNER_WAIT_MS = 8_000;

const srcSet = (art: { x1: string; x2: string }) => `${art.x1} 1x, ${art.x2} 2x`;

/**
 * Whether both banners (light and dark) load, decided before the dialog opens: true only when both decode within
 * `waitMs`. `load` loads one srcset and settles when it is drawable.
 */
export async function probePersonalAgentsBanner(load: (srcset: string) => Promise<void>, waitMs = PERSONAL_AGENTS_BANNER_WAIT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs);
  });
  const both = Promise.all([load(srcSet(PERSONAL_AGENTS_BANNER.light)), load(srcSet(PERSONAL_AGENTS_BANNER.dark))]).then(
    () => true,
    () => false,
  );
  try {
    return await Promise.race([both, late]);
  } finally {
    clearTimeout(timer);
  }
}

const loadImage = (srcset: string) =>
  new Promise<void>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('banner'));
    img.srcset = srcset;
  });

/**
 * The banner probe for one load: null while undecided (nothing asked yet, or loading), then whether to draw it. It
 * starts once `want` is true and decides once, so the dialog never gains or loses its header while open.
 */
export function usePersonalAgentsBanner(want: boolean): boolean | null {
  const [shown, setShown] = useState<boolean | null>(null);
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (!want || asked) return;
    setAsked(true);
    void probePersonalAgentsBanner(loadImage).then(setShown);
  }, [want, asked]);
  return shown;
}

/** The second button waits this long for the Cloud agents answer, then opens Settings → Agents. */
export const PERSONAL_AGENTS_SETTINGS_WAIT_MS = 1_500;

/**
 * Where the second button goes: Settings → Cloud agents, where all four are added, when Settings shows that section
 * (the relay answered once, or an agent is paired); otherwise, or with no answer in time, Settings → Agents.
 */
export async function personalAgentsSettingsHash(answer: Promise<boolean>, waitMs = PERSONAL_AGENTS_SETTINGS_WAIT_MS): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs);
  });
  try {
    const cloud = await Promise.race([answer.catch(() => false), late]);
    return `#${settingsHash({ section: cloud ? 'cloud-agents' : 'agents' })}`;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The dialog, open once the line's claim showed it. Either button settles it (`close`); Escape or a click outside is
 * its Not now, so the line's next offer waits three days. The second button opens Settings (`personalAgentsSettingsHash`).
 */
export function PersonalAgentsIntro({ phone, banner, close }: { phone: boolean; banner: boolean; close: () => void }) {
  const cloud = useRef<Promise<boolean> | null>(null);
  useEffect(() => {
    cloud.current = inboxApi.cloudAgents().then(cloudAgentsShown, () => false);
  }, []);
  const notNow = () => {
    void inboxApi.revealNotNow('personal_agents');
    close();
  };
  const openSettings = () => {
    const answer = cloud.current ?? Promise.resolve(false);
    close();
    void personalAgentsSettingsHash(answer).then((hash) => {
      window.location.hash = hash;
    });
  };
  return (
    <Modal labelledBy="ib-pa-title" describedBy="ib-pa-desc" testId="personal-agents-intro" onClose={notNow} ownKeys className={`ib-bi ib-pa${phone ? ' ib-bi-phone' : ''}`}>
      {banner && (
        <div className="ib-pa-banner" data-personal-agents-banner="">
          <img className="ib-pa-art ib-pa-light" srcSet={srcSet(PERSONAL_AGENTS_BANNER.light)} src={PERSONAL_AGENTS_BANNER.light.x1} alt={PERSONAL_AGENTS_BANNER_WORDS} width={600} height={150} />
          <img className="ib-pa-art ib-pa-dark" srcSet={srcSet(PERSONAL_AGENTS_BANNER.dark)} src={PERSONAL_AGENTS_BANNER.dark.x1} alt={PERSONAL_AGENTS_BANNER_WORDS} width={600} height={150} />
        </div>
      )}
      <div className="ib-bi-text">
        <h2 id="ib-pa-title">{PERSONAL_AGENTS_COPY.title}</h2>
        <p id="ib-pa-desc">{PERSONAL_AGENTS_COPY.body}</p>
      </div>
      <div className="ib-bi-acts">
        <button type="button" className="ib-btn ib-ghost" onClick={openSettings} data-personal-agents-settings="">
          {PERSONAL_AGENTS_COPY.settings}
        </button>
        <span className="ib-bsp" />
        <button type="button" className="ib-btn ib-pri ib-bi-copy" onClick={close} data-personal-agents-done="">
          {PERSONAL_AGENTS_COPY.done}
        </button>
      </div>
    </Modal>
  );
}
