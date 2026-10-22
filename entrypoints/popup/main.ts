/**
 * 弹窗入口。
 *
 * 类型来自 shared/settings.ts。本次改动只补标注、不调整运行时逻辑：
 * 类型层面无法证明非空的位置保留断言并用注释写明依据，不引入默认值或提前返回，
 * 以免在迁移过程中改变行为。
 */

import type {
  HistoryItem,
  QuickFindSettings,
  RawGroup,
  SearchGroup,
  SearchSource,
  StoredSettings,
} from '@/shared/settings';
import { SPECIAL_ACTIONS } from '@/shared/search-actions';
import { LEGACY_NOTES_STORAGE_KEY, NOTES_STORAGE_KEY, prependNotesLines, splitNotesLines } from '@/shared/notes';
import { BUILTIN_SOURCES, backfillBuiltinSources } from '@/shared/builtins';
import { DEFAULT_GROUP_NAME, DEFAULT_SETTINGS } from '@/shared/defaults';
import { decodeQueryText } from '@/shared/query-text';

(function () {
  'use strict';

  const builtins: SearchSource[] = BUILTIN_SOURCES;
  // 传给 chrome.storage.sync.get 的默认值：既是键集合也提供缺省值，因此需要索引签名。
  const defaults: StoredSettings & Record<string, unknown> = {
    ...DEFAULT_SETTINGS,
    sources: [],
    groups: [],
    searchHistory: [],
  };
  const POPUP_CACHE_KEY = 'quickfind-popup-cache';
  // 以下 7 个元素在 popup/index.html 中固定存在，查询结果必然非空。
  const queryInput = document.querySelector<HTMLInputElement>('#query-input')!;
  const clearQuery = document.querySelector<HTMLButtonElement>('#clear-query')!;
  const historyToggle = document.querySelector<HTMLButtonElement>('#history-toggle')!;
  const historyList = document.querySelector<HTMLDivElement>('#history-list')!;
  const groupTabs = document.querySelector<HTMLElement>('#group-tabs')!;
  const engineSettings = document.querySelector<HTMLDivElement>('#engine-settings')!;
  const openOptions = document.querySelector<HTMLButtonElement>('#open-options')!;
  const aiToggle = document.querySelector<HTMLButtonElement>('#ai-toggle')!;
  // 由 render() 首次赋值。所有读取都发生在渲染之后的交互或异步回调中。
  let settings!: QuickFindSettings;
  let activeGroupId = 'default';
  let draggedGroupId: string | null = null;
  let historyOpen = false;
  let queryEditedSinceOpen = false;

  function normalize(value: StoredSettings): QuickFindSettings {
    const rawGroups: RawGroup[] = Array.isArray(value.groups) ? value.groups : [];
    const configured = Array.isArray(value.sources) && (value.sources.length || rawGroups.some((group) => group.id === 'default'));
    // configured 为真时 value.sources 必然是数组，此处断言只表达这一前提。
    const rawSources: SearchSource[] = configured ? [...value.sources!] : builtins.map((source): SearchSource => ({ ...source,
    enabled: value.engines?.[source.id] !== false, iconOnly: value.iconOnly?.[source.id] === true })).concat(Array.isArray(value.customEngines) ? value.customEngines : []);
    if (configured) {
      // 补源规则与另两个入口共用一份（shared/builtins.ts）：只在配置版本落后时补，
      // 否则用户自己删掉的内置源会在打开弹窗后被悄悄加回来。
      backfillBuiltinSources(rawSources, value.sourceConfigVersion, true, false);
    }
    const sources: SearchSource[] = rawSources.filter((source) => source && source.id && source.name && (source.url || source.buildUrl)).map((source) => ({ ...source,
    id: String(source.id), className: source.className || (String(source.id).startsWith('custom-') ? 'custom' : String(source.id)) }));
    const sourceMap = new Map<string, SearchSource>(sources.map((source): [string, SearchSource] => [source.id, source]));
    const actionTokens = new Set(SPECIAL_ACTIONS.map((action) => 'action:' + action.id));
    const oldDefault = rawGroups.find((group) => group.id === 'default');
    const customGroups: SearchGroup[] = rawGroups.filter((group) => group && group.id && group.id !== 'default')
      .map((group) => ({ id: String(group.id), name: String(group.name || '未命名分组'), items: [], visible: group.visible !== false && group.showInDefault !== false }));
    const customIds = new Set(customGroups.map((group) => group.id));
    const assigned = new Set<string>();
    customGroups.forEach((group) => {
      const rawGroup = rawGroups.find((item) => String(item?.id) === group.id);
      (rawGroup?.items || rawGroup?.sourceIds || []).map(String).forEach((id) => {
        if ((sourceMap.has(id) || actionTokens.has(id)) && !assigned.has(id)) { group.items.push(id); assigned.add(id); }
      });
    });
    const order: string[] = Array.isArray(value.engineOrder) ? value.engineOrder.map(String) : sources.map((source) => source.id);
    const defaultItems: string[] = [];
    const seen = new Set<string>();
    (oldDefault?.items || oldDefault?.sourceIds || order).map(String).forEach((item) => {
      const validGroup = item.startsWith('group:') && customIds.has(item.slice(6));
      const validSource = sourceMap.has(item) && !assigned.has(item);
      const validAction = actionTokens.has(item) && !assigned.has(item);
      if ((validGroup || validSource || validAction) && !seen.has(item)) { defaultItems.push(item); seen.add(item); }
    });
    sources.forEach((source) => { if (!assigned.has(source.id) && !seen.has(source.id)) { defaultItems.push(source.id); seen.add(source.id); } });
    customGroups.forEach((group) => { const token = 'group:' + group.id; if (!seen.has(token)) defaultItems.push(token); });
    const groups: SearchGroup[] = [{ id: 'default', name: String(oldDefault?.name || DEFAULT_GROUP_NAME), items: defaultItems, visible: oldDefault?.visible !== false }, ...customGroups];
    return { enabled: value.enabled !== false, sources, groups, searchHistory: Array.isArray(value.searchHistory) ? value.searchHistory : [] };
  }

  function getGroupSources(group: { id?: string; items: string[] }): SearchSource[] {
    const sourceMap = new Map<string, SearchSource>(settings.sources.map((source): [string, SearchSource] => [source.id, source]));
    const sources: SearchSource[] = [];
    group.items.forEach((id) => {
      if (group.id === 'default' && String(id).startsWith('group:')) {
        const customGroup = settings.groups.find((item) => item.id === String(id).slice(6));
        if (customGroup && customGroup.visible !== false && customGroup.showInDefault !== false) sources.push({ id: 'group:' + customGroup.id,
        groupId: customGroup.id, name: customGroup.name, mark: '群', className: 'group', isGroup: true });
        return;
      }
      if (String(id).startsWith('action:')) {
        const action = SPECIAL_ACTIONS.find((item) => item.id === String(id).slice(7));
        if (action) sources.push({ ...action, id: String(id) });
        return;
      }
      const source = sourceMap.get(id);
      if (source && source.enabled !== false) sources.push(source);
    });
    return sources;
  }
  // normalize 已保证每个源至少具备 url 或 buildUrl 之一，走 url 分支时它必然存在。
  function getSearchUrl(source: SearchSource, query: string): string { if (source.id === 'doubao') return `https://www.doubao.com/chat/?quickfind=${encodeURIComponent(query)}`;
  return typeof source.buildUrl === 'function' ? source.buildUrl(query) : source.url!.replace(/\{query\}/gi, encodeURIComponent(query)); }
  async function copyTextToClipboard(text: string): Promise<boolean> {
    const value = String(text || '');
    if (!value) return false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); return true; } catch { /* use the legacy fallback */ }
    }
    const textarea = document.createElement('textarea');
    textarea.value = value; textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.append(textarea);
    try { textarea.select(); return document.execCommand('copy'); }
    catch { return false; }
    finally { textarea.remove(); }
  }
  /**
   * 特殊功能按钮「笔记」：把搜索框里的内容存到无限大纲笔记第一行。
   * 笔记的最新状态在页面侧栏手里，优先交给它写；页面没有内容脚本时（浏览器内置页、
   * 扩展页、PDF 查看器等）直接写存储兜底，两条路径都不会把内容丢掉。
   */
  function saveQueryToNotes(): void {
    const text = queryInput.value.trim();
    if (!text) return;
    if (!chrome.tabs?.query) { void prependNoteLocally(text); return; }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab?.id) { void prependNoteLocally(text); return; }
      chrome.tabs.sendMessage(tab.id, { type: 'save-note', text }, { frameId: 0 }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) void prependNoteLocally(text);
      });
    });
  }

  const AI_PANEL_UNSUPPORTED = '当前页面无法显示对话窗口，请在普通网页上使用。';

  /**
   * 把当前页面的 AI 对话交出去，由页面侧在网页中弹出一个对话窗口。
   *
   * `text` 是**显式传入**的，不再默认取搜索框内容：头部按钮要的是空白对话，
   * 而「问 ai」按钮行要的是拿搜索内容去提问——两处语义不同，由调用方各自决定，
   * 避免「默认带上搜索框」这种隐式行为让其中一个入口变成另一个。
   * 空字符串时页面侧只开窗口、不发送（见 content/index.ts 的 askAiFromAction）。
   */
  function openAiOnPage(text: string): void {
    if (!chrome.tabs?.query) { showPopupNotice(AI_PANEL_UNSUPPORTED); return; }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab?.id) { showPopupNotice(AI_PANEL_UNSUPPORTED); return; }
      // frameId: 0 —— 对话窗口是整页级 UI，只由顶层框架承载。
      chrome.tabs.sendMessage(tab.id, { type: 'ask-ai', text }, { frameId: 0 }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) { showPopupNotice(AI_PANEL_UNSUPPORTED); return; }
        // 对话已经在页面上打开，弹窗的使命结束。
        window.close();
      });
    });
  }

  /** 弹窗里的临时提示条：用完即撤，不占位、不写存储。 */
  let popupNoticeTimer: number | null = null;
  function showPopupNotice(message: string): void {
    const notice = document.getElementById('popup-notice');
    if (!notice) return;
    notice.textContent = message;
    notice.hidden = false;
    if (popupNoticeTimer) window.clearTimeout(popupNoticeTimer);
    popupNoticeTimer = window.setTimeout(() => { notice.hidden = true; popupNoticeTimer = null; }, 3200);
  }

  /** 兜底写入：取存储里最新的副本，把内容插到第一行再写回。 */
  async function prependNoteLocally(text: string): Promise<boolean> {
    const lines = splitNotesLines(text);
    if (!lines.length) return false;
    const stored = await new Promise<Record<string, unknown>>((resolve) => {
      chrome.storage.local.get([NOTES_STORAGE_KEY, LEGACY_NOTES_STORAGE_KEY], (value) => resolve(value || {}));
    });
    // 旧版笔记还没迁移完时不写：那份数组由设置页和侧栏负责搬迁，这里插进去会让它再也看不到。
    if (stored[LEGACY_NOTES_STORAGE_KEY]) return false;
    const next = prependNotesLines(stored[NOTES_STORAGE_KEY], lines);
    if (!next) return false;
    return new Promise<boolean>((resolve) => chrome.storage.local.set({ [NOTES_STORAGE_KEY]: next }, () => resolve(true)));
  }

  function savePopupCache(value: unknown) { chrome.storage.session?.set({ [POPUP_CACHE_KEY]: value }); }
  function rememberSearch(query: string) { const normalized = decodeQueryText(query).replace(/\s+/g, ' ').trim(); if (!normalized) return; const history = settings.searchHistory.map((item) => typeof item === 'string' ? { query: item } : item).filter((item) => item && item.query && item.query !== normalized); history.unshift({ query: normalized, timestamp: Date.now() }); settings.searchHistory = history.slice(0, 20); chrome.storage.sync.set({ searchHistory: settings.searchHistory }); savePopupCache(settings); }
  function focusAndSelectQuery() { queryInput.focus({ preventScroll: true }); queryInput.select(); }
  function submitSearch(source: SearchSource) { if (!settings.enabled) return focusAndSelectQuery();
  const query = queryInput.value.trim(); if (!query) return focusAndSelectQuery();
  rememberSearch(query); const url = getSearchUrl(source, query);
  // active:true——新标签必须自动切过去。此前是 active:false：结果在后台打开，
  // 弹窗一关用户还停在原来那一页，观感就是「点了搜索没反应」。
  // 新标签被激活后弹窗会自动关闭，所以这里不再需要把焦点抢回输入框。
  if (chrome.tabs?.create) { chrome.tabs.create({ url, active: true }, () => { void chrome.runtime.lastError; }); return; }
  window.open(url, '_blank', 'noopener,noreferrer'); }
  function reorderGroups(sourceId: string, targetId: string, after: boolean) {
    if (sourceId === 'default' || targetId === 'default' || sourceId === targetId) return;
    const sourceIndex = settings.groups.findIndex((group) => group.id === sourceId);
    if (sourceIndex < 0 || !settings.groups.some((group) => group.id === targetId)) return;
    const [moving] = settings.groups.splice(sourceIndex, 1);
    const targetIndex = settings.groups.findIndex((group) => group.id === targetId);
    settings.groups.splice(targetIndex + (after ? 1 : 0), 0, moving!);
    chrome.storage.sync.set({ groups: settings.groups });
    savePopupCache(settings);
    render(settings);
  }
  function render(current: QuickFindSettings) {
    settings = current;
    const visibleGroups = settings.groups.filter((group) => group.visible !== false);
    if (!visibleGroups.length) visibleGroups.push(settings.groups[0]!); if (!visibleGroups.some((group) => group.id === activeGroupId)) activeGroupId = visibleGroups[0]?.id || 'default';
    groupTabs.replaceChildren(); visibleGroups.forEach((group) => {
      const tab = document.createElement('button');
      tab.type = 'button'; tab.className = `group-tab${group.id === activeGroupId ? ' active' : ''}`;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(group.id === activeGroupId)); tab.textContent = group.name;
      tab.draggable = group.id !== 'default';
      tab.title = group.id === 'default' ? '默认分组' : `切换到${group.name}，拖动标签可调整分组顺序`;
      tab.addEventListener('click', () => { activeGroupId = group.id; render(settings); });
      tab.addEventListener('dragstart', (event) => {
        if (group.id === 'default') return;
        draggedGroupId = group.id;
        tab.classList.add('dragging');
        event.dataTransfer!.effectAllowed = 'move';
        event.dataTransfer!.setData('text/plain', 'group:' + group.id);
      });
      tab.addEventListener('dragover', (event) => {
        if (!draggedGroupId || draggedGroupId === group.id || group.id === 'default') return;
        event.preventDefault();
        const after = event.clientX > tab.getBoundingClientRect().left + tab.offsetWidth / 2;
        tab.classList.toggle('drag-before', !after); tab.classList.toggle('drag-after', after);
      });
      tab.addEventListener('dragleave', () => tab.classList.remove('drag-before', 'drag-after'));
      tab.addEventListener('drop', (event) => {
        if (!draggedGroupId || draggedGroupId === group.id || group.id === 'default') return;
        event.preventDefault();
        const after = event.clientX > tab.getBoundingClientRect().left + tab.offsetWidth / 2;
        const sourceId = draggedGroupId;
        draggedGroupId = null;
        tab.classList.remove('drag-before', 'drag-after');
        reorderGroups(sourceId, group.id, after);
      });
      tab.addEventListener('dragend', () => {
        draggedGroupId = null;
        groupTabs.querySelectorAll('.group-tab.drag-before,.group-tab.drag-after,.group-tab.dragging').forEach((element) => element.classList.remove('drag-before', 'drag-after', 'dragging'));
      });
      groupTabs.append(tab);
    });
    engineSettings.replaceChildren(); const active = settings.groups.find((group) => group.id === activeGroupId) || settings.groups[0];
    getGroupSources(active || { items: [] }).forEach((source) => { const button = document.createElement('button');
    button.type = 'button'; button.className = `engine-row${source.isGroup ? ' group-row' : ''}`;
    button.title = source.isGroup ? `打开${source.name}` : source.isSpecial ? String(source.specialTitle || source.name) : `使用${source.name}搜索`;
    const ident = document.createElement('span'); ident.className = 'engine-ident';
    const logo = document.createElement('span'); logo.className = `engine-logo ${source.className}`;
    if (source.iconUrl) { const image = document.createElement('img');
    image.src = source.iconUrl; image.alt = ''; image.addEventListener('error', () => { image.remove();
    if (!logo.childElementCount) logo.textContent = source.mark || '?';
    }); logo.append(image); } if (!logo.childElementCount) logo.textContent = source.mark || '?';
    const name = document.createElement('strong'); name.textContent = source.name;
    ident.append(logo, name); const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('class', 'go-icon'); arrow.setAttribute('viewBox', '0 0 24 24');
    arrow.setAttribute('aria-hidden', 'true'); arrow.innerHTML = '<path d="m9 6 6 6-6 6"></path>';
    button.append(ident, arrow); button.addEventListener('click', () => { if (source.isGroup) { activeGroupId = source.groupId!;
    render(settings); return; } if (source.isSpecial) { if (source.action === 'copy') void copyTextToClipboard(queryInput.value.trim());
    else if (source.action === 'notes') saveQueryToNotes();
    else if (source.action === 'ask-ai') openAiOnPage(queryInput.value.trim()); return; } submitSearch(source); }); engineSettings.append(button); });
    renderHistory(settings.searchHistory);
  }
  function renderHistory(history: HistoryItem[]) { historyList.replaceChildren();
  const entries = history.map((item) => typeof item === 'string' ? { query: item } : item).filter((item) => item && item.query);
  if (!entries.length) { historyList.innerHTML = '<div class="history-empty">暂无搜索历史</div>';
  return; } entries.forEach((item) => { const button = document.createElement('button');
  button.type = 'button'; button.className = 'history-item';
  button.textContent = item.query; button.title = item.query;
  button.addEventListener('click', () => { queryInput.value = item.query;
  syncClearButton(); historyOpen = false; historyToggle.setAttribute('aria-expanded', 'false'); historyList.hidden = true; queryInput.focus(); }); historyList.append(button); }); }
  function syncClearButton() { clearQuery.classList.toggle('is-empty', !queryInput.value); }
  function requestSelection() { focusAndSelectQuery(); if (!chrome.tabs?.query) return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { const tab = tabs?.[0];
  if (!tab?.id) return focusAndSelectQuery(); chrome.tabs.sendMessage(tab.id, { type: 'get-selection' }, { frameId: 0 }, (response) => { if (queryEditedSinceOpen) return;
  if (!chrome.runtime.lastError && response?.text) { queryInput.value = response.text; syncClearButton(); } focusAndSelectQuery(); }); }); }

  queryInput.addEventListener('input', () => { queryEditedSinceOpen = true; syncClearButton(); });
  queryInput.addEventListener('keydown', (event) => { if (event.key !== 'Enter' || event.isComposing) return;
  const active = settings?.groups.find((group) => group.id === activeGroupId) || settings?.groups[0];
  const source = getGroupSources(active || { items: [] }).find((item) => !item.isGroup); if (!source) return; event.preventDefault(); submitSearch(source); });
  clearQuery.addEventListener('click', () => { queryInput.value = ''; syncClearButton(); queryInput.focus(); });
  historyToggle.addEventListener('click', () => { historyOpen = !historyOpen; historyToggle.setAttribute('aria-expanded', String(historyOpen)); historyList.hidden = !historyOpen; });
  openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  chrome.storage.onChanged?.addListener((changes, area) => { if (area !== 'sync') return;
  chrome.storage.sync.get({ ...defaults }, (stored) => { savePopupCache(stored); render(normalize(stored)); }); });
  function initialize(stored: StoredSettings) { const normalized = normalize({ ...defaults, ...stored });
  render(normalized); const latest = normalized.searchHistory?.[0];
  if (latest && !queryInput.value) queryInput.value = typeof latest === 'string' ? latest : latest.query || ''; syncClearButton(); requestSelection(); }
  function loadPopupSettings() { if (!chrome.storage.session) { chrome.storage.sync.get(defaults, (stored) => { savePopupCache(stored);
  initialize(stored); }); return; } chrome.storage.session.get(POPUP_CACHE_KEY, (cached) => { const stored = cached[POPUP_CACHE_KEY];
  if (stored && typeof stored === 'object') return initialize(stored); chrome.storage.sync.get(defaults, (fresh) => { savePopupCache(fresh); initialize(fresh); }); }); }

  // 头部「AI 对话」按钮：开一个**空白**对话，不默认把搜索框内容发出去——
  // 按钮的语义是「打开 AI 聊天」，发送什么由用户在窗口里自己决定。
  aiToggle.addEventListener('click', () => openAiOnPage(''));

  focusAndSelectQuery();
  loadPopupSettings();
})();
