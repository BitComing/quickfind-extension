const CONTEXT_MENU_ID = 'quickfind-context-search';
const POPUP_CACHE_KEY = 'quickfind-popup-cache';
let popupCacheTimer = null;

function refreshPopupCache() {
  chrome.storage.sync.get(null, (stored) => {
    if (chrome.runtime.lastError || !chrome.storage.session) return;
    chrome.storage.session.set({ [POPUP_CACHE_KEY]: stored });
  });
}

function schedulePopupCacheRefresh() {
  if (popupCacheTimer) return;
  popupCacheTimer = setTimeout(() => {
    popupCacheTimer = null;
    refreshPopupCache();
  }, 50);
}

function ensureContextMenu() {
  chrome.contextMenus.remove(CONTEXT_MENU_ID, () => {
    void chrome.runtime.lastError;
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: '使用 QuickFind 搜索',
      contexts: ['all']
    });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureContextMenu();
  refreshPopupCache();
});

chrome.runtime.onStartup?.addListener(() => {
  ensureContextMenu();
  refreshPopupCache();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && Object.keys(changes).length) schedulePopupCacheRefresh();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, {
    type: 'open-context-search',
    selectionText: info.selectionText || '',
    linkUrl: info.linkUrl || ''
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message) return;
  if (message.type === 'open-options') chrome.runtime.openOptionsPage();
  if (message.type === 'open-search-tab' && typeof message.url === 'string') chrome.tabs.create({ url: message.url });
});

// Keep provider requests in the extension context so pages with restrictive
// CSP/CORS policies do not prevent a configured assistant from responding.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'quickfind-llm-chat') return;
  const config = message.config && typeof message.config === 'object' ? message.config : {};
  const endpoint = String(config.endpoint || '').trim();
  const apiKey = String(config.apiKey || '').trim();
  const model = String(config.model || '').trim();
  const messages = Array.isArray(message.messages) ? message.messages : [];
  if (!endpoint || !model || !messages.length) {
    sendResponse({ ok: false, error: '请先在设置中填写 API 地址和模型。' });
    return;
  }
  const requestEndpoint = /\/chat\/completions$/i.test(endpoint)
    ? endpoint
    : /\/v\d+\/?$/i.test(endpoint.replace(/\/+$/, ''))
      ? `${endpoint.replace(/\/+$/, '')}/chat/completions`
      : `${endpoint.replace(/\/+$/, '')}/v1/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  fetch(requestEndpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, messages, temperature: 0.7, stream: false })
  }).then(async (response) => {
    let payload = null;
    try { payload = await response.json(); } catch { /* retain status-based error */ }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || `请求失败（${response.status}）`;
      sendResponse({ ok: false, error: String(detail) });
      return;
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      sendResponse({ ok: false, error: '接口返回了空回复。' });
      return;
    }
    sendResponse({ ok: true, content: content.trim(), usage: payload?.usage || null });
  }).catch((error) => {
    sendResponse({ ok: false, error: error?.message || '无法连接到 API。' });
  });
  return true;
});
