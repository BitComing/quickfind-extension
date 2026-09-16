// @ts-nocheck
// 由早期手写 JavaScript 迁移而来，尚未补齐类型标注；补全后删除本行。见 README「迁移状态」。
(function () {
  'use strict';

  // Keep the settings page usable when opened directly during development.
  if (!globalThis.chrome) globalThis.chrome = {};
  if (!chrome.storage) {
    const readFallback = () => { try { return JSON.parse(localStorage.getItem('quickfind-options-storage') || '{}'); } catch { return {}; } };
    const writeFallback = (value) => { try { localStorage.setItem('quickfind-options-storage', JSON.stringify(value)); } catch { /* storage unavailable */ } };
    chrome.storage = {
      sync: {
        get(keys, callback) { const data = readFallback(); if (keys == null) return callback(data); if (typeof keys === 'string') return callback({ [keys]: data[keys] }); const result = {}; Object.keys(keys || {}).forEach((key) => { result[key] = data[key] ?? keys[key]; }); callback(result); },
        set(value, callback) { const data = readFallback(); writeFallback({ ...data, ...value }); callback?.(); },
        remove(keys, callback) { const data = readFallback(); (Array.isArray(keys) ? keys : [keys]).forEach((key) => delete data[key]); writeFallback(data); callback?.(); }
      },
      local: {
        get(keys, callback) { const data = readFallback(); callback(typeof keys === 'string' ? { [keys]: data[keys] } : data); },
        set(value, callback) { const data = readFallback(); writeFallback({ ...data, ...value }); callback?.(); }
      },
      onChanged: { addListener() {} }
    };
  }

  const BUILTINS = [
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
  const SPECIAL_ACTIONS = [
    { id: 'copy', name: '复制', detail: '复制当前搜索内容', mark: '复', className: 'special-copy' }
  ];
  const LEGACY_KEYS = ['engines', 'iconOnly', 'customEngines', 'engineOrder'];
  const CONFIG_VERSION = 5;
  const PINNED_SITES = [
    { id: 'google', name: 'Google', url: 'https://www.google.com/search?q={query}', selector: 'textarea[name="q"], input[name="q"]' },
    { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd={query}', selector: 'input#kw, input[name="wd"], input[name="word"], textarea#kw' },
    { id: 'google-scholar', name: '谷歌学术', url: 'https://scholar.google.com/scholar?q={query}', selector: 'input[name="q"], input.gs_in_txt, textarea[name="q"]' },
    { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={query}', selector: 'input[name="q"], #search_form_input, #search_form_input_homepage, input[aria-label*="Search"]' },
    { id: 'so', name: '360 搜索', url: 'https://www.so.com/s?q={query}', selector: 'input#input, input#search-input, input[name="q"], input[placeholder*="搜索"]' },
    { id: 'sogou', name: '搜狗', url: 'https://www.sogou.com/web?query={query}', selector: 'input#query, input[name="query"], input[name="q"], input[placeholder*="搜索"]' },
    { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q={query}', selector: 'input[name="q"]' },
    { id: 'yandex', name: 'Yandex', url: 'https://yandex.com/search/?text={query}', selector: 'input[name="text"], textarea[name="text"], input#text' },
    { id: 'zhihu', name: '知乎', url: 'https://www.zhihu.com/search?type=content&q={query}', selector: 'input[name="q"], input[placeholder*="搜索"], input[aria-label*="搜索"]' },
    { id: 'bilibili', name: '哔哩哔哩', url: 'https://search.bilibili.com/all?keyword={query}', selector: 'input.nav-search-input, input.search-input, input[name="keyword"], input[placeholder*="搜索"], input[placeholder*="搜"]' },
    { id: 'douyin', name: '抖音', url: 'https://www.douyin.com/search/{query}?type=general', selector: 'input[data-e2e="searchbar-input"], input[placeholder*="搜索"], input[aria-label*="搜索"], input[name="keyword"]' }
  ];
  const PINNED_SITE_CONFIG_VERSION = 3;
  const NEW_BUILTIN_IDS = ['baidu', 'google-scholar', 'duckduckgo', 'so', 'sogou', 'douyin'];
  const DEFAULTS = {
    enabled: true, triggerMode: 'click', editableTriggerMode: 'click', defaultGroupCount: 4, selectionTriggerDelay: 200,
    engines: Object.fromEntries(BUILTINS.map((source) => [source.id, true])), searchHistory: [],
    llm: { enabled: true, endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', apiKey: '', systemPrompt: '' },
    iconOnly: {}, customEngines: [], engineOrder: BUILTINS.map((source) => source.id), sources: [], groups: []
  };
  const MAX_DEFAULT_GROUP_COUNT = 20;

  let settings;
  let activePanel = 'general';
  const activeGroupId = { general: 'default', pinned: 'default' };
  let editing = null;
  let draggedItem = null;
  let iconEditorSourceId = null;
  let pinnedSiteEditingId = null;
  const iconNodeCache = new Map();
  const selectedSourceIds = { general: new Set(), pinned: new Set() };
  const selectedHistoryIndexes = new Set();

  const navItems = Array.from(document.querySelectorAll('.nav-item'));
  const panels = Array.from(document.querySelectorAll('.settings-panel'));
  const sourceManager = document.querySelector('#source-manager');
  const managerTitle = document.querySelector('#manager-title');
  const managerHelp = document.querySelector('#manager-help');
  const defaultGroupCountInput = document.querySelector('#default-group-count');
  const pinnedDefaultGroupCountInput = document.querySelector('#pinned-default-group-count');
  const pinnedCollapseDelayInput = document.querySelector('#pinned-collapse-delay');
  const pinnedAllSitesInput = document.querySelector('#pinned-all-sites');
  const selectionTriggerDelayInput = document.querySelector('#selection-trigger-delay');
  const llmEnabledInput = document.querySelector('#llm-enabled');
  const llmEndpointInput = document.querySelector('#llm-endpoint');
  const llmModelInput = document.querySelector('#llm-model');
  const llmApiKeyInput = document.querySelector('#llm-api-key');
  const llmSystemPromptInput = document.querySelector('#llm-system-prompt');
  const sourceList = document.querySelector('#source-list');
  const groupList = document.querySelector('#group-list');
  const activeGroupMeta = document.querySelector('#active-group-meta');
  const form = document.querySelector('#source-form');
  const nameInput = document.querySelector('#source-name');
  const markInput = document.querySelector('#source-mark');
  const urlInput = document.querySelector('#source-url');
  const errorEl = document.querySelector('#form-error');
  const formTitle = document.querySelector('#form-title');
  const submitLabel = document.querySelector('#submit-label');
  const cancelEdit = document.querySelector('#cancel-edit');
  const addGroupButton = document.querySelector('#add-group');
  const saveStates = { general: document.querySelector('#save-state'), pinned: document.querySelector('#pinned-save-state'), history: document.querySelector('#history-save-state'), notes: document.querySelector('#notes-save-state') };
  const triggerInputs = Array.from(document.querySelectorAll('input[name="trigger-mode"]'));
  const editableTriggerInputs = Array.from(document.querySelectorAll('input[name="editable-trigger-mode"]'));
  const iconEditor = document.querySelector('#icon-editor');
  const iconUrlInput = document.querySelector('#icon-url');
  const iconFileInput = document.querySelector('#icon-file');
  const applyIconUrl = document.querySelector('#apply-icon-url');
  const closeIconEditor = document.querySelector('#close-icon-editor');
  const iconEditorError = document.querySelector('#icon-editor-error');
  const pinnedSiteList = document.querySelector('#pinned-site-list');
  const pinnedSiteForm = document.querySelector('#pinned-site-form');
  const pinnedSiteNameInput = document.querySelector('#pinned-site-name');
  const pinnedSiteUrlInput = document.querySelector('#pinned-site-url');
  const pinnedSiteSelectorInput = document.querySelector('#pinned-site-selector');
  const pinnedSiteError = document.querySelector('#pinned-site-error');
  const pinnedSiteSummary = document.querySelector('#pinned-site-summary');
  const managePinnedSites = document.querySelector('#manage-pinned-sites');
  const pinnedSiteDialog = document.querySelector('#pinned-site-dialog');
  const closePinnedSiteDialog = document.querySelector('#close-pinned-site-dialog');
  const cancelPinnedSiteEdit = document.querySelector('#cancel-pinned-site-edit');
  const pinnedSiteFormTitle = document.querySelector('#pinned-site-form-title');
  const pinnedSiteSubmit = document.querySelector('#pinned-site-submit');
  const batchActions = document.querySelector('#batch-actions');
  const batchCount = document.querySelector('#batch-count');
  const batchGroup = document.querySelector('#batch-group');
  const batchDelete = document.querySelector('#batch-delete');
  const historyRecordList = document.querySelector('#history-record-list');
  const historySelectionCount = document.querySelector('#history-selection-count');
  const selectAllHistory = document.querySelector('#select-all-history');
  const deleteSelectedHistory = document.querySelector('#delete-selected-history');
  const clearHistory = document.querySelector('#clear-history');
  const specialActionList = document.querySelector('#special-action-list');
  const notesSaveState = document.querySelector('#notes-save-state');
  const notesSearchInput = document.querySelector('#notes-search-input');
  const notesSearchResult = document.querySelector('#notes-search-result');
  const notesOutline = document.querySelector('#notes-outline');
  const notesBreadcrumb = document.querySelector('#notes-breadcrumb');
  const notesHomeButton = document.querySelector('#notes-home');
  const addNoteButton = document.querySelector('#add-note');
  const undoNotesButton = document.querySelector('#undo-notes');
  const redoNotesButton = document.querySelector('#redo-notes');
  const expandNotesButton = document.querySelector('#expand-notes');
  const collapseNotesButton = document.querySelector('#collapse-notes');
  const exportNotesButton = document.querySelector('#export-notes');
  const exportNotesMarkdownButton = document.querySelector('#export-notes-markdown');
  const importNotesButton = document.querySelector('#import-notes');
  const importNotesFile = document.querySelector('#import-notes-file');

  const NOTES_DB_NAME = 'quickfind-notes';
  const NOTES_STORE = 'documents';
  const NOTES_DOCUMENT_ID = 'main';
  let notesState = createEmptyNotes();
  let notesDbPromise = null;
  let notesSaveTimer = null;
  let notesActiveId = null;
  let notesLoaded = false;
  let noteIdCounter = 0;
  let notesFocusRestoreToken = 0;
  let notesZoomRootId = 'root';
  let notesSearchTimer = null;
  let notesUndoStack = [];
  let notesRedoStack = [];
  let notesTypingHistoryId = null;
  let notesTypingBeforeState = null;
  let notesHistorySuspend = false;
  let notesWriteQueue = Promise.resolve();
  const NOTES_HISTORY_LIMIT = 100;

  function copyBuiltins(raw) {
    const config = raw || {};
    const custom = Array.isArray(config.customEngines) ? config.customEngines : [];
    return BUILTINS.map((source) => ({ ...source, enabled: config.engines?.[source.id] !== false, iconOnly: config.iconOnly?.[source.id] === true })).concat(custom);
  }

  function cleanSource(source) {
    if (!source || !source.id || !source.name || !(source.url || source.buildUrl)) return null;
    return {
      id: String(source.id), name: String(source.name), mark: String(source.mark || '?').slice(0, 2),
      url: String(source.url || ''), detail: String(source.detail || source.url || ''), iconUrl: String(source.iconUrl || ''),
      className: source.className || (String(source.id).startsWith('custom-') ? 'custom' : String(source.id)),
      enabled: source.enabled !== false, iconOnly: source.iconOnly === true
    };
  }

  function specialActionToken(id) { return 'action:' + String(id); }
  function specialActionByToken(token) {
    const value = String(token || '');
    if (!value.startsWith('action:')) return null;
    return SPECIAL_ACTIONS.find((action) => action.id === value.slice(7)) || null;
  }

  function normalizeSearchHistory(history) {
    if (!Array.isArray(history)) return [];
    return history.map((item) => {
      const query = String(typeof item === 'string' ? item : item?.query || '').replace(/\s+/g, ' ').trim();
      if (!query) return null;
      const timestamp = Number(typeof item === 'string' ? NaN : item?.timestamp);
      return Number.isFinite(timestamp) ? { query, timestamp } : { query };
    }).filter(Boolean);
  }

  function deriveSiteName(url, fallback = '') {
    const raw = String(url || '').trim();
    try {
      const parsed = new URL(raw.replace(/\{query\}/gi, 'quickfind').match(/^[a-z][a-z\d+.-]*:\/\//i) ? raw.replace(/\{query\}/gi, 'quickfind') : 'https://' + raw.replace(/^\/\//, '').replace(/\{query\}/gi, 'quickfind'));
      return parsed.hostname.replace(/^www\./i, '') || fallback;
    } catch { return fallback; }
  }

  function cleanPinnedSite(site) {
    if (!site || !site.id) return null;
    const rawName = String(site.name || '').trim();
    const fallbackName = deriveSiteName(site.url, String(site.id));
    return {
      id: String(site.id), name: (rawName && !/^custom-site-\d+$/.test(rawName) ? rawName : fallbackName).slice(0, 24), url: String(site.url || ''),
      selector: String(site.selector || '' ).slice(0, 500), categorySelectors: Array.isArray(site.categorySelectors) ? site.categorySelectors.map(String).slice(0, 8) : []
    };
  }

  function getExistingSourceSites() {
    const sourceSets = [settings?.general?.sources];
    if (!sourceSets.some((sources) => Array.isArray(sources) && sources.length)) sourceSets.push(copyBuiltins(settings || {}));
    const seen = new Set();
    return sourceSets.flatMap((sources) => (Array.isArray(sources) ? sources : []))
      .map(cleanSource).filter((source) => source && source.url).filter((source) => !seen.has(source.id) && seen.add(source.id))
      .map((source) => ({ id: source.id, name: source.name, source: true }));
  }

  function renderPinnedSiteOptions() {
    if (!pinnedSiteList || !settings) return;
    const customSites = Array.isArray(settings.pinned.customSites) ? settings.pinned.customSites : [];
    const overrides = new Map(customSites.map((site) => [String(site.id), site]));
    const options = PINNED_SITES.map((site) => ({ ...site, ...(overrides.get(site.id) || {}), managed: true }));
    getExistingSourceSites().forEach((site) => { if (!options.some((item) => item.id === site.id)) options.push({ ...site, ...(overrides.get(site.id) || {}), managed: true }); });
    customSites.forEach((site) => { if (!options.some((item) => item.id === site.id)) options.push({ ...site, managed: true }); });
    const selected = new Set(settings.pinned.sites || []);
    if (pinnedSiteSummary) {
      const selectedNames = options.filter((site) => selected.has(site.id)).map((site) => site.name);
      pinnedSiteSummary.textContent = selectedNames.length ? selectedNames.join('、') : '未选择';
    }
    pinnedSiteList.replaceChildren();
    options.forEach((site) => {
      const label = document.createElement('label');
      label.className = 'site-option managed-site' + (site.custom ? ' custom-site' : '');
      if (site.url) label.title = site.url;
      const input = document.createElement('input');
      input.type = 'checkbox'; input.dataset.siteId = site.id; input.checked = selected.has(site.id); input.setAttribute('aria-label', site.name);
      const name = document.createElement('span');
      name.textContent = site.name + (site.source && !PINNED_SITES.some((item) => item.id === site.id) ? ' · 搜索源' : '');
      label.append(input, name);
      if (site.managed) {
        const edit = document.createElement('button');
        edit.type = 'button'; edit.className = 'site-edit'; edit.title = '编辑站点'; edit.setAttribute('aria-label', '编辑' + site.name + '站点');
        edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"></path></svg>';
        edit.addEventListener('click', (event) => { event.preventDefault(); startPinnedSiteEdit(site); });
        label.append(edit);
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'site-remove'; remove.title = '删除站点'; remove.setAttribute('aria-label', '删除' + site.name + '站点');
        remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg>';
        remove.addEventListener('click', (event) => {
          event.preventDefault();
          if (pinnedSiteEditingId === site.id) resetPinnedSiteForm();
          settings.pinned.customSites = customSites.filter((item) => item.id !== site.id);
          settings.pinned.sites = (settings.pinned.sites || []).filter((id) => id !== site.id);
          savePinned(); renderPinnedSiteOptions();
        });
        label.append(remove);
      }
      pinnedSiteList.append(label);
    });
  }

  function startPinnedSiteEdit(site) {
    if (!site || !pinnedSiteForm) return;
    pinnedSiteEditingId = site.id;
    pinnedSiteNameInput.value = site.name || '';
    pinnedSiteUrlInput.value = site.url || '';
    pinnedSiteSelectorInput.value = site.selector || '';
    pinnedSiteFormTitle.textContent = '编辑常驻站点';
    pinnedSiteSubmit.textContent = '保存修改';
    cancelPinnedSiteEdit.hidden = false;
    pinnedSiteError.textContent = '';
    pinnedSiteNameInput.focus();
  }

  function resetPinnedSiteForm() {
    pinnedSiteEditingId = null;
    pinnedSiteForm?.reset();
    if (pinnedSiteFormTitle) pinnedSiteFormTitle.textContent = '添加常驻站点';
    if (pinnedSiteSubmit) pinnedSiteSubmit.textContent = '添加站点';
    if (cancelPinnedSiteEdit) cancelPinnedSiteEdit.hidden = true;
    if (pinnedSiteError) pinnedSiteError.textContent = '';
  }

  // Default items contain source IDs, action:<id> tokens, and group:<id> tokens.
  // This lets custom groups, sources, and special actions share one order.
  function normalizeList(raw, fallbackSources) {
    const sourceValue = raw && typeof raw === 'object' ? raw : {};
    const rawGroups = Array.isArray(sourceValue.groups) ? sourceValue.groups : [];
    const hasSources = Array.isArray(sourceValue.sources) && (sourceValue.sources.length || rawGroups.some((group) => group?.id === 'default'));
    const sourceMap = new Map();
    (hasSources ? sourceValue.sources : fallbackSources).map(cleanSource).filter(Boolean).forEach((source) => {
      if (!sourceMap.has(source.id)) sourceMap.set(source.id, source);
    });
    const sources = Array.from(sourceMap.values());
    const sourceIds = new Set(sourceMap.keys());
    const actionTokens = new Set(SPECIAL_ACTIONS.map((action) => specialActionToken(action.id)));
    const rawDefault = rawGroups.find((group) => group?.id === 'default');
    const customGroups = rawGroups.filter((group) => group && group.id && group.id !== 'default')
      .map((group) => ({ id: String(group.id), name: String(group.name || '未命名分组'), items: [], visible: group.visible !== false && group.showInDefault !== false }));
    const customIds = new Set(customGroups.map((group) => group.id));
    const assigned = new Set();
    customGroups.forEach((group) => {
      const rawGroup = rawGroups.find((item) => String(item?.id) === group.id);
      (rawGroup?.items || rawGroup?.sourceIds || []).map(String).forEach((id) => {
        const validSource = sourceIds.has(id);
        const validAction = actionTokens.has(id);
        if ((validSource || validAction) && !assigned.has(id)) { group.items.push(id); assigned.add(id); }
      });
    });
    const defaultItems = [];
    const seen = new Set();
    (rawDefault?.items || rawDefault?.sourceIds || []).map(String).forEach((item) => {
      const validGroup = item.startsWith('group:') && customIds.has(item.slice(6));
      const validSource = sourceIds.has(item) && !assigned.has(item);
      const validAction = actionTokens.has(item) && !assigned.has(item);
      if ((validGroup || validSource || validAction) && !seen.has(item)) { defaultItems.push(item); seen.add(item); }
    });
    const order = Array.isArray(sourceValue.engineOrder) ? sourceValue.engineOrder.map(String) : sources.map((source) => source.id);
    order.forEach((id) => {
      if (sourceIds.has(id) && !assigned.has(id) && !seen.has(id)) { defaultItems.push(id); seen.add(id); }
    });
    sources.forEach((source) => {
      if (!assigned.has(source.id) && !seen.has(source.id)) { defaultItems.push(source.id); seen.add(source.id); }
    });
    customGroups.forEach((group) => {
      const token = 'group:' + group.id;
      if (!seen.has(token)) defaultItems.push(token);
    });
    return { sources, groups: [{ id: 'default', name: String(rawDefault?.name || '默认组'), items: defaultItems, visible: rawDefault?.visible !== false }, ...customGroups] };
  }

  function appendNewBuiltins(normalized, fallbackSources) {
    const sourceIds = new Set(normalized.sources.map((source) => source.id));
    const defaultGroup = normalized.groups.find((group) => group.id === 'default');
    if (!defaultGroup) return normalized;
    NEW_BUILTIN_IDS.forEach((id) => {
      if (sourceIds.has(id)) return;
      const source = fallbackSources.map(cleanSource).find((candidate) => candidate?.id === id);
      if (!source) return;
      normalized.sources.push(source);
      defaultGroup.items.push(id);
      sourceIds.add(id);
    });
    return normalized;
  }

  function normalizeSettings(stored) {
    const needsBuiltinMigration = Number(stored.sourceConfigVersion) < CONFIG_VERSION;
    const general = needsBuiltinMigration
      ? appendNewBuiltins(normalizeList(stored, copyBuiltins(stored)), copyBuiltins(stored))
      : normalizeList(stored, copyBuiltins(stored));
    const pinnedRaw = stored.pinnedSearch && typeof stored.pinnedSearch === 'object' ? stored.pinnedSearch : {};
    const hasPinnedSiteConfig = Number(pinnedRaw.siteConfigVersion) >= PINNED_SITE_CONFIG_VERSION;
    const customSites = Array.isArray(pinnedRaw.customSites) ? pinnedRaw.customSites.map(cleanPinnedSite).filter(Boolean) : [];
    const knownSiteIds = new Set([
      ...PINNED_SITES.map((site) => site.id),
      ...general.sources.map((source) => source.id),
      ...customSites.map((site) => site.id)
    ]);
    const validStoredSites = Array.isArray(pinnedRaw.sites) ? [...new Set(pinnedRaw.sites.map(String).filter((id) => knownSiteIds.has(id)))] : [];
    const sites = hasPinnedSiteConfig
      ? validStoredSites
      : [...new Set([
        ...(Array.isArray(pinnedRaw.sites) ? validStoredSites : PINNED_SITES.map((site) => site.id)),
        ...customSites.map((site) => site.id)
      ])];
    const pinnedDefaultGroupCount = Math.max(1, Math.min(MAX_DEFAULT_GROUP_COUNT, Math.round(Number(pinnedRaw.defaultGroupCount ?? 4) || 4)));
    const rawCollapseDelay = Number(pinnedRaw.collapseDelay ?? 2000);
    const pinnedCollapseDelay = Number.isFinite(rawCollapseDelay) ? Math.max(0, Math.min(60000, Math.round(rawCollapseDelay))) : 2000;
    const pinned = { sites, customSites, defaultGroupCount: pinnedDefaultGroupCount, collapseDelay: pinnedCollapseDelay, openInNewTab: pinnedRaw.openInNewTab === true, allSites: pinnedRaw.allSites === true, siteConfigVersion: PINNED_SITE_CONFIG_VERSION };
    const count = Math.max(1, Math.min(MAX_DEFAULT_GROUP_COUNT, Math.round(Number(stored.defaultGroupCount ?? stored.defaultVisibleCount ?? 4) || 4)));
    const editableTriggerMode = ['click', 'hover', 'none'].includes(stored.editableTriggerMode) ? stored.editableTriggerMode : 'click';
    const selectionTriggerDelay = Math.max(0, Math.min(2000, Math.round(Number(stored.selectionTriggerDelay ?? 200) || 0)));
    const rawLlm = stored.llm && typeof stored.llm === 'object' ? stored.llm : {};
    const llm = {
      enabled: rawLlm.enabled !== false,
      endpoint: String(rawLlm.endpoint || DEFAULTS.llm.endpoint).trim(),
      model: String(rawLlm.model || DEFAULTS.llm.model).trim(),
      apiKey: String(rawLlm.apiKey || ''),
      systemPrompt: String(rawLlm.systemPrompt || '').trim()
    };
    return { enabled: stored.enabled !== false, triggerMode: stored.triggerMode === 'hover' ? 'hover' : 'click', editableTriggerMode, defaultGroupCount: count, selectionTriggerDelay, general, pinned, llm, searchHistory: normalizeSearchHistory(stored.searchHistory) };
  }

  // Both settings pages edit the same search-source data. The pinned panel only
  // owns its display and site-matching preferences.
  function config() { return settings.general; }
  function activeGroup() { return config().groups.find((group) => group.id === activeGroupId[activePanel]) || config().groups[0]; }
  function sourceById(id) { return config().sources.find((source) => source.id === id); }
  function groupById(id) { return config().groups.find((group) => group.id === id); }

  function showSaved(panel) {
    const status = saveStates[panel || activePanel];
    status.textContent = '已保存';
    window.setTimeout(() => { if (status.textContent === '已保存') status.textContent = ''; }, 1200);
  }

  function saveGeneral(statusPanel = 'general') {
    chrome.storage.sync.set({
      enabled: settings.enabled, triggerMode: settings.triggerMode, defaultGroupCount: settings.defaultGroupCount,
      editableTriggerMode: settings.editableTriggerMode,
      selectionTriggerDelay: settings.selectionTriggerDelay,
      llm: settings.llm,
      sources: settings.general.sources, groups: settings.general.groups, sourceConfigVersion: CONFIG_VERSION
    }, () => showSaved(statusPanel));
  }
  function savePinned() { settings.pinned.siteConfigVersion = PINNED_SITE_CONFIG_VERSION; chrome.storage.sync.set({ pinnedSearch: settings.pinned }, () => showSaved('pinned')); }
  function saveCurrent() { saveGeneral(activePanel); }

  function formatHistoryTimestamp(timestamp) {
    if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8640000000000000) return '';
    return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
  }

  function saveHistory() {
    chrome.storage.sync.set({ searchHistory: settings.searchHistory }, () => showSaved('history'));
  }

  function createEmptyNotes() {
    const now = Date.now();
    return { version: 2, rootId: 'root', nodes: { root: { id: 'root', parentId: null, children: [], text: '', collapsed: false, completed: false, createdAt: now, updatedAt: now } }, updatedAt: now };
  }

  function normalizeNotes(raw) {
    const fallback = createEmptyNotes();
    if (!raw || typeof raw !== 'object' || !raw.nodes || typeof raw.nodes !== 'object') return fallback;
    const nodes = {};
    Object.entries(raw.nodes).forEach(([key, value]) => {
      if (!value || typeof value !== 'object') return;
      const id = String(value.id || key);
      if (!id || id === 'root') return;
      const now = Date.now();
      const createdAt = Number(value.createdAt) || now;
      nodes[id] = { id, parentId: value.parentId == null ? 'root' : String(value.parentId), children: [], text: String(value.text || ''), collapsed: value.collapsed === true, completed: value.completed === true, createdAt, updatedAt: Number(value.updatedAt) || createdAt };
    });
    const rootValue = raw.nodes.root && typeof raw.nodes.root === 'object' ? raw.nodes.root : {};
    const rootNow = Number(rootValue.updatedAt) || Date.now();
    nodes.root = { id: 'root', parentId: null, children: [], text: '', collapsed: false, completed: false, createdAt: Number(rootValue.createdAt) || rootNow, updatedAt: rootNow };
    Object.values(nodes).forEach((node) => {
      if (node.id === 'root' || !nodes[node.parentId] || node.parentId === node.id) node.parentId = 'root';
    });
    const declaredChildren = new Map(Object.keys(nodes).map((id) => [id, []]));
    Object.entries(raw.nodes).forEach(([key, value]) => {
      const id = String(value?.id || key);
      if (!nodes[id] || !Array.isArray(value?.children)) return;
      const seen = new Set();
      value.children.map(String).forEach((childId) => {
        if (!nodes[childId] || nodes[childId].parentId !== id || seen.has(childId)) return;
        seen.add(childId); declaredChildren.get(id).push(childId);
      });
    });
    // Rebuild the tree from root with cycle protection. Broken or unreachable data becomes a root item.
    const visited = new Set(['root']);
    const attach = (parentId, trail = new Set()) => {
      const parent = nodes[parentId];
      if (!parent || trail.has(parentId)) return;
      const nextTrail = new Set(trail); nextTrail.add(parentId);
      (declaredChildren.get(parentId) || []).forEach((childId) => {
        if (visited.has(childId) || nextTrail.has(childId)) return;
        visited.add(childId); parent.children.push(childId); attach(childId, nextTrail);
      });
    };
    attach('root');
    Object.values(nodes).forEach((node) => {
      if (node.id === 'root' || visited.has(node.id)) return;
      node.parentId = 'root'; nodes.root.children.push(node.id); visited.add(node.id); attach(node.id);
    });
    return { version: 2, rootId: 'root', nodes, updatedAt: Number(raw.updatedAt) || Date.now() };
  }

  function openNotesDb() {
    if (notesDbPromise) return notesDbPromise;
    if (!window.indexedDB) return Promise.reject(new Error('IndexedDB unavailable'));
    notesDbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(NOTES_DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(NOTES_STORE, { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Unable to open notes database'));
    });
    return notesDbPromise;
  }

  function readNotesFromLocal() {
    if (!chrome.storage?.local) {
      try { return Promise.resolve(JSON.parse(localStorage.getItem('quickfind-notes') || 'null')); } catch { return Promise.resolve(null); }
    }
    return new Promise((resolve) => chrome.storage.local.get('quickfind-notes', (value) => resolve(value?.['quickfind-notes'] || null)));
  }

  async function loadNotes() {
    let dbStored = null;
    try {
      const db = await openNotesDb();
      dbStored = await new Promise((resolve, reject) => {
        const request = db.transaction(NOTES_STORE, 'readonly').objectStore(NOTES_STORE).get(NOTES_DOCUMENT_ID);
        request.onsuccess = () => resolve(request.result?.data || null);
        request.onerror = () => reject(request.error);
      });
    } catch { /* IndexedDB unavailable */ }
    let localStored = null;
    try { localStored = await readNotesFromLocal(); } catch { /* ignore */ }
    let stored = null;
    // IndexedDB lives in the extension origin and is unreachable from content scripts,
    // so chrome.storage.local is the only copy the in-page sidebar can read and write.
    // Whenever the sidebar has touched the notes it is the freshest copy, and on a tie
    // it must win — otherwise a stale IndexedDB snapshot would silently revert sidebar edits.
    if (dbStored && localStored) stored = Number(localStored.updatedAt || 0) >= Number(dbStored.updatedAt || 0) ? localStored : dbStored;
    else stored = localStored || dbStored;
    notesState = normalizeNotes(stored);
    notesLoaded = true;
    // After load, refresh both copies (IndexedDB + storage mirror for the sidebar) so they agree.
    if (stored) void persistNotes();
    if (activePanel === 'notes') renderNotes();
  }

  async function persistNotes() {
    notesState.updatedAt = Date.now();
    const payload = { id: NOTES_DOCUMENT_ID, data: notesState };
    notesWriteQueue = notesWriteQueue.then(async () => {
      let saved = false;
      try {
        const db = await openNotesDb();
        await new Promise((resolve, reject) => {
          const request = db.transaction(NOTES_STORE, 'readwrite').objectStore(NOTES_STORE).put(payload);
          request.onsuccess = resolve; request.onerror = () => reject(request.error);
        });
        saved = true;
      } catch { /* fall through to the storage mirror */ }
      try {
        // Always mirror to storage so the in-page sidebar sees the latest notes.
        if (chrome.storage?.local) await new Promise((resolve, reject) => chrome.storage.local.set({ 'quickfind-notes': notesState }, () => chrome.runtime?.lastError ? reject(chrome.runtime.lastError) : resolve()));
        else localStorage.setItem('quickfind-notes', JSON.stringify(notesState));
        saved = true;
      } catch { /* ignore */ }
      if (!saved) {
        if (notesSaveState) notesSaveState.textContent = '保存失败';
        return;
      }
      showSaved('notes');
    });
    return notesWriteQueue;
  }

  // Keep the notes panel live when the in-page sidebar (or another settings tab) edits the notes.
  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes['quickfind-notes'] || !notesLoaded) return;
      if (notesSaveTimer) return; // local edits pending; last writer wins
      const incoming = changes['quickfind-notes'].newValue;
      if (!incoming || typeof incoming !== 'object') return;
      const next = normalizeNotes(incoming);
      if (notesStateSignature(next) === notesStateSignature()) return;
      notesState = next;
      if (!noteById(notesZoomRootId)) notesZoomRootId = 'root';
      if (notesActiveId && !noteById(notesActiveId)) notesActiveId = null;
      notesUndoStack = [];
      notesRedoStack = [];
      updateNotesHistoryButtons();
      void persistNotes(); // backfill IndexedDB with the sidebar's change
      if (activePanel === 'notes') renderNotes();
    });
  }

  function scheduleNotesSave() {
    window.clearTimeout(notesSaveTimer);
    notesSaveTimer = window.setTimeout(() => { notesSaveTimer = null; void persistNotes(); }, 350);
    if (notesSaveState) notesSaveState.textContent = '保存中…';
  }

  function cloneNotesState(state = notesState) {
    return JSON.parse(JSON.stringify(state));
  }
  function notesStateSignature(state = notesState) {
    return JSON.stringify({ rootId: state.rootId, nodes: state.nodes });
  }
  function updateNotesHistoryButtons() {
    if (undoNotesButton) undoNotesButton.disabled = notesUndoStack.length === 0;
    if (redoNotesButton) redoNotesButton.disabled = notesRedoStack.length === 0;
  }
  function pushNotesHistory(before) {
    if (notesHistorySuspend || notesStateSignature(before) === notesStateSignature()) return;
    notesUndoStack.push(before);
    if (notesUndoStack.length > NOTES_HISTORY_LIMIT) notesUndoStack.shift();
    notesRedoStack = [];
    updateNotesHistoryButtons();
  }
  function beginNotesHistory(id) {
    if (notesTypingHistoryId === id) return;
    notesTypingHistoryId = id;
    pushNotesHistory(notesTypingBeforeState || cloneNotesState());
    notesTypingBeforeState = null;
  }
  function restoreNotesSnapshot(snapshot, focusId = null) {
    if (!snapshot) return;
    notesHistorySuspend = true;
    notesState = normalizeNotes(snapshot);
    notesHistorySuspend = false;
    notesActiveId = focusId && noteById(focusId) ? focusId : null;
    scheduleNotesSave();
    renderNotes(notesActiveId);
    updateNotesHistoryButtons();
  }
  function undoNotes() {
    const previous = notesUndoStack.pop();
    if (!previous) return;
    notesRedoStack.push(cloneNotesState());
    restoreNotesSnapshot(previous);
  }
  function redoNotes() {
    const next = notesRedoStack.pop();
    if (!next) return;
    notesUndoStack.push(cloneNotesState());
    restoreNotesSnapshot(next);
  }

  function noteById(id) { return notesState.nodes[String(id)] || null; }
  function noteId() { noteIdCounter += 1; return 'note-' + Date.now() + '-' + noteIdCounter; }
  function noteDepth(id, baseId = 'root') {
    let depth = 0; let node = noteById(id); const seen = new Set();
    while (node && node.parentId && node.parentId !== baseId && !seen.has(node.id)) { seen.add(node.id); depth += 1; node = noteById(node.parentId); }
    return depth;
  }
  function notePath(id) {
    const path = []; let node = noteById(id); const seen = new Set();
    while (node && node.id !== 'root' && !seen.has(node.id)) { path.unshift(node.text.trim() || '未命名项目'); seen.add(node.id); node = noteById(node.parentId); }
    return path;
  }
  function noteSubtreeHasMatch(id, query, matches, trail = new Set()) {
    const node = noteById(id); if (!node || trail.has(id)) return false;
    const nextTrail = new Set(trail); nextTrail.add(id);
    const ownMatch = !query || node.text.toLocaleLowerCase().includes(query);
    let childMatch = false;
    node.children.forEach((childId) => { if (noteSubtreeHasMatch(childId, query, matches, nextTrail)) childMatch = true; });
    if (ownMatch || childMatch) matches.add(id);
    return ownMatch || childMatch;
  }
  function visibleNoteIds(query) {
    const ids = []; const matching = new Set();
    const scopeRoot = noteById(notesZoomRootId) || noteById('root');
    if (query) noteSubtreeHasMatch(scopeRoot.id, query, matching);
    const walk = (parentId, trail = new Set()) => {
      const parent = noteById(parentId); if (!parent) return;
      if (trail.has(parentId)) return;
      const nextTrail = new Set(trail); nextTrail.add(parentId);
      parent.children.forEach((id) => {
        const node = noteById(id); if (!node || (query && !matching.has(id))) return;
        ids.push(id);
        if (!node.collapsed || query) walk(id, nextTrail);
      });
    };
    walk(scopeRoot.id); return { ids, matching, scopeRoot };
  }

  function resizeNoteInput(input) { input.style.height = 'auto'; input.style.height = Math.max(28, input.scrollHeight) + 'px'; }
  function noteSelection(input) {
    return { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
  }
  function focusNote(id, selection = null) {
    const input = notesOutline?.querySelector('.note-input[data-note-id="' + CSS.escape(String(id)) + '"]');
    if (!input) return;
    input.scrollIntoView({ block: 'nearest' });
    input.focus({ preventScroll: true });
    const start = Math.max(0, Math.min(input.value.length, Number(selection?.start ?? input.value.length)));
    const end = Math.max(start, Math.min(input.value.length, Number(selection?.end ?? start)));
    input.setSelectionRange(start, end, selection?.direction || 'none');
  }
  function renderNotes(focusId = null, focusSelection = null) {
    if (!notesOutline || !notesLoaded) { if (notesOutline) notesOutline.textContent = '正在加载笔记…'; if (addNoteButton) addNoteButton.disabled = true; return; }
    if (addNoteButton) addNoteButton.disabled = false;
    const focusRestoreToken = ++notesFocusRestoreToken;
    // Rebuilding the list replaces the textarea, so carry its selection across the render.
    let selection = focusSelection;
    const activeInput = document.activeElement?.matches?.('.note-input') ? document.activeElement : null;
    if (!focusId && activeInput?.dataset.noteId) {
      focusId = activeInput.dataset.noteId;
      selection = noteSelection(activeInput);
    } else if (focusId && !selection && activeInput?.dataset.noteId === String(focusId)) {
      selection = noteSelection(activeInput);
    }
    const query = String(notesSearchInput?.value || '').trim().toLocaleLowerCase();
    const visible = visibleNoteIds(query); notesOutline.classList.toggle('zoomed', visible.scopeRoot?.id !== 'root'); notesOutline.replaceChildren();
    if (notesSearchResult) {
      const matchCount = query ? Object.values(notesState.nodes).filter((node) => node.id !== 'root' && node.id !== notesZoomRootId && node.text.toLocaleLowerCase().includes(query) && (notesZoomRootId === 'root' || isNoteDescendant(node.id, notesZoomRootId))).length : 0;
      notesSearchResult.textContent = query ? ('找到 ' + matchCount + ' 项') : '';
    }
    if (visible.scopeRoot && visible.scopeRoot.id !== 'root') {
      const heading = document.createElement('div');
      heading.className = 'notes-zoom-heading';
      heading.textContent = visible.scopeRoot.text.trim() || '未命名项目';
      notesOutline.append(heading);
    }
    if (!visible.ids.length) {
      const empty = document.createElement('div'); empty.className = 'notes-empty'; empty.textContent = query ? '没有匹配的笔记' : (visible.scopeRoot?.id === 'root' ? '还没有笔记项目，点击“新建项目”开始。' : '这个项目还没有子项目，按 Enter 新建。'); notesOutline.append(empty);
    } else visible.ids.forEach((id) => {
      const node = noteById(id); const row = document.createElement('div'); row.className = 'note-row' + (node.completed ? ' completed' : '') + (query && node.text.toLocaleLowerCase().includes(query) ? ' search-match' : ''); row.dataset.noteId = id; row.draggable = true; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(noteDepth(id, visible.scopeRoot?.id || 'root') + 1)); row.setAttribute('aria-expanded', node.children.length ? String(!node.collapsed) : 'false'); row.style.paddingLeft = (6 + noteDepth(id, visible.scopeRoot?.id || 'root') * 24) + 'px';
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'note-toggle' + (node.collapsed ? ' collapsed' : ''); toggle.disabled = !node.children.length; toggle.setAttribute('aria-label', node.children.length ? (node.collapsed ? '展开项目' : '收起项目') : '没有子项目'); toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 6 5-6"></path></svg>'; toggle.addEventListener('click', () => { if (!node.children.length) return; const before = cloneNotesState(); node.collapsed = !node.collapsed; pushNotesHistory(before); node.updatedAt = Date.now(); scheduleNotesSave(); renderNotes(id); });
      const complete = document.createElement('button'); complete.type = 'button'; complete.className = 'note-complete'; complete.setAttribute('aria-label', node.completed ? '标记未完成' : '标记完成'); complete.title = node.completed ? '标记未完成' : '标记完成'; complete.innerHTML = node.completed ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle></svg>'; complete.addEventListener('click', () => { const before = cloneNotesState(); node.completed = !node.completed; node.updatedAt = Date.now(); pushNotesHistory(before); scheduleNotesSave(); renderNotes(id); });
      const bullet = document.createElement('span'); bullet.className = 'note-bullet'; bullet.setAttribute('aria-hidden', 'true');
      const input = document.createElement('textarea'); input.className = 'note-input'; input.rows = 1; input.value = node.text; input.placeholder = '输入项目内容'; input.setAttribute('aria-label', '大纲项目'); input.dataset.noteId = id; input.addEventListener('input', () => { beginNotesHistory(id); node.text = input.value; node.updatedAt = Date.now(); resizeNoteInput(input); updateNotesBreadcrumb(id); scheduleNotesSave(); }); input.addEventListener('focus', () => { notesActiveId = id; notesTypingHistoryId = null; notesTypingBeforeState = cloneNotesState(); updateNotesBreadcrumb(id); });
      input.addEventListener('keydown', (event) => handleNoteKeydown(event, id, input));
      const drag = document.createElement('span'); drag.className = 'note-drag'; drag.textContent = '⋮⋮'; drag.title = '拖动项目'; drag.setAttribute('aria-hidden', 'true');
      const zoom = document.createElement('button'); zoom.type = 'button'; zoom.className = 'note-zoom'; zoom.setAttribute('aria-label', '专注此项目'); zoom.title = '专注此项目'; zoom.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H4v4M16 4h4v4M8 20H4v-4M20 20h-4v-4"></path></svg>'; zoom.addEventListener('click', () => zoomIntoNote(id));
      row.append(toggle, complete, bullet, input, zoom, drag);
      row.addEventListener('dragstart', (event) => { draggedItem = { type: 'note', id }; row.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id); });
      row.addEventListener('dragend', () => { draggedItem = null; row.classList.remove('dragging', 'drag-target-before', 'drag-target-inside', 'drag-target-after'); });
      row.addEventListener('dragover', (event) => { if (draggedItem?.type !== 'note' || draggedItem.id === id || isNoteDescendant(id, draggedItem.id)) return; event.preventDefault(); const rect = row.getBoundingClientRect(); const ratio = (event.clientY - rect.top) / Math.max(1, rect.height); const zone = ratio < .27 ? 'before' : (ratio > .73 ? 'after' : 'inside'); row.classList.toggle('drag-target-before', zone === 'before'); row.classList.toggle('drag-target-inside', zone === 'inside'); row.classList.toggle('drag-target-after', zone === 'after'); event.dataTransfer.dropEffect = 'move'; row.dataset.dropZone = zone; });
      row.addEventListener('dragleave', () => { row.classList.remove('drag-target-before', 'drag-target-inside', 'drag-target-after'); delete row.dataset.dropZone; });
      row.addEventListener('drop', (event) => { event.preventDefault(); const zone = row.dataset.dropZone || 'after'; row.classList.remove('drag-target-before', 'drag-target-inside', 'drag-target-after'); if (draggedItem?.type === 'note') moveNote(draggedItem.id, id, zone); });
      notesOutline.append(row); resizeNoteInput(input);
    });
    updateNotesBreadcrumb(notesActiveId);
    if (focusId) {
      focusNote(focusId, selection);
      window.requestAnimationFrame(() => {
        if (focusRestoreToken !== notesFocusRestoreToken) return;
        const current = document.activeElement;
        if (current === document.body || current === document.documentElement || !current || !notesOutline.contains(current)) focusNote(focusId, selection);
      });
    }
  }
  function updateNotesBreadcrumb(id) {
    if (!notesBreadcrumb) return;
    const zoomPath = notePath(notesZoomRootId);
    const path = notesZoomRootId !== 'root' ? zoomPath : notePath(id || notesActiveId);
    notesBreadcrumb.textContent = path.length ? path.join(' / ') : '根目录';
    if (notesHomeButton) notesHomeButton.textContent = notesZoomRootId === 'root' ? '根目录' : '返回上级';
  }
  function zoomIntoNote(id) {
    const node = noteById(id); if (!node) return;
    notesZoomRootId = node.id; notesActiveId = node.id; notesSearchInput.value = '';
    renderNotes(); updateNotesBreadcrumb(id);
  }
  function zoomOutNotes() {
    const node = noteById(notesZoomRootId);
    notesZoomRootId = node?.parentId && noteById(node.parentId) ? node.parentId : 'root';
    notesActiveId = notesZoomRootId === 'root' ? null : notesZoomRootId;
    renderNotes(); updateNotesBreadcrumb(notesActiveId);
  }
  function isNoteDescendant(candidateId, ancestorId) { let node = noteById(candidateId); const seen = new Set(); while (node && node.parentId && !seen.has(node.id)) { if (node.parentId === ancestorId) return true; seen.add(node.id); node = noteById(node.parentId); } return false; }
  function moveNote(sourceId, targetId, placement = 'after') {
    const source = noteById(sourceId); const target = noteById(targetId);
    if (!source || !target || sourceId === targetId || isNoteDescendant(targetId, sourceId)) return;
    const oldParent = noteById(source.parentId); if (!oldParent) return;
    const before = cloneNotesState();
    oldParent.children = oldParent.children.filter((id) => id !== sourceId);
    let newParent; let index;
    if (placement === 'inside') {
      newParent = target; index = target.children.length; target.collapsed = false;
    } else {
      newParent = noteById(target.parentId) || noteById('root');
      index = newParent.children.indexOf(targetId) + (placement === 'after' ? 1 : 0);
    }
    if (!newParent || index < 0) return;
    source.parentId = newParent.id; source.updatedAt = Date.now(); newParent.children.splice(Math.min(index, newParent.children.length), 0, sourceId);
    pushNotesHistory(before); notesActiveId = sourceId; scheduleNotesSave(); renderNotes(sourceId);
  }
  function insertNoteAfter(id, text = '', historyBefore = null) {
    const current = noteById(id);
    if (!current) return null;
    const parent = noteById(current.parentId) || noteById('root');
    const index = parent.children.indexOf(id);
    if (index < 0) return null;
    const before = historyBefore || cloneNotesState();
    const child = { id: noteId(), parentId: parent.id, children: [], text, collapsed: false };
    child.createdAt = Date.now(); child.updatedAt = child.createdAt;
    notesState.nodes[child.id] = child;
    parent.children.splice(index + 1, 0, child.id);
    notesActiveId = child.id;
    pushNotesHistory(before);
    scheduleNotesSave();
    renderNotes(child.id);
    return child;
  }
  function insertNoteChild(parentId, text = '') {
    const parent = noteById(parentId); if (!parent) return null;
    const before = cloneNotesState(); const now = Date.now();
    const child = { id: noteId(), parentId: parent.id, children: [], text, collapsed: false, completed: false, createdAt: now, updatedAt: now };
    notesState.nodes[child.id] = child; parent.children.push(child.id); parent.collapsed = false; notesActiveId = child.id;
    pushNotesHistory(before); scheduleNotesSave(); renderNotes(child.id); return child;
  }
  function removeNote(id) {
    const node = noteById(id); if (!node || id === 'root') return null; const parent = noteById(node.parentId) || noteById('root'); const index = parent.children.indexOf(id); if (index < 0) return null;
    const before = cloneNotesState();
    const promoted = [...node.children]; promoted.forEach((childId) => { const child = noteById(childId); if (child) child.parentId = parent.id; });
    parent.children.splice(index, 1, ...promoted); delete notesState.nodes[id];
    const nextId = parent.children[Math.max(0, Math.min(index, parent.children.length - 1))] || parent.id; pushNotesHistory(before); notesActiveId = nextId === 'root' ? null : nextId; scheduleNotesSave(); renderNotes(nextId === 'root' ? null : nextId); return nextId;
  }
  function changeNoteIndent(id, outdent, input = null) {
    const node = noteById(id); const parent = node && noteById(node.parentId); if (!node || !parent) return;
    const before = cloneNotesState(); let changed = false;
    if (!outdent) { const index = parent.children.indexOf(id); if (index <= 0) return; const previous = noteById(parent.children[index - 1]); if (!previous) return; parent.children.splice(index, 1); previous.children.push(id); previous.collapsed = false; node.parentId = previous.id; changed = true; }
    else if (parent.id !== 'root') { const grand = noteById(parent.parentId); if (!grand) return; parent.children = parent.children.filter((childId) => childId !== id); const index = grand.children.indexOf(parent.id); grand.children.splice(index + 1, 0, id); node.parentId = grand.id; changed = true; }
    if (changed) { node.updatedAt = Date.now(); pushNotesHistory(before); scheduleNotesSave(); renderNotes(id, input ? noteSelection(input) : null); }
  }
  function mergeNoteWithPrevious(id, input) {
    const node = noteById(id); const parent = node && noteById(node.parentId); if (!node || !parent) return false;
    const index = parent.children.indexOf(id); if (index <= 0) return false;
    const previous = noteById(parent.children[index - 1]); if (!previous) return false;
    const before = cloneNotesState(); const joinAt = previous.text.length;
    previous.text += node.text; previous.updatedAt = Date.now(); parent.children.splice(index, 1);
    node.children.forEach((childId) => { const child = noteById(childId); if (child) child.parentId = previous.id; }); previous.children.push(...node.children); delete notesState.nodes[id];
    pushNotesHistory(before); notesActiveId = previous.id; scheduleNotesSave(); renderNotes(previous.id, { start: joinAt, end: joinAt }); return true;
  }
  function handleNoteKeydown(event, id, input) {
    if (event.isComposing) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redoNotes() : undoNotes(); return; }
    if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); redoNotes(); return; }
    if (event.key === 'Escape') { if (notesZoomRootId !== 'root') { event.preventDefault(); zoomOutNotes(); } else if (notesSearchInput.value) { notesSearchInput.value = ''; renderNotes(id); } return; }
    if (modifier && event.key === 'Enter') { event.preventDefault(); const node = noteById(id); if (!node) return; const before = cloneNotesState(); node.completed = !node.completed; node.updatedAt = Date.now(); pushNotesHistory(before); scheduleNotesSave(); renderNotes(id, noteSelection(input)); return; }
    if (modifier && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); changeNoteIndent(id, event.key === 'ArrowLeft', input); return; }
    if (modifier && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); const node = noteById(id); const parent = node && noteById(node.parentId); const index = parent?.children.indexOf(id) ?? -1; const targetId = parent?.children[index + (event.key === 'ArrowUp' ? -1 : 1)]; if (targetId) moveNote(id, targetId, event.key === 'ArrowUp' ? 'before' : 'after'); return;
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); const cursor = input.selectionStart; const beforeText = input.value.slice(0, cursor); const after = input.value.slice(input.selectionEnd); const node = noteById(id); const beforeState = cloneNotesState(); if (node) node.text = beforeText; insertNoteAfter(id, after, beforeState); return; }
    if (event.key === 'Tab') { event.preventDefault(); changeNoteIndent(id, event.shiftKey, input); return; }
    if (event.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) { event.preventDefault(); if (input.value) mergeNoteWithPrevious(id, input); else removeNote(id); return; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { const inputs = Array.from(notesOutline.querySelectorAll('.note-input')); const index = inputs.indexOf(input); const next = inputs[index + (event.key === 'ArrowUp' ? -1 : 1)]; if (next && (event.key === 'ArrowUp' ? input.selectionStart === 0 : input.selectionStart === input.value.length)) { event.preventDefault(); next.focus(); next.setSelectionRange(event.key === 'ArrowUp' ? next.value.length : 0, event.key === 'ArrowUp' ? next.value.length : 0); } }
  }
  function addNote() { const target = notesActiveId && noteById(notesActiveId) ? notesActiveId : null; if (target && notesZoomRootId !== 'root' && target === notesZoomRootId) return insertNoteChild(target); if (target) return insertNoteAfter(target); const root = noteById(notesZoomRootId) || noteById('root'); const before = cloneNotesState(); const now = Date.now(); const node = { id: noteId(), parentId: root.id, children: [], text: '', collapsed: false, completed: false, createdAt: now, updatedAt: now }; notesState.nodes[node.id] = node; root.children.push(node.id); root.collapsed = false; notesActiveId = node.id; pushNotesHistory(before); scheduleNotesSave(); renderNotes(node.id); }
  function setAllNotesCollapsed(collapsed) { const before = cloneNotesState(); Object.values(notesState.nodes).forEach((node) => { if (node.id !== 'root' && node.children.length) node.collapsed = collapsed; }); pushNotesHistory(before); scheduleNotesSave(); renderNotes(); }
  function downloadNotesFile(content, filename, type) { const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0); }
  function exportNotes() { downloadNotesFile(JSON.stringify(notesState, null, 2), 'quickfind-notes.json', 'application/json'); }
  function markdownNotesLines(parentId, depth = 0, lines = []) { const parent = noteById(parentId); if (!parent) return lines; parent.children.forEach((id) => { const node = noteById(id); if (!node) return; lines.push('  '.repeat(depth) + '- ' + (node.completed ? '[x] ' : '') + node.text.replace(/\r?\n/g, ' ')); markdownNotesLines(id, depth + 1, lines); }); return lines; }
  function exportNotesMarkdown() { downloadNotesFile(markdownNotesLines('root').join('\n') + '\n', 'quickfind-notes.md', 'text/markdown'); }
  function parseMarkdownNotes(text) {
    const state = createEmptyNotes(); const stack = [{ depth: -1, id: 'root' }];
    String(text || '').split(/\r?\n/).forEach((line) => { if (!line.trim()) return; const match = line.match(/^(\s*)(?:[-*+]\s+|\d+[.)]\s+)?(.*)$/); if (!match || !match[2].trim()) return; const depth = Math.floor(match[1].replace(/\t/g, '  ').length / 2); const raw = match[2].trim(); const completed = /^\[x\]\s+/i.test(raw); const value = raw.replace(/^\[[ xX]\]\s+/, ''); while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop(); const parentNode = state.nodes[stack[stack.length - 1]?.id || 'root']; const now = Date.now(); const node = { id: 'note-import-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), parentId: parentNode.id, children: [], text: value, collapsed: false, completed, createdAt: now, updatedAt: now }; state.nodes[node.id] = node; parentNode.children.push(node.id); stack.push({ depth, id: node.id }); }); return state;
  }
  function importNotes(file) { if (!file) return; const reader = new FileReader(); reader.onload = () => { try { const content = String(reader.result || ''); const parsed = /\.m(?:d|arkdown)$/i.test(file.name || '') ? parseMarkdownNotes(content) : JSON.parse(content); const normalized = normalizeNotes(parsed); if (Object.keys(normalized.nodes).length <= 1 && content.trim()) throw new Error(); const before = cloneNotesState(); notesState = normalized; notesUndoStack.push(before); if (notesUndoStack.length > NOTES_HISTORY_LIMIT) notesUndoStack.shift(); notesRedoStack = []; notesActiveId = null; notesZoomRootId = 'root'; updateNotesHistoryButtons(); scheduleNotesSave(); renderNotes(); } catch { window.alert('导入失败：请选择有效的 JSON 或 Markdown 大纲文件。'); } }; reader.readAsText(file); }

  function renderHistory() {
    if (!historyRecordList || !settings) return;
    const history = settings.searchHistory || [];
    Array.from(selectedHistoryIndexes).forEach((index) => {
      if (index < 0 || index >= history.length) selectedHistoryIndexes.delete(index);
    });
    historyRecordList.replaceChildren();
    if (!history.length) {
      historyRecordList.innerHTML = '<div class="history-empty">暂无搜索历史</div>';
    } else {
      history.forEach((entry, index) => {
        const row = document.createElement('div');
        row.className = 'history-record';
        const select = document.createElement('label');
        select.className = 'check';
        select.title = '选择历史记录';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = selectedHistoryIndexes.has(index);
        input.setAttribute('aria-label', '选择历史记录：' + entry.query);
        input.addEventListener('change', () => {
          if (input.checked) selectedHistoryIndexes.add(index);
          else selectedHistoryIndexes.delete(index);
          renderHistory();
        });
        const checkmark = document.createElement('span');
        checkmark.className = 'checkmark';
        select.append(input, checkmark);
        const query = document.createElement('span');
        query.className = 'history-record-query';
        query.textContent = entry.query;
        query.title = entry.query;
        const time = document.createElement('time');
        const timestamp = Number(entry.timestamp);
        if (Number.isFinite(timestamp) && Math.abs(timestamp) <= 8640000000000000) time.dateTime = new Date(timestamp).toISOString();
        time.textContent = formatHistoryTimestamp(timestamp);
        const actions = document.createElement('div');
        actions.className = 'history-record-actions';
        actions.append(
          iconButton('copy', '复制历史记录', () => copyHistoryEntry(entry, actions.firstElementChild)),
          iconButton('remove', '删除历史记录', () => removeHistoryAt(index))
        );
        row.append(select, query, time, actions);
        historyRecordList.append(row);
      });
    }
    if (historySelectionCount) historySelectionCount.textContent = '已选 ' + selectedHistoryIndexes.size + ' 项';
    const allSelected = history.length > 0 && selectedHistoryIndexes.size === history.length;
    if (selectAllHistory) {
      selectAllHistory.disabled = history.length === 0;
      selectAllHistory.setAttribute('aria-pressed', String(allSelected));
      selectAllHistory.setAttribute('aria-label', allSelected ? '取消全选历史记录' : '全选历史记录');
      selectAllHistory.title = allSelected ? '取消全选历史记录' : '全选历史记录';
      selectAllHistory.innerHTML = allSelected
        ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"></rect><path d="m8 12 2.5 2.5L16 9"></path></svg>'
        : '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3"></rect></svg>';
    }
    if (deleteSelectedHistory) deleteSelectedHistory.disabled = selectedHistoryIndexes.size === 0;
    if (clearHistory) clearHistory.disabled = history.length === 0;
  }

  function fallbackCopyText(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text; textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
    document.body.append(textarea);
    try {
      textarea.select();
      return document.execCommand('copy');
    } finally {
      textarea.remove();
    }
  }

  async function copyHistoryEntry(entry, button) {
    if (!entry?.query || !button) return;
    const copyText = String(entry.query);
    try {
      if (navigator.clipboard?.writeText) {
        try { await navigator.clipboard.writeText(copyText); }
        catch { if (!fallbackCopyText(copyText)) throw new Error('copy failed'); }
      } else if (!fallbackCopyText(copyText)) {
        throw new Error('copy failed');
      }
      clearTimeout(button._copyFeedbackTimer);
      const originalLabel = button.dataset.originalLabel || '复制历史记录';
      button.dataset.originalLabel = originalLabel;
      button.setAttribute('aria-label', '已复制'); button.title = '已复制';
      button._copyFeedbackTimer = window.setTimeout(() => {
        button.setAttribute('aria-label', originalLabel); button.title = originalLabel;
      }, 1200);
    } catch {
      button.setAttribute('aria-label', '复制失败'); button.title = '复制失败';
      clearTimeout(button._copyFeedbackTimer);
      button._copyFeedbackTimer = window.setTimeout(() => {
        button.setAttribute('aria-label', '复制历史记录'); button.title = '复制历史记录';
      }, 1200);
    }
  }

  function removeHistoryAt(index) {
    const history = settings?.searchHistory;
    if (!Array.isArray(history) || index < 0 || index >= history.length) return;
    history.splice(index, 1);
    const nextSelection = new Set();
    selectedHistoryIndexes.forEach((selectedIndex) => {
      if (selectedIndex < index) nextSelection.add(selectedIndex);
      else if (selectedIndex > index) nextSelection.add(selectedIndex - 1);
    });
    selectedHistoryIndexes.clear();
    nextSelection.forEach((selectedIndex) => selectedHistoryIndexes.add(selectedIndex));
    saveHistory();
    renderHistory();
  }

  pinnedSiteList?.addEventListener('change', () => {
    if (!settings) return;
    settings.pinned.sites = Array.from(pinnedSiteList.querySelectorAll('input[data-site-id]:checked')).map((input) => input.dataset.siteId);
    savePinned();
  });

  function iconButton(kind, title, handler) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'icon-button'; button.title = title; button.setAttribute('aria-label', title);
    const icons = {
      fetch: '<svg viewBox="0 0 24 24"><path d="M20 11a8.1 8.1 0 0 0-14.7-4.7L3 9"></path><path d="M3 4v5h5"></path><path d="M4 13a8.1 8.1 0 0 0 14.7 4.7L21 15"></path><path d="M21 20v-5h-5"></path></svg>',
      copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>',
      edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"></path></svg>',
      remove: '<svg viewBox="0 0 24 24"><path d="M3 6h18"></path><path d="M8 6V4h8v2M19 6l-1 14H6L5 6"></path></svg>'
    };
    button.innerHTML = icons[kind]; button.addEventListener('click', handler); return button;
  }

  function makeLogo(source) {
    const logo = document.createElement('button');
    logo.type = 'button'; logo.className = 'source-logo source-logo-button ' + source.className;
    logo.title = source.iconUrl ? '恢复原始图标' : '更改图标';
    logo.setAttribute('aria-label', (source.iconUrl ? '恢复' : '更改') + source.name + '的图标');
    if (source.iconUrl) {
      const iconUrl = String(source.iconUrl);
      let cached = iconNodeCache.get(source.id);
      if (!cached || cached.url !== iconUrl) {
        const image = document.createElement('img');
        image.alt = '';
        image.decoding = 'async';
        image.loading = 'eager';
        cached = { url: iconUrl, image, failed: false };
        iconNodeCache.set(source.id, cached);
        image.addEventListener('error', () => {
          cached.failed = true;
          const parent = image.parentElement;
          image.remove();
          if (parent && !parent.childElementCount) parent.textContent = source.mark;
        });
        image.src = iconUrl;
      }
      if (!cached.failed) logo.append(cached.image);
    }
    if (!logo.childElementCount) logo.textContent = source.mark;
    logo.addEventListener('click', () => source.iconUrl ? restoreSourceIcon(source) : openIconEditor(source));
    return logo;
  }

  function addDragBehavior(row, item) {
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      const selected = item.type === 'source' ? selectedSourceIds[item.panel] : null;
      const ids = selected?.has(item.id) ? Array.from(selected) : [item.id];
      draggedItem = { ...item, ids };
      row.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', ids.join(','));
    });
    row.addEventListener('dragend', () => {
      draggedItem = null;
      document.querySelectorAll('.drag-before,.drag-after,.dragging').forEach((element) => element.classList.remove('drag-before', 'drag-after', 'dragging'));
    });
    row.addEventListener('dragover', (event) => {
      if (!draggedItem || draggedItem.panel !== activePanel || (draggedItem.ids || [draggedItem.id]).includes(item.id)) return;
      event.preventDefault();
      const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
      row.classList.toggle('drag-before', !after); row.classList.toggle('drag-after', after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-before', 'drag-after'));
    row.addEventListener('drop', (event) => {
      event.preventDefault(); row.classList.remove('drag-before', 'drag-after');
      if (!draggedItem || draggedItem.panel !== activePanel || (draggedItem.ids || [draggedItem.id]).includes(item.id)) return;
      reorderActiveItem(draggedItem.ids || draggedItem.id, item.id, event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2);
    });
  }

  function createSourceRow(source) {
    const row = document.createElement('div');
    row.className = 'source-row'; row.dataset.sourceId = source.id;
    addDragBehavior(row, { panel: activePanel, id: source.id, type: 'source' });
    const handle = document.createElement('span');
    handle.className = 'drag-handle'; handle.textContent = '⠿'; handle.title = '拖动排序，或拖到分组标签中移动'; handle.setAttribute('aria-hidden', 'true');
    const select = document.createElement('label');
    select.className = 'source-select'; select.title = '选择搜索源';
    const selectInput = document.createElement('input');
    selectInput.type = 'checkbox'; selectInput.checked = selectedSourceIds[activePanel].has(source.id); selectInput.setAttribute('aria-label', '选择' + source.name);
    selectInput.addEventListener('change', () => { if (selectInput.checked) selectedSourceIds[activePanel].add(source.id); else selectedSourceIds[activePanel].delete(source.id); renderBatchActions(); });
    select.append(selectInput);
    const meta = document.createElement('div');
    meta.className = 'source-meta';
    const sourceName = document.createElement('strong');
    sourceName.textContent = source.name;
    const sourceDetail = document.createElement('small');
    sourceDetail.textContent = source.detail || source.url;
    meta.append(sourceName, sourceDetail);
    const actions = document.createElement('div');
    actions.className = 'source-actions';
    actions.append(iconButton('fetch', '获取网站图标', () => fetchSourceIcon(source)), iconButton('edit', '编辑搜索源', () => startEdit(source)), iconButton('remove', '删除搜索源', () => removeSource(source.id)));
    const iconOnly = document.createElement('label');
    iconOnly.className = 'icon-only-setting'; iconOnly.title = '仅显示图标';
    const iconOnlyInput = document.createElement('input');
    iconOnlyInput.type = 'checkbox'; iconOnlyInput.checked = source.iconOnly; iconOnlyInput.setAttribute('aria-label', source.name + '仅显示图标');
    iconOnlyInput.addEventListener('change', (event) => { source.iconOnly = event.target.checked; saveCurrent(); });
    iconOnly.append(iconOnlyInput);
    const enabled = document.createElement('label');
    enabled.className = 'check'; enabled.title = '启用搜索源';
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox'; enabledInput.checked = source.enabled; enabledInput.setAttribute('aria-label', source.name + '启用');
    const enabledMark = document.createElement('span');
    enabledMark.className = 'checkmark';
    enabledInput.addEventListener('change', (event) => { source.enabled = event.target.checked; saveCurrent(); });
    enabled.append(enabledInput, enabledMark);
    row.append(handle, select, makeLogo(source), meta, actions, iconOnly, enabled);
    return row;
  }

  function createSpecialActionRow(action) {
    const row = document.createElement('div');
    const token = specialActionToken(action.id);
    row.className = 'source-row special-action-row'; row.dataset.actionId = action.id;
    addDragBehavior(row, { panel: activePanel, id: token, type: 'action' });
    const handle = document.createElement('span');
    handle.className = 'drag-handle'; handle.textContent = '⠿'; handle.title = '拖动调整位置，或拖到分组标签中移动'; handle.setAttribute('aria-hidden', 'true');
    const logo = document.createElement('span');
    logo.className = 'source-logo ' + action.className; logo.textContent = action.mark;
    const meta = document.createElement('div');
    meta.className = 'source-meta';
    const name = document.createElement('strong'); name.textContent = action.name;
    const detail = document.createElement('small'); detail.textContent = action.detail;
    meta.append(name, detail);
    const actions = document.createElement('div');
    actions.className = 'source-actions';
    actions.append(iconButton('remove', '从分组移除', () => removeSpecialAction(action.id)));
    row.append(handle, logo, meta, actions);
    return row;
  }

  function createGroupRow(group) {
    const token = 'group:' + group.id;
    const row = document.createElement('div');
    row.className = 'source-row derived-group-row'; row.dataset.groupId = group.id;
    addDragBehavior(row, { panel: activePanel, id: token, type: 'group' });
    const handle = document.createElement('span');
    handle.className = 'drag-handle'; handle.textContent = '⠿'; handle.title = '拖动排序'; handle.setAttribute('aria-hidden', 'true');
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'source-logo source-logo-button group'; open.title = '打开' + group.name; open.textContent = '组';
    open.addEventListener('click', () => { activeGroupId[activePanel] = group.id; renderManager(); });
    const meta = document.createElement('button');
    meta.type = 'button'; meta.className = 'source-meta group-meta-button'; meta.title = '打开' + group.name;
    const groupName = document.createElement('strong');
    groupName.textContent = group.name;
    const groupDetail = document.createElement('small');
    groupDetail.textContent = group.items.length + ' 个搜索源';
    meta.append(groupName, groupDetail);
    meta.addEventListener('click', () => { activeGroupId[activePanel] = group.id; renderManager(); });
    const actions = document.createElement('div');
    actions.className = 'source-actions';
    actions.append(iconButton('edit', '重命名分组', () => renameGroup(group)), iconButton('remove', '删除分组', () => removeGroup(group.id)));
    const spacer = document.createElement('span');
    spacer.className = 'source-control-spacer';
    const visible = document.createElement('label');
    visible.className = 'check'; visible.title = '在搜索列表中显示';
    const visibleInput = document.createElement('input');
    visibleInput.type = 'checkbox'; visibleInput.checked = group.visible; visibleInput.setAttribute('aria-label', group.name + '在搜索列表中显示');
    const visibleMark = document.createElement('span');
    visibleMark.className = 'checkmark';
    visibleInput.addEventListener('change', (event) => { group.visible = event.target.checked; saveCurrent(); });
    visible.append(visibleInput, visibleMark);
    row.append(handle, open, meta, actions, spacer, visible);
    return row;
  }

  function renderGroups() {
    groupList.replaceChildren();
    config().groups.forEach((group) => {
      const tab = document.createElement('button');
      tab.type = 'button'; tab.className = 'group-tab' + (group.id === activeGroupId[activePanel] ? ' active' : '');
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(group.id === activeGroupId[activePanel])); tab.textContent = group.name;
      tab.draggable = group.id !== 'default';
      tab.title = group.id === 'default' ? '默认组，可拖入搜索源或特殊功能按钮' : '打开' + group.name + '，可将搜索源或特殊功能按钮拖到此处，也可拖动标签调整分组顺序';
      tab.addEventListener('click', () => { activeGroupId[activePanel] = group.id; resetForm(); renderManager(); });
      tab.addEventListener('dragstart', (event) => {
        if (group.id === 'default') return;
        draggedItem = { panel: activePanel, id: group.id, type: 'group-tab' };
        tab.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', 'group:' + group.id);
      });
      tab.addEventListener('dragend', () => {
        draggedItem = null;
        document.querySelectorAll('.group-tab.drag-before,.group-tab.drag-after,.group-tab.dragging').forEach((element) => element.classList.remove('drag-before', 'drag-after', 'dragging'));
      });
      tab.addEventListener('dragover', (event) => {
        if (!draggedItem || draggedItem.panel !== activePanel) return;
        if (draggedItem.type === 'group-tab') {
          if (group.id === 'default' || draggedItem.id === group.id) return;
          event.preventDefault();
          const after = event.clientX > tab.getBoundingClientRect().left + tab.offsetWidth / 2;
          tab.classList.toggle('drag-before', !after); tab.classList.toggle('drag-after', after);
          return;
        }
        if (!['source', 'action'].includes(draggedItem.type)) return;
        event.preventDefault(); tab.classList.add('drop-target');
      });
      tab.addEventListener('dragleave', () => tab.classList.remove('drop-target', 'drag-before', 'drag-after'));
      tab.addEventListener('drop', (event) => {
        if (!draggedItem || draggedItem.panel !== activePanel) return;
        event.preventDefault();
        const after = event.clientX > tab.getBoundingClientRect().left + tab.offsetWidth / 2;
        const item = draggedItem;
        tab.classList.remove('drop-target', 'drag-before', 'drag-after');
        if (item.type === 'group-tab') {
          if (group.id !== 'default' && item.id !== group.id) reorderGroupTab(item.id, group.id, after);
        } else if (['source', 'action'].includes(item.type)) {
          moveItemsToGroup(item.ids || item.id, group.id);
        }
      });
      groupList.append(tab);
    });
  }

  function renderSources() {
    sourceList.replaceChildren();
    const group = activeGroup();
    group.items.forEach((item) => {
      if (item.startsWith('group:')) {
        const customGroup = groupById(item.slice(6));
        if (group.id === 'default' && customGroup) sourceList.append(createGroupRow(customGroup));
        return;
      }
      const specialAction = specialActionByToken(item);
      if (specialAction) {
        sourceList.append(createSpecialActionRow(specialAction));
        return;
      }
      const source = sourceById(item);
      if (source) sourceList.append(createSourceRow(source));
    });
    if (!sourceList.childElementCount) sourceList.innerHTML = '<div class="empty">这个分组还没有搜索源</div>';
    activeGroupMeta.textContent = group.id === 'default'
      ? '默认组 · ' + group.items.length + ' 个项目（搜索源和自定义组可以一起排序）'
      : group.name + ' · ' + group.items.length + ' 个搜索源';
  }

  function renderSpecialActions() {
    if (!specialActionList || !settings) return;
    specialActionList.replaceChildren();
    SPECIAL_ACTIONS.forEach((action) => {
      const row = document.createElement('div');
      row.className = 'special-action-config';
      const logo = document.createElement('span');
      logo.className = 'source-logo ' + action.className; logo.textContent = action.mark;
      const meta = document.createElement('div');
      meta.className = 'special-action-meta';
      const name = document.createElement('strong'); name.textContent = action.name;
      const detail = document.createElement('small'); detail.textContent = action.detail;
      meta.append(name, detail);
      const select = document.createElement('select');
      select.setAttribute('aria-label', action.name + '按钮所在分组');
      const none = document.createElement('option'); none.value = ''; none.textContent = '未添加'; select.append(none);
      config().groups.forEach((group) => {
        const option = document.createElement('option'); option.value = group.id; option.textContent = group.name; select.append(option);
      });
      const token = specialActionToken(action.id);
      const currentGroup = config().groups.find((group) => group.items.includes(token));
      select.value = currentGroup?.id || '';
      select.addEventListener('change', () => setSpecialActionGroup(action.id, select.value));
      row.append(logo, meta, select);
      specialActionList.append(row);
    });
  }

  function setSpecialActionGroup(actionId, groupId) {
    const token = specialActionToken(actionId);
    config().groups.forEach((group) => { group.items = group.items.filter((item) => item !== token); });
    if (groupId) groupById(groupId)?.items.push(token);
    saveGeneral();
    renderManager();
  }

  function removeSpecialAction(actionId) {
    setSpecialActionGroup(actionId, '');
  }

  function renderManager() {
    const isPinned = activePanel === 'pinned';
    managerTitle.textContent = '搜索源分组';
    managerHelp.textContent = isPinned
      ? '与常用设置共用同一份搜索源和分组配置，调整会同步到两个搜索列表。'
      : '拖动默认组中的搜索源、特殊功能按钮或自定义组，调整两个搜索列表中的顺序。';
    renderGroups(); renderSources();
    renderSpecialActions();
    renderPinnedSiteOptions();
    renderBatchActions();
    if (pinnedDefaultGroupCountInput) pinnedDefaultGroupCountInput.value = settings.pinned.defaultGroupCount;
  }

  function renderBatchActions() {
    if (!batchActions || !settings) return;
    const selected = selectedSourceIds[activePanel];
    const valid = new Set(config().sources.map((source) => source.id));
    Array.from(selected).forEach((id) => { if (!valid.has(id)) selected.delete(id); });
    batchActions.hidden = selected.size === 0;
    if (batchCount) batchCount.textContent = '已选 ' + selected.size + ' 项';
    if (batchGroup) {
      const current = batchGroup.value;
      batchGroup.replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '移动到分组'; batchGroup.append(placeholder);
      config().groups.forEach((group) => {
        const option = document.createElement('option'); option.value = group.id; option.textContent = group.name; batchGroup.append(option);
      });
      batchGroup.value = current;
    }
  }

  function reorderActiveItem(sourceId, targetId, after) {
    const group = activeGroup();
    const ids = (Array.isArray(sourceId) ? sourceId : [sourceId]).map(String);
    const moving = group.items.filter((id) => ids.includes(id));
    const targetIndex = group.items.indexOf(targetId);
    if (!moving.length || targetIndex < 0 || moving.includes(String(targetId))) return;
    const remaining = group.items.filter((id) => !moving.includes(id));
    const nextTargetIndex = remaining.indexOf(targetId);
    remaining.splice(nextTargetIndex + (after ? 1 : 0), 0, ...moving);
    group.items = remaining;
    saveCurrent(); renderSources();
  }

  function reorderGroupTab(sourceId, targetId, after) {
    const groups = config().groups;
    if (sourceId === 'default' || targetId === 'default' || sourceId === targetId) return;
    const sourceIndex = groups.findIndex((group) => group.id === sourceId);
    const targetIndex = groups.findIndex((group) => group.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const [moving] = groups.splice(sourceIndex, 1);
    const nextTargetIndex = groups.findIndex((group) => group.id === targetId);
    groups.splice(nextTargetIndex + (after ? 1 : 0), 0, moving);
    saveCurrent(); renderGroups();
  }

  function moveItemsToGroup(itemId, groupId) {
    const target = groupById(groupId);
    const ids = Array.isArray(itemId) ? itemId : [itemId];
    const validIds = ids.map(String).filter((id) => sourceById(id) || specialActionByToken(id));
    if (!target || !validIds.length) return;
    config().groups.forEach((group) => { group.items = group.items.filter((item) => !validIds.includes(item)); });
    validIds.forEach((id) => target.items.push(id));
    validIds.forEach((id) => selectedSourceIds[activePanel].delete(id));
    saveCurrent(); renderManager();
  }

  function moveSourceToGroup(sourceId, groupId) {
    moveItemsToGroup(sourceId, groupId);
  }

  function addGroup() {
    const name = window.prompt('分组名称', '新分组');
    if (!name?.trim()) return;
    const id = 'group-' + Date.now();
    config().groups.push({ id, name: name.trim(), items: [], visible: true });
    groupById('default').items.push('group:' + id);
    activeGroupId[activePanel] = id; saveCurrent(); renderManager();
  }
  function renameGroup(group) {
    const name = window.prompt('分组名称', group.name);
    if (!name?.trim()) return;
    group.name = name.trim(); saveCurrent(); renderManager();
  }
  function removeGroup(groupId) {
    const group = groupById(groupId);
    const defaultGroup = groupById('default');
    if (!group || groupId === 'default' || !defaultGroup) return;
    const tokenIndex = defaultGroup.items.indexOf('group:' + groupId);
    if (tokenIndex >= 0) defaultGroup.items.splice(tokenIndex, 1, ...group.items);
    else defaultGroup.items.push(...group.items);
    settings.general.groups = config().groups.filter((item) => item.id !== groupId);
    activeGroupId[activePanel] = 'default'; saveCurrent(); renderManager();
  }
  function removeSource(id) {
    settings.general.sources = config().sources.filter((source) => source.id !== id);
    config().groups.forEach((group) => { group.items = group.items.filter((item) => item !== id); });
    iconNodeCache.delete(id);
    if (editing?.id === id && editing.panel === activePanel) resetForm();
    selectedSourceIds[activePanel].delete(id);
    saveCurrent(); renderManager();
  }
  function startEdit(source) {
    editing = { panel: activePanel, id: source.id };
    nameInput.value = source.name; markInput.value = source.mark; urlInput.value = source.url;
    formTitle.textContent = '编辑搜索源'; submitLabel.textContent = '保存修改'; cancelEdit.hidden = false; nameInput.focus();
  }
  function resetForm() {
    editing = null; form.reset(); formTitle.textContent = '添加搜索源'; submitLabel.textContent = '添加搜索源'; cancelEdit.hidden = true; errorEl.textContent = '';
  }
  function getFaviconUrl(source) {
    try {
      const parsed = new URL(source.url.replace(/\{query\}/gi, 'quickfind'));
      return 'https://www.google.com/s2/favicons?sz=64&domain_url=' + encodeURIComponent(parsed.origin);
    } catch { return ''; }
  }
  function fetchSourceIcon(source) {
    const iconUrl = getFaviconUrl(source);
    if (!iconUrl) return;
    iconNodeCache.delete(source.id);
    source.iconUrl = iconUrl; saveCurrent(); renderSources();
  }
  function restoreSourceIcon(source) { iconNodeCache.delete(source.id); source.iconUrl = ''; saveCurrent(); renderSources(); }
  function openIconEditor(source) {
    iconEditorSourceId = source.id; iconUrlInput.value = ''; iconFileInput.value = ''; iconEditorError.textContent = '';
    if (typeof iconEditor.showModal === 'function') iconEditor.showModal(); else iconEditor.setAttribute('open', '');
    iconUrlInput.focus();
  }
  function closeIconEditorPanel() {
    iconEditorSourceId = null;
    if (typeof iconEditor.close === 'function') iconEditor.close(); else iconEditor.removeAttribute('open');
  }
  function iconUrlFromInput(value) {
    if (!value) throw new Error('请输入图标地址。');
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('图标地址需要使用 http 或 https。');
    return parsed.href;
  }
  function setIconUrl(iconUrl) {
    const source = sourceById(iconEditorSourceId);
    if (!source) return;
    iconNodeCache.delete(source.id);
    source.iconUrl = iconUrl; saveCurrent(); renderSources(); closeIconEditorPanel();
  }
  function localFileToIconUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('请选择图片。'));
      if (file.size > 5 * 1024 * 1024) return reject(new Error('图片不能超过 5 MB。'));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('无法读取图片。'));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error('无法使用该图片。'));
        image.onload = () => {
          if (!image.naturalWidth || !image.naturalHeight) return reject(new Error('图片尺寸无效。'));
          const size = 32, scale = Math.min(size / image.naturalWidth, size / image.naturalHeight);
          const width = Math.max(1, Math.round(image.naturalWidth * scale)), height = Math.max(1, Math.round(image.naturalHeight * scale));
          const canvas = document.createElement('canvas');
          canvas.width = size; canvas.height = size;
          canvas.getContext('2d').drawImage(image, Math.round((size - width) / 2), Math.round((size - height) / 2), width, height);
          resolve(canvas.toDataURL('image/webp', 0.78));
        };
        image.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  navItems.forEach((item) => item.addEventListener('click', () => {
    const nextPanel = item.dataset.panel;
    if (nextPanel === activePanel) return;
    activePanel = nextPanel; resetForm();
    navItems.forEach((button) => {
      const selected = button === item;
      button.classList.toggle('active', selected); button.setAttribute('aria-selected', String(selected));
    });
    panels.forEach((panel) => {
      const selected = panel.dataset.panelContent === activePanel;
      panel.classList.toggle('active', selected); panel.hidden = !selected;
    });
    sourceManager.hidden = !['general', 'pinned'].includes(activePanel);
    if (activePanel === 'history') renderHistory();
    else if (activePanel === 'notes') renderNotes();
    else renderManager();
  }));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameInput.value.trim(), mark = markInput.value.trim().slice(0, 2), url = urlInput.value.trim();
    if (!name || !mark || !url) return;
    if (!url.includes('{query}')) { errorEl.textContent = 'URL 中需要包含 {query} 占位符。'; return; }
    try {
      const parsed = new URL(url.replace(/\{query\}/gi, 'quickfind'));
      if (!/^https?:$/.test(parsed.protocol)) throw new Error();
    } catch { errorEl.textContent = '请输入有效的 http 或 https 搜索 URL。'; return; }
    const source = editing?.panel === activePanel ? sourceById(editing.id) : null;
    if (source) Object.assign(source, { name, mark, url, detail: url });
    else {
      const id = 'custom-' + Date.now();
      config().sources.push({ id, name, mark, url, detail: url, iconUrl: '', className: 'custom', enabled: true, iconOnly: false });
      activeGroup().items.push(id);
    }
    saveCurrent(); resetForm(); renderManager();
  });
  pinnedSiteForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = pinnedSiteNameInput.value.trim();
    const url = pinnedSiteUrlInput.value.trim();
    const selector = pinnedSiteSelectorInput.value.trim();
    pinnedSiteError.textContent = '';
    if (!url) { pinnedSiteError.textContent = '请至少填写站点 URL。'; return; }
    if (selector) {
      try { document.querySelectorAll(selector); } catch { pinnedSiteError.textContent = 'CSS 选择器格式无效。'; return; }
    }
    if (!Array.isArray(settings.pinned.customSites)) settings.pinned.customSites = [];
    const knownSite = [...PINNED_SITES, ...getExistingSourceSites()].find((item) => item.id === pinnedSiteEditingId);
    const id = pinnedSiteEditingId || ('custom-site-' + Date.now());
    const displayName = (name || deriveSiteName(url, knownSite?.name || id)).slice(0, 24);
    const existing = settings.pinned.customSites.find((item) => item.id === id);
    if (existing) {
      Object.assign(existing, { name: displayName, url, selector });
    } else {
      settings.pinned.customSites.push({ id, name: displayName, url, selector, categorySelectors: [] });
    }
    if (!pinnedSiteEditingId) {
      if (!Array.isArray(settings.pinned.sites)) settings.pinned.sites = [];
      settings.pinned.sites.push(id);
    }
    savePinned();
    resetPinnedSiteForm();
    renderPinnedSiteOptions();
  });
  managePinnedSites?.addEventListener('click', () => {
    renderPinnedSiteOptions();
    if (typeof pinnedSiteDialog?.showModal === 'function') pinnedSiteDialog.showModal(); else pinnedSiteDialog?.setAttribute('open', '');
  });
  closePinnedSiteDialog?.addEventListener('click', () => {
    resetPinnedSiteForm();
    if (typeof pinnedSiteDialog?.close === 'function') pinnedSiteDialog.close(); else pinnedSiteDialog?.removeAttribute('open');
  });
  pinnedSiteDialog?.addEventListener('click', (event) => { if (event.target === pinnedSiteDialog) closePinnedSiteDialog?.click(); });
  pinnedSiteDialog?.addEventListener('cancel', resetPinnedSiteForm);
  cancelPinnedSiteEdit?.addEventListener('click', resetPinnedSiteForm);
  batchDelete?.addEventListener('click', () => {
    const selected = selectedSourceIds[activePanel];
    if (!selected.size) return;
    const ids = new Set(selected);
    settings.general.sources = config().sources.filter((source) => !ids.has(source.id));
    config().groups.forEach((group) => { group.items = group.items.filter((item) => !ids.has(item)); });
    selected.clear();
    if (editing && editing.panel === activePanel && ids.has(editing.id)) resetForm();
    saveCurrent(); renderManager();
  });
  selectAllHistory?.addEventListener('click', () => {
    const history = settings?.searchHistory || [];
    if (!history.length) return;
    const allSelected = selectedHistoryIndexes.size === history.length;
    selectedHistoryIndexes.clear();
    if (!allSelected) history.forEach((_entry, index) => selectedHistoryIndexes.add(index));
    renderHistory();
  });
  batchGroup?.addEventListener('change', () => {
    if (!batchGroup.value) return;
    moveSourceToGroup(Array.from(selectedSourceIds[activePanel]), batchGroup.value);
    batchGroup.value = '';
  });
  deleteSelectedHistory?.addEventListener('click', () => {
    if (!selectedHistoryIndexes.size) return;
    settings.searchHistory = settings.searchHistory.filter((_entry, index) => !selectedHistoryIndexes.has(index));
    selectedHistoryIndexes.clear();
    saveHistory();
    renderHistory();
  });
  clearHistory?.addEventListener('click', () => {
    if (!settings.searchHistory.length) return;
    settings.searchHistory = [];
    selectedHistoryIndexes.clear();
    saveHistory();
    renderHistory();
  });
  cancelEdit.addEventListener('click', resetForm);
  addGroupButton.addEventListener('click', addGroup);
  defaultGroupCountInput.addEventListener('change', () => {
    settings.defaultGroupCount = Math.max(1, Math.min(MAX_DEFAULT_GROUP_COUNT, Number(defaultGroupCountInput.value) || 4));
    defaultGroupCountInput.value = settings.defaultGroupCount; saveGeneral();
  });
  pinnedDefaultGroupCountInput.addEventListener('change', () => {
    settings.pinned.defaultGroupCount = Math.max(1, Math.min(MAX_DEFAULT_GROUP_COUNT, Number(pinnedDefaultGroupCountInput.value) || 4));
    pinnedDefaultGroupCountInput.value = settings.pinned.defaultGroupCount; savePinned();
  });
  pinnedCollapseDelayInput?.addEventListener('change', () => {
    settings.pinned.collapseDelay = Math.max(0, Math.min(60000, Number(pinnedCollapseDelayInput.value) || 0));
    pinnedCollapseDelayInput.value = settings.pinned.collapseDelay; savePinned();
  });
  pinnedAllSitesInput?.addEventListener('change', () => {
    settings.pinned.allSites = pinnedAllSitesInput.checked;
    savePinned();
  });
  selectionTriggerDelayInput?.addEventListener('change', () => {
    settings.selectionTriggerDelay = Math.max(0, Math.min(2000, Number(selectionTriggerDelayInput.value) || 0));
    selectionTriggerDelayInput.value = settings.selectionTriggerDelay; saveGeneral();
  });
  triggerInputs.forEach((input) => input.addEventListener('change', () => {
    if (!input.checked) return;
    settings.triggerMode = input.value; saveGeneral();
  }));
  editableTriggerInputs.forEach((input) => input.addEventListener('change', () => {
    if (!input.checked) return;
    settings.editableTriggerMode = input.value; saveGeneral();
  }));
  function saveLlmConfig() {
    if (!settings) return;
    settings.llm = {
      enabled: Boolean(llmEnabledInput?.checked),
      endpoint: String(llmEndpointInput?.value || DEFAULTS.llm.endpoint).trim(),
      model: String(llmModelInput?.value || DEFAULTS.llm.model).trim(),
      apiKey: String(llmApiKeyInput?.value || ''),
      systemPrompt: String(llmSystemPromptInput?.value || '').trim()
    };
    if (!settings.llm.endpoint) settings.llm.endpoint = DEFAULTS.llm.endpoint;
    if (!settings.llm.model) settings.llm.model = DEFAULTS.llm.model;
    saveGeneral();
  }
  [llmEnabledInput, llmEndpointInput, llmModelInput, llmApiKeyInput, llmSystemPromptInput].filter(Boolean).forEach((input) => {
    input.addEventListener('change', saveLlmConfig);
    if (input.tagName === 'TEXTAREA' || input.type === 'text' || input.type === 'url' || input.type === 'password') input.addEventListener('blur', saveLlmConfig);
  });
  closeIconEditor.addEventListener('click', closeIconEditorPanel);
  applyIconUrl.addEventListener('click', () => {
    try { setIconUrl(iconUrlFromInput(iconUrlInput.value.trim())); }
    catch (error) { iconEditorError.textContent = error.message || '无法使用该图标地址。'; }
  });
  iconEditor.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); applyIconUrl.click(); });
  iconFileInput.addEventListener('change', async () => {
    try { setIconUrl(await localFileToIconUrl(iconFileInput.files?.[0])); }
    catch (error) { iconEditorError.textContent = error.message || '无法使用该图片。'; }
  });
  iconEditor.addEventListener('cancel', () => { iconEditorSourceId = null; });

  addNoteButton?.addEventListener('click', addNote);
  undoNotesButton?.addEventListener('click', undoNotes);
  redoNotesButton?.addEventListener('click', redoNotes);
  expandNotesButton?.addEventListener('click', () => setAllNotesCollapsed(false));
  collapseNotesButton?.addEventListener('click', () => setAllNotesCollapsed(true));
  notesSearchInput?.addEventListener('input', () => { window.clearTimeout(notesSearchTimer); notesSearchTimer = window.setTimeout(() => renderNotes(), 120); });
  notesHomeButton?.addEventListener('click', () => { if (notesZoomRootId === 'root') { notesSearchInput.value = ''; renderNotes(); } else zoomOutNotes(); });
  exportNotesButton?.addEventListener('click', exportNotes);
  exportNotesMarkdownButton?.addEventListener('click', exportNotesMarkdown);
  importNotesButton?.addEventListener('click', () => importNotesFile?.click());
  importNotesFile?.addEventListener('change', () => { importNotes(importNotesFile.files?.[0]); importNotesFile.value = ''; });

  document.addEventListener('keydown', (event) => {
    if (activePanel !== 'notes') return;
    const target = event.target;
    const inNoteInput = target?.matches?.('.note-input');
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !inNoteInput) { event.preventDefault(); notesSearchInput?.focus(); notesSearchInput?.select(); }
    if (event.key === 'Escape' && notesZoomRootId !== 'root' && !inNoteInput) { event.preventDefault(); zoomOutNotes(); }
  });
  window.addEventListener('pagehide', () => { if (notesSaveTimer) { window.clearTimeout(notesSaveTimer); void persistNotes(); } });

  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== 'sync' || !changes.searchHistory || !settings) return;
    settings.searchHistory = normalizeSearchHistory(changes.searchHistory.newValue);
    selectedHistoryIndexes.clear();
    if (activePanel === 'history') renderHistory();
  });

  chrome.storage.sync.get(null, (stored) => {
    settings = normalizeSettings({ ...DEFAULTS, ...stored });
    defaultGroupCountInput.value = settings.defaultGroupCount;
    pinnedDefaultGroupCountInput.value = settings.pinned.defaultGroupCount;
    if (pinnedCollapseDelayInput) pinnedCollapseDelayInput.value = settings.pinned.collapseDelay;
    if (pinnedAllSitesInput) pinnedAllSitesInput.checked = settings.pinned.allSites === true;
    if (selectionTriggerDelayInput) selectionTriggerDelayInput.value = settings.selectionTriggerDelay;
    if (llmEnabledInput) llmEnabledInput.checked = settings.llm.enabled !== false;
    if (llmEndpointInput) llmEndpointInput.value = settings.llm.endpoint;
    if (llmModelInput) llmModelInput.value = settings.llm.model;
    if (llmApiKeyInput) llmApiKeyInput.value = settings.llm.apiKey;
    if (llmSystemPromptInput) llmSystemPromptInput.value = settings.llm.systemPrompt;
    triggerInputs.forEach((input) => { input.checked = input.value === settings.triggerMode; });
    editableTriggerInputs.forEach((input) => { input.checked = input.value === settings.editableTriggerMode; });
    renderManager();
    const hasLegacy = LEGACY_KEYS.some((key) => Object.prototype.hasOwnProperty.call(stored, key));
    const hasDeprecatedPinnedContent = ['sources', 'groups', 'engines', 'iconOnly', 'engineOrder', 'customEngines'].some((key) => Object.prototype.hasOwnProperty.call(stored.pinnedSearch || {}, key));
    if (stored.sourceConfigVersion !== CONFIG_VERSION || !stored.pinnedSearch || Number(stored.pinnedSearch?.siteConfigVersion) !== PINNED_SITE_CONFIG_VERSION || hasLegacy || hasDeprecatedPinnedContent) {
      chrome.storage.sync.set({
        enabled: settings.enabled, triggerMode: settings.triggerMode, editableTriggerMode: settings.editableTriggerMode, defaultGroupCount: settings.defaultGroupCount, selectionTriggerDelay: settings.selectionTriggerDelay, llm: settings.llm,
        sources: settings.general.sources, groups: settings.general.groups, pinnedSearch: settings.pinned, sourceConfigVersion: CONFIG_VERSION
      }, () => { if (hasLegacy) chrome.storage.sync.remove(LEGACY_KEYS); });
    }
  });
  void loadNotes();
})();
