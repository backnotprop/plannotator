# Raw HTML Block Test Fixture

This fixture exercises the new CommonMark Type 6 HTML block detection plus the
sanitized renderer. Headings and paragraphs around each block should render as
normal markdown — the HTML blocks should render as real HTML.

## 1. GitHub-style collapsible section

<details>
<summary>Prerequisites</summary>

Install **bun** and clone the repo. The summary row is always visible; the
body renders only when expanded. Selecting text inside this expanded block
should trigger the annotation toolbar via web-highlighter.

</details>

A regular paragraph after the collapsible. This should render as plain
markdown with **bold** and *italic* formatting intact.

## 2. Nested collapsibles

<details>
<summary>Outer section</summary>

<details>
<summary>Inner section</summary>

Nested details render as one HTML block (CommonMark Type 6 terminates on blank
line, not on matching close tag).

</details>

</details>

## 3. Raw blockquote with inline formatting

<blockquote>
This blockquote was authored as raw HTML. It should render with the
<code>.html-block blockquote</code> styling from theme.css — a primary-tinted
left border and italic muted foreground.
</blockquote>

## 4. Section / header / footer landmarks

<section>
<header><strong>Section header</strong></header>

The section/article/aside/header/footer tags are in the allowlist and should
render as generic block containers.

<footer>Section footer</footer>
</section>

## 5. Sanitizer smoke test

<details>
<summary>Should strip scripts and event handlers</summary>

<script>alert('xss')</script>

<p onclick="alert('xss')">Click me — the onclick handler should be stripped by DOMPurify.</p>

<a href="javascript:alert('xss')">This javascript: href should be neutralized.</a>

<a href="https://plannotator.ai" rel="noopener" target="_blank">This safe https link should render normally.</a>

</details>

## 6. Non-allowlisted tag falls through

<xyz>This custom tag is NOT in the block-tag allowlist, so the parser should leave it as paragraph text and React will escape the angle brackets.</xyz>

## 7. Adjacent blocks separated by blank line

<details>
<summary>First</summary>
One.
</details>

<details>
<summary>Second</summary>
Two.
</details>

## 8. Table authored as raw HTML

<table>
  <thead>
    <tr><th>Tag</th><th>Allowed</th></tr>
  </thead>
  <tbody>
    <tr><td>details</td><td>yes</td></tr>
    <tr><td>script</td><td>no — stripped</td></tr>
  </tbody>
</table>

## End

Final paragraph — confirms that HTML blocks don't swallow trailing content.
