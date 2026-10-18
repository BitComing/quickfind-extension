export default defineBackground(() => {
  const CONTEXT_MENU_ID = 'quickfind-context-search';
  const POPUP_CACHE_KEY = 'quickfind-popup-cache';
  /**
   * LLM 请求的超时上限。取 60 秒：比多数网关的首字节时间宽裕，又不至于让用户
   * 对着「正在思考…」等到失去耐心——超时后会显示明确原因。
   */
  const LLM_TIMEOUT_MS = 60000;
  let popupCacheTimer: ReturnType<typeof setTimeout> | null = null;

  /** 把 fetch 的各类失败翻成用户能看懂的一句话。终止信号要单独说，否则会显示 "signal is aborted"。 */
  function describeLlmError(error: unknown): string {
    const name = (error as { name?: string } | null)?.name;
    if (name === 'AbortError' || name === 'TimeoutError') {
      return `请求超时（超过 ${Math.round(LLM_TIMEOUT_MS / 1000)} 秒未响应）。`;
    }
    const message = (error as { message?: string } | null)?.message;
    return message || '无法连接到 API。';
  }

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
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    // 超时兜底。没有它时，网络挂起（不是拒绝）会让这一侧的 Promise 永不 settle，
    // 内容脚本的 llmRequestInFlight 一直为 true，会话就卡在「正在思考…」且没有任何提示。
    // 用 AbortController 触发后走下面的 catch，把原因交给调用方显示。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    fetch(requestEndpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages, temperature: 0.7, stream: false }),
      signal: controller.signal
    }).then(async (response) => {
      let payload: any = null;
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
      sendResponse({ ok: false, error: describeLlmError(error) });
    }).finally(() => clearTimeout(timer));
    return true;
  });
});
