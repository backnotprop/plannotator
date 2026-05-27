import type { DiffFile } from '../types';

export interface FileTreeNode {
  type: 'file' | 'folder';
  name: string;
  path: string;
  depth: number;
  fileIndex?: number;
  file?: DiffFile;
  children?: FileTreeNode[];
  additions: number;
  deletions: number;
}

interface TrieNode {
  children: Map<string, TrieNode>;
  file?: { index: number; data: DiffFile };
}

function buildTrie(files: DiffFile[]): TrieNode {
  const root: TrieNode = { children: new Map() };

  for (let i = 0; i < files.length; i++) {
    const segments = files[i].path.split('/').filter(Boolean);
    let current = root;

    for (let j = 0; j < segments.length - 1; j++) {
      if (!current.children.has(segments[j])) {
        current.children.set(segments[j], { children: new Map() });
      }
      current = current.children.get(segments[j])!;
    }

    const fileName = segments[segments.length - 1];
    const leaf: TrieNode = { children: new Map(), file: { index: i, data: files[i] } };
    current.children.set(fileName, leaf);
  }

  return root;
}

function trieToNodes(trie: TrieNode, parentPath: string, depth: number): FileTreeNode[] {
  const folders: FileTreeNode[] = [];
  const fileNodes: FileTreeNode[] = [];

  for (const [name, child] of trie.children) {
    const fullPath = parentPath ? `${parentPath}/${name}` : name;

    if (child.file) {
      fileNodes.push({
        type: 'file',
        name,
        path: child.file.data.path,
        depth,
        fileIndex: child.file.index,
        file: child.file.data,
        additions: child.file.data.additions,
        deletions: child.file.data.deletions,
      });
    } else {
      const children = trieToNodes(child, fullPath, depth + 1);
      const additions = children.reduce((s, c) => s + c.additions, 0);
      const deletions = children.reduce((s, c) => s + c.deletions, 0);

      folders.push({
        type: 'folder',
        name,
        path: fullPath,
        depth,
        children,
        additions,
        deletions,
      });
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name));
  fileNodes.sort((a, b) => a.name.localeCompare(b.name));

  return [...folders, ...fileNodes];
}

function collapseSingleChild(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map(node => {
    if (node.type !== 'folder' || !node.children) return node;

    let current = node;
    while (
      current.children &&
      current.children.length === 1 &&
      current.children[0].type === 'folder'
    ) {
      const child = current.children[0];
      current = {
        ...child,
        name: `${current.name}/${child.name}`,
        depth: node.depth,
      };
    }

    return {
      ...current,
      children: current.children ? collapseSingleChild(fixDepths(current.children, node.depth + 1)) : undefined,
    };
  });
}

function fixDepths(nodes: FileTreeNode[], depth: number): FileTreeNode[] {
  return nodes.map(node => ({
    ...node,
    depth,
    children: node.children ? fixDepths(node.children, depth + 1) : undefined,
  }));
}

export function buildFileTree(files: DiffFile[]): FileTreeNode[] {
  if (files.length === 0) return [];

  const trie = buildTrie(files);
  let tree = trieToNodes(trie, '', 0);
  tree = collapseSingleChild(tree);

  // Flat fallback: if the tree is a single root folder with only file children, unwrap it
  if (
    tree.length === 1 &&
    tree[0].type === 'folder' &&
    tree[0].children?.every(c => c.type === 'file')
  ) {
    return fixDepths(tree[0].children!, 0);
  }

  return tree;
}

export function getAncestorPaths(filePath: string): string[] {
  const segments = filePath.split('/').filter(Boolean);
  const paths: string[] = [];
  for (let i = 1; i < segments.length; i++) {
    paths.push(segments.slice(0, i).join('/'));
  }
  return paths;
}

export function getVisualFileOrder(nodes: FileTreeNode[]): number[] {
  const order: number[] = [];
  for (const node of nodes) {
    if (node.type === 'file' && node.fileIndex != null) {
      order.push(node.fileIndex);
    } else if (node.children) {
      order.push(...getVisualFileOrder(node.children));
    }
  }
  return order;
}

export function getAllFolderPaths(nodes: FileTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.type === 'folder') {
      paths.push(node.path);
      if (node.children) {
        paths.push(...getAllFolderPaths(node.children));
      }
    }
  }
  return paths;
}
