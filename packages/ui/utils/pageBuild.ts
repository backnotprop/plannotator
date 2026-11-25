/**
 * The release this page was built from (`__APP_VERSION__`, each app's vite.config.ts), or null where nothing defines
 * it (a test, a tool that bundles it bare).
 *
 * The one place the build's release is read: the bundler writes the release as a literal at each read, and the
 * Inbox's stale page check is proven by serving the page's one literal as an older release
 * (tests/e2e/inbox-stale-page-webkit.spec.ts). A second read in the same bundle (the failure box's Copy error) would
 * leave the page half old, half new.
 */
declare const __APP_VERSION__: string | undefined;

export function pageBuild(): string | null {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null;
}
