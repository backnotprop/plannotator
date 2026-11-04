/**
 * Drawings that try to load (or run) something from outside a Shape board:
 * the independent review's probe payloads for #2585, plus their near
 * variants. The store must refuse each one by field (`shapeHtmlProblems`,
 * `shapeCssProblems`), and the board's sanitizer must neuter each one. The
 * host is `.invalid`, which never resolves; the tests never attach these to a
 * live page, so nothing is fetched either way.
 */
export const OUTSIDE_HOST = 'evil.invalid';

export const SHAPE_OUTSIDE_HTML: readonly string[] = [
  // The style attribute was never checked.
  '<div style="background:url(https://evil.invalid/a)">s</div>',
  '<div style="background:u\\72l(https://evil.invalid/a)">s</div>',
  '<div style="background-image:image-set(\'https://evil.invalid/a.png\' 1x)">s</div>',
  '<div style="background:url(&quot;https://evil.invalid/a&quot;)">s</div>',
  '<div style="background:url&lpar;https://evil.invalid/a)">s</div>',
  // srcset, poster, <source>, <input type=image>.
  '<img srcset="a.png 1x, https://evil.invalid/b.png 2x">',
  '<video poster="https:evil.invalid/p.png"><source src="https:evil.invalid/v.mp4"></video>',
  '<input type="image" src="https:evil.invalid/i.png">',
  // Schemes as a URL parser reads them.
  '<img src="https:evil.invalid/x.png">',
  '<img src="\\\\evil.invalid/x.png">',
  '<img src="/\\evil.invalid/x.png">',
  '<img src="//evil.invalid/x.png">',
  '<img src="  HTTPS://evil.invalid/x.png">',
  '<img src="ht&#9;tps://evil.invalid/x.png">',
  '<img src="ht&#9tps://evil.invalid/x.png">',
  '<img src="&#104;ttps://evil.invalid/x.png">',
  '<img src="https&colon;//evil.invalid/x.png">',
  '<img src="files/../../../etc/passwd">',
  '<img src="files/a\\..\\..\\passwd">',
  '<img src="data:image/svg+xml,<svg xmlns=\'http://www.w3.org/2000/svg\'><image href=\'https://evil.invalid/z\'/></svg>">',
  // SVG.
  '<svg><image href="https:evil.invalid/x"/></svg>',
  '<svg><image xlink:href="https://evil.invalid/x"/></svg>',
  '<svg><feImage href="https://evil.invalid/x.png"/></svg>',
  '<svg><use href="https://evil.invalid/s.svg#a"/><use href="data:image/svg+xml,<svg/>"/></svg>',
  '<svg><rect fill="url(https://evil.invalid/p.svg#a)" mask="url(https://evil.invalid/m.svg#m)" filter="url(https://evil.invalid/f.svg#f)"/></svg>',
  '<svg><path clip-path="url(https://evil.invalid/c.svg#c)" marker-end="url(https://evil.invalid/k.svg#k)"/></svg>',
  '<svg><animate attributeName="href" to="javascript:alert(1)"/><set attributeName="href" to="javascript:x"/></svg>',
  '<svg><foreignObject><img src="https:evil.invalid/fo.png"></foreignObject></svg>',
  // Links: only https may point out, and nothing runs.
  '<a href="http://evil.invalid/x">plain http</a>',
  '<a href="//evil.invalid/x">no scheme</a>',
  '<a href="data:text/html,<script>alert(1)</script>">d</a>',
  '<a href="javascript:alert(1)">j</a>',
  '<a href="java&#9;script:alert(1)">j2</a>',
  '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>',
  // Other attributes that load.
  '<button formaction="https://evil.invalid">b</button>',
  '<table background="https://evil.invalid/t.png"><tr><td>t</td></tr></table>',
  '<a href="#x" ping="https://evil.invalid/p">pinged</a>',
  '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>',
];

export const SHAPE_OUTSIDE_CSS: readonly string[] = [
  '@\\69mport url(https://evil.invalid/a.css);',
  '@import "https://evil.invalid/a.css";',
  '.a{background:u\\72l(https://evil.invalid/a)}',
  '.a{background:\\75rl(https://evil.invalid/a)}',
  '.a{background:url(https://evil.invalid/a)}',
  '.a{background:url( "  https:evil.invalid/a" )}',
  '.a{background:url(//evil.invalid/a)}',
  '.a{background-image:image-set("https://evil.invalid/a.png" 1x)}',
  '.a{background-image:-webkit-image-set("https://evil.invalid/a.png" 1x)}',
  '.a{background-image:im\\61ge-set("https://evil.invalid/a.png" 1x)}',
  '@font-face{font-family:x;src:url(https://evil.invalid/f.woff)}',
  '@font-face{font-family:x;src:local(x)}',
  '.a{background:url(data:image/svg+xml,%3Csvg%3E%3Cimage href=%22https://evil.invalid/z%22/%3E%3C/svg%3E)}',
];

/** What a drawing may hold: the board's own files, fragments, data images and https links. */
export const SHAPE_SAFE_HTML: readonly string[] = [
  '<img src="files/B-desktop-light.png" alt="Approved B">',
  '<img src="data:image/png;base64,AAAA" alt="dot">',
  '<a href="https://example.com/pr/1">PR</a>',
  '<a href="#step-2">step 2</a>',
  '<svg><defs><marker id="arrow"></marker></defs><path marker-end="url(#arrow)" fill="url(#g)" d="M0 0L4 4"/></svg>',
  '<div class="box" style="left:12px;top:40px;width:300px">box</div>',
];
