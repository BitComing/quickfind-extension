/**
 * QuickFind 共享领域类型。
 *
 * popup / options / content 三个入口操作的是同一份存储数据（设置、搜索源、分组、历史），
 * 此前这些结构只存在于运行时代码里，没有任何地方声明过，于是每个入口各自推断，
 * 互相之间没有约束。这里集中声明一次。
 *
 * 本文件只含类型，编译后不产生任何运行时产物，不参与扩展的工作方式。
 *
 * 约定：`Raw*` 前缀代表「存储里的原始形状」，字段可能缺失或停留在旧版本；
 * 无前缀的接口代表「收敛之后的形状」，界面渲染以它为准。
 */

/** 搜索源。内置源、自定义源、分组入口、特殊动作共用同一形状。 */
export interface SearchSource {
  id: string;
  name: string;
  /** 副标题，如 “Google Search”。 */
  detail?: string;
  /** 没有图标时显示的短标记。 */
  mark?: string;
  /** 图标样式类名，对应 style.css 中的颜色。 */
  className?: string;
  /** 静态搜索地址，含 `{query}` 占位符。 */
  url?: string;
  /** 需要动态拼装地址时替代 url。 */
  buildUrl?: (query: string) => string;
  /** 是否出现在搜索列表中。 */
  enabled?: boolean;
  /** 在分组中只显示图标。 */
  iconOnly?: boolean;
  /** 自定义源的自备图标。 */
  iconUrl?: string;
  /** 该条目代表一个分组入口，点击后切换到 groupId 指定的分组。 */
  isGroup?: boolean;
  groupId?: string;
  /** 特殊动作条目（当前只有「复制」）。 */
  isSpecial?: boolean;
  action?: string;
}

/** 分组。items 是有序的条目引用：源 id、`group:<id>` 或 `action:<id>`。 */
export interface SearchGroup {
  id: string;
  name: string;
  items: string[];
  /** 是否出现在分组标签栏。 */
  visible?: boolean;
  /** 是否同时出现在默认分组的列表中。 */
  showInDefault?: boolean;
}

/** 存储中的分组记录，字段可能缺失，需经 normalize 收敛为 SearchGroup。 */
export interface RawGroup {
  id?: unknown;
  name?: unknown;
  items?: unknown[];
  /** 早期版本的字段名，读取语义与 items 相同。 */
  sourceIds?: unknown[];
  visible?: boolean;
  showInDefault?: boolean;
}

/** 历史记录条目。 */
export interface HistoryEntry {
  query: string;
  timestamp?: number;
}

/** 早期版本把历史直接存成字符串数组，两种形状都要能读。 */
export type HistoryItem = string | HistoryEntry;

/** normalize 之后的设置，界面渲染以此为准。 */
export interface QuickFindSettings {
  enabled: boolean;
  sources: SearchSource[];
  groups: SearchGroup[];
  searchHistory: HistoryItem[];
}

/** 存储中的原始设置，所有字段都可能缺失或停留在旧版本形状。 */
export interface StoredSettings {
  enabled?: boolean;
  /** 内置源的启用状态，键为源 id。 */
  engines?: Record<string, boolean | undefined>;
  iconOnly?: Record<string, boolean | undefined>;
  customEngines?: SearchSource[];
  /** 搜索源配置的迁移版本号，用于补齐新增的内置源。 */
  sourceConfigVersion?: number;
  /** 默认分组中条目的排列顺序。 */
  engineOrder?: unknown[];
  sources?: SearchSource[];
  groups?: RawGroup[];
  searchHistory?: HistoryItem[];
}
