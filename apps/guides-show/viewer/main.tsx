import './review-styles.css';
import './portable.css';
import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { setStorageBackend } from '@plannotator/ui/utils/storage';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { ModeToggle } from '@plannotator/ui/components/ModeToggle';
import { TooltipProvider } from '@plannotator/ui/components/Tooltip';
import { readEmbeddedGuideSnapshot, type GuideSnapshot } from '@plannotator/core/guide-format';
import type { GuideOverviewDiagram } from '@plannotator/core/guide';
import { GuideSectionSkeleton, GuideViewer } from '@plannotator/guide-viewer';
import { ReadOnlyDiffRenderer, getReadOnlyDiffRendererProps } from './ReadOnlyDiffRenderer';
import { PortableWorkerPool, preparePortableWorkerFactory } from './portablePool';
import { HostedDownloadButton, loadHostedEncryptedSnapshot, readHostedPage } from './hosted';

const memory = new Map<string, string>();
const PREFIX = 'pgr:';
const local = (() => {
  try {
    const probe = `${PREFIX}probe`;
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch {
    return null;
  }
})();
setStorageBackend({
  getItem: (key) => (local ? local.getItem(PREFIX + key) : memory.get(key) ?? null),
  setItem: (key, value) => { if (local) local.setItem(PREFIX + key, value); else memory.set(key, value); },
  removeItem: (key) => { if (local) local.removeItem(PREFIX + key); else memory.delete(key); },
});

const OverviewDiagram = lazy(() => import('./OverviewDiagram'));
function renderOverviewDiagram(diagram: GuideOverviewDiagram): React.ReactNode | null {
  if (diagram.kind !== 'mermaid') return null;
  return (
    <Suspense fallback={<pre className="overflow-x-auto whitespace-pre rounded-md bg-muted/50 p-3 font-mono text-[11px] text-muted-foreground"><code>{diagram.source}</code></pre>}>
      <OverviewDiagram source={diagram.source} />
    </Suspense>
  );
}
function renderChapterDiagram(diagram: GuideOverviewDiagram, index: number): React.ReactNode | null {
  if (diagram.kind !== 'mermaid') return null;
  return (
    <Suspense fallback={<pre className="overflow-x-auto whitespace-pre rounded-md bg-muted/50 p-3 font-mono text-[11px] text-muted-foreground"><code>{diagram.source}</code></pre>}>
      <OverviewDiagram source={diagram.source} id={`guide-chapter-${index + 1}-diagram`} />
    </Suspense>
  );
}

function SourceLine({ snapshot }: { snapshot: GuideSnapshot }) {
  const s = snapshot.source;
  const parts: React.ReactNode[] = [];
  if (s.kind === 'pr' && s.pr) {
    parts.push(
      <a key="pr" href={s.pr.url} target="_blank" rel="noopener noreferrer" className="underline-offset-2 hover:text-foreground hover:underline">
        {s.pr.number !== undefined ? `PR #${s.pr.number}` : 'Pull request'}
        {s.pr.title ? ` — ${s.pr.title}` : ''}
      </a>,
    );
  } else if (s.kind === 'commit') {
    parts.push(<span key="c">commit {s.commitSha ? s.commitSha.slice(0, 12) : ''}</span>);
  } else if (s.kind === 'workspace') {
    parts.push(<span key="w">multi-repository workspace</span>);
  } else {
    parts.push(<span key="l">local changes</span>);
  }
  if (s.repo) parts.push(<span key="repo"> · {s.repo}</span>);
  if (s.branch) parts.push(<span key="branch"> · {s.branch}</span>);
  parts.push(<span key="ref"> · {snapshot.review.gitRef}</span>);
  return <>{parts}</>;
}

function ErrorCard({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mx-auto mt-16 max-w-[60ch] rounded-lg border border-border bg-card px-6 py-5">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1.5 font-mono text-[11px] text-muted-foreground">{detail}</p>
    </div>
  );
}

function BrandLink() {
  return (
    <a
      href="https://plannotator.ai/?ref=guide"
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center rounded-md px-1.5 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:text-foreground pointer-coarse:px-2.5 pointer-coarse:py-2.5"
      title="Guided Reviews are made with Plannotator"
      data-testid="guide-brand-link"
    >
      Made with Plannotator
    </a>
  );
}

function App({ snapshot, workerFactory, hosted }: { snapshot: GuideSnapshot; workerFactory: (() => Worker) | null; hosted: boolean }) {
  const headerActions = (
    <>
      <BrandLink />
      {hosted && <HostedDownloadButton snapshot={snapshot} scriptUrl={import.meta.url} />}
      <ModeToggle />
    </>
  );
  const view = (
    <GuideViewer
      snapshot={snapshot}
      DiffRenderer={ReadOnlyDiffRenderer}
      getDiffRendererProps={getReadOnlyDiffRendererProps}
      sourceLine={<SourceLine snapshot={snapshot} />}
      headerActions={headerActions}
      renderOverviewDiagram={renderOverviewDiagram}
      renderChapterDiagram={renderChapterDiagram}
      className="min-h-screen bg-background text-foreground"
    />
  );
  return workerFactory ? <PortableWorkerPool workerFactory={workerFactory}>{view}</PortableWorkerPool> : view;
}

async function boot() {
  const rootEl = document.getElementById('root');
  if (!rootEl) throw new Error('portable guide: #root missing');

  const page = readHostedPage(document);
  const hosted = page.hostedUrl !== null;

  let parsed = readEmbeddedGuideSnapshot(document);
  const encrypted = !parsed && page.payloadUrl !== null;
  if (!parsed && !encrypted && import.meta.env.DEV) {
    const { FIXTURE_V1_PR } = await import('@plannotator/core/guide-format-fixtures');
    parsed = { ok: true, value: FIXTURE_V1_PR };
  }

  document.body.classList.remove('pgr-fallback-body');
  const root = createRoot(rootEl);
  const shell = (children: React.ReactNode, palette: string | undefined) => (
    <React.StrictMode>
      <ThemeProvider key={palette ?? ''} defaultTheme="system" defaultColorTheme={palette ?? 'plannotator'}>
        <TooltipProvider>{children}</TooltipProvider>
      </ThemeProvider>
    </React.StrictMode>
  );
  const skeleton = (palette: string | undefined) =>
    root.render(shell(<div className="min-h-screen bg-background text-foreground"><GuideSectionSkeleton /></div>, palette));

  if (encrypted && page.payloadUrl) {
    skeleton(undefined);
    const loaded = await loadHostedEncryptedSnapshot(page.payloadUrl, location.hash);
    switch (loaded.kind) {
      case 'missing-key':
        root.render(shell(<ErrorCard title="This link is missing its key" detail="The key is the part of the link after #. Ask for the full link, including the fragment." />, undefined));
        return;
      case 'unavailable':
        root.render(shell(<ErrorCard title="This guide is no longer available" detail={`It may have been removed or expired. (${loaded.detail})`} />, undefined));
        return;
      case 'wrong-key':
        root.render(shell(<ErrorCard title="The key in this link does not open this guide" detail="The part after # is wrong or incomplete. Ask for the link again." />, undefined));
        return;
      case 'invalid':
        root.render(shell(<ErrorCard title="This guide could not be opened" detail={`${loaded.path}: ${loaded.message}`} />, undefined));
        return;
      case 'ok':
        parsed = { ok: true, value: loaded.snapshot };
        break;
    }
  }

  if (!parsed) {
    root.render(shell(<ErrorCard title="No guide found in this document" detail={`Expected a <script id="plannotator-guided-review" type="application/json"> element.`} />, undefined));
    return;
  }
  if (parsed.ok === false) {
    root.render(shell(<ErrorCard title="This guide could not be opened" detail={`${parsed.error.path}: ${parsed.error.message}`} />, undefined));
    return;
  }
  const palette = parsed.value.theme?.palette;

  skeleton(palette);
  const workerFactory = await preparePortableWorkerFactory();
  document.documentElement.dataset.pgrHighlighter = workerFactory ? 'worker' : 'main-thread';
  if (hosted) document.documentElement.dataset.pgrHosted = encrypted ? 'encrypted' : 'plain';
  root.render(shell(<App snapshot={parsed.value} workerFactory={workerFactory} hosted={hosted} />, palette));
}

void boot();
