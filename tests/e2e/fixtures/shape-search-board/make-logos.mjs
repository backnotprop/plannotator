import { createRequire } from 'node:module';
const [repo, out] = process.argv.slice(2);
const { chromium } = createRequire(`${repo}/package.json`)('@playwright/test');
const tile = (letter, fill) =>
  `<svg viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="6" fill="${fill}"/><text x="12" y="16.6" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="13" font-weight="700" fill="#fff">${letter}</text></svg>`;
const marks = { google: tile('G', '#475569'), ddg: tile('D', '#0f766e'), bing: tile('B', '#71717a'), kagi: tile('K', '#b45309') };
const b = await chromium.launch();
const p = await b.newPage({ deviceScaleFactor: 1 });
for (const [name, svg] of Object.entries(marks)) {
  await p.setContent(`<body style="margin:0;background:transparent"><div id="m" style="width:128px;height:128px">${svg.replace('<svg ', '<svg width="128" height="128" ')}</div></body>`);
  await p.locator('#m').screenshot({ path: `${out}/${name}.png`, omitBackground: true });
}
await b.close();
console.log('logos written');
