// Parser setup and per-language knowledge: what a function is, where its
// statements live, what a call and a return look like.
import { Language, Parser, type Node, type Tree } from 'web-tree-sitter';
import { currentSetup, resolveInNode, rule } from './runtime.ts';

import type { LanguageId } from './languages.ts';
export { languageForPath, type LanguageId } from './languages.ts';

/** Comment node types across grammars (Rust splits line and block comments). */
export const COMMENT_TYPES: ReadonlySet<string> = new Set(['comment', 'line_comment', 'block_comment']);
export const isComment = (n: Node | null | undefined) => !!n && COMMENT_TYPES.has(n.type);

export interface LanguageConfig {
  id: LanguageId;
  /** The grammar's package path, e.g. `tree-sitter-go/tree-sitter-go.wasm` (see `configure`). */
  wasm: string;
  /** Node types that declare a named function or method. */
  functionTypes: ReadonlySet<string>;
  callType: string;
  /** Node types that hold a list of statements. */
  blockTypes: ReadonlySet<string>;
  /** The statement returns from the function (`last`: it is the body's final statement, for tail expressions). */
  isReturn(stmt: Node, last: boolean): boolean;
  /** The function's name, or null for anonymous functions. */
  nameOf(fn: Node): string | null;
  /** The block node holding the function's statements. */
  bodyOf(fn: Node): Node | null;
  /** Statements directly inside a block. */
  statementsOf(block: Node): Node[];
  /** The callee name of a call expression, e.g. `foo` for `a.foo(x)`. */
  calleeOf(call: Node): string | null;
  /** The expression a return statement returns, if any. */
  returnValueOf(ret: Node): Node | null;
  /** Leaf node types that are names (variables, fields, types). */
  identifierTypes: ReadonlySet<string>;
  /**
   * Named declarations directly inside `container` (the file, or a class body),
   * with the node to treat as the whole declaration and, for classes, the body
   * that holds its members.
   */
  declarationsIn(container: Node): Declaration[];
  /**
   * Node types that hold the lines just above a declaration and belong to it:
   * comments, and attributes such as Rust's `#[derive(..)]`.
   */
  attachedTypes: ReadonlySet<string>;
}

/**
 * Imports are declarations too, named by what they import (the module path), so
 * re-sorted imports pair up and show as moved rather than deleted and re-added.
 * Adding a language's imports takes only the key: the text of its module path.
 */
export const importDeclaration = (node: Node, key: string, prefix = ''): Declaration => ({
  node,
  kind: 'import',
  name: prefix + unquote(key).replace(/\s+/g, ''),
});
const unquote = (s: string) => s.replace(/^(['"`])(.*)\1$/, '$2');

export interface Declaration {
  node: Node;
  kind: string;
  name: string;
  members?: Node;
}

/** The expression body of a one-line arrow function (`(x) => x + 1`). */
const FUNCTION_VALUE = /^(arrow_function|function_expression|function|generator_function)$/;

/**
 * The function an Effect constructor wraps: the first function argument of `X.gen(...)`,
 * `X.fn(...)`, `X.fnUntraced(...)` or `X.suspend(...)`, also when the name comes first
 * (`Effect.fn("load")(function* () {...})`). Null for any other call.
 */
function effectFunction(call: Node): Node | null {
  const callee = call.childForFieldName('function');
  const wraps = (c: Node | null | undefined) => c?.type === 'member_expression' && /^(gen|fn|fnUntraced|suspend)$/.test(c.childForFieldName('property')?.text ?? '');
  if (!wraps(callee) && !(callee?.type === 'call_expression' && wraps(callee.childForFieldName('function')))) return null;
  for (const a of call.childForFieldName('arguments')?.namedChildren ?? []) if (a && FUNCTION_VALUE.test(a.type)) return a;
  return null;
}

/**
 * A top-level constant made by handing a function to a factory is that function:
 * `export const withRetry = dual(2, (self, n) => {...})`,
 * `export const view = makeView((model, h) => ...)`, `const subs = Subscription.make<M>()((entry) => ...)`.
 * Only at module level, only when the function is the last argument, and never for collection or
 * promise methods (`const rows = items.map((x) => ...)` holds a value, not a function).
 */
const VALUE_METHODS = /^(map|flatMap|filter|reduce|reduceRight|forEach|find|findIndex|findLast|some|every|sort|toSorted|then|catch|finally|from|all|race|any|allSettled|keys|values|entries|fromEntries|assign|freeze|of|pipe|setTimeout|setInterval|queueMicrotask|describe|it|test|beforeEach|afterEach|beforeAll|afterAll|computed|watch|effect)$/;
function factoryFunction(decl: Node, call: Node): Node | null {
  if (!rule('FACTORY_FUNCTIONS')) return null;
  const statement = decl.parent?.type === 'lexical_declaration' || decl.parent?.type === 'variable_declaration' ? decl.parent : null;
  const top = statement?.parent?.type === 'export_statement' ? statement.parent.parent : statement?.parent;
  if (top?.type !== 'program') return null;
  let callee = call.childForFieldName('function');
  // `make<M>()((entry) => ...)`: the factory is the inner call.
  while (callee?.type === 'call_expression') callee = callee.childForFieldName('function');
  const name = callee?.type === 'member_expression' ? callee.childForFieldName('property')?.text : callee?.text;
  if (!name || VALUE_METHODS.test(name)) return null;
  const args = call.childForFieldName('arguments')?.namedChildren.filter((a): a is Node => !!a && !isComment(a)) ?? [];
  const last = args.at(-1);
  return last && FUNCTION_VALUE.test(last.type) ? last : null;
}

const isArrowExpressionBody =(n: Node) => n.type !== 'statement_block' && n.parent?.type === 'arrow_function' && n.parent.childForFieldName('body')?.id === n.id;

const tsLike = (id: 'typescript' | 'tsx', file: string): LanguageConfig => ({
  id,
  wasm: `tree-sitter-typescript/${file}`,
  // `const f = () => { ... }`, class fields and object properties holding arrow
  // functions (`perform: (elements) => { ... }`) are functions too.
  functionTypes: new Set(['function_declaration', 'method_definition', 'generator_function_declaration', 'variable_declarator', 'public_field_definition', 'pair']),
  callType: 'call_expression',
  blockTypes: new Set(['statement_block']),
  // A one-line arrow (`const f = (x) => x.a + 1`) returns its expression body.
  isReturn: (s, last) => s.type === 'return_statement' || (!!last && isArrowExpressionBody(s)),
  // Decorators above a class member (`@Get(':id')`) belong to it, like a doc comment.
  attachedTypes: new Set(['comment', 'decorator']),
  nameOf: (fn) => (fn.type === 'pair' ? (fn.childForFieldName('key')?.text.replace(/^['"]|['"]$/g, '') ?? null) : (fn.childForFieldName('name')?.text ?? null)),
  bodyOf: (fn) => {
    let value = fn.childForFieldName('value');
    // A function handed to a wrapper is still this one: `const Row = memo((props) => {...})`,
    // `const save = useCallback(async () => {...}, [deps])`, `forwardRef(function X() {...})`.
    // Only wrappers that define a function: `items.map((x) => ...)` holds a value, not a function.
    if (value?.type === 'call_expression' && /^(React\.)?(memo|forwardRef|useCallback|observer)$/.test(value.childForFieldName('function')?.text ?? '')) {
      const first = value.childForFieldName('arguments')?.namedChild(0);
      value = first && FUNCTION_VALUE.test(first.type) ? first : value;
    }
    // Effect defines functions the same way: `const load = Effect.gen(function* () {...})`,
    // `Effect.fn("load")(function* (id) {...})`, `Effect.suspend(() => ...)`.
    if (value?.type === 'call_expression') value = effectFunction(value) ?? value;
    if (value?.type === 'call_expression' && fn.type === 'variable_declarator') value = factoryFunction(fn, value) ?? value;
    if (fn.type === 'variable_declarator' || fn.type === 'public_field_definition' || fn.type === 'pair') {
      if (!value || !FUNCTION_VALUE.test(value.type)) return null;
      const body = value.childForFieldName('body');
      return body?.type === 'statement_block' || (body && value.type === 'arrow_function') ? body : null;
    }
    return fn.childForFieldName('body');
  },
  statementsOf: (block) => (isArrowExpressionBody(block) ? [block] : block.namedChildren.filter((n): n is Node => n !== null && !isComment(n))),
  calleeOf: (call) => {
    const f = call.childForFieldName('function');
    if (!f) return null;
    return f.type === 'member_expression' ? (f.childForFieldName('property')?.text ?? null) : f.text;
  },
  returnValueOf: (ret) => (isArrowExpressionBody(ret) ? ret : (ret.namedChildren.find((n) => n !== null && n.type !== 'comment') ?? null)),
  identifierTypes: new Set(['identifier', 'property_identifier', 'type_identifier', 'shorthand_property_identifier', 'private_property_identifier']),
  declarationsIn: (container) => {
    const out: Declaration[] = [];
    for (const child of container.namedChildren) {
      if (!child || child.type === 'comment') continue;
      if (child.type === 'import_statement') {
        // `import type { X } from 'm'` and `import { Y } from 'm'` are different imports.
        const source = child.childForFieldName('source');
        const type = child.children.some((c) => c?.type === 'type') ? 'type ' : '';
        if (source) out.push(importDeclaration(child, source.text, type));
        continue;
      }
      // Re-exports (`export { a } from 'm'`, `export * from 'm'`) are imports too.
      const reexport = child.type === 'export_statement' && !child.childForFieldName('declaration') ? child.childForFieldName('source') : null;
      if (reexport) {
        out.push({ ...importDeclaration(child, reexport.text), kind: 'export-from' });
        continue;
      }
      // `export ...` wraps the declaration; the whole statement is the entity.
      const decl = child.type === 'export_statement' ? (child.childForFieldName('declaration') ?? child) : child;
      let name = decl.childForFieldName('name')?.text ?? null;
      if (!name && (decl.type === 'lexical_declaration' || decl.type === 'variable_declaration')) {
        name = decl.namedChildren.find((n) => n?.type === 'variable_declarator')?.childForFieldName('name')?.text ?? null;
      }
      if (!name) continue;
      const body = decl.childForFieldName('body');
      // Namespaces (`namespace N { ... }`) hold declarations like a class body does.
      const members = body && (body.type === 'class_body' || body.type === 'interface_body' || (body.type === 'statement_block' && /module/.test(decl.type))) ? body : undefined;
      out.push({ node: child, kind: decl.type, name, members });
    }
    return out;
  },
});


/** Rust items that declare one named thing; `impl` and `use` are handled on their own. */
const RUST_ITEMS = new Set([
  'function_item', 'function_signature_item', 'struct_item', 'enum_item', 'union_item', 'trait_item', 'mod_item',
  'const_item', 'static_item', 'type_item', 'macro_definition', 'extern_crate_declaration',
]);
/** A Rust expression as the last thing in a block is the block's value (a return without `return`). */
const RUST_NOT_TAIL = new Set(['let_declaration', 'expression_statement', 'empty_statement', 'macro_definition', 'attribute_item', 'inner_attribute_item']);

const rust: LanguageConfig = {
  id: 'rust',
  wasm: 'tree-sitter-rust/tree-sitter-rust.wasm',
  functionTypes: new Set(['function_item']),
  callType: 'call_expression',
  blockTypes: new Set(['block']),
  isReturn: (s, last) =>
    (s.type === 'expression_statement' && s.namedChild(0)?.type === 'return_expression') ||
    s.type === 'return_expression' ||
    (last && !RUST_NOT_TAIL.has(s.type) && !s.type.endsWith('_item')),
  attachedTypes: new Set(['line_comment', 'block_comment', 'attribute_item']),
  nameOf: (fn) => fn.childForFieldName('name')?.text ?? null,
  bodyOf: (fn) => fn.childForFieldName('body'),
  statementsOf: (block) => block.namedChildren.filter((n): n is Node => n !== null && !isComment(n) && n.type !== 'label'),
  calleeOf: (call) => {
    let f = call.childForFieldName('function');
    if (f?.type === 'generic_function') f = f.childForFieldName('function');
    if (!f) return null;
    if (f.type === 'field_expression') return f.childForFieldName('field')?.text ?? null;
    if (f.type === 'scoped_identifier') return f.childForFieldName('name')?.text ?? null;
    return f.text;
  },
  returnValueOf: (ret) => {
    const r = ret.type === 'expression_statement' ? ret.namedChild(0) : ret;
    if (r?.type === 'return_expression') return r.namedChildren.find((n) => n !== null && !isComment(n)) ?? null;
    return r;
  },
  identifierTypes: new Set(['identifier', 'field_identifier', 'type_identifier', 'shorthand_field_identifier']),
  declarationsIn: (container) => {
    const out: Declaration[] = [];
    for (const child of container.namedChildren) {
      if (!child || isComment(child)) continue;
      if (child.type === 'use_declaration') {
        // `use a::b::{C, D}` is keyed by its path (`a::b`), so re-sorting the braces is an edit of one import.
        const arg = child.childForFieldName('argument');
        const key = arg?.type === 'scoped_use_list' ? (arg.childForFieldName('path')?.text ?? arg.text) + '::{}' : arg?.text;
        if (key) out.push(importDeclaration(child, key));
      } else if (child.type === 'impl_item') {
        // `impl Trait for Type` and `impl Type` are named by what they implement.
        const type = child.childForFieldName('type')?.text ?? '';
        const trait = child.childForFieldName('trait')?.text;
        const body = child.childForFieldName('body') ?? undefined;
        out.push({ node: child, kind: child.type, name: (trait ? `${trait} for ${type}` : type).replace(/\s+/g, ''), members: body });
      } else if (RUST_ITEMS.has(child.type)) {
        const name = child.childForFieldName('name')?.text;
        const body = child.childForFieldName('body');
        const members = body?.type === 'declaration_list' ? body : undefined;
        if (name) out.push({ node: child, kind: child.type, name, members });
      }
    }
    return out;
  },
};

/** Top-level-ish declarations shared by the C-family configs below: kind, name, and a body holding members. */
const named = (node: Node, kind = node.type, name = node.childForFieldName('name')?.text): Declaration | null => {
  if (!name) return null;
  const body = node.childForFieldName('body');
  // Python class bodies are plain `block`s, like function bodies: only a class's block holds members.
  const holds = body && (MEMBER_BODIES.has(body.type) || (body.type === 'block' && node.type === 'class_definition'));
  return { node, kind, name, members: holds ? body : undefined };
};
const MEMBER_BODIES = new Set([
  'class_body', 'interface_body', 'enum_body', 'annotation_type_body', // Java
  'declaration_list', // C# and Rust
]);
/** The first declared variable's name in a field or variable declaration. */
const firstDeclarator = (n: Node): string | undefined => {
  const walk = (x: Node): Node | null => {
    if (x.type === 'variable_declarator') return x;
    for (const c of x.namedChildren) {
      const r = c && walk(c);
      if (r) return r;
    }
    return null;
  };
  const d = walk(n);
  return (d?.childForFieldName('name') ?? d?.namedChild(0))?.text;
};
const withoutKeyword = (text: string, keyword: string) => text.replace(new RegExp(`^\\s*(global\\s+)?${keyword}\\s+`), '').replace(/;\s*$/, '');

const python: LanguageConfig = {
  id: 'python',
  wasm: 'tree-sitter-python/tree-sitter-python.wasm',
  functionTypes: new Set(['function_definition']),
  callType: 'call',
  blockTypes: new Set(['block']),
  isReturn: (s) => s.type === 'return_statement',
  attachedTypes: new Set(['comment']),
  nameOf: (fn) => fn.childForFieldName('name')?.text ?? null,
  bodyOf: (fn) => fn.childForFieldName('body'),
  statementsOf: (block) => block.namedChildren.filter((n): n is Node => n !== null && !isComment(n)),
  calleeOf: (call) => {
    const f = call.childForFieldName('function');
    if (!f) return null;
    return f.type === 'attribute' ? (f.childForFieldName('attribute')?.text ?? null) : f.text;
  },
  returnValueOf: (ret) => ret.namedChildren.find((n) => n !== null && !isComment(n)) ?? null,
  identifierTypes: new Set(['identifier']),
  declarationsIn: (container) => {
    const out: Declaration[] = [];
    for (const child of container.namedChildren) {
      if (!child || isComment(child)) continue;
      if (child.type === 'import_statement') {
        // `import a, b.c` is keyed by what it names.
        out.push(importDeclaration(child, child.namedChildren.map((n) => n?.text ?? '').join(',')));
      } else if (child.type === 'import_from_statement') {
        const module = child.childForFieldName('module_name')?.text;
        if (module) out.push(importDeclaration(child, module, 'from '));
      } else if (child.type === 'function_definition' || child.type === 'class_definition') {
        const d = named(child);
        if (d) out.push(d);
      } else if (child.type === 'decorated_definition') {
        // The decorators belong to the definition: the whole thing is the entity.
        const def = child.childForFieldName('definition');
        const d = def && named(def);
        if (d) out.push({ ...d, node: child });
      } else if (child.type === 'expression_statement' && child.namedChild(0)?.type === 'assignment') {
        // Module and class constants: `NAME = ...`.
        const left = child.namedChild(0)!.childForFieldName('left');
        if (left?.type === 'identifier') out.push({ node: child, kind: 'assignment', name: left.text });
      }
    }
    return out;
  },
};

const java: LanguageConfig = {
  id: 'java',
  wasm: 'tree-sitter-java/tree-sitter-java.wasm',
  functionTypes: new Set(['method_declaration', 'constructor_declaration']),
  callType: 'method_invocation',
  blockTypes: new Set(['block', 'constructor_body']),
  isReturn: (s) => s.type === 'return_statement',
  attachedTypes: new Set(['line_comment', 'block_comment']),
  nameOf: (fn) => fn.childForFieldName('name')?.text ?? null,
  bodyOf: (fn) => fn.childForFieldName('body'),
  statementsOf: (block) => block.namedChildren.filter((n): n is Node => n !== null && !isComment(n)),
  calleeOf: (call) => call.childForFieldName('name')?.text ?? null,
  returnValueOf: (ret) => ret.namedChildren.find((n) => n !== null && !isComment(n)) ?? null,
  identifierTypes: new Set(['identifier', 'type_identifier']),
  declarationsIn: (container) => {
    const out: Declaration[] = [];
    // An enum's methods and fields sit after its constants, in their own node.
    const children = container.namedChildren.flatMap((c) => (c?.type === 'enum_body_declarations' ? c.namedChildren : [c]));
    for (const child of children) {
      if (!child || isComment(child)) continue;
      if (child.type === 'import_declaration') out.push(importDeclaration(child, withoutKeyword(child.text, 'import')));
      else if (child.type === 'field_declaration' || child.type === 'constant_declaration') {
        const name = firstDeclarator(child);
        if (name) out.push({ node: child, kind: 'field_declaration', name });
      } else if (child.type.endsWith('_declaration') && child.type !== 'package_declaration') {
        const d = named(child);
        if (d) out.push(d);
      }
    }
    return out;
  },
};

const csharp: LanguageConfig = {
  id: 'csharp',
  wasm: 'tree-sitter-c-sharp/tree-sitter-c_sharp.wasm',
  functionTypes: new Set(['method_declaration', 'constructor_declaration', 'local_function_statement']),
  callType: 'invocation_expression',
  blockTypes: new Set(['block']),
  // An expression-bodied member (`int F(int x) => x + 1;`) returns its expression, like a
  // one-line arrow in TypeScript: code pulled out into one is a single value moved.
  isReturn: (s, last) => s.type === 'return_statement' || (!!last && s.type === 'arrow_expression_clause'),
  attachedTypes: new Set(['comment']),
  nameOf: (fn) => fn.childForFieldName('name')?.text ?? null,
  bodyOf: (fn) => {
    const b = fn.childForFieldName('body');
    return b?.type === 'block' || b?.type === 'arrow_expression_clause' ? b : null;
  },
  statementsOf: (block) => (block.type === 'arrow_expression_clause' ? [block] : block.namedChildren.filter((n): n is Node => n !== null && !isComment(n))),
  calleeOf: (call) => {
    let f = call.childForFieldName('function');
    if (f?.type === 'member_access_expression') f = f.childForFieldName('name');
    if (f?.type === 'generic_name') f = f.namedChild(0);
    return f?.text ?? null;
  },
  returnValueOf: (ret) => ret.namedChildren.find((n) => n !== null && !isComment(n)) ?? null, // `=> x` holds x too
  identifierTypes: new Set(['identifier']),
  declarationsIn: (container) => {
    const out: Declaration[] = [];
    for (const child of container.namedChildren) {
      if (!child || isComment(child)) continue;
      if (child.type === 'using_directive') out.push(importDeclaration(child, withoutKeyword(child.text, 'using')));
      else if (child.type === 'field_declaration' || child.type === 'event_field_declaration') {
        const name = firstDeclarator(child);
        if (name) out.push({ node: child, kind: 'field_declaration', name });
      } else if (child.type.endsWith('_declaration') && child.type !== 'file_scoped_namespace_declaration') {
        const d = named(child);
        if (d) out.push(d);
      }
    }
    return out;
  },
};

export const LANGUAGES: Record<LanguageId, LanguageConfig> = {
  go: {
    id: 'go',
    wasm: 'tree-sitter-go/tree-sitter-go.wasm',
    functionTypes: new Set(['function_declaration', 'method_declaration']),
    callType: 'call_expression',
    blockTypes: new Set(['block']),
    isReturn: (s) => s.type === 'return_statement',
    attachedTypes: new Set(['comment']),
    nameOf: (fn) => fn.childForFieldName('name')?.text ?? null,
    bodyOf: (fn) => fn.childForFieldName('body'),
    statementsOf: (block) => {
      const list = block.namedChildren.find((n) => n?.type === 'statement_list');
      const holder = list ?? block;
      return holder.namedChildren.filter((n): n is Node => n !== null && n.type !== 'comment');
    },
    calleeOf: (call) => {
      const f = call.childForFieldName('function');
      if (!f) return null;
      return f.type === 'selector_expression' ? (f.childForFieldName('field')?.text ?? null) : f.text;
    },
    returnValueOf: (ret) => {
      const list = ret.namedChildren.find((n) => n?.type === 'expression_list');
      // A single returned value: unwrap the expression list.
      if (list && list.namedChildCount === 1) return list.namedChild(0);
      return list ?? null;
    },
    identifierTypes: new Set(['identifier', 'field_identifier', 'type_identifier', 'package_identifier']),
    declarationsIn: (container) => {
      const out: Declaration[] = [];
      for (const child of container.namedChildren) {
        if (!child || child.type === 'comment') continue;
        if (child.type === 'import_declaration') {
          // Each spec is its own import, whether grouped in `import ( ... )` or not.
          const list = child.namedChildren.find((n) => n?.type === 'import_spec_list') ?? child;
          for (const spec of list.namedChildren) {
            const path = spec?.type === 'import_spec' ? spec.childForFieldName('path') : null;
            if (spec && path) out.push(importDeclaration(spec, path.text));
          }
        } else if (child.type === 'function_declaration') {
          const name = child.childForFieldName('name')?.text;
          if (name) out.push({ node: child, kind: child.type, name });
        } else if (child.type === 'method_declaration') {
          // Methods are keyed by receiver type too: (T).Name.
          const recv = child.childForFieldName('receiver')?.text ?? '';
          const name = child.childForFieldName('name')?.text;
          if (name) out.push({ node: child, kind: child.type, name: `${recv.replace(/^\(\s*\w+\s+/, '(')}.${name}` });
        } else if (['type_declaration', 'const_declaration', 'var_declaration'].includes(child.type)) {
          const spec = child.namedChildren.find((n) => n?.type.endsWith('_spec'));
          const name = spec?.childForFieldName('name')?.text ?? spec?.namedChild(0)?.text;
          if (name) out.push({ node: child, kind: child.type, name });
        }
      }
      return out;
    },
  },
  typescript: tsLike('typescript', 'tree-sitter-typescript.wasm'),
  tsx: tsLike('tsx', 'tree-sitter-tsx.wasm'),
  rust,
  python,
  java,
  csharp,
};


let ready: Promise<void> | null = null;
const loaded = new Map<LanguageId, Language>();

export async function getParser(id: LanguageId): Promise<Parser> {
  const setup = currentSetup();
  ready ??= Parser.init(setup.locateRuntime ? { locateFile: setup.locateRuntime } : undefined);
  await ready;
  let lang = loaded.get(id);
  if (!lang) {
    const file = LANGUAGES[id].wasm;
    const source = setup.locateGrammar ? await setup.locateGrammar(file, id) : await resolveInNode(file);
    lang = await Language.load(source instanceof URL ? source.href : source);
    loaded.set(id, lang);
  }
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

/** Parse both versions, run `fn`, and always free the trees (they live in WASM memory). */
export async function withTrees<T>(
  id: LanguageId,
  oldText: string,
  newText: string,
  fn: (oldTree: Tree, newTree: Tree) => T
): Promise<T> {
  const parser = await getParser(id);
  const a = parser.parse(oldText);
  const b = parser.parse(newText);
  if (!a || !b) throw new Error('parse failed');
  try {
    return fn(a, b);
  } finally {
    a.delete();
    b.delete();
    parser.delete();
  }
}
