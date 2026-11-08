/**
 * 存储形状 → 渲染形状的唯一实现。
 *
 * 背景：这条规则此前在五个地方各写了一份——popup 的 `normalize`、选项页的
 * `normalizeList`、内容脚本的 `getAvailableEngines` / `getPinnedEntries` /
 * `getPinnedGroupSources`。它们意图相同（把「存储里可能缺字段、可能是旧版本的配置」
 * 收敛成「界面可以直接渲染的 sources + groups」），但细节已经分叉：
 *
 *   - 分组入口的角标：浮层写 '群'，常驻栏写 '组'；
 *   - 分组名兜底：只有常驻栏有「未命名分组」；
 *   - 图标角标：选项页把 mark 截断到 2 字符，于是「360 搜索」在那里显示 '36'；
 *   - 默认组的条目不产出时，回落到 engineOrder 还是 sources，三处各不相同。
 *
 * 因此这里只做一次收敛，五个调用点全部改成调用本模块。**规则改动只改这里**；
 * 各入口只保留自己的 DOM 适配（shadow root / document），不再各自重算条目。
 *
 * 两种形状的约定与 shared/settings.ts 一致：
 *   `Stored*`  —— 存储里的原始形状，字段可能缺失、可能停在旧版本；
 *   返回的 `SearchSource` / `SearchGroup` —— 收敛后的形状，界面以此为准。
 */

import { BUILTIN_SOURCES, backfillBuiltinSources } from './builtins';
import { DEFAULT_GROUP_NAME } from './defaults';
import { normalizeLocale } from './i18n';
import { SPECIAL_ACTIONS } from './search-actions';
import type { ActionSettings, QuickFindSettings, RawGroup, SearchGroup, SearchSource, StoredSettings } from './settings';

const ACTION_PREFIX = 'action:';
const GROUP_PREFIX = 'group:';

/** 分组入口条目的角标。统一用 '组'：选项页的按钮文案、常驻栏此前用的都是它。 */
const GROUP_MARK = '组';

export function actionToken(id: unknown): string {
  return ACTION_PREFIX + String(id);
}

export function groupToken(id: unknown): string {
  return GROUP_PREFIX + String(id);
}

export function isActionToken(value: unknown): boolean {
  return String(value ?? '').startsWith(ACTION_PREFIX);
}

export function isGroupToken(value: unknown): boolean {
  return String(value ?? '').startsWith(GROUP_PREFIX);
}

/** 从 `group:<id>` / `action:<id>` 里取出 id；不是该前缀时返回 ''。 */
export function tokenId(token: unknown, prefix: string): string {
  const value = String(token ?? '');
  return value.startsWith(prefix) ? value.slice(prefix.length) : '';
}

/**
 * 把一个可能来自存储、可能残缺的源收敛成可渲染的源。
 *
 * 返回 null 表示这条记录根本不可用（没有 id / 名字 / 地址），调用方应当丢弃——
 * 保留它会在界面上留下一个点了没反应的图标。
 *
 * `mark` 刻意不截断：此前选项页截到 2 字符，「360 搜索」显示成 '36'，
 * 与浮层、弹窗显示的不一致。宽度交给 CSS 处理。
 */
export function cleanSource(value: unknown): SearchSource | null {
  const source = value as Partial<SearchSource> | null | undefined;
  if (!source || !source.id || !source.name) return null;
  if (!source.url && typeof source.buildUrl !== 'function') return null;
  const id = String(source.id);
  return {
    ...source,
    id,
    name: String(source.name),
    mark: String(source.mark || '?'),
    detail: String(source.detail || ''),
    url: source.url === undefined ? undefined : String(source.url),
    iconUrl: String(source.iconUrl || ''),
    className: source.className || (id.startsWith('custom-') ? 'custom' : id),
    enabled: source.enabled !== false,
    iconOnly: source.iconOnly === true,
  };
}

/**
 * 取「当前配置下的源列表」。
 *
 * 两种来源：
 *   1. 已迁移的配置（`sources` 非空，或 groups 里已有 default 组）——以 `sources` 为准；
 *   2. 旧版配置——按 `engines` / `iconOnly` 开关重建内置源，再接上 `customEngines`。
 *
 * 补源只在配置版本落后时进行（规则在 shared/builtins.ts），否则用户自己删掉的内置源
 * 会在下次打开任何一个入口时被悄悄加回来。
 */
export function configuredSources(stored: StoredSettings, builtins: SearchSource[] = BUILTIN_SOURCES): SearchSource[] {
  const rawGroups: RawGroup[] = Array.isArray(stored.groups) ? stored.groups : [];
  const configured = Array.isArray(stored.sources) && (stored.sources.length > 0 || rawGroups.some((group) => group?.id === 'default'));
  if (!configured) {
    const custom: SearchSource[] = Array.isArray(stored.customEngines) ? stored.customEngines : [];
    const rebuilt: SearchSource[] = builtins.map((source) => ({
      ...source,
      enabled: stored.engines?.[String(source.id)] !== false,
      iconOnly: stored.iconOnly?.[String(source.id)] === true,
    }));
    return rebuilt.concat(custom);
  }
  const sources = [...(stored.sources as SearchSource[])];
  backfillBuiltinSources(sources, stored.sourceConfigVersion, true, false);
  return sources;
}

/**
 * 特殊功能按钮的设置。只保留认识的动作 id，且只保留「与默认不同」的字段：
 * iconOnly 只存 true、enabled 只存 false、name 只存非空且与默认名不同的值。
 * 存进去的稀疏表越小，sync 的 8 KB 单键上限就越不容易被顶到。
 */
export function normalizeActionSettings(stored: StoredSettings): ActionSettings {
  const raw = stored.specialActions;
  if (!raw || typeof raw !== 'object') return {};
  const settings: ActionSettings = {};
  SPECIAL_ACTIONS.forEach((action) => {
    const value = (raw as Record<string, unknown>)[String(action.id)];
    if (!value || typeof value !== 'object') return;
    const entry: { iconOnly?: boolean; name?: string; enabled?: boolean } = {};
    if ((value as { iconOnly?: unknown }).iconOnly === true) entry.iconOnly = true;
    if ((value as { enabled?: unknown }).enabled === false) entry.enabled = false;
    const name = String((value as { name?: unknown }).name ?? '').trim().slice(0, 24);
    if (name && name !== String(action.name)) entry.name = name;
    if (Object.keys(entry).length) settings[String(action.id)] = entry;
  });
  return settings;
}

/**
 * 收敛 sources + groups。这是三个入口共用的那一步；额外字段（enabled、searchHistory、
 * pinned 等）由各入口自己补，它们不属于「搜索源与分组」这条规则。
 */
export function normalizeSearchConfig(stored: StoredSettings, builtins: SearchSource[] = BUILTIN_SOURCES): { sources: SearchSource[]; groups: SearchGroup[]; actions: ActionSettings } {
  const rawGroups: RawGroup[] = Array.isArray(stored.groups) ? stored.groups : [];

  // 去重按 id 取第一条：同一份存储里出现两条同 id 的源时，行为要可预测。
  const sources: SearchSource[] = [];
  const sourceMap = new Map<string, SearchSource>();
  configuredSources(stored, builtins).forEach((raw) => {
    const source = cleanSource(raw);
    if (!source || sourceMap.has(source.id)) return;
    sourceMap.set(source.id, source);
    sources.push(source);
  });

  const actions = new Set(SPECIAL_ACTIONS.map((action) => actionToken(action.id)));

  // 自定义分组：items 里只保留真实存在的源与动作，且一条条目只归属一个分组。
  const customGroups: SearchGroup[] = rawGroups
    .filter((group) => group && group.id && group.id !== 'default')
    .map((group) => ({
      id: String(group.id),
      name: String(group.name || '未命名分组'),
      items: [] as string[],
      visible: group.visible !== false && group.showInDefault !== false,
    }));
  const customIds = new Set(customGroups.map((group) => group.id));
  const assigned = new Set<string>();
  customGroups.forEach((group) => {
    const raw = rawGroups.find((item) => String(item?.id) === group.id);
    (raw?.items || raw?.sourceIds || []).map(String).forEach((id) => {
      if ((sourceMap.has(id) || actions.has(id)) && !assigned.has(id)) {
        group.items.push(id);
        assigned.add(id);
      }
    });
  });

  // 默认组的条目：先按存储里的顺序，再补 engineOrder 里没被列到的，最后补剩下的源与分组入口。
  // 这个顺序是三个入口原本各自实现里「并集」的部分，取并集不会丢条目。
  const rawDefault = rawGroups.find((group) => String(group?.id) === 'default');
  const storedItems: string[] = (rawDefault?.items || rawDefault?.sourceIds || []).map(String);
  const order: string[] = Array.isArray(stored.engineOrder) ? stored.engineOrder.map(String) : sources.map((source) => source.id);
  const defaultItems: string[] = [];
  const seen = new Set<string>();
  const push = (item: string) => {
    if (seen.has(item)) return;
    seen.add(item);
    defaultItems.push(item);
  };

  (storedItems.length ? storedItems : order).forEach((item) => {
    const validGroup = isGroupToken(item) && customIds.has(tokenId(item, GROUP_PREFIX));
    const validSource = sourceMap.has(item) && !assigned.has(item);
    const validAction = actions.has(item) && !assigned.has(item);
    if (validGroup || validSource || validAction) push(item);
  });
  order.forEach((id) => {
    if (sourceMap.has(id) && !assigned.has(id)) push(id);
  });
  sources.forEach((source) => {
    if (!assigned.has(source.id)) push(source.id);
  });
  customGroups.forEach((group) => push(groupToken(group.id)));

  const groups: SearchGroup[] = [
    { id: 'default', name: String(rawDefault?.name || DEFAULT_GROUP_NAME), items: defaultItems, visible: rawDefault?.visible !== false },
    ...customGroups,
  ];
  return { sources, groups, actions: normalizeActionSettings(stored) };
}

/** 收敛成弹窗 / 内容脚本直接渲染的整份设置。 */
export function normalizeSettings(stored: StoredSettings, builtins: SearchSource[] = BUILTIN_SOURCES): QuickFindSettings {
  const { sources, groups, actions } = normalizeSearchConfig(stored, builtins);
  return {
    enabled: stored.enabled !== false,
    sources,
    groups,
    actions,
    language: normalizeLocale(stored.language),
    searchHistory: Array.isArray(stored.searchHistory) ? stored.searchHistory : [],
  };
}

function groupEntry(group: SearchGroup): SearchSource {
  return {
    id: groupToken(group.id),
    groupId: group.id,
    name: group.name,
    mark: GROUP_MARK,
    className: 'group',
    isGroup: true,
  };
}

function actionEntry(token: string, actions: ActionSettings | undefined): SearchSource | null {
  const action = SPECIAL_ACTIONS.find((item) => item.id === tokenId(token, ACTION_PREFIX));
  if (!action) return null;
  // 仅图标、改名、停用都是动作自己的设置，和搜索源同名字段，渲染侧不必区分两者。
  const settings = actions?.[String(action.id)];
  const name = String(settings?.name || '').trim();
  return {
    ...action,
    // 改过名之后，默认名仍留在 shared/search-actions.ts 里：重置配置时能回到它。
    name: name || String(action.name),
    iconOnly: settings?.iconOnly === true,
    enabled: settings?.enabled !== false,
  };
}

/**
 * 把一个分组的 `items` 解析成可以直接渲染的条目列表。
 *
 * - `group:<id>` 只出现在默认组里，且目标分组必须同时可见、被允许出现在默认组；
 * - `action:<id>` 与源一样受 `enabled` 约束（在选项页里可以停用），停用后三个入口都不画它；
 * - 默认组整体隐藏时返回空列表——调用方据此不渲染列表。
 */
export function resolveGroupEntries(config: { sources: SearchSource[]; groups: SearchGroup[]; actions?: ActionSettings }, groupId = 'default'): SearchSource[] {
  const group = config.groups.find((item) => item.id === String(groupId));
  if (!group || group.visible === false) return [];
  const sourceMap = new Map(config.sources.map((source) => [source.id, source]));
  const entries: SearchSource[] = [];
  (group.items || []).forEach((token) => {
    if (isActionToken(token)) {
      const entry = actionEntry(token, config.actions);
      if (entry && entry.enabled !== false) entries.push(entry);
      return;
    }
    if (isGroupToken(token)) {
      if (group.id !== 'default') return;
      const target = config.groups.find((item) => item.id === tokenId(token, GROUP_PREFIX));
      if (target && target.visible !== false) entries.push(groupEntry(target));
      return;
    }
    const source = sourceMap.get(String(token));
    if (source && source.enabled !== false) entries.push(source);
  });
  return entries;
}