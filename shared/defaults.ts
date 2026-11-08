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
import type { RawGroup, SearchSource, StoredSettings } from './settings';

/** 默认分组的名字。popup 的 normalize 也用它兜底，避免入口之间出现两个名字。 */
export const DEFAULT_GROUP_NAME = '默认组';

/**
 * 默认组直排 4 个常用源（小红书、Bing、知乎、哔哩哔哩），另有一个「视频」分组放抖音。
 *
 * 未出现在这里的内置源不会丢：归一化时，未归组的源会被追加到默认组末尾；
 * 它们默认不启用，而渲染侧只画启用的源（resolveGroupEntries），所以全新安装看到的就是
 * 这 4 个源加一个「视频」分组入口。
 */
export const DEFAULT_GROUPS: RawGroup[] = [
  { id: 'default', name: DEFAULT_GROUP_NAME, items: ['xiaohongshu', 'bing', 'zhihu', 'bilibili', 'group:group-video'], visible: true },
  { id: 'group-video', name: '视频', items: ['douyin'], visible: true },
];

/**
 * 全新安装时启用的搜索源 id：默认分组里列出的全部源（含子分组里的）。
 *
 * 其余内置源照旧留在 `BUILTIN_SOURCES` 里，只是默认不启用——全新安装先给一组常用的，
 * 用户在「搜索源与分组」里逐个打开即可。免费版的 20 个上限按已启用的源计数（见 license.ts），
 * 所以没启用的内置源不占名额。
 */
export const DEFAULT_ENABLED_IDS: string[] = [...new Set(DEFAULT_GROUPS.flatMap((group) => (group.items || [])
  .map(String)
  .filter((item) => !item.startsWith('group:'))))];

/** 全新安装时落地的搜索源：目录全保留，只有 DEFAULT_ENABLED_IDS 里的是启用的。 */
export const DEFAULT_SOURCES: SearchSource[] = BUILTIN_SOURCES.map((source) => ({
  ...source,
  enabled: DEFAULT_ENABLED_IDS.includes(String(source.id)),
  iconOnly: DEFAULT_ICON_ONLY_IDS.includes(String(source.id)),
}));

/** 常驻搜索栏：默认在所有站点出现，展开后 0.25 秒自动收起、在新标签页打开。 */
export const DEFAULT_PINNED_SEARCH = {
  sites: DEFAULT_PINNED_SITE_IDS,
  customSites: [] as Array<{ id: string; name: string; url: string; selector?: string; categorySelectors?: string[] }>,
  defaultGroupCount: 10,
  collapseDelay: 250,
  openInNewTab: true,
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
  /** 界面语言，见 shared/i18n.ts。 */
  language: 'zh-CN',
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
  defaultGroupCount: 10,
  selectionTriggerDelay: 200,
  llmDockVisible: false,
};

/** 分组中一次最多直排多少个条目，超出部分进「更多」。 */
export const MAX_DEFAULT_GROUP_COUNT = 20;

/** 旧版键名：出现即说明这份配置来自迁移前的版本。 */
export const LEGACY_CONFIG_KEYS = ['engines', 'iconOnly', 'customEngines', 'engineOrder'];

/**
 * 全新安装时该落地的配置：存储里既没有 sources/groups，也没有旧版痕迹时返回默认值。
 *
 * 已有配置一律走版本迁移，默认值只在「真的什么都没有」时注入——否则会把老安装的
 * engines/iconOnly 开关冲掉。选项页与弹窗读取存储时都过这一条判据，保证两个入口
 * 在「用户还没打开过设置」时看到的默认配置是同一份（曾有入口在空存储上把内置源全部启用）。
 */
export function freshInstallSeed(stored: StoredSettings | null | undefined): { sources?: SearchSource[]; groups?: RawGroup[] } {
  const raw = stored || {};
  const groups = Array.isArray(raw.groups) ? raw.groups : [];
  const sources = Array.isArray(raw.sources) ? raw.sources : [];
  const hasConfiguredList = sources.length > 0 || groups.some((group) => group?.id === 'default');
  const hasLegacy = LEGACY_CONFIG_KEYS.some((key) => Object.prototype.hasOwnProperty.call(raw, key));
  return hasConfiguredList || hasLegacy ? {} : { sources: DEFAULT_SOURCES, groups: DEFAULT_GROUPS };
}