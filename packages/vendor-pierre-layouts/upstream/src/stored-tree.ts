import { naryTree } from './models/n-ary';
import type {
  ChildSize,
  Direction,
  LayoutNode,
  PaneNode,
  SplitNode,
  StackNode,
  StoredLayoutTree,
  TreeModel,
} from './types';

export class InvalidLayoutTreeError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'InvalidLayoutTreeError';
    this.path = path;
  }
}

const TREE_KEYS = new Set(['version', 'root']);
const PANE_KEYS = new Set([
  'type',
  'id',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'hidden',
  'collapsed',
  'collapsedSize',
]);
const STACK_KEYS = new Set([
  'type',
  'id',
  'children',
  'active',
  'collapsed',
  'collapsedSize',
]);
const SPLIT_KEYS = new Set(['type', 'id', 'direction', 'children', 'sizes']);

type Fields = Readonly<Record<string, unknown>>;

function fieldsOf(value: unknown, path: string, keys: Set<string>): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidLayoutTreeError(path, 'must be an object');
  for (const key of Object.keys(value)) {
    if (!keys.has(key))
      throw new InvalidLayoutTreeError(`${path}.${key}`, 'is not allowed');
  }
  return value as Fields;
}

function stringAt(fields: Fields, key: string, path: string): string {
  const value = fields[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new InvalidLayoutTreeError(
      `${path}.${key}`,
      'must be a non-empty string'
    );
  return value;
}

function optionalNumber(
  fields: Fields,
  key: string,
  path: string
): number | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new InvalidLayoutTreeError(
      `${path}.${key}`,
      'must be a finite number of 0 or more'
    );
  return value;
}

function optionalBoolean(
  fields: Fields,
  key: string,
  path: string
): boolean | undefined {
  const value = fields[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean')
    throw new InvalidLayoutTreeError(`${path}.${key}`, 'must be a boolean');
  return value;
}

function arrayAt(fields: Fields, key: string, path: string): unknown[] {
  const value = fields[key];
  if (!Array.isArray(value))
    throw new InvalidLayoutTreeError(`${path}.${key}`, 'must be an array');
  return value;
}

function withDefined<T extends object>(node: T): T {
  return Object.fromEntries(
    Object.entries(node).filter(([, value]) => value !== undefined)
  ) as T;
}

function parsePane(value: unknown, path: string): PaneNode {
  const fields = fieldsOf(value, path, PANE_KEYS);
  return withDefined<PaneNode>({
    type: 'pane',
    id: stringAt(fields, 'id', path),
    minWidth: optionalNumber(fields, 'minWidth', path),
    minHeight: optionalNumber(fields, 'minHeight', path),
    maxWidth: optionalNumber(fields, 'maxWidth', path),
    maxHeight: optionalNumber(fields, 'maxHeight', path),
    hidden: optionalBoolean(fields, 'hidden', path),
    collapsed: optionalBoolean(fields, 'collapsed', path),
    collapsedSize: optionalNumber(fields, 'collapsedSize', path),
  });
}

function parseStack(value: unknown, path: string): StackNode {
  const fields = fieldsOf(value, path, STACK_KEYS);
  const children = arrayAt(fields, 'children', path).map((child, index) => {
    const childPath = `${path}.children[${index}]`;
    if (child === null || typeof child !== 'object' || Array.isArray(child))
      throw new InvalidLayoutTreeError(childPath, 'must be an object');
    if ((child as Fields).type !== 'pane')
      throw new InvalidLayoutTreeError(
        `${childPath}.type`,
        'a stack holds panes only'
      );
    return parsePane(child, childPath);
  });
  return withDefined<StackNode>({
    type: 'stack',
    id: stringAt(fields, 'id', path),
    children,
    active: stringAt(fields, 'active', path),
    collapsed: optionalBoolean(fields, 'collapsed', path),
    collapsedSize: optionalNumber(fields, 'collapsedSize', path),
  });
}

function parseSize(value: unknown, path: string): ChildSize {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0)
      throw new InvalidLayoutTreeError(path, 'must be a positive weight');
    return value;
  }
  const fields = fieldsOf(value, path, new Set(['px']));
  const px = fields.px;
  if (typeof px !== 'number' || !Number.isFinite(px) || px < 0)
    throw new InvalidLayoutTreeError(
      `${path}.px`,
      'must be a finite number of 0 or more'
    );
  return { px };
}

function parseDirection(fields: Fields, path: string): Direction {
  const direction = fields.direction;
  if (direction !== 'horizontal' && direction !== 'vertical')
    throw new InvalidLayoutTreeError(
      `${path}.direction`,
      'must be "horizontal" or "vertical"'
    );
  return direction;
}

function parseSplit(value: unknown, path: string): SplitNode {
  const fields = fieldsOf(value, path, SPLIT_KEYS);
  return {
    type: 'split',
    id: stringAt(fields, 'id', path),
    direction: parseDirection(fields, path),
    children: arrayAt(fields, 'children', path).map((child, index) =>
      parseNode(child, `${path}.children[${index}]`)
    ),
    sizes: arrayAt(fields, 'sizes', path).map((size, index) =>
      parseSize(size, `${path}.sizes[${index}]`)
    ),
  };
}

function parseNode(value: unknown, path: string): LayoutNode {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new InvalidLayoutTreeError(path, 'must be an object');
  const type = (value as Fields).type;
  if (type === 'pane') return parsePane(value, path);
  if (type === 'stack') return parseStack(value, path);
  if (type === 'split') return parseSplit(value, path);
  throw new InvalidLayoutTreeError(
    `${path}.type`,
    'must be "pane", "stack", or "split"'
  );
}

/** Validate a tree read from storage, without importing DOM or window state. */
export function parseStoredLayoutTree(
  value: unknown,
  model: TreeModel = naryTree
): StoredLayoutTree {
  const fields = fieldsOf(value, 'tree', TREE_KEYS);
  if (fields.version !== 3)
    throw new InvalidLayoutTreeError('tree.version', 'must be 3');
  const root = parseNode(fields.root, 'tree.root');
  try {
    model.validate(root);
  } catch (error) {
    throw new InvalidLayoutTreeError(
      'tree.root',
      error instanceof Error ? error.message : String(error)
    );
  }
  return { version: 3, root };
}
