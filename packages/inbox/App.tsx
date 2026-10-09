/**
 * The Plannotator Inbox window (`plannotator inbox`): the design of record is
 * `.product/approved/plannotator-inbox-window-2026-10-07/`. A mail client for
 * what agents send: the list in the approved sections (a row is a thread),
 * the thread read as an email with Plannotator's question cards, pick then
 * Send, the project's decisions, and Settings.
 *
 * Routing is the URL hash (`#thread=msg_…`, `#project=prj_…`, `#settings`,
 * `#decisions=prj_…&decision=dec_…`), the same `#thread=` the MCP tools hand
 * agents.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { configurePlannotatorUI } from '@plannotator/ui/configure';
import { storage } from '@plannotator/ui/utils/storage';
import type { InboxDecision, InboxHealth, InboxListRow, InboxListSection, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import {
  InboxApiError,
  inboxApi,
  setPageSession,
  subscribeInboxEvents,
  type AgentToolHost,
  type DecisionsModel,
  type ListModel,
  type SettingsModel,
} from './api';
import { filterSections, heldNotice, refreshHeldRows, waitingCount } from './held';
import { tildePath } from './format';
import type { ConnectContext } from './harnesses';
import { Sidebar } from './components/Sidebar';
import { SidebarShell } from './shell/SidebarShell';
import { InboxList } from './components/InboxList';
import { ThreadPane } from './components/Thread';
import { EmptyState } from './components/EmptyState';
import { SettingsPage } from './components/Settings';
import { NotificationAsk } from './components/NotificationAsk';
import { useInboxNotifications } from './notify';
import { DecisionsPage } from './components/Decisions';
import { GuidePane } from './components/GuidePane';

// The Inbox has no /api/config and no browser-agent tools: settings stay in
// the page's own cookies, and WebMCP is off.
// No image uploads and no skill catalog either: a comment's image would need
// an upload route the Inbox does not have, so the composer says so instead of
// posting nowhere.
configurePlannotatorUI({
  serverSync: () => {},
  webmcp: { enabled: false, namePrefix: 'plannotator.' },
  // Skill references in comments read the host's skills; the Inbox has none to offer.
  skillCatalogTransport: async () => [],
  uploadTransport: {
    upload: async () => {
      throw new Error('Images cannot be added to a comment in the Inbox.');
    },
  },
});

const SIDEBAR_OPEN_COOKIE = 'plannotator-inbox-sidebar-open';

interface Route {
  page: 'inbox' | 'settings' | 'decisions';
  project: string | null;
  thread: string | null;
  /** The decision open beside the Decisions list. */
  decision?: string | null;
  /** An attachment open beside the thread: `file=att_…`, `v=sent` for the version the agent sent, `at=` an annotation to show. */
  file?: { id: string; version: 'current' | 'sent'; focus: string | null } | null;
  /** The message whose guided review is open over the window (`#thread=…&guide=msg_…`). */
  guide?: string | null;
}

function readRoute(): Route {
  const hash = window.location.hash.replace(/^#/, '');
  if (hash === 'settings') return { page: 'settings', project: null, thread: null };
  const params = new URLSearchParams(hash);
  if (params.has('decisions')) {
    return { page: 'decisions', project: params.get('decisions') || null, thread: null, decision: params.get('decision') };
  }
  const thread = params.get('thread');
  const fileId = thread ? params.get('file') : null;
  return {
    page: 'inbox',
    project: params.get('project'),
    thread,
    file: fileId ? { id: fileId, version: params.get('v') === 'sent' ? 'sent' : 'current', focus: params.get('at') } : null,
    guide: thread ? params.get('guide') : null,
  };
}

function writeRoute(route: Route): void {
  let hash = '';
  if (route.page === 'settings') hash = 'settings';
  else if (route.page === 'decisions') {
    const params = new URLSearchParams();
    params.set('decisions', route.project ?? '');
    if (route.decision) params.set('decision', route.decision);
    hash = params.toString();
  } else {
    const params = new URLSearchParams();
    if (route.project) params.set('project', route.project);
    if (route.thread) params.set('thread', route.thread);
    if (route.thread && route.file) {
      params.set('file', route.file.id);
      if (route.file.version === 'sent') params.set('v', 'sent');
      if (route.file.focus) params.set('at', route.file.focus);
    }
    if (route.thread && route.guide) params.set('guide', route.guide);
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
  // Open or closed as the person left it (⌘B or the toggle): a cookie of the Inbox's own, open when absent.
  const [sidebarOpen, setSidebarOpen] = useState(() => storage.getItem(SIDEBAR_OPEN_COOKIE) !== 'false');
  const changeSidebar = useCallback((next: boolean) => {
    setSidebarOpen(next);
    storage.setItem(SIDEBAR_OPEN_COOKIE, String(next));
  }, []);
  const [latest, setLatest] = useState<ListModel | null>(null);
  /** The list on screen: held until the person acts (the "N new" notice). */
  const [shown, setShown] = useState<InboxListSection[] | null>(null);
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [threadDecisions, setThreadDecisions] = useState<InboxDecision[]>([]);
  const [decisions, setDecisions] = useState<DecisionsModel | null>(null);
  const [decisionsError, setDecisionsError] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsModel | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [update, setUpdate] = useState<InboxHealth['update']>(null);
  const [restarting, setRestarting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const routeRef = useRef(route);
  routeRef.current = route;
  const notifications = useInboxNotifications({
    settings: settings?.notifications ?? null,
    onSettings: (next) => setSettings((current) => (current ? { ...current, notifications: next } : current)),
    // A click on a notification: the thread opens, and the list on screen catches up.
    openThread: (threadId) => {
      writeRoute({ page: 'inbox', project: null, thread: threadId });
      void refreshList(true);
    },
    // A click on a burst's notice: the list at rest, as it now is.
    openList: () => {
      writeRoute({ page: 'inbox', project: null, thread: null });
      void refreshList(true);
    },
  });
  const { observe: observeEvent, flush: flushNotifications } = notifications;

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
      // Held: the order waits for an action, but each row's own state (a delivery, an agent's read) follows at once.
      setShown((current) => (adopt || current === null || !hasRows(current) ? next.sections : refreshHeldRows(current, next.sections)));
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
      if (routeRef.current.thread === threadId) {
        setThread(next.thread);
        setThreadDecisions(next.decisions);
      }
      return next.thread;
    } catch (cause) {
      if (cause instanceof InboxApiError && cause.status === 404 && routeRef.current.thread === threadId) setThread(null);
      return null;
    }
  }, []);

  /** The Decisions page's project: the route's, else the one with the newest activity. */
  const decisionsProjectOf = useCallback((route: Route, model: ListModel | null): string | null => {
    if (route.project) return route.project;
    const rows = (model?.sections ?? []).flatMap((s) => s.threads).sort((a, b) => b.last_at.localeCompare(a.last_at));
    return rows[0]?.project.id ?? model?.projects[0]?.id ?? null;
  }, []);

  const refreshDecisions = useCallback(async (projectId: string | null) => {
    if (!projectId) return;
    try {
      const next = await inboxApi.decisions(projectId);
      setDecisions(next);
      setDecisionsError(null);
    } catch (cause) {
      setDecisionsError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  const latestRef = useRef(latest);
  latestRef.current = latest;

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
        onRecord: (event) => {
          observeEvent(event);
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            void refreshList(false).then((next) => next && flushNotifications(next));
            const open = routeRef.current.thread;
            if (open) void refreshThread(open);
            if (routeRef.current.page === 'decisions') void refreshDecisions(decisionsProjectOf(routeRef.current, latestRef.current));
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
  }, [refreshList, refreshSettings, refreshThread, observeEvent, flushNotifications, refreshDecisions, decisionsProjectOf]);

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

  const decisionsProject = route.page === 'decisions' ? decisionsProjectOf(route, latest) : null;
  useEffect(() => {
    if (decisionsProject) void refreshDecisions(decisionsProject);
  }, [decisionsProject, refreshDecisions]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // An open file owns Escape (the HTML viewer's ladder, the composers).
      if (event.key !== 'Escape' || !routeRef.current.thread || routeRef.current.file) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return;
      // An open guided review closes first, back to its thread.
      writeRoute(routeRef.current.guide ? { ...routeRef.current, guide: null } : { ...routeRef.current, thread: null });
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

  // Settings' Delete thread / Delete project: the store, its blobs and the size read again.
  const deleteThread = async (threadId: string) => {
    setSettingsError(null);
    try {
      await inboxApi.deleteThread(threadId);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The thread was not deleted.');
    }
    await Promise.all([refreshSettings(), refreshList(true)]);
  };
  const deleteProject = async (projectId: string) => {
    setSettingsError(null);
    try {
      await inboxApi.deleteProject(projectId);
    } catch (cause) {
      setSettingsError(cause instanceof Error ? cause.message : 'The project was not deleted.');
    }
    await Promise.all([refreshSettings(), refreshList(true)]);
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

  const retireDecision = async (decision: InboxDecision) => {
    await inboxApi.retireDecision(decision.id, decision.version);
    await refreshDecisions(decision.project_id);
  };

  const replaceDecision = async (decision: InboxDecision, text: string, reason: string) => {
    const result = await inboxApi.replaceDecision(decision.id, { version: decision.version, text, reason });
    await refreshDecisions(decision.project_id);
    go({ page: 'decisions', project: decision.project_id, thread: null, decision: result.decision.id });
  };

  const filterProject = route.page === 'inbox' && route.project ? projects.find((p) => p.id === route.project) ?? null : null;
  const notice = shown && latest ? heldNotice(filterSections(shown, route.project), filterSections(latest.sections, route.project)).text : null;
  const firstRun = latest !== null && projects.length === 0;
  // A file beside the thread takes the list's and the sidebar's room (record 2.2).
  const fileOpen = route.page === 'inbox' && !!route.thread && !!route.file;
  const guideMessage =
    route.guide && thread && thread.thread_id === route.thread ? (thread.messages.find((m) => m.id === route.guide && m.guide) ?? null) : null;

  let main: ReactNode;
  const decisionsFolder = decisionsProject ? projects.find((p) => p.id === decisionsProject) ?? null : null;
  if (route.page === 'settings') {
    main = (
      <SettingsPage
        settings={settings}
        context={context}
        error={settingsError}
        onToggleTool={toggleTool}
        permission={notifications.permission}
        onToggleNotifications={(next) => void notifications.setEnabled(next)}
        onDeleteThread={deleteThread}
        onDeleteProject={deleteProject}
      />
    );
  } else if (route.page === 'decisions' && decisionsFolder) {
    main = (
      <DecisionsPage
        projects={projects}
        project={decisionsFolder}
        model={decisions && decisions.project_id === decisionsFolder.id ? decisions : null}
        error={decisionsError}
        openId={route.decision ?? null}
        onProject={(projectId) => go({ page: 'decisions', project: projectId, thread: null })}
        onOpen={(decisionId) => go({ page: 'decisions', project: decisionsFolder.id, thread: null, decision: decisionId })}
        onOpenThread={(threadId) => go({ page: 'inbox', project: null, thread: threadId })}
        onRetire={retireDecision}
        onReplace={replaceDecision}
      />
    );
  } else if (route.page === 'decisions') {
    main = <div className="ib-listcol" />;
  } else if (!latest || !shown) {
    main = <div className="ib-listcol">{loadError && <div className="ib-error" style={{ padding: 22 }}>{loadError}</div>}</div>;
  } else if (firstRun) {
    main = <EmptyState context={context} />;
  } else {
    main = (
      <>
        {!fileOpen && (
        <InboxList
          title={filterProject?.name ?? 'Inbox'}
          path={filterProject ? tildePath(filterProject.root, settings?.home) : null}
          sections={filterSections(shown, route.project)}
          filtered={filterProject !== null}
          narrow={route.thread !== null}
          selectedThreadId={route.thread}
          notice={notice}
          ask={notifications.ask && <NotificationAsk kind={notifications.ask} onTurnOn={() => void notifications.turnOn()} onNotNow={notifications.notNow} />}
          onShowNew={() => setShown(latest.sections)}
          onOpen={openRow}
        />
        )}
        {route.thread && thread && thread.thread_id === route.thread && (
          <ThreadPane
            thread={thread}
            sent={latestSections.flatMap((section) => section.threads).find((row) => row.thread_id === thread.thread_id)?.sent ?? null}
            onQuestions={patchQuestions}
            onChanged={afterWrite}
            onClose={() => go({ ...route, thread: null, file: null })}
            decisions={threadDecisions}
            onOpenDecisionPage={(decision) => go({ page: 'decisions', project: decision.project_id, thread: null, decision: decision.id })}
            file={route.file ?? null}
            onOpenFile={(file) => writeRoute({ ...routeRef.current, file })}
            onOpenGuide={(messageId) => go({ ...route, guide: messageId })}
          />
        )}
      </>
    );
  }

  return (
    <div className="pn-inbox">
      {/* A file beside the thread takes the sidebar's room (record 2.2): it closes on the same spring, and the person's choice stays as it was. */}
      <SidebarShell
        className="ib-shell"
        open={sidebarOpen && !fileOpen}
        onOpenChange={changeSidebar}
        navigation={
          <Sidebar
            page={route.page}
            projectId={route.project}
            inboxCount={waitingCount(latestSections)}
            decisionsCount={latest?.decisions_waiting ?? 0}
            projects={projects}
            projectCounts={projectCounts}
            updateReady={update !== null}
            restarting={restarting}
            onInbox={() => go({ page: 'inbox', project: null, thread: null })}
            onProject={(projectId) => go({ page: 'inbox', project: projectId, thread: null })}
            onSettings={() => go({ page: 'settings', project: null, thread: null })}
            onDecisions={() => go({ page: 'decisions', project: null, thread: null })}
            onRestart={() => void restart()}
          />
        }
      >
        <main className="ib-main">{main}</main>
      </SidebarShell>
      {guideMessage && thread && (
        <GuidePane
          thread={thread}
          message={guideMessage}
          onBack={() => go({ ...route, guide: null })}
          onClose={() => go({ ...route, thread: null, guide: null })}
        />
      )}
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
