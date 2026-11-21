import type { Plugin } from 'vite';

const WASM_URL = 'new URL("web-tree-sitter.wasm", import.meta.url).href';

export function webTreeSitterServedWasm(): Plugin {
  return {
    name: 'web-tree-sitter-served-wasm',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]web-tree-sitter[\\/]web-tree-sitter\.js$/.test(id.split('?')[0]!)) return null;
      if (!code.includes(WASM_URL)) this.error('web-tree-sitter changed: its own wasm URL was not found');
      return { code: code.replace(WASM_URL, '"web-tree-sitter.wasm"'), map: null };
    },
  };
}
