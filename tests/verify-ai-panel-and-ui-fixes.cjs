/**
 * 本轮四项改动回归（多为 UI 契约，不需外网）。
 *
 * 逐条对上用户提的四点，每条都对应一种真实的坏法：
 *   1. 头部图标糊化：置顶/历史按钮的 svg 缺少尺寸与描边规则时，会以默认 300×150 横铺，
 *      被 28×28 的按钮裁成一角。判据是**渲染尺寸与可见性**，不是「写了 CSS」。
 *   2. 历史会话要有删除入口：删除走两步（上膛 → 确认），删完会话从列表消失，
 *      且正开着这段会话的窗口要一起关掉（否则再发一条又把会话写回来）。
 *   3. 选中文字按原始分行进入搜索框：多段选区进浮层后仍带换行，单行控件仍压平。
 *   4. 扩展弹窗要有 AI 对话入口：图标能开出对话视图，列出历史、能起新对话、
 *      能真的发一条消息并渲染出回复（打到本地假服务）。
 *
 * 产出物是真实构建目录，操作走真实鼠标/键盘与真实 DOM。
 */

const http = require('http');
const { createChecker, launchWithExtension } = require('./helpers.cjs');
const { check, summary } = createChecker();

const PANEL_HOST = '#quickfind-shadow-host';

/** 假 LLM 服务：回一段带 Markdown 的答复，并记下收到的请求。 */
function startLlmStub() {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body || '{}'); } catch { /* 非 JSON 也照常回 */ }
      calls.push(parsed);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '# 答复\n\n- 要点一\n- 要点二\n\n**加粗** 与 `代码`\n\n<script>alert(1)</script>' } }],
        usage: {},
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions` }));
  });
}

const PAGE = '<!doctype html><meta charset="utf-8"><title>qf fixes</title><body style="font:16px sans-serif">'
  + '<p id="multi" style="width:420px;line-height:1.9">第一段内容，用来产生多段选区。</p>'
  + '<p id="second" style="width:420px;line-height:1.9">第二段内容，与上一段之间隔着段落边界。</p></body>';

/** 读对话窗口里头部按钮的渲染尺寸与可见性——「糊了」必须量出来，不能凭 CSS 文本判断。 */
const headerButtons = (page) => page.evaluate((selector) => {
  const root = document.querySelector(selector)?.shadowRoot;
  const dialog = root?.querySelector('.llm-chat-dialog');
  if (!dialog) return null;
  return Array.from(dialog.querySelectorAll('.llm-chat-head button')).map((button) => {
    const svg = button.querySelector('svg');
    const rect = svg ? svg.getBoundingClientRect() : null;
    const style = svg ? getComputedStyle(svg) : null;
    return {
      className: button.className,
      svgWidth: rect ? Math.round(rect.width) : null,
      svgHeight: rect ? Math.round(rect.height) : null,
      stroke: style ? style.strokeWidth : null,
      fill: style ? style.fill : null,
      // 图标必须收在按钮里，横铺出去就是被裁糊的那一版。
      withinButton: rect && button.getBoundingClientRect().width >= rect.width,
    };
  });
}, PANEL_HOST);

(async () => {
  const stub = await startLlmStub();
  const env = await launchWithExtension();
  try {
    const optionsPage = await env.openOptionsPage();

    // ---------- 【3】多段选区保留分行 ----------
    console.log('【3】选中文字按原始分行、分段进入搜索框');
    await optionsPage.evaluate((endpoint) => new Promise((resolve) => chrome.storage.sync.set({
      sources: [{ id: 'google', name: '谷歌', mark: 'G', className: 'google', url: 'https://www.google.com/search?q={query}', enabled: true, iconOnly: false }],
      groups: [{ id: 'default', name: '默认组', items: ['google', 'action:ask-ai'], visible: true }],
      triggerMode: 'click', editableTriggerMode: 'none', selectionTriggerDelay: 0, defaultGroupCount: 20,
      searchHistory: [], llmDockVisible: false,
      llm: { enabled: true, endpoint, model: 'stub-model', apiKey: '', systemPrompt: '' },
      pinnedSearch: { sites: [], customSites: [], defaultGroupCount: 4, collapseDelay: 60000, openInNewTab: false, allSites: false, siteConfigVersion: 3 },
    }, resolve)), stub.endpoint);

    const baseUrl = await env.serve(PAGE);
    const page = await env.context.newPage();
    page.on('pageerror', (e) => { check(`页面抛错：${e.message}`, false); });
    await page.goto(baseUrl);
    await page.waitForSelector(PANEL_HOST, { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(800);

    // 跨两段正文产生选区：FirstChild 起点 → 第二段终点的 range，中间必然带换行。
    const selectedRaw = await page.evaluate(() => {
      const range = document.createRange();
      range.setStart(document.getElementById('multi').firstChild, 0);
      range.setEnd(document.getElementById('second').firstChild, 8);
      const s = window.getSelection();
      s.removeAllRanges(); s.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 120, clientY: 60 }));
      return s.toString();
    });
    check('选区原文确实跨段（含换行）', selectedRaw.includes('\n'), JSON.stringify(selectedRaw));
    await page.waitForTimeout(400);
    await page.locator(`${PANEL_HOST} .quickfind-trigger`).dispatchEvent('click');
    await page.waitForTimeout(350);

    const queryText = await page.evaluate((selector) => document.querySelector(selector).shadowRoot.querySelector('.query-input').value, PANEL_HOST);
    check('浮层搜索框保留了原始分行（不再压成一行）', queryText.includes('\n'), JSON.stringify(queryText));
    check('两段文字都在（没丢段落）',
      queryText.includes('第一段内容') && queryText.includes('第二段内容'), JSON.stringify(queryText));
    // 多行进框要自动展开多行外观，否则换行挤在一行行高里看不出来。
    const expanded = await page.evaluate((selector) => document.querySelector(selector).shadowRoot.querySelector('.query-row').classList.contains('expanded'), PANEL_HOST);
    check('多行内容进框时自动切到多行输入外观', expanded === true, String(expanded));
    // 行内空白仍要折叠：段落里多余的连续空格不该原样带进来。
    check('行内连续空白已折叠为单个空格', !/ {2,}/.test(queryText), JSON.stringify(queryText));
    console.log('');

    // ---------- 【1】头部图标不再糊 ----------
    console.log('【1】对话窗口头部按钮的图标有正确尺寸与描边');
    // 用「问 ai」开一个窗口，才能量到头部按钮。
    await page.evaluate((selector) => {
      const input = document.querySelector(selector).shadowRoot.querySelector('.query-input');
      input.value = '图标检查';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector(selector).shadowRoot.querySelector('.engine.special-ask-ai').click();
    }, PANEL_HOST);
    await page.waitForTimeout(1200);
    const buttons = await headerButtons(page);
    check('量到了头部按钮', Array.isArray(buttons) && buttons.length >= 4, JSON.stringify(buttons && buttons.length));
    for (const button of buttons || []) {
      const label = button.className.replace('llm-chat-', '') || 'button';
      check(`「${label}」图标尺寸收在按钮内（15px 档，非默认横铺）`,
        button.svgWidth !== null && button.svgWidth <= 20 && button.svgHeight <= 20 && button.withinButton === true,
        JSON.stringify(button));
      check(`「${label}」图标有描边、无填充（看得出线条）`,
        Number.parseFloat(button.stroke) > 0 && button.fill === 'none',
        JSON.stringify({ stroke: button.stroke, fill: button.fill }));
    }
    console.log('');

    // ---------- 【2】历史会话删除 ----------
    console.log('【2】历史会话卡片有删除入口，两步确认');
    // 侧栏历史列表与窗口内历史视图共用同一个卡片构建器，先在这里确认侧栏那份也带删除入口。
    // 必须在删除之前看：删掉唯一的会话后侧栏就空了，卡片自然不存在。
    const sidebarCards = await page.evaluate((selector) => {
      const root = document.querySelector(selector).shadowRoot;
      const cards = Array.from(root.querySelectorAll('.llm-history-list .llm-history-card'));
      return { count: cards.length, hasDelete: cards.every((card) => Boolean(card.querySelector('.llm-card-delete'))), isDiv: cards.every((card) => card.tagName === 'DIV') };
    }, PANEL_HOST);
    check('侧栏历史卡片同样带删除按钮（共用构建器）',
      sidebarCards.count >= 1 && sidebarCards.hasDelete === true && sidebarCards.isDiv === true, JSON.stringify(sidebarCards));

    // 先把历史视图打开（窗口内）。
    const historyOpen = await page.evaluate((selector) => {
      const dialog = document.querySelector(selector).shadowRoot.querySelector('.llm-chat-dialog');
      dialog.querySelector('.llm-chat-history-btn').click();
      return true;
    }, PANEL_HOST);
    check('切到历史视图', historyOpen === true, String(historyOpen));
    await page.waitForTimeout(400);

    // 逐个按钮读属性并即时汇总：节点一旦被换掉，事后再遍历会读到已摘除的旧节点。
    const before = await page.evaluate((selector) => {
      const dialog = document.querySelector(selector).shadowRoot.querySelector('.llm-chat-dialog');
      const cards = Array.from(dialog.querySelectorAll('.llm-chat-history .llm-history-card'));
      return {
        count: cards.length,
        hasDelete: cards.every((card) => Boolean(card.querySelector('.llm-card-delete'))),
        // 卡片不能再是 button：button 不能嵌套 button，删除按钮会被浏览器拆出去。
        isDiv: cards.every((card) => card.tagName === 'DIV'),
        // 删除按钮默认必须既看不见、又不吃指针（否则点卡片会误触删除）。
        hiddenAndInert: cards.map((card) => {
          const style = getComputedStyle(card.querySelector('.llm-card-delete'));
          return style.opacity === '0' && style.pointerEvents === 'none';
        }),
      };
    }, PANEL_HOST);
    check('历史卡片上都有删除按钮', before.hasDelete === true, JSON.stringify(before));
    check('卡片本体是 div（避免 button 嵌套 button）', before.isDiv === true, String(before.isDiv));
    check('删除按钮默认收敛且不吃指针（不会误触）',
      before.hiddenAndInert.every(Boolean), JSON.stringify(before));

    // 两步确认：第一下只上膛，不改列表。
    const armed = await page.evaluate((selector) => {
      const dialog = document.querySelector(selector).shadowRoot.querySelector('.llm-chat-dialog');
      const del = dialog.querySelector('.llm-chat-history .llm-history-card .llm-card-delete');
      del.click();
      return {
        armed: del.classList.contains('is-armed'),
        label: del.textContent.trim(),
        count: dialog.querySelectorAll('.llm-chat-history .llm-history-card').length,
      };
    }, PANEL_HOST);
    check('第一下只「上膛」，文案变为确认删除', armed.armed === true && armed.label === '确认删除', JSON.stringify(armed));
    check('上膛后尚未真的删除', armed.count === before.count, `${before.count} → ${armed.count}`);

    // 第二下真删。注意要读**活动 DOM**：被删的正是当前窗口打开的那段会话，
    // 删除会把它连同窗口一起收掉——继续读那个已经摘除的 dialog 只会拿到旧节点，
    // 看起来像「没删掉」（第一版就踩了这个假阴性）。
    const afterDelete = await page.evaluate((selector) => {
      const root = document.querySelector(selector).shadowRoot;
      root.querySelector('.llm-chat-dialog .llm-chat-history .llm-history-card .llm-card-delete').click();
      return {
        dialogs: root.querySelectorAll('.llm-chat-dialog').length,
        sidebarCards: root.querySelectorAll('.llm-history-list .llm-history-card').length,
      };
    }, PANEL_HOST);
    await page.waitForTimeout(500);
    check('确认后该会话从列表消失', afterDelete.sidebarCards === before.count - 1, `${before.count} → ${afterDelete.sidebarCards}`);
    check('正开着这段会话的窗口一并关闭（否则再发一条又会写回来）',
      afterDelete.dialogs === 0, `dialogs=${afterDelete.dialogs}`);

    const afterDeleteSettled = await page.evaluate((selector) => {
      const root = document.querySelector(selector).shadowRoot;
      const layer = root.querySelector('.llm-chat-layer');
      return {
        sidebarCards: root.querySelectorAll('.llm-history-list .llm-history-card').length,
        layerHidden: layer ? layer.hidden : null,
        dockHidden: root.querySelector('.llm-dock')?.hidden ?? null,
      };
    }, PANEL_HOST);
    check('删除后侧栏历史同样清空（同一份数据）', afterDeleteSettled.sidebarCards === 0, JSON.stringify(afterDeleteSettled));
    check('没有窗口后对话层与宿主一并收起', afterDeleteSettled.layerHidden === true && afterDeleteSettled.dockHidden === true, JSON.stringify(afterDeleteSettled));

    // 存储里也要真的少一条：刷新页面后不该又冒出来。
    const storedCount = await optionsPage.evaluate(() => new Promise((resolve) => {
      chrome.storage.local.get('quickfind-llm-conversations', (stored) => resolve((stored?.['quickfind-llm-conversations'] || []).length));
    }));
    check('删除已落盘（本地存储里不再有这段会话）', storedCount === 0, String(storedCount));
    console.log('');

    await page.close();

    // ---------- 【4】弹窗 AI 入口：交给网页侧 ----------
    console.log('【4】扩展弹窗的 AI 对话入口（在网页中弹窗，不在弹窗里渲染面板）');
    const target2 = await env.context.newPage();
    await target2.goto(baseUrl);
    await target2.waitForSelector(PANEL_HOST, { state: 'attached', timeout: 10000 });
    await target2.waitForTimeout(800);

    const popup = await env.context.newPage();
    popup.on('pageerror', (e) => { check(`弹窗抛错：${e.message}`, false); });
    await popup.goto(`chrome-extension://${env.extId}/popup.html`);
    await popup.waitForTimeout(1000);
    // 弹窗一打开就是活动标签页；把被测页切回前台（「问 ai」按 active 标签页转交），
    // 之后只对弹窗做 fill/evaluate，不会改变活动标签页。
    await target2.bringToFront();
    await popup.waitForTimeout(200);

    const entry = await popup.evaluate(() => {
      const toggle = document.querySelector('#ai-toggle');
      const svg = toggle?.querySelector('svg');
      const rect = svg?.getBoundingClientRect();
      return {
        hasToggle: Boolean(toggle),
        title: toggle?.getAttribute('title') ?? null,
        // 面板已按用户要求移除：只留入口，UI 只有页面侧那一套。
        hasPanel: Boolean(document.querySelector('#ai-panel')),
        iconWidth: rect ? Math.round(rect.width) : null,
        iconHeight: rect ? Math.round(rect.height) : null,
      };
    });
    check('弹窗头部有 AI 对话入口图标', entry.hasToggle === true, JSON.stringify(entry));
    check('入口提示写明是在网页中打开', entry.title === '在网页中打开 AI 对话', String(entry.title));
    check('入口图标有正常尺寸', entry.iconWidth !== null && entry.iconWidth <= 20 && entry.iconHeight <= 20, JSON.stringify(entry));
    check('弹窗内不再有自渲染的 AI 面板', entry.hasPanel === false, String(entry.hasPanel));

    // 点入口：应在**网页里**弹出一个对话窗口，且**默认不发送任何消息**——
    // 头部按钮的语义是「打开 AI 聊天」，发送什么由用户在窗口里自己决定。
    // （搜索内容 -> 提问是「问 ai」按钮行的语义，用搜索框预填反而会让两枚按钮混为一谈。）
    const beforeCalls = stub.calls.length;
    await popup.fill('#query-input', '这段内容不该被自动发出');
    await popup.evaluate(() => document.querySelector('#ai-toggle').click());
    await target2.waitForTimeout(1600);

    const handedOff = await target2.evaluate((host) => {
      const root = document.querySelector(host)?.shadowRoot;
      const layer = root?.querySelector('.llm-chat-layer');
      const dialog = root?.querySelector('.llm-chat-dialog');
      return {
        layerHidden: layer ? layer.hidden : null,
        dialogs: root ? root.querySelectorAll('.llm-chat-dialog').length : 0,
        bubbles: dialog ? Array.from(dialog.querySelectorAll('.llm-message-bubble')).map((n) => n.textContent.trim().slice(0, 30)) : [],
        emptyHint: dialog ? Boolean(dialog.querySelector('.llm-chat-empty, .llm-empty')) : null,
        composeValue: dialog?.querySelector('.llm-chat-input, textarea')?.value ?? null,
      };
    }, PANEL_HOST);
    check('点入口在网页中弹出对话窗口', handedOff.layerHidden === false && handedOff.dialogs >= 1, JSON.stringify(handedOff));
    check('对话是空白的（没有任何消息气泡）', handedOff.bubbles.length === 0, JSON.stringify(handedOff.bubbles));
    check('没有因为点开窗口就发起请求', stub.calls.length === beforeCalls, `${beforeCalls} → ${stub.calls.length}`);
    check('搜索框内容没有被带进对话', !handedOff.bubbles.some((t) => t.includes('这段内容不该被自动发出')), JSON.stringify(handedOff.bubbles));
    check('转交后弹窗自动关闭', popup.isClosed() === true, String(popup.isClosed()));

    await popup.close().catch(() => { /* 已自行关闭 */ });
    await target2.close();
    console.log('');

    return summary();
  } finally {
    await env.close();
    await new Promise((resolve) => stub.server.close(resolve));
  }
})().then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(2); });