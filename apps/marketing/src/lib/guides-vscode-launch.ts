// Guided Reviews for VS Code (the Guides view of the VS Code extension) is
// hidden until it ships. While this is false the deployed site has none of it:
// /vscode/ is not generated, the screens and the OG image (guides-vscode-assets/)
// are not copied into dist, and the Footer carries no link.
// Flip at launch, once the extension release with the Guides view is on the
// Marketplace and Open VSX.
// For review before launch, build it locally with the switch on:
//   GUIDES_VSCODE_LAUNCHED=true bun run --cwd apps/marketing build
//   bun run --cwd apps/marketing preview   (then open /vscode/)
// or run it in dev with the switch on (the screens are served there too):
//   GUIDES_VSCODE_LAUNCHED=true bunx astro dev   (from apps/marketing)
// The film is optional: the page shows it only when public/assets/guides-vscode.mp4
// exists at build time (poster: public/assets/guides-vscode-poster.png).
export const GUIDES_VSCODE_LAUNCHED = false || process.env.GUIDES_VSCODE_LAUNCHED === 'true';

export const GUIDES_VSCODE_ROUTE = 'vscode';
