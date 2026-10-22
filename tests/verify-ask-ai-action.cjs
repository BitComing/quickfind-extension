/**
 * 特殊功能按钮「问 ai」的行为契约（自包含，不依赖 git HEAD）。
 *
 * 按钮的落点是把搜索内容作为首个问题，弹出现成的对话层；接着能在同一面板里继续追问。
 * 这里守住四件事，每一条都对应一种真实的坏法：
 *   一、三种入口都要认识这枚按钮（浮层 / 常驻栏 / 弹窗）。少一处会在那个入口被 normalize
 *       当成无效条目丢掉，用户下次在那个入口拖动排序就会把按钮从配置里抹掉。
 *   二、点它必须弹出对话层，并把内容作为首个问题发出去。核心是「面板独立于右侧栏」——
 *       选项页关掉「随心问」时，早期的 setLlmDockOpen 闸门会把面板挡回去，表现为点了没反应。
 *   三、面板要能继续提问（追问输入框 + 发送）。
 *   四、关掉面板后宿主必须退出 top layer：宿主是透明整屏层，留在 top layer 会挡住页面控件，
 *       而这种缺陷在正常截图里完全看不出来（同 verify-top-layer.cjs 的判据）。
 *
 * LLM 请求打到本地假服务，避免依赖外网。
 */

const http = require('http');
const { createChecker, launchWithExtension } = require('./helpers.cjs');
const { check, summary } = createChecker();

const PANEL_HOST = '#quickfind-shadow-host';
const PINNED_HOST = '#quickfind-pinned-search-host';
const QUESTION = '为什么天空是蓝色的';

/** 假 LLM 服务：回一句可辨识的答复，并记下收到的提问。 */
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
        choices: [{ message: { role: 'assistant', content: `答复 #${calls.length}` } }],
        usage: {},
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions` }));
  });
}

const PAGE = '<!doctype html><meta charset="utf-8"><title>qf ask ai</title>'
  + '<body style="font:16px sans-serif"><p id="text" style="width:420px;line-height:1.9">'
  + '这段话用来产生选区，点「问 ai」后应当进入对话面板。</p>'
  + '<form onsubmit="return false"><input name="q" style="width:280px"></form></body>';

/** 读对话层的状态：开关、标题、气泡文本、面板是否侧栏专属。 */
const readChat = (page) => page.evaluate((selector) => {
  const root = document.querySelector(selector)?.shadowRoot;
  if (!root) return null;
  const layer = root.querySelector('.llm-chat-layer');
  const dock = root.querySelector('.llm-dock');
  return {
    layerHidden: layer ? layer.hidden : null,
    dockHidden: dock ? dock.hidden : null,
    chatOnly: dock ? dock.classList.contains('is-chat-only') : null,
    title: root.querySelector('.llm-chat-title')?.textContent ?? null,
    bubbles: Array.from(root.querySelectorAll('.llm-chat-scroll .llm-message-bubble')).map((b) => b.textContent.trim()),
  };
}, PANEL_HOST);

/** 宿主是否占着 top layer —— 浏览器对这件事的真实回答，不是我们自己记的标志位。 */
const hostPopover = (page) => page.evaluate((selector) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  try { return el.matches(':popover-open'); } catch { return 'unsupported'; }
}, PANEL_HOST);

(async () => {
  const stub = await startLlmStub();
  const env = await launchWithExtension();
  try {
    const optionsPage = await env.openOptionsPage();

    // 预置：默认组里放「问 ai」，关掉右侧「随心问」面板（这正是最容易被闸门挡住的配置）。
    await optionsPage.evaluate((endpoint) => new Promise((resolve) => chrome.storage.sync.set({
      sources: [{ id: 'google', name: '谷歌', mark: 'G', className: 'google', url: 'https://www.google.com/search?q={query}', enabled: true, iconOnly: false }],
      groups: [{ id: 'default', name: '默认组', items: ['google', 'action:ask-ai'], visible: true }],
      triggerMode: 'click',
      editableTriggerMode: 'none',
      selectionTriggerDelay: 0,
      defaultGroupCount: 20,
      searchHistory: [],
      llmDockVisible: false,
      llm: { enabled: true, endpoint, model: 'stub-model', apiKey: '', systemPrompt: '' },
      pinnedSearch: { sites: [], customSites: [], defaultGroupCount: 4, collapseDelay: 60000, openInNewTab: false, allSites: true, siteConfigVersion: 3 },
    }, resolve)), stub.endpoint);

    const baseUrl = await env.serve(PAGE);

    // ---------- 一. 三个入口都出现这枚按钮 ----------
    console.log('【一】三个入口都认识「问 ai」');
    const page = await env.context.newPage();
    page.on('pageerror', (e) => { check(`页面抛错：${e.message}`, false); });
    await page.goto(baseUrl);
    await page.waitForSelector(PANEL_HOST, { state: 'attached', timeout: 10000 });
    await page.waitForSelector(PINNED_HOST, { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(700);

    // 选中文字 → 打开浮层，确认按钮在。
    // 用程序化选区：无头模式下按下-拖动往往不产生真实选区（同 verify-top-layer.cjs 的做法）。
    await page.evaluate(() => {
      const node = document.getElementById('text').firstChild;
      const range = document.createRange();
      range.setStart(node, 0);
      range.setEnd(node, 10);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 220, clientY: 100 }));
    });
    await page.waitForTimeout(500);
    await page.locator(`${PANEL_HOST} .quickfind-trigger`).dispatchEvent('click');
    await page.waitForTimeout(300);
    const panelBtn = await page.evaluate((selector) => {
      const root = document.querySelector(selector).shadowRoot;
      const btn = root.querySelector('.engine.special-ask-ai');
      return { exists: Boolean(btn), title: btn ? btn.title : null, mark: btn ? btn.querySelector('.engine-mark').textContent : null };
    }, PANEL_HOST);
    check('浮层里出现「问 ai」按钮', panelBtn.exists === true, JSON.stringify(panelBtn));
    check('按钮提示=向 AI 提问、图标=AI', panelBtn.title === '向 AI 提问' && panelBtn.mark === 'AI', JSON.stringify(panelBtn));

    const pinnedBtn = await page.evaluate((selector) => Boolean(document.querySelector(selector)?.shadowRoot?.querySelector('.entries .entry.special-ask-ai')), PINNED_HOST);
    check('常驻栏里出现「问 ai」按钮', pinnedBtn === true, String(pinnedBtn));

    const popupPage = await env.context.newPage();
    await popupPage.goto(`chrome-extension://${env.extId}/popup.html`);
    await popupPage.waitForTimeout(800);
    const popupBtn = await popupPage.evaluate(() => Boolean(document.querySelector('.engine-row[title="向 AI 提问"]')));
    check('弹窗里出现「问 ai」按钮行', popupBtn === true, String(popupBtn));
    await popupPage.close();
    console.log('');

    // ---------- 二. 点它 → 弹出对话层，内容成为首个问题 ----------
    console.log('【二】面板独立于右侧栏，且把内容作为首个问题发出去');
    // 把浮层搜索框里的内容换成一句明确的问题，便于逐步断言。
    await page.evaluate((payload) => {
      const input = document.querySelector(payload.selector).shadowRoot.querySelector('.query-input');
      input.value = payload.question;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, { selector: PANEL_HOST, question: QUESTION });
    await page.waitForTimeout(200);
    const before = await readChat(page);
    check('点之前对话层是关的、宿主未占用', before.layerHidden === true && before.dockHidden === true, JSON.stringify(before));

    await page.locator(`${PANEL_HOST} .engine.special-ask-ai`).dispatchEvent('click');
    await page.waitForTimeout(1200);
    const after = await readChat(page);
    check('对话层已弹出（关掉右侧栏也能弹）', after.layerHidden === false && after.dockHidden === false, JSON.stringify(after));
    check('面板处于「仅对话」模式（不显示滑杆与侧栏）', after.chatOnly === true, JSON.stringify(after));
    check('标题 = 搜索框里的问题', after.title === QUESTION, JSON.stringify(after.title));
    check('问题作为用户气泡发出', after.bubbles[0] === QUESTION, JSON.stringify(after.bubbles));
    check('收到助手答复', after.bubbles.some((t) => /答复 #\d/.test(t)), JSON.stringify(after.bubbles));
    check('请求确实带着这个问题打到模型', Array.isArray(stub.calls[0]?.messages) && stub.calls[0].messages.some((m) => m.content === QUESTION), JSON.stringify(stub.calls[0]?.messages));
    console.log('');

    // ---------- 三. 同一面板里继续追问 ----------
    console.log('【三】在面板里继续提问');
    const before2 = stub.calls.length;
    await page.evaluate((selector) => {
      const root = document.querySelector(selector).shadowRoot;
      const input = root.querySelector('.llm-chat-input');
      input.value = '再展开讲讲';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      root.querySelector('.llm-chat-compose').requestSubmit();
    }, PANEL_HOST);
    await page.waitForTimeout(1200);
    const asked = await readChat(page);
    check('追问发出，气泡数增加', asked.bubbles.includes('再展开讲讲'), JSON.stringify(asked.bubbles));
    check('追问也带上了上下文（多打了一次请求）', stub.calls.length === before2 + 1, `${before2} → ${stub.calls.length}`);
    check('第二轮请求带上了首轮问答', Array.isArray(stub.calls[stub.calls.length - 1]?.messages)
      && stub.calls[stub.calls.length - 1].messages.length >= 3, JSON.stringify(stub.calls[stub.calls.length - 1]?.messages?.length));
    console.log('');

    // ---------- 四. 收起后面板必须退出 top layer ----------
    console.log('【四】收起面板 → 宿主退出 top layer');
    const openPopover = await hostPopover(page);
    check('面板开着时宿主占着 top layer', openPopover === true, String(openPopover));

    await page.locator(`${PANEL_HOST} .llm-chat-close`).dispatchEvent('click');
    await page.waitForTimeout(600);
    const closed = await readChat(page);
    check('点关闭后对话层收起', closed.layerHidden === true, JSON.stringify(closed));
    check('侧栏不可用时宿主一并隐藏', closed.dockHidden === true, JSON.stringify(closed));
    const closedPopover = await hostPopover(page);
    check('宿主退出 top layer（透明整屏层不会残留）', closedPopover === false, String(closedPopover));
    console.log('');

    await page.close();

    // ---------- 五. 弹窗入口：转交页面侧 ----------
    console.log('【五】弹窗里的「问 ai」转交给当前页面');
    const target = await env.context.newPage();
    await target.goto(baseUrl);
    await target.waitForSelector(PANEL_HOST, { state: 'attached', timeout: 10000 });
    await target.waitForTimeout(800);

    // 顺序很关键：弹窗页一打开就会成为活动标签页，而「问 ai」按 active 标签页转交。
    // 所以先把弹窗加载好，再让被测页回到前台——之后对它只做 fill/evaluate，不会改变活动标签页。
    const popup2 = await env.context.newPage();
    await popup2.goto(`chrome-extension://${env.extId}/popup.html`);
    await popup2.waitForTimeout(800);
    await target.bringToFront();
    await popup2.waitForTimeout(200);

    await popup2.fill('#query-input', '弹窗问出来的问题');
    await popup2.evaluate(() => document.querySelector('.engine-row[title="向 AI 提问"]').click());
    // 弹窗转交成功后会自动关闭（对话窗口已经在网页上打开），所以这里不能等它、
    // 也不要再对它求值：直接等页面侧的结果。
    await target.waitForTimeout(1400);
    const handedOff = await readChat(target);
    check('页面侧对话层被弹窗唤起', handedOff.layerHidden === false, JSON.stringify(handedOff));
    check('弹窗里的内容成为首个问题', handedOff.bubbles[0] === '弹窗问出来的问题', JSON.stringify(handedOff.bubbles));
    const popupGone = popup2.isClosed();
    check('转交后弹窗自动关闭（对话已在网页中打开）', popupGone === true, String(popupGone));
    await popup2.close().catch(() => { /* 已自行关闭 */ });
    await target.close();

    return summary();
  } finally {
    await env.close();
    await new Promise((resolve) => stub.server.close(resolve));
  }
})().then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(2); });