/**
 * 内置搜索源的唯一来源，以及「旧配置补哪些新源」的唯一规则。
 *
 * 此前这份目录在三个入口各存了一份（popup 的 `builtins`、options 的 `BUILTINS`、
 * content 的 `ENGINES`），形状还分两种：popup/options 用 `url` 模板，content 用 `buildUrl`
 * 函数。补源集合也跟着各写一份，于是同一份旧配置在不同入口会补出不同的源——
 * content 判断 `sourceConfigVersion < 5` 时补 10 个，options 只补 6 个，popup 又是第三种写法。
 *
 * 现在只在这里声明一次，三个入口都从这里取。
 */

import type { SearchSource } from './settings';

/** 配置结构的版本号。新增内置源、改变分组形状时都要 +1，并同步下面的补源规则。 */
export const SOURCE_CONFIG_VERSION = 5;
/** 常驻搜索栏站点配置的版本号。 */
export const PINNED_SITE_CONFIG_VERSION = 3;

/**
 * 内置源的规范目录。
 *
 * 统一用 `url` 模板（含 `{query}` 占位符）而不是 `buildUrl` 函数：
 * 模板可以直接序列化进存储、也能被选项页当作字符串编辑，函数不行。
 * 需要动态拼装地址的源（如豆包）在 `getSearchUrl` 里单独处理。
 */
export const BUILTIN_SOURCES: SearchSource[] = [
  { id: 'google', name: '谷歌', detail: 'Google Search', mark: 'G', className: 'google', url: 'https://www.google.com/search?q={query}' },
  { id: 'baidu', name: '百度', detail: '百度搜索', mark: '百', className: 'baidu', url: 'https://www.baidu.com/s?wd={query}' },
  { id: 'google-scholar', name: '谷歌学术', detail: 'Google Scholar', mark: 'GS', className: 'google-scholar', url: 'https://scholar.google.com/scholar?q={query}' },
  { id: 'duckduckgo', name: 'DuckDuckGo', detail: 'Privacy Search', mark: 'D', className: 'duckduckgo', url: 'https://duckduckgo.com/?q={query}' },
  { id: 'so', name: '360 搜索', detail: '360 Search', mark: '360', className: 'so', url: 'https://www.so.com/s?q={query}' },
  { id: 'sogou', name: '搜狗', detail: '搜狗搜索', mark: '搜', className: 'sogou', url: 'https://www.sogou.com/web?query={query}' },
  { id: 'bing', name: 'Bing', detail: 'Microsoft Search', mark: 'b', className: 'bing', url: 'https://www.bing.com/search?q={query}' },
  { id: 'yandex', name: 'Yandex', detail: 'Search', mark: 'Я', className: 'yandex', url: 'https://yandex.com/search/?text={query}' },
  { id: 'google-ai', name: 'Google AI Mode', detail: 'Google AI Mode', mark: 'AI', className: 'google-ai', url: 'https://www.google.com/search?q={query}&udm=50' },
  { id: 'bilibili', name: '哔哩哔哩', detail: '视频搜索', mark: 'B', className: 'bilibili', url: 'https://search.bilibili.com/all?keyword={query}' },
  { id: 'xiaohongshu', name: '小红书', detail: '内容搜索', mark: '红', className: 'xiaohongshu', url: 'https://www.xiaohongshu.com/search_result?keyword={query}' },
  { id: 'x', name: 'X', detail: 'X Search', mark: 'X', className: 'x', url: 'https://x.com/search?q={query}' },
  { id: 'youtube', name: 'YouTube', detail: '视频搜索', mark: '▶', className: 'youtube', url: 'https://www.youtube.com/results?search_query={query}' },
  { id: 'zhihu', name: '知乎', detail: '知乎搜索', mark: '知', className: 'zhihu', url: 'https://www.zhihu.com/search?type=content&q={query}' },
  { id: 'douyin', name: '抖音', detail: '抖音搜索', mark: '抖', className: 'douyin', url: 'https://www.douyin.com/search/{query}?type=general' },
  { id: 'doubao', name: '豆包', detail: '打开新对话并填入内容', mark: '豆', className: 'doubao', url: 'https://www.doubao.com/chat/?quickfind={query}' },
  { id: 'deepseek', name: 'DeepSeek', detail: 'AI 对话搜索', mark: 'DS', className: 'deepseek', url: 'https://chat.deepseek.com/?q={query}' },
];

export const BUILTIN_SOURCE_IDS: string[] = BUILTIN_SOURCES.map((source) => String(source.id));

/**
 * 补源规则里「无条件补齐」的那几个：它们是被静默加进来的，旧配置普遍缺。
 * 注意：这里用的是「迁移时才补」，不是「每次缺了就补」——见 backfillBuiltinSources。
 */
export const ALWAYS_BACKFILL_IDS: string[] = ['google-ai', 'xiaohongshu', 'doubao', 'deepseek'];

/**
 * 引入版本号（SOURCE_CONFIG_VERSION）时新增的源。
 * 把这 6 个无差别地补进已有配置，会让老用户的分组里凭空多出一批条目。
 */
export const VERSION_BACKFILL_IDS: string[] = ['baidu', 'google-scholar', 'duckduckgo', 'so', 'sogou', 'douyin'];

/** 常驻搜索栏默认支持的站点，决定 DEFAULT_PINNED_SEARCH.sites 的初始值。 */
export const DEFAULT_PINNED_SITE_IDS: string[] = ['google', 'baidu', 'google-scholar', 'duckduckgo', 'so', 'sogou', 'bing', 'yandex', 'zhihu', 'bilibili', 'douyin'];

/** 只在列表里显示图标的内置源，默认值用它，名字交给悬浮提示。 */
export const DEFAULT_ICON_ONLY_IDS: string[] = ['google', 'baidu', 'google-scholar', 'duckduckgo', 'so', 'bing', 'yandex', 'bilibili', 'xiaohongshu', 'youtube', 'zhihu'];

/** 按 id 查内置源。找不到时返回 null，调用方不必再各自 find。 */
export function builtinSourceById(id: unknown): SearchSource | null {
  const key = String(id ?? '');
  return BUILTIN_SOURCES.find((source) => source.id === key) || null;
}

/**
 * 迁移旧配置时补齐缺失的内置源，返回实际补进去的 id。
 *
 * 只在 `version < SOURCE_CONFIG_VERSION` 时动作，这是一条刻意的边界：
 * 版本已是最新的配置说明迁移早就跑完了，此时还缺某个内置源，只可能是用户自己删的——
 * 再补回来等于删不掉。此前 popup 不分版本地补 google-ai 等 4 个，就属于这种情况；
 * 三个入口统一到「只在迁移时补」之后，删除内置源的行为在哪个入口都保持一致。
 *
 * `version` 由调用方传入而不是在这里读存储，这样它是纯函数，三个入口能共用同一份判断。
 */
export function backfillBuiltinSources(sources: SearchSource[], version: unknown, enabled = true, iconOnly = false): string[] {
  if (!(Number(version) < SOURCE_CONFIG_VERSION)) return [];
  const present = new Set(sources.map((source) => String(source?.id)));
  const missing = [...ALWAYS_BACKFILL_IDS, ...VERSION_BACKFILL_IDS];
  const added: string[] = [];
  missing.forEach((id) => {
    if (present.has(id)) return;
    const source = builtinSourceById(id);
    if (!source) return;
    sources.push({ ...source, enabled, iconOnly });
    present.add(id);
    added.push(id);
  });
  return added;
}