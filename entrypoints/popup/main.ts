// @ts-nocheck
// 由早期手写 JavaScript 迁移而来，尚未补齐类型标注；补全后删除本行。见 README「迁移状态」。
(function () {
  'use strict';

  const builtins = [
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
    { id: 'deepseek', name: 'DeepSeek', detail: 'AI 对话搜索', mark: 'DS', className: 'deepseek', url: 'https://chat.deepseek.com/?q={query}' }
  ];
  const specialActions = [
    { id: 'copy', name: '复制', detail: '复制当前搜索内容', mark: '复', className: 'special-copy', action: 'copy', isSpecial: true }
  ];
  const defaults = { enabled: true, engines: Object.fromEntries(builtins.map((source) => [source.id, true])), iconOnly: {}, customEngines: [], engineOrder: builtins.map((source) => source.id), sources: [], groups: [], searchHistory: [] };
  const POPUP_CACHE_KEY = 'quickfind-popup-cache';
  const queryInput = document.querySelector('#query-input');
  const clearQuery = document.querySelector('#clear-query');
  const historyToggle = document.querySelector('#history-toggle');
  const historyList = document.querySelector('#history-list');
  const groupTabs = document.querySelector('#group-tabs');
  const engineSettings = document.querySelector('#engine-settings');
  const openOptions = document.querySelector('#open-options');
  let settings;
  let activeGroupId = 'default';
  let draggedGroupId = null;
  let historyOpen = false;
  let queryEditedSinceOpen = false;

  function normalize(value) {
    const rawGroups = Array.isArray(value.groups) ? value.groups : [];
    const configured = Array.isArray(value.sources) && (value.sources.length || rawGroups.some((group) => group.id === 'default'));
    const rawSources = configured ? [...value.sources] : builtins.map((source) => ({ ...source, enabled: value.engines?.[source.id] !== false, iconOnly: value.iconOnly?.[source.id] === true })).concat(Array.isArray(value.customEngines) ? value.customEngines : []);
    if (configured) {
      const builtinIds = ['google-ai', 'xiaohongshu', 'doubao', 'deepseek'];
      if (Number(value.sourceConfigVersion) < 5) builtinIds.unshift('baidu', 'google-scholar', 'duckduckgo', 'so', 'sogou', 'douyin');
      builtinIds.forEach((id) => { if (!rawSources.some((source) => String(source?.id) === id)) { const source = builtins.find((item) => item.id === id); if (source) rawSources.push({ ...source, enabled: true, iconOnly: false }); } });
    }
    const sources = rawSources.filter((source) => source && source.id && source.name && (source.url || source.buildUrl)).map((source) => ({ ...source, id: String(source.id), className: source.className || (String(source.id).startsWith('custom-') ? 'custom' : String(source.id)) }));
    const sourceMap = new Map(sources.map((source) => [source.id, source]));
    const actionTokens = new Set(specialActions.map((action) => 'action:' + action.id));
    const oldDefault = rawGroups.find((group) => group.id === 'default');
    const customGroups = rawGroups.filter((group) => group && group.id && group.id !== 'default')
      .map((group) => ({ id: String(group.id), name: String(group.name || '未命名分组'), items: [], visible: group.visible !== false && group.showInDefault !== false }));
    const customIds = new Set(customGroups.map((group) => group.id));
    const assigned = new Set();
    customGroups.forEach((group) => {
      const rawGroup = rawGroups.find((item) => String(item?.id) === group.id);
      (rawGroup?.items || rawGroup?.sourceIds || []).map(String).forEach((id) => {
        if ((sourceMap.has(id) || actionTokens.has(id)) && !assigned.has(id)) { group.items.push(id); assigned.add(id); }
      });
    });
    const order = Array.isArray(value.engineOrder) ? value.engineOrder.map(String) : sources.map((source) => source.id);
    const defaultItems = [];
    const seen = new Set();
    (oldDefault?.items || oldDefault?.sourceIds || order).map(String).forEach((item) => {
      const validGroup = item.startsWith('group:') && customIds.has(item.slice(6));
      const validSource = sourceMap.has(item) && !assigned.has(item);
      const validAction = actionTokens.has(item) && !assigned.has(item);
      if ((validGroup || validSource || validAction) && !seen.has(item)) { defaultItems.push(item); seen.add(item); }
    });
    sources.forEach((source) => { if (!assigned.has(source.id) && !seen.has(source.id)) { defaultItems.push(source.id); seen.add(source.id); } });
    customGroups.forEach((group) => { const token = 'group:' + group.id; if (!seen.has(token)) defaultItems.push(token); });
    const groups = [{ id: 'default', name: String(oldDefault?.name || '默认'), items: defaultItems, visible: oldDefault?.visible !== false }, ...customGroups];
    return { enabled: value.enabled !== false, sources, groups, searchHistory: Array.isArray(value.searchHistory) ? value.searchHistory : [] };
  }

  function getGroupSources(group) {
    const sourceMap = new Map(settings.sources.map((source) => [source.id, source]));
    const sources = [];
    group.items.forEach((id) => {
      if (group.id === 'default' && String(id).startsWith('group:')) {
        const customGroup = settings.groups.find((item) => item.id === String(id).slice(6));
        if (customGroup && customGroup.visible !== false && customGroup.showInDefault !== false) sources.push({ id: 'group:' + customGroup.id, groupId: customGroup.id, name: customGroup.name, mark: '群', className: 'group', isGroup: true });
        return;
      }
      if (String(id).startsWith('action:')) {
        const action = specialActions.find((item) => item.id === String(id).slice(7));
        if (action) sources.push({ ...action, id: String(id) });
        return;
      }
      const source = sourceMap.get(id);
      if (source && source.enabled !== false) sources.push(source);
    });
    return sources;
  }
  function getSearchUrl(source, query) { if (source.id === 'doubao') return `https://www.doubao.com/chat/?quickfind=${encodeURIComponent(query)}`; return typeof source.buildUrl === 'function' ? source.buildUrl(query) : source.url.replace(/\{query\}/gi, encodeURIComponent(query)); }
  async function copyTextToClipboard(text) {
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
  function savePopupCache(value) { chrome.storage.session?.set({ [POPUP_CACHE_KEY]: value }); }
  function rememberSearch(query) { const normalized = query.replace(/\s+/g, ' ').trim(); if (!normalized) return; const history = settings.searchHistory.map((item) => typeof item === 'string' ? { query: item } : item).filter((item) => item && item.query && item.query !== normalized); history.unshift({ query: normalized, timestamp: Date.now() }); settings.searchHistory = history.slice(0, 20); chrome.storage.sync.set({ searchHistory: settings.searchHistory }); savePopupCache(settings); }
  function focusAndSelectQuery() { queryInput.focus({ preventScroll: true }); queryInput.select(); }
  function submitSearch(source) { if (!settings.enabled) return focusAndSelectQuery(); const query = queryInput.value.trim(); if (!query) return focusAndSelectQuery(); rememberSearch(query); const url = getSearchUrl(source, query); const restoreFocus = () => window.setTimeout(focusAndSelectQuery, 0); if (chrome.tabs?.create) { chrome.tabs.create({ url, active: false }, () => { void chrome.runtime.lastError; restoreFocus(); }); return; } window.open(url, '_blank', 'noopener,noreferrer'); restoreFocus(); }
  function reorderGroups(sourceId, targetId, after) {
    if (sourceId === 'default' || targetId === 'default' || sourceId === targetId) return;
    const sourceIndex = settings.groups.findIndex((group) => group.id === sourceId);
    if (sourceIndex < 0 || !settings.groups.some((group) => group.id === targetId)) return;
    const [moving] = settings.groups.splice(sourceIndex, 1);
    const targetIndex = settings.groups.findIndex((group) => group.id === targetId);
    settings.groups.splice(targetIndex + (after ? 1 : 0), 0, moving);
    chrome.storage.sync.set({ groups: settings.groups });
    savePopupCache(settings);
    render(settings);
  }
  function render(current) {
    settings = current;
    const visibleGroups = settings.groups.filter((group) => group.visible !== false); if (!visibleGroups.length) visibleGroups.push(settings.groups[0]); if (!visibleGroups.some((group) => group.id === activeGroupId)) activeGroupId = visibleGroups[0]?.id || 'default';
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
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', 'group:' + group.id);
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
    engineSettings.replaceChildren(); const active = settings.groups.find((group) => group.id === activeGroupId) || settings.groups[0]; getGroupSources(active || { items: [] }).forEach((source) => { const button = document.createElement('button'); button.type = 'button'; button.className = `engine-row${source.isGroup ? ' group-row' : ''}`; button.title = source.isGroup ? `打开${source.name}` : source.isSpecial ? `${source.name}搜索内容` : `使用${source.name}搜索`; const ident = document.createElement('span'); ident.className = 'engine-ident'; const logo = document.createElement('span'); logo.className = `engine-logo ${source.className}`; if (source.iconUrl) { const image = document.createElement('img'); image.src = source.iconUrl; image.alt = ''; image.addEventListener('error', () => { image.remove(); if (!logo.childElementCount) logo.textContent = source.mark || '?'; }); logo.append(image); } if (!logo.childElementCount) logo.textContent = source.mark || '?'; const name = document.createElement('strong'); name.textContent = source.name; ident.append(logo, name); const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); arrow.setAttribute('class', 'go-icon'); arrow.setAttribute('viewBox', '0 0 24 24'); arrow.setAttribute('aria-hidden', 'true'); arrow.innerHTML = '<path d="m9 6 6 6-6 6"></path>'; button.append(ident, arrow); button.addEventListener('click', () => { if (source.isGroup) { activeGroupId = source.groupId; render(settings); return; } if (source.isSpecial && source.action === 'copy') { void copyTextToClipboard(queryInput.value.trim()); return; } submitSearch(source); }); engineSettings.append(button); });
    renderHistory(settings.searchHistory);
  }
  function renderHistory(history) { historyList.replaceChildren(); const entries = history.map((item) => typeof item === 'string' ? { query: item } : item).filter((item) => item && item.query); if (!entries.length) { historyList.innerHTML = '<div class="history-empty">暂无搜索历史</div>'; return; } entries.forEach((item) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'history-item'; button.textContent = item.query; button.title = item.query; button.addEventListener('click', () => { queryInput.value = item.query; syncClearButton(); historyOpen = false; historyToggle.setAttribute('aria-expanded', 'false'); historyList.hidden = true; queryInput.focus(); }); historyList.append(button); }); }
  function syncClearButton() { clearQuery.classList.toggle('is-empty', !queryInput.value); }
  function requestSelection() { focusAndSelectQuery(); if (!chrome.tabs?.query) return; chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => { const tab = tabs?.[0]; if (!tab?.id) return focusAndSelectQuery(); chrome.tabs.sendMessage(tab.id, { type: 'get-selection' }, (response) => { if (queryEditedSinceOpen) return; if (!chrome.runtime.lastError && response?.text) { queryInput.value = response.text; syncClearButton(); } focusAndSelectQuery(); }); }); }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }

  queryInput.addEventListener('input', () => { queryEditedSinceOpen = true; syncClearButton(); });
  queryInput.addEventListener('keydown', (event) => { if (event.key !== 'Enter' || event.isComposing) return; const active = settings?.groups.find((group) => group.id === activeGroupId) || settings?.groups[0]; const source = getGroupSources(active || { items: [] }).find((item) => !item.isGroup); if (!source) return; event.preventDefault(); submitSearch(source); });
  clearQuery.addEventListener('click', () => { queryInput.value = ''; syncClearButton(); queryInput.focus(); });
  historyToggle.addEventListener('click', () => { historyOpen = !historyOpen; historyToggle.setAttribute('aria-expanded', String(historyOpen)); historyList.hidden = !historyOpen; });
  openOptions.addEventListener('click', () => chrome.runtime.openOptionsPage());
  chrome.storage.onChanged?.addListener((changes, area) => { if (area !== 'sync') return; chrome.storage.sync.get({ ...defaults }, (stored) => { savePopupCache(stored); render(normalize(stored)); }); });
  function initialize(stored) { const normalized = normalize({ ...defaults, ...stored }); render(normalized); const latest = normalized.searchHistory?.[0]; if (latest && !queryInput.value) queryInput.value = typeof latest === 'string' ? latest : latest.query || ''; syncClearButton(); requestSelection(); }
  function loadPopupSettings() { if (!chrome.storage.session) { chrome.storage.sync.get(defaults, (stored) => { savePopupCache(stored); initialize(stored); }); return; } chrome.storage.session.get(POPUP_CACHE_KEY, (cached) => { const stored = cached[POPUP_CACHE_KEY]; if (stored && typeof stored === 'object') return initialize(stored); chrome.storage.sync.get(defaults, (fresh) => { savePopupCache(fresh); initialize(fresh); }); }); }
  focusAndSelectQuery();
  loadPopupSettings();
})();
