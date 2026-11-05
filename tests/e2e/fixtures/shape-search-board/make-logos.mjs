// Four search engine marks as PNGs for the test board. Google's G is its published path; the other three are
// drawn by hand after the real marks (no file was downloaded).
import { createRequire } from 'node:module';
const [repo, out] = process.argv.slice(2);
const { chromium } = createRequire(`${repo}/package.json`)('@playwright/test');
const marks = {
  google: `<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`,
  ddg: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="11.5" fill="#DE5833"/><circle cx="12" cy="12" r="9.2" fill="#fff"/><circle cx="12" cy="12" r="8.4" fill="#DE5833"/><path fill="#fff" d="M10.2 5.2c-2.3.4-3.6 2.6-3.3 5.4.3 2.6 1.6 5.6 2.7 8.3l1.6.3c-.6-2-1.5-4.6-1.6-6.8-.1-2.4.6-3.9 2.1-4.3-.2-1.2-.7-2.3-1.5-2.9z"/><circle cx="12.6" cy="9.6" r="1" fill="#2D4F8E"/><path fill="#FDD20A" d="M11 13.2c1.4-.6 3.5-1 4.7-.7.4.4-.6 1.3-1.7 1.5-1.3.3-2.5 0-3-.8z"/><path fill="#65BC46" d="M11.2 17.6c.8.2 1.7.1 2.4-.3l.4 1.3c-.9.4-1.9.5-2.8.3z"/></svg>`,
  bing: `<svg viewBox="0 0 24 24"><defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#37BDFF"/><stop offset="1" stop-color="#0D7C6B"/></linearGradient></defs><path fill="url(#b)" d="M6 2.5l3.6 1.3v12.4l4.9-2.8-2.4-1.1-1.5-3.8 7.4 2.6v3.9l-8.4 4.9L6 17.9z"/></svg>`,
  kagi: `<svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="#FFB319"/><path fill="#1E1E2E" d="M7.5 6h2.6v5.2L14.6 6h3.1l-4.7 5.4 5 6.6h-3.1l-3.6-4.9-1.2 1.3V18H7.5z"/></svg>`,
};
const b = await chromium.launch();
const p = await b.newPage({ deviceScaleFactor: 1 });
for (const [name, svg] of Object.entries(marks)) {
  await p.setContent(`<body style="margin:0;background:transparent"><div id="m" style="width:128px;height:128px">${svg.replace('<svg ', '<svg width="128" height="128" ')}</div></body>`);
  await p.locator('#m').screenshot({ path: `${out}/${name}.png`, omitBackground: true });
}
await b.close();
console.log('logos written');
