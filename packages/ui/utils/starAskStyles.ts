/**
 * The art band is an illustration in the brand kit's Type Only palette, the same in light and
 * dark: bone ground, faint grid, corner ticks, an ink rule, the small mono row and one giant
 * line, with a warm yellow star (#F3D45E) behind it that fills #FFC926 once starred, in one
 * frame (nothing moves, so reduced motion shows the same).
 */
import { STAR_ASK_DISPLAY_FONT, STAR_ASK_FONT_FACES, STAR_ASK_MONO_FONT } from './starAskFonts';

export const STAR_ASK_CSS = `${STAR_ASK_FONT_FACES}
.psa{--psa-fs-m:var(--text-sm,14px);--psa-fs-l:var(--text-sm,14px);--psa-fs-h:var(--text-base,16px);--psa-fs-xh:var(--text-xl,20px);color:var(--foreground);font-family:inherit;text-align:left}
.pn-inbox .psa{--psa-fs-m:var(--ib-fs-13-5,13.5px);--psa-fs-l:var(--ib-fs-14,14px);--psa-fs-h:var(--ib-fs-15,15px);--psa-fs-xh:var(--ib-fs-20,20px)}
.psa *{box-sizing:border-box}
.psa .psa-art{position:relative;overflow:hidden;background:#E8E3D9;flex:none;aspect-ratio:340/104}
.psa .psa-board{position:absolute;left:0;top:0;width:340px;height:104px;transform-origin:0 0;overflow:hidden;background:#E8E3D9;color:#161514}
.psa .psa-board>*{position:absolute;margin:0}
.psa .psa-star{left:0;top:0;width:340px;height:104px;overflow:visible}
.psa .psa-star polygon{fill:#F3D45E;stroke:none}
.psa .psa-lit .psa-star polygon{fill:#FFC926}
.psa .psa-grid{left:12px;right:12px;top:0;bottom:0;background-image:repeating-linear-gradient(90deg,rgb(201 194 182 / .7) 0 1px,transparent 1px calc(316px / 4))}
.psa .psa-reg{width:9px;height:9px;border-left:1px solid #C9C2B6;border-top:1px solid #C9C2B6}
.psa .psa-r1{left:6px;top:4px}
.psa .psa-r2{right:6px;bottom:4px;transform:rotate(180deg)}
.psa .psa-rule{left:12px;right:12px;top:22px;height:1px;background:#161514}
.psa .psa-lab{left:12px;right:12px;top:8px;height:12px;font-family:"${STAR_ASK_MONO_FONT}",ui-monospace,monospace;font-weight:500;font-size:9px;line-height:12px;color:#161514;white-space:nowrap}
.psa .psa-lab span{position:absolute;top:0;left:0}
.psa .psa-lab .psa-lab-r{left:auto;right:0}
.psa .psa-big{left:12px;top:34px;width:316px;height:68px;font-family:"${STAR_ASK_DISPLAY_FONT}",sans-serif;font-weight:900;font-style:normal}
.psa .psa-w{position:absolute;left:0;bottom:0;white-space:nowrap;line-height:.8;letter-spacing:-0.01em;word-spacing:.14em}
.psa .psa-h{margin:0;font-weight:600;letter-spacing:-0.01em;color:var(--foreground)}
.psa .psa-p{margin:0;color:var(--muted-foreground);line-height:1.5;text-wrap:pretty}
.psa .psa-acts{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.psa .psa-sp{flex:1}
.psa .psa-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:32px;padding:0 13px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--foreground);font:inherit;font-size:var(--psa-fs-m);font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;text-decoration:none}
.psa .psa-btn.psa-pri{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}
.psa .psa-btn.psa-pri:hover{opacity:.92}
.psa .psa-btn.psa-ghost:hover{background:var(--ib-hover,var(--muted))}
.psa .psa-btn.psa-lg{height:36px;padding:0 16px;font-size:var(--psa-fs-l)}
.psa .psa-btn svg{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linejoin:round;stroke-linecap:round}
.psa .psa-btn:focus-visible,.psa .psa-done a:focus-visible{outline:2px solid var(--ring);outline-offset:2px}
.psa .psa-btn[aria-busy="true"]{cursor:progress}
.psa .psa-done{margin:0;display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px 8px;min-height:32px;font-size:var(--psa-fs-m);font-weight:500;color:var(--foreground)}
.psa .psa-done i{width:10px;height:10px;background:#FFC926;box-shadow:0 0 0 1px color-mix(in oklch,#0F0D16 30%,transparent);flex:none}
.psa .psa-done a{color:var(--primary);text-decoration:underline;text-underline-offset:3px;border-radius:3px}
.psa.psa-corner{position:fixed;z-index:45;right:20px;bottom:20px;width:340px;background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:var(--ib-float-shadow,0 16px 40px -14px rgb(0 0 0 / .4))}
.psa.psa-corner .psa-body{display:grid;gap:10px;padding:14px 16px}
.psa.psa-corner .psa-h{font-size:var(--psa-fs-h)}
.psa.psa-corner .psa-p{font-size:var(--psa-fs-m)}
.psa.psa-corner .psa-acts{margin-top:4px}
.psa.psa-card{width:100%;margin:32px auto 0;background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:0 16px 40px -18px rgb(0 0 0 / .3)}
.psa.psa-card .psa-body{display:grid;gap:14px;padding:20px 24px}
.psa.psa-card .psa-h{font-size:var(--psa-fs-xh)}
.psa.psa-card .psa-p{font-size:var(--psa-fs-l)}
.psa.psa-card .psa-acts{margin-top:6px}
@media (max-width:640px){
.psa.psa-corner{left:12px;right:12px;bottom:12px;width:auto}
.psa.psa-card .psa-body{padding:18px 18px 16px}
.psa.psa-card .psa-acts{flex-direction:column-reverse;align-items:stretch}
.psa.psa-card .psa-sp{display:none}
}`;
