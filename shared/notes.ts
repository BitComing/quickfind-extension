/**
 * 笔记的存储形状，以及「存到第一行」这一条写入规则。
 *
 * 完整的大纲修复（环、孤儿节点、旧版结构迁移）由设置页与页面侧栏各自的 normalize 负责，
 * 这里只补齐写入必需的结构，不要把它扩写成第三份 normalize。
 *
 * 常规路径是页面侧栏（内容脚本）持有着最新状态并落盘，本模块只在页面没有内容脚本时兜底
 * ——浏览器内置页、扩展页、PDF 查看器等，弹窗仍然要能把这枚按钮点得动。
 */

/** 与 content/index.ts 的 NOTES_KEY 一致。 */
export const NOTES_STORAGE_KEY = 'quickfind-notes';
/** 旧版侧栏笔记的键。迁移还没发生时不要写入，否则这里的空笔记会把待迁移的数据顶掉。 */
export const LEGACY_NOTES_STORAGE_KEY = 'quickfind-outline-notes';

/** 笔记节点，与各入口的 normalize 结果一致。 */
export interface NotesNode {
  id: string;
  parentId: string | null;
  children: string[];
  text: string;
  collapsed: boolean;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 存储里的笔记文档。 */
export interface NotesState {
  version: number;
  rootId: string;
  nodes: Record<string, NotesNode>;
  updatedAt: number;
}

/** 与侧栏一致：整段文字按行拆成条目，最多 60 行。 */
export function splitNotesLines(text: unknown): string[] {
  return String(text ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 60);
}

function emptyNotesState(): NotesState {
  const now = Date.now();
  return {
    version: 2,
    rootId: 'root',
    nodes: {
      root: { id: 'root', parentId: null, children: [], text: '', collapsed: false, completed: false, createdAt: now, updatedAt: now }
    },
    updatedAt: now
  };
}

/**
 * 把若干行按原顺序插到第一行，返回写回存储用的新状态。
 *
 * 存储里不是可识别的笔记形状时返回 null，调用方放弃这次写入——这份数据该由读它的
 * 一方去迁移或修复，这里硬写会把它覆盖掉。
 */
export function prependNotesLines(stored: unknown, lines: string[]): NotesState | null {
  if (!lines.length) return null;
  const source: Partial<NotesState> = stored && typeof stored === 'object' ? { ...(stored as Partial<NotesState>) } : {};
  const nodes = source.nodes;
  if (nodes !== undefined && (typeof nodes !== 'object' || nodes === null)) return null;
  if (nodes && nodes.root !== undefined && !Array.isArray(nodes.root.children)) return null;
  const next: NotesState = nodes && nodes.root
    ? { version: Number(source.version) || 2, rootId: 'root', nodes: { ...nodes }, updatedAt: Number(source.updatedAt) || Date.now() }
    : emptyNotesState();
  const root = next.nodes.root;
  if (!root) return null; // 空状态与上面校验过的副本都带 root，这里只是把不确定性收窄
  const now = Date.now();
  const created = lines.map((text, index): NotesNode => ({
    // 侧栏的 id 形如 note-<时间戳>-<自增序号>，这里带 p 前缀并加随机尾，避免与之撞号。
    id: `note-${now}-p${index}-${Math.random().toString(36).slice(2, 6)}`,
    parentId: 'root',
    children: [],
    text,
    collapsed: false,
    completed: false,
    createdAt: now,
    updatedAt: now
  }));
  created.forEach((node) => { next.nodes[node.id] = node; });
  root.children = created.map((node) => node.id).concat(root.children);
  next.updatedAt = now;
  return next;
}
