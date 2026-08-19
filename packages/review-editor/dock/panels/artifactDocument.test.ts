import { describe, expect, it } from 'bun:test';
import {
  artifactContentBaseUrl,
  artifactContentProxyUrl,
  injectArtifactBaseUrl,
  resolveArtifactReferenceUrl,
  rewriteArtifactMarkdownReferences,
} from './artifactDocument';

const github = { platform: 'github', host: 'github.com' } as const;
const gitlab = { platform: 'gitlab', host: 'gitlab.com' } as const;
const hasDom = typeof document !== 'undefined';

describe('injectArtifactBaseUrl', () => {
  it('places the base inside an existing head and escapes the URL', () => {
    expect(
      injectArtifactBaseUrl(
        '<html><head><title>Review</title></head><body></body></html>',
        'https://example.com/path/review.html?left=1&right="two"',
        github,
      ),
    ).toContain(
      '<head><base href="https://example.com/path/review.html?left=1&amp;right=&quot;two&quot;">',
    );
  });

  it('prepends the base when the document has no head', () => {
    expect(injectArtifactBaseUrl('<main>Review</main>', 'https://example.com/review.html', github))
      .toBe('<base href="https://example.com/review.html"><main>Review</main>');
  });

  it('routes private HTML resources through the authenticated content endpoint', () => {
    const artifactUrl = 'https://github.com/acme/widgets/blob/main/docs/review.html';
    const html = injectArtifactBaseUrl(
      [
        '<head><link rel="stylesheet" href="./review.css"></head><body>',
        '<img src="../images/diff.png" srcset="data:image/png;base64,AAAA 1x, ../images/diff@2x.png 2x">',
        '<video poster="./poster.png"><track src="./captions.vtt"></video>',
        '<embed src="./review.pdf"><object data="./review.svg"></object>',
        '<link rel="preload" imagesrcset="./card.png 1x, ./card@2x.png 2x">',
        '<svg><image href="./diagram.svg"><feImage xlink:href="./texture.png">',
        '<use xlink:href="./sprites.svg#check"></use></svg>',
        '<table background="./grid.png"><tr><td></td></tr></table>',
        '<style>.hero{background:url(../images/hero.png)}</style></body>',
      ].join(''),
      artifactUrl,
      github,
    );
    expect(html).toContain('/api/pr-artifact-content?');
    expect(html).toContain('review.css');
    expect(html).toContain('diff.png');
    expect(html).toContain('diff%402x.png');
    expect(html).toContain('captions.vtt');
    expect(html).toContain('review.pdf');
    expect(html).toContain('review.svg');
    expect(html).toContain('diagram.svg');
    expect(html).toContain('texture.png');
    expect(html).toContain('sprites.svg%23check');
    expect(html).toContain('card.png');
    expect(html).toContain('card%402x.png');
    expect(html).toContain('grid.png');
    expect(html).toContain('hero.png');
    expect(html).toContain('source=');
    expect(html).toContain('data:image/png;base64,AAAA 1x');
    expect(html).not.toContain('<img src="../images/diff.png">');
  });

  it('leaves public CDN resources direct while proxying repository resources', () => {
    const artifactUrl = 'https://github.com/acme/widgets/blob/main/docs/review.html';
    const html = injectArtifactBaseUrl(
      '<link href="https://cdn.example.com/theme.css"><img src="./private.png">',
      artifactUrl,
      github,
    );
    expect(html).toContain('href="https://cdn.example.com/theme.css"');
    expect(html).toContain('/api/pr-artifact-content?');
    expect(html).toContain('private.png');
    expect(html).not.toContain('url=https%3A%2F%2Fcdn.example.com');
  });
});

describe('rewriteArtifactMarkdownReferences', () => {
  it.skipIf(!hasDom)('is idempotent and leaves public CDN images direct', () => {
    const artifactUrl = 'https://github.com/acme/widgets/blob/main/README.md';
    const root = document.createElement('div');
    root.innerHTML = [
      '<img alt="private" src="/api/image?path=.github/assets/banner.webp">',
      '<img alt="public" src="https://cdn.example.com/logo.svg">',
    ].join('');

    rewriteArtifactMarkdownReferences(root, artifactUrl, github);
    const privateImage = root.querySelector<HTMLImageElement>('img[alt="private"]');
    const publicImage = root.querySelector<HTMLImageElement>('img[alt="public"]');
    const firstPrivateUrl = privateImage?.getAttribute('src');
    expect(firstPrivateUrl).toContain('/api/pr-artifact-content?');
    expect(publicImage?.getAttribute('src')).toBe('https://cdn.example.com/logo.svg');

    rewriteArtifactMarkdownReferences(root, artifactUrl, github);
    expect(privateImage?.getAttribute('src')).toBe(firstPrivateUrl);
    expect(privateImage?.getAttribute('src')).not.toContain(
      'raw.githubusercontent.com%2Fapi%2Fpr-artifact-content',
    );
    expect(publicImage?.getAttribute('src')).toBe('https://cdn.example.com/logo.svg');
  });
});

describe('artifactContentProxyUrl', () => {
  it('keeps the target and provenance source in a same-origin URL', () => {
    const proxy = artifactContentProxyUrl(
      'https://raw.githubusercontent.com/acme/widgets/main/image.png',
      'https://github.com/acme/widgets/blob/main/review.html',
    );
    expect(proxy.startsWith('/api/pr-artifact-content?')).toBe(true);
    const params = new URL(proxy, 'http://localhost').searchParams;
    expect(params.get('url')).toBe('https://raw.githubusercontent.com/acme/widgets/main/image.png');
    expect(params.get('source')).toBe('https://github.com/acme/widgets/blob/main/review.html');
  });
});

describe('resolveArtifactReferenceUrl', () => {
  const artifactUrl = 'https://github.com/user-attachments/files/123/explainer.md';

  it('resolves Markdown links and local image-proxy paths against the artifact', () => {
    expect(resolveArtifactReferenceUrl('../images/diff.png', artifactUrl, github)).toBe(
      'https://github.com/user-attachments/files/images/diff.png',
    );
    expect(
      resolveArtifactReferenceUrl('/api/image?path=diagram.png', artifactUrl, github),
    ).toBe('https://github.com/user-attachments/files/123/diagram.png');
  });

  it('leaves document anchors and unsafe protocols alone', () => {
    expect(resolveArtifactReferenceUrl('#quality-diff', artifactUrl, github)).toBeNull();
    expect(resolveArtifactReferenceUrl('javascript:alert(1)', artifactUrl, github)).toBeNull();
    expect(resolveArtifactReferenceUrl('data:image/png;base64,AAAA', artifactUrl, github)).toBeNull();
  });
});

describe('artifactContentBaseUrl', () => {
  it('maps GitHub and GitLab file viewers to their raw-content equivalents', () => {
    expect(artifactContentBaseUrl(
      'https://github.com/acme/widgets/blob/feature/docs/explainer.html',
      github,
    )).toBe('https://raw.githubusercontent.com/acme/widgets/feature/docs/explainer.html');
    expect(artifactContentBaseUrl(
      'https://gitlab.com/acme/widgets/-/blob/feature/docs/explainer.html',
      gitlab,
    )).toBe('https://gitlab.com/acme/widgets/-/raw/feature/docs/explainer.html');
    expect(artifactContentBaseUrl(
      'https://github.example.com:8443/acme/widgets/blob/main/review.html',
      { platform: 'github', host: 'github.example.com:8443' },
    )).toBe('https://github.example.com:8443/acme/widgets/raw/main/review.html');
  });

  it('uses the raw base when resolving assets in a repository-backed explainer', () => {
    expect(resolveArtifactReferenceUrl(
      './diagram.png',
      'https://github.com/acme/widgets/blob/feature/docs/explainer.md',
      github,
    )).toBe('https://raw.githubusercontent.com/acme/widgets/feature/docs/diagram.png');
  });

  it('does not reinterpret GitHub-shaped paths on an external host', () => {
    const artifactUrl = 'https://example.com/acme/widgets/blob/main/explainer.html';
    expect(artifactContentBaseUrl(artifactUrl, github)).toBe(artifactUrl);
  });
});
