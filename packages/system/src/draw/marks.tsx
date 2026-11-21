// Hand-drawn approximations of runtime and vendor marks. They tell the reader
// the runtime without a word. Word marks are set in the drawing's ink, not the
// vendor's colour. A mark with no drawing is written as a small mono tag, so
// any drawing can name its own runtimes and protocols without renderer code.
import type { ReactNode } from 'react';
import { fs } from './type.ts';

const S = ({ s = 16, vb = '0 0 24 24', children, title }: { s?: number; vb?: string; children: ReactNode; title: string }) => (
  <svg width={s} height={s} viewBox={vb} aria-label={title} role="img" style={{ display: 'block', flex: 'none' }}>
    {children}
  </svg>
);

const Word = ({ children, w = 600, size, italic, ls }: { children: ReactNode; w?: number; size: number; italic?: boolean; ls?: string }) => (
  <span style={{ color: 'var(--sys-ink)', fontWeight: w, fontSize: fs(size), fontStyle: italic ? 'italic' : 'normal', letterSpacing: ls, lineHeight: 1, whiteSpace: 'nowrap' }}>{children}</span>
);

// text drawn inside a mark's square
const svgText = (n: number) => ({ fontSize: fs(n), fontWeight: 700, fontFamily: 'var(--font-sans)' });

export const MARKS: Record<string, (s: number) => ReactNode> = {
  cloudflare: (s) => (
    <S s={s} title="Cloudflare" vb="0 0 32 20">
      <path d="M24.6 17.5H5.2c-2 0-3.6-1.5-3.6-3.4 0-1.8 1.4-3.3 3.2-3.4.5-3 3.1-5.2 6.2-5.2 1.8 0 3.4.7 4.6 1.9 1.1-2.6 3.6-4.4 6.6-4.4 3.9 0 7.1 3.1 7.2 7 1.5.6 2.4 1.9 2.4 3.5 0 2.2-1.7 4-3.9 4z" fill="#F38020" />
    </S>
  ),
  ts: (s) => (
    <S s={s} title="TypeScript">
      <rect x="1" y="1" width="22" height="22" rx="2.5" fill="#3178C6" />
      <text x="20.5" y="19.5" textAnchor="end" fill="#fff" style={svgText(11)}>TS</text>
    </S>
  ),
  react: (s) => (
    <S s={s} title="React" vb="-12 -12 24 24">
      <circle r="2.1" fill="#149ECA" />
      {[0, 60, 120].map((a) => <ellipse key={a} rx="10.5" ry="4" fill="none" stroke="#149ECA" strokeWidth="1.3" transform={`rotate(${a})`} />)}
    </S>
  ),
  electron: (s) => (
    <S s={s} title="Electron" vb="-12 -12 24 24">
      <circle r="2" fill="#47848F" />
      {[30, 90, 150].map((a) => <ellipse key={a} rx="10.5" ry="3.6" fill="none" stroke="#47848F" strokeWidth="1.3" transform={`rotate(${a})`} />)}
    </S>
  ),
  swift: (s) => (
    <S s={s} title="Swift">
      <rect x="1" y="1" width="22" height="22" rx="5.5" fill="#F05138" />
      <path d="M17.8 15.6c.9-2.9-.4-6.4-3.4-8.6 1.4 1.9 1.9 4.1 1.3 5.9-2.4-1.6-5-3.7-7-5.8 1.6 2.3 3.5 4.3 5.4 5.9-2.4 1-5.6.4-8.4-1.7 2.3 3.4 6.4 5.4 10 3.9.8.4 1.6.8 2.1 1.6.3-.5.2-.9 0-1.2z" fill="#fff" />
    </S>
  ),
  go: (s) => <Word w={700} italic size={s * 0.9}>GO</Word>,
  postgres: (s) => (
    <S s={s} title="Postgres">
      <circle cx="12" cy="12" r="11" fill="#336791" />
      <path d="M8 17V8.2c0-.6.4-1 1-1h3.4c2 0 3.4 1.3 3.4 3.1s-1.4 3.1-3.4 3.1H8" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
    </S>
  ),
  planetscale: (s) => (
    <S s={s} title="PlanetScale">
      <circle cx="12" cy="12" r="10.5" fill="none" stroke="var(--sys-ink)" strokeWidth="2" />
      <path d="M5 17.5L17.5 5" stroke="var(--sys-ink)" strokeWidth="2" />
    </S>
  ),
  r2: (s) => (
    <S s={s} title="R2">
      <rect x="1.5" y="3.5" width="21" height="17" rx="3" fill="none" stroke="#F38020" strokeWidth="1.8" />
      <text x="12" y="16.3" textAnchor="middle" fill="#F38020" style={svgText(9.5)}>R2</text>
    </S>
  ),
  git: (s) => (
    <S s={s} title="git">
      <rect x="4" y="4" width="16" height="16" rx="2.5" transform="rotate(45 12 12)" fill="#F05033" />
      <path d="M9.2 7.5l3 3m0 0v5.5m0-5.5l3 3" stroke="#fff" strokeWidth="1.5" fill="none" />
      <circle cx="12.2" cy="10.5" r="1.3" fill="#fff" />
      <circle cx="12.2" cy="16.2" r="1.3" fill="#fff" />
      <circle cx="15.2" cy="13.5" r="1.3" fill="#fff" />
    </S>
  ),
  github: (s) => <Word size={s * 0.8} w={700}>GitHub</Word>,
  linear: (s) => (
    <S s={s} title="Linear">
      <circle cx="12" cy="12" r="10.5" fill="#5E6AD2" />
      <path d="M3.5 13.5l7 7M2.6 9.4l12 12M4.8 4.8l14.4 14.4" stroke="#fff" strokeWidth="1.6" />
    </S>
  ),
  slack: (s) => (
    <S s={s} title="Slack">
      <rect x="9.5" y="2" width="4" height="9" rx="2" fill="#36C5F0" />
      <rect x="13" y="9.5" width="9" height="4" rx="2" fill="#2EB67D" />
      <rect x="10.5" y="13" width="4" height="9" rx="2" fill="#ECB22E" />
      <rect x="2" y="10.5" width="9" height="4" rx="2" fill="#E01E5A" />
    </S>
  ),
  figma: (s) => (
    <S s={s} title="Figma" vb="0 0 16 24">
      <circle cx="5" cy="4" r="4" fill="#F24E1E" />
      <circle cx="11" cy="4" r="4" fill="#FF7262" />
      <circle cx="5" cy="12" r="4" fill="#A259FF" />
      <circle cx="11" cy="12" r="4" fill="#1ABCFE" />
      <circle cx="5" cy="20" r="4" fill="#0ACF83" />
    </S>
  ),
  claude: (s) => (
    <S s={s} title="Claude" vb="-12 -12 24 24">
      {Array.from({ length: 10 }).map((_, i) => <path key={i} d="M0 -2.2L.9 -10.5h-1.8z" fill="#D97757" transform={`rotate(${i * 36 + (i % 2) * 6})`} />)}
      <circle r="2.6" fill="#D97757" />
    </S>
  ),
  codex: (s) => (
    <S s={s} title="Codex">
      <circle cx="12" cy="12" r="10.5" fill="var(--sys-ink)" />
      <path d="M8 9.5l3 2.5-3 2.5M12.5 15h4" stroke="var(--sys-box)" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </S>
  ),
  cursor: (s) => (
    <S s={s} title="Cursor">
      <path d="M12 2l9 5v10l-9 5-9-5V7z" fill="var(--sys-ink)" />
      <path d="M12 2v10l9-5M12 12L3 7M12 12v10" stroke="#8a8c90" strokeWidth=".8" fill="none" />
    </S>
  ),
  devin: (s) => (
    <S s={s} title="Devin">
      <rect x="2" y="2" width="20" height="20" rx="4" fill="#0f6f5c" />
      <path d="M8 7h3.5a5 5 0 010 10H8z" fill="none" stroke="#fff" strokeWidth="1.8" />
    </S>
  ),
  openai: (s) => <Word size={s * 0.8}>OpenAI</Word>,
  stripe: (s) => <Word size={s * 0.85} w={700} ls="-0.02em">stripe</Word>,
  workos: (s) => <Word size={s * 0.8}>WorkOS</Word>,
  hono: (s) => (
    <S s={s} title="Hono">
      <path d="M12 2c3 4 7 7.5 7 12.2A7 7 0 015 14.2C5 11 7 9 8.6 7.3c.2 2 1 3.3 2.3 4C10.8 8 11.2 5 12 2z" fill="#FF5B11" />
    </S>
  ),
  mermaid: (s) => <Word size={s * 0.8}>mermaid</Word>,
  mcp: (s) => (
    <span className="sys-mark-mcp" style={{ fontSize: fs(s * 0.62) }}>MCP</span>
  ),
  workers: (s) => (
    <S s={s} title="Workers">
      <path d="M7.5 3L2 12l5.5 9h3L5 12l5.5-9zM13.5 3l5.5 9-5.5 9h3L22 12 16.5 3z" fill="#F38020" />
    </S>
  ),
  vite: (s) => (
    <S s={s} title="Vite">
      <path d="M2 4.5l10 17.5 10-17.5-10 1.8z" fill="#7E6CF2" />
      <path d="M13.6 2.5L8 3.6l-.4 7.3 2.3-.5-.6 3.6 2.6-.6-1.2 6 5-9.3-2.6.5 1.2-4.7-2.4.4z" fill="#FFC824" />
    </S>
  ),
  vitest: (s) => (
    <S s={s} title="Vitest">
      <path d="M3 5l7.5 15h3L21 5" fill="none" stroke="#729B1B" strokeWidth="3" strokeLinejoin="round" />
      <path d="M12.6 3.5L9.5 11h3l-1.4 6.4 5-8.4h-3l1.6-5.5z" fill="#FCC72B" />
    </S>
  ),
  playwright: (s) => (
    <S s={s} title="Playwright">
      <path d="M3 9.5c3-2 6-2.6 9-1.6l-1.6 9.4c-3 .4-5.4-.8-6.8-3.4z" fill="#2EAD33" />
      <path d="M12.2 7.6c3.2-1.4 6.2-1.4 8.8.4l-2 7.2c-1.4 2.4-3.8 3.4-7 3z" fill="#D65348" />
      <circle cx="8" cy="11.6" r="1" fill="var(--sys-ink)" />
      <circle cx="16" cy="10.8" r="1" fill="var(--sys-ink)" />
    </S>
  ),
  sentry: (s) => (
    <S s={s} title="Sentry">
      <path d="M13.6 3.6a1.9 1.9 0 00-3.2 0L7.6 8.4a10 10 0 015.6 8.6h-2a8 8 0 00-4.6-6.8L4.4 14a4.4 4.4 0 012.6 3h-4.2a.4.4 0 01-.3-.6l1.2-2.1-.8-.5-1.2 2.1A1.5 1.5 0 002.8 18H8.6a6.2 6.2 0 00-2.9-5.4l.9-1.6a8.3 8.3 0 013.6 7h5a12 12 0 00-5.8-10l1.9-3.3c.1-.2.4-.2.5 0l8.3 14.4c.1.2 0 .5-.3.5h-1.9v1.4h1.9a1.9 1.9 0 001.6-2.8z" fill="var(--sys-ink)" />
    </S>
  ),
  posthog: (s) => (
    <S s={s} title="PostHog">
      <path d="M2 18l4-4v4zM2 13l4-4v4zM7 18l4-4v4zM2 8l4-4v4zM7 13l4-4v4zM12 18l4-4v4z" fill="#1D4AFF" />
      <path d="M12 13l4-4v4zM7 8l4-4v4z" fill="#F9BD2B" />
      <path d="M16.5 18L22 12.5V18z" fill="var(--sys-ink)" />
    </S>
  ),
  pnpm: (s) => (
    <S s={s} title="pnpm">
      {[[2, 2], [9, 2], [16, 2], [16, 9]].map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="6" height="6" fill="#F9AD00" />)}
      {[[9, 9], [2, 16], [9, 16], [16, 16]].map(([x, y]) => <rect key={`${x}-${y}`} x={x} y={y} width="6" height="6" fill="#4E4E4E" />)}
    </S>
  ),
  python: (s) => (
    <S s={s} title="Python">
      <path d="M11.8 2c-4.6 0-4.3 2-4.3 2v2.1h4.4v.6H5.8S2.8 6.4 2.8 11.1s2.6 4.5 2.6 4.5H7v-2.2s-.1-2.6 2.6-2.6h4.4s2.5 0 2.5-2.4V4.4S16.9 2 11.8 2zm-2.4 1.4a.8.8 0 110 1.6.8.8 0 010-1.6z" fill="#3776AB" />
      <path d="M12.2 22c4.6 0 4.3-2 4.3-2v-2.1h-4.4v-.6h6.1s3 .3 3-4.4-2.6-4.5-2.6-4.5H17v2.2s.1 2.6-2.6 2.6H10s-2.5 0-2.5 2.4v4S7.1 22 12.2 22zm2.4-1.4a.8.8 0 110-1.6.8.8 0 010 1.6z" fill="#FFD43B" />
    </S>
  ),
  node: (s) => (
    <S s={s} title="Node.js">
      <path d="M12 1.5l9.5 5.5v10L12 22.5 2.5 17V7z" fill="#5FA04E" />
      <text x="12" y="15.5" textAnchor="middle" fill="#fff" style={{ ...svgText(8), fontFamily: 'var(--font-mono)' }}>JS</text>
    </S>
  ),
};

export function Mark({ id, s = 16 }: { id: string; s?: number }) {
  const m = MARKS[id];
  // a long tag id is cut with an ellipsis and kept whole in the tooltip
  return m ? (
    <span className="sys-mark" title={id}>{m(s)}</span>
  ) : (
    <span className="sys-mark sys-tag" title={id} style={{ fontSize: fs(Math.max(9, s * 0.62)) }}>{id}</span>
  );
}

export const Marks = ({ ids, s = 15 }: { ids: string[]; s?: number }) => (
  <span className="sys-marks">{ids.map((m) => <Mark key={m} id={m} s={s} />)}</span>
);
