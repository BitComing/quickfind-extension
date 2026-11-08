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
  SearchGroup,
  SearchSource,
  StoredSettings,
} from '@/shared/settings';
import { LEGACY_NOTES_STORAGE_KEY, NOTES_STORAGE_KEY, prependNotesLines, splitNotesLines } from '@/shared/notes';
import { DEFAULT_SETTINGS, freshInstallSeed } from '@/shared/defaults';
import { decodeQueryText } from '@/shared/query-text';
import { normalizeSettings, resolveGroupEntries } from '@/shared/settings-store';
import { actionLabel, actionTooltip, applyI18n, getLocale, groupLabel, setLocale, sourceLabel, t } from '@/shared/i18n';

(function () {
  'use strict';

  // 传给 chrome.storage.sync.get 的默认值：既是键集合也提供缺省值，因此需要索引签名。
  const defaults: StoredSettings & Record<string, unknown> = {
    ...DEFAULT_SETTINGS,
    sources: [],
    groups: [],
    specialActions: {},
    searchHistory: [],
  };
  const POPUP_CACHE_KEY = 'quickfind-popup-cache';

  /**
   * 存储 → 渲染形状。
   *
   * 空存储（用户还没打开过选项页）要先补上全新安装的默认配置：不补的话会落到
   * 「按 engines 重建内置源」那条旧版回落路径，没有旧开关可读就变成 17 个内置源全部启用，
   * 与内容脚本、选项页看到的默认配置不是同一份。判据与选项页共用 freshInstallSeed。
   */
  function normalizeStored(stored: StoredSettings): QuickFindSettings {
    return normalizeSettings({ ...defaults, ...freshInstallSeed(stored), ...stored });
  }
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

  // 源的收敛、条目解析都在 shared/settings-store.ts，弹窗这里只负责渲染。
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

  const AI_PANEL_UNSUPPORTED = () => t('当前页面无法显示对话窗口，请在普通网页上使用。');

  /**
   * 把当前页面的 AI 对话交出去，由页面侧在网页中弹出一个对话窗口。
   *
   * `text` 是**显式传入**的，不再默认取搜索框内容：头部按钮要的是空白对话，
   * 而「问 ai」按钮行要的是拿搜索内容去提问——两处语义不同，由调用方各自决定，
   * 避免「默认带上搜索框」这种隐式行为让其中一个入口变成另一个。
   * 空字符串时页面侧只开窗口、不发送（见 content/index.ts 的 askAiFromAction）。
   */
  function openAiOnPage(text: string): void {
    if (!chrome.tabs?.query) { showPopupNotice(AI_PANEL_UNSUPPORTED()); return; }
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs?.[0];
      if (!tab?.id) { showPopupNotice(AI_PANEL_UNSUPPORTED()); return; }
      // frameId: 0 —— 对话窗口是整页级 UI，只由顶层框架承载。
      chrome.tabs.sendMessage(tab.id, { type: 'ask-ai', text }, { frameId: 0 }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) { showPopupNotice(AI_PANEL_UNSUPPORTED()); return; }
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
  /**
   * 上一次渲染用的结构化指纹，见 render。
   *
   * 为什么要它：`chrome.storage.onChanged` 一响就整份重取 + 全量重建——而常驻栏、笔记、
   * LLM 这些模块写存储的频率与弹窗内容毫无关系（例如每次搜索都会写 searchHistory）。
   * 弹窗开着的时候，这些回声会让「分组标签 + 全部搜索源行」整批重建一遍，
   * 图片重新立 <img>、拖动中的标签状态被抹掉。指纹不变就只更新历史列表。
   */
  let lastConfigSignature = '';

  /** 影响分组标签与搜索源行的全部字段。少写一个，界面就会停在旧状态。 */
  function configSignature(visibleGroups: SearchGroup[], current: QuickFindSettings): string {
    const entries = resolveGroupEntries(current, activeGroupId || 'default');
    const describe = (source: SearchSource) => [
      source.id, source.name, source.mark, source.className || '', source.iconUrl || '',
      source.isGroup ? 'g' : '', source.groupId || '', source.isSpecial ? 's' : '',
      source.url || '', source.iconOnly ? '1' : '0', source.enabled === false ? '0' : '1',
    ].join('\u0001');
    return [
      getLocale(),
      visibleGroups.map((group) => `${group.id}\u0001${group.name}\u0001${group.visible !== false}`).join('\u0002'),
      activeGroupId,
      entries.map(describe).join('\u0002'),
    ].join('\u0003');
  }

  function render(current: QuickFindSettings) {
    settings = current;
    // 语言在渲染前落地：下面每一行都用 t() 取文案，晚了就会停在旧语言上。
    setLocale(current.language);
    document.documentElement.lang = getLocale();
    applyI18n(document);
    const visibleGroups = settings.groups.filter((group) => group.visible !== false);
    if (!visibleGroups.length) visibleGroups.push(settings.groups[0]!); if (!visibleGroups.some((group) => group.id === activeGroupId)) activeGroupId = visibleGroups[0]?.id || 'default';
    const signature = configSignature(visibleGroups, settings);
    if (signature !== lastConfigSignature) {
      lastConfigSignature = signature;
      renderGroupTabs(visibleGroups);
      renderEngineRows();
    }
    renderHistory(settings.searchHistory);
  }

  function renderGroupTabs(visibleGroups: SearchGroup[]) {
    groupTabs.replaceChildren(); visibleGroups.forEach((group) => {
      const tab = document.createElement('button');
      tab.type = 'button'; tab.className = `group-tab${group.id === activeGroupId ? ' active' : ''}`;
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(group.id === activeGroupId)); tab.textContent = groupLabel(group);
      tab.draggable = group.id !== 'default';
      tab.title = group.id === 'default' ? t('默认分组') : t('切换到{n}，拖动标签可调整分组顺序', { n: groupLabel(group) });
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
  }

  function renderEngineRows() {
    engineSettings.replaceChildren(); const active = settings.groups.find((group) => group.id === activeGroupId) || settings.groups[0];
    resolveGroupEntries(settings, active?.id || 'default').forEach((source) => { const button = document.createElement('button');
    const displayName = source.isSpecial ? actionLabel(source) : source.isGroup ? groupLabel({ id: source.groupId, name: source.name }) : sourceLabel(source);
    button.type = 'button'; button.className = `engine-row${source.isGroup ? ' group-row' : ''}`;
    button.title = source.isGroup ? t('打开{n}', { n: displayName }) : source.isSpecial ? actionTooltip(source) : t('使用{n}搜索', { n: displayName });
    const ident = document.createElement('span'); ident.className = 'engine-ident';
    const logo = document.createElement('span'); logo.className = `engine-logo ${source.className}`;
    if (source.iconUrl) { const image = document.createElement('img');
    image.src = source.iconUrl; image.alt = ''; image.addEventListener('error', () => { image.remove();
    if (!logo.childElementCount) logo.textContent = source.mark || '?';
    }); logo.append(image); } if (!logo.childElementCount) logo.textContent = source.isGroup ? t('组') : source.mark || '?';
    const name = document.createElement('strong'); name.textContent = displayName;
    ident.append(logo, name); const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('class', 'go-icon'); arrow.setAttribute('viewBox', '0 0 24 24');
    arrow.setAttribute('aria-hidden', 'true'); arrow.innerHTML = '<path d="m9 6 6 6-6 6"></path>';
    button.append(ident, arrow); button.addEventListener('click', () => { if (source.isGroup) { activeGroupId = source.groupId!;
    render(settings); return; } if (source.isSpecial) { if (source.action === 'copy') void copyTextToClipboard(queryInput.value.trim());
    else if (source.action === 'notes') saveQueryToNotes();
    else if (source.action === 'ask-ai') openAiOnPage(queryInput.value.trim()); return; } submitSearch(source); }); engineSettings.append(button); });
  }
  /** 历史列表的指纹：只有条目文案变了才重建（时间戳变化不影响呈现）。 */
  let lastHistorySignature = '';
  function renderHistory(history: HistoryItem[]) {
  const entries = history.map((item) => typeof item === 'string' ? { query: item } : item).filter((item) => item && item.query);
  const signature = entries.map((item) => item.query).join('\u0001');
  if (!entries.length) { lastHistorySignature = '';
  // 空态已经是当前语言的占位文案时不必重写 innerHTML；换过语言则要重写。
  if (!historyList.querySelector('.history-empty') || historyList.dataset.locale !== getLocale()) {
    historyList.innerHTML = '<div class="history-empty">' + t('暂无搜索历史') + '</div>';
    historyList.dataset.locale = getLocale();
  }
  return; }
  // 指纹闸门必须在清空之前：先 replaceChildren 再比对，看到的永远是空表，闸门等于没写。
  if (signature === lastHistorySignature) return;
  lastHistorySignature = signature;
  historyList.replaceChildren();
  entries.forEach((item) => { const button = document.createElement('button');
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
  const source = resolveGroupEntries(settings, active?.id || 'default').find((item) => !item.isGroup); if (!source) return; event.preventDefault(); submitSearch(source); });
  clearQuery.addEventListener('click', () => { queryInput.value = ''; syncClearButton(); queryInput.focus(); });
  historyToggle.addEventListener('click', () => { historyOpen = !historyOpen; historyToggle.setAttribute('aria-expanded', String(historyOpen)); historyList.hidden = !historyOpen; });
  openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  chrome.storage.onChanged?.addListener((changes, area) => { if (area !== 'sync') return;
  chrome.storage.sync.get(null, (stored) => { savePopupCache(stored); render(normalizeStored(stored)); }); });
  function initialize(stored: StoredSettings) { const normalized = normalizeStored(stored);
  render(normalized); const latest = normalized.searchHistory?.[0];
  if (latest && !queryInput.value) queryInput.value = typeof latest === 'string' ? latest : latest.query || ''; syncClearButton(); requestSelection(); }
  function loadPopupSettings() { if (!chrome.storage.session) { chrome.storage.sync.get(null, (stored) => { savePopupCache(stored);
  initialize(stored); }); return; } chrome.storage.session.get(POPUP_CACHE_KEY, (cached) => { const stored = cached[POPUP_CACHE_KEY];
  if (stored && typeof stored === 'object') return initialize(stored); chrome.storage.sync.get(null, (fresh) => { savePopupCache(fresh); initialize(fresh); }); }); }

  // 头部「AI 对话」按钮：开一个**空白**对话，不默认把搜索框内容发出去——
  // 按钮的语义是「打开 AI 聊天」，发送什么由用户在窗口里自己决定。
  aiToggle.addEventListener('click', () => openAiOnPage(''));

  focusAndSelectQuery();
  loadPopupSettings();
})();
