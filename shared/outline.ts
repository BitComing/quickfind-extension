/**
 * 大纲笔记的模型层：树结构、归一化、以及所有增删改查。
 *
 * 此前这约 260 行在内容脚本侧栏与选项页面板里各存一份，经比对除一行守卫外**逐字相同**，
 * 于是任何一处调整都要记得同步另一边——实际已经漏过：行缩进一边 18px 一边 24px，
 * 空态文案也不一致。这类「算得对不对」的规则必须只有一处实现。
 *
 * 这里只做纯数据变换：不碰 DOM、不读存储、不触发渲染。调用方传入当前 `state`，
 * 拿到「该聚焦哪个节点」之后自己决定怎么重绘——内容脚本用 ShadowRoot，选项页用 document。
 *
 * 与 shared/note-drag.ts 的分工一致：那边管指针，这边管数据，宿主只做适配。
 */

import type { NotesNode, NotesState } from './notes';

/** 一次变更之后，调用方需要知道的信息。 */
export interface OutlineChange {
  /** 变更是否真的发生（没变就不要重绘、不要记入撤销栈）。 */
  changed: boolean;
  /** 变更后应该聚焦的节点 id。 */
  focusId: string | null;
  /** 需要恢复的插入点位置，仅合并节点时用到。 */
  caret?: number | null;
}

const NO_CHANGE: OutlineChange = { changed: false, focusId: null };

/** 新建一份空笔记。 */
export function createEmptyNotes(): NotesState {
  const now = Date.now();
  return {
    version: 2,
    rootId: 'root',
    nodes: {
      root: { id: 'root', parentId: null, children: [], text: '', collapsed: false, completed: false, createdAt: now, updatedAt: now },
    },
    updatedAt: now,
  };
}

/**
 * 把存储里的原始数据收敛成可用的树。
 *
 * 会修三类坏数据：指向不存在父节点的孤儿、自指的环、以及声明了却不可达的节点——
 * 一律提到根下，保证返回的树一定完整可达。这是「唯一一处」实现，别在调用方再补一遍。
 */
export function normalizeNotes(raw: unknown): NotesState {
  const fallback = createEmptyNotes();
  const source = raw as { nodes?: Record<string, unknown>; updatedAt?: unknown } | null;
  if (!source || typeof source !== 'object' || !source.nodes || typeof source.nodes !== 'object') return fallback;
  const nodes: Record<string, NotesNode> = {};
  Object.entries(source.nodes).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const id = String(record.id || key);
    if (!id || id === 'root') return;
    const now = Date.now();
    const createdAt = Number(record.createdAt) || now;
    nodes[id] = {
      id,
      parentId: record.parentId == null ? 'root' : String(record.parentId),
      children: [],
      text: String(record.text || ''),
      collapsed: record.collapsed === true,
      completed: record.completed === true,
      createdAt,
      updatedAt: Number(record.updatedAt) || createdAt,
    };
  });
  const rootValue = (source.nodes.root && typeof source.nodes.root === 'object' ? source.nodes.root : {}) as Record<string, unknown>;
  const rootNow = Number(rootValue.updatedAt) || Date.now();
  nodes.root = {
    id: 'root', parentId: null, children: [], text: '', collapsed: false, completed: false,
    createdAt: Number(rootValue.createdAt) || rootNow, updatedAt: rootNow,
  };
  Object.values(nodes).forEach((node) => {
    if (node.id === 'root' || !nodes[node.parentId] || node.parentId === node.id) node.parentId = 'root';
  });
  const declaredChildren = new Map<string, string[]>(Object.keys(nodes).map((id) => [id, []]));
  Object.entries(source.nodes).forEach(([key, value]) => {
    const record = (value || {}) as Record<string, unknown>;
    const id = String(record.id || key);
    if (!nodes[id] || !Array.isArray(record.children)) return;
    const seen = new Set<string>();
    (record.children as unknown[]).map(String).forEach((childId) => {
      if (!nodes[childId] || nodes[childId].parentId !== id || seen.has(childId)) return;
      seen.add(childId);
      declaredChildren.get(id)!.push(childId);
    });
  });
  // 从根往下重建，带环保护。断裂或不可达的数据一律变成根级条目。
  const visited = new Set<string>(['root']);
  const attach = (parentId: string, trail = new Set<string>()): void => {
    const parent = nodes[parentId];
    if (!parent || trail.has(parentId)) return;
    const nextTrail = new Set(trail);
    nextTrail.add(parentId);
    (declaredChildren.get(parentId) || []).forEach((childId) => {
      if (visited.has(childId) || nextTrail.has(childId)) return;
      visited.add(childId);
      parent.children.push(childId);
      attach(childId, nextTrail);
    });
  };
  attach('root');
  Object.values(nodes).forEach((node) => {
    if (node.id === 'root' || visited.has(node.id)) return;
    node.parentId = 'root';
    nodes.root.children.push(node.id);
    visited.add(node.id);
    attach(node.id);
  });
  return { version: 2, rootId: 'root', nodes, updatedAt: Number(source.updatedAt) || Date.now() };
}

// ---------- 查询 ----------

export function noteById(state: NotesState, id: unknown): NotesNode | null {
  return state.nodes[String(id)] || null;
}

/** 节点相对 baseId 的层级深度。 */
export function noteDepth(state: NotesState, id: unknown, baseId = 'root'): number {
  let depth = 0;
  let node = noteById(state, id);
  const seen = new Set<string>();
  while (node && node.parentId && node.parentId !== baseId && !seen.has(node.id)) {
    seen.add(node.id);
    depth += 1;
    node = noteById(state, node.parentId);
  }
  return depth;
}

/** 从根到该节点的标题路径，用于面包屑。 */
export function notePath(state: NotesState, id: unknown): string[] {
  const path: string[] = [];
  let node = noteById(state, id);
  const seen = new Set<string>();
  while (node && node.id !== 'root' && !seen.has(node.id)) {
    path.unshift(node.text.trim() || '未命名项目');
    seen.add(node.id);
    node = noteById(state, node.parentId);
  }
  return path;
}

/** candidate 是否是 ancestor 的后代（自己不算自己的后代）。 */
export function isNoteDescendant(state: NotesState, candidateId: unknown, ancestorId: unknown): boolean {
  const ancestor = String(ancestorId);
  let node = noteById(state, candidateId);
  const seen = new Set<string>();
  while (node && node.parentId && !seen.has(node.id)) {
    if (node.parentId === ancestor) return true;
    seen.add(node.id);
    node = noteById(state, node.parentId);
  }
  return false;
}

function subtreeHasMatch(state: NotesState, id: string, query: string, matches: Set<string>, trail = new Set<string>()): boolean {
  const node = noteById(state, id);
  if (!node || trail.has(id)) return false;
  const nextTrail = new Set(trail);
  nextTrail.add(id);
  const ownMatch = !query || node.text.toLocaleLowerCase().includes(query);
  let childMatch = false;
  node.children.forEach((childId) => { if (subtreeHasMatch(state, childId, query, matches, nextTrail)) childMatch = true; });
  if (ownMatch || childMatch) matches.add(id);
  return ownMatch || childMatch;
}

/**
 * 在 scopeRootId 范围内，按折叠状态与搜索词算出要显示的行。
 *
 * 搜索时忽略折叠（`query` 为真时不看 collapsed），否则匹配到的项会被折叠挡住。
 */
export function visibleNoteIds(state: NotesState, scopeRootId: unknown, query: string): { ids: string[]; matching: Set<string>; scopeRoot: NotesNode } {
  const ids: string[] = [];
  const matching = new Set<string>();
  const scopeRoot = noteById(state, scopeRootId) || noteById(state, 'root')!;
  if (query) subtreeHasMatch(state, scopeRoot.id, query, matching);
  const walk = (parentId: string, trail = new Set<string>()): void => {
    const parent = noteById(state, parentId);
    if (!parent || trail.has(parentId)) return;
    const nextTrail = new Set(trail);
    nextTrail.add(parentId);
    parent.children.forEach((id) => {
      const node = noteById(state, id);
      if (!node || (query && !matching.has(id))) return;
      ids.push(id);
      if (!node.collapsed || query) walk(id, nextTrail);
    });
  };
  walk(scopeRoot.id);
  return { ids, matching, scopeRoot };
}

/** 搜索命中的项数：在 scope 内、文本命中、且不含 scope 自身。 */
export function countMatches(state: NotesState, scopeRootId: unknown, query: string): number {
  const lower = query.toLocaleLowerCase();
  const zoomId = String(scopeRootId);
  return Object.values(state.nodes).filter((node) => node.id !== 'root' && node.id !== zoomId
    && node.text.toLocaleLowerCase().includes(lower)
    && (zoomId === 'root' || isNoteDescendant(state, node.id, zoomId))).length;
}

// ---------- 变更 ----------

function makeNode(state: NotesState, parentId: string, text: string, newId: string): NotesNode {
  const now = Date.now();
  const node: NotesNode = { id: newId, parentId, children: [], text, collapsed: false, completed: false, createdAt: now, updatedAt: now };
  state.nodes[node.id] = node;
  return node;
}

/** 在 target 之前/之内/之后移动 source。 */
export function moveNote(state: NotesState, sourceId: string, targetId: string, placement: 'before' | 'inside' | 'after' = 'after'): OutlineChange {
  const source = noteById(state, sourceId);
  const target = noteById(state, targetId);
  if (!source || !target || sourceId === targetId || isNoteDescendant(state, targetId, sourceId)) return NO_CHANGE;
  const oldParent = noteById(state, source.parentId);
  if (!oldParent) return NO_CHANGE;
  oldParent.children = oldParent.children.filter((id) => id !== sourceId);
  let newParent: NotesNode | null;
  let index: number;
  if (placement === 'inside') {
    newParent = target;
    index = target.children.length;
    target.collapsed = false;
  } else {
    newParent = noteById(state, target.parentId) || noteById(state, 'root');
    index = newParent.children.indexOf(targetId) + (placement === 'after' ? 1 : 0);
  }
  if (!newParent || index < 0) return NO_CHANGE;
  source.parentId = newParent.id;
  source.updatedAt = Date.now();
  newParent.children.splice(Math.min(index, newParent.children.length), 0, sourceId);
  return { changed: true, focusId: sourceId };
}

/** 在 id 之后插入一个同级节点。 */
export function insertNoteAfter(state: NotesState, id: string, text: string, newId: string): OutlineChange {
  const current = noteById(state, id);
  if (!current) return NO_CHANGE;
  const parent = noteById(state, current.parentId) || noteById(state, 'root');
  if (!parent) return NO_CHANGE;
  const index = parent.children.indexOf(id);
  if (index < 0) return NO_CHANGE;
  const child = makeNode(state, parent.id, text, newId);
  parent.children.splice(index + 1, 0, child.id);
  return { changed: true, focusId: child.id };
}

/** 在 parentId 下追加一个子节点。 */
export function insertNoteChild(state: NotesState, parentId: string, text: string, newId: string): OutlineChange {
  const parent = noteById(state, parentId);
  if (!parent) return NO_CHANGE;
  const child = makeNode(state, parent.id, text, newId);
  parent.children.push(child.id);
  parent.collapsed = false;
  return { changed: true, focusId: child.id };
}

/** 删除节点，其子节点提升到父级同位置。 */
export function removeNote(state: NotesState, id: string): OutlineChange {
  const node = noteById(state, id);
  if (!node || id === 'root') return NO_CHANGE;
  const parent = noteById(state, node.parentId) || noteById(state, 'root');
  if (!parent) return NO_CHANGE;
  const index = parent.children.indexOf(id);
  if (index < 0) return NO_CHANGE;
  const promoted = [...node.children];
  promoted.forEach((childId) => {
    const child = noteById(state, childId);
    if (child) child.parentId = parent.id;
  });
  parent.children.splice(index, 1, ...promoted);
  delete state.nodes[id];
  const nextId = parent.children[Math.max(0, Math.min(index, parent.children.length - 1))] || parent.id;
  return { changed: true, focusId: nextId === 'root' ? null : nextId };
}

/** Tab / Shift+Tab：降级为前一个兄弟的子节点，或提升到祖父同级。 */
export function changeNoteIndent(state: NotesState, id: string, outdent: boolean): OutlineChange {
  const node = noteById(state, id);
  const parent = node && noteById(state, node.parentId);
  if (!node || !parent) return NO_CHANGE;
  if (!outdent) {
    const index = parent.children.indexOf(id);
    if (index <= 0) return NO_CHANGE;
    const previous = noteById(state, parent.children[index - 1]);
    if (!previous) return NO_CHANGE;
    parent.children.splice(index, 1);
    previous.children.push(id);
    previous.collapsed = false;
    node.parentId = previous.id;
  } else {
    if (parent.id === 'root') return NO_CHANGE;
    const grand = noteById(state, parent.parentId);
    if (!grand) return NO_CHANGE;
    parent.children = parent.children.filter((childId) => childId !== id);
    const index = grand.children.indexOf(parent.id);
    grand.children.splice(index + 1, 0, id);
    node.parentId = grand.id;
  }
  node.updatedAt = Date.now();
  return { changed: true, focusId: id };
}

/** 行首 Backspace：把本节点文本并入上一个兄弟。 */
export function mergeNoteWithPrevious(state: NotesState, id: string): OutlineChange {
  const node = noteById(state, id);
  const parent = node && noteById(state, node.parentId);
  if (!node || !parent) return NO_CHANGE;
  const index = parent.children.indexOf(id);
  if (index <= 0) return NO_CHANGE;
  const previous = noteById(state, parent.children[index - 1]);
  if (!previous) return NO_CHANGE;
  const joinAt = previous.text.length;
  previous.text += node.text;
  previous.updatedAt = Date.now();
  parent.children.splice(index, 1);
  node.children.forEach((childId) => {
    const child = noteById(state, childId);
    if (child) child.parentId = previous.id;
  });
  previous.children.push(...node.children);
  delete state.nodes[id];
  return { changed: true, focusId: previous.id, caret: joinAt };
}

/** 全部展开 / 收起（只影响有子节点的项）。 */
export function setAllNotesCollapsed(state: NotesState, collapsed: boolean): OutlineChange {
  Object.values(state.nodes).forEach((node) => {
    if (node.id !== 'root' && node.children.length) node.collapsed = collapsed;
  });
  return { changed: true, focusId: null };
}

// ---------- 导入导出 ----------

/** 导出为 Markdown 的行列表，缩进两空格一层。 */
export function notesToMarkdownLines(state: NotesState, parentId = 'root', depth = 0, lines: string[] = []): string[] {
  const parent = noteById(state, parentId);
  if (!parent) return lines;
  parent.children.forEach((id) => {
    const node = noteById(state, id);
    if (!node) return;
    lines.push('  '.repeat(depth) + '- ' + (node.completed ? '[x] ' : '') + node.text.replace(/\r?\n/g, ' '));
    notesToMarkdownLines(state, id, depth + 1, lines);
  });
  return lines;
}

/** 从 Markdown 大纲解析出笔记树，按缩进深度判断层级。 */
export function parseMarkdownNotes(text: unknown, makeId: () => string): NotesState {
  const state = createEmptyNotes();
  const stack: Array<{ depth: number; id: string }> = [{ depth: -1, id: 'root' }];
  String(text || '').split(/\r?\n/).forEach((line) => {
    if (!line.trim()) return;
    const match = line.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)?(.*)$/);
    if (!match || !match[2].trim()) return;
    const depth = Math.floor(match[1].replace(/\t/g, '  ').length / 2);
    const raw = match[2].trim();
    const completed = /^\[x\]\s+/i.test(raw);
    const value = raw.replace(/^\[[ xX]\]\s+/, '');
    while (stack.length && stack[stack.length - 1]!.depth >= depth) stack.pop();
    const parentNode = state.nodes[stack[stack.length - 1]?.id || 'root']!;
    const now = Date.now();
    const node: NotesNode = { id: makeId(), parentId: parentNode.id, children: [], text: value, collapsed: false, completed, createdAt: now, updatedAt: now };
    state.nodes[node.id] = node;
    parentNode.children.push(node.id);
    stack.push({ depth, id: node.id });
  });
  return state;
}