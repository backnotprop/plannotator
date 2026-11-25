import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { reloadSkillCatalog } from '@plannotator/ui/utils/skillCatalog';
import { inboxApi, post, type AgentToolHost, type InboxStorageModel, type SettingsModel } from '../../api';
import { inboxUrl } from '../../inboxUrl';
import { scheduledApi } from '../../scheduled/client';
import { noteDeletedHere } from '../deletedHere';

export interface SettingsHost {
  setSettings: Dispatch<SetStateAction<SettingsModel | null>>;
  setError: (error: string | null) => void;
  refresh: () => Promise<unknown>;
}

export function settingsSaver(host: SettingsHost) {
  return async <A>(change: (current: SettingsModel) => SettingsModel, save: () => Promise<A>, adopt: (current: SettingsModel, saved: A) => SettingsModel, landed?: () => void): Promise<void> => {
    host.setError(null);
    host.setSettings((current) => (current ? change(current) : current));
    try {
      const saved = await save();
      landed?.();
      host.setSettings((current) => (current ? adopt(current, saved) : current));
    } catch (cause) {
      host.setError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void host.refresh();
    }
  };
}

export function useSettingsSaves(
  app: SettingsHost & { adoptStore: (store: InboxStorageModel) => void; readStore: () => void; refreshList: (adopt: boolean) => Promise<unknown> },
) {
  const saveSetting = settingsSaver(app);
  const { setSettings, setError: setSettingsError, refresh: refreshSettings, adoptStore, readStore, refreshList } = app;
  adoptSplitView = (on) => setSettings((s) => (s ? ({ ...s, split_view: { on } } as SettingsModel) : s));
  const toggleTool = (host: AgentToolHost, next: boolean) =>
    saveSetting(
      (s) => ({ ...s, inbox_tool: { ...s.inbox_tool, hosts: { ...s.inbox_tool.hosts, [host]: next } } }),
      () => inboxApi.saveInboxTool({ [host]: next }),
      (s, saved) => ({ ...s, inbox_tool: saved.inbox_tool }),
    );

  const toggleCookieHost = (next: boolean) =>
    saveSetting(
      (s) => (s.cookie_host ? { ...s, cookie_host: { ...s.cookie_host, on: next } } : s),
      () => inboxApi.saveCookieHost(next),
      (s, saved) => ({ ...s, cookie_host: saved.cookie_host }),
    );

  const toggleBoard = (next: boolean) => saveSetting((s) => ({ ...s, board: { on: next } }), () => inboxApi.saveBoard(next), (s, saved) => ({ ...s, board: saved.board }));

  const toggleBro = (next: boolean) => saveSetting((s) => ({ ...s, bro: { on: next } }), () => inboxApi.saveBro(next), (s, saved) => ({ ...s, bro: saved.bro }));

  const toggleFloatDrafts = (next: boolean) =>
    saveSetting((s) => ({ ...s, float_drafts: { on: next } }), () => inboxApi.saveFloatDrafts(next), (s, saved) => ({ ...s, float_drafts: saved.float_drafts }));

  const toggleMarkReadWarning = (next: boolean) =>
    saveSetting((s) => ({ ...s, mark_read_warning: { on: next } }), () => inboxApi.saveMarkReadWarning(next), (s, saved) => ({ ...s, mark_read_warning: saved.mark_read_warning }));

  const toggleSteps = (next: boolean) => saveSetting((s) => ({ ...s, steps: { on: next } }), () => inboxApi.saveSteps(next), (s, saved) => ({ ...s, steps: saved.steps }));

  const toggleCodeReview = (next: boolean) =>
    saveSetting((s) => ({ ...s, code_review: { on: next } }), () => inboxApi.saveCodeReview(next), (s, saved) => ({ ...s, code_review: saved.code_review }), reloadSkillCatalog);

  const toggleSystem = (next: boolean) => saveSetting((s) => ({ ...s, system: { on: next } }), () => inboxApi.saveSystem(next), (s, saved) => ({ ...s, system: saved.system ?? { on: next } }));

  const toggleChapterDiagrams = (next: boolean) =>
    saveSetting((s) => ({ ...s, chapter_diagrams: { on: next } }), () => inboxApi.saveChapterDiagrams(next), (s, saved) => ({ ...s, chapter_diagrams: saved.chapter_diagrams ?? { on: next } }));


  const toggleScheduled = (next: boolean) =>
    saveSetting((s) => ({ ...s, scheduled_threads: { ...s.scheduled_threads, on: next } }), () => scheduledApi.saveSwitch(next), (s, saved) => ({ ...s, scheduled_threads: saved.scheduled_threads ?? { on: next } }), reloadSkillCatalog);

  /** Decision mode (Settings → Capabilities): on unless turned off; every window follows through `event: capabilities`. */
  const toggleDecisionMode = (next: boolean) =>
    saveSetting((s) => ({ ...s, decision_mode: { ...s.decision_mode, on: next } }), () => inboxApi.saveDecisionMode(next), (s, saved) => ({ ...s, decision_mode: { ...s.decision_mode, ...saved.decision_mode } }));

  /** The one experimental switch with a row: Grid (approval "inbox-agent-grid"). */
  const toggleExperimental = (next: boolean, _feature: 'grid' = 'grid') =>
    saveSetting(
      (s) => ({ ...s, experimental: { ...s.experimental, grid: { on: next, env: s.experimental?.grid?.env ?? null } } }),
      () => inboxApi.saveExperimental({ grid: next }),
      (s, saved) => ({ ...s, experimental: saved.experimental }),
    );

  const [tailscaleBusy, setTailscaleBusy] = useState(false);
  const toggleTailscale = async (next: boolean, replaceExposed = false) => {
    setSettingsError(null);
    setTailscaleBusy(true);
    try {
      const saved = await inboxApi.saveTailscale(next, replaceExposed);
      setSettings((current) => (current ? { ...current, tailscale: saved.tailscale } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    } finally {
      setTailscaleBusy(false);
    }
  };

  const deleteThread = async (threadId: string) => {
    setSettingsError(null);
    try {
      // A pane still holding it (off the page) lets it go on its next read, as before (data/deletedHere.ts).
      noteDeletedHere({ thread: threadId });
      adoptStore((await inboxApi.deleteThread(threadId)).store);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The thread was not deleted.');
      readStore();
    }
    await refreshList(true);
  };
  const deleteProject = async (projectId: string) => {
    setSettingsError(null);
    try {
      noteDeletedHere({ project: projectId });
      adoptStore((await inboxApi.deleteProject(projectId)).store);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The project was not deleted.');
      readStore();
    }
    await refreshList(true);
  };
  return { toggleTool, toggleCookieHost, toggleBoard, toggleBro, toggleFloatDrafts, toggleMarkReadWarning, toggleSteps, toggleCodeReview, toggleSystem, toggleChapterDiagrams, toggleScheduled, toggleDecisionMode, toggleExperimental, tailscaleBusy, toggleTailscale, deleteThread, deleteProject };
}

/** App's settings take a saved thread panes switch through this (set where App runs `useSettingsSaves`). */
let adoptSplitView: ((on: boolean) => void) | null = null;

/**
 * Settings → General → Appearance → thread panes (config.json `inboxSplitView`, off by default). The save's own answer
 * goes into the window's settings, so the switch and the panes agree even with the event stream down; every other
 * window takes it from `event: capabilities`, which the save sends to all of them (capabilities.ts). Until the answer
 * lands the switch shows the person's choice. A save that fails puts the switch back and says so.
 */
export function useSplitViewSwitch(saved: boolean): { on: boolean; failed: boolean; toggle: () => void } {
  const [asked, setAsked] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => setAsked(null), [saved]);
  const on = asked ?? saved;
  const toggle = () => {
    const next = !on;
    setAsked(next);
    setFailed(false);
    post<{ split_view: { on: boolean } }>(inboxUrl('/settings'), { split_view: { on: next } }).then(
      (saved) => adoptSplitView?.(saved.split_view.on),
      () => {
        setAsked(null);
        setFailed(true);
      },
    );
  };
  return { on, failed, toggle };
}
