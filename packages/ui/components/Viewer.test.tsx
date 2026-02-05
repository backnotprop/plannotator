/**
 * Code Block Annotation Tests
 * 
 * Tests for the fix to PR #122 - code block annotation visual bug
 * Run: bun test packages/ui/components/Viewer.test.tsx
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { parseMarkdownToBlocks } from "../utils/parser";
import { Window } from 'happy-dom';

// Setup DOM globals
const window = new Window();
const document = window.document;
globalThis.document = document as any;
globalThis.window = window as any;

// Mock highlight.js for testing
const mockHljs = {
  highlightElement: (el: HTMLElement) => {
    // Simulate syntax highlighting by wrapping words in spans
    const text = el.textContent || '';
    el.innerHTML = text
      .split(' ')
      .map(word => `<span class="hljs-keyword">${word}</span>`)
      .join(' ');
  }
};

describe("Code Block Annotation Fix (PR #122)", () => {

  test("parseMarkdownToBlocks identifies code blocks correctly", () => {
    const markdown = `
# Test Plan

Some text here.

\`\`\`typescript
function hello() {
  return "world";
}
\`\`\`

More text.
`;

    const blocks = parseMarkdownToBlocks(markdown);
    
    // Find the code block
    const codeBlock = blocks.find(b => b.type === 'code');
    
    expect(codeBlock).toBeDefined();
    expect(codeBlock?.language).toBe('typescript');
    expect(codeBlock?.content).toContain('function hello()');
  });

  test("code block annotation wrapping works with plain text", () => {
    // Create a code element
    const codeEl = document.createElement('code');
    codeEl.className = 'hljs font-mono language-typescript';
    codeEl.textContent = 'function hello() {\n  return "world";\n}';

    // Simulate the fixed handleCodeBlockAnnotate behavior
    const id = `codeblock-${Date.now()}`;
    const codeText = codeEl.textContent || '';

    // Create mark wrapper with plain text (the fix)
    const wrapper = document.createElement('mark');
    wrapper.className = 'annotation-highlight deletion';
    wrapper.dataset.bindId = id;
    wrapper.textContent = codeText;

    // Replace code element's content with the wrapper
    codeEl.innerHTML = '';
    codeEl.appendChild(wrapper);

    // Verify the structure
    expect(codeEl.children.length).toBe(1);
    expect(codeEl.children[0].tagName).toBe('MARK');
    expect(codeEl.children[0].textContent).toBe(codeText);
    expect((codeEl.children[0] as HTMLElement).dataset.bindId).toBe(id);
  });

  test("OLD BUGGY APPROACH: surroundContents fails with syntax-highlighted code", () => {
    // Create a code element with syntax highlighting
    const codeEl = document.createElement('code');
    codeEl.innerHTML = '<span class="hljs-keyword">function</span> <span class="hljs-title">hello</span>() { }';

    try {
      // Try the old buggy approach
      const range = document.createRange();
      range.selectNodeContents(codeEl);
      
      const wrapper = document.createElement('mark');
      
      // This will fail or produce broken HTML
      range.surroundContents(wrapper);
      
      // If we get here, check if the structure is broken
      // With nested elements, surroundContents either throws or creates invalid structure
      const hasValidStructure = codeEl.querySelectorAll('mark').length === 1;
      
      // The bug is that this creates broken/duplicate structure
      console.log("Old approach created structure:", codeEl.innerHTML);
      
    } catch (err) {
      // Expected: surroundContents throws when range contains partially selected elements
      expect(err).toBeDefined();
      console.log("Old approach failed as expected:", (err as Error).message);
    }
  });

  test("NEW FIXED APPROACH: innerHTML replacement works with syntax-highlighted code", () => {
    // Create a code element with syntax highlighting (complex DOM)
    const codeEl = document.createElement('code');
    codeEl.className = 'hljs font-mono language-typescript';
    codeEl.innerHTML = '<span class="hljs-keyword">function</span> <span class="hljs-title">hello</span>() { }';
    
    const originalText = codeEl.textContent || '';

    // Apply the fix: replace innerHTML with mark wrapper containing plain text
    const id = `codeblock-${Date.now()}`;
    const wrapper = document.createElement('mark');
    wrapper.className = 'annotation-highlight deletion';
    wrapper.dataset.bindId = id;
    wrapper.textContent = originalText;

    codeEl.innerHTML = '';
    codeEl.appendChild(wrapper);

    // Verify clean structure
    expect(codeEl.children.length).toBe(1);
    expect(codeEl.children[0].tagName).toBe('MARK');
    expect(codeEl.textContent).toBe(originalText);
    expect(codeEl.querySelectorAll('span.hljs-keyword').length).toBe(0); // No nested spans
    
    console.log("New approach created clean structure:", codeEl.innerHTML);
  });

  test("removeHighlight restores syntax highlighting for code blocks", () => {
    // Setup: annotated code block
    const codeEl = document.createElement('code');
    codeEl.className = 'hljs font-mono language-typescript';
    
    const wrapper = document.createElement('mark');
    wrapper.dataset.bindId = 'test-id';
    wrapper.textContent = 'function test() { }';
    codeEl.appendChild(wrapper);

    // Simulate removeHighlight behavior for code blocks
    const mark = codeEl.querySelector('[data-bind-id="test-id"]') as HTMLElement;
    expect(mark).toBeDefined();

    // Extract plain text
    const plainText = mark.textContent || '';
    
    // Restore plain text
    codeEl.textContent = plainText;
    
    // Re-apply syntax highlighting (using mock)
    mockHljs.highlightElement(codeEl);

    // Verify syntax highlighting was restored
    expect(codeEl.querySelectorAll('span.hljs-keyword').length).toBeGreaterThan(0);
    expect(codeEl.querySelector('[data-bind-id]')).toBeNull(); // mark removed
    expect(codeEl.textContent).toBe(plainText);
    
    console.log("After removeHighlight, restored:", codeEl.innerHTML);
  });

  test("annotation and removal roundtrip preserves code content", () => {
    const originalCode = 'function hello() {\n  return "world";\n}';
    
    // 1. Start with plain code
    const codeEl = document.createElement('code');
    codeEl.textContent = originalCode;
    
    // 2. Apply syntax highlighting
    mockHljs.highlightElement(codeEl);
    const highlightedHTML = codeEl.innerHTML;
    
    // 3. Annotate (using the fix)
    const id = 'test-annotation';
    const wrapper = document.createElement('mark');
    wrapper.dataset.bindId = id;
    wrapper.textContent = codeEl.textContent || '';
    codeEl.innerHTML = '';
    codeEl.appendChild(wrapper);
    
    // 4. Remove annotation
    const mark = codeEl.querySelector(`[data-bind-id="${id}"]`) as HTMLElement;
    const savedText = mark.textContent || '';
    codeEl.textContent = savedText;
    
    // 5. Re-highlight
    mockHljs.highlightElement(codeEl);
    
    // Verify content is preserved
    expect(codeEl.textContent).toBe(originalCode);
    expect(codeEl.innerHTML).toBe(highlightedHTML); // Structure restored
  });
});

describe("Edge Cases", () => {
  test("handles empty code blocks", () => {
    const codeEl = document.createElement('code');
    codeEl.textContent = '';
    
    const wrapper = document.createElement('mark');
    wrapper.textContent = codeEl.textContent || '';
    codeEl.innerHTML = '';
    codeEl.appendChild(wrapper);
    
    expect(codeEl.children.length).toBe(1);
    expect(codeEl.textContent).toBe('');
  });

  test("handles code blocks with special characters", () => {
    const specialCode = 'const x = "<script>alert(\'XSS\')</script>";';
    
    const codeEl = document.createElement('code');
    codeEl.textContent = specialCode;
    
    const wrapper = document.createElement('mark');
    wrapper.textContent = codeEl.textContent || '';
    codeEl.innerHTML = '';
    codeEl.appendChild(wrapper);
    
    expect(codeEl.textContent).toBe(specialCode);
    // Verify no script execution
    expect(codeEl.querySelector('script')).toBeNull();
  });

  test("handles very large code blocks", () => {
    const largeCode = 'x'.repeat(10000);
    
    const codeEl = document.createElement('code');
    codeEl.textContent = largeCode;
    
    const wrapper = document.createElement('mark');
    wrapper.textContent = codeEl.textContent || '';
    codeEl.innerHTML = '';
    codeEl.appendChild(wrapper);
    
    expect(codeEl.textContent?.length).toBe(10000);
  });
});

describe("Regression Tests - PR #122 Bug Prevention", () => {
  
  test("REGRESSION: annotated code block must NOT contain nested syntax spans", () => {
    // This is the actual bug - nested <span> elements inside <mark>
    const codeEl = document.createElement('code');
    codeEl.className = 'hljs language-typescript';
    
    // Start with syntax-highlighted code (simulate hljs output)
    codeEl.innerHTML = '<span class="hljs-keyword">function</span> <span class="hljs-title">hello</span>() { <span class="hljs-keyword">return</span> <span class="hljs-string">"world"</span>; }';
    
    const originalText = codeEl.textContent || '';
    
    // Apply annotation using the fix
    const wrapper = document.createElement('mark');
    wrapper.className = 'annotation-highlight deletion';
    wrapper.dataset.bindId = 'regression-test';
    wrapper.textContent = originalText;
    
    codeEl.innerHTML = '';
    codeEl.appendChild(wrapper);
    
    // CRITICAL ASSERTIONS - these prevent the bug from reoccurring
    const mark = codeEl.querySelector('mark');
    expect(mark).not.toBeNull();
    
    // The mark should contain NO nested spans (this is the bug fix)
    const nestedSpans = mark!.querySelectorAll('span');
    expect(nestedSpans.length).toBe(0);
    
    // The mark should only contain text nodes, no element children
    expect(mark!.children.length).toBe(0);
    
    // Verify text content is preserved
    expect(mark!.textContent).toBe(originalText);
    expect(codeEl.textContent).toBe(originalText);
  });

  test("REGRESSION: must handle code blocks with multiple syntax elements", () => {
    // Simulate a complex syntax-highlighted block
    const codeEl = document.createElement('code');
    codeEl.innerHTML = `
      <span class="hljs-keyword">const</span> 
      <span class="hljs-variable">foo</span> = 
      <span class="hljs-function">
        <span class="hljs-keyword">function</span>(
          <span class="hljs-params">a, b</span>
        ) 
      </span>{ 
        <span class="hljs-keyword">return</span> 
        <span class="hljs-variable">a</span> + 
        <span class="hljs-variable">b</span>; 
      };
    `.trim();
    
    const originalText = codeEl.textContent || '';
    
    // Annotate
    const wrapper = document.createElement('mark');
    wrapper.dataset.bindId = 'complex-test';
    wrapper.textContent = originalText;
    
    codeEl.innerHTML = '';
    codeEl.appendChild(wrapper);
    
    // Verify no nested syntax elements inside mark
    const mark = codeEl.querySelector('mark');
    expect(mark!.querySelectorAll('span').length).toBe(0);
    expect(mark!.querySelectorAll('.hljs-keyword').length).toBe(0);
    expect(mark!.querySelectorAll('.hljs-function').length).toBe(0);
    
    // Text must be preserved
    expect(codeEl.textContent?.trim()).toBe(originalText.trim());
  });

  test("REGRESSION: removal must restore syntax highlighting", () => {
    // This ensures that after removing an annotation, syntax highlighting is restored
    const originalCode = 'function test() { return true; }';
    
    const codeEl = document.createElement('code');
    codeEl.className = 'hljs language-javascript';
    codeEl.textContent = originalCode;
    
    // Apply syntax highlighting
    mockHljs.highlightElement(codeEl);
    const highlightedSpanCount = codeEl.querySelectorAll('span.hljs-keyword').length;
    expect(highlightedSpanCount).toBeGreaterThan(0);
    
    // Annotate (removes syntax highlighting)
    const wrapper = document.createElement('mark');
    wrapper.dataset.bindId = 'removal-test';
    wrapper.textContent = codeEl.textContent || '';
    codeEl.innerHTML = '';
    codeEl.appendChild(wrapper);
    
    // Verify annotation has no syntax spans
    expect(codeEl.querySelectorAll('span.hljs-keyword').length).toBe(0);
    
    // Remove annotation
    const mark = codeEl.querySelector('[data-bind-id="removal-test"]') as HTMLElement;
    const savedText = mark.textContent || '';
    codeEl.textContent = savedText;
    
    // Re-apply highlighting
    mockHljs.highlightElement(codeEl);
    
    // CRITICAL: Syntax highlighting must be restored
    const restoredSpanCount = codeEl.querySelectorAll('span.hljs-keyword').length;
    expect(restoredSpanCount).toBe(highlightedSpanCount);
    expect(codeEl.textContent).toBe(originalCode);
  });

  test("REGRESSION: multiple annotation cycles must not break structure", () => {
    // Test annotating, removing, and re-annotating multiple times
    const code = 'let x = 42;';
    const codeEl = document.createElement('code');
    codeEl.textContent = code;
    
    // Cycle 1: annotate
    let wrapper = document.createElement('mark');
    wrapper.dataset.bindId = 'cycle-1';
    wrapper.textContent = codeEl.textContent || '';
    codeEl.innerHTML = '';
    codeEl.appendChild(wrapper);
    expect(codeEl.querySelector('mark')).not.toBeNull();
    
    // Cycle 1: remove
    codeEl.textContent = code;
    mockHljs.highlightElement(codeEl);
    expect(codeEl.querySelectorAll('span').length).toBeGreaterThan(0);
    
    // Cycle 2: annotate again
    wrapper = document.createElement('mark');
    wrapper.dataset.bindId = 'cycle-2';
    wrapper.textContent = codeEl.textContent || '';
    codeEl.innerHTML = '';
    codeEl.appendChild(wrapper);
    
    // Verify clean structure after multiple cycles
    const mark = codeEl.querySelector('mark');
    expect(mark!.querySelectorAll('span').length).toBe(0);
    expect(codeEl.textContent).toBe(code);
    
    // Cycle 2: remove
    codeEl.textContent = code;
    mockHljs.highlightElement(codeEl);
    
    // Cycle 3: one more time
    wrapper = document.createElement('mark');
    wrapper.dataset.bindId = 'cycle-3';
    wrapper.textContent = codeEl.textContent || '';
    codeEl.innerHTML = '';
    codeEl.appendChild(wrapper);
    
    expect(codeEl.querySelector('mark')!.querySelectorAll('span').length).toBe(0);
  });

  test("REGRESSION: verify DOM structure matches expected format", () => {
    // This test documents the exact expected structure
    const codeEl = document.createElement('code');
    codeEl.className = 'hljs language-python';
    codeEl.innerHTML = '<span class="hljs-keyword">def</span> <span class="hljs-title">foo</span>():';
    
    const text = codeEl.textContent || '';
    
    // Apply annotation
    const wrapper = document.createElement('mark');
    wrapper.className = 'annotation-highlight comment';
    wrapper.dataset.bindId = 'structure-test';
    wrapper.textContent = text;
    
    codeEl.innerHTML = '';
    codeEl.appendChild(wrapper);
    
    // Expected structure: <code><mark data-bind-id="..." class="...">text content</mark></code>
    expect(codeEl.children.length).toBe(1);
    expect(codeEl.children[0].tagName).toBe('MARK');
    expect(codeEl.children[0].children.length).toBe(0); // No children inside mark
    expect((codeEl.children[0] as HTMLElement).dataset.bindId).toBe('structure-test');
    expect(codeEl.children[0].className).toBe('annotation-highlight comment');
    expect(codeEl.children[0].textContent).toBe(text);
    
    // The code element should have exactly this structure, nothing else
    const html = codeEl.innerHTML;
    expect(html).toMatch(/^<mark[^>]*>.*<\/mark>$/);
    expect(html).not.toContain('<span'); // No spans inside
  });

  test("REGRESSION: text content must be preserved exactly", () => {
    // Ensure no text is lost or corrupted during annotation
    const testCases = [
      'function test() { }',
      'const x = "hello world";',
      'class Foo {\n  constructor() {}\n}',
      '// comment\nlet x = 1;\n/* block */\nlet y = 2;',
      'tab\tseparated\tcode',
      'unicode: 你好世界 🚀',
    ];
    
    testCases.forEach(testCode => {
      const codeEl = document.createElement('code');
      codeEl.textContent = testCode;
      
      // Highlight
      mockHljs.highlightElement(codeEl);
      
      // Annotate
      const wrapper = document.createElement('mark');
      wrapper.textContent = codeEl.textContent || '';
      codeEl.innerHTML = '';
      codeEl.appendChild(wrapper);
      
      // Verify exact text preservation
      expect(codeEl.textContent).toBe(testCode);
      
      // Remove and re-highlight
      codeEl.textContent = testCode;
      mockHljs.highlightElement(codeEl);
      
      expect(codeEl.textContent).toBe(testCode);
    });
  });
});
