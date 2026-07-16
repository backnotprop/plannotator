# LaTeX + Media Regression Test

A manual fixture that exercises #878's math rendering **and** the QA regression
fixes (unclosed delimiters, dollar-amount prose, media tags). Every `##` heading
below must appear in the Table of Contents — if any go missing, a block is
swallowing content.

## 1. Inline math (should render)

The mass-energy relation is $E = mc^2$, and the Pythagorean theorem is
$a^2 + b^2 = c^2$. A single variable like $x$ and a Greek one like $\alpha$
should render too. Parenthesized form: \(A = \pi r^2\).

## 2. Display math (should render)

Closed `$$` block:

$$
\sum_{i=1}^{n} i = \frac{n(n+1)}{2}
$$

Closed `\[ \]` block:

\[ \int_0^1 x^2 \, dx = \frac{1}{3} \]

Closed on one line (must render as display math):

$$e^{i\pi} + 1 = 0$$

Closing delimiter with trailing text (formula renders, prose stays text):

$$E = mc^2$$ where $E$ is the energy.

## 3. Dollar amounts (must stay LITERAL — NOT math)

This tier costs $5-$10 depending on usage. The annual budget is
$50,000-$100,000 this year. Tier A is $5/mo and tier B is $10/mo. A single
price like $42 in a sentence should also stay plain text.

## 4. Unclosed math must NOT swallow this section

Here is a stray, unterminated display-math opener:

$$
\theta = \frac{1}{2}

...and this line, plus everything below it, MUST still render as normal blocks.
If section 5's heading is missing from the TOC, the swallow bug is back.

## 5. Media tags

A self-closing video (must not swallow the rest of the doc):

<video src="https://example.com/clip.mp4" controls />

An unclosed video opener:

<video src="https://example.com/other.mp4" controls>

A multi-line image (must render as one image, not leak attribute text):

<img
  src="https://picsum.photos/600/200"
  alt="architecture diagram"
  width="600">

A responsive picture (should render its image):

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://placehold.co/600x200/222/fff.png?text=dark">
  <img alt="logo" src="https://placehold.co/600x200/eee/222.png?text=light">
</picture>

## 6. Mixed content + math in code (math here must NOT render)

Inline `$x$` inside code stays literal, and a fenced block is untouched:

```
$$ this is code, not math $$
const price = "$5-$10";
```

## 7. Final heading (TOC sentinel)

If you can see this heading in the Table of Contents, no block swallowed the
document. Select this sentence and add an annotation to confirm annotation
still works end-to-end.
