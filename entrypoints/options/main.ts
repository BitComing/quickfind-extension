// @ts-nocheck
// 由早期手写 JavaScript 迁移而来，尚未补齐类型标注；补全后删除本行。见 README「迁移状态」。
import { SPECIAL_ACTIONS } from '@/shared/search-actions';
import { createNoteDrag } from '@/shared/note-drag';
import { SOURCE_CONFIG_VERSION, PINNED_SITE_CONFIG_VERSION as SHARED_PINNED_VERSION } from '@/shared/builtins';
import { DEFAULT_PINNED_SEARCH, DEFAULT_SETTINGS as SHARED_DEFAULTS, LEGACY_CONFIG_KEYS, MAX_DEFAULT_GROUP_COUNT, freshInstallSeed } from '@/shared/defaults';
import {
  createEmptyNotes as outlineCreateEmptyNotes,
  normalizeNotes as outlineNormalizeNotes,
  noteById as outlineNoteById,
  noteDepth as outlineNoteDepth,
  notePath as outlineNotePath,
  isNoteDescendant as outlineIsNoteDescendant,
  visibleNoteIds as outlineVisibleNoteIds,
  countMatches as outlineCountMatches,
  moveNote as outlineMoveNote,
  insertNoteAfter as outlineInsertNoteAfter,
  insertNoteChild as outlineInsertNoteChild,
  removeNote as outlineRemoveNote,
  changeNoteIndent as outlineChangeNoteIndent,
  mergeNoteWithPrevious as outlineMergeNoteWithPrevious,
  setAllNotesCollapsed as outlineSetAllNotesCollapsed,
  notesToMarkdownLines as outlineNotesToMarkdownLines,
  parseMarkdownNotes as outlineParseMarkdownNotes,
} from '@/shared/outline';
import { decodeQueryText } from '@/shared/query-text';
import { NOTES_STORAGE_KEY } from '@/shared/notes';
import { cleanSource, configuredSources, normalizeSearchConfig } from '@/shared/settings-store';
import type { SearchSource } from '@/shared/settings';
import { applyI18n, countText, getLocale, groupLabel, localeTag, normalizeLocale, setLocale, sourceLabel, t } from '@/shared/i18n';
import { FREE_GROUP_LIMIT, FREE_SOURCE_LIMIT, PLANS, describeLicense, formatExpiryDate, groupQuota, normalizeLicenseRecord, parseActivationCode, recordFromServer, sourceQuota, toSyncRecord } from '@/shared/license';
import type { LicenseRecord } from '@/shared/license';
import { activateLicense as activateOnServer, clearSession, errorText, flushPendingReleases, queuePendingRelease, readSession, refreshLicense, releaseLicense, saveSession, verifyLicenseToken } from '@/shared/license-api';
import { OUTLINE_NOTES_ENABLED, PAGE_SIDEBAR_ENABLED } from '@/shared/features';

(function () {
  'use strict';

  // Keep the settings page usable when opened directly during development.
  if (!globalThis.chrome) globalThis.chrome = {};
  if (!chrome.storage) {
    const readFallback = () => { try { return JSON.parse(localStorage.getItem('quickfind-options-storage') || '{}'); } catch { return {}; } };
    const writeFallback = (value) => { try { localStorage.setItem('quickfind-options-storage', JSON.stringify(value)); } catch { /* storage unavailable */ } };
    chrome.storage = {
      sync: {
        get(keys, callback) { const data = readFallback(); if (keys == null) return callback(data);
        if (typeof keys === 'string') return callback({ [keys]: data[keys] });
        const result = {}; Object.keys(keys || {}).forEach((key) => { result[key] = data[key] ?? keys[key]; }); callback(result); },
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

  // ── 已下线的模块 ─────────────────────────────────────────────────────
  // 见 shared/features.ts：入口直接从 DOM 摘掉，而不是靠 CSS 藏起来。
  // 相关逻辑保持原样——元素缺失后它们自然失效（各自都有空值判断），
  // 开关改回 true 时这一页与右侧「随心问」就会原样回来。
  if (!OUTLINE_NOTES_ENABLED) {
    document.querySelector('.nav-item[data-panel="notes"]')?.remove();
    document.querySelector('[data-panel-content="notes"]')?.remove();
  }
  // 右侧 dock 已下线：那个开关不再有对应物，留着只会让人以为还能打开。
  // 它所在的「面板」块只剩这一行，一并摘掉——留着空标题与分隔线会看起来像坏了。
  if (!PAGE_SIDEBAR_ENABLED) {
    const dockRow = document.querySelector('#llm-dock-visible')?.closest('.row');
    const dockBlock = dockRow?.closest('.setting-block');
    dockRow?.remove();
    if (dockBlock && !dockBlock.querySelector('.row, .field')) dockBlock.remove();
  }

  // 内置源目录、默认配置、补源规则、源的收敛都在 shared/，本文件不再各自维护一份。
  const LEGACY_KEYS = LEGACY_CONFIG_KEYS;
  const CONFIG_VERSION = SOURCE_CONFIG_VERSION;
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
    { id: 'bilibili', name: '哔哩哔哩', url: 'https://search.bilibili.com/all?keyword={query}',
    selector: 'input.nav-search-input, input.search-input, input[name="keyword"], input[placeholder*="搜索"], input[placeholder*="搜"]' },
    { id: 'douyin', name: '抖音', url: 'https://www.douyin.com/search/{query}?type=general',
    selector: 'input[data-e2e="searchbar-input"], input[placeholder*="搜索"], input[aria-label*="搜索"], input[name="keyword"]' }
  ];
  // 这些站点选择器与内容脚本里的同源，只在选项页用于展示与自定义覆盖。
  const PINNED_SITE_CONFIG_VERSION = SHARED_PINNED_VERSION;

  // ── 默认配置 ──────────────────────────────────────────────────────────
  // 默认值来自 shared/defaults.ts（唯一定义处）。它只在「全新安装」时落地：存储里已有
  // sources/groups 或旧版 engines/iconOnly 的安装一律走版本迁移，不会被这里覆盖。

  // sources/groups 必须留空，不能直接用 shared 里的默认值：
  // 收敛时一见 sources 非空就不再走旧版回落路径，而旧版安装（只有 engines/iconOnly、
  // 没有 sources）正是靠那条回落路径读出开关的——塞进来会把它们的配置冲掉。
  // 全新安装的默认值由 defaultConfigSeed() 在「真的什么都没有」时注入。
  const DEFAULTS = { ...SHARED_DEFAULTS, sources: [], groups: [] };

  let settings;
  // 会员记录单独持有：整份设置还没有类型（见 README「类型债务与迭代路线」），
  // 新代码不再往那份隐式 any 上挂字段，自己拿一份已标注的。
  let license: LicenseRecord | null = null;
  let activePanel = 'common';
  // 搜索源与分组已是独立的一页，manager 的选中态不再按面板区分；
  // 拖拽与编辑的归属统一记在这个常量上。
  const MANAGER_PANEL = 'sources';
  let managerGroupId = 'default';
  let editing = null;
  let draggedItem = null;
  let iconEditorSourceId = null;
  let pinnedSiteEditingId = null;
  const iconNodeCache = new Map();
  // 批量选中的条目 id：搜索源 id 与 `action:<id>` 混在一起——两者都能批移、批删。
  const selectedItemIds = new Set();
  const selectedHistoryIndexes = new Set();

  const navItems = Array.from(document.querySelectorAll('.nav-item'));
  const panels = Array.from(document.querySelectorAll('.settings-panel'));
  const defaultGroupCountInput = document.querySelector('#default-group-count');
  const pinnedDefaultGroupCountInput = document.querySelector('#pinned-default-group-count');
  const pinnedCollapseDelayInput = document.querySelector('#pinned-collapse-delay');
  const pinnedAllSitesInput = document.querySelector('#pinned-all-sites');
  const selectionTriggerDelayInput = document.querySelector('#selection-trigger-delay');
  const llmEnabledInput = document.querySelector<HTMLInputElement>('#llm-enabled');
  const llmDockVisibleInput = document.querySelector<HTMLInputElement>('#llm-dock-visible');
  const llmEndpointInput = document.querySelector<HTMLInputElement>('#llm-endpoint');
  const llmModelInput = document.querySelector<HTMLInputElement>('#llm-model');
  const llmApiKeyInput = document.querySelector<HTMLInputElement>('#llm-api-key');
  const llmSystemPromptInput = document.querySelector<HTMLTextAreaElement>('#llm-system-prompt');
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
  const sourceDialog = document.querySelector('#source-dialog');
  const addSourceButton = document.querySelector<HTMLElement>('#add-source');
  const closeSourceDialog = document.querySelector('#close-source-dialog');
  const addGroupButton = document.querySelector<HTMLElement>('#add-group');
  const aboutVersion = document.querySelector('#about-version');
  const planCards = document.querySelector('#plan-cards');
  const licenseStatus = document.querySelector('#license-status');
  const licenseGroupQuota = document.querySelector('#license-group-quota');
  const licenseSourceQuota = document.querySelector('#license-source-quota');
  const licenseCodeInput = document.querySelector<HTMLInputElement>('#license-code');
  const licenseEmailInput = document.querySelector<HTMLInputElement>('#license-email');
  const licenseError = document.querySelector('#license-error');
  const activateLicenseButton = document.querySelector('#activate-license');
  const clearLicenseButton = document.querySelector('#clear-license');
  const licenseClearRow = document.querySelector<HTMLElement>('#license-clear-row');
  const saveStates = { common: document.querySelector('#selection-save-state'),
  selection: document.querySelector('#selection-save-state'),
  pinned: document.querySelector('#pinned-save-state'), sources: document.querySelector('#sources-save-state'),
  llm: document.querySelector('#llm-save-state'), history: document.querySelector('#history-save-state'), notes: document.querySelector('#notes-save-state'),
  about: document.querySelector('#license-save-state') };
  const triggerInputs = Array.from(document.querySelectorAll('input[name="trigger-mode"]'));
  const editableTriggerInputs = Array.from(document.querySelectorAll('input[name="editable-trigger-mode"]'));
  const languageInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="language"]'));
  const iconEditor = document.querySelector('#icon-editor');
  const iconUrlInput = document.querySelector('#icon-url');
  const iconFileInput = document.querySelector('#icon-file');
  const applyIconUrl = document.querySelector('#apply-icon-url');
  const closeIconEditor = document.querySelector('#close-icon-editor');
  const iconEditorError = document.querySelector('#icon-editor-error');
  const iconEditorPreview = document.querySelector('#icon-editor-preview');
  const iconEditorName = document.querySelector('#icon-editor-name');
  const iconEditorNote = document.querySelector('#icon-editor-note');
  const fetchIconButton = document.querySelector<HTMLButtonElement>('#fetch-icon');
  const uploadIconButton = document.querySelector<HTMLButtonElement>('#upload-icon');
  const restoreIconButton = document.querySelector<HTMLButtonElement>('#restore-icon');
  const pinnedSiteList = document.querySelector('#pinned-site-list');
  const pinnedSiteForm = document.querySelector('#pinned-site-form');
  const pinnedSiteNameInput = document.querySelector('#pinned-site-name');
  const pinnedSiteUrlInput = document.querySelector('#pinned-site-url');
  const pinnedSiteSelectorInput = document.querySelector('#pinned-site-selector');
  const pinnedSiteError = document.querySelector('#pinned-site-error');
  const pinnedSitesRow = document.querySelector<HTMLElement>('#pinned-sites-row');
  const pinnedSiteSummary = document.querySelector<HTMLElement>('#pinned-site-summary');
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

  // IndexedDB 的库名。与同步存储里的键（shared/notes.ts 的 NOTES_STORAGE_KEY）恰好同字面量，
  // 但是两套不同的命名空间；改这里会让已有安装读不到旧库，不要动。
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

  function specialActionToken(id) { return 'action:' + String(id); }
  function specialActionByToken(token) {
    const value = String(token || '');
    if (!value.startsWith('action:')) return null;
    return SPECIAL_ACTIONS.find((action) => action.id === value.slice(7)) || null;
  }
  /** 动作在存储里的设置：改名、停用、仅图标都在这张稀疏表里，缺键即默认。 */
  function specialActionSettings(actionId) { return config().actions?.[actionId] || {}; }
  /** 按钮显示名：用户改过就用改过的，否则用 shared/search-actions.ts 的默认名（随界面语言）。 */
  function specialActionName(action) { return String(specialActionSettings(action.id).name || t(String(action.name))); }
  /** 写动作设置只有一个出口：默认值不落盘（iconOnly 只留 true、enabled 只留 false、name 只在非空时留）。 */
  function updateSpecialActionSettings(actionId, patch) {
    if (!config().actions) config().actions = {};
    const next = { ...specialActionSettings(actionId), ...patch };
    if (next.iconOnly !== true) delete next.iconOnly;
    if (next.enabled !== false) delete next.enabled;
    if (!String(next.name || '').trim()) delete next.name;
    if (Object.keys(next).length) config().actions[actionId] = next;
    else delete config().actions[actionId];
  }

  function normalizeSearchHistory(history) {
    if (!Array.isArray(history)) return [];
    return history.map((item) => {
      const query = decodeQueryText(String(typeof item === 'string' ? item : item?.query || '')).replace(/\s+/g, ' ').trim();
      if (!query) return null;
      const timestamp = Number(typeof item === 'string' ? NaN : item?.timestamp);
      return Number.isFinite(timestamp) ? { query, timestamp } : { query };
    }).filter(Boolean);
  }

  function deriveSiteName(url, fallback = '') {
    const raw = String(url || '').trim();
    try {
      const parsed = new URL(raw.replace(/\{query\}/gi, 'quickfind').match(/^[a-z][a-z\d+.-]*:\/\//i) ? raw.replace(/\{query\}/gi, 'quickfind') : 'https://' + raw.replace(/^\/\//,
      '').replace(/\{query\}/gi, 'quickfind'));
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
    // settings.general.sources 已是收敛后的形状；只有它为空时才回落到内置源目录。
    const listed = settings?.general?.sources;
    const sources = Array.isArray(listed) && listed.length ? listed : configuredSources({});
    const seen = new Set();
    return sources.map(cleanSource).filter((source) => source && source.url).filter((source) => !seen.has(source.id) && seen.add(source.id))
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
      const selectedNames = options.filter((site) => selected.has(site.id)).map((site) => sourceLabel(site));
      // 站点名整体列出来会被截断成「Google、百度、谷歌学术、DuckDuckGo、360 搜索、搜…」，
      // 行内只留数量，名单挂在 title 上（点「管理」也能看到全部）。
      pinnedSiteSummary.textContent = selectedNames.length ? countText(selectedNames.length, '1 个站点', '{n} 个站点') : t('未选择');
      pinnedSiteSummary.title = selectedNames.join(getLocale() === 'en' ? ', ' : '、');
    }
    pinnedSiteList.replaceChildren();
    options.forEach((site) => {
      const siteName = sourceLabel(site);
      const label = document.createElement('label');
      label.className = 'site-option managed-site' + (site.custom ? ' custom-site' : '');
      if (site.url) label.title = site.url;
      const input = document.createElement('input');
      input.type = 'checkbox'; input.dataset.siteId = site.id; input.checked = selected.has(site.id); input.setAttribute('aria-label', siteName);
      const name = document.createElement('span');
      name.textContent = siteName + (site.source && !PINNED_SITES.some((item) => item.id === site.id) ? t(' · 搜索源') : '');
      label.append(input, name);
      if (site.managed) {
        const edit = document.createElement('button');
        edit.type = 'button'; edit.className = 'site-edit'; edit.title = t('编辑站点'); edit.setAttribute('aria-label', t('编辑{n}站点', { n: siteName }));
        edit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"></path></svg>';
        edit.addEventListener('click', (event) => { event.preventDefault(); startPinnedSiteEdit(site); });
        label.append(edit);
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'site-remove'; remove.title = t('删除站点'); remove.setAttribute('aria-label', t('删除{n}站点', { n: siteName }));
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

  /**
   * 「已启用」这一行只决定常驻栏在哪些站点出现。勾上「所有站点都显示」之后，
   * 常驻栏在每个页面都会出现，站点名单不再影响任何东西——留着这行反而让人以为
   * 还得在这里挑站点。所以两者互斥：全站显示时收起整行，关掉开关再放回来。
   *
   * 显隐用 hidden 属性而不是条件渲染：这一行的内容是同步渲染的摘要 + 一个弹窗入口，
   * 拆掉重排既没必要，也会让「管理常驻站点」的焦点还原失效。
   */
  function syncPinnedSitesRow() {
    if (!pinnedSitesRow) return;
    pinnedSitesRow.hidden = pinnedAllSitesInput?.checked === true;
  }

  function startPinnedSiteEdit(site) {
    if (!site || !pinnedSiteForm) return;
    pinnedSiteEditingId = site.id;
    pinnedSiteNameInput.value = site.name || '';
    pinnedSiteUrlInput.value = site.url || '';
    pinnedSiteSelectorInput.value = site.selector || '';
    pinnedSiteFormTitle.textContent = t('编辑常驻站点');
    pinnedSiteSubmit.textContent = t('保存');
    cancelPinnedSiteEdit.hidden = false;
    pinnedSiteError.textContent = '';
    pinnedSiteNameInput.focus();
  }

  function resetPinnedSiteForm() {
    pinnedSiteEditingId = null;
    pinnedSiteForm?.reset();
    if (pinnedSiteFormTitle) pinnedSiteFormTitle.textContent = t('添加常驻站点');
    if (pinnedSiteSubmit) pinnedSiteSubmit.textContent = t('添加');
    if (cancelPinnedSiteEdit) cancelPinnedSiteEdit.hidden = true;
    if (pinnedSiteError) pinnedSiteError.textContent = '';
  }

  // 默认组的条目顺序（源 id、action:<id>、group:<id> 混排）与源的收敛都在
  // shared/settings-store.ts，三个入口共用同一份规则。

  // 全新安装（存储里既没有 sources/groups，也没有旧版 engines/iconOnly 痕迹）直接落在默认
  // 配置上。已有配置一律走版本迁移：旧版安装的 engines/iconOnly/customEngines 只能靠
  // 「sources 为空时按开关重建内置源」那条回落路径读出来，所以默认值不能塞进 DEFAULTS，
  // 否则会把旧安装的源开关冲掉。判据与弹窗共用 shared/defaults.ts 的 freshInstallSeed。
  function defaultConfigSeed(stored: any) {
    return freshInstallSeed(stored);
  }

  function normalizeSettings(stored) {
    const general = normalizeSearchConfig(stored);
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
    const pinnedDefaultGroupCount = Math.max(1, Math.min(MAX_DEFAULT_GROUP_COUNT, Math.round(Number(pinnedRaw.defaultGroupCount ?? DEFAULT_PINNED_SEARCH.defaultGroupCount) || DEFAULT_PINNED_SEARCH.defaultGroupCount)));
    const rawCollapseDelay = Number(pinnedRaw.collapseDelay ?? DEFAULT_PINNED_SEARCH.collapseDelay);
    const pinnedCollapseDelay = Number.isFinite(rawCollapseDelay) ? Math.max(0, Math.min(60000, Math.round(rawCollapseDelay))) : DEFAULT_PINNED_SEARCH.collapseDelay;
    const pinned = { sites, customSites, defaultGroupCount: pinnedDefaultGroupCount,
    collapseDelay: pinnedCollapseDelay, openInNewTab: pinnedRaw.openInNewTab === true, allSites: pinnedRaw.allSites === true, siteConfigVersion: PINNED_SITE_CONFIG_VERSION };
    const count = Math.max(1, Math.min(MAX_DEFAULT_GROUP_COUNT, Math.round(Number(stored.defaultGroupCount ?? stored.defaultVisibleCount ?? SHARED_DEFAULTS.defaultGroupCount) || SHARED_DEFAULTS.defaultGroupCount)));
    const editableTriggerMode = ['click', 'hover', 'none'].includes(stored.editableTriggerMode) ? stored.editableTriggerMode : DEFAULTS.editableTriggerMode;
    const selectionTriggerDelay = Math.max(0, Math.min(2000, Math.round(Number(stored.selectionTriggerDelay ?? 200) || 0)));
    const rawLlm = stored.llm && typeof stored.llm === 'object' ? stored.llm : {};
    const llm = {
      enabled: rawLlm.enabled !== false,
      endpoint: String(rawLlm.endpoint || DEFAULTS.llm.endpoint).trim(),
      model: String(rawLlm.model || DEFAULTS.llm.model).trim(),
      apiKey: String(rawLlm.apiKey || ''),
      systemPrompt: String(rawLlm.systemPrompt || '').trim()
    };
    return { enabled: stored.enabled !== false, triggerMode: stored.triggerMode === 'hover' ? 'hover' : 'click',
    editableTriggerMode, defaultGroupCount: count, selectionTriggerDelay,
    language: normalizeLocale(stored.language),
    llmDockVisible: stored.llmDockVisible !== false, general, pinned, llm, searchHistory: normalizeSearchHistory(stored.searchHistory) };
  }

  // 两个搜索列表编辑的是同一份搜索源数据，这里统一称它为 config()。
  function config() { return settings.general; }
  function activeGroup() { return config().groups.find((group) => group.id === managerGroupId) || config().groups[0]; }
  function sourceById(id) { return config().sources.find((source) => source.id === id); }
  function groupById(id) { return config().groups.find((group) => group.id === id); }

  /** 保存成功后显示的确认。失败态要先撤掉，否则成功提示会顶着错误色。 */
  function showSaved(panel?: string) {
    const status = saveStates[panel || activePanel];
    if (!status) return;
    status.classList.remove('is-error');
    status.textContent = t('已保存');
    window.setTimeout(() => { if (status.textContent === t('已保存')) status.textContent = ''; }, 1200);
  }

  /**
   * 保存失败时说明原因，且不自动消失——它是要用户处理的。
   * 两种配额失败给的下一步不同，分开说：容量超了要减配置，频率超了只要等一会儿。
   */
  function saveFailureReason(): string {
    const message = chrome.runtime?.lastError?.message || '';
    if (/MAX_WRITE_OPERATIONS/i.test(message)) return t('保存失败：写入过于频繁，稍后再试。');
    // 单键上限是 8192 字节。实测浏览器返回 Resource::kQuotaBytesPerItem quota exceeded，
    // 两种配额错误都可能带 "quota" 字样，所以先排掉频率那个。
    if (/QUOTA_BYTES|kQuotaBytes|quota/i.test(message)) {
      return t('保存失败：换成浏览器同步后超出单键容量上限（8 KB）。占位最大的是自定义图标，可改用图标地址或精简搜索源。');
    }
    return t('保存失败：{n}', { n: message || t('浏览器未接受这次写入。') });
  }

  function showSaveFailed(panel?: string): void {
    const status = saveStates[panel || activePanel];
    if (!status) return;
    status.classList.add('is-error');
    status.textContent = saveFailureReason();
  }

  /**
   * 所有 sync 写入都走这里。此前 saveGeneral / savePinned / saveHistory 各自调用
   * chrome.storage.sync.set 且都不检查 lastError，一旦超出单键配额（自定义图标是 data URL，
   * 很容易顶到 8 KB），写入被静默丢弃而界面仍显示「已保存」——用户下次打开才发现改动没了。
   *
   * afterWrite 只在写入成功时执行，用于迁移后清理旧键这类「不能跟失败一起做」的后续动作。
   */
  function writeSync(payload: Record<string, unknown>, panel?: string, afterWrite?: () => void): void {
    chrome.storage.sync.set(payload, () => {
      if (chrome.runtime?.lastError) { showSaveFailed(panel); return; }
      afterWrite?.();
      showSaved(panel);
    });
  }

  function saveGeneral(statusPanel = 'selection') {
    writeSync({
      enabled: settings.enabled, triggerMode: settings.triggerMode, defaultGroupCount: settings.defaultGroupCount,
      editableTriggerMode: settings.editableTriggerMode,
      selectionTriggerDelay: settings.selectionTriggerDelay,
      language: settings.language,
      llmDockVisible: settings.llmDockVisible,
      llm: settings.llm,
      sources: settings.general.sources, groups: settings.general.groups, specialActions: settings.general.actions, sourceConfigVersion: CONFIG_VERSION
    }, statusPanel);
  }
  function savePinned() { settings.pinned.siteConfigVersion = PINNED_SITE_CONFIG_VERSION; writeSync({ pinnedSearch: settings.pinned }, 'pinned'); }
  function saveCurrent() { saveGeneral(activePanel); }
  /** 会员记录单独一个键：激活不改动 sources/groups，没必要把整份配置一起重写。 */
  function saveLicense() { writeSync({ license: license ? toSyncRecord(license) : null }, 'about'); }

  /**
   * 语言切换的唯一生效点。
   *
   * 静态文案由 index.html 上的 `data-i18n*` 标记驱动，动态列表（分组标签、搜索源行、
   * 特殊按钮、配额提示、历史、关于）必须整体重画——它们的文案是渲染时拼出来的，
   * 只换 data-i18n 覆盖不到。弹窗标题与提交按钮由编辑态决定，所以单独补一次。
   */
  function applyInterfaceLanguage() {
    const locale = setLocale(settings?.language);
    document.documentElement.lang = locale;
    document.title = t('QuickFind 设置');
    applyI18n(document);
    languageInputs.forEach((input) => { input.checked = input.value === locale; });
    if (!settings) return;
    renderManager();
    if (activePanel === 'history') renderHistory();
    else if (activePanel === 'notes') renderNotes();
    else if (activePanel === 'about') renderAbout();
    if (formTitle && submitLabel) {
      formTitle.textContent = editing?.panel === MANAGER_PANEL ? t('编辑搜索源') : t('添加搜索源');
      submitLabel.textContent = editing?.panel === MANAGER_PANEL ? t('保存') : t('添加');
    }
    if (pinnedSiteFormTitle && pinnedSiteSubmit) {
      pinnedSiteFormTitle.textContent = pinnedSiteEditingId ? t('编辑常驻站点') : t('添加常驻站点');
      pinnedSiteSubmit.textContent = pinnedSiteEditingId ? t('保存') : t('添加');
    }
  }

  function formatHistoryTimestamp(timestamp) {
    if (!Number.isFinite(timestamp) || Math.abs(timestamp) > 8640000000000000) return '';
    return new Intl.DateTimeFormat(localeTag(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
  }

  function saveHistory() {
    writeSync({ searchHistory: settings.searchHistory }, 'history');
  }

  function createEmptyNotes() { return outlineCreateEmptyNotes(); }

  function normalizeNotes(raw) { return outlineNormalizeNotes(raw); }

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
      try { return Promise.resolve(JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) || 'null')); } catch { return Promise.resolve(null); }
    }
    return new Promise((resolve) => chrome.storage.local.get(NOTES_STORAGE_KEY, (value) => resolve(value?.[NOTES_STORAGE_KEY] || null)));
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
        if (chrome.storage?.local) await new Promise((resolve,
        reject) => chrome.storage.local.set({ [NOTES_STORAGE_KEY]: notesState }, () => chrome.runtime?.lastError ? reject(chrome.runtime.lastError) : resolve()));
        else localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(notesState));
        saved = true;
      } catch { /* ignore */ }
      if (!saved) {
        if (notesSaveState) notesSaveState.textContent = t('保存失败');
        return;
      }
      showSaved('notes');
    });
    return notesWriteQueue;
  }

  // Keep the notes panel live when the in-page sidebar (or another settings tab) edits the notes.
  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[NOTES_STORAGE_KEY] || !notesLoaded) return;
      if (notesSaveTimer) return; // local edits pending; last writer wins
      const incoming = changes[NOTES_STORAGE_KEY].newValue as { updatedAt?: unknown } | null | undefined;
      if (!incoming || typeof incoming !== 'object') return;
      // 自己写出去的变动会以 onChanged 的形式回来。先按 updatedAt 认出来直接返回，
      // 省掉一次全量 normalizeNotes（遍历+重建树）与一次 JSON.stringify 签名比对。
      // persistNotes 每次都把 updatedAt 刷成 Date.now()，单调递增，相等即同一份。
      if (Number(incoming.updatedAt) === Number(notesState.updatedAt)) return;
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
    if (notesSaveState) notesSaveState.textContent = t('保存中…');
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

  function noteById(id) { return outlineNoteById(notesState, id); }
  function noteId() { noteIdCounter += 1; return 'note-' + Date.now() + '-' + noteIdCounter; }
  function noteDepth(id, baseId = 'root') { return outlineNoteDepth(notesState, id, baseId); }
  function notePath(id) { return outlineNotePath(notesState, id); }
  function visibleNoteIds(query) { return outlineVisibleNoteIds(notesState, notesZoomRootId, query); }

  function resizeNoteInput(input) { input.style.height = 'auto'; input.style.height = Math.max(28, input.scrollHeight) + 'px'; }
  /**
   * 大纲圆点上的长按拖动。单击圆点进入专注由圆点自己的 click 处理（见 renderNotes），
   * 这里只接管长按之后那一段：跟随指针的浮层、投放区高亮、松手后的移动。
   */
  const noteDrag = createNoteDrag({
    hitRoot: () => document,
    overlayRoot: () => document.body,
    scrollContainer: () => document.scrollingElement as HTMLElement | null,
    ghostText: (id) => String(noteById(id)?.text || '').trim() || t('未命名项目'),
    canDropOn: (sourceId, targetId) => targetId !== sourceId && !isNoteDescendant(targetId, sourceId),
    onDrop: (sourceId, targetId, zone) => moveNote(sourceId, targetId, zone)
  });
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
    if (!notesOutline || !notesLoaded) { if (notesOutline) notesOutline.textContent = t('正在加载笔记…'); if (addNoteButton) addNoteButton.disabled = true; return; }
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
      const matchCount = query ? outlineCountMatches(notesState, notesZoomRootId, query) : 0;
      notesSearchResult.textContent = query ? t('找到 {n} 项', { n: matchCount }) : '';
    }
    if (visible.scopeRoot && visible.scopeRoot.id !== 'root') {
      const heading = document.createElement('div');
      heading.className = 'notes-zoom-heading';
      heading.textContent = visible.scopeRoot.text.trim() || t('未命名项目');
      notesOutline.append(heading);
    }
    if (!visible.ids.length) {
      const empty = document.createElement('div'); empty.className = 'notes-empty';
      empty.textContent = query ? t('没有匹配的笔记') : (visible.scopeRoot?.id === 'root' ? t('还没有笔记项目') : t('还没有子项目')); notesOutline.append(empty);
    } else visible.ids.forEach((id) => {
      const node = noteById(id); const row = document.createElement('div');
      row.className = 'note-row' + (node.completed ? ' completed' : '') + (query && node.text.toLocaleLowerCase().includes(query) ? ' search-match' : '');
      row.dataset.noteId = id; row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(noteDepth(id, visible.scopeRoot?.id || 'root') + 1));
      row.setAttribute('aria-expanded', node.children.length ? String(!node.collapsed) : 'false'); row.style.paddingLeft = (6 + noteDepth(id, visible.scopeRoot?.id || 'root') * 24) + 'px';
      const toggle = document.createElement('button'); toggle.type = 'button';
      toggle.className = 'note-toggle' + (node.collapsed ? ' collapsed' : '');
      toggle.disabled = !node.children.length; toggle.setAttribute('aria-label', node.children.length ? (node.collapsed ? t('展开项目') : t('收起项目')) : t('没有子项目'));
      toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 6 5-6"></path></svg>';
      toggle.addEventListener('click', () => { if (!node.children.length) return;
      const before = cloneNotesState(); node.collapsed = !node.collapsed; pushNotesHistory(before); node.updatedAt = Date.now(); scheduleNotesSave(); renderNotes(id); });
      const complete = document.createElement('button'); complete.type = 'button';
      complete.className = 'note-complete'; complete.setAttribute('aria-label', node.completed ? t('标记未完成') : t('标记完成'));
      complete.title = node.completed ? t('标记未完成') : t('标记完成'); complete.innerHTML = node.completed ?
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle></svg>';
      complete.addEventListener('click', () => { const before = cloneNotesState();
      node.completed = !node.completed; node.updatedAt = Date.now(); pushNotesHistory(before); scheduleNotesSave(); renderNotes(id); });
      const bullet = document.createElement('button'); bullet.type = 'button'; bullet.className = 'note-bullet'; bullet.setAttribute('aria-label', t('专注此项目'));
      const input = document.createElement('textarea'); input.className = 'note-input';
      input.rows = 1; input.value = node.text; input.setAttribute('aria-label', t('大纲项目'));
      input.dataset.noteId = id; input.addEventListener('input', () => { beginNotesHistory(id);
      node.text = input.value; node.updatedAt = Date.now();
      resizeNoteInput(input); updateNotesBreadcrumb(id); scheduleNotesSave();
      }); input.addEventListener('focus', () => { notesActiveId = id; notesTypingHistoryId = null; notesTypingBeforeState = cloneNotesState(); updateNotesBreadcrumb(id); });
      input.addEventListener('keydown', (event) => handleNoteKeydown(event, id, input));
      row.append(toggle, complete, bullet, input);
      // 圆点：单击进入专注，按住不动才进入拖动。见 shared/note-drag.ts。
      bullet.addEventListener('pointerdown', (event) => noteDrag.press(event, id, row, bullet));
      bullet.addEventListener('click', () => { if (noteDrag.shouldIgnoreClick()) return; zoomIntoNote(id); });
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
    notesBreadcrumb.textContent = path.length ? path.join(' / ') : '';
    if (notesHomeButton) notesHomeButton.textContent = notesZoomRootId === 'root' ? t('根目录') : t('返回上级');
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
  function isNoteDescendant(candidateId, ancestorId) { return outlineIsNoteDescendant(notesState, candidateId, ancestorId); }
  function moveNote(sourceId, targetId, placement = 'after') {
    const before = cloneNotesState();
    const result = outlineMoveNote(notesState, sourceId, targetId, placement);
    if (!result.changed) return;
    pushNotesHistory(before); notesActiveId = result.focusId; scheduleNotesSave(); renderNotes(result.focusId);
  }
  function insertNoteAfter(id, text = '', historyBefore = null) {
    const before = historyBefore || cloneNotesState();
    const result = outlineInsertNoteAfter(notesState, id, text, noteId());
    if (!result.changed) return null;
    notesActiveId = result.focusId;
    pushNotesHistory(before);
    scheduleNotesSave();
    renderNotes(result.focusId);
    return noteById(result.focusId);
  }
  function insertNoteChild(parentId, text = '') {
    const before = cloneNotesState();
    const result = outlineInsertNoteChild(notesState, parentId, text, noteId());
    if (!result.changed) return null;
    notesActiveId = result.focusId;
    pushNotesHistory(before); scheduleNotesSave(); renderNotes(result.focusId);
    return noteById(result.focusId);
  }
  function removeNote(id) {
    const before = cloneNotesState();
    const result = outlineRemoveNote(notesState, id);
    if (!result.changed) return null;
    pushNotesHistory(before);
    notesActiveId = result.focusId;
    scheduleNotesSave();
    renderNotes(result.focusId);
    return result.focusId || 'root';
  }
  function changeNoteIndent(id, outdent, input = null) {
    const before = cloneNotesState();
    const result = outlineChangeNoteIndent(notesState, id, outdent);
    if (!result.changed) return;
    pushNotesHistory(before); scheduleNotesSave(); renderNotes(id, input ? noteSelection(input) : null);
  }
  function mergeNoteWithPrevious(id, input) {
    const before = cloneNotesState();
    const result = outlineMergeNoteWithPrevious(notesState, id);
    if (!result.changed) return false;
    pushNotesHistory(before);
    notesActiveId = result.focusId;
    scheduleNotesSave();
    renderNotes(result.focusId, { start: result.caret, end: result.caret });
    return true;
  }
  function handleNoteKeydown(event, id, input) {
    if (event.isComposing) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redoNotes() : undoNotes(); return; }
    if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); redoNotes(); return; }
    if (event.key === 'Escape') { if (notesZoomRootId !== 'root') { event.preventDefault();
    zoomOutNotes(); } else if (notesSearchInput.value) { notesSearchInput.value = ''; renderNotes(id); } return; }
    if (modifier && event.key === 'Enter') { event.preventDefault();
    const node = noteById(id); if (!node) return; const before = cloneNotesState();
    node.completed = !node.completed; node.updatedAt = Date.now(); pushNotesHistory(before); scheduleNotesSave(); renderNotes(id, noteSelection(input)); return; }
    if (modifier && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); changeNoteIndent(id, event.key === 'ArrowLeft', input); return; }
    if (modifier && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); const node = noteById(id); const parent = node && noteById(node.parentId);
      const index = parent?.children.indexOf(id) ?? -1; const targetId = parent?.children[index + (event.key === 'ArrowUp' ? -1 : 1)];
      if (targetId) moveNote(id, targetId, event.key === 'ArrowUp' ? 'before' : 'after'); return;
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault();
    const cursor = input.selectionStart; const beforeText = input.value.slice(0, cursor);
    const after = input.value.slice(input.selectionEnd); const node = noteById(id);
    const beforeState = cloneNotesState(); if (node) node.text = beforeText; insertNoteAfter(id, after, beforeState); return; }
    if (event.key === 'Tab') { event.preventDefault(); changeNoteIndent(id, event.shiftKey, input); return; }
    if (event.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) { event.preventDefault(); if (input.value) mergeNoteWithPrevious(id, input); else removeNote(id); return; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { const inputs = Array.from(notesOutline.querySelectorAll('.note-input'));
    const index = inputs.indexOf(input); const next = inputs[index + (event.key === 'ArrowUp' ? -1 : 1)];
    if (next && (event.key === 'ArrowUp' ? input.selectionStart === 0 : input.selectionStart === input.value.length)) { event.preventDefault();
    next.focus(); next.setSelectionRange(event.key === 'ArrowUp' ? next.value.length : 0, event.key === 'ArrowUp' ? next.value.length : 0); } }
  }
  function addNote() {
    const target = notesActiveId && noteById(notesActiveId) ? notesActiveId : null;
    if (target && notesZoomRootId !== 'root' && target === notesZoomRootId) return insertNoteChild(target);
    if (target) return insertNoteAfter(target);
    const before = cloneNotesState();
    const result = outlineInsertNoteChild(notesState, notesZoomRootId, '', noteId());
    if (!result.changed) return;
    notesActiveId = result.focusId;
    pushNotesHistory(before); scheduleNotesSave(); renderNotes(result.focusId);
  }
  function setAllNotesCollapsed(collapsed) { const before = cloneNotesState(); outlineSetAllNotesCollapsed(notesState, collapsed); pushNotesHistory(before); scheduleNotesSave(); renderNotes(); }
  function downloadNotesFile(content, filename, type) { const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 0); }
  function exportNotes() { downloadNotesFile(JSON.stringify(notesState, null, 2), 'quickfind-notes.json', 'application/json'); }
  function markdownNotesLines(parentId, depth = 0, lines = []) { return outlineNotesToMarkdownLines(notesState, parentId, depth, lines); }
  function exportNotesMarkdown() { downloadNotesFile(markdownNotesLines('root').join('\n') + '\n', 'quickfind-notes.md', 'text/markdown'); }
  function parseMarkdownNotes(text) { return outlineParseMarkdownNotes(text, noteId); }
  function importNotes(file) { if (!file) return; const reader = new FileReader();
  reader.onload = () => { try { const content = String(reader.result || '');
  const parsed = /\.m(?:d|arkdown)$/i.test(file.name || '') ? parseMarkdownNotes(content) : JSON.parse(content); const normalized = normalizeNotes(parsed); if (Object.keys(normalized.nodes).length <= 1 && content.trim()) throw new Error(); const before = cloneNotesState(); notesState = normalized; notesUndoStack.push(before); if (notesUndoStack.length > NOTES_HISTORY_LIMIT) notesUndoStack.shift(); notesRedoStack = []; notesActiveId = null; notesZoomRootId = 'root'; updateNotesHistoryButtons(); scheduleNotesSave(); renderNotes(); } catch { window.alert(t('导入失败：请选择有效的 JSON 或 Markdown 大纲文件。')); } }; reader.readAsText(file); }

  function renderHistory() {
    if (!historyRecordList || !settings) return;
    const history = settings.searchHistory || [];
    Array.from(selectedHistoryIndexes).forEach((index) => {
      if (index < 0 || index >= history.length) selectedHistoryIndexes.delete(index);
    });
    historyRecordList.replaceChildren();
    if (!history.length) {
      historyRecordList.innerHTML = '<div class="history-empty">' + t('暂无搜索历史') + '</div>';
    } else {
      history.forEach((entry, index) => {
        const row = document.createElement('div');
        row.className = 'history-record';
        const select = document.createElement('label');
        select.className = 'check';
        select.title = t('选择历史记录');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = selectedHistoryIndexes.has(index);
        input.setAttribute('aria-label', t('选择历史记录：{n}', { n: entry.query }));
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
          iconButton('copy', t('复制历史记录'), () => copyHistoryEntry(entry, actions.firstElementChild)),
          iconButton('remove', t('删除历史记录'), () => removeHistoryAt(index))
        );
        row.append(select, query, time, actions);
        historyRecordList.append(row);
      });
    }
    if (historySelectionCount) historySelectionCount.textContent = selectedHistoryIndexes.size ? t('已选 {n} 项', { n: selectedHistoryIndexes.size }) : '';
    const allSelected = history.length > 0 && selectedHistoryIndexes.size === history.length;
    if (selectAllHistory) {
      selectAllHistory.disabled = history.length === 0;
      selectAllHistory.setAttribute('aria-pressed', String(allSelected));
      selectAllHistory.setAttribute('aria-label', allSelected ? t('取消全选历史记录') : t('全选历史记录'));
      selectAllHistory.title = allSelected ? t('取消全选历史记录') : t('全选历史记录');
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
      const originalLabel = button.dataset.originalLabel || t('复制历史记录');
      button.dataset.originalLabel = originalLabel;
      button.setAttribute('aria-label', t('已复制')); button.title = t('已复制');
      button._copyFeedbackTimer = window.setTimeout(() => {
        button.setAttribute('aria-label', originalLabel); button.title = originalLabel;
      }, 1200);
    } catch {
      button.setAttribute('aria-label', t('复制失败')); button.title = t('复制失败');
      clearTimeout(button._copyFeedbackTimer);
      button._copyFeedbackTimer = window.setTimeout(() => {
        button.setAttribute('aria-label', t('复制历史记录')); button.title = t('复制历史记录');
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
      copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>',
      edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"></path></svg>',
      remove: '<svg viewBox="0 0 24 24"><path d="M3 6h18"></path><path d="M8 6V4h8v2M19 6l-1 14H6L5 6"></path></svg>'
    };
    button.innerHTML = icons[kind]; button.addEventListener('click', handler); return button;
  }

  function makeLogo(source) {
    const logo = document.createElement('button');
    logo.type = 'button'; logo.className = 'source-logo source-logo-button ' + source.className;
    // 图标的所有操作（获取网站图标 / 上传 / 链接 / 恢复默认）都收进了弹窗，
    // 行上的图标只负责打开它——此前点已改过图标的那个会直接恢复，等于一个没有提示的破坏操作。
    logo.title = t('更改图标');
    logo.setAttribute('aria-label', t('更改{n}的图标', { n: sourceLabel(source) }));
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
    logo.addEventListener('click', () => openIconEditor(source));
    return logo;
  }

  function addDragBehavior(row, item) {
    row.draggable = true;
    row.addEventListener('dragstart', (event) => {
      const selected = item.type === 'source' ? selectedItemIds : null;
      const ids = selected?.has(item.id) ? Array.from(selected) : [item.id];
      draggedItem = { ...item, ids };
      row.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', ids.join(','));
    });
    row.addEventListener('dragend', () => {
      draggedItem = null;
      document.querySelectorAll('.drag-before,.drag-after,.dragging').forEach((element) => element.classList.remove('drag-before', 'drag-after', 'dragging'));
    });
    row.addEventListener('dragover', (event) => {
      if (!draggedItem || draggedItem.panel !== MANAGER_PANEL || (draggedItem.ids || [draggedItem.id]).includes(item.id)) return;
      event.preventDefault();
      const after = event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2;
      row.classList.toggle('drag-before', !after); row.classList.toggle('drag-after', after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-before', 'drag-after'));
    row.addEventListener('drop', (event) => {
      event.preventDefault(); row.classList.remove('drag-before', 'drag-after');
      if (!draggedItem || draggedItem.panel !== MANAGER_PANEL || (draggedItem.ids || [draggedItem.id]).includes(item.id)) return;
      reorderActiveItem(draggedItem.ids || draggedItem.id, item.id, event.clientY > row.getBoundingClientRect().top + row.offsetHeight / 2);
    });
  }

  function createSourceRow(source) {
    const row = document.createElement('div');
    const displayName = sourceLabel(source);
    row.className = 'source-row'; row.dataset.sourceId = source.id;
    addDragBehavior(row, { panel: MANAGER_PANEL, id: source.id, type: 'source' });
    const handle = document.createElement('span');
    handle.className = 'drag-handle'; handle.textContent = '⠿'; handle.title = t('拖动排序，或拖到分组标签中移动'); handle.setAttribute('aria-hidden', 'true');
    const select = document.createElement('label');
    select.className = 'source-select'; select.title = t('选择搜索源');
    const selectInput = document.createElement('input');
    selectInput.type = 'checkbox'; selectInput.checked = selectedItemIds.has(source.id); selectInput.setAttribute('aria-label', t('选择{n}按钮', { n: displayName }));
    selectInput.addEventListener('change', () => { if (selectInput.checked) selectedItemIds.add(source.id); else selectedItemIds.delete(source.id); renderBatchActions(); });
    select.append(selectInput);
    const meta = document.createElement('div');
    meta.className = 'source-meta';
    const sourceName = document.createElement('strong');
    sourceName.textContent = displayName;
    // URL 模板与说明放在 title 里，不在行内常驻：设置页只呈现「是什么」和「能改什么」，
    // 说明性文字（怎么用、会发生什么）一律不占版面。见 MEMORY.md「界面文案」。
    meta.title = t(String(source.detail || source.url || ''));
    meta.append(sourceName);
    const actions = document.createElement('div');
    actions.className = 'source-actions';
    actions.append(iconButton('edit', t('编辑搜索源'), () => startEdit(source)), iconButton('remove', t('删除搜索源'), () => removeSource(source.id)));
    const iconOnly = document.createElement('label');
    iconOnly.className = 'icon-only-setting'; iconOnly.title = t('仅显示图标');
    const iconOnlyInput = document.createElement('input');
    iconOnlyInput.type = 'checkbox'; iconOnlyInput.checked = source.iconOnly; iconOnlyInput.setAttribute('aria-label', t('{n}仅显示图标', { n: displayName }));
    iconOnlyInput.addEventListener('change', (event) => { source.iconOnly = event.target.checked; saveCurrent(); });
    iconOnly.append(iconOnlyInput);
    const enabled = document.createElement('label');
    enabled.className = 'check'; enabled.title = t('启用搜索源');
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox'; enabledInput.checked = source.enabled; enabledInput.setAttribute('aria-label', t('{n}启用', { n: displayName }));
    const enabledMark = document.createElement('span');
    enabledMark.className = 'checkmark';
    enabledInput.addEventListener('change', (event) => { source.enabled = event.target.checked; saveCurrent(); });
    enabled.append(enabledInput, enabledMark);
    row.append(handle, select, makeLogo(source), meta, actions, iconOnly, enabled);
    return row;
  }

  function createSpecialActionRow(action: SearchSource) {
    const row = document.createElement('div');
    const token = specialActionToken(action.id);
    const displayName = specialActionName(action);
    row.className = 'source-row special-action-row'; row.dataset.actionId = action.id;
    addDragBehavior(row, { panel: MANAGER_PANEL, id: token, type: 'action' });
    const handle = document.createElement('span');
    handle.className = 'drag-handle'; handle.textContent = '⠿'; handle.title = t('拖动调整位置，或拖到分组标签中移动'); handle.setAttribute('aria-hidden', 'true');
    // 多选：与搜索源共用同一份选中集合，批移与批删都认 `action:<id>`。
    const select = document.createElement('label');
    select.className = 'source-select'; select.title = t('选择{n}按钮', { n: displayName });
    const selectInput = document.createElement('input');
    selectInput.type = 'checkbox'; selectInput.checked = selectedItemIds.has(token); selectInput.setAttribute('aria-label', t('选择{n}按钮', { n: displayName }));
    selectInput.addEventListener('change', () => {
      if (selectInput.checked) selectedItemIds.add(token); else selectedItemIds.delete(token);
      renderBatchActions();
    });
    select.append(selectInput);
    const logo = document.createElement('span');
    logo.className = 'source-logo ' + action.className; logo.textContent = String(action.mark || '');
    const meta = document.createElement('div');
    meta.className = 'source-meta';
    const name = document.createElement('strong'); name.textContent = displayName;
    meta.title = t(String(action.detail || action.specialTitle || ''));
    meta.append(name);
    // 与搜索源行对齐：改名、删除都在这一列。
    const actions = document.createElement('div');
    actions.className = 'source-actions';
    actions.append(iconButton('edit', t('重命名按钮'), () => renameSpecialAction(action)), iconButton('remove', t('从分组移除'), () => removeSpecialAction(action.id)));
    // 仅图标：存进 general.actions，由 shared/settings-store 收敛后交给浮层与常驻栏渲染。
    const iconOnly = document.createElement('label');
    iconOnly.className = 'icon-only-setting'; iconOnly.title = t('仅显示图标');
    const iconOnlyInput = document.createElement('input');
    iconOnlyInput.type = 'checkbox'; iconOnlyInput.checked = specialActionSettings(action.id).iconOnly === true;
    iconOnlyInput.setAttribute('aria-label', t('{n}仅显示图标', { n: displayName }));
    iconOnlyInput.addEventListener('change', () => setSpecialActionIconOnly(action.id, iconOnlyInput.checked));
    iconOnly.append(iconOnlyInput);
    // 启用列与搜索源同一位置：动作也可以整体停用，停用后三个入口都不再出现它。
    const enabled = document.createElement('label');
    enabled.className = 'check'; enabled.title = t('启用按钮');
    const enabledInput = document.createElement('input');
    enabledInput.type = 'checkbox'; enabledInput.checked = specialActionSettings(action.id).enabled !== false;
    enabledInput.setAttribute('aria-label', t('{n}启用', { n: displayName }));
    const enabledMark = document.createElement('span');
    enabledMark.className = 'checkmark';
    enabledInput.addEventListener('change', () => setSpecialActionEnabled(action.id, enabledInput.checked));
    enabled.append(enabledInput, enabledMark);
    row.append(handle, select, logo, meta, actions, iconOnly, enabled);
    return row;
  }

  function createGroupRow(group) {
    const token = 'group:' + group.id;
    const displayName = groupLabel(group);
    const row = document.createElement('div');
    row.className = 'source-row derived-group-row'; row.dataset.groupId = group.id;
    addDragBehavior(row, { panel: MANAGER_PANEL, id: token, type: 'group' });
    const handle = document.createElement('span');
    handle.className = 'drag-handle'; handle.textContent = '⠿'; handle.title = t('拖动排序'); handle.setAttribute('aria-hidden', 'true');
    const open = document.createElement('button');
    open.type = 'button'; open.className = 'source-logo source-logo-button group'; open.title = t('打开{n}', { n: displayName }); open.textContent = t('组');
    open.addEventListener('click', () => { managerGroupId = group.id; renderManager(); });
    const meta = document.createElement('button');
    meta.type = 'button'; meta.className = 'source-meta group-meta-button'; meta.title = t('打开{n}', { n: displayName });
    const groupName = document.createElement('strong');
    groupName.textContent = displayName;
    const groupDetail = document.createElement('small');
    groupDetail.textContent = countText(group.items.length, '1 个搜索源', '{n} 个搜索源');
    meta.append(groupName, groupDetail);
    meta.addEventListener('click', () => { managerGroupId = group.id; renderManager(); });
    const actions = document.createElement('div');
    actions.className = 'source-actions';
    actions.append(iconButton('edit', t('重命名分组'), () => renameGroup(group)), iconButton('remove', t('删除分组'), () => removeGroup(group.id)));
    const spacer = document.createElement('span');
    spacer.className = 'source-control-spacer';
    const visible = document.createElement('label');
    visible.className = 'check'; visible.title = t('在搜索列表中显示');
    const visibleInput = document.createElement('input');
    visibleInput.type = 'checkbox'; visibleInput.checked = group.visible; visibleInput.setAttribute('aria-label', t('{n}在搜索列表中显示', { n: displayName }));
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
      tab.type = 'button'; tab.className = 'group-tab' + (group.id === managerGroupId ? ' active' : '');
      tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(group.id === managerGroupId)); tab.textContent = groupLabel(group);
      tab.draggable = group.id !== 'default';
      tab.title = group.id === 'default' ? t('默认组，可拖入搜索源或特殊功能按钮') : t('打开{n}，可将搜索源或特殊功能按钮拖到此处，也可拖动标签调整分组顺序', { n: groupLabel(group) });
      tab.addEventListener('click', () => { managerGroupId = group.id; resetForm(); renderManager(); });
      tab.addEventListener('dragstart', (event) => {
        if (group.id === 'default') return;
        draggedItem = { panel: MANAGER_PANEL, id: group.id, type: 'group-tab' };
        tab.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', 'group:' + group.id);
      });
      tab.addEventListener('dragend', () => {
        draggedItem = null;
        document.querySelectorAll('.group-tab.drag-before,.group-tab.drag-after,.group-tab.dragging').forEach((element) => element.classList.remove('drag-before', 'drag-after', 'dragging'));
      });
      tab.addEventListener('dragover', (event) => {
        if (!draggedItem || draggedItem.panel !== MANAGER_PANEL) return;
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
        if (!draggedItem || draggedItem.panel !== MANAGER_PANEL) return;
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
    if (!sourceList.childElementCount) sourceList.innerHTML = '<div class="empty">' + t('这个分组还没有搜索源') + '</div>';
    // 只给数量：组名已经在选中的标签上，再写一句「搜索源和自定义组可以一起排序」是说明。
    activeGroupMeta.textContent = countText(group.items.length, '1 项', '{n} 项');
  }

  function renderSpecialActions() {
    if (!specialActionList || !settings) return;
    specialActionList.replaceChildren();
    SPECIAL_ACTIONS.forEach((action) => {
      const row = document.createElement('div');
      row.className = 'special-action-config';
      const logo = document.createElement('span');
      logo.className = 'source-logo ' + action.className; logo.textContent = String(action.mark || '');
      const meta = document.createElement('div');
      meta.className = 'special-action-meta';
      const name = document.createElement('strong'); name.textContent = specialActionName(action);
      meta.title = t(String(action.detail || action.specialTitle || ''));
      meta.append(name);
      const select = document.createElement('select');
      select.setAttribute('aria-label', t('{n}按钮所在分组', { n: specialActionName(action) }));
      const none = document.createElement('option'); none.value = ''; none.textContent = t('未添加'); select.append(none);
      config().groups.forEach((group) => {
        const option = document.createElement('option'); option.value = group.id; option.textContent = groupLabel(group); select.append(option);
      });
      const token = specialActionToken(action.id);
      const currentGroup = config().groups.find((group) => group.items.includes(token));
      select.value = currentGroup?.id || '';
      select.addEventListener('change', () => setSpecialActionGroup(action.id, select.value));
      row.append(logo, meta, select);
      specialActionList.append(row);
    });
  }

  function setSpecialActionGroup(actionId: string, groupId: string) {
    const token = specialActionToken(actionId);
    config().groups.forEach((group) => { group.items = group.items.filter((item) => item !== token); });
    if (groupId) groupById(groupId)?.items.push(token);
    saveGeneral('sources');
    renderManager();
  }

  function removeSpecialAction(actionId: string) {
    setSpecialActionGroup(actionId, '');
  }

  /**
   * 改名与分组重命名同一条路径：只有一个字段要填，用 prompt 比开一个弹窗轻。
   * 清空则回到动作的默认名（不把空串写进存储）。
   */
  function renameSpecialAction(action) {
    const next = window.prompt(t('按钮名称'), specialActionName(action));
    if (next === null) return;
    const name = next.trim().slice(0, 24);
    updateSpecialActionSettings(action.id, { name });
    saveCurrent(); renderManager();
  }

  /** 停用只影响三个入口的列表；按钮仍留在分组里，随时可以再打开。 */
  function setSpecialActionEnabled(actionId: string, enabled: boolean) {
    updateSpecialActionSettings(actionId, { enabled });
    saveCurrent(); renderManager();
  }

  /** 仅图标只影响显示，不改条目归属；关掉时把键删掉，别在 sync 里留一堆 false。 */
  function setSpecialActionIconOnly(actionId: string, iconOnly: boolean) {
    updateSpecialActionSettings(actionId, { iconOnly });
    saveCurrent();
  }

  function renderManager() {
    renderGroups(); renderSources();
    renderSpecialActions();
    renderPinnedSiteOptions();
    renderBatchActions();
    renderQuotaButtons();
    if (pinnedDefaultGroupCountInput) pinnedDefaultGroupCountInput.value = settings.pinned.defaultGroupCount;
  }

  // ── 关于页：版本与会员 ────────────────────────────────────────────────
  // 价格、有效期、分组上限都来自 shared/license.ts。这里的 DOM 只把那份声明画出来，
  // 不另写一份文案——改价只改一处，页面与校验就不会对不上。

  /** 一张套餐卡：名称、价格、两三条权益。当前生效的那张描边强调。 */
  function createPlanCard(plan: { id: string; label: string; price: string; period: string; features: string[]; hint?: string; current: boolean }): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'plan-card' + (plan.current ? ' is-current' : '');
    card.dataset.plan = plan.id;
    if (plan.hint) card.title = t(plan.hint);
    const head = document.createElement('div');
    head.className = 'plan-card-head';
    const name = document.createElement('span');
    name.className = 'plan-name'; name.textContent = t(plan.label);
    head.append(name);
    if (plan.current) {
      const tag = document.createElement('span');
      tag.className = 'plan-tag'; tag.textContent = t('当前');
      head.append(tag);
    }
    const price = document.createElement('div');
    price.className = 'plan-price';
    const amount = document.createElement('span');
    amount.className = 'plan-amount'; amount.textContent = t(plan.price);
    price.append(amount);
    if (plan.period) {
      const period = document.createElement('span');
      period.className = 'plan-period'; period.textContent = t(plan.period);
      price.append(period);
    }
    const features = document.createElement('ul');
    features.className = 'plan-features';
    plan.features.forEach((feature) => {
      const item = document.createElement('li');
      item.textContent = t(feature);
      features.append(item);
    });
    card.append(head, price, features);
    return card;
  }

  function renderPlanCards() {
    if (!planCards) return;
    const status = describeLicense(license);
    const cards = [createPlanCard({
      id: 'free',
      label: t('免费版'),
      price: t('0 元'),
      period: '',
      features: [t('最多 {n} 个搜索源分组', { n: FREE_GROUP_LIMIT }), t('最多启用 {n} 个搜索源', { n: FREE_SOURCE_LIMIT })],
      hint: t('不激活也能用，超出上限的部分需要会员'),
      current: !status.active,
    })];
    PLANS.forEach((plan) => cards.push(createPlanCard({
      id: plan.id, label: plan.label, price: plan.price, period: plan.period,
      features: plan.features, hint: plan.hint, current: status.active && status.plan === plan.id,
    })));
    planCards.replaceChildren(...cards);
  }

  /** 配额文案：会员显示「n 个（不限）」，免费显示「n / 上限」。 */
  function quotaText(quota: { used: number; limit: number; unlimited: boolean }): string {
    return quota.unlimited ? t('{n} 个（不限）', { n: quota.used }) : t('{n} / {limit}', { n: quota.used, limit: quota.limit });
  }

  /** 状态、配额、停用按钮、套餐卡四处都由这一份状态驱动，激活与清除后只调它。 */
  // 只在设置读回之后才会被调到（导航、激活、存储变更三处都各自守着），
  // 这里不再重复判一次 settings。
  function renderLicenseState() {
    if (!licenseStatus) return;
    const status = describeLicense(license);
    const expires = formatExpiryDate(status.expiresAt);
    let text = t(status.label);
    if (status.active && expires) text = t('{n} · {date} 到期', { n: text, date: expires });
    if (status.expired && expires) text = t('{n} · {date}', { n: text, date: expires });
    licenseStatus.textContent = text;
    licenseStatus.classList.toggle('is-member', status.active);
    licenseStatus.classList.toggle('is-expired', status.expired);
    if (licenseGroupQuota) licenseGroupQuota.textContent = quotaText(groupQuota(config().groups, license));
    if (licenseSourceQuota) licenseSourceQuota.textContent = quotaText(sourceQuota(config().sources, license));
    if (licenseClearRow) licenseClearRow.hidden = !license;
    renderPlanCards();
    renderQuotaButtons();
  }

  /** 两个「+」的提示里带上各自配额：点之前就能看出还剩几个。 */
  function renderQuotaButtons() {
    renderGroupQuotaButton();
    renderSourceQuotaButton();
  }

  function renderGroupQuotaButton() {
    if (!addGroupButton) return;
    const quota = groupQuota(config().groups, license);
    addGroupButton.title = quota.unlimited
      ? t('新建分组（会员不限数量）')
      : quota.allowed
        ? t('新建分组（免费版还可建 {n} 个）', { n: quota.remaining })
        : t('免费版最多创建 {n} 个搜索源分组', { n: FREE_GROUP_LIMIT });
    addGroupButton.classList.toggle('is-locked', !quota.allowed);
  }

  function renderSourceQuotaButton() {
    if (!addSourceButton) return;
    const quota = sourceQuota(config().sources, license);
    addSourceButton.title = quota.unlimited
      ? t('添加搜索源（会员不限数量）')
      : quota.allowed
        ? t('添加搜索源（免费版还可启用 {n} 个）', { n: quota.remaining })
        : t('免费版最多启用 {n} 个搜索源（可先关掉一个）', { n: FREE_SOURCE_LIMIT });
    addSourceButton.classList.toggle('is-locked', !quota.allowed);
  }

  function renderAbout() {
    if (!settings) return;
    const version = chrome.runtime?.getManifest?.().version;
    if (aboutVersion) aboutVersion.textContent = version ? 'v' + version : t('开发预览');
    renderLicenseState();
    void maybeRefreshLicense();
  }

  /**
   * 激活：本地只验「格式像不像」，真伪由服务端回答（`/v1/activate`）。
   *
   * 为什么要邮箱：码与购买时填写的邮箱绑定，服务端按邮箱 + 码核验，并把这条记录
   * 绑到本机设备号上。没有邮箱这一步，「一码一邮箱」就退化成「码可以随便传」。
   */
  async function activateLicense() {
    if (!settings) return;
    const email = String(licenseEmailInput?.value || '').trim();
    const raw = String(licenseCodeInput?.value || '').trim();
    if (!email) {
      if (licenseError) licenseError.textContent = t('请填写购买时使用的邮箱。');
      return;
    }
    const check = parseActivationCode(raw);
    if (!check.ok) {
      if (licenseError) licenseError.textContent = t(check.error);
      return;
    }
    // 请求在飞时再点一次会重复激活：第二次会把第一次刚拿到的续期令牌顶掉。
    const button = activateLicenseButton;
    if (button?.disabled) return;
    if (button) {
      button.disabled = true;
      button.textContent = t('激活中…');
    }
    if (licenseError) licenseError.textContent = '';
    try {
      const result = await activateOnServer(email, raw);
      if (!result.ok) {
        if (licenseError) licenseError.textContent = t(errorText(result.error));
        return;
      }
      const record = recordFromServer({
        code: raw,
        email: result.email,
        plan: result.plan,
        expires_at: result.expires_at,
        license: result.license,
        refresh: result.refresh,
      });
      if (!record) {
        if (licenseError) licenseError.textContent = t('激活失败，请稍后再试。');
        return;
      }
      license = record;
      if (record.token && record.refreshToken) {
        await saveSession({
          code: record.code,
          token: record.token,
          tokenExp: record.tokenExp ?? 0,
          refreshToken: record.refreshToken,
          refreshExp: record.refreshExp ?? 0,
        });
      }
      if (licenseCodeInput) licenseCodeInput.value = '';
      saveLicense();
      renderLicenseState();
    } catch {
      if (licenseError) licenseError.textContent = t('激活失败，请稍后再试。');
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = t('激活');
      }
    }
  }

  /** 许可证快到期就静默续期。失败不打扰用户：服务端仍以会员到期时间为准。 */
  async function maybeRefreshLicense() {
    if (!license) return;
    // 令牌存在 local（每台设备各一份），sync 里那份是老版本遗留的兜底。
    const session = await readSession();
    const refreshToken = session?.refreshToken || license.refreshToken;
    const tokenExp = session?.tokenExp || license.tokenExp || 0;
    if (!refreshToken || tokenExp - Date.now() > 7 * 24 * 60 * 60 * 1000) return;
    const result = await refreshLicense(refreshToken);
    if (!result.ok) return;
    // 续期回来的令牌先离线验一遍：验不过说明公钥与服务端不匹配（比如换过私钥），
    // 这时候宁可保留旧记录，也不要把一张验不过的令牌落盘。
    if (!(await verifyLicenseToken(result.license.token))) return;
    const record = recordFromServer({
      code: license.code,
      email: result.email,
      plan: result.plan,
      expires_at: result.expires_at,
      license: result.license,
      refresh: result.refresh,
    });
    if (!record) return;
    // 激活时间不跟着续期变，否则一年会员的「起算点」会往后漂。
    license = { ...record, activatedAt: license.activatedAt };
    if (record.token && record.refreshToken) {
      await saveSession({
        code: record.code,
        token: record.token,
        tokenExp: record.tokenExp ?? 0,
        refreshToken: record.refreshToken,
        refreshExp: record.refreshExp ?? 0,
      });
    }
    saveLicense();
    renderLicenseState();
  }

  /** sync 里只有身份信息，本机的设备凭证在 local：读回来并在内存里并成完整记录。 */
  async function hydrateSession() {
    const session = await readSession();
    if (!session || !license || session.code !== license.code) return;
    license = {
      ...license,
      token: session.token,
      tokenExp: session.tokenExp,
      refreshToken: session.refreshToken,
      refreshExp: session.refreshExp,
    };
  }

  /**
   * 停用：先把设备位还给用户，再清本地。
   * 网络失败也照样清——不能因为连不上服务器就把人卡在「清除不了」；发不出去的请求
   * 记进待办，下次打开设置页补发，否则离线点一次就白丢一个名额。
   */
  async function clearLicense() {
    if (!license) return;
    const session = await readSession();
    const refreshToken = session?.refreshToken || license.refreshToken;
    license = null;
    if (licenseError) licenseError.textContent = '';
    saveLicense();
    renderLicenseState();
    await clearSession();
    if (refreshToken) {
      const released = await releaseLicense(refreshToken);
      if (!released) await queuePendingRelease(refreshToken);
    }
  }

  function renderBatchActions() {
    if (!batchActions || !settings) return;
    const selected = selectedItemIds;
    // 有效条目 = 搜索源 + 当前挂在某个分组里的特殊功能按钮。少了后半截，
    // 选中动作后一渲染就会被当成「已失效」清掉，批量删除永远等不到点击。
    const valid = new Set(config().sources.map((source) => source.id));
    config().groups.forEach((group) => group.items.forEach((item) => { if (specialActionByToken(item)) valid.add(item); }));
    Array.from(selected).forEach((id) => { if (!valid.has(id)) selected.delete(id); });
    batchActions.hidden = selected.size === 0;
    if (batchCount) batchCount.textContent = t('已选 {n} 项', { n: selected.size });
    if (batchGroup) {
      const current = batchGroup.value;
      batchGroup.replaceChildren();
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = t('移动到分组'); batchGroup.append(placeholder);
      config().groups.forEach((group) => {
        const option = document.createElement('option'); option.value = group.id; option.textContent = groupLabel(group); batchGroup.append(option);
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
    validIds.forEach((id) => selectedItemIds.delete(id));
    saveCurrent(); renderManager();
  }

  function moveSourceToGroup(sourceId, groupId) {
    moveItemsToGroup(sourceId, groupId);
  }

  /** 配额用尽时的统一出口：说明原因，再把用户送到「关于」里激活。 */
  function redirectToLicense(message: string) {
    window.alert(message);
    document.querySelector<HTMLElement>('.nav-item[data-panel="about"]')?.click();
    licenseCodeInput?.focus();
  }

  function addGroup() {
    // 配额在命名之前判：先让人看到为什么建不了，而不是填完名字才被拒。
    if (!groupQuota(config().groups, license).allowed) {
      redirectToLicense(t('免费版最多创建 {n} 个搜索源分组。激活会员后不限数量，激活码在「关于」里。', { n: FREE_GROUP_LIMIT }));
      return;
    }
    const name = window.prompt(t('分组名称'), t('新分组'));
    if (!name?.trim()) return;
    const id = 'group-' + Date.now();
    config().groups.push({ id, name: name.trim(), items: [], visible: true });
    groupById('default').items.push('group:' + id);
    managerGroupId = id; saveCurrent(); renderManager();
  }
  function renameGroup(group) {
    const name = window.prompt(t('分组名称'), groupLabel(group));
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
    managerGroupId = 'default'; saveCurrent(); renderManager();
  }
  function removeSource(id) {
    settings.general.sources = config().sources.filter((source) => source.id !== id);
    config().groups.forEach((group) => { group.items = group.items.filter((item) => item !== id); });
    iconNodeCache.delete(id);
    if (editing?.id === id && editing.panel === activePanel) resetForm();
    selectedItemIds.delete(id);
    saveCurrent(); renderManager();
  }
  /** 搜索源编辑改成弹窗：行内的铅笔与顶部「添加搜索源」都打开同一个对话框。 */
  function openSourceDialog() {
    if (typeof sourceDialog?.showModal === 'function') {
      if (!sourceDialog.open) sourceDialog.showModal();
    } else sourceDialog?.setAttribute('open', '');
    nameInput?.focus();
  }
  function closeSourceDialogPanel() {
    if (typeof sourceDialog?.close === 'function' && sourceDialog.open) sourceDialog.close();
    else sourceDialog?.removeAttribute('open');
  }
  /** 只清表单与编辑态，不动弹窗本身（关闭动作由「关闭事件」统一收尾）。 */
  function resetSourceFormFields() {
    editing = null; form?.reset();
    if (formTitle) formTitle.textContent = t('添加搜索源');
    if (submitLabel) submitLabel.textContent = t('添加');
    if (errorEl) errorEl.textContent = '';
  }
  function startEdit(source) {
    resetSourceFormFields();
    editing = { panel: MANAGER_PANEL, id: source.id };
    nameInput.value = source.name; markInput.value = source.mark; urlInput.value = source.url;
    formTitle.textContent = t('编辑搜索源'); submitLabel.textContent = t('保存');
    openSourceDialog();
  }
  function resetForm() {
    resetSourceFormFields();
    closeSourceDialogPanel();
  }
  function getFaviconUrl(source) {
    try {
      const parsed = new URL(source.url.replace(/\{query\}/gi, 'quickfind'));
      return 'https://www.google.com/s2/favicons?sz=64&domain_url=' + encodeURIComponent(parsed.origin);
    } catch { return ''; }
  }

  /** 预览下方那行小字：图标现在从哪来。比「已设置」有用，决定用户下一步点哪个按钮。 */
  function iconSourceNote(source) {
    const iconUrl = String(source?.iconUrl || '');
    if (!iconUrl) return t('默认图标');
    if (iconUrl.startsWith('data:image/')) return t('本地图片');
    if (iconUrl.includes('/s2/favicons')) return t('网站图标');
    return t('自定义链接');
  }

  /** 弹窗里的预览与标题：每次换图标、每次打开都重画，它和列表共用同一份 iconUrl。 */
  function renderIconEditorPreview() {
    const source = sourceById(iconEditorSourceId);
    if (!source || !iconEditorPreview) return;
    iconEditorPreview.className = 'source-logo icon-editor-preview ' + String(source.className || '');
    iconEditorPreview.replaceChildren();
    if (source.iconUrl) {
      const image = document.createElement('img');
      image.alt = '';
      image.decoding = 'async';
      image.addEventListener('error', () => { iconEditorPreview.textContent = source.mark || '?'; });
      image.src = String(source.iconUrl);
      iconEditorPreview.append(image);
    } else {
      iconEditorPreview.textContent = source.mark || '?';
    }
    if (iconEditorName) iconEditorName.textContent = source.name;
    if (iconEditorNote) iconEditorNote.textContent = iconSourceNote(source);
    if (restoreIconButton) restoreIconButton.hidden = !source.iconUrl;
  }

  /**
   * 换图标只有一个出口：所有入口（网站图标 / 上传 / 链接 / 恢复默认）都落到这里，
   * 于是「存进 sync、刷新列表、刷新弹窗预览」不会出现只做了其中两步的路径。
   * 与旧版不同，这里不关弹窗：用户要能立刻看见换完的样子，再决定要不要再换。
   */
  function applySourceIcon(iconUrl) {
    const source = sourceById(iconEditorSourceId);
    if (!source) return;
    iconNodeCache.delete(source.id);
    source.iconUrl = iconUrl;
    saveCurrent(); renderSources(); renderIconEditorPreview();
  }

  /** 弹窗里的错误提示只有一个出口，顺便把「元素可能不存在」的判断收在一处。 */
  function setIconEditorError(message) { if (iconEditorError) iconEditorError.textContent = message; }

  function fetchIconFromSite() {
    const source = sourceById(iconEditorSourceId);
    const iconUrl = source ? getFaviconUrl(source) : '';
    if (!iconUrl) { setIconEditorError(t('这个搜索源的地址里没有可用的网站域名。')); return; }
    setIconEditorError('');
    applySourceIcon(iconUrl);
  }

  function openIconEditor(source) {
    if (!iconEditor) return;
    iconEditorSourceId = source.id;
    if (iconUrlInput) iconUrlInput.value = '';
    if (iconFileInput) iconFileInput.value = '';
    setIconEditorError('');
    renderIconEditorPreview();
    if (typeof iconEditor.showModal === 'function') iconEditor.showModal(); else iconEditor.setAttribute('open', '');
    iconUrlInput?.focus();
  }
  function closeIconEditorPanel() {
    iconEditorSourceId = null;
    if (!iconEditor) return;
    if (typeof iconEditor.close === 'function') iconEditor.close(); else iconEditor.removeAttribute('open');
  }
  function iconUrlFromInput(value) {
    if (!value) throw new Error(t('请输入图标地址。'));
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error(t('图标地址需要使用 http 或 https。'));
    return parsed.href;
  }
  function localFileToIconUrl(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error(t('请选择图片。')));
      if (file.size > 5 * 1024 * 1024) return reject(new Error(t('图片不能超过 5 MB。')));
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(t('无法读取图片。')));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error(t('无法使用该图片。')));
        image.onload = () => {
          if (!image.naturalWidth || !image.naturalHeight) return reject(new Error(t('图片尺寸无效。')));
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
    if (activePanel === 'history') renderHistory();
    else if (activePanel === 'notes') renderNotes();
    else if (activePanel === 'sources') renderManager();
    else if (activePanel === 'about') renderAbout();
  }));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameInput.value.trim(), mark = markInput.value.trim().slice(0, 2), url = urlInput.value.trim();
    if (!name || !mark || !url) return;
    if (!url.includes('{query}')) { errorEl.textContent = t('URL 中需要包含 {query} 占位符。'); return; }
    try {
      const parsed = new URL(url.replace(/\{query\}/gi, 'quickfind'));
      if (!/^https?:$/.test(parsed.protocol)) throw new Error();
    } catch { errorEl.textContent = t('请输入有效的 http 或 https 搜索 URL。'); return; }
    const source = editing?.panel === MANAGER_PANEL ? sourceById(editing.id) : null;
    if (!source && !sourceQuota(config().sources, license).allowed) {
      // 弹窗是先打开的：配额可能在编辑期间被别人（另一台设备）占满，这里再判一次，
      // 而不是关掉弹窗让用户以为存上了。
      errorEl.textContent = t('免费版最多启用 {n} 个搜索源，先关掉一个再新增；激活会员后不限数量。', { n: FREE_SOURCE_LIMIT });
      return;
    }
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
    if (!url) { pinnedSiteError.textContent = t('请至少填写站点 URL。'); return; }
    if (selector) {
      try { document.querySelectorAll(selector); } catch { pinnedSiteError.textContent = t('CSS 选择器格式无效。'); return; }
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
    const selected = selectedItemIds;
    if (!selected.size) return;
    const ids = new Set(selected);
    settings.general.sources = config().sources.filter((source) => !ids.has(source.id));
    config().groups.forEach((group) => { group.items = group.items.filter((item) => !ids.has(item)); });
    selected.clear();
    if (editing && editing.panel === MANAGER_PANEL && ids.has(editing.id)) resetForm();
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
    moveSourceToGroup(Array.from(selectedItemIds), batchGroup.value);
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
  addSourceButton?.addEventListener('click', () => {
    if (!sourceQuota(config().sources, license).allowed) {
      redirectToLicense(t('免费版最多启用 {n} 个搜索源，先关掉一个再新增；激活会员后不限数量，激活码在「关于」里。', { n: FREE_SOURCE_LIMIT }));
      return;
    }
    resetForm(); openSourceDialog();
  });
  closeSourceDialog?.addEventListener('click', resetForm);
  // 点遮罩关闭：目标就是 dialog 本身时才算点在弹窗外。
  sourceDialog?.addEventListener('click', (event) => { if (event.target === sourceDialog) resetForm(); });
  sourceDialog?.addEventListener('close', resetSourceFormFields);
  addGroupButton.addEventListener('click', addGroup);
  activateLicenseButton?.addEventListener('click', activateLicense);
  clearLicenseButton?.addEventListener('click', clearLicense);
  licenseEmailInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); licenseCodeInput?.focus(); } });
  licenseEmailInput?.addEventListener('input', () => { if (licenseError) licenseError.textContent = ''; });
  licenseCodeInput?.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); activateLicense(); } });
  licenseCodeInput?.addEventListener('input', () => { if (licenseError) licenseError.textContent = ''; });
  defaultGroupCountInput.addEventListener('change', () => {
    settings.defaultGroupCount = Math.max(1, Math.min(MAX_DEFAULT_GROUP_COUNT, Number(defaultGroupCountInput.value) || SHARED_DEFAULTS.defaultGroupCount));
    defaultGroupCountInput.value = settings.defaultGroupCount; saveGeneral('selection');
  });
  pinnedDefaultGroupCountInput.addEventListener('change', () => {
    settings.pinned.defaultGroupCount = Math.max(1, Math.min(MAX_DEFAULT_GROUP_COUNT, Number(pinnedDefaultGroupCountInput.value) || DEFAULT_PINNED_SEARCH.defaultGroupCount));
    pinnedDefaultGroupCountInput.value = settings.pinned.defaultGroupCount; savePinned();
  });
  pinnedCollapseDelayInput?.addEventListener('change', () => {
    settings.pinned.collapseDelay = Math.max(0, Math.min(60000, Number(pinnedCollapseDelayInput.value) || 0));
    pinnedCollapseDelayInput.value = settings.pinned.collapseDelay; savePinned();
  });
  pinnedAllSitesInput?.addEventListener('change', () => {
    settings.pinned.allSites = pinnedAllSitesInput.checked;
    syncPinnedSitesRow();
    savePinned();
  });
  selectionTriggerDelayInput?.addEventListener('change', () => {
    settings.selectionTriggerDelay = Math.max(0, Math.min(2000, Number(selectionTriggerDelayInput.value) || 0));
    selectionTriggerDelayInput.value = settings.selectionTriggerDelay; saveGeneral('selection');
  });
  triggerInputs.forEach((input) => input.addEventListener('change', () => {
    if (!input.checked) return;
    settings.triggerMode = input.value; saveGeneral('selection');
  }));
  languageInputs.forEach((input) => input.addEventListener('change', () => {
    if (!input.checked) return;
    settings.language = normalizeLocale(input.value);
    applyInterfaceLanguage();
    saveGeneral('common');
  }));
  editableTriggerInputs.forEach((input) => input.addEventListener('change', () => {
    if (!input.checked) return;
    settings.editableTriggerMode = input.value; saveGeneral('selection');
  }));
  llmDockVisibleInput?.addEventListener('change', () => {
    settings.llmDockVisible = llmDockVisibleInput.checked;
    saveGeneral('llm');
  });
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
    saveGeneral('llm');
  }
  [llmEnabledInput, llmEndpointInput, llmModelInput, llmApiKeyInput, llmSystemPromptInput].filter(Boolean).forEach((input) => {
    input.addEventListener('change', saveLlmConfig);
    if (input.tagName === 'TEXTAREA' || input.type === 'text' || input.type === 'url' || input.type === 'password') input.addEventListener('blur', saveLlmConfig);
  });
  closeIconEditor?.addEventListener('click', closeIconEditorPanel);
  fetchIconButton?.addEventListener('click', fetchIconFromSite);
  uploadIconButton?.addEventListener('click', () => iconFileInput?.click());
  restoreIconButton?.addEventListener('click', () => { setIconEditorError(''); applySourceIcon(''); });
  applyIconUrl?.addEventListener('click', () => {
    try {
      applySourceIcon(iconUrlFromInput(String(iconUrlInput?.value || '').trim()));
      if (iconUrlInput) iconUrlInput.value = '';
      setIconEditorError('');
    } catch (error) { setIconEditorError(error.message || t('无法使用该图标地址。')); }
  });
  iconEditor?.querySelector('form')?.addEventListener('submit', (event) => { event.preventDefault(); applyIconUrl?.click(); });
  iconFileInput?.addEventListener('change', async () => {
    try { applySourceIcon(await localFileToIconUrl(iconFileInput.files?.[0])); iconFileInput.value = ''; setIconEditorError(''); }
    catch (error) { setIconEditorError(error.message || t('无法使用该图片。')); }
  });
  iconEditor?.addEventListener('cancel', () => { iconEditorSourceId = null; });

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
    if (area !== 'sync' || !settings) return;
    // 会员记录也可能在另一台设备上被激活：状态与分组配额要跟着刷新。
    if (changes.license) {
      license = normalizeLicenseRecord(changes.license.newValue);
      renderGroupQuotaButton();
      if (activePanel === 'about') renderLicenseState();
    }
    // 语言也可能在另一台设备/另一个标签页里改过：跟着切换，别停在旧语言。
    if (changes.language) {
      settings.language = normalizeLocale(changes.language.newValue);
      applyInterfaceLanguage();
    }
    if (!changes.searchHistory) return;
    settings.searchHistory = normalizeSearchHistory(changes.searchHistory.newValue);
    selectedHistoryIndexes.clear();
    if (activePanel === 'history') renderHistory();
  });

  // 收款码与联系码是私有素材（public/pay/ 不入库）：从源码构建时这两张图不存在，
  // 浏览器会画出两个破图框。加载失败就把整块扫码区域摘掉，上面的微信号文字仍然有效。
  document.querySelectorAll('.pay-codes img').forEach((img) => {
    img.addEventListener('error', () => { img.closest('.pay-codes')?.remove(); }, { once: true });
  });

  chrome.storage.sync.get(null, (stored) => {
    settings = normalizeSettings({ ...DEFAULTS, ...defaultConfigSeed(stored), ...stored });
    license = normalizeLicenseRecord(stored.license);
    void hydrateSession();
    // 上次离线点了「清除激活码」的话，这里把没发出去的停用请求补上，把设备位还给用户。
    void flushPendingReleases();
    defaultGroupCountInput.value = settings.defaultGroupCount;
    pinnedDefaultGroupCountInput.value = settings.pinned.defaultGroupCount;
    if (pinnedCollapseDelayInput) pinnedCollapseDelayInput.value = settings.pinned.collapseDelay;
    if (pinnedAllSitesInput) pinnedAllSitesInput.checked = settings.pinned.allSites === true;
    syncPinnedSitesRow();
    if (selectionTriggerDelayInput) selectionTriggerDelayInput.value = settings.selectionTriggerDelay;
    if (llmEnabledInput) llmEnabledInput.checked = settings.llm.enabled !== false;
    if (llmDockVisibleInput) llmDockVisibleInput.checked = settings.llmDockVisible !== false;
    if (llmEndpointInput) llmEndpointInput.value = settings.llm.endpoint;
    if (llmModelInput) llmModelInput.value = settings.llm.model;
    if (llmApiKeyInput) llmApiKeyInput.value = settings.llm.apiKey;
    if (llmSystemPromptInput) llmSystemPromptInput.value = settings.llm.systemPrompt;
    triggerInputs.forEach((input) => { input.checked = input.value === settings.triggerMode; });
    editableTriggerInputs.forEach((input) => { input.checked = input.value === settings.editableTriggerMode; });
    applyInterfaceLanguage();
    const hasLegacy = LEGACY_KEYS.some((key) => Object.prototype.hasOwnProperty.call(stored, key));
    const hasDeprecatedPinnedContent = ['sources', 'groups', 'engines', 'iconOnly', 'engineOrder', 'customEngines'].some((key) => Object.prototype.hasOwnProperty.call(stored.pinnedSearch || {}, key));
    if (stored.sourceConfigVersion !== CONFIG_VERSION || !stored.pinnedSearch ||
    Number(stored.pinnedSearch?.siteConfigVersion) !== PINNED_SITE_CONFIG_VERSION || hasLegacy || hasDeprecatedPinnedContent) {
      // 迁移写入同样走 writeSync：这是最容易撞上配额的一次写入（要连同 sources 一起刷新），
      // 而且它失败时用户什么都没改，界面必须给出原因，否则配置会停在半迁移状态。
      writeSync({
        enabled: settings.enabled, triggerMode: settings.triggerMode,
        editableTriggerMode: settings.editableTriggerMode, defaultGroupCount: settings.defaultGroupCount, selectionTriggerDelay: settings.selectionTriggerDelay, llm: settings.llm,
        llmDockVisible: settings.llmDockVisible,
        sources: settings.general.sources, groups: settings.general.groups, specialActions: settings.general.actions, pinnedSearch: settings.pinned, sourceConfigVersion: CONFIG_VERSION
      }, activePanel, () => { if (hasLegacy) chrome.storage.sync.remove(LEGACY_KEYS); });
    }
  });
  void loadNotes();
})();
