/**
 * guides.show viewer entry — mounts a portable Guided Review from the snapshot
 * embedded in the exported HTML (`#plannotator-guided-review`), or, on a hosted
 * encrypted page (`<meta name="plannotator-guided-review-payload">`), from the
 * ciphertext it fetches and opens with the key in the URL fragment.
 *
 * Boot order is load-bearing:
 *   1. install a settings backend BEFORE anything reads a setting (configStore
 *      seeds defaults on first read). localStorage when the browser allows it,
 *      so the reader's light/dark choice survives a reload; memory otherwise.
 *      Never cookies: on `file://` they either fail or leak into the reader's
 *      other pages,
 *   2. read + parse the snapshot (embedded first; else the encrypted hosted
 *      path — see ./hosted.tsx),
 *   3. try to prepare a worker (fetch → blob); fall back to main thread,
 *   4. render the same guide chain the review app renders. Hosted pages
 *      (either mode) add a client-side "Download portable guide" control.
 *
 * Decision record: adr/decisions/007-portable-guided-reviews-20260815.md.
 * Hosting contract: adr/implementation/guide-share-hosting.md (section 6).
 */
import '@plannotator/review-editor/styles';
import './portable.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
// setStorageBackend directly (not configurePlannotatorUI): the configure barrel
// statically imports every host seam and their UI, which drags markdown/math
// renderers into a bundle that never uses them.
import { setStorageBackend } from '@plannotator/ui/utils/storage';
import { ThemeProvider } from '@plannotator/ui/components/ThemeProvider';
import { ModeToggle } from '@plannotator/ui/components/ModeToggle';
import { TooltipProvider } from '@plannotator/ui/components/Tooltip';
import { readEmbeddedGuideSnapshot, type GuideSnapshot } from '@plannotator/core/guide-format';
import { GuideSectionSkeleton, GuideViewer } from '@plannotator/guide-viewer';
import { ReadOnlyDiffRenderer, getReadOnlyDiffRendererProps } from './ReadOnlyDiffRenderer';
import { PortableWorkerPool, preparePortableWorkerFactory } from './portablePool';
import { HostedDownloadButton, loadHostedEncryptedSnapshot, readHostedPage } from './hosted';

// 1. Settings: localStorage if usable (private mode / disabled storage throw
//    on access), else memory for the life of the page. Keys are namespaced so
//    a hosted guides.show page never collides with anything else on the origin.
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

/**
 * "Made with Plannotator" → plannotator.ai. Portable pages send no referrer
 * (`<meta name="referrer" content="no-referrer">`), so the `ref` query is the
 * only attribution the destination gets. Plain text, muted, no icon: it must
 * read as a credit, not a call to action, next to the guide's own controls.
 */
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
  // Only a hosted page offers the download: a downloaded file IS the export.
  // The attribution link is on every guides.show-rendered page (portable and
  // hosted); the in-app review UI composes its own header and never sees this.
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

  // 2. Snapshot. Embedded when present (downloaded file, or a hosted plain
  //    page); otherwise the hosted encrypted path fetches it. In dev (no
  //    exported document) fall back to a fixture so the viewer can be
  //    iterated on with `vite`.
  let parsed = readEmbeddedGuideSnapshot(document);
  const encrypted = !parsed && page.payloadUrl !== null;
  if (!parsed && !encrypted && import.meta.env.DEV) {
    const { FIXTURE_V1_PR } = await import('@plannotator/core/guide-format-fixtures');
    parsed = { ok: true, value: FIXTURE_V1_PR };
  }

  // The exported document paints a plain fallback ground until we mount; from
  // here on the theme owns the body background.
  document.body.classList.remove('pgr-fallback-body');
  const root = createRoot(rootEl);
  const shell = (children: React.ReactNode, palette: string | undefined) => (
    <React.StrictMode>
      {/* `system` follows the OS live (ThemeProvider watches prefers-color-scheme);
          a stored choice from the header toggle wins over it (readThemePairCookies
          via the storage backend above). Keyed on the palette: the encrypted path
          learns the guide's palette only after the fetch, and the provider reads
          its default once. */}
      <ThemeProvider key={palette ?? ''} defaultTheme="system" defaultColorTheme={palette ?? 'plannotator'}>
        <TooltipProvider delayDuration={200} skipDelayDuration={100}>{children}</TooltipProvider>
      </ThemeProvider>
    </React.StrictMode>
  );
  const skeleton = (palette: string | undefined) =>
    root.render(shell(<div className="min-h-screen bg-background text-foreground"><GuideSectionSkeleton /></div>, palette));

  if (encrypted && page.payloadUrl) {
    // Hosted encrypted page: the host stamped WHERE the ciphertext is; the key
    // is ours alone (URL fragment, never sent). Skeleton while it travels.
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

  // 3. Worker (best effort). Preparing it means fetching the worker script and
  //    probing how this browser lets us construct one, so show the guide's
  //    own loading state meanwhile instead of the plain-text fallback.
  skeleton(palette);
  const workerFactory = await preparePortableWorkerFactory();
  // 4. Render. Observable for smoke tests and support: which highlighting path
  //    this page took, and whether it is a hosted page.
  document.documentElement.dataset.pgrHighlighter = workerFactory ? 'worker' : 'main-thread';
  if (hosted) document.documentElement.dataset.pgrHosted = encrypted ? 'encrypted' : 'plain';
  root.render(shell(<App snapshot={parsed.value} workerFactory={workerFactory} hosted={hosted} />, palette));
}

void boot();
