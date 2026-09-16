// @ts-nocheck
// 由早期手写 JavaScript 迁移而来，尚未补齐类型标注；补全后删除本行。见 README「迁移状态」。
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
  'use strict';

  const DEFAULT_SETTINGS = {
    enabled: true,
    engines: {
      google: true,
      baidu: true,
      'google-scholar': true,
      duckduckgo: true,
      so: true,
      sogou: true,
      bing: true,
      yandex: true,
      'google-ai': true,
      bilibili: true,
      xiaohongshu: true,
      x: true,
      youtube: true,
      zhihu: true,
      douyin: true,
      doubao: true,
      deepseek: true
    },
    iconOnly: {},
    customEngines: [],
    engineOrder: ['google', 'baidu', 'google-scholar', 'duckduckgo', 'so', 'sogou', 'bing', 'yandex', 'google-ai', 'bilibili', 'xiaohongshu', 'x', 'youtube', 'zhihu', 'douyin', 'doubao', 'deepseek'],
    sources: [],
    groups: [],
    searchHistory: [],
    llm: { enabled: true, endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini', apiKey: '', systemPrompt: '' },
    triggerMode: 'click',
    editableTriggerMode: 'click',
    defaultGroupCount: 4,
    selectionTriggerDelay: 200
  };
  const MAX_DEFAULT_GROUP_COUNT = 20;

  const PINNED_SITES = [
    { id: 'google', name: 'Google' },
    { id: 'baidu', name: '百度' },
    { id: 'google-scholar', name: '谷歌学术' },
    { id: 'duckduckgo', name: 'DuckDuckGo' },
    { id: 'so', name: '360 搜索' },
    { id: 'sogou', name: '搜狗' },
    { id: 'bing', name: 'Bing' },
    { id: 'yandex', name: 'Yandex' },
    { id: 'zhihu', name: '知乎' },
    { id: 'bilibili', name: '哔哩哔哩' },
    { id: 'douyin', name: '抖音' }
  ];
  const LEGACY_PINNED_SITE_IDS = new Set(['google', 'bing', 'yandex', 'zhihu', 'bilibili']);
  const PINNED_SITE_CONFIG_VERSION = 3;
  const DEFAULT_PINNED_SITE_IDS = PINNED_SITES.map((site) => site.id);
  const GENERIC_PINNED_INPUT_SELECTOR = 'input[type="search"], input[name="q"], input[name="query"], input[name="keyword"], input[name="text"], input[placeholder*="搜索"], input[placeholder*="Search"], textarea[name="q"]';

  const ENGINES = [
    {
      id: 'google',
      name: '谷歌',
      className: 'google',
      mark: 'G',
      buildUrl: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}`
    },
    {
      id: 'baidu',
      name: '百度',
      className: 'baidu',
      mark: '百',
      buildUrl: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`
    },
    {
      id: 'google-scholar',
      name: '谷歌学术',
      className: 'google-scholar',
      mark: 'GS',
      buildUrl: (query) => `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`
    },
    {
      id: 'duckduckgo',
      name: 'DuckDuckGo',
      className: 'duckduckgo',
      mark: 'D',
      buildUrl: (query) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}`
    },
    {
      id: 'so',
      name: '360 搜索',
      className: 'so',
      mark: '360',
      buildUrl: (query) => `https://www.so.com/s?q=${encodeURIComponent(query)}`
    },
    {
      id: 'sogou',
      name: '搜狗',
      className: 'sogou',
      mark: '搜',
      buildUrl: (query) => `https://www.sogou.com/web?query=${encodeURIComponent(query)}`
    },
    {
      id: 'bing',
      name: 'Bing',
      className: 'bing',
      mark: 'b',
      buildUrl: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`
    },
    {
      id: 'yandex',
      name: 'Yandex',
      className: 'yandex',
      mark: 'Я',
      buildUrl: (query) => `https://yandex.com/search/?text=${encodeURIComponent(query)}`
    },
    {
      id: 'google-ai',
      name: 'Google AI Mode',
      className: 'google-ai',
      mark: 'AI',
      buildUrl: (query) => `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50`
    },
    {
      id: 'bilibili',
      name: '哔哩哔哩',
      className: 'bilibili',
      mark: 'B',
      buildUrl: (query) => `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`
    },
    {
      id: 'xiaohongshu',
      name: '小红书',
      className: 'xiaohongshu',
      mark: '红',
      buildUrl: (query) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}`
    },
    {
      id: 'x',
      name: 'X',
      className: 'x',
      mark: 'X',
      buildUrl: (query) => `https://x.com/search?q=${encodeURIComponent(query)}`
    },
    {
      id: 'youtube',
      name: 'YouTube',
      className: 'youtube',
      mark: '▶',
      buildUrl: (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
    },
    {
      id: 'zhihu',
      name: '知乎',
      className: 'zhihu',
      mark: '知',
      buildUrl: (query) => `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(query)}`
    },
    {
      id: 'douyin',
      name: '抖音',
      className: 'douyin',
      mark: '抖',
      buildUrl: (query) => `https://www.douyin.com/search/${encodeURIComponent(query)}?type=general`
    },
    {
      id: 'doubao',
      name: '豆包',
      className: 'doubao',
      mark: '豆',
      buildUrl: (query) => `https://www.doubao.com/chat/?quickfind=${encodeURIComponent(query)}`
    },
    {
      id: 'deepseek',
      name: 'DeepSeek',
      className: 'deepseek',
      mark: 'DS',
      buildUrl: (query) => `https://chat.deepseek.com/?q=${encodeURIComponent(query)}`
    }
  ];
  const SPECIAL_ACTIONS = [
    { id: 'copy', name: '复制', className: 'special-copy', mark: '复', action: 'copy', isSpecial: true }
  ];

  let settings = cloneSettings(DEFAULT_SETTINGS);
  let selectedText = '';
  let selectedRange = null;
  let selectedInput = null;
  let selectedInputStart = 0;
  let selectedInputEnd = 0;
  let anchorRect = null;
  let panelOpen = false;
  let expanded = false;
  let expandedGroupId = null;
  let panelManuallyMoved = false;
  let panelDragTimer = null;
  let panelDragState = null;
  let pinnedHost = null;
  let pinnedExpandedGroupId = null;
  let pinnedMoreExpanded = false;
  let pinnedBarCollapsed = false;
  let pinnedCollapseTimer = null;
  let pinnedCollapseDeadline = 0;
  let pinnedCollapsePaused = false;
  let pinnedQueryComposing = false;
  let pinnedMountTimer = null;
  let pinnedMountedSiteId = null;
  let pinnedMountedPageKey = '';
  let contextAnchor = null;
  let selectionPointer = null;
  let selectionPointerPending = false;
  let selectionPointerText = '';
  let mouseButtonDown = false;
  let selectionShowTimer = null;
  const LLM_CONVERSATIONS_KEY = 'quickfind-llm-conversations';
  let llmConversations = [];
  let llmActiveConversation = null;
  let llmCloseTimer = null;
  let llmDockOpen = false;
  let llmHistorySignature = '';
  let llmRequestInFlight = false;
  let triggerHoverTimer = null;
  const TRIGGER_HOVER_OPEN_DELAY = 100;

  const host = document.createElement('div');
  host.id = 'quickfind-shadow-host';
  host.style.cssText = 'position:fixed;inset:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      *, *::before, *::after { box-sizing: border-box; }
      .quickfind-trigger,
      .quickfind-panel { position: fixed; font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      .quickfind-trigger {
        display: grid;
        place-items: center;
        width: 25px;
        height: 25px;
        padding: 0;
        border: 0;
        border-radius: 7px;
        color: rgba(62,143,108,.88);
        background: transparent;
        box-shadow: none;
        cursor: pointer;
        opacity: 0;
        transform: translateX(-4px) scale(.94);
        transition: opacity .16s ease, transform .16s ease, background .16s ease, box-shadow .16s ease;
        pointer-events: auto;
      }
      .quickfind-trigger.visible { opacity: .9; transform: translateX(0) scale(1); }
      .quickfind-trigger.disabled { color:#a6b0aa; }
      .quickfind-trigger:hover { opacity: 1; color:#19352c; background:transparent; }
      .quickfind-trigger[aria-expanded="true"] { visibility:hidden; opacity:0; pointer-events:none; transform:translateX(-4px) scale(.94); }
      .quickfind-trigger:focus-visible, .engine:focus-visible, .panel-close:focus-visible { outline: 2px solid #3a8c6a; outline-offset: 2px; }
      .quickfind-trigger svg { width: 18px; height: 18px; stroke: currentColor; stroke-width: 2; fill: none; stroke-linecap: round; stroke-linejoin: round; }
      .quickfind-panel {
        width: max-content;
        max-width: calc(100vw - 20px);
        padding: 5px 7px 7px;
        border: 1px solid rgba(255,255,255,.7);
        border-radius: 11px;
        background: rgba(250, 253, 251, .94);
        box-shadow: 0 18px 45px rgba(20, 53, 40, .2), 0 2px 5px rgba(20, 53, 40, .08);
        backdrop-filter: blur(18px) saturate(1.25);
        -webkit-backdrop-filter: blur(18px) saturate(1.25);
        opacity: 0;
        transform: translateY(-5px);
        pointer-events: none;
        transition: opacity .16s ease, transform .16s ease;
      }
      .quickfind-panel.visible { opacity: 1; transform: translateY(0); pointer-events: auto; }
      .panel-drag-handle { display:grid; place-items:center; width:100%; height:9px; padding:0; border:0; color:#a2b4aa; background:transparent; cursor:grab; touch-action:none; }
      .panel-drag-handle::before { content:""; width:27px; height:3px; border-radius:99px; background:currentColor; }
      .panel-drag-handle:hover { color:#527967; }
      .panel-drag-handle:active, .quickfind-panel.dragging .panel-drag-handle { cursor:grabbing; }
      .panel-head { display:flex; flex-direction:column; align-items:stretch; min-width:0; margin-bottom:6px; }
      .query-row { position:relative; display:flex; align-items:center; min-width:180px; }
      .query-input { width:100%; height:28px; min-height:28px; max-height:116px; padding:3px 31px 3px 8px; overflow:hidden; resize:none; border:1px solid #dbe8e0; border-radius:6px; outline:none; color:#29483b; background:rgba(255,255,255,.9); font:11px/18px Inter,ui-sans-serif,sans-serif; }
      .query-input:focus { border-color:#6eaf8d; box-shadow:0 0 0 2px rgba(62,143,108,.12); }
      .query-row.expanded .query-input { padding-top:5px; padding-bottom:5px; overflow-y:auto; line-height:16px; }
      .query-expand { position:absolute; top:4px; right:4px; display:grid; place-items:center; width:20px; height:20px; padding:0; border:0; border-radius:5px; color:#789087; background:transparent; cursor:pointer; }
      .query-expand:hover, .query-expand[aria-expanded="true"] { color:#2f795b; background:#edf7f0; }
      .query-expand:focus-visible { outline:2px solid #3a8c6a; outline-offset:2px; }
      .query-expand svg { width:13px; height:13px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
      .panel-close { display:none; }
      .panel-close svg { width:14px; height:14px; stroke:currentColor; stroke-width:2; fill:none; stroke-linecap:round; }
      .engine-list { display:flex; align-items:center; flex-wrap:nowrap; gap:4px; width:max-content; max-width:100%; overflow-x:auto; }
      .hidden-engine-list { display:flex; flex-direction:column; align-items:stretch; gap:4px; width:100%; min-width:180px; margin-top:5px; padding-top:5px; border-top:1px solid #e5eee8; }
      .hidden-engine-list[hidden] { display:none; }
      .group-engine-list { position:absolute; z-index:1; display:flex; flex-direction:column; align-items:stretch; gap:4px; min-width:160px; max-width:calc(100vw - 20px); max-height:calc(100vh - 20px); padding:5px; overflow-y:auto; border:1px solid rgba(255,255,255,.78); border-radius:8px; background:rgba(250,253,251,.98); box-shadow:0 12px 30px rgba(20,53,40,.18),0 2px 5px rgba(20,53,40,.08); backdrop-filter:blur(14px) saturate(1.2); -webkit-backdrop-filter:blur(14px) saturate(1.2); pointer-events:auto; }
      .group-engine-list[hidden] { display:none; }
      .group-engine-list .engine { width:100%; justify-content:flex-start; }
      .engine { display:flex; flex:0 0 auto; min-width:0; flex-direction:row; align-items:center; gap:4px; padding:4px 6px 4px 4px; border:1px solid #dbe8e0; border-radius:7px; color:#324640; background:rgba(255,255,255,.75); cursor:pointer; transition: border-color .14s ease, background .14s ease, transform .14s ease, box-shadow .14s ease; }
      .hidden-engine-list .engine { width:100%; justify-content:flex-start; }
      .engine:hover { border-color:#a8cbb9; background:#f7fcf9; transform:translateY(-1px); box-shadow:0 4px 10px rgba(42, 88, 68, .1); }
      .engine:active { transform:translateY(0); }
      .engine-mark { display:grid; place-items:center; width:19px; height:19px; overflow:hidden; border-radius:5px; font:700 11px/1 Arial, sans-serif; }
      .engine-mark img { width:100%; height:100%; object-fit:cover; }
      .engine-name { overflow:hidden; max-width:64px; text-overflow:ellipsis; white-space:nowrap; font-size:10px; font-weight:600; }
      .engine.icon-only { padding-right:4px; }
      .engine.icon-only .engine-name { display:none; }
      .engine.group-text-only { padding:5px 8px; }
      .engine.group-text-only .engine-name { max-width:100px; }
      .google .engine-mark { color:#fff; background:#4285f4; }
      .baidu .engine-mark { color:#fff; background:#2932e1; }
      .google-scholar .engine-mark { color:#fff; background:#5f6368; font-size:9px; }
      .duckduckgo .engine-mark { color:#fff; background:#de5833; }
      .so .engine-mark { color:#fff; background:#19a15f; font-size:9px; }
      .sogou .engine-mark { color:#fff; background:#ff5a34; }
      .bing .engine-mark { color:#fff; background:#1185e0; }
      .yandex .engine-mark { color:#fff; background:#ef3b3b; }
      .google-ai .engine-mark { color:#fff; background:#6b5ce7; font-size:9px; }
      .bilibili .engine-mark { color:#fff; background:#00aeec; }
      .xiaohongshu .engine-mark { color:#fff; background:#ef4d62; }
      .x .engine-mark { color:#fff; background:#111; }
      .youtube .engine-mark { color:#fff; background:#f21f26; }
      .zhihu .engine-mark { color:#fff; background:#1777e6; }
      .douyin .engine-mark { color:#fff; background:#161823; }
      .doubao .engine-mark { color:#fff; background:#4f7cff; }
      .deepseek .engine-mark { color:#fff; background:#4d6bfe; font-size:9px; }
      .special-copy .engine-mark { color:#fff; background:#6c8178; }
      .custom .engine-mark { color:#587269; background:#e6efe9; }
      .more-engine .engine-mark { color:#587269; background:#e6efe9; font-size:13px; }
      .group .engine-mark { color:#315f4d; background:#dfeee5; font-size:12px; }
      .llm-dock { position:fixed; inset:0; z-index:2147483646; width:100vw; height:100vh; pointer-events:none; font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:#203b31; }
      .llm-rail { position:fixed; top:50%; right:0; display:flex; align-items:center; justify-content:center; width:14px; height:20vh; min-height:96px; max-height:176px; padding:0; border:0; border-left:1px solid #e4eee8; border-radius:9px 0 0 9px; transform:translateY(-50%); color:#6a8978; background:#fff; box-shadow:-4px 0 14px rgba(24,61,44,.08); cursor:pointer; pointer-events:auto; transition:width .22s ease, color .18s ease, box-shadow .22s ease; }
      .llm-rail::before { content:""; width:3px; height:44px; border-radius:99px; background:currentColor; opacity:.55; transition:height .18s ease,opacity .18s ease; }
      .llm-rail:hover,.llm-dock.is-open .llm-rail { width:16px; color:#2f795b; box-shadow:-6px 0 18px rgba(24,61,44,.13); }
      .llm-rail:hover::before,.llm-dock.is-open .llm-rail::before { height:68px; opacity:.8; }
      .llm-sidebar { position:fixed; top:0; right:0; display:flex; flex-direction:column; width:min(392px,calc(100vw - 24px)); height:100vh; overflow:hidden; border-left:1px solid #dce9e1; background:#fff; box-shadow:-18px 0 46px rgba(25,57,42,.15); pointer-events:auto; transform:translateX(102%); transition:transform .28s cubic-bezier(.2,.8,.2,1); }
      .llm-dock.is-open .llm-sidebar { transform:translateX(0); }
      .llm-sidebar-head { display:flex; align-items:center; gap:10px; min-height:74px; padding:17px 18px 12px; border-bottom:1px solid #edf3ef; }
      .llm-brand-mark { display:grid; place-items:center; width:34px; height:34px; flex:0 0 auto; border-radius:10px; color:#f5c56b; background:#19352c; }
      .llm-brand-mark svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
      .llm-kicker { color:#779286; font-size:9px; font-weight:750; letter-spacing:.13em; }
      .llm-title { margin-top:2px; color:#19352c; font-size:18px; font-weight:730; line-height:1.2; }
      .llm-sidebar-close { display:grid; place-items:center; width:28px; height:28px; margin-left:auto; padding:0; border:0; border-radius:6px; color:#81958a; background:transparent; cursor:pointer; }
      .llm-sidebar-close:hover { color:#19352c; background:#edf5ef; }
      .llm-sidebar-close svg,.llm-new-chat svg,.llm-chat-icon svg { width:15px; height:15px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
      .llm-status-row { display:flex; align-items:center; gap:7px; min-height:38px; padding:0 18px; color:#73867c; font-size:10px; }
      .llm-status-dot { width:7px; height:7px; flex:0 0 auto; border-radius:50%; background:#d6a05b; box-shadow:0 0 0 3px #fff6e9; }
      .llm-status-dot.ready { background:#3e9a6e; box-shadow:0 0 0 3px #e9f7ee; }
      .llm-status-dot.busy { background:#4f7cff; box-shadow:0 0 0 3px #edf0ff; animation:quickfind-llm-pulse 1.2s ease-in-out infinite; }
      .llm-status-dot.error { background:#c76a5f; box-shadow:0 0 0 3px #fcecea; }
      .llm-status-text { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .llm-new-chat { display:inline-flex; align-items:center; gap:4px; min-height:25px; margin-left:auto; padding:0 7px; border:1px solid #d6e6dc; border-radius:6px; color:#3c6d58; background:#fff; font-size:10px; cursor:pointer; }
      .llm-new-chat:hover { border-color:#7db394; background:#f2faf4; }
      .llm-history-wrap { min-height:0; flex:1; padding:8px 15px 14px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:#cadbd0 transparent; }
      .llm-history-heading { display:flex; align-items:center; justify-content:space-between; padding:5px 3px 9px; color:#506d5d; font-size:11px; font-weight:700; }
      .llm-history-count { color:#9aaa9f; font-size:10px; font-weight:500; }
      .llm-history-list { display:flex; flex-direction:column; gap:8px; }
      .llm-history-card { display:block; width:100%; min-height:78px; padding:12px 13px; border:1px solid #e0ece4; border-radius:8px; color:#29483b; background:#fbfdfb; text-align:left; cursor:pointer; transition:border-color .14s ease,background .14s ease,box-shadow .14s ease,transform .14s ease; }
      .llm-history-card:hover { border-color:#9cc5aa; background:#f7fcf8; box-shadow:0 6px 16px rgba(42,88,68,.08); transform:translateY(-1px); }
      .llm-history-card:focus-visible,.llm-send:focus-visible,.llm-chat-close:focus-visible,.llm-chat-back:focus-visible,.llm-rail:focus-visible,.llm-sidebar-close:focus-visible { outline:2px solid #3e8f6c; outline-offset:2px; }
      .llm-card-title { display:block; overflow:hidden; color:#264d3b; font-size:12px; font-weight:680; line-height:1.45; text-overflow:ellipsis; white-space:nowrap; }
      .llm-card-preview { display:-webkit-box; margin-top:6px; overflow:hidden; color:#82958a; font-size:10px; line-height:1.5; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
      .llm-card-meta { display:flex; align-items:center; justify-content:space-between; margin-top:8px; color:#a0aea5; font-size:9px; }
      .llm-history-empty { display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:240px; padding:24px 25px; color:#91a199; text-align:center; }
      .llm-history-empty[hidden] { display:none; }
      .llm-history-empty svg { width:32px; height:32px; margin-bottom:10px; fill:none; stroke:#a9bbb0; stroke-width:1.4; stroke-linecap:round; stroke-linejoin:round; }
      .llm-history-empty strong { color:#587466; font-size:12px; font-weight:680; }
      .llm-history-empty span { max-width:220px; margin-top:6px; font-size:10px; line-height:1.6; }
      .llm-compose { margin:0; padding:11px 15px 15px; border-top:1px solid #e6efe9; background:#fff; }
      .llm-compose-box { position:relative; border:1px solid #d4e4da; border-radius:8px; background:#fbfdfb; transition:border-color .14s ease,box-shadow .14s ease; }
      .llm-compose-box:focus-within { border-color:#80b595; box-shadow:0 0 0 3px rgba(62,143,108,.1); }
      .llm-compose textarea,.llm-chat-compose textarea { display:block; width:100%; min-height:52px; max-height:128px; padding:10px 12px 5px; border:0; outline:none; resize:none; overflow-y:auto; color:#29483b; background:transparent; font:12px/1.55 Inter,ui-sans-serif,sans-serif; }
      .llm-compose textarea::placeholder,.llm-chat-compose textarea::placeholder { color:#a2b0a8; }
      .llm-compose-bottom { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 7px 7px 12px; }
      .llm-compose-hint { color:#9aaa9f; font-size:9px; }
      .llm-send { display:grid; place-items:center; width:28px; height:28px; padding:0; border:0; border-radius:7px; color:#fff; background:#2f795b; cursor:pointer; }
      .llm-send:hover { background:#25654b; }
      .llm-send:disabled { opacity:.45; cursor:not-allowed; }
      .llm-send svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round; }
      .llm-tabbar { display:flex; gap:3px; flex:0 0 auto; margin:0 15px 8px; padding:3px; border-radius:10px; background:#f0f6f2; }
      .llm-tab { display:flex; flex:1; align-items:center; justify-content:center; min-width:0; min-height:29px; padding:0 8px; overflow:hidden; border:0; border-radius:8px; color:#7d9086; background:transparent; font-size:11px; font-weight:700; white-space:nowrap; text-overflow:ellipsis; cursor:pointer; transition:color .15s ease, background .15s ease, box-shadow .15s ease; }
      .llm-tab:hover { color:#2f795b; }
      .llm-tab.is-active { color:#19352c; background:#fff; box-shadow:0 1px 4px rgba(24,61,44,.12); }
      .llm-tab:focus-visible { outline:2px solid #3e8f6c; outline-offset:1px; }
      .llm-pane { display:flex; flex:1; flex-direction:column; min-height:0; }
      .llm-pane[hidden] { display:none; }
      .outline-toolbar { display:flex; align-items:center; gap:5px; flex:0 0 auto; padding:0 15px 7px; }
      .outline-search { display:flex; align-items:center; gap:4px; flex:1; min-width:0; height:28px; padding:0 7px; border:1px solid #dbe8e0; border-radius:7px; background:#fff; }
      .outline-search:focus-within { border-color:#80b595; }
      .outline-search svg { width:11px; height:11px; flex:0 0 auto; fill:none; stroke:#8fa298; stroke-width:2; stroke-linecap:round; }
      .outline-search input { min-width:0; flex:1; border:0; padding:0; outline:none; color:#29483b; background:transparent; font:11px Inter,ui-sans-serif,sans-serif; }
      .outline-tool-button { display:inline-flex; align-items:center; justify-content:center; gap:3px; min-height:28px; flex:0 0 auto; padding:0 8px; border:1px solid #d6e6dc; border-radius:7px; color:#3c6d58; background:#fff; font-size:10px; font-weight:650; white-space:nowrap; cursor:pointer; }
      .outline-tool-button:hover { border-color:#7db394; background:#f2faf4; }
      .outline-tool-button:disabled { opacity:.45; cursor:not-allowed; }
      .outline-tool-button:focus-visible { outline:2px solid #3e8f6c; outline-offset:1px; }
      .outline-tool-button svg { width:11px; height:11px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
      .outline-tool-icon { width:28px; padding:0; }
      .outline-context { display:flex; align-items:center; gap:5px; flex:0 0 auto; padding:0 15px 6px; }
      .outline-home { flex:0 0 auto; padding:3px 8px; border:1px solid #d6e6dc; border-radius:6px; color:#3c6d58; background:#fff; font-size:10px; font-weight:650; white-space:nowrap; cursor:pointer; }
      .outline-home:hover { border-color:#7db394; background:#f2faf4; }
      .outline-context-separator { color:#b6c6bc; }
      .outline-breadcrumb { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#4b6157; font-size:10px; }
      .outline-search-result { flex:0 0 auto; color:#8fa298; font-size:10px; }
      .outline-scroll { flex:1; min-height:0; padding:4px 10px 14px; overflow-y:auto; scrollbar-width:thin; scrollbar-color:#cadbd0 transparent; }
      .outline-list { position:relative; }
      .notes-zoom-heading { padding:2px 6px 8px; color:#4b6157; font-size:11px; font-weight:700; }
      .notes-empty { padding:26px 10px; color:#91a199; font-size:11px; line-height:1.7; text-align:center; }
      .note-row { display:flex; align-items:flex-start; gap:3px; padding:1px 0; border-radius:6px; }
      .note-row.dragging { opacity:.4; }
      .note-row.drag-target-before { box-shadow:inset 0 2px 0 #3e8f6c; }
      .note-row.drag-target-inside { box-shadow:inset 0 0 0 2px #3e8f6c; }
      .note-row.drag-target-after { box-shadow:inset 0 -2px 0 #3e8f6c; }
      .note-toggle { display:grid; place-items:center; width:16px; height:22px; flex:0 0 auto; padding:0; border:0; border-radius:4px; color:#93a79c; background:transparent; cursor:pointer; }
      .note-toggle:hover:not(:disabled) { color:#2f795b; background:#eef7f1; }
      .note-toggle:disabled { opacity:.35; cursor:default; }
      .note-toggle svg { width:10px; height:10px; fill:none; stroke:currentColor; stroke-width:2.4; stroke-linecap:round; stroke-linejoin:round; transition:transform .15s ease; }
      .note-toggle.collapsed svg { transform:rotate(-90deg); }
      .note-complete { display:grid; place-items:center; width:17px; height:22px; flex:0 0 auto; padding:0; border:0; color:#93a79c; background:transparent; cursor:pointer; }
      .note-complete:hover { color:#2f795b; }
      .note-complete svg { width:12px; height:12px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
      .note-row.completed .note-input { color:#a0aea5; text-decoration:line-through; }
      .note-bullet { display:grid; place-items:center; width:7px; height:22px; flex:0 0 auto; }
      .note-bullet::before { content:""; width:5px; height:5px; border-radius:50%; background:#b9cbc0; }
      .note-input { min-width:0; flex:1; padding:2px 4px; border:1px solid transparent; border-radius:6px; outline:none; resize:none; overflow:hidden; color:#2c4b3d; background:transparent; font:12px/1.6 Inter,ui-sans-serif,sans-serif; cursor:text; }
      .note-input:hover { border-color:#e2ece6; }
      .note-input:focus { border-color:#80b595; background:#fff; box-shadow:0 0 0 2px rgba(62,143,108,.12); }
      .note-row.search-match .note-input { background:#f2faf4; }
      .note-zoom { display:grid; place-items:center; width:17px; height:22px; flex:0 0 auto; padding:0; border:0; border-radius:4px; color:#8fa298; background:transparent; cursor:pointer; opacity:0; transition:opacity .14s ease; }
      .note-zoom:hover { color:#2f795b; background:#eef7f1; }
      .note-zoom svg { width:11px; height:11px; fill:none; stroke:currentColor; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }
      .note-drag { display:grid; place-items:center; width:13px; height:22px; flex:0 0 auto; color:#b6c6bc; font-size:10px; cursor:grab; opacity:0; transition:opacity .14s ease; }
      .note-row:hover .note-zoom,.note-row:hover .note-drag,.note-row:focus-within .note-zoom,.note-row:focus-within .note-drag { opacity:1; }
      .outline-hint { flex:0 0 auto; padding:0 15px 12px; color:#a0aea5; font-size:9px; }
      .llm-chat-layer { position:fixed; inset:0; z-index:3; pointer-events:auto; }
      .llm-chat-layer[hidden] { display:none; }
      .llm-backdrop { position:absolute; inset:0; background:rgba(22,43,33,.26); backdrop-filter:blur(1px); -webkit-backdrop-filter:blur(1px); }
      .llm-chat-dialog { position:absolute; top:16px; right:16px; bottom:16px; display:flex; flex-direction:column; width:min(420px,calc(100vw - 32px)); overflow:hidden; border:1px solid #d8e7dd; border-radius:10px; background:#fff; box-shadow:0 24px 65px rgba(17,43,31,.28),0 3px 10px rgba(17,43,31,.12); animation:quickfind-llm-rise .22s cubic-bezier(.2,.8,.2,1); }
      .llm-chat-head { display:flex; align-items:center; gap:8px; min-height:61px; padding:11px 13px; border-bottom:1px solid #e7efe9; }
      .llm-chat-back,.llm-chat-close { display:grid; place-items:center; width:28px; height:28px; padding:0; border:0; border-radius:6px; color:#789086; background:transparent; cursor:pointer; }
      .llm-chat-back:hover,.llm-chat-close:hover { color:#19352c; background:#edf5ef; }
      .llm-chat-icon { display:grid; place-items:center; width:29px; height:29px; border-radius:8px; color:#f5c56b; background:#19352c; }
      .llm-chat-head-copy { min-width:0; }
      .llm-chat-title { overflow:hidden; color:#234837; font-size:12px; font-weight:720; text-overflow:ellipsis; white-space:nowrap; }
      .llm-chat-subtitle { margin-top:3px; color:#8a9c92; font-size:9px; }
      .llm-chat-close { margin-left:auto; }
      .llm-chat-scroll { display:flex; flex:1; flex-direction:column; gap:14px; padding:18px 15px; overflow-y:auto; background:#fcfefc; scrollbar-width:thin; scrollbar-color:#cadbd0 transparent; }
      .llm-message { display:flex; flex-direction:column; max-width:88%; gap:5px; }
      .llm-message.user { align-self:flex-end; align-items:flex-end; }
      .llm-message.assistant { align-self:flex-start; align-items:flex-start; }
      .llm-message-label { color:#91a198; font-size:9px; font-weight:650; }
      .llm-message-bubble { padding:10px 12px; border:1px solid #e0ebe4; border-radius:9px; color:#385448; background:#fff; font-size:12px; line-height:1.65; white-space:pre-wrap; overflow-wrap:anywhere; }
      .llm-message.user .llm-message-bubble { border-color:#d3e9da; color:#244e39; background:#eaf7ee; border-bottom-right-radius:3px; }
      .llm-message.assistant .llm-message-bubble { border-bottom-left-radius:3px; }
      .llm-message.pending .llm-message-bubble { color:#82958a; }
      .llm-typing { display:inline-flex; align-items:center; gap:3px; height:14px; }
      .llm-typing i { width:4px; height:4px; border-radius:50%; background:#7da58b; animation:quickfind-llm-dot 1s ease-in-out infinite; }
      .llm-typing i:nth-child(2) { animation-delay:.15s; }.llm-typing i:nth-child(3) { animation-delay:.3s; }
      .llm-chat-compose { padding:10px 12px 12px; border-top:1px solid #e5eee8; background:#fff; }
      .llm-chat-compose .llm-compose-box { background:#fbfdfb; }
      .llm-chat-compose .llm-compose-bottom { padding-bottom:6px; }
      .llm-chat-footer-note { padding:0 4px 7px; color:#a0aea5; font-size:9px; }
      @keyframes quickfind-llm-pulse { 0%,100%{opacity:.55}50%{opacity:1} }
      @keyframes quickfind-llm-rise { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
      @keyframes quickfind-llm-dot { 0%,80%,100%{opacity:.35;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)} }
      @media (prefers-reduced-motion: reduce) { .quickfind-trigger, .quickfind-panel, .engine, .llm-rail,.llm-sidebar,.llm-history-card,.llm-chat-dialog { transition:none; animation:none; } .llm-status-dot.busy,.llm-typing i { animation:none; } }
      @media (max-width:600px) { .llm-sidebar { width:calc(100vw - 12px); } .llm-chat-dialog { top:8px;right:8px;bottom:8px;width:calc(100vw - 16px); } .llm-history-wrap { padding-left:12px;padding-right:12px; } }
    </style>
    <button class="quickfind-trigger" type="button" aria-label="使用搜索引擎搜索选中文字" aria-expanded="false" title="搜索选中文字">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>
    </button>
    <section class="quickfind-panel" role="dialog" aria-label="搜索引擎列表">
      <div class="panel-drag-handle" role="button" tabindex="0" aria-label="长按拖动搜索列表" title="长按拖动搜索列表"></div>
      <div class="panel-head"><div class="query-row"><textarea class="query-input" rows="1" aria-label="编辑搜索内容" autocomplete="off"></textarea><button class="query-expand" type="button" aria-label="展开多行输入" aria-expanded="false" title="展开多行输入"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5"></path></svg></button></div></div>
      <div class="engine-list"></div>
      <div class="hidden-engine-list" hidden></div>
      <div class="group-engine-list" hidden></div>
    </section>
    <div class="llm-dock" aria-label="右侧 LLM 对话">
      <button class="llm-rail" type="button" aria-label="展开 LLM 对话" aria-expanded="false" title="展开 LLM 对话"></button>
      <aside class="llm-sidebar" aria-label="LLM 聊天历史" aria-hidden="true">
        <header class="llm-sidebar-head">
          <span class="llm-brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 6.5 12 3l7 3.5v7L12 17l-7-3.5Z"></path><path d="m8.5 8.5 3.5 1.8 3.5-1.8M12 10.3V17"></path></svg></span>
          <div><p class="llm-kicker">QUICKFIND / AI</p><h2 class="llm-title">随心问</h2></div>
          <button class="llm-sidebar-close" type="button" aria-label="收起 LLM 面板" title="收起"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"></path></svg></button>
        </header>
        <div class="llm-tabbar" role="tablist" aria-label="面板功能">
          <button class="llm-tab is-active" type="button" role="tab" data-tab="chat" aria-selected="true" aria-controls="llm-pane-chat" title="随选随问的 AI 对话">随心问</button>
          <button class="llm-tab" type="button" role="tab" data-tab="outline" aria-selected="false" aria-controls="llm-pane-outline" title="无限层级的大纲笔记">无限大纲笔记</button>
        </div>
        <div class="llm-pane" id="llm-pane-chat" data-pane="chat" role="tabpanel" aria-label="随心问">
          <div class="llm-status-row"><span class="llm-status-dot" aria-hidden="true"></span><span class="llm-status-text">正在读取配置…</span><button class="llm-new-chat" type="button" title="新建对话"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg><span>新对话</span></button></div>
          <div class="llm-history-wrap"><div class="llm-history-heading"><span>最近对话</span><span class="llm-history-count"></span></div><div class="llm-history-list"></div><div class="llm-history-empty" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5.5h14v10H9l-4 3v-13Z"></path><path d="M8 9h8M8 12h5"></path></svg><strong>从一个问题开始</strong><span>你的对话会保存在这里，下一次打开可以继续。</span></div></div>
          <form class="llm-compose" novalidate><div class="llm-compose-box"><textarea class="llm-sidebar-input" rows="1" aria-label="输入问题" placeholder="问点什么…"></textarea><div class="llm-compose-bottom"><span class="llm-compose-hint">Enter 发送 · Shift+Enter 换行</span><button class="llm-send" type="submit" aria-label="发送问题" title="发送"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 8-16 8 3-8-3-8Z"></path><path d="M7 12h13"></path></svg></button></div></div></form>
        </div>
        <div class="llm-pane" id="llm-pane-outline" data-pane="outline" role="tabpanel" aria-label="无限大纲笔记" hidden>
          <div class="outline-toolbar">
            <label class="outline-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.5"></circle><path d="m16 16 4 4"></path></svg><input class="outline-search-input" type="search" placeholder="搜索笔记" aria-label="搜索笔记" /></label>
            <button class="outline-tool-button outline-tool-icon" type="button" data-outline-action="undo" title="撤销（Ctrl/⌘+Z）" aria-label="撤销" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7 4 12l5 5"></path><path d="M4 12h9a6 6 0 0 1 6 6v1"></path></svg></button>
            <button class="outline-tool-button outline-tool-icon" type="button" data-outline-action="redo" title="重做（Ctrl/⌘+Shift+Z）" aria-label="重做" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 7 5 5-5 5"></path><path d="M20 12h-9a6 6 0 0 0-6 6v1"></path></svg></button>
            <button class="outline-tool-button" type="button" data-outline-action="add-note" title="新建项目"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg><span>新建</span></button>
            <button class="outline-tool-button" type="button" data-outline-action="insert-selection" title="把页面上选中的文字加入笔记">插入</button>
          </div>
          <div class="outline-context">
            <button class="outline-home" type="button" data-outline-action="home" aria-label="返回根目录" title="返回根目录">根目录</button>
            <span class="outline-context-separator" aria-hidden="true">/</span>
            <div class="outline-breadcrumb" aria-live="polite">根目录</div>
            <span class="outline-search-result" aria-live="polite"></span>
            <button class="outline-tool-button outline-tool-icon" type="button" data-outline-action="expand" title="展开全部" aria-label="展开全部"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></button>
            <button class="outline-tool-button outline-tool-icon" type="button" data-outline-action="collapse" title="收起全部" aria-label="收起全部"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m18 15-6-6-6 6"></path></svg></button>
          </div>
          <div class="outline-scroll"><div class="outline-list" role="tree" aria-label="大纲笔记"></div></div>
          <div class="outline-hint">Enter 新建同级 · Tab 缩进 · Ctrl/⌘+Enter 完成 · Ctrl/⌘+Z 撤销 · 拖动排序</div>
        </div>
      </aside>
      <div class="llm-chat-layer" hidden>
        <div class="llm-backdrop"></div>
        <section class="llm-chat-dialog" role="dialog" aria-modal="true" aria-label="LLM 对话">
          <header class="llm-chat-head"><button class="llm-chat-back" type="button" aria-label="返回聊天历史" title="返回聊天历史"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 6-6 6 6 6"></path></svg></button><span class="llm-chat-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 6.5 12 3l7 3.5v7L12 17l-7-3.5Z"></path><path d="m8.5 8.5 3.5 1.8 3.5-1.8M12 10.3V17"></path></svg></span><div class="llm-chat-head-copy"><div class="llm-chat-title">新对话</div><div class="llm-chat-subtitle">LLM 助手</div></div><button class="llm-chat-close" type="button" aria-label="关闭对话" title="关闭"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button></header>
          <div class="llm-chat-scroll" aria-live="polite"></div>
          <form class="llm-chat-compose" novalidate><div class="llm-chat-footer-note">回答由你配置的模型生成</div><div class="llm-compose-box"><textarea class="llm-chat-input" rows="1" aria-label="继续提问" placeholder="继续追问…"></textarea><div class="llm-compose-bottom"><span class="llm-compose-hint">Enter 发送 · Shift+Enter 换行</span><button class="llm-send" type="submit" aria-label="发送消息" title="发送"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 8-16 8 3-8-3-8Z"></path><path d="M7 12h13"></path></svg></button></div></div></form>
        </section>
      </div>
    </div>
  `;

  const trigger = shadow.querySelector('.quickfind-trigger');
  const panel = shadow.querySelector('.quickfind-panel');
  const queryInput = shadow.querySelector('.query-input');
  const queryExpand = shadow.querySelector('.query-expand');
  const queryRow = shadow.querySelector('.query-row');
  const panelDragHandle = shadow.querySelector('.panel-drag-handle');
  const engineList = shadow.querySelector('.engine-list');
  const hiddenEngineList = shadow.querySelector('.hidden-engine-list');
  const groupEngineList = shadow.querySelector('.group-engine-list');
  const llmDock = shadow.querySelector('.llm-dock');
  const llmRail = shadow.querySelector('.llm-rail');
  const llmSidebar = shadow.querySelector('.llm-sidebar');
  const llmSidebarClose = shadow.querySelector('.llm-sidebar-close');
  const llmNewChat = shadow.querySelector('.llm-new-chat');
  const llmStatusDot = shadow.querySelector('.llm-status-dot');
  const llmStatusText = shadow.querySelector('.llm-status-text');
  const llmHistoryList = shadow.querySelector('.llm-history-list');
  const llmHistoryEmpty = shadow.querySelector('.llm-history-empty');
  const llmHistoryCount = shadow.querySelector('.llm-history-count');
  const llmSidebarCompose = shadow.querySelector('.llm-compose');
  const llmSidebarInput = shadow.querySelector('.llm-sidebar-input');
  const llmChatLayer = shadow.querySelector('.llm-chat-layer');
  const llmChatBackdrop = shadow.querySelector('.llm-backdrop');
  const llmChatDialog = shadow.querySelector('.llm-chat-dialog');
  const llmChatBack = shadow.querySelector('.llm-chat-back');
  const llmChatClose = shadow.querySelector('.llm-chat-close');
  const llmChatTitle = shadow.querySelector('.llm-chat-title');
  const llmChatSubtitle = shadow.querySelector('.llm-chat-subtitle');
  const llmChatScroll = shadow.querySelector('.llm-chat-scroll');
  const llmChatCompose = shadow.querySelector('.llm-chat-compose');
  const llmChatInput = shadow.querySelector('.llm-chat-input');
  const llmTabbar = shadow.querySelector('.llm-tabbar');
  const llmTitle = shadow.querySelector('.llm-title');
  const outlineSearchInput = shadow.querySelector('.outline-search-input');
  const outlineSearchResult = shadow.querySelector('.outline-search-result');
  const outlineBreadcrumb = shadow.querySelector('.outline-breadcrumb');
  const outlineHomeButton = shadow.querySelector('[data-outline-action="home"]');
  const outlineUndoButton = shadow.querySelector('[data-outline-action="undo"]');
  const outlineRedoButton = shadow.querySelector('[data-outline-action="redo"]');
  const outlineAddButton = shadow.querySelector('[data-outline-action="add-note"]');
  const outlineExpandButton = shadow.querySelector('[data-outline-action="expand"]');
  const outlineCollapseButton = shadow.querySelector('[data-outline-action="collapse"]');
  const outlineInsertSelection = shadow.querySelector('[data-outline-action="insert-selection"]');
  const outlineList = shadow.querySelector('.outline-list');

  function cloneSettings(source) {
    return {
      enabled: source.enabled !== false,
      engines: { ...DEFAULT_SETTINGS.engines, ...(source.engines || {}) },
      iconOnly: { ...(source.iconOnly || {}) },
      customEngines: Array.isArray(source.customEngines) ? source.customEngines : [],
      engineOrder: Array.isArray(source.engineOrder) ? source.engineOrder : DEFAULT_SETTINGS.engineOrder,
      sources: Array.isArray(source.sources) ? source.sources : [],
      groups: Array.isArray(source.groups) ? source.groups : [],
      sourceConfigVersion: Number(source.sourceConfigVersion) || 0,
      pinnedSearch: source.pinnedSearch && typeof source.pinnedSearch === 'object' ? source.pinnedSearch : {},
      searchHistory: Array.isArray(source.searchHistory) ? source.searchHistory : [],
      llm: normalizeLlmConfig(source.llm),
      triggerMode: source.triggerMode === 'hover' ? 'hover' : 'click',
      editableTriggerMode: ['click', 'hover', 'none'].includes(source.editableTriggerMode) ? source.editableTriggerMode : 'click',
      defaultGroupCount: Math.max(1, Math.min(MAX_DEFAULT_GROUP_COUNT, Math.round(Number(source.defaultGroupCount ?? source.defaultVisibleCount ?? 4) || 4))),
      selectionTriggerDelay: Math.max(0, Math.min(2000, Math.round(Number(source.selectionTriggerDelay ?? 200) || 0)))
    };
  }

  function normalizeLlmConfig(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      enabled: source.enabled !== false,
      endpoint: String(source.endpoint || source.baseUrl || DEFAULT_SETTINGS.llm.endpoint).trim(),
      model: String(source.model || DEFAULT_SETTINGS.llm.model).trim(),
      apiKey: String(source.apiKey || source.key || ''),
      systemPrompt: String(source.systemPrompt || '').trim()
    };
  }

  function normalizeLlmConversation(value) {
    if (!value || typeof value !== 'object') return null;
    const messages = Array.isArray(value.messages) ? value.messages.map((message) => {
      if (!message || !['user', 'assistant', 'system'].includes(message.role)) return null;
      const content = String(message.content || '').trim();
      return content ? { role: message.role, content } : null;
    }).filter(Boolean).filter((message) => message.role !== 'system') : [];
    if (!messages.length) return null;
    const now = Date.now();
    return {
      id: String(value.id || `llm-${now}-${Math.random().toString(36).slice(2, 8)}`),
      messages,
      createdAt: Number(value.createdAt) || now,
      updatedAt: Number(value.updatedAt) || Number(value.createdAt) || now
    };
  }

  function readLlmConversations() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
      return new Promise((resolve) => chrome.storage.local.get(LLM_CONVERSATIONS_KEY, (stored) => resolve(stored?.[LLM_CONVERSATIONS_KEY])));
    }
    try { return Promise.resolve(JSON.parse(localStorage.getItem(LLM_CONVERSATIONS_KEY) || '[]')); } catch { return Promise.resolve([]); }
  }

  function writeLlmConversations() {
    const payload = llmConversations.slice(0, 30);
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.set) {
      chrome.storage.local.set({ [LLM_CONVERSATIONS_KEY]: payload });
      return;
    }
    try { localStorage.setItem(LLM_CONVERSATIONS_KEY, JSON.stringify(payload)); } catch { /* storage may be unavailable */ }
  }

  function loadLlmConversations() {
    if (loadLlmConversations.started) return;
    loadLlmConversations.started = true;
    void readLlmConversations().then((value) => {
      llmConversations = (Array.isArray(value) ? value : []).map(normalizeLlmConversation).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 30);
      renderLlmHistory();
    });
  }

  function llmHasConfig() {
    const config = normalizeLlmConfig(settings?.llm);
    const localEndpoint = /(?:localhost|127\.0\.0\.1|::1)(?::\d+)?(?:\/|$)/i.test(config.endpoint);
    return config.enabled !== false && Boolean(config.endpoint && config.model && (config.apiKey || localEndpoint));
  }

  function syncLlmConfigStatus(kind) {
    if (!llmStatusDot || !llmStatusText) return;
    const config = normalizeLlmConfig(settings?.llm);
    llmStatusDot.classList.remove('ready', 'busy', 'error');
    if (kind === 'busy') {
      llmStatusDot.classList.add('busy');
      llmStatusText.textContent = '正在思考…';
      return;
    }
    if (kind === 'error') {
      llmStatusDot.classList.add('error');
      llmStatusText.textContent = '请求未完成';
      return;
    }
    if (config.enabled === false) {
      llmStatusText.textContent = 'LLM 已关闭';
      return;
    }
    if (!config.endpoint || !config.model || !config.apiKey) {
      llmStatusText.textContent = '待配置 API Key';
      return;
    }
    llmStatusDot.classList.add('ready');
    llmStatusText.textContent = `${config.model} · 已配置`;
  }

  function formatLlmTime(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value)) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
    } catch { return ''; }
  }

  function firstMessage(conversation, role) {
    return conversation?.messages?.find((message) => message.role === role)?.content || '';
  }

  function shortenLlmText(value, limit = 92) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }

  function renderLlmHistory() {
    if (!llmHistoryList) return;
    const conversations = llmConversations.slice().sort((a, b) => b.updatedAt - a.updatedAt);
    // 内容没有变化时不要重建 DOM：重建会毁掉正在按下（mousedown 之后、mouseup 之前）
    // 的那张卡片，浏览器因此不会派发 click 事件，历史对话就点不动了。
    const signature = JSON.stringify(conversations);
    if (signature === llmHistorySignature) return;
    llmHistorySignature = signature;
    llmHistoryList.replaceChildren();
    if (llmHistoryCount) llmHistoryCount.textContent = conversations.length ? `${conversations.length} 条` : '';
    if (llmHistoryEmpty) llmHistoryEmpty.hidden = conversations.length > 0;
    conversations.forEach((conversation) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'llm-history-card';
      card.dataset.conversationId = conversation.id;
      const title = document.createElement('strong');
      title.className = 'llm-card-title';
      title.textContent = shortenLlmText(firstMessage(conversation, 'user'), 72) || '未命名对话';
      const preview = document.createElement('span');
      preview.className = 'llm-card-preview';
      preview.textContent = shortenLlmText(firstMessage(conversation, 'assistant'), 118) || '等待 LLM 回复…';
      const meta = document.createElement('span');
      meta.className = 'llm-card-meta';
      const count = conversation.messages.filter((message) => message.role === 'user').length;
      meta.textContent = `${formatLlmTime(conversation.updatedAt)}  ·  ${count} 次提问`;
      card.append(title, preview, meta);
      card.addEventListener('click', () => openLlmConversation(conversation));
      llmHistoryList.append(card);
    });
  }

  function resizeLlmTextarea(input) {
    if (!input) return;
    input.style.height = 'auto';
    const maxHeight = 128;
    input.style.height = `${Math.max(52, Math.min(maxHeight, input.scrollHeight || 52))}px`;
    input.style.overflowY = (input.scrollHeight || 0) > maxHeight ? 'auto' : 'hidden';
  }

  function setLlmDockOpen(open) {
    if (!llmDock) return;
    if (llmCloseTimer) window.clearTimeout(llmCloseTimer);
    llmCloseTimer = null;
    const nextOpen = Boolean(open);
    // 只有状态真正发生变化时才刷新内容/抢焦点，否则 focusin、pointerenter 这类
    // 高频事件会在用户按下卡片时重建列表，导致 click 事件丢失。
    const justOpened = nextOpen && !llmDockOpen;
    llmDockOpen = nextOpen;
    llmDock.classList.toggle('is-open', nextOpen);
    llmRail?.setAttribute('aria-expanded', String(nextOpen));
    llmRail?.setAttribute('aria-label', nextOpen ? '收起 QuickFind 面板' : '展开 QuickFind 面板');
    if (llmSidebar) llmSidebar.setAttribute('aria-hidden', String(!nextOpen));
    if (!nextOpen) return;
    if (llmActiveTab === 'outline') {
      // 大纲列表重绘时会把焦点还给输入框，再次触发 focusin；若这里无条件重载，
      // 就会 focusin → loadOutlineNotes → renderNotes → focusin 无限递归。
      if (justOpened) loadOutlineNotes();
      syncOutlineInsertButton();
      return;
    }
    renderLlmHistory();
    if (justOpened) window.requestAnimationFrame(() => { if (!llmChatLayer || llmChatLayer.hidden) llmSidebarInput?.focus({ preventScroll: true }); });
  }

  function scheduleLlmDockClose() {
    if (llmChatLayer && !llmChatLayer.hidden) return;
    if (llmCloseTimer) window.clearTimeout(llmCloseTimer);
    llmCloseTimer = window.setTimeout(() => {
      llmCloseTimer = null;
      const activeElement = shadow.activeElement;
      const editing = (activeElement === llmSidebarInput && Boolean(llmSidebarInput?.value.trim()))
        || activeElement?.classList?.contains('note-input')
        || activeElement === outlineSearchInput;
      if (!llmRail?.matches(':hover') && !llmSidebar?.matches(':hover') && !editing) setLlmDockOpen(false);
    }, 260);
  }

  function renderLlmChat() {
    if (!llmChatScroll || !llmActiveConversation) return;
    llmChatScroll.replaceChildren();
    llmActiveConversation.messages.forEach((message) => {
      const row = document.createElement('div');
      row.className = `llm-message ${message.role}`;
      const label = document.createElement('span');
      label.className = 'llm-message-label';
      label.textContent = message.role === 'user' ? '你' : 'LLM';
      const bubble = document.createElement('div');
      bubble.className = 'llm-message-bubble';
      bubble.textContent = message.content;
      row.append(label, bubble);
      llmChatScroll.append(row);
    });
    if (llmRequestInFlight) {
      const row = document.createElement('div');
      row.className = 'llm-message assistant pending';
      const label = document.createElement('span');
      label.className = 'llm-message-label';
      label.textContent = 'LLM';
      const bubble = document.createElement('div');
      bubble.className = 'llm-message-bubble';
      bubble.innerHTML = '<span class="llm-typing" aria-label="正在生成回复"><i></i><i></i><i></i></span>';
      row.append(label, bubble);
      llmChatScroll.append(row);
    }
    window.requestAnimationFrame(() => { llmChatScroll.scrollTop = llmChatScroll.scrollHeight; });
  }

  function showLlmChatLayer() {
    if (!llmChatLayer) return;
    setLlmDockOpen(true);
    llmChatLayer.hidden = false;
    llmChatLayer.setAttribute('aria-hidden', 'false');
    renderLlmChat();
  }

  function hideLlmChatLayer() {
    if (!llmChatLayer) return;
    llmChatLayer.hidden = true;
    llmChatLayer.setAttribute('aria-hidden', 'true');
    llmChatInput.value = '';
    resizeLlmTextarea(llmChatInput);
    if (llmRequestInFlight) return;
    window.requestAnimationFrame(() => llmSidebarInput?.focus({ preventScroll: true }));
  }

  function openLlmConversation(conversation) {
    const normalized = normalizeLlmConversation(conversation);
    if (!normalized) return;
    const current = llmConversations.find((item) => item.id === normalized.id);
    llmActiveConversation = current || normalized;
    if (!current) llmConversations.unshift(llmActiveConversation);
    llmChatTitle.textContent = shortenLlmText(firstMessage(llmActiveConversation, 'user'), 42) || '新对话';
    llmChatSubtitle.textContent = `${normalizeLlmConfig(settings?.llm).model || 'LLM'} · 对话中`;
    showLlmChatLayer();
    window.requestAnimationFrame(() => llmChatInput?.focus({ preventScroll: true }));
  }

  function startNewLlmConversation() {
    llmActiveConversation = null;
    llmRequestInFlight = false;
    if (llmChatLayer && !llmChatLayer.hidden) hideLlmChatLayer();
    llmSidebarInput.value = '';
    resizeLlmTextarea(llmSidebarInput);
    renderLlmHistory();
    window.requestAnimationFrame(() => llmSidebarInput?.focus({ preventScroll: true }));
  }

  function resolveLlmEndpoint(value) {
    const endpoint = String(value || '').trim().replace(/\/+$/, '');
    if (!endpoint) return '';
    if (/\/chat\/completions$/i.test(endpoint)) return endpoint;
    if (/\/v\d+$/i.test(endpoint)) return `${endpoint}/chat/completions`;
    return `${endpoint}/v1/chat/completions`;
  }

  function buildLlmMessages(conversation) {
    const config = normalizeLlmConfig(settings?.llm);
    const messages = [];
    if (config.systemPrompt) messages.push({ role: 'system', content: config.systemPrompt });
    conversation.messages.forEach((message) => messages.push({ role: message.role, content: message.content }));
    return messages;
  }

  function requestLlmViaFetch(config, messages) {
    const headers = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    return fetch(resolveLlmEndpoint(config.endpoint), { method: 'POST', headers, body: JSON.stringify({ model: config.model, messages, temperature: 0.7, stream: false }) }).then(async (response) => {
      let payload = null;
      try { payload = await response.json(); } catch { /* retain status-based error */ }
      if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `请求失败（${response.status}）`);
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('接口返回了空回复。');
      return content.trim();
    });
  }

  function requestLlmResponse(conversation) {
    const config = normalizeLlmConfig(settings?.llm);
    if (!llmHasConfig()) return Promise.reject(new Error('请先在设置页填写 API 地址和模型。'));
    const messages = buildLlmMessages(conversation);
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      return new Promise((resolve, reject) => {
        try {
          chrome.runtime.sendMessage({ type: 'quickfind-llm-chat', config, messages }, (response) => {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) { reject(new Error(runtimeError.message || '无法连接到扩展后台。')); return; }
            if (!response?.ok) { reject(new Error(response?.error || '接口请求失败。')); return; }
            resolve(String(response.content || '').trim());
          });
        } catch (error) { reject(error); }
      });
    }
    return requestLlmViaFetch(config, messages);
  }

  async function sendLlmMessage(value) {
    const text = String(value || '').trim();
    if (!text || llmRequestInFlight) return;
    let conversation = llmActiveConversation;
    if (!conversation) {
      const now = Date.now();
      conversation = { id: `llm-${now}-${Math.random().toString(36).slice(2, 8)}`, messages: [], createdAt: now, updatedAt: now };
      llmConversations.unshift(conversation);
      llmActiveConversation = conversation;
    }
    conversation.messages.push({ role: 'user', content: text });
    conversation.updatedAt = Date.now();
    llmRequestInFlight = true;
    llmSidebarInput.value = '';
    llmChatInput.value = '';
    resizeLlmTextarea(llmSidebarInput);
    resizeLlmTextarea(llmChatInput);
    llmChatTitle.textContent = shortenLlmText(firstMessage(conversation, 'user'), 42) || '新对话';
    llmChatSubtitle.textContent = `${normalizeLlmConfig(settings?.llm).model || 'LLM'} · 对话中`;
    showLlmChatLayer();
    syncLlmConfigStatus('busy');
    renderLlmHistory();
    writeLlmConversations();
    try {
      const content = await requestLlmResponse(conversation);
      conversation.messages.push({ role: 'assistant', content });
      conversation.updatedAt = Date.now();
      syncLlmConfigStatus();
    } catch (error) {
      conversation.messages.push({ role: 'assistant', content: `请求失败：${error?.message || '无法连接到 API。'}` });
      conversation.updatedAt = Date.now();
      syncLlmConfigStatus('error');
    } finally {
      llmRequestInFlight = false;
      writeLlmConversations();
      renderLlmHistory();
      renderLlmChat();
      if (llmChatLayer?.hidden) scheduleLlmDockClose();
    }
  }

  const NOTES_KEY = 'quickfind-notes';
  const NOTES_LEGACY_KEY = 'quickfind-outline-notes';
  const OUTLINE_TAB_KEY = 'quickfind-outline-tab';
  const OUTLINE_TITLES = { chat: '随心问', outline: '无限大纲笔记' };
  const NOTES_HISTORY_LIMIT = 100;
  let notesState = createEmptyNotes();
  let notesLoaded = false;
  let notesSaveTimer = null;
  let notesSearchTimer = null;
  let notesActiveId = null;
  let notesZoomRootId = 'root';
  let notesFocusRestoreToken = 0;
  let notesUndoStack = [];
  let notesRedoStack = [];
  let notesTypingHistoryId = null;
  let notesTypingBeforeState = null;
  let notesHistorySuspend = false;
  let noteIdCounter = 0;
  let outlineDraggedItem = null;
  let llmActiveTab = 'chat';

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

  function noteId() { noteIdCounter += 1; return 'note-' + Date.now() + '-' + noteIdCounter; }
  function cloneNotesState(state = notesState) { return JSON.parse(JSON.stringify(state)); }
  function notesStateSignature(state = notesState) { return JSON.stringify({ rootId: state.rootId, nodes: state.nodes }); }

  function readNotesStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
      return new Promise((resolve) => chrome.storage.local.get([NOTES_KEY, NOTES_LEGACY_KEY], (stored) => resolve({ current: stored?.[NOTES_KEY] || null, legacy: stored?.[NOTES_LEGACY_KEY] || null })));
    }
    try {
      return Promise.resolve({ current: JSON.parse(localStorage.getItem(NOTES_KEY) || 'null'), legacy: JSON.parse(localStorage.getItem(NOTES_LEGACY_KEY) || 'null') });
    } catch { return Promise.resolve({ current: null, legacy: null }); }
  }

  function writeNotesStorage() {
    // 刷新 updatedAt：设置页用它判断哪一份副本更新，侧栏若沿用旧时间戳，
    // 在设置页里做的合并会判定侧栏数据更旧，从而把这里的修改覆盖掉。
    notesState.updatedAt = Date.now();
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.set) { chrome.storage.local.set({ [NOTES_KEY]: notesState }); return; }
    try { localStorage.setItem(NOTES_KEY, JSON.stringify(notesState)); } catch { /* storage may be unavailable */ }
  }

  function scheduleNotesSave() {
    if (notesSaveTimer) window.clearTimeout(notesSaveTimer);
    notesSaveTimer = window.setTimeout(() => { notesSaveTimer = null; writeNotesStorage(); }, 350);
  }

  function removeLegacyNotesStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.remove) { chrome.storage.local.remove(NOTES_LEGACY_KEY); return; }
    try { localStorage.removeItem(NOTES_LEGACY_KEY); } catch { /* ignore */ }
  }

  // 旧版侧栏笔记（多笔记 + 嵌套树）迁移为与设置页一致的扁平节点树。
  function legacyNotesToState(legacyNotes) {
    const state = createEmptyNotes();
    const now = Date.now();
    (Array.isArray(legacyNotes) ? legacyNotes : []).forEach((note, index) => {
      const title = String(note?.title || '').trim() || `未命名笔记 ${index + 1}`;
      const item = { id: noteId(), parentId: 'root', children: [], text: title, collapsed: false, completed: false, createdAt: now, updatedAt: now };
      state.nodes[item.id] = item;
      state.nodes.root.children.push(item.id);
      const walk = (nodes, parentId) => {
        (Array.isArray(nodes) ? nodes : []).forEach((value) => {
          if (!value || typeof value !== 'object') return;
          const child = { id: noteId(), parentId, children: [], text: String(value.text ?? '').trim(), collapsed: value.collapsed === true, completed: false, createdAt: now, updatedAt: now };
          state.nodes[child.id] = child;
          state.nodes[parentId].children.push(child.id);
          walk(value.children, child.id);
        });
      };
      walk(note?.nodes, item.id);
    });
    return state;
  }

  function loadOutlineNotes() {
    if (notesLoaded) { renderNotes(); return; }
    notesLoaded = true;
    void readNotesStorage().then(({ current, legacy }) => {
      let state = current ? normalizeNotes(current) : null;
      let migrated = false;
      if (!state && Array.isArray(legacy) && legacy.length) {
        state = legacyNotesToState(legacy);
        migrated = true;
      }
      notesState = state || createEmptyNotes();
      if (migrated) { writeNotesStorage(); removeLegacyNotesStorage(); }
      renderNotes();
      syncOutlineInsertButton();
    });
  }

  // 与设置页（及其他标签页侧栏）通过 chrome.storage.local 双向同步。
  function handleNotesStorageChange(changes, areaName) {
    if (areaName !== 'local' || !changes || !changes[NOTES_KEY]) return;
    if (!notesLoaded || notesSaveTimer) return; // 有未保存的本地编辑时跳过，避免覆盖正在输入的内容
    const incoming = changes[NOTES_KEY].newValue;
    if (!incoming || typeof incoming !== 'object') return;
    const next = normalizeNotes(incoming);
    if (notesStateSignature(next) === notesStateSignature()) return;
    notesState = next;
    if (!noteById(notesZoomRootId)) notesZoomRootId = 'root';
    if (notesActiveId && !noteById(notesActiveId)) notesActiveId = null;
    notesUndoStack = [];
    notesRedoStack = [];
    updateNotesHistoryButtons();
    renderNotes();
  }

  function updateNotesHistoryButtons() {
    if (outlineUndoButton) outlineUndoButton.disabled = notesUndoStack.length === 0;
    if (outlineRedoButton) outlineRedoButton.disabled = notesRedoStack.length === 0;
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
    if (!noteById(notesZoomRootId)) notesZoomRootId = 'root';
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
  function isNoteDescendant(candidateId, ancestorId) { let node = noteById(candidateId); const seen = new Set(); while (node && node.parentId && !seen.has(node.id)) { if (node.parentId === ancestorId) return true; seen.add(node.id); node = noteById(node.parentId); } return false; }

  function resizeNoteInput(input) { input.style.height = 'auto'; input.style.height = Math.max(24, input.scrollHeight) + 'px'; }
  function noteSelection(input) { return { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection }; }
  function focusNote(id, selection = null) {
    const input = outlineList?.querySelector('.note-input[data-note-id="' + CSS.escape(String(id)) + '"]');
    if (!input) return;
    input.scrollIntoView({ block: 'nearest' });
    input.focus({ preventScroll: true });
    const start = Math.max(0, Math.min(input.value.length, Number(selection?.start ?? input.value.length)));
    const end = Math.max(start, Math.min(input.value.length, Number(selection?.end ?? start)));
    input.setSelectionRange(start, end, selection?.direction || 'none');
  }

  function renderNotes(focusId = null, focusSelection = null) {
    if (!outlineList) return;
    if (!notesLoaded) { outlineList.textContent = '正在加载笔记…'; return; }
    const focusRestoreToken = ++notesFocusRestoreToken;
    // Rebuilding the list replaces the textarea, so carry its selection across the render.
    let selection = focusSelection;
    const activeInput = shadow.activeElement?.matches?.('.note-input') ? shadow.activeElement : null;
    if (!focusId && activeInput?.dataset.noteId) {
      focusId = activeInput.dataset.noteId;
      selection = noteSelection(activeInput);
    } else if (focusId && !selection && activeInput?.dataset.noteId === String(focusId)) {
      selection = noteSelection(activeInput);
    }
    const query = String(outlineSearchInput?.value || '').trim().toLocaleLowerCase();
    const visible = visibleNoteIds(query);
    outlineList.classList.toggle('zoomed', visible.scopeRoot?.id !== 'root');
    outlineList.replaceChildren();
    if (outlineSearchResult) {
      const matchCount = query ? Object.values(notesState.nodes).filter((node) => node.id !== 'root' && node.id !== notesZoomRootId && node.text.toLocaleLowerCase().includes(query) && (notesZoomRootId === 'root' || isNoteDescendant(node.id, notesZoomRootId))).length : 0;
      outlineSearchResult.textContent = query ? ('找到 ' + matchCount + ' 项') : '';
    }
    if (visible.scopeRoot && visible.scopeRoot.id !== 'root') {
      const heading = document.createElement('div');
      heading.className = 'notes-zoom-heading';
      heading.textContent = visible.scopeRoot.text.trim() || '未命名项目';
      outlineList.append(heading);
    }
    if (!visible.ids.length) {
      const empty = document.createElement('div');
      empty.className = 'notes-empty';
      empty.textContent = query ? '没有匹配的笔记' : (visible.scopeRoot?.id === 'root' ? '还没有笔记项目，点击“新建”开始。' : '这个项目还没有子项目，按 Enter 新建。');
      outlineList.append(empty);
    } else visible.ids.forEach((id) => {
      const node = noteById(id);
      const row = document.createElement('div');
      row.className = 'note-row' + (node.completed ? ' completed' : '') + (query && node.text.toLocaleLowerCase().includes(query) ? ' search-match' : '');
      row.dataset.noteId = id;
      row.draggable = true;
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(noteDepth(id, visible.scopeRoot?.id || 'root') + 1));
      row.setAttribute('aria-expanded', node.children.length ? String(!node.collapsed) : 'false');
      row.style.paddingLeft = (6 + noteDepth(id, visible.scopeRoot?.id || 'root') * 18) + 'px';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'note-toggle' + (node.collapsed ? ' collapsed' : '');
      toggle.disabled = !node.children.length;
      toggle.setAttribute('aria-label', node.children.length ? (node.collapsed ? '展开项目' : '收起项目') : '没有子项目');
      toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 9 5 6 5-6"></path></svg>';
      toggle.addEventListener('click', () => { if (!node.children.length) return; const before = cloneNotesState(); node.collapsed = !node.collapsed; pushNotesHistory(before); node.updatedAt = Date.now(); scheduleNotesSave(); renderNotes(id); });
      const complete = document.createElement('button');
      complete.type = 'button';
      complete.className = 'note-complete';
      complete.setAttribute('aria-label', node.completed ? '标记未完成' : '标记完成');
      complete.title = node.completed ? '标记未完成' : '标记完成';
      complete.innerHTML = node.completed ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle></svg>';
      complete.addEventListener('click', () => { const before = cloneNotesState(); node.completed = !node.completed; node.updatedAt = Date.now(); pushNotesHistory(before); scheduleNotesSave(); renderNotes(id); });
      const bullet = document.createElement('span');
      bullet.className = 'note-bullet';
      bullet.setAttribute('aria-hidden', 'true');
      const input = document.createElement('textarea');
      input.className = 'note-input';
      input.rows = 1;
      input.value = node.text;
      input.placeholder = '输入项目内容';
      input.setAttribute('aria-label', '大纲项目');
      input.dataset.noteId = id;
      input.addEventListener('input', () => { beginNotesHistory(id); node.text = input.value; node.updatedAt = Date.now(); resizeNoteInput(input); updateNotesBreadcrumb(id); scheduleNotesSave(); });
      input.addEventListener('focus', () => { notesActiveId = id; notesTypingHistoryId = null; notesTypingBeforeState = cloneNotesState(); updateNotesBreadcrumb(id); });
      input.addEventListener('keydown', (event) => handleNoteKeydown(event, id, input));
      const zoom = document.createElement('button');
      zoom.type = 'button';
      zoom.className = 'note-zoom';
      zoom.setAttribute('aria-label', '专注此项目');
      zoom.title = '专注此项目';
      zoom.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H4v4M16 4h4v4M8 20H4v-4M20 20h-4v-4"></path></svg>';
      zoom.addEventListener('click', () => zoomIntoNote(id));
      const drag = document.createElement('span');
      drag.className = 'note-drag';
      drag.textContent = '⋮⋮';
      drag.title = '拖动项目';
      drag.setAttribute('aria-hidden', 'true');
      row.append(toggle, complete, bullet, input, zoom, drag);
      row.addEventListener('dragstart', (event) => { outlineDraggedItem = { id }; row.classList.add('dragging'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id); });
      row.addEventListener('dragend', () => { outlineDraggedItem = null; row.classList.remove('dragging', 'drag-target-before', 'drag-target-inside', 'drag-target-after'); });
      row.addEventListener('dragover', (event) => { if (!outlineDraggedItem || outlineDraggedItem.id === id || isNoteDescendant(id, outlineDraggedItem.id)) return; event.preventDefault(); const rect = row.getBoundingClientRect(); const ratio = (event.clientY - rect.top) / Math.max(1, rect.height); const zone = ratio < .27 ? 'before' : (ratio > .73 ? 'after' : 'inside'); row.classList.toggle('drag-target-before', zone === 'before'); row.classList.toggle('drag-target-inside', zone === 'inside'); row.classList.toggle('drag-target-after', zone === 'after'); event.dataTransfer.dropEffect = 'move'; row.dataset.dropZone = zone; });
      row.addEventListener('dragleave', () => { row.classList.remove('drag-target-before', 'drag-target-inside', 'drag-target-after'); delete row.dataset.dropZone; });
      row.addEventListener('drop', (event) => { event.preventDefault(); const zone = row.dataset.dropZone || 'after'; row.classList.remove('drag-target-before', 'drag-target-inside', 'drag-target-after'); if (outlineDraggedItem) moveNote(outlineDraggedItem.id, id, zone); });
      outlineList.append(row);
      resizeNoteInput(input);
    });
    updateNotesBreadcrumb(notesActiveId);
    if (focusId) {
      focusNote(focusId, selection);
      window.requestAnimationFrame(() => {
        if (focusRestoreToken !== notesFocusRestoreToken) return;
        const current = shadow.activeElement;
        if (!current || !outlineList.contains(current)) focusNote(focusId, selection);
      });
    }
  }

  function updateNotesBreadcrumb(id) {
    if (!outlineBreadcrumb) return;
    const zoomPath = notePath(notesZoomRootId);
    const path = notesZoomRootId !== 'root' ? zoomPath : notePath(id || notesActiveId);
    outlineBreadcrumb.textContent = path.length ? path.join(' / ') : '根目录';
    if (outlineHomeButton) {
      const atRoot = notesZoomRootId === 'root';
      outlineHomeButton.textContent = atRoot ? '根目录' : '返回上级';
      outlineHomeButton.setAttribute('aria-label', atRoot ? '返回根目录' : '返回上级');
      outlineHomeButton.title = atRoot ? '返回根目录' : '返回上级';
    }
  }

  function zoomIntoNote(id) {
    const node = noteById(id); if (!node) return;
    notesZoomRootId = node.id; notesActiveId = node.id;
    if (outlineSearchInput) outlineSearchInput.value = '';
    renderNotes(); updateNotesBreadcrumb(id);
  }

  function zoomOutNotes() {
    const node = noteById(notesZoomRootId);
    notesZoomRootId = node?.parentId && noteById(node.parentId) ? node.parentId : 'root';
    notesActiveId = notesZoomRootId === 'root' ? null : notesZoomRootId;
    renderNotes(); updateNotesBreadcrumb(notesActiveId);
  }

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
    if (event.key === 'Escape') { if (notesZoomRootId !== 'root') { event.preventDefault(); zoomOutNotes(); } else if (outlineSearchInput?.value) { outlineSearchInput.value = ''; renderNotes(id); } return; }
    if (modifier && event.key === 'Enter') { event.preventDefault(); const node = noteById(id); if (!node) return; const before = cloneNotesState(); node.completed = !node.completed; node.updatedAt = Date.now(); pushNotesHistory(before); scheduleNotesSave(); renderNotes(id, noteSelection(input)); return; }
    if (modifier && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); changeNoteIndent(id, event.key === 'ArrowLeft', input); return; }
    if (modifier && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault(); const node = noteById(id); const parent = node && noteById(node.parentId); const index = parent?.children.indexOf(id) ?? -1; const targetId = parent?.children[index + (event.key === 'ArrowUp' ? -1 : 1)]; if (targetId) moveNote(id, targetId, event.key === 'ArrowUp' ? 'before' : 'after'); return;
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); const cursor = input.selectionStart; const beforeText = input.value.slice(0, cursor); const after = input.value.slice(input.selectionEnd); const node = noteById(id); const beforeState = cloneNotesState(); if (node) node.text = beforeText; insertNoteAfter(id, after, beforeState); return; }
    if (event.key === 'Tab') { event.preventDefault(); changeNoteIndent(id, event.shiftKey, input); return; }
    if (event.key === 'Backspace' && input.selectionStart === 0 && input.selectionEnd === 0) { event.preventDefault(); if (input.value) mergeNoteWithPrevious(id, input); else removeNote(id); return; }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { const inputs = Array.from(outlineList.querySelectorAll('.note-input')); const index = inputs.indexOf(input); const next = inputs[index + (event.key === 'ArrowUp' ? -1 : 1)]; if (next && (event.key === 'ArrowUp' ? input.selectionStart === 0 : input.selectionStart === input.value.length)) { event.preventDefault(); next.focus(); next.setSelectionRange(event.key === 'ArrowUp' ? next.value.length : 0, event.key === 'ArrowUp' ? next.value.length : 0); } }
  }

  function addNote() {
    if (!notesLoaded) return;
    const target = notesActiveId && noteById(notesActiveId) ? notesActiveId : null;
    if (target && notesZoomRootId !== 'root' && target === notesZoomRootId) return insertNoteChild(target);
    if (target) return insertNoteAfter(target);
    const root = noteById(notesZoomRootId) || noteById('root');
    const before = cloneNotesState(); const now = Date.now();
    const node = { id: noteId(), parentId: root.id, children: [], text: '', collapsed: false, completed: false, createdAt: now, updatedAt: now };
    notesState.nodes[node.id] = node; root.children.push(node.id); root.collapsed = false; notesActiveId = node.id; pushNotesHistory(before); scheduleNotesSave(); renderNotes(node.id);
  }

  function setAllNotesCollapsed(collapsed) {
    if (!notesLoaded) return;
    const before = cloneNotesState();
    Object.values(notesState.nodes).forEach((node) => { if (node.id !== 'root' && node.children.length) node.collapsed = collapsed; });
    pushNotesHistory(before); scheduleNotesSave(); renderNotes();
  }

  function syncOutlineInsertButton() {
    if (!outlineInsertSelection) return;
    const hasText = Boolean(String(selectedText || '').trim());
    outlineInsertSelection.disabled = !hasText;
    outlineInsertSelection.title = hasText ? '把页面上选中的文字加入笔记' : '先在页面上选中一段文字';
  }

  function insertSelectionIntoNotes() {
    if (!notesLoaded) return;
    const raw = String(selectedText || '').trim();
    if (!raw) return;
    const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 60);
    if (!lines.length) return;
    const parent = noteById(notesZoomRootId) || noteById('root');
    let anchor = notesActiveId && noteById(notesActiveId) ? notesActiveId : null;
    const before = cloneNotesState();
    const now = Date.now();
    let firstId = '';
    lines.forEach((line) => {
      const node = { id: noteId(), parentId: parent.id, children: [], text: line, collapsed: false, completed: false, createdAt: now, updatedAt: now };
      notesState.nodes[node.id] = node;
      if (anchor) {
        const anchorNode = noteById(anchor);
        const anchorParent = anchorNode ? noteById(anchorNode.parentId) || parent : parent;
        node.parentId = anchorParent.id;
        anchorParent.children.splice(anchorParent.children.indexOf(anchor) + 1, 0, node.id);
      } else parent.children.push(node.id);
      anchor = node.id;
      if (!firstId) firstId = node.id;
    });
    notesActiveId = firstId;
    pushNotesHistory(before);
    scheduleNotesSave();
    renderNotes(firstId);
  }

  function setLlmTab(tab, options = {}) {
    const next = tab === 'outline' ? 'outline' : 'chat';
    llmActiveTab = next;
    llmTabbar?.querySelectorAll('.llm-tab').forEach((button) => {
      const active = button.dataset.tab === next;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', String(active));
    });
    shadow.querySelectorAll('.llm-pane').forEach((pane) => { pane.hidden = pane.dataset.pane !== next; });
    if (llmTitle) llmTitle.textContent = OUTLINE_TITLES[next];
    if (next === 'outline') loadOutlineNotes();
    else renderLlmHistory();
    syncOutlineInsertButton();
    if (options.persist !== false && typeof chrome !== 'undefined' && chrome.storage?.local?.set) chrome.storage.local.set({ [OUTLINE_TAB_KEY]: next });
  }

  function initializeLlmDock() {
    if (!llmDock || initializeLlmDock.started) return;
    initializeLlmDock.started = true;
    llmRail?.addEventListener('pointerenter', () => setLlmDockOpen(true));
    llmSidebar?.addEventListener('pointerenter', () => setLlmDockOpen(true));
    llmRail?.addEventListener('focus', () => setLlmDockOpen(true));
    llmSidebar?.addEventListener('focusin', () => setLlmDockOpen(true));
    llmRail?.addEventListener('pointerleave', scheduleLlmDockClose);
    llmSidebar?.addEventListener('pointerleave', scheduleLlmDockClose);
    llmRail?.addEventListener('click', () => { if (!llmDock.classList.contains('is-open')) setLlmDockOpen(true); });
    llmSidebarClose?.addEventListener('click', () => setLlmDockOpen(false));
    llmNewChat?.addEventListener('click', startNewLlmConversation);
    llmSidebarCompose?.addEventListener('submit', (event) => { event.preventDefault(); void sendLlmMessage(llmSidebarInput.value); });
    llmChatCompose?.addEventListener('submit', (event) => { event.preventDefault(); void sendLlmMessage(llmChatInput.value); });
    llmChatBack?.addEventListener('click', hideLlmChatLayer);
    llmChatClose?.addEventListener('click', hideLlmChatLayer);
    llmChatBackdrop?.addEventListener('click', hideLlmChatLayer);
    window.addEventListener('pointermove', (event) => {
      if (!llmDock.classList.contains('is-open') || (llmChatLayer && !llmChatLayer.hidden)) return;
      const pointInside = (rect) => rect && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (pointInside(llmRail.getBoundingClientRect()) || pointInside(llmSidebar.getBoundingClientRect())) {
        if (llmCloseTimer) { window.clearTimeout(llmCloseTimer); llmCloseTimer = null; }
      } else scheduleLlmDockClose();
    }, true);
    [llmSidebarInput, llmChatInput].filter(Boolean).forEach((input) => {
      input.addEventListener('input', () => resizeLlmTextarea(input));
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
        event.preventDefault();
        input.form?.requestSubmit();
      });
      resizeLlmTextarea(input);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && llmChatLayer && !llmChatLayer.hidden) { event.preventDefault(); hideLlmChatLayer(); }
    }, true);
    llmTabbar?.addEventListener('click', (event) => {
      const button = event.target?.closest?.('.llm-tab');
      if (button) setLlmTab(button.dataset.tab);
    });
    outlineAddButton?.addEventListener('click', addNote);
    outlineUndoButton?.addEventListener('click', undoNotes);
    outlineRedoButton?.addEventListener('click', redoNotes);
    outlineExpandButton?.addEventListener('click', () => setAllNotesCollapsed(false));
    outlineCollapseButton?.addEventListener('click', () => setAllNotesCollapsed(true));
    outlineHomeButton?.addEventListener('click', () => {
      if (notesZoomRootId === 'root') { if (outlineSearchInput) outlineSearchInput.value = ''; renderNotes(); }
      else zoomOutNotes();
    });
    outlineInsertSelection?.addEventListener('click', insertSelectionIntoNotes);
    outlineSearchInput?.addEventListener('input', () => {
      window.clearTimeout(notesSearchTimer);
      notesSearchTimer = window.setTimeout(() => renderNotes(), 120);
    });
    if (typeof chrome !== 'undefined' && chrome.storage?.onChanged) chrome.storage.onChanged.addListener(handleNotesStorageChange);
    document.addEventListener('selectionchange', syncOutlineInsertButton);
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
      chrome.storage.local.get(OUTLINE_TAB_KEY, (stored) => setLlmTab(stored?.[OUTLINE_TAB_KEY] === 'outline' ? 'outline' : 'chat', { persist: false }));
    } else setLlmTab('chat', { persist: false });
    loadLlmConversations();
    syncLlmConfigStatus();
  }

  initializeLlmDock();

  function storageAvailable() {
    return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync;
  }

  function eventInsideOverlay(event) {
    return (typeof event.composedPath === 'function' && event.composedPath().includes(host)) || host.contains(event.target);
  }

  function keepPanelSearchKeysInOverlay(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    if (!path.includes(queryInput)) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== ' ' && event.key !== 'Spacebar' && event.code !== 'Space') return;
    // Preserve the textarea's native editing behavior while keeping page-level
    // video shortcuts from receiving its navigation and space keys.
    event.stopImmediatePropagation();
  }

  ['keydown', 'keyup', 'keypress'].forEach((type) => {
    window.addEventListener(type, keepPanelSearchKeysInOverlay, true);
  });

  function loadSettings() {
    if (!storageAvailable()) return;
    chrome.storage.sync.get(null, (stored) => {
      settings = cloneSettings(stored);
      trigger.classList.toggle('disabled', !settings.enabled);
      syncLlmConfigStatus();
      loadLlmConversations();
      mountPinnedBar();
    });
    chrome.storage.onChanged?.addListener((changes, area) => {
      if (area !== 'sync') return;
      if (changes.enabled) settings.enabled = changes.enabled.newValue !== false;
      if (changes.engines) settings.engines = { ...DEFAULT_SETTINGS.engines, ...(changes.engines.newValue || {}) };
      if (changes.iconOnly) settings.iconOnly = { ...(changes.iconOnly.newValue || {}) };
      if (changes.customEngines) settings.customEngines = Array.isArray(changes.customEngines.newValue) ? changes.customEngines.newValue : [];
      if (changes.engineOrder) settings.engineOrder = Array.isArray(changes.engineOrder.newValue) ? changes.engineOrder.newValue : DEFAULT_SETTINGS.engineOrder;
      if (changes.sources) settings.sources = Array.isArray(changes.sources.newValue) ? changes.sources.newValue : [];
      if (changes.groups) settings.groups = Array.isArray(changes.groups.newValue) ? changes.groups.newValue : [];
      if (changes.sourceConfigVersion) settings.sourceConfigVersion = Number(changes.sourceConfigVersion.newValue) || 0;
      if (changes.pinnedSearch) settings.pinnedSearch = changes.pinnedSearch.newValue && typeof changes.pinnedSearch.newValue === 'object' ? changes.pinnedSearch.newValue : {};
      if (changes.enabled || changes.pinnedSearch || changes.sources || changes.groups || changes.engines || changes.iconOnly || changes.customEngines || changes.engineOrder) mountPinnedBar();
      if ((changes.pinnedSearch || changes.enabled) && !pinnedBarCollapsed) {
        const currentPinnedSite = getPinnedSite();
        if (currentPinnedSite) schedulePinnedBarCollapse(currentPinnedSite);
      }
      if (changes.searchHistory) {
        settings.searchHistory = Array.isArray(changes.searchHistory.newValue) ? changes.searchHistory.newValue : [];
        if (!isEditingPinnedQuery()) syncPinnedQuery(getPinnedSite());
      }
      if (changes.llm) {
        settings.llm = normalizeLlmConfig(changes.llm.newValue);
        syncLlmConfigStatus();
      }
      if (changes.triggerMode) {
        settings.triggerMode = changes.triggerMode.newValue === 'hover' ? 'hover' : 'click';
        if (getSelectionTriggerMode() !== 'hover') cancelTriggerHoverOpen();
        else if (trigger.classList.contains('visible')) scheduleTriggerHoverOpen();
      }
      if (changes.editableTriggerMode) {
        settings.editableTriggerMode = ['click', 'hover', 'none'].includes(changes.editableTriggerMode.newValue) ? changes.editableTriggerMode.newValue : 'click';
        if (settings.editableTriggerMode === 'none' && selectedInput) hideAll();
        else if (getSelectionTriggerMode() !== 'hover') cancelTriggerHoverOpen();
        else if (trigger.classList.contains('visible')) scheduleTriggerHoverOpen();
      }
      if (changes.defaultGroupCount) settings.defaultGroupCount = Math.max(1, Math.min(MAX_DEFAULT_GROUP_COUNT, Math.round(Number(changes.defaultGroupCount.newValue) || 4)));
      if (changes.selectionTriggerDelay) settings.selectionTriggerDelay = Math.max(0, Math.min(2000, Math.round(Number(changes.selectionTriggerDelay.newValue) || 0)));
      trigger.classList.toggle('disabled', !settings.enabled);
      if (!settings.enabled) {
        cancelTriggerHoverOpen();
        if (pinnedHost) pinnedHost.hidden = true;
        panelOpen = false;
        trigger.setAttribute('aria-expanded', 'false');
        panel.classList.remove('visible');
      }
      if (panelOpen) {
        renderEngines();
        positionPanel();
      }
    });
  }

  function hideAll() {
    if (selectionShowTimer) { window.clearTimeout(selectionShowTimer); selectionShowTimer = null; }
    cancelTriggerHoverOpen();
    panelOpen = false;
    expanded = false;
    expandedGroupId = null;
    trigger.classList.remove('visible');
    trigger.setAttribute('aria-expanded', 'false');
    panel.classList.remove('visible');
    queryRow.classList.remove('expanded');
    queryExpand.setAttribute('aria-expanded', 'false');
    queryExpand.title = '展开多行输入';
    selectedText = '';
    selectedRange = null;
    selectedInput = null;
    anchorRect = null;
    contextAnchor = null;
    selectionPointer = null;
    selectionPointerPending = false;
    selectionPointerText = '';
  }

  function getSelectionRect(range) {
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.width || rect.height);
    return rects[rects.length - 1] || range.getBoundingClientRect();
  }

  function getInputSelectionRect(input, start, end) {
    const rect = input.getBoundingClientRect();
    const style = getComputedStyle(input);
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const selected = input.value.slice(start, end);
    const before = input.value.slice(0, start);
    const isSingleLine = input instanceof HTMLInputElement;
    if (isSingleLine) {
      const canvas = getInputSelectionRect.canvas || (getInputSelectionRect.canvas = document.createElement('canvas'));
      const context = canvas.getContext('2d');
      if (context) {
        context.font = style.font;
        const transform = (value) => style.textTransform === 'uppercase' ? value.toUpperCase() : style.textTransform === 'lowercase' ? value.toLowerCase() : value;
        const letterSpacing = parseFloat(style.letterSpacing) || 0;
        const measure = (value) => context.measureText(transform(value)).width + letterSpacing * value.length;
        const beforeWidth = measure(before);
        const selectedWidth = Math.max(1, measure(selected));
        const left = rect.left + borderLeft + paddingLeft + beforeWidth - input.scrollLeft;
        const lineHeight = parseFloat(style.lineHeight) || rect.height;
        const top = rect.top + borderTop + Math.max(0, (rect.height - borderTop - (parseFloat(style.borderBottomWidth) || 0) - lineHeight) / 2);
        return { left, right: left + selectedWidth, top, bottom: top + lineHeight, width: selectedWidth, height: lineHeight };
      }
    }
    const mirror = document.createElement('div');
    const marker = document.createElement('span');
    mirror.style.cssText = `position:fixed;display:block;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;visibility:hidden;pointer-events:none;white-space:${style.whiteSpace};overflow-wrap:${style.overflowWrap};word-wrap:${style.wordWrap};font:${style.font};letter-spacing:${style.letterSpacing};word-spacing:${style.wordSpacing};text-indent:${style.textIndent};text-transform:${style.textTransform};line-height:${style.lineHeight};padding:${style.padding};border:${style.border};box-sizing:${style.boxSizing};`;
    marker.style.cssText = `font:${style.font};letter-spacing:${style.letterSpacing};word-spacing:${style.wordSpacing};white-space:${style.whiteSpace};text-transform:${style.textTransform};`;
    mirror.append(document.createTextNode(before), marker, document.createTextNode(input.value.slice(end)));
    marker.textContent = selected || '\u200b';
    document.body.append(mirror);
    const markerRect = marker.getBoundingClientRect();
    mirror.remove();
    const left = markerRect.left - input.scrollLeft;
    const top = markerRect.top - input.scrollTop;
    return { left, right: Math.max(left + 1, markerRect.right - input.scrollLeft), top, bottom: markerRect.bottom - input.scrollTop, width: Math.max(1, markerRect.width), height: Math.max(1, markerRect.height) };
  }

  function getInputSelection() {
    const input = document.activeElement;
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return null;
    if (typeof input.selectionStart !== 'number' || typeof input.selectionEnd !== 'number' || input.selectionStart === input.selectionEnd) return null;
    const text = input.value.slice(input.selectionStart, input.selectionEnd).replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return { text, input, rect: getInputSelectionRect(input, input.selectionStart, input.selectionEnd) };
  }

  function getContentEditableSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const anchor = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode?.parentElement;
    const editable = anchor?.closest?.('[contenteditable="true"]');
    if (!editable || !editable.isContentEditable || !editable.contains(selection.focusNode)) return null;
    const range = selection.getRangeAt(0);
    const text = selection.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    return { text, element: editable, range, rect: getSelectionRect(range) };
  }

  function positionTrigger(rect) {
    const triggerSize = 25;
    const left = Math.max(8, Math.min(window.innerWidth - triggerSize - 8, rect.right + 9));
    const top = Math.max(8, Math.min(window.innerHeight - triggerSize - 8, rect.top + (rect.height - triggerSize) / 2));
    trigger.style.left = `${left}px`;
    trigger.style.top = `${top}px`;
    return { left, top };
  }

  function positionPanel(rect, triggerPosition) {
    if (panelManuallyMoved) return;
    const panelWidth = Math.min(panel.offsetWidth || 362, window.innerWidth - 20);
    const panelHeight = panel.offsetHeight || 95;
    const triggerRect = trigger.getBoundingClientRect();
    const anchor = contextAnchor || triggerRect;
    const centeredLeft = selectionPointer ? selectionPointer.x - panelWidth / 2 : triggerRect.left;
    const left = Math.max(10, Math.min(window.innerWidth - panelWidth - 10, contextAnchor ? anchor.left : centeredLeft));
    const gap = 7;
    let top = selectionPointer && !contextAnchor ? selectionPointer.y + gap : anchor.bottom + gap;
    const upperAnchor = selectionPointer && !contextAnchor ? selectionPointer.y : anchor.top;
    if (top + panelHeight > window.innerHeight - 10 && upperAnchor - panelHeight - gap >= 10) top = upperAnchor - panelHeight - gap;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function resizeQueryInput() {
    queryInput.style.height = 'auto';
    const minHeight = 28;
    const maxHeight = 116;
    const height = Math.max(minHeight, Math.min(maxHeight, queryInput.scrollHeight || minHeight));
    queryInput.style.height = `${height}px`;
    queryInput.style.overflowY = (queryInput.scrollHeight || 0) > maxHeight ? 'auto' : 'hidden';
  }

  function getAvailableEngines() {
    const sourceMap = new Map();
    const groups = Array.isArray(settings.groups) ? settings.groups : [];
    const hasConfiguredSources = Array.isArray(settings.sources) && (settings.sources.length || groups.some((group) => group.id === 'default'));
    const sources = hasConfiguredSources
      ? [...settings.sources]
      : ENGINES.map((engine) => ({ ...engine, enabled: settings.engines[engine.id] !== false, iconOnly: settings.iconOnly[engine.id] === true }));
    if (hasConfiguredSources && settings.sourceConfigVersion < 5) ['baidu', 'google-scholar', 'duckduckgo', 'so', 'sogou', 'google-ai', 'xiaohongshu', 'douyin', 'doubao', 'deepseek'].forEach((id) => { if (!sources.some((source) => String(source?.id) === id)) { const engine = ENGINES.find((item) => item.id === id); if (engine) sources.push({ ...engine, enabled: true, iconOnly: false }); } });
    sources.forEach((source) => sourceMap.set(source.id, { ...source, className: source.className || (String(source.id).startsWith('custom-') ? 'custom' : source.id) }));
    const defaultGroup = groups.find((group) => group.id === 'default');
    const items = defaultGroup?.items || defaultGroup?.sourceIds || [];
    const defaultVisible = defaultGroup?.visible !== false;
    const customOwned = new Set(groups.filter((group) => group.id !== 'default').flatMap((group) => group.items || group.sourceIds || []).map(String));
    const ordered = [];
    const addSource = (id) => {
      const source = sourceMap.get(id);
      if (source && source.enabled !== false && source.name && (source.url || source.buildUrl) && !ordered.some((item) => item.id === id)) ordered.push(source);
    };
    const addSpecialAction = (id) => {
      const action = SPECIAL_ACTIONS.find((item) => item.id === String(id));
      const entryId = `action:${id}`;
      if (action && !ordered.some((item) => item.id === entryId)) ordered.push({ ...action, id: entryId });
    };
    const addGroup = (groupId) => {
      const group = groups.find((item) => item.id === groupId);
      if (group && group.id !== 'default' && group.visible !== false && group.showInDefault !== false && group.name && !ordered.some((item) => item.id === `group:${group.id}`)) ordered.push({ id: `group:${group.id}`, groupId: group.id, name: group.name, mark: '群', className: 'group', isGroup: true });
    };
    const addDefaultSource = (id) => { if (!customOwned.has(String(id))) addSource(id); };
    if (defaultVisible) {
      if (items.length) items.forEach((id) => {
        const token = String(id);
        if (token.startsWith('group:')) addGroup(token.slice(6));
        else if (token.startsWith('action:')) { if (!customOwned.has(token)) addSpecialAction(token.slice(7)); }
        else addDefaultSource(token);
      });
      else if (settings.sources?.length) settings.sources.forEach((source) => addDefaultSource(source.id));
      else (settings.engineOrder || []).forEach(addDefaultSource);
      if (items.length && hasConfiguredSources) sources.forEach((source) => addDefaultSource(source.id));
      if (!items.length && !hasConfiguredSources) settings.customEngines.filter((source) => source.enabled !== false).forEach((source) => addSource(source.id));
      groups.filter((group) => group.id !== 'default' && group.visible !== false && group.showInDefault !== false).forEach((group) => addGroup(group.id));
    }
    return ordered;
  }

  function getGroupSources(groupId) {
    const group = (settings.groups || []).find((item) => item.id === groupId);
    if (!group) return [];
    const sourceMap = new Map((settings.sources || []).map((source) => [source.id, source]));
    return (group.items || group.sourceIds || []).map((id) => {
      const token = String(id);
      if (token.startsWith('action:')) {
        const action = SPECIAL_ACTIONS.find((item) => item.id === token.slice(7));
        return action ? { ...action, id: token } : null;
      }
      return sourceMap.get(token);
    }).filter((source) => source && (source.isSpecial || (source.enabled !== false && source.name && (source.url || source.buildUrl))));
  }

  function rememberSearch(query) {
    const normalized = query.replace(/\s+/g, ' ').trim();
    if (!normalized) return;
    const history = settings.searchHistory
      .map((item) => typeof item === 'string' ? { query: item } : item)
      .filter((item) => item && item.query && item.query !== normalized);
    history.unshift({ query: normalized, timestamp: Date.now() });
    settings.searchHistory = history.slice(0, 20);
    if (storageAvailable()) chrome.storage.sync.set({ searchHistory: settings.searchHistory });
  }

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

  function getSearchUrl(engine, query) {
    if (engine.id === 'doubao') return `https://www.doubao.com/chat/?quickfind=${encodeURIComponent(query)}`;
    return typeof engine.buildUrl === 'function'
      ? engine.buildUrl(query)
      : engine.url.replace(/\{query\}/gi, encodeURIComponent(query));
  }

  function isPinnedSearchResults(siteId) {
    const params = new URLSearchParams(location.search);
    if (siteId === 'google-scholar') return /^\/scholar\/?$/i.test(location.pathname) && params.has('q');
    if (siteId === 'google') return /^\/search\/?$/i.test(location.pathname) && params.has('q');
    if (siteId === 'baidu') return /^\/s\/?$/i.test(location.pathname) && (params.has('wd') || params.has('word') || params.has('q'));
    if (siteId === 'duckduckgo') return (/^\/(?:html\/?)?$/i.test(location.pathname) || /^\/lite\/?$/i.test(location.pathname)) && params.has('q');
    if (siteId === 'so') return /^\/s\/?$/i.test(location.pathname) && params.has('q');
    if (siteId === 'sogou') return /^\/web\/?$/i.test(location.pathname) && (params.has('query') || params.has('q'));
    if (siteId === 'bing') return /^\/search\/?$/i.test(location.pathname) && params.has('q');
    if (siteId === 'yandex') return /^\/search\/?$/i.test(location.pathname) && params.has('text');
    if (siteId === 'zhihu') return /^\/search\/?$/i.test(location.pathname) && params.has('q');
    if (siteId === 'bilibili') return /^\/all\/?$/i.test(location.pathname) && params.has('keyword');
    if (siteId === 'douyin') return /^\/search(?:\/|$)/i.test(location.pathname) && (location.pathname.length > 8 || params.has('q') || params.has('keyword'));
    return false;
  }

  function createTemplateSite(source) {
    if (!source?.id) return null;
    const sourceName = String(source.name || source.id);
    const template = String(source.url || '');
    if (!template && typeof source.buildUrl !== 'function') return null;
    try {
      const marker = '__quickfind_query__';
      const candidateUrl = template && /\{query\}/i.test(template)
        ? template.replace(/\{query\}/gi, marker)
        : getSearchUrl(source, marker);
      const parsed = new URL(candidateUrl);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('unsupported protocol');
      const path = decodeURIComponent(parsed.pathname || '/');
      const pathMarker = path.toLowerCase().indexOf(marker.toLowerCase());
      const queryKeys = [];
      parsed.searchParams.forEach((value, key) => { if (value.toLowerCase().includes(marker.toLowerCase())) queryKeys.push(key); });
      return {
        id: String(source.id), name: sourceName, host: parsed.hostname.toLowerCase(), path,
        pathPrefix: pathMarker >= 0 ? path.slice(0, pathMarker) : '', pathSuffix: pathMarker >= 0 ? path.slice(pathMarker + marker.length) : '',
        pathHasMarker: pathMarker >= 0, queryKeys, selector: String(source.pinnedInputSelector || source.selector || GENERIC_PINNED_INPUT_SELECTOR),
        selectorConfigured: Boolean(String(source.pinnedInputSelector || source.selector || '').trim()),
        categorySelectors: Array.isArray(source.pinnedCategorySelectors) ? source.pinnedCategorySelectors.map(String) : [], dynamic: true,
        loose: !/\{query\}/i.test(template)
      };
    } catch {
      const raw = String(source.url || '').trim();
      const hostSource = raw.replace(/^[a-z][a-z\d+.-]*:\/\//i, '');
      const host = (hostSource.match(/(?:www\.)?([^/\s:?]+)(?::\d+)?/) || [])[1];
      return host ? { id: String(source.id), name: sourceName, host: host.toLowerCase(), path: '/', pathPrefix: '', pathSuffix: '', pathHasMarker: false, queryKeys: [], selector: String(source.pinnedInputSelector || source.selector || GENERIC_PINNED_INPUT_SELECTOR), selectorConfigured: Boolean(String(source.pinnedInputSelector || source.selector || '').trim()), categorySelectors: [], dynamic: true, loose: true } : null;
    }
  }

  function getDynamicPinnedSites() {
    const map = new Map();
    const pinned = settings?.pinnedSearch;
    const customSites = Array.isArray(pinned?.customSites) ? pinned.customSites : [];
    const addSources = (sources) => (Array.isArray(sources) ? sources : []).forEach((source) => {
      const site = createTemplateSite(source);
      if (site && !map.has(site.id)) map.set(site.id, site);
    });
    customSites.forEach((site) => {
      const descriptor = createTemplateSite(site);
      if (descriptor && !map.has(descriptor.id)) map.set(descriptor.id, descriptor);
    });
    addSources(settings?.sources);
    addSources(settings?.customEngines);
    if (!map.size) addSources(ENGINES.map((engine) => ({ ...engine, url: getSearchUrl(engine, 'quickfind') })));
    return Array.from(map.values());
  }

  function matchesDynamicPinnedSite(site) {
    const hostname = location.hostname.toLowerCase();
    const host = String(site.host || '').replace(/^www\./, '');
    const currentHost = hostname.replace(/^www\./, '');
    if (!(currentHost === host || currentHost.endsWith('.' + host))) return false;
    if (site.loose) return true;
    let pathname = location.pathname || '/';
    try { pathname = decodeURIComponent(pathname); } catch { /* keep encoded path */ }
    if (site.pathHasMarker) {
      if (!pathname.toLowerCase().startsWith(site.pathPrefix.toLowerCase()) || !pathname.toLowerCase().endsWith(site.pathSuffix.toLowerCase())) return false;
      const value = pathname.slice(site.pathPrefix.length, pathname.length - site.pathSuffix.length || undefined);
      if (!value || value.toLowerCase() === '__quickfind_query__') return false;
    } else {
      const normalizePath = (value) => String(value || '/').replace(/\/+$/, '') || '/';
      if (normalizePath(pathname) !== normalizePath(site.path)) return false;
      if (!site.queryKeys.length) return false;
      const params = new URLSearchParams(location.search);
      if (!site.queryKeys.some((key) => params.has(key))) return false;
    }
    return true;
  }

  function getPinnedSite(options = {}) {
    const requireSearchResults = options.requireSearchResults !== false;
    const hostname = location.hostname.toLowerCase();
    const pinned = settings?.pinnedSearch;
    const hasPinnedSiteConfig = Number(pinned?.siteConfigVersion) >= PINNED_SITE_CONFIG_VERSION;
    const enabledSites = hasPinnedSiteConfig && Array.isArray(pinned?.sites)
      ? new Set(pinned.sites.map(String))
      : Array.isArray(pinned?.sites)
        ? new Set([...pinned.sites.map(String), ...DEFAULT_PINNED_SITE_IDS.filter((id) => !LEGACY_PINNED_SITE_IDS.has(id))])
        : new Set(DEFAULT_PINNED_SITE_IDS);
    let site = null;
    if (/(^|\.)scholar\.google\.com$/.test(hostname) && enabledSites.has('google-scholar')) site = { id: 'google-scholar', selector: 'input[name="q"], input.gs_in_txt, textarea[name="q"]', selectorConfigured: true, categorySelectors: ['#gs_ab', '#gs_hdr'] };
    else if (/(^|\.)google\./.test(hostname) && enabledSites.has('google')) site = { id: 'google', selector: 'textarea[name="q"], input[name="q"]', selectorConfigured: true, categorySelectors: ['#hdtb', '#top_nav', '[role="navigation"] #hdtb-msb'] };
    else if (/(^|\.)baidu\.com$/.test(hostname) && enabledSites.has('baidu')) site = { id: 'baidu', selector: 'input#kw, input[name="wd"], input[name="word"], textarea#kw', selectorConfigured: true, categorySelectors: ['#s_tab', '#form', '[class*="s_tab"]'] };
    else if (/(^|\.)duckduckgo\.com$/.test(hostname) && enabledSites.has('duckduckgo')) site = { id: 'duckduckgo', selector: 'input[name="q"], #search_form_input, #search_form_input_homepage, input[aria-label*="Search"]', selectorConfigured: true, categorySelectors: ['#duckbar', '#duckbar_static', '[data-testid="search-filters"]'] };
    else if (/(^|\.)so\.com$/.test(hostname) && enabledSites.has('so')) site = { id: 'so', selector: 'input#input, input#search-input, input[name="q"], input[placeholder*="搜索"]', selectorConfigured: true, categorySelectors: ['.search-menu', '.search-nav', '[class*="search-nav"]'] };
    else if (/(^|\.)sogou\.com$/.test(hostname) && enabledSites.has('sogou')) site = { id: 'sogou', selector: 'input#query, input[name="query"], input[name="q"], input[placeholder*="搜索"]', selectorConfigured: true, categorySelectors: ['.search-nav', '#searchTab', '[class*="search-tab"]'] };
    else if (/(^|\.)bing\.com$/.test(hostname) && enabledSites.has('bing')) site = { id: 'bing', selector: 'input[name="q"]', selectorConfigured: true, categorySelectors: ['#b-scopebar', '[role="navigation"] #b-scopebar'] };
    else if (/(^|\.)yandex\.(com|ru)$/.test(hostname) && enabledSites.has('yandex')) site = { id: 'yandex', selector: 'input[name="text"], textarea[name="text"], input#text', selectorConfigured: true, categorySelectors: ['.navigation__items', '.serp-header .navigation', '[class*="Navigation"]'] };
    else if (/(^|\.)zhihu\.com$/.test(hostname) && enabledSites.has('zhihu')) site = { id: 'zhihu', selector: 'input[name="q"], input[placeholder*="搜索"], input[aria-label*="搜索"]', selectorConfigured: true, categorySelectors: ['.SearchTabs', '[class*="SearchTabs"]'] };
    else if (/(^|\.)bilibili\.com$/.test(hostname) && enabledSites.has('bilibili')) site = { id: 'bilibili', selector: 'input.nav-search-input, input.search-input, input[name="keyword"], input[placeholder*="搜索"], input[placeholder*="搜"]', selectorConfigured: true, categorySelectors: ['.search-tabs', '.search-header-tabs', '[class*="search-tabs"]'] };
    else if (/(^|\.)douyin\.com$/.test(hostname) && enabledSites.has('douyin')) site = { id: 'douyin', selector: 'input[data-e2e="searchbar-input"], input[placeholder*="搜索"], input[aria-label*="搜索"], input[name="keyword"]', selectorConfigured: true, categorySelectors: ['[data-e2e="search-tabs"]', '[class*="search-tab"]', '[class*="searchTab"]'] };
    const override = Array.isArray(pinned?.customSites) ? pinned.customSites.find((item) => String(item?.id) === String(site?.id)) : null;
    if (site && override) {
      const builtin = ENGINES.find((engine) => engine.id === site.id) || {};
      const overridden = createTemplateSite({ ...builtin, ...site, ...override, id: site.id, name: override.name || site.id, url: override.url || builtin.url });
      const host = String(overridden?.host || '').replace(/^www\./, '');
      const currentHost = hostname.replace(/^www\./, '');
      site = overridden && (currentHost === host || currentHost.endsWith('.' + host)) ? { ...site, ...overridden } : null;
    }
    if (site && requireSearchResults && pinned?.allSites !== true && !isPinnedSearchResults(site.id)) site = null;
    if (!site) {
      site = getDynamicPinnedSites().find((candidate) => enabledSites.has(candidate.id)
        && (requireSearchResults ? matchesDynamicPinnedSite(candidate) : (() => {
          const host = String(candidate.host || '').replace(/^www\./, '');
          const currentHost = hostname.replace(/^www\./, '');
          return currentHost === host || currentHost.endsWith('.' + host);
        })())) || null;
    }
    if (!site && pinned?.allSites === true) {
      const currentHost = hostname.replace(/^www\./, '');
      site = getDynamicPinnedSites().find((candidate) => enabledSites.has(candidate.id) && (currentHost === String(candidate.host || '').replace(/^www\./, '') || currentHost.endsWith('.' + String(candidate.host || '').replace(/^www\./, '')))) || {
        id: 'all-sites', name: '当前站点', host: hostname, path: '/', pathPrefix: '', pathSuffix: '', pathHasMarker: false, queryKeys: [], selector: GENERIC_PINNED_INPUT_SELECTOR, selectorConfigured: false, categorySelectors: [], dynamic: true, loose: true
      };
    }
    if (!site || (requireSearchResults && pinned?.allSites !== true && site.dynamic && !matchesDynamicPinnedSite(site))) return null;
    return site;
  }

  function findVisibleInput(selector) {
    try {
      return Array.from(document.querySelectorAll(selector)).find((input) => {
        const rect = input.getBoundingClientRect();
        return rect.width > 20 && rect.height > 10 && getComputedStyle(input).visibility !== 'hidden';
      }) || null;
    } catch { return null; }
  }

  function findVisibleElement(selectors) {
    for (const selector of selectors) {
      const element = Array.from(document.querySelectorAll(selector)).find((candidate) => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 20 && rect.height > 10 && getComputedStyle(candidate).visibility !== 'hidden';
      });
      if (element) return element;
    }
    return null;
  }

  function getPinnedConfig() {
    const pinned = settings.pinnedSearch || {};
    return {
      sources: settings.sources,
      groups: settings.groups,
      engines: settings.engines,
      iconOnly: settings.iconOnly,
      engineOrder: settings.engineOrder,
      customEngines: settings.customEngines,
      customSites: pinned.customSites,
      defaultGroupCount: pinned.defaultGroupCount,
      collapseDelay: pinned.collapseDelay,
      openInNewTab: pinned.openInNewTab === true,
      allSites: pinned.allSites === true,
      siteConfigVersion: settings.sourceConfigVersion >= 5 ? PINNED_SITE_CONFIG_VERSION : 0
    };
  }

  function getPinnedDefaultGroupCount() {
    return Math.max(1, Math.min(MAX_DEFAULT_GROUP_COUNT, Math.round(Number(getPinnedConfig().defaultGroupCount ?? 4) || 4)));
  }

  function getPinnedOpenInNewTab() {
    return getPinnedConfig().openInNewTab === true;
  }

  function setPinnedOpenInNewTab(openInNewTab) {
    settings.pinnedSearch = { ...(settings.pinnedSearch || {}), openInNewTab: Boolean(openInNewTab) };
    syncPinnedOpenModeButton();
    if (storageAvailable()) chrome.storage.sync.set({ pinnedSearch: settings.pinnedSearch });
  }

  function openPinnedSearchInNewTab(url) {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'open-search-tab', url });
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function getPinnedEntries() {
    const config = getPinnedConfig();
    const groups = Array.isArray(config.groups) ? config.groups : [];
    const configured = Array.isArray(config.sources) && (config.sources.length || groups.some((group) => group?.id === 'default'));
    const backfilledBuiltinIds = [];
    const rawSources = configured
      ? [...config.sources]
      : (Array.isArray(config.sources) && config.sources.length ? config.sources : ENGINES.map((engine) => ({ ...engine, enabled: config.engines?.[engine.id] !== false, iconOnly: config.iconOnly?.[engine.id] === true })).concat(config.customEngines || []));
    const needsPinnedBuiltinMigration = Number(config.siteConfigVersion) < PINNED_SITE_CONFIG_VERSION;
    if (configured && needsPinnedBuiltinMigration) ['baidu', 'google-scholar', 'duckduckgo', 'so', 'sogou', 'douyin'].forEach((id) => {
      if (rawSources.some((source) => String(source?.id) === id)) return;
      const engine = ENGINES.find((item) => item.id === id);
      if (engine) { rawSources.push({ ...engine, enabled: true, iconOnly: false }); backfilledBuiltinIds.push(id); }
    });
    const sourceMap = new Map();
    rawSources.forEach((source) => {
      if (!source?.id || !source.name || !(source.url || source.buildUrl)) return;
      sourceMap.set(String(source.id), { ...source, id: String(source.id), className: source.className || (String(source.id).startsWith('custom-') ? 'custom' : String(source.id)) });
    });
    const defaultGroup = groups.find((group) => group?.id === 'default');
    const customOwned = new Set(groups.filter((group) => group?.id && group.id !== 'default').flatMap((group) => group.items || group.sourceIds || []).map(String));
    const ordered = [];
    const addSource = (id) => {
      const source = sourceMap.get(String(id));
      if (source && source.enabled !== false && !ordered.some((item) => item.id === source.id)) ordered.push(source);
    };
    const addSpecialAction = (id) => {
      const action = SPECIAL_ACTIONS.find((item) => item.id === String(id));
      const entryId = `action:${id}`;
      if (action && !ordered.some((item) => item.id === entryId)) ordered.push({ ...action, id: entryId });
    };
    const addGroup = (id) => {
      const group = groups.find((item) => String(item?.id) === String(id));
      const entryId = 'group:' + id;
      if (group && group.id !== 'default' && group.visible !== false && group.showInDefault !== false && !ordered.some((item) => item.id === entryId)) ordered.push({ id: entryId, groupId: String(id), name: String(group.name || '未命名分组'), mark: '组', className: 'group', isGroup: true });
    };
    const items = [...(defaultGroup?.items || defaultGroup?.sourceIds || []), ...backfilledBuiltinIds];
    if (defaultGroup?.visible !== false) {
      if (items.length) items.forEach((item) => {
        const token = String(item);
        if (token.startsWith('group:')) addGroup(token.slice(6));
        else if (token.startsWith('action:')) { if (!customOwned.has(token)) addSpecialAction(token.slice(7)); }
        else if (!customOwned.has(token)) addSource(token);
      });
      else {
        (config.engineOrder || Array.from(sourceMap.keys())).forEach((id) => !customOwned.has(String(id)) && addSource(id));
        sourceMap.forEach((source) => { if (!customOwned.has(source.id)) addSource(source.id); });
      }
      groups.filter((group) => group?.id && group.id !== 'default' && group.visible !== false && group.showInDefault !== false).forEach((group) => addGroup(group.id));
    }
    return ordered;
  }

  function getPinnedGroupSources(groupId) {
    const config = getPinnedConfig();
    const group = (config.groups || []).find((item) => String(item?.id) === String(groupId));
    if (!group) return [];
    const sourceMap = new Map();
    const addSources = (sources) => (Array.isArray(sources) ? sources : []).forEach((source) => {
      if (source?.id && source?.name && (source.url || source.buildUrl) && !sourceMap.has(String(source.id))) {
        sourceMap.set(String(source.id), { ...source, id: String(source.id), className: source.className || (String(source.id).startsWith('custom-') ? 'custom' : String(source.id)) });
      }
    });
    addSources(config.sources);
    addSources(config.customEngines);
    addSources(settings.sources);
    addSources(settings.customEngines);
    if (!sourceMap.size) addSources(ENGINES);
    return (group.items || group.sourceIds || []).map((id) => {
      const token = String(id);
      if (token.startsWith('action:')) {
        const action = SPECIAL_ACTIONS.find((item) => item.id === token.slice(7));
        return action ? { ...action, id: token } : null;
      }
      return sourceMap.get(token);
    }).filter((source) => source && (source.isSpecial || (source.enabled !== false && source.name && (source.url || source.buildUrl))));
  }

  function ensurePinnedHost() {
    if (pinnedHost?.shadowRoot) return pinnedHost;
    pinnedHost = document.createElement('div');
    pinnedHost.id = 'quickfind-pinned-search-host';
    pinnedHost.style.cssText = 'position:fixed;z-index:2147483646;display:block;max-width:calc(100vw - 20px);pointer-events:none;';
    const root = pinnedHost.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host{all:initial;display:block;width:max-content;max-width:calc(100vw - 20px);overflow:visible}
        .bar{--pinned-bar-border-size:1px;box-sizing:border-box;display:block;width:max-content;max-width:calc(100vw - 20px);height:var(--pinned-bar-height,auto);border:var(--pinned-bar-border-size) solid rgba(255,255,255,.7);border-radius:0 0 7px 7px;background:rgba(250,253,251,.96);box-shadow:0 10px 24px rgba(20,53,40,.16),0 2px 4px rgba(20,53,40,.07);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);overflow:hidden;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:auto;transform:translateY(0);transition:height .22s cubic-bezier(.2,.8,.2,1),transform .22s cubic-bezier(.2,.8,.2,1),border-width .22s cubic-bezier(.2,.8,.2,1),box-shadow .18s ease;will-change:height,transform}
        .bar-content{display:flex;flex-direction:column;align-items:stretch;gap:3px;padding:3px 5px 4px}
        :host(.is-collapsed) .bar{height:0;border-width:0;box-shadow:none;transform:translateY(-7px);pointer-events:none}
        .pinned-query-row{display:flex;flex:0 0 auto;gap:3px;width:100%;min-width:180px;max-width:calc(100vw - 34px)}
        .pinned-query{flex:1 1 auto;width:0;height:24px;min-width:0;padding:2px 7px;border:1px solid #d8e5dc;border-radius:5px;outline:none;color:#29483b;background:rgba(255,255,255,.9);font:11px/17px Inter,ui-sans-serif,sans-serif}
        .pinned-query:focus{border-color:#6eaf8d;box-shadow:0 0 0 2px rgba(62,143,108,.12)}
        .pinned-open-mode{display:grid;place-items:center;flex:0 0 auto;width:24px;height:24px;padding:0;border:1px solid #d8e5dc;border-radius:5px;color:#789087;background:#fff;cursor:pointer}
        .pinned-open-mode:hover{border-color:#93bda6;color:#2f795b;background:#f4faf6}.pinned-open-mode[aria-pressed="true"]{border-color:#8fbea4;color:#2f795b;background:#e6f4eb}.pinned-open-mode:focus-visible{outline:2px solid #3e8f6c;outline-offset:2px}
        .pinned-open-mode svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
        .reveal-handle{display:grid;place-items:center;width:78px;height:9px;margin:0 auto;padding:0;border:1px solid rgba(255,255,255,.78);border-top:0;border-radius:0 0 7px 7px;color:#6f8b7d;background:rgba(250,253,251,.96);box-shadow:0 5px 12px rgba(20,53,40,.14);cursor:pointer;pointer-events:none;opacity:0;visibility:hidden;transform:translateY(-7px);transition:transform .22s cubic-bezier(.2,.8,.2,1),opacity .12s ease,visibility 0s linear .22s}
        :host(.is-collapsed) .reveal-handle{pointer-events:auto;opacity:1;visibility:visible;transform:translateY(0);transition-delay:.06s,.06s,0s}
        .reveal-handle::before{content:"";width:30px;height:2px;border-radius:99px;background:currentColor}
        .reveal-handle:hover{color:#2f795b;background:#f4faf6}
        .reveal-handle:focus-visible{outline:2px solid #3e8f6c;outline-offset:2px}
        .entries{display:flex;align-items:center;flex:0 0 auto;flex-wrap:nowrap;gap:4px;width:100%;min-width:0;max-width:calc(100vw - 34px);overflow-x:auto}
        .entry{display:flex;align-items:center;gap:4px;flex:0 0 auto;min-height:23px;padding:2px 6px 2px 3px;border:1px solid #d8e5dc;border-radius:5px;color:#355347;background:#fff;font:600 11px/1.2 Inter,ui-sans-serif,sans-serif;cursor:pointer}
        .entry.icon-only{gap:0;padding-right:4px}.entry.icon-only .name{display:none}
        .entry:hover{border-color:#93bda6;background:#f4faf6}.entry:focus-visible{outline:2px solid #3e8f6c;outline-offset:2px}
        .mark{display:grid;place-items:center;width:17px;height:17px;overflow:hidden;border-radius:4px;color:#fff;background:#6c8b7b;font:700 10px/1 Arial,sans-serif}.mark img{width:100%;height:100%;object-fit:cover}
        .google .mark{background:#4285f4}.baidu .mark{background:#2932e1}.google-scholar .mark{background:#5f6368;font-size:9px}.duckduckgo .mark{background:#de5833}.so .mark{background:#19a15f;font-size:9px}.sogou .mark{background:#ff5a34}.bing .mark{background:#1185e0}.yandex .mark{background:#ef3b3b}.google-ai .mark{background:#6b5ce7}.bilibili .mark{background:#00aeec}.xiaohongshu .mark{background:#ef4d62}.x .mark{background:#111}.youtube .mark{background:#f21f26}.zhihu .mark{background:#1777e6}.douyin .mark{background:#161823}.doubao .mark{background:#4f7cff}.deepseek .mark{background:#4d6bfe}.group .mark{color:#315f4d;background:#dfeee5}
        .special-copy .mark{color:#fff;background:#6c8178}
        .name{max-width:94px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .collapse-button{display:flex;align-items:center;justify-content:center;width:100%;height:14px;margin-top:2px;padding:0;border:0;border-bottom:1px solid #e6eee9;color:#789087;background:transparent;cursor:pointer}
        .collapse-button:hover{color:#2f795b;background:#f4faf6}.collapse-button:focus-visible{outline:2px solid #3e8f6c;outline-offset:1px}
        .collapse-button svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
        @media (prefers-reduced-motion: reduce){.bar,.reveal-handle{transition:none}}
        .pinned-group-list{position:fixed;z-index:2147483647;display:flex;flex-direction:column;align-items:stretch;gap:4px;min-width:160px;max-width:calc(100vw - 20px);max-height:calc(100vh - 20px);padding:4px;overflow-y:auto;border:1px solid rgba(255,255,255,.78);border-radius:7px;background:rgba(250,253,251,.98);box-shadow:0 12px 30px rgba(20,53,40,.18),0 2px 5px rgba(20,53,40,.08);backdrop-filter:blur(14px) saturate(1.2);-webkit-backdrop-filter:blur(14px) saturate(1.2);pointer-events:auto}
        .pinned-group-list[hidden]{display:none}.pinned-group-list .entry{width:100%;justify-content:flex-start}
      </style>
      <section class="bar" aria-label="QuickFind 常驻搜索列表">
        <div class="bar-content">
          <div class="pinned-query-row"><input class="pinned-query" type="text" aria-label="当前搜索文本" autocomplete="off" /><button class="pinned-open-mode" type="button" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"></path></svg></button></div>
          <div class="entries"></div>
          <button class="collapse-button" type="button" aria-label="收起常驻搜索栏" title="收起常驻搜索栏"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 15 6-6 6 6"></path></svg></button>
        </div>
      </section>
      <div class="pinned-group-list" hidden></div>
      <button class="reveal-handle" type="button" aria-label="展开常驻搜索栏" aria-expanded="false" title="展开常驻搜索栏"></button>
    `;
    const bar = root.querySelector('.bar');
    const pinnedQuery = root.querySelector('.pinned-query');
    const pinnedOpenMode = root.querySelector('.pinned-open-mode');
    const pinnedGroupList = root.querySelector('.pinned-group-list');
    const revealHandle = root.querySelector('.reveal-handle');
    const collapseButton = root.querySelector('.collapse-button');
    const resumePinnedBarCollapseAfterEditing = () => {
      window.setTimeout(() => {
        if (isEditingPinnedQuery()) return;
        pinnedCollapsePaused = false;
        schedulePinnedBarCollapse(getPinnedSite(), { restart: true });
      }, 0);
    };
    pinnedQuery.addEventListener('compositionstart', () => {
      pinnedQueryComposing = true;
      pinnedCollapsePaused = true;
      clearPinnedCollapseTimer();
    });
    pinnedQuery.addEventListener('compositionend', () => {
      pinnedQueryComposing = false;
      resumePinnedBarCollapseAfterEditing();
    });
    pinnedQuery.addEventListener('input', () => {
      pinnedCollapsePaused = true;
      clearPinnedCollapseTimer();
      const site = getPinnedSite();
      const siteInput = site?.selectorConfigured === false ? null : site ? findVisibleInput(site.selector) : null;
      if (!siteInput || siteInput.value === pinnedQuery.value) return;
      siteInput.value = pinnedQuery.value;
      siteInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    pinnedOpenMode.addEventListener('click', () => setPinnedOpenInNewTab(!getPinnedOpenInNewTab()));
    syncPinnedOpenModeButton(root);
    const expandPinnedBar = () => {
      pinnedCollapsePaused = true;
      clearPinnedCollapseTimer();
      setPinnedBarCollapsed(false, getPinnedSite());
    };
    revealHandle.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'touch') expandPinnedBar();
    });
    revealHandle.addEventListener('focus', expandPinnedBar);
    revealHandle.addEventListener('click', expandPinnedBar);
    bar.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'touch') {
        pinnedCollapsePaused = true;
        clearPinnedCollapseTimer();
      }
    });
    bar.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'touch') {
        if (isEditingPinnedQuery()) return;
        pinnedCollapsePaused = false;
        schedulePinnedBarCollapse(getPinnedSite(), { restart: true });
      }
    });
    bar.addEventListener('focusin', () => {
      pinnedCollapsePaused = true;
      clearPinnedCollapseTimer();
    });
    bar.addEventListener('focusout', () => {
      if (isEditingPinnedQuery() || (root.activeElement && bar.contains(root.activeElement))) return;
      pinnedCollapsePaused = false;
      schedulePinnedBarCollapse(getPinnedSite(), { restart: true });
    });
    pinnedGroupList.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'touch') {
        pinnedCollapsePaused = true;
        clearPinnedCollapseTimer();
      }
    });
    pinnedGroupList.addEventListener('pointerleave', (event) => {
      if (event.pointerType !== 'touch') {
        pinnedCollapsePaused = false;
        schedulePinnedBarCollapse(getPinnedSite(), { restart: true });
      }
    });
    collapseButton.addEventListener('click', () => setPinnedBarCollapsed(true, getPinnedSite()));
    return pinnedHost;
  }

  function syncPinnedOpenModeButton(root = pinnedHost?.shadowRoot) {
    const button = root?.querySelector('.pinned-open-mode');
    if (!button) return;
    const openInNewTab = getPinnedOpenInNewTab();
    const label = openInNewTab
      ? '搜索结果将在新标签页打开；点击改为当前页面打开'
      : '搜索结果将在当前页面打开；点击改为新标签页打开';
    button.setAttribute('aria-pressed', String(openInNewTab));
    button.setAttribute('aria-label', label);
    button.title = label;
  }

  function getPinnedQueryInput() {
    return pinnedHost?.shadowRoot?.querySelector('.pinned-query') || null;
  }

  function isEditingPinnedQuery() {
    const pinnedQuery = getPinnedQueryInput();
    return pinnedQueryComposing || Boolean(pinnedQuery && pinnedHost?.shadowRoot?.activeElement === pinnedQuery);
  }

  function syncPinnedQuery(site) {
    const pinnedQuery = getPinnedQueryInput();
    if (!pinnedQuery || pinnedHost?.shadowRoot?.activeElement === pinnedQuery) return;
    const siteInput = site?.selectorConfigured === false ? null : site ? findVisibleInput(site.selector) : null;
    const history = Array.isArray(settings?.searchHistory) ? settings.searchHistory : [];
    const lastSearch = history.map((item) => typeof item === 'string' ? item : item?.query).find(Boolean) || '';
    const urlQuery = getPinnedQueryFromUrl(site);
    const fallback = urlQuery || lastSearch;
    pinnedQuery.value = siteInput?.value || fallback || '';
  }

  function getPinnedQueryFromUrl(site) {
    if (!site) return '';
    const keys = [...new Set(['q', 'keyword', ...(Array.isArray(site.queryKeys) ? site.queryKeys : [])].map((key) => String(key).toLowerCase()))];
    const queryParts = [location.search];
    const hashQueryIndex = location.hash.indexOf('?');
    if (hashQueryIndex >= 0) queryParts.push(location.hash.slice(hashQueryIndex));
    else if (/^#[^/=?&]+=/i.test(location.hash)) queryParts.push(location.hash.slice(1));
    const paramsList = queryParts.filter(Boolean).map((query) => new URLSearchParams(query));
    for (const key of keys) {
      for (const params of paramsList) {
        const match = Array.from(params.entries()).find(([name, value]) => name.toLowerCase() === key && value.trim());
        if (match) return match[1].trim();
      }
    }
    if (site.pathHasMarker) {
      let pathname = location.pathname || '/';
      try { pathname = decodeURIComponent(pathname); } catch { /* keep encoded path */ }
      const prefix = String(site.pathPrefix || ''), suffix = String(site.pathSuffix || '');
      if (pathname.toLowerCase().startsWith(prefix.toLowerCase()) && pathname.toLowerCase().endsWith(suffix.toLowerCase())) {
        const value = pathname.slice(prefix.length, pathname.length - suffix.length || undefined);
        if (value && value.toLowerCase() !== '__quickfind_query__') return value;
      }
    }
    return '';
  }

  function getPinnedQuery(site) {
    const pinnedQuery = getPinnedQueryInput();
    if (pinnedQuery) return pinnedQuery.value.trim();
    return site?.selectorConfigured === false ? '' : findVisibleInput(site.selector)?.value.trim() || '';
  }

  function createPinnedButton(entry, site, allowIconOnly = true) {
    const button = document.createElement('button');
    button.type = 'button';
    const iconOnly = allowIconOnly && !entry.isGroup && (entry.iconOnly === true || getPinnedConfig().iconOnly?.[entry.id] === true);
    button.className = 'entry ' + entry.className + (iconOnly ? ' icon-only' : '');
    button.title = entry.isGroup ? '展开' + entry.name : entry.isSpecial ? `${entry.name}搜索内容` : '使用' + entry.name + '搜索';
    if (entry.isGroup) {
      button.dataset.groupId = entry.groupId;
      button.setAttribute('aria-expanded', String(pinnedExpandedGroupId === entry.groupId));
    }
    const mark = document.createElement('span');
    mark.className = 'mark';
    if (entry.iconUrl) {
      const image = document.createElement('img');
      image.src = entry.iconUrl; image.alt = '';
      image.addEventListener('error', () => { image.remove(); mark.textContent = entry.mark || '?'; });
      mark.append(image);
    } else mark.textContent = entry.mark || '?';
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = entry.name;
    button.append(mark, name);
    button.addEventListener('click', () => {
      if (entry.isGroup) {
        pinnedMoreExpanded = false;
        pinnedExpandedGroupId = pinnedExpandedGroupId === entry.groupId ? null : entry.groupId;
        renderPinnedBar(site);
        positionPinnedBar(site);
        return;
      }
      const input = findVisibleInput(site.selector);
      const query = getPinnedQuery(site);
      if (!query) return getPinnedQueryInput()?.focus() || input?.focus();
      if (entry.isSpecial) {
        if (entry.action === 'copy') void copyTextToClipboard(query);
        return;
      }
      rememberSearch(query);
      const url = getSearchUrl(entry, query);
      if (getPinnedOpenInNewTab()) openPinnedSearchInNewTab(url);
      else window.location.assign(url);
    });
    return button;
  }

  function createPinnedMoreButton(site) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'entry group';
    button.dataset.pinnedMore = 'true';
    button.setAttribute('aria-expanded', String(pinnedMoreExpanded));
    button.title = pinnedMoreExpanded ? '收起更多搜索源' : '展开更多搜索源';
    const mark = document.createElement('span');
    mark.className = 'mark'; mark.textContent = pinnedMoreExpanded ? '⌃' : '…';
    const name = document.createElement('span');
    name.className = 'name'; name.textContent = pinnedMoreExpanded ? '收起' : '更多';
    button.append(mark, name);
    button.addEventListener('click', () => {
      pinnedExpandedGroupId = null;
      pinnedMoreExpanded = !pinnedMoreExpanded;
      renderPinnedBar(site);
      positionPinnedBar(site);
    });
    return button;
  }

  function renderPinnedBar(site) {
    const root = ensurePinnedHost().shadowRoot;
    const entries = root.querySelector('.entries');
    const groupList = root.querySelector('.pinned-group-list');
    const allEntries = getPinnedEntries();
    const directEntries = allEntries.slice(0, getPinnedDefaultGroupCount());
    const hiddenEntries = allEntries.slice(directEntries.length);
    syncPinnedQuery(site);
    entries.replaceChildren();
    directEntries.forEach((entry) => entries.append(createPinnedButton(entry, site)));
    if (hiddenEntries.length) entries.append(createPinnedMoreButton(site));
    groupList.replaceChildren();
    if (pinnedMoreExpanded) hiddenEntries.forEach((entry) => groupList.append(createPinnedButton(entry, site, false)));
    else if (pinnedExpandedGroupId) getPinnedGroupSources(pinnedExpandedGroupId).forEach((entry) => groupList.append(createPinnedButton(entry, site, false)));
    groupList.hidden = !groupList.childElementCount;
    ensurePinnedHost().hidden = !entries.childElementCount;
    syncPinnedOpenModeButton(root);
    syncPinnedBarHeight(root);
  }

  function syncPinnedBarHeight(root = pinnedHost?.shadowRoot) {
    const bar = root?.querySelector('.bar');
    const content = root?.querySelector('.bar-content');
    if (!bar || !content) return;
    const borderSize = parseFloat(getComputedStyle(bar).getPropertyValue('--pinned-bar-border-size')) || 1;
    const height = Math.ceil(content.scrollHeight + borderSize * 2);
    bar.style.setProperty('--pinned-bar-height', `${height}px`);
  }

  function clearPinnedCollapseTimer({ resetDeadline = true } = {}) {
    if (pinnedCollapseTimer) window.clearTimeout(pinnedCollapseTimer);
    pinnedCollapseTimer = null;
    if (resetDeadline) pinnedCollapseDeadline = 0;
  }

  function schedulePinnedBarCollapse(site, { restart = false } = {}) {
    clearPinnedCollapseTimer({ resetDeadline: false });
    if (!pinnedHost || pinnedBarCollapsed || pinnedCollapsePaused || isEditingPinnedQuery()) return;
    const configuredDelay = Number(getPinnedConfig().collapseDelay);
    const delay = Number.isFinite(configuredDelay) ? Math.max(0, Math.min(60000, configuredDelay)) : 2000;
    if (restart || !pinnedCollapseDeadline) pinnedCollapseDeadline = Date.now() + delay;
    const remaining = Math.max(0, pinnedCollapseDeadline - Date.now());
    pinnedCollapseTimer = window.setTimeout(() => {
      pinnedCollapseTimer = null;
      pinnedCollapseDeadline = 0;
      setPinnedBarCollapsed(true, site || getPinnedSite());
    }, remaining);
  }

  function positionPinnedGroupList() {
    if ((!pinnedExpandedGroupId && !pinnedMoreExpanded) || !pinnedHost) return;
    const root = pinnedHost.shadowRoot;
    const groupList = root?.querySelector('.pinned-group-list');
    if (!groupList || groupList.hidden) return;
    const moreButton = root.querySelector('.entry[data-pinned-more="true"]');
    const triggerButton = pinnedMoreExpanded
      ? moreButton
      : Array.from(root.querySelectorAll('.entries .entry[data-group-id]')).find((button) => button.dataset.groupId === pinnedExpandedGroupId) || moreButton;
    if (!triggerButton) { groupList.hidden = true; return; }
    const buttonRect = triggerButton.getBoundingClientRect();
    const flyoutWidth = Math.min(groupList.offsetWidth || 160, window.innerWidth - 20);
    const flyoutHeight = Math.min(groupList.offsetHeight || 36, window.innerHeight - 20);
    let left = buttonRect.right + 6;
    if (left + flyoutWidth > window.innerWidth - 10) left = buttonRect.left - flyoutWidth - 6;
    left = Math.max(10, Math.min(window.innerWidth - flyoutWidth - 10, left));
    const top = Math.max(10, Math.min(window.innerHeight - flyoutHeight - 10, buttonRect.top));
    groupList.style.left = `${left}px`;
    groupList.style.top = `${top}px`;
  }

  function setPinnedBarCollapsed(collapsed, site) {
    clearPinnedCollapseTimer();
    if (!pinnedHost) return;
    const wasCollapsed = pinnedBarCollapsed;
    pinnedBarCollapsed = collapsed;
    if (collapsed) {
      pinnedExpandedGroupId = null;
      pinnedMoreExpanded = false;
      if (site) renderPinnedBar(site);
    }
    pinnedHost.classList.toggle('is-collapsed', collapsed);
    const revealHandle = pinnedHost.shadowRoot?.querySelector('.reveal-handle');
    if (revealHandle) revealHandle.setAttribute('aria-expanded', String(!collapsed));
    positionPinnedBar(site);
    if (wasCollapsed && !collapsed) {
      const pinnedQuery = pinnedHost.shadowRoot?.querySelector('.pinned-query');
      pinnedQuery?.focus({ preventScroll: true });
      pinnedQuery?.select();
    }
  }

  function positionPinnedBar(site) {
    const entriesAvailable = Boolean(site && getPinnedEntries().length && settings?.enabled);
    if (!entriesAvailable) {
      clearPinnedCollapseTimer();
      if (pinnedHost) pinnedHost.hidden = true;
      return null;
    }
    const barHost = pinnedHost || ensurePinnedHost();
    if (!barHost.isConnected) document.documentElement.append(barHost);
    barHost.hidden = false;
    barHost.classList.toggle('is-collapsed', pinnedBarCollapsed);
    const panelWidth = Math.min(barHost.offsetWidth || 420, window.innerWidth - 20);
    const left = Math.max(10, Math.min(window.innerWidth - panelWidth - 10, (window.innerWidth - panelWidth) / 2));
    barHost.style.left = `${left}px`;
    barHost.style.top = '0px';
    positionPinnedGroupList();
    return barHost;
  }

  function mountPinnedBar() {
    const site = getPinnedSite();
    if (!site || !settings) {
      clearPinnedCollapseTimer();
      if (pinnedHost) pinnedHost.hidden = true;
      pinnedMountedSiteId = null;
      pinnedMountedPageKey = '';
      return;
    }
    const pageKey = location.href;
    const isNewPage = pinnedMountedSiteId !== site.id || pinnedMountedPageKey !== pageKey;
    if (isNewPage) {
      clearPinnedCollapseTimer();
      pinnedMountedSiteId = site.id;
      pinnedMountedPageKey = pageKey;
      if (!isEditingPinnedQuery()) {
        pinnedBarCollapsed = true;
        pinnedCollapsePaused = false;
        pinnedMoreExpanded = false;
        pinnedExpandedGroupId = null;
      }
    }
    const host = ensurePinnedHost();
    host.classList.toggle('is-collapsed', pinnedBarCollapsed);
    host.shadowRoot?.querySelector('.reveal-handle')?.setAttribute('aria-expanded', String(!pinnedBarCollapsed));
    if (!host.isConnected) document.documentElement.append(host);
    renderPinnedBar(site);
    positionPinnedBar(site);
    if (!pinnedBarCollapsed && !isNewPage) schedulePinnedBarCollapse(site);
  }

  function schedulePinnedMount() {
    if (!getPinnedSite({ requireSearchResults: false }) || pinnedMountTimer) return;
    pinnedMountTimer = window.setTimeout(() => { pinnedMountTimer = null; mountPinnedBar(); }, 120);
  }

  function positionGroupEngineList() {
    if (!expandedGroupId || groupEngineList.hidden) return;
    const groupButton = Array.from(shadow.querySelectorAll('.engine[data-group-id]')).find((button) => button.dataset.groupId === expandedGroupId);
    if (!groupButton) { groupEngineList.hidden = true; return; }
    const buttonRect = groupButton.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const flyoutWidth = Math.min(groupEngineList.offsetWidth || 160, window.innerWidth - 20);
    const flyoutHeight = Math.min(groupEngineList.offsetHeight || 36, window.innerHeight - 20);
    let left = buttonRect.right + 6;
    if (left + flyoutWidth > window.innerWidth - 10) left = buttonRect.left - flyoutWidth - 6;
    left = Math.max(10, Math.min(window.innerWidth - flyoutWidth - 10, left));
    const top = Math.max(10, Math.min(window.innerHeight - flyoutHeight - 10, buttonRect.top));
    groupEngineList.style.left = `${left - panelRect.left}px`;
    groupEngineList.style.top = `${top - panelRect.top}px`;
  }

  function renderEngines() {
    engineList.replaceChildren();
    hiddenEngineList.replaceChildren();
    groupEngineList.replaceChildren();
    const available = getAvailableEngines();
    const createEngineButton = (engine, target, allowIconOnly = true) => {
      const button = document.createElement('button');
      button.type = 'button';
      const iconOnly = allowIconOnly && (engine.iconOnly === true || settings.iconOnly[engine.id] === true);
      button.className = `engine ${engine.className}${iconOnly ? ' icon-only' : ''}`;
      button.dataset.engine = engine.id;
      button.title = engine.isSpecial ? `${engine.name}搜索内容` : `使用${engine.name}搜索`;
      const name = document.createElement('span');
      name.className = 'engine-name';
      name.textContent = engine.name;
      if (engine.isGroup) {
        button.classList.add('group-text-only');
        button.dataset.groupId = engine.groupId;
        button.setAttribute('aria-expanded', String(expandedGroupId === engine.groupId));
      } else {
        const mark = document.createElement('span');
        mark.className = 'engine-mark';
        mark.setAttribute('aria-hidden', 'true');
        if (engine.iconUrl) { const image = document.createElement('img'); image.src = engine.iconUrl; image.alt = ''; image.addEventListener('error', () => { image.remove(); mark.textContent = engine.mark || '?'; }); mark.append(image); } else mark.textContent = engine.mark || '?';
        button.append(mark);
      }
      button.append(name);
      button.addEventListener('click', () => {
        if (engine.isGroup) {
          expandedGroupId = expandedGroupId === engine.groupId ? null : engine.groupId;
          if (target === hiddenEngineList) expanded = true;
          renderEngines();
          if (anchorRect) positionPanel(anchorRect, { left: parseFloat(trigger.style.left) || 0 });
          positionGroupEngineList();
          return;
        }
        if (!selectedText) return;
        if (engine.isSpecial) {
          if (engine.action === 'copy') void copyTextToClipboard(selectedText);
          hideAll();
          return;
        }
        const url = getSearchUrl(engine, selectedText);
        rememberSearch(selectedText);
        window.open(url, '_blank', 'noopener,noreferrer');
        hideAll();
      });
      target.append(button);
    };
    const visibleCount = settings.defaultGroupCount || 4;
    const initial = available.slice(0, visibleCount);
    const hidden = available.slice(visibleCount);
    initial.forEach((engine) => createEngineButton(engine, engineList));
    if (expanded) hidden.forEach((engine) => createEngineButton(engine, hiddenEngineList, false));
    if (expandedGroupId) getGroupSources(expandedGroupId).forEach((engine) => createEngineButton(engine, groupEngineList, false));
    groupEngineList.hidden = !expandedGroupId || !groupEngineList.childElementCount;
    const moreButton = document.createElement('button');
    moreButton.type = 'button';
    moreButton.className = 'engine more-engine';
    moreButton.title = expanded ? '收起更多搜索源' : '展开更多搜索源';
    moreButton.setAttribute('aria-label', moreButton.title);
    moreButton.innerHTML = expanded
      ? '<span class="engine-mark" aria-hidden="true">⌃</span>'
      : '<span class="engine-mark" aria-hidden="true">•••</span>';
    moreButton.addEventListener('click', () => {
      expanded = !expanded;
      expandedGroupId = null;
      renderEngines();
      if (anchorRect) positionPanel(anchorRect, { left: parseFloat(trigger.style.left) || 0 });
    });
    if (hidden.length) engineList.append(moreButton);
    hiddenEngineList.hidden = !expanded || !hidden.length;
  }

  function showForSelection() {
    // Selection changes fire continuously while the user is dragging. Wait for mouseup.
    if (mouseButtonDown) return hideAll();
    if (contextAnchor) return;
    const inputSelection = getInputSelection();
    const contentEditableSelection = inputSelection ? null : getContentEditableSelection();
    const editableSelection = inputSelection || contentEditableSelection;
    if (editableSelection && settings.editableTriggerMode === 'none') return hideAll();
    const selection = inputSelection ? null : window.getSelection();
    if (!inputSelection && (!selection || selection.isCollapsed)) return hideAll();
    const text = editableSelection ? editableSelection.text : selection.toString().replace(/\s+/g, ' ').trim();
    if (!text || text.length > 5000) return hideAll();
    if (!selectionPointerPending && selectionPointerText && selectionPointerText !== text) selectionPointer = null;
    selectionPointerPending = false;
    selectionPointerText = text;
    const range = inputSelection ? null : contentEditableSelection?.range || selection.getRangeAt(0);
    const rect = inputSelection ? inputSelection.rect : contentEditableSelection?.rect || getSelectionRect(range);
    if (!rect || (!rect.width && !rect.height)) return hideAll();
    selectedText = text;
    selectedRange = range ? range.cloneRange() : null;
    selectedInput = editableSelection?.input || editableSelection?.element || null;
    selectedInputStart = inputSelection ? selectedInput.selectionStart : 0;
    selectedInputEnd = inputSelection ? selectedInput.selectionEnd : 0;
    anchorRect = rect;
    contextAnchor = null;
    panelManuallyMoved = false;
    trigger.classList.toggle('disabled', !settings.enabled);
    queryInput.value = text;
    resizeQueryInput();
    positionTrigger(rect);
    trigger.classList.add('visible');
    if (!panelOpen) panel.classList.remove('visible');
  }

  function scheduleSelectionDisplay() {
    if (selectionShowTimer) window.clearTimeout(selectionShowTimer);
    const delay = Math.max(0, Math.min(2000, Number(settings.selectionTriggerDelay) || 0));
    selectionShowTimer = window.setTimeout(() => {
      selectionShowTimer = null;
      requestAnimationFrame(showForSelection);
    }, delay);
  }

  function openPanel() {
    cancelTriggerHoverOpen();
    if (!selectedText || !settings.enabled) return;
    panelOpen = true;
    trigger.setAttribute('aria-expanded', 'true');
    queryInput.value = selectedText;
    resizeQueryInput();
    renderEngines();
    positionPanel();
    panel.classList.add('visible');
    requestAnimationFrame(() => {
      queryInput.focus({ preventScroll: true });
      queryInput.select();
      restoreSelectedRange();
    });
  }

  function getSelectionTriggerMode() {
    return selectedInput ? settings.editableTriggerMode : settings.triggerMode;
  }

  function restoreSelectedRange() {
    if (selectedInput?.isConnected && typeof selectedInput.setSelectionRange === 'function') {
      try { selectedInput.setSelectionRange(selectedInputStart, selectedInputEnd); } catch { /* input may have changed */ }
    }
    if (!selectedRange || !selectedRange.startContainer?.isConnected) return;
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    selection.addRange(selectedRange.cloneRange());
  }

  function snapshotRect(rect) {
    if (!rect) return null;
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
  }

  function contextLink(target) {
    return target instanceof Element ? target.closest('a[href]') : null;
  }

  function getContextLinkText(link) {
    if (!link) return '';
    return String(link.getAttribute('title') || link.getAttribute('aria-label') || link.textContent || link.href || '').replace(/\s+/g, ' ').trim().slice(0, 5000);
  }

  function openContextSearch(message) {
    if (!settings.enabled) return;
    if (selectionShowTimer) { window.clearTimeout(selectionShowTimer); selectionShowTimer = null; }
    const state = contextMenuState;
    const text = state?.isLink ? state.linkText || message.linkUrl || '' : message.selectionText || state?.selectionText || '';
    const rect = state?.rect || null;
    if (!text && !rect && !state) return;
    selectedText = text;
    selectedRange = state?.range?.cloneRange?.() || null;
    selectedInput = null;
    anchorRect = rect || { left: state?.x ?? 10, right: state?.x ?? 10, top: state?.y ?? 10, bottom: state?.y ?? 10, width: 0, height: 0 };
    contextAnchor = rect || { left: anchorRect.left, right: anchorRect.right, top: anchorRect.top, bottom: anchorRect.bottom, width: 0, height: 0 };
    selectionPointer = null;
    selectionPointerText = '';
    panelManuallyMoved = false;
    trigger.classList.remove('visible');
    trigger.setAttribute('aria-expanded', 'false');
    panelOpen = true;
    queryInput.value = text;
    resizeQueryInput();
    renderEngines();
    panel.classList.add('visible');
    requestAnimationFrame(() => { positionPanel(); queryInput.focus({ preventScroll: true }); queryInput.select(); restoreSelectedRange(); });
    contextMenuState = null;
  }

  trigger.addEventListener('pointerdown', (event) => event.preventDefault());
  panelDragHandle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    panelDragHandle.setPointerCapture(event.pointerId);
    const rect = panel.getBoundingClientRect();
    panelDragState = { pointerId: event.pointerId, offsetX: startX - rect.left, offsetY: startY - rect.top, frame: 0, latestX: startX, latestY: startY };
    panel.classList.add('dragging');
  });
  panelDragHandle.addEventListener('pointermove', (event) => {
    if (!panelDragState || panelDragState.pointerId !== event.pointerId) return;
    panelDragState.latestX = event.clientX;
    panelDragState.latestY = event.clientY;
    if (panelDragState.frame) return;
    panelDragState.frame = requestAnimationFrame(() => {
      panelDragState.frame = 0;
      if (!panelDragState) return;
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const left = Math.max(10, Math.min(window.innerWidth - width - 10, panelDragState.latestX - panelDragState.offsetX));
      const top = Math.max(10, Math.min(window.innerHeight - height - 10, panelDragState.latestY - panelDragState.offsetY));
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panelManuallyMoved = true;
      positionGroupEngineList();
    });
  });
  function finishPanelDrag(event) {
    if (event && panelDragState && panelDragState.pointerId === event.pointerId && panelDragHandle.hasPointerCapture(event.pointerId)) panelDragHandle.releasePointerCapture(event.pointerId);
    if (panelDragState?.frame) cancelAnimationFrame(panelDragState.frame);
    if (panelDragTimer) window.clearTimeout(panelDragTimer);
    panelDragTimer = null;
    panelDragState = null;
    panel.classList.remove('dragging');
  }
  panelDragHandle.addEventListener('pointerup', finishPanelDrag);
  panelDragHandle.addEventListener('pointercancel', finishPanelDrag);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (panelOpen || trigger.classList.contains('visible')) {
      event.preventDefault();
      hideAll();
    }
  }, true);
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === 'get-selection') {
        sendResponse({ text: getInputSelection()?.text || window.getSelection()?.toString().replace(/\s+/g, ' ').trim() || '' });
        return;
      }
      if (message?.type === 'open-context-search') openContextSearch(message);
    });
  }
  function cancelTriggerHoverOpen() {
    if (!triggerHoverTimer) return;
    window.clearTimeout(triggerHoverTimer);
    triggerHoverTimer = null;
  }
  function scheduleTriggerHoverOpen() {
    cancelTriggerHoverOpen();
    if (!settings.enabled || getSelectionTriggerMode() !== 'hover' || panelOpen) return;
    triggerHoverTimer = window.setTimeout(() => {
      triggerHoverTimer = null;
      if (settings.enabled && getSelectionTriggerMode() === 'hover' && trigger.matches(':hover')) openPanel();
    }, TRIGGER_HOVER_OPEN_DELAY);
  }
  trigger.addEventListener('pointerenter', (event) => {
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX || event.clientY)) selectionPointer = { x: event.clientX, y: event.clientY };
    scheduleTriggerHoverOpen();
  });
  trigger.addEventListener('pointerleave', cancelTriggerHoverOpen);
  trigger.addEventListener('click', (event) => {
    if (!settings.enabled) return;
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY) && (event.clientX || event.clientY)) selectionPointer = { x: event.clientX, y: event.clientY };
    const triggerMode = getSelectionTriggerMode();
    if (triggerMode === 'none') return hideAll();
    if (triggerMode === 'hover') { cancelTriggerHoverOpen(); return openPanel(); }
    panelOpen = !panelOpen;
    trigger.setAttribute('aria-expanded', String(panelOpen));
    if (panelOpen) return openPanel();
    panel.classList.toggle('visible', panelOpen);
  });
  queryInput.addEventListener('input', () => { selectedText = queryInput.value; resizeQueryInput(); if (panelOpen && anchorRect) requestAnimationFrame(() => { positionPanel(); positionGroupEngineList(); }); });
  queryExpand.addEventListener('click', () => {
    const expandedInput = !queryRow.classList.contains('expanded');
    queryRow.classList.toggle('expanded', expandedInput);
    queryExpand.setAttribute('aria-expanded', String(expandedInput));
    queryExpand.setAttribute('aria-label', expandedInput ? '收起多行输入' : '展开多行输入');
    queryExpand.title = expandedInput ? '收起多行输入' : '展开多行输入';
    resizeQueryInput();
    queryInput.focus();
    if (panelOpen && anchorRect) requestAnimationFrame(() => {
      positionPanel(anchorRect, { left: parseFloat(trigger.style.left) || 0 });
      positionGroupEngineList();
    });
  });
  document.addEventListener('input', (event) => {
    const site = getPinnedSite();
    if (!site || !pinnedHost) return;
    if (site.selectorConfigured !== false && event.target === findVisibleInput(site.selector)) syncPinnedQuery(site);
  }, true);
  document.addEventListener('mouseup', (event) => {
    mouseButtonDown = false;
    if (eventInsideOverlay(event)) return;
    selectionPointer = { x: event.clientX, y: event.clientY };
    selectionPointerPending = true;
    scheduleSelectionDisplay();
  }, true);
  document.addEventListener('touchend', (event) => {
    if (eventInsideOverlay(event)) return;
    const point = event.changedTouches?.[0];
    selectionPointer = point ? { x: point.clientX, y: point.clientY } : null;
    selectionPointerPending = Boolean(point);
    scheduleSelectionDisplay();
  }, true);
  let contextMenuState = null;
  document.addEventListener('contextmenu', (event) => {
    if (eventInsideOverlay(event)) return;
    const link = contextLink(event.target);
    const selection = window.getSelection();
    const selectionText = selection && !selection.isCollapsed ? selection.toString().replace(/\s+/g, ' ').trim() : '';
    const range = !link && selection && !selection.isCollapsed ? selection.getRangeAt(0).cloneRange() : null;
    const rect = link ? snapshotRect(link.getBoundingClientRect()) : range ? snapshotRect(getSelectionRect(range)) : null;
    contextMenuState = { x: event.clientX, y: event.clientY, linkText: getContextLinkText(link), isLink: Boolean(link), selectionText, rect, range };
  }, true);
  document.addEventListener('selectionchange', () => {
    if (shadow.activeElement) return;
    if (panelOpen) return;
    if (mouseButtonDown) return;
    scheduleSelectionDisplay();
  });
  document.addEventListener('mousedown', (event) => {
    mouseButtonDown = true;
    if (!eventInsideOverlay(event)) hideAll();
  }, true);
  window.addEventListener('blur', () => { mouseButtonDown = false; });
  window.addEventListener('resize', () => {
    refreshSelectionPosition(false);
  });
  function refreshSelectionPosition(preserveHorizontal = true) {
    positionPinnedBar(getPinnedSite());
    if (anchorRect && selectedText) {
      let rect = null;
      if (selectedRange && selectedRange.startContainer?.isConnected) {
        rect = getSelectionRect(selectedRange);
      } else if (selectedInput && selectedInput.isConnected && typeof selectedInput.selectionStart === 'number') {
        rect = getInputSelectionRect(selectedInput, selectedInputStart, selectedInputEnd);
      } else {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) rect = getSelectionRect(selection.getRangeAt(0));
      }
      if (rect) {
        if (preserveHorizontal && anchorRect) rect = { ...rect, left: anchorRect.left, right: anchorRect.right, width: anchorRect.width };
        anchorRect = rect;
        if (contextAnchor && selectedRange) contextAnchor = { ...contextAnchor, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        // Once the page moves, anchor the panel to the live selection instead of
        // the original mouse-up point, which is no longer in the same viewport spot.
        selectionPointer = null;
        const triggerPosition = positionTrigger(anchorRect);
        if (panelOpen) { positionPanel(anchorRect, triggerPosition); positionGroupEngineList(); }
        if (panelOpen) restoreSelectedRange();
      }
    }
  }
  window.addEventListener('scroll', refreshSelectionPosition, { passive: true });
  document.addEventListener('scroll', refreshSelectionPosition, true);

  function tryPrefillDoubao() {
    if (!/doubao\.com$/i.test(location.hostname)) return;
    const query = new URLSearchParams(location.search).get('quickfind');
    if (!query) return;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      const input = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
      if (!input) { if (attempts > 30) window.clearInterval(timer); return; }
      if (input.matches('[contenteditable="true"]')) input.textContent = query;
      else { const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value'); if (descriptor?.set) descriptor.set.call(input, query); else input.value = query; }
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: query }));
      input.focus();
      if (attempts > 8) { window.clearInterval(timer); history.replaceState(null, '', `${location.pathname}${location.hash}`); }
    }, 400);
  }
  document.documentElement.append(host);
  loadSettings();
  const pinnedObserver = new MutationObserver(schedulePinnedMount);
  pinnedObserver.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', schedulePinnedMount);
  schedulePinnedMount();
  tryPrefillDoubao();
  },
});
