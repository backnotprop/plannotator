import { useState, type Dispatch, type SetStateAction } from 'react';
import { reloadSkillCatalog } from '@plannotator/ui/utils/skillCatalog';
import { inboxApi, type AgentToolHost, type InboxStorageModel, type SettingsModel } from '../../api';

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

  const toggleShape = (next: boolean) => saveSetting((s) => ({ ...s, shape: { on: next } }), () => inboxApi.saveShape(next), (s, saved) => ({ ...s, shape: saved.shape }), reloadSkillCatalog);

  const toggleExperimental = (next: boolean) =>
    saveSetting(
      (s) => ({ ...s, experimental: { decision_mode: { on: next, env: s.experimental?.decision_mode.env ?? null } } }),
      () => inboxApi.saveExperimental({ decision_mode: next }),
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
      adoptStore((await inboxApi.deleteProject(projectId)).store);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The project was not deleted.');
      readStore();
    }
    await refreshList(true);
  };
  return { toggleTool, toggleCookieHost, toggleBoard, toggleBro, toggleFloatDrafts, toggleMarkReadWarning, toggleSteps, toggleCodeReview, toggleSystem, toggleChapterDiagrams, toggleShape, toggleExperimental, tailscaleBusy, toggleTailscale, deleteThread, deleteProject };
}
