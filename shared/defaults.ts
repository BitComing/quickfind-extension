/**
 * 默认配置的唯一来源。
 *
 * 此前 content 的 `DEFAULT_SETTINGS` 与 options 的 `DEFAULTS` 各写一份，
 * 靠注释「改默认值请连同另一边一起改」维持同步——这种约定迟早会被漏掉一次。
 * 更麻烦的是两边的默认组名不一致（popup 兜底 '默认'、另两处 '默认组'），
 * 用户看到的标签取决于哪个入口先写入存储。现在只在这里声明。
 *
 * 默认值即作者当前在浏览器里使用的一套设置（搜索历史这类个人数据除外）。
 * 它只在「全新安装」时落地：存储里已有 sources/groups 或旧版 engines/iconOnly 的安装
 * 一律走版本迁移，不会被这里覆盖。见 options/main.ts 的 defaultConfigSeed。
 */

import { BUILTIN_SOURCES, BUILTIN_SOURCE_IDS, DEFAULT_ICON_ONLY_IDS, DEFAULT_PINNED_SITE_IDS, PINNED_SITE_CONFIG_VERSION } from './builtins';
import type { RawGroup, SearchSource } from './settings';

/** 全新安装时落地的搜索源：全部启用，其中常用的几个只显示图标。 */
export const DEFAULT_SOURCES: SearchSource[] = BUILTIN_SOURCES.map((source) => ({
  ...source,
  enabled: true,
  iconOnly: DEFAULT_ICON_ONLY_IDS.includes(String(source.id)),
}));

/** 默认分组的名字。popup 的 normalize 也用它兜底，避免入口之间出现两个名字。 */
export const DEFAULT_GROUP_NAME = '默认组';

/** 默认组先直排 4 个常用源，其余按主题收进 4 个分组。 */
export const DEFAULT_GROUPS: RawGroup[] = [
  { id: 'default', name: DEFAULT_GROUP_NAME, items: ['google', 'bing', 'yandex', 'zhihu', 'group:group-other', 'group:group-video', 'group:group-social', 'group:group-ai'], visible: true },
  { id: 'group-other', name: '其他', items: ['so', 'sogou', 'duckduckgo', 'baidu', 'google-scholar'], visible: true },
  { id: 'group-video', name: '视频', items: ['bilibili', 'youtube', 'douyin'], visible: true },
  { id: 'group-social', name: '社媒', items: ['xiaohongshu', 'x'], visible: true },
  { id: 'group-ai', name: 'ai', items: ['google-ai', 'doubao', 'deepseek'], visible: true },
];

/** 常驻搜索栏：默认在所有站点出现，展开后 1 秒自动收起。 */
export const DEFAULT_PINNED_SEARCH = {
  sites: DEFAULT_PINNED_SITE_IDS,
  customSites: [] as Array<{ id: string; name: string; url: string; selector?: string; categorySelectors?: string[] }>,
  defaultGroupCount: 4,
  collapseDelay: 1000,
  openInNewTab: false,
  allSites: true,
  siteConfigVersion: PINNED_SITE_CONFIG_VERSION,
};

/** LLM 对话的默认配置。 */
export const DEFAULT_LLM = {
  enabled: false,
  endpoint: 'https://api.openai.com/v1/chat/completions',
  model: 'gpt-4o-mini',
  apiKey: '',
  systemPrompt: '',
};

/** 全新安装的默认设置，对应存储里的各个 sync 键。 */
export const DEFAULT_SETTINGS = {
  enabled: true,
  engines: Object.fromEntries(BUILTIN_SOURCE_IDS.map((id): [string, boolean] => [id, true])),
  iconOnly: {} as Record<string, boolean>,
  customEngines: [] as SearchSource[],
  engineOrder: [...BUILTIN_SOURCE_IDS],
  sources: DEFAULT_SOURCES,
  groups: DEFAULT_GROUPS,
  pinnedSearch: DEFAULT_PINNED_SEARCH,
  searchHistory: [] as unknown[],
  llm: DEFAULT_LLM,
  triggerMode: 'click' as const,
  editableTriggerMode: 'none' as const,
  defaultGroupCount: 4,
  selectionTriggerDelay: 200,
  llmDockVisible: false,
};

/** 分组中一次最多直排多少个条目，超出部分进「更多」。 */
export const MAX_DEFAULT_GROUP_COUNT = 20;

/** 旧版键名：出现即说明这份配置来自迁移前的版本。 */
export const LEGACY_CONFIG_KEYS = ['engines', 'iconOnly', 'customEngines', 'engineOrder'];