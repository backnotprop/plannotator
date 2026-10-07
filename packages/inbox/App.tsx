/**
 * The Plannotator Inbox window (`plannotator inbox`): the design of record is
 * `.product/approved/plannotator-inbox-window-2026-10-07/`. A mail client for
 * what agents send: the list in the approved sections (a row is a thread),
 * the thread read as an email with Plannotator's question cards, pick then
 * Send, and Settings.
 *
 * Routing is the URL hash (`#thread=msg_…`, `#project=prj_…`, `#settings`),
 * the same `#thread=` the MCP tools hand agents.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { configurePlannotatorUI } from '@plannotator/ui/configure';
import type { InboxHealth, InboxListRow, InboxListSection, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import { InboxApiError, inboxApi, setPageSession, subscribeInboxEvents, type AgentToolHost, type ListModel, type SettingsModel } from './api';
import { filterSections, heldNotice, waitingCount } from './held';
import { tildePath } from './format';
import type { ConnectContext } from './harnesses';
import { Sidebar } from './components/Sidebar';
import { InboxList } from './components/InboxList';
import { ThreadPane } from './components/Thread';
import { EmptyState } from './components/EmptyState';
import { SettingsPage } from './components/Settings';

// The Inbox has no /api/config and no browser-agent tools: settings stay in
// the page's own cookies, and WebMCP is off.
configurePlannotatorUI({ serverSync: () => {}, webmcp: { enabled: false, namePrefix: 'plannotator.' } });

interface Route {
  page: 'inbox' | 'settings';
  project: string | null;
  thread: string | null;
}

function readRoute(): Route {
  const hash = window.location.hash.replace(/^#/, '');
  if (hash === 'settings') return { page: 'settings', project: null, thread: null };
  const params = new URLSearchParams(hash);
  return { page: 'inbox', project: params.get('project'), thread: params.get('thread') };
}

function writeRoute(route: Route): void {
  let hash = '';
  if (route.page === 'settings') hash = 'settings';
  else {
    const params = new URLSearchParams();
    if (route.project) params.set('project', route.project);
    if (route.thread) params.set('thread', route.thread);
    hash = params.toString();
  }
  const next = hash ? `#${hash}` : window.location.pathname + window.location.search;
  if (`#${hash}` !== window.location.hash) window.history.pushState(null, '', next);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function platformOf(): ConnectContext['platform'] {
  const p = `${navigator.platform} ${navigator.userAgent}`.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'mac';
  return 'linux';
}

function hasRows(sections: readonly InboxListSection[] | null): boolean {
  return !!sections && sections.some((s) => s.threads.length > 0);
}

function Inbox() {
  const [route, setRoute] = useState<Route>(readRoute);
  const [latest, setLatest] = useState<ListModel | null>(null);
  /** The list on screen: held until the person acts (the "N new" notice). */
  const [shown, setShown] = useState<InboxListSection[] | null>(null);
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [settings, setSettings] = useState<SettingsModel | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [update, setUpdate] = useState<InboxHealth['update']>(null);
  const [restarting, setRestarting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const routeRef = useRef(route);
  routeRef.current = route;

  useEffect(() => {
    const onHash = () => setRoute(readRoute());
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => {
      window.removeEventListener('hashchange', onHash);
      window.removeEventListener('popstate', onHash);
    };
  }, []);

  /** Read the list; `adopt` puts it on screen (an action, Show, or nothing on screen yet). */
  const refreshList = useCallback(async (adopt: boolean) => {
    try {
      const next = await inboxApi.list();
      setPageSession(next.serverSession);
      setLatest(next);
      setUpdate(next.update);
      setShown((current) => (adopt || current === null || !hasRows(current) ? next.sections : current));
      setLoadError(null);
      return next;
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, []);

  const refreshThread = useCallback(async (threadId: string) => {
    try {
      const next = await inboxApi.thread(threadId);
      if (routeRef.current.thread === threadId) setThread(next.thread);
      return next.thread;
    } catch (cause) {
      if (cause instanceof InboxApiError && cause.status === 404 && routeRef.current.thread === threadId) setThread(null);
      return null;
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      setSettings(await inboxApi.settings());
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  // First read, then the event stream keeps the counts, the open thread and the notice live.
  useEffect(() => {
    let unsubscribe = () => {};
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    void (async () => {
      const first = await refreshList(true);
      void refreshSettings();
      if (cancelled || !first) return;
      unsubscribe = subscribeInboxEvents(first.cursor, {
        onRecord: () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            void refreshList(false);
            const open = routeRef.current.thread;
            if (open) void refreshThread(open);
          }, 80);
        },
        onStatus: (next) => setUpdate(next),
      });
    })();
    return () => {
      cancelled = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [refreshList, refreshSettings, refreshThread]);

  // Opening a thread: read it, record the look, and put the list as it now is on screen.
  useEffect(() => {
    const threadId = route.thread;
    if (!threadId) {
      setThread(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const opened = await refreshThread(threadId);
      if (cancelled || !opened) return;
      await inboxApi.seen(threadId).catch(() => {});
      if (!cancelled) await refreshList(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [route.thread, refreshThread, refreshList]);

  useEffect(() => {
    if (route.page === 'settings') void refreshSettings();
  }, [route.page, refreshSettings]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !routeRef.current.thread) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
      writeRoute({ ...routeRef.current, thread: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (next: Route) => {
    writeRoute(next);
    // Changing the view is an action: the list on screen catches up.
    if (latest) setShown(latest.sections);
  };

  const openRow = (row: InboxListRow) => go({ page: 'inbox', project: route.project, thread: row.thread_id });

  const patchQuestions = (messageId: string, questions: InboxQuestion[]) => {
    setThread((current) =>
      current
        ? { ...current, messages: current.messages.map((m) => (m.id === messageId ? { ...m, questions } : m)) }
        : current,
    );
    void refreshList(true);
  };

  const afterWrite = async () => {
    if (route.thread) await refreshThread(route.thread);
    await refreshList(true);
  };

  const restart = async () => {
    setRestarting(true);
    const before = latest?.serverSession;
    try {
      await inboxApi.restart();
    } catch {
      setRestarting(false);
      return;
    }
    // The new Inbox comes up on the same port: reload once it answers.
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const health = await inboxApi.health();
        if (health.serverSession !== before) {
          window.location.reload();
          return;
        }
      } catch {
        // Not up yet.
      }
    }
    setRestarting(false);
  };

  const toggleTool = async (host: AgentToolHost, next: boolean) => {
    setSettingsError(null);
    setSettings((current) =>
      current ? { ...current, inbox_tool: { ...current.inbox_tool, hosts: { ...current.inbox_tool.hosts, [host]: next } } } : current,
    );
    try {
      const saved = await inboxApi.saveInboxTool({ [host]: next });
      setSettings((current) => (current ? { ...current, inbox_tool: saved.inbox_tool } : current));
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The setting was not saved.');
      void refreshSettings();
    }
  };

  const projects = latest?.projects ?? [];
  const latestSections = latest?.sections ?? [];
  const projectCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const project of projects) counts.set(project.id, waitingCount(latestSections, project.id));
    return counts;
  }, [projects, latestSections]);

  const context: ConnectContext | null = settings
    ? { command: settings.mcp_command, mcpUrl: settings.mcp_url, platform: platformOf() }
    : null;

  const filterProject = route.project ? projects.find((p) => p.id === route.project) ?? null : null;
  const notice = shown && latest ? heldNotice(filterSections(shown, route.project), filterSections(latest.sections, route.project)).text : null;
  const firstRun = latest !== null && projects.length === 0;

  let main: ReactNode;
  if (route.page === 'settings') {
    main = <SettingsPage settings={settings} context={context} error={settingsError} onToggleTool={toggleTool} />;
  } else if (!latest || !shown) {
    main = <div className="ib-listcol">{loadError && <div className="ib-error" style={{ padding: 22 }}>{loadError}</div>}</div>;
  } else if (firstRun) {
    main = <EmptyState context={context} />;
  } else {
    main = (
      <>
        <InboxList
          title={filterProject?.name ?? 'Inbox'}
          path={filterProject ? tildePath(filterProject.root, settings?.home) : null}
          sections={filterSections(shown, route.project)}
          filtered={filterProject !== null}
          narrow={route.thread !== null}
          selectedThreadId={route.thread}
          notice={notice}
          onShowNew={() => setShown(latest.sections)}
          onOpen={openRow}
        />
        {route.thread && thread && thread.thread_id === route.thread && (
          <ThreadPane
            thread={thread}
            sent={latestSections.flatMap((section) => section.threads).find((row) => row.thread_id === thread.thread_id)?.sent ?? null}
            onQuestions={patchQuestions}
            onChanged={afterWrite}
            onClose={() => go({ ...route, thread: null })}
          />
        )}
      </>
    );
  }

  return (
    <div className="pn-inbox">
      <div className="ib-shell">
        <Sidebar
          page={route.page}
          projectId={route.project}
          inboxCount={waitingCount(latestSections)}
          projects={projects}
          projectCounts={projectCounts}
          updateReady={update !== null}
          restarting={restarting}
          onInbox={() => go({ page: 'inbox', project: null, thread: null })}
          onProject={(projectId) => go({ page: 'inbox', project: projectId, thread: null })}
          onSettings={() => go({ page: 'settings', project: null, thread: null })}
          onRestart={() => void restart()}
        />
        <main className="ib-main">{main}</main>
      </div>
    </div>
  );
}

export function InboxApp() {
  return (
    <ThemeProvider defaultTheme="system">
      <Inbox />
    </ThemeProvider>
  );
}
