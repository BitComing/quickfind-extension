/**
 * 对话窗口的行为契约（自包含）。
 *
 * 把原有的单例模态框改成多窗口面板后，这里守住六件事，每条都对应一种真实的坏法：
 *   一、同层容器不吃指针事件（无蒙版）：页面按钮照常可点、可选中——蒙版会把它挡住。
 *   二、可移动：拖标题栏改位置；拖标题栏上的按钮**不该**带动窗口。
 *   三、可缩放：拖右下角抓手改尺寸，且不小于下限。
 *   四、可置顶：置顶窗口的层级高于普通窗口，取消置顶后回落。
 *   五、可开多个：点两次「问 ai」得到两个窗口；窗口之间互不串状态（各自的请求在飞标志、
 *       各自的标题与输入框）。
 *   六、可查看历史会话：窗口里的历史入口能列出会话并切回对话。
 *   七、Markdown 渲染：助手回复里的标题/列表/代码块被排成对应标签，且**原始 HTML 不穿透**。
 *
 * 几何持久化（位置/大小/置顶跨刷新）单独在最后一段验。
 */

const http = require('http');
const { createChecker, launchWithExtension } = require('./helpers.cjs');
const { check, summary } = createChecker();

const PANEL_HOST = '#quickfind-shadow-host';

function startLlmStub() {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body || '{}'); } catch { /* 非 JSON 也照常回 */ }
      calls.push(parsed);
      const last = parsed?.messages?.[parsed.messages.length - 1]?.content || '';
      // 首轮回一段 Markdown（含标题/列表/代码块/裸 HTML），第二轮回固定短句便于区分窗口。
      const content = calls.length === 1
        ? '# 标题\n\n- 第一项\n- 第二项\n\n```js\nconst a = 1;\n```\n\n<script>alert(1)</script>\n\n**加粗** 与 `代码`'
        : `答复 #${calls.length}：${String(last).slice(0, 20)}`;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: {} }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, calls, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions` }));
  });
}

const PAGE = '<!doctype html><meta charset="utf-8"><title>qf windows</title>'
  + '<body style="font:16px sans-serif">'
  + '<p id="text" style="width:420px;line-height:1.9">这段话用来产生选区，点「问 ai」后应当开出对话窗口。</p>'
  + '<button id="page-btn" style="position:fixed;left:12px;bottom:12px;width:120px;height:34px">页面按钮</button>'
  + '<form onsubmit="return false"><input name="q" style="width:280px"></form></body>';

/** 读所有对话窗口的关键状态。 */
const readWindows = (page) => page.evaluate((selector) => {
  const root = document.querySelector(selector)?.shadowRoot;
  if (!root) return null;
  const layer = root.querySelector('.llm-chat-layer');
  const dialogs = Array.from(root.querySelectorAll('.llm-chat-dialog'));
  return {
    layerHidden: layer ? layer.hidden : null,
    count: dialogs.length,
    windows: dialogs.map((dialog) => {
      const rect = dialog.getBoundingClientRect();
      return {
        title: dialog.querySelector('.llm-chat-title')?.textContent ?? null,
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        z: Number(dialog.style.zIndex || 0),
        pinned: dialog.classList.contains('is-pinned'),
        // 用**计算样式的可见性**而不是 .hidden 属性判断：属性为真但类选择器里的 display
        // 压过了 UA 的 [hidden] 时，元素其实还显示着，只读属性会得到假绿（真踩过）。
        historyHidden: (dialog.querySelector('.llm-chat-history')?.offsetParent === null),
        composeHidden: (dialog.querySelector('.llm-chat-compose')?.offsetParent === null),
        chatVisible: (dialog.querySelector('.llm-chat-scroll')?.offsetParent !== null),
        bubbles: Array.from(dialog.querySelectorAll('.llm-chat-scroll .llm-message-bubble')).map((b) => b.textContent.trim()),
        html: Array.from(dialog.querySelectorAll('.llm-md')).map((n) => n.innerHTML),
        historyCards: dialog.querySelectorAll('.llm-chat-history .llm-history-card').length,
      };
    }),
  };
}, PANEL_HOST);

/** 页面按钮中心点上最上层是谁——用来证明没有蒙版拦截。 */
const pageButtonTop = (page) => page.evaluate(() => {
  const btn = document.getElementById('page-btn');
  const rect = btn.getBoundingClientRect();
  const chain = document.elementsFromPoint(Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2));
  return chain[0] ? (chain[0].id || chain[0].tagName) : null;
});

/** 走真实用户路径开一个「问 ai」窗口：选中文字 → 点触发点 → 点按钮。 */
async function askAi(page, question) {
  await page.evaluate(() => {
    const node = document.getElementById('text').firstChild;
    const range = document.createRange();
    range.setStart(node, 0); range.setEnd(node, 10);
    const selection = window.getSelection();
    selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 220, clientY: 100 }));
  });
  await page.waitForTimeout(350);
  await page.locator(`${PANEL_HOST} .quickfind-trigger`).dispatchEvent('click');
  await page.waitForTimeout(280);
  await page.evaluate((payload) => {
    const input = document.querySelector(payload.selector).shadowRoot.querySelector('.query-input');
    input.value = payload.question;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { selector: PANEL_HOST, question });
  await page.waitForTimeout(150);
  await page.locator(`${PANEL_HOST} .engine.special-ask-ai`).dispatchEvent('click');
  await page.waitForTimeout(1200);
}

(async () => {
  const stub = await startLlmStub();
  const env = await launchWithExtension();
  try {
    const optionsPage = await env.openOptionsPage();
    await optionsPage.evaluate((endpoint) => new Promise((resolve) => chrome.storage.sync.set({
      sources: [{ id: 'google', name: '谷歌', mark: 'G', className: 'google', url: 'https://www.google.com/search?q={query}', enabled: true, iconOnly: false }],
      groups: [{ id: 'default', name: '默认组', items: ['google', 'action:ask-ai'], visible: true }],
      triggerMode: 'click', editableTriggerMode: 'none', selectionTriggerDelay: 0, defaultGroupCount: 20,
      searchHistory: [], llmDockVisible: true,
      llm: { enabled: true, endpoint, model: 'stub-model', apiKey: '', systemPrompt: '' },
      pinnedSearch: { sites: [], customSites: [], defaultGroupCount: 4, collapseDelay: 60000, openInNewTab: false, allSites: false, siteConfigVersion: 3 },
    }, resolve)), stub.endpoint);

    const baseUrl = await env.serve(PAGE);
    const page = await env.context.newPage();
    page.on('pageerror', (e) => { check(`页面抛错：${e.message}`, false); });
    await page.goto(baseUrl);
    await page.waitForSelector(PANEL_HOST, { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(900);

    // ---------- 一. 无蒙版 ----------
    console.log('【一】同层容器不吃指针事件（无蒙版）');
    await askAi(page, '第一个问题');
    const opened = await readWindows(page);
    check('开出一个对话窗口', opened.count === 1, JSON.stringify({ count: opened.count }));
    check('页面按钮仍可点中（无蒙版遮挡）', (await pageButtonTop(page)) === 'page-btn', String(await pageButtonTop(page)));

    // 无蒙版还应体现在容器本身：它不吃指针，只有窗口矩形吃。
    const layerPointerEvents = await page.evaluate((selector) => {
      const layer = document.querySelector(selector)?.shadowRoot?.querySelector('.llm-chat-layer');
      const dialog = document.querySelector(selector)?.shadowRoot?.querySelector('.llm-chat-dialog');
      return {
        layer: layer ? getComputedStyle(layer).pointerEvents : null,
        dialog: dialog ? getComputedStyle(dialog).pointerEvents : null,
      };
    }, PANEL_HOST);
    check('容器 pointer-events:none、窗口 auto', layerPointerEvents.layer === 'none' && layerPointerEvents.dialog === 'auto', JSON.stringify(layerPointerEvents));

    // 容器里不得有「泄漏成文本的注释」。shadow 模板是普通模板字符串，写在里面的 `//` 行注释
    // 不会被 JS 解析掉，会变成真实文本节点；宿主是 fixed inset:0，于是那串字就渲染在页面左上角。
    const strayText = await page.evaluate((selector) => {
      const dock = document.querySelector(selector)?.shadowRoot?.querySelector('.llm-dock');
      if (!dock) return null;
      return Array.from(dock.childNodes)
        .filter((node) => node.nodeType === 3 && node.textContent.trim())
        .map((node) => node.textContent.trim());
    }, PANEL_HOST);
    check('对话容器里没有泄漏成文本的注释', Array.isArray(strayText) && strayText.length === 0, JSON.stringify(strayText));
    console.log('');

    // ---------- 二. 可移动 ----------
    console.log('【二】拖动标题栏可移动窗口');
    const beforeMove = (await readWindows(page)).windows[0];
    const head = await page.evaluate((selector) => {
      const dialog = document.querySelector(selector).shadowRoot.querySelector('.llm-chat-dialog');
      const rect = dialog.querySelector('.llm-chat-head').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, PANEL_HOST);
    await page.mouse.move(head.x, head.y);
    await page.mouse.down();
    await page.mouse.move(head.x - 120, head.y + 90, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const afterMove = (await readWindows(page)).windows[0];
    check('窗口位置随拖动改变', afterMove.left !== beforeMove.left || afterMove.top !== beforeMove.top,
      `${beforeMove.left},${beforeMove.top} → ${afterMove.left},${afterMove.top}`);

    // 拖动标题栏上的按钮不该带动窗口。
    const beforePinDrag = (await readWindows(page)).windows[0];
    const pinRect = await page.evaluate((selector) => {
      const pin = document.querySelector(selector).shadowRoot.querySelector('.llm-chat-pin');
      const rect = pin.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, PANEL_HOST);
    await page.mouse.move(pinRect.x, pinRect.y);
    await page.mouse.down();
    await page.mouse.move(pinRect.x - 70, pinRect.y + 60, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const afterPinDrag = (await readWindows(page)).windows[0];
    check('拖标题栏上的按钮不移动窗口', afterPinDrag.left === beforePinDrag.left && afterPinDrag.top === beforePinDrag.top,
      `${beforePinDrag.left},${beforePinDrag.top} → ${afterPinDrag.left},${afterPinDrag.top}`);
    console.log('');

    // ---------- 三. 可缩放 ----------
    console.log('【三】拖右下角抓手可缩放');
    const beforeResize = (await readWindows(page)).windows[0];
    const grip = await page.evaluate((selector) => {
      const gripEl = document.querySelector(selector).shadowRoot.querySelector('.llm-chat-resize');
      const rect = gripEl.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, PANEL_HOST);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x + 110, grip.y + 70, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const afterResize = (await readWindows(page)).windows[0];
    check('窗口尺寸随拖动改变', afterResize.width > beforeResize.width && afterResize.height > beforeResize.height,
      `${beforeResize.width}x${beforeResize.height} → ${afterResize.width}x${afterResize.height}`);

    // 往下限方向猛拖，尺寸不得塌掉。
    const grip2 = await page.evaluate((selector) => {
      const rect = document.querySelector(selector).shadowRoot.querySelector('.llm-chat-resize').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, PANEL_HOST);
    await page.mouse.move(grip2.x, grip2.y);
    await page.mouse.down();
    await page.mouse.move(grip2.x - 900, grip2.y - 900, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const minSize = (await readWindows(page)).windows[0];
    check('缩放下限生效（不小于 280×240）', minSize.width >= 280 && minSize.height >= 240, `${minSize.width}x${minSize.height}`);
    console.log('');

    // ---------- 四. 可置顶 ----------
    console.log('【四】置顶抬高层级');
    const zBefore = (await readWindows(page)).windows[0].z;
    await page.locator(`${PANEL_HOST} .llm-chat-pin`).dispatchEvent('click');
    await page.waitForTimeout(250);
    const pinned = (await readWindows(page)).windows[0];
    check('置顶后带 is-pinned 且层级抬升', pinned.pinned === true && pinned.z > zBefore, `z ${zBefore} → ${pinned.z}`);
    await page.locator(`${PANEL_HOST} .llm-chat-pin`).dispatchEvent('click');
    await page.waitForTimeout(250);
    const unpinned = (await readWindows(page)).windows[0];
    check('取消置顶后回落', unpinned.pinned === false && unpinned.z < pinned.z, `z ${pinned.z} → ${unpinned.z}`);
    console.log('');

    // ---------- 五. 可开多个，且互不串状态 ----------
    console.log('【五】可同时开多个窗口');
    await askAi(page, '第二个问题');
    await page.waitForTimeout(600);
    const two = await readWindows(page);
    check('两次「问 ai」得到两个窗口', two.count === 2, JSON.stringify({ count: two.count }));
    check('两个窗口标题各自对应各自的问题',
      two.windows[0].title === '第一个问题' && two.windows[1].title === '第二个问题',
      JSON.stringify(two.windows.map((w) => w.title)));
    check('新窗口与旧窗口位置错开',
      two.windows[0].left !== two.windows[1].left || two.windows[0].top !== two.windows[1].top,
      JSON.stringify(two.windows.map((w) => `${w.left},${w.top}`)));
    // 两个窗口各自一条用户气泡，说明没有互相改写内容。
    check('两个窗口各自保有自己的一条提问',
      two.windows[0].bubbles.length === 2 && two.windows[1].bubbles.length === 2,
      JSON.stringify(two.windows.map((w) => w.bubbles.length)));
    console.log('');

    // ---------- 六. 查看历史会话（独立按钮） ----------
    console.log('【六】历史是独立按钮，返回键只在历史里出现');
    const headerBefore = await page.evaluate((selector) => {
      const dialog = document.querySelector(selector).shadowRoot.querySelectorAll('.llm-chat-dialog')[0];
      return {
        hasHistoryBtn: Boolean(dialog.querySelector('.llm-chat-history-btn')),
        backHidden: dialog.querySelector('.llm-chat-back').hidden,
        historyBtnTitle: dialog.querySelector('.llm-chat-history-btn')?.title ?? null,
      };
    }, PANEL_HOST);
    check('标题栏有独立的「历史会话」按钮', headerBefore.hasHistoryBtn === true, JSON.stringify(headerBefore));
    check('对话视图下返回键是收起的（不兼作历史入口）', headerBefore.backHidden === true, String(headerBefore.backHidden));
    check('历史按钮提示文案正确', headerBefore.historyBtnTitle === '历史会话', String(headerBefore.historyBtnTitle));

    await page.evaluate((selector) => {
      const dialog = document.querySelector(selector).shadowRoot.querySelectorAll('.llm-chat-dialog')[0];
      dialog.querySelector('.llm-chat-history-btn').click();
    }, PANEL_HOST);
    await page.waitForTimeout(400);
    const historyView = (await readWindows(page)).windows[0];
    check('点独立按钮切到历史视图（对话流收起、输入区收起）',
      historyView.chatVisible === false && historyView.historyHidden === false && historyView.composeHidden === true,
      JSON.stringify({ chatVisible: historyView.chatVisible, historyHidden: historyView.historyHidden, composeHidden: historyView.composeHidden }));
    // 两个视图必须互斥：曾经因为 display:flex 压过 [hidden]，对话流与历史列表同屏显示。
    check('历史视图下对话流确实不可见（与历史互斥）', historyView.chatVisible === false, String(historyView.chatVisible));
    check('历史列表里列出了会话', historyView.historyCards >= 2, String(historyView.historyCards));
    check('标题显示为历史对话', historyView.title === '历史对话', String(historyView.title));
    const inHistoryHeader = await page.evaluate((selector) => {
      const dialog = document.querySelector(selector).shadowRoot.querySelectorAll('.llm-chat-dialog')[0];
      return {
        backHidden: dialog.querySelector('.llm-chat-back').hidden,
        historyActive: dialog.querySelector('.llm-chat-history-btn').classList.contains('is-active'),
      };
    }, PANEL_HOST);
    check('历史视图下返回键出现、历史按钮高亮', inHistoryHeader.backHidden === false && inHistoryHeader.historyActive === true, JSON.stringify(inHistoryHeader));
    // 返回键退回对话视图。
    await page.evaluate((selector) => {
      const dialog = document.querySelector(selector).shadowRoot.querySelectorAll('.llm-chat-dialog')[0];
      dialog.querySelector('.llm-chat-back').click();
    }, PANEL_HOST);
    await page.waitForTimeout(350);
    const afterBackState = await readWindows(page);
    const afterBack = afterBackState ? afterBackState.windows[0] : null;
    check('返回键退回对话视图', afterBack && afterBack.historyHidden === true && afterBack.composeHidden === false, JSON.stringify(afterBack));
    // 再次进历史，点卡片回到对话。
    await page.evaluate((selector) => {
      const dialog = document.querySelector(selector).shadowRoot.querySelectorAll('.llm-chat-dialog')[0];
      dialog.querySelector('.llm-chat-history-btn').click();
    }, PANEL_HOST);
    await page.waitForTimeout(300);
    // 点第一张卡片回到对话视图。
    await page.evaluate((selector) => {
      const dialog = document.querySelector(selector).shadowRoot.querySelectorAll('.llm-chat-dialog')[0];
      dialog.querySelector('.llm-chat-history .llm-history-card').click();
    }, PANEL_HOST);
    await page.waitForTimeout(400);
    const backToChat = (await readWindows(page)).windows[0];
    check('点历史卡片回到对话视图', backToChat.historyHidden === true && backToChat.composeHidden === false, JSON.stringify(backToChat));
    console.log('');

    // ---------- 六b. 拖动不闪（逐帧采样） ----------
    // 「动画一闪一闪」这类缺陷必须逐帧采样：起止两态看不出来，问题只在中间几帧。
    // 判据是同一帧内的几何量是否连续，以及入场动画有没有被重放。
    console.log('【六b】拖动时窗口不闪（逐帧采样）');
    const dragHead = await page.evaluate((selector) => {
      const dialog = document.querySelector(selector).shadowRoot.querySelectorAll('.llm-chat-dialog')[0];
      const rect = dialog.querySelector('.llm-chat-head').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, PANEL_HOST);
    // 先发 evaluate（不 await）启动采样 → 再拖 → 最后 await 结果。
    const sampling = page.evaluate((selector) => new Promise((resolve) => {
      const dialog = document.querySelector(selector).shadowRoot.querySelectorAll('.llm-chat-dialog')[0];
      const frames = [];
      const read = () => {
        const rect = dialog.getBoundingClientRect();
        const style = getComputedStyle(dialog);
        return { left: +rect.left.toFixed(2), top: +rect.top.toFixed(2), opacity: style.opacity, animationName: style.animationName };
      };
      let count = 0;
      const tick = () => { frames.push(read()); if (++count < 110) requestAnimationFrame(tick); else resolve(frames); };
      requestAnimationFrame(tick);
    }), PANEL_HOST);
    await page.mouse.move(dragHead.x, dragHead.y);
    await page.mouse.down();
    for (let i = 1; i <= 18; i += 1) { await page.mouse.move(dragHead.x - i * 5, dragHead.y + i * 4); await page.waitForTimeout(16); }
    await page.mouse.up();
    const frames = await sampling;
    // 同帧内的跳变：位移 > 20px 或透明度变化即异常（拖动的每帧位移远小于 20px）。
    let jumps = 0;
    let opacityFlicker = 0;
    for (let i = 1; i < frames.length; i += 1) {
      if (Math.abs(frames[i].left - frames[i - 1].left) > 20 || Math.abs(frames[i].top - frames[i - 1].top) > 20) jumps += 1;
      if (frames[i].opacity !== frames[i - 1].opacity) opacityFlicker += 1;
    }
    check('拖动全程无位置跳变', jumps === 0, `异常帧 ${jumps} / 共 ${frames.length} 帧`);
    check('拖动全程无透明度闪烁（入场动画不重放）', opacityFlicker === 0, `透明度变化帧 ${opacityFlicker}`);
    check('拖动期间入场动画始终未重新挂上',
      frames.every((f) => f.animationName === 'none'), [...new Set(frames.map((f) => f.animationName))].join('|'));
    console.log('');

    // ---------- 六c. 点外部关闭未置顶窗口 ----------
    console.log('【六c】点窗口外收起未置顶窗口，置顶窗口不动');
    // 目前有两个窗口。把第 0 个置顶，然后点页面空白。
    await page.evaluate((selector) => {
      const dialogs = document.querySelector(selector).shadowRoot.querySelectorAll('.llm-chat-dialog');
      dialogs[0].querySelector('.llm-chat-pin').click();
    }, PANEL_HOST);
    await page.waitForTimeout(250);
    const beforeOutside = await readWindows(page);
    check('点之前两个窗口都在，其中一个已置顶',
      beforeOutside.count === 2 && beforeOutside.windows.some((w) => w.pinned), JSON.stringify(beforeOutside.windows.map((w) => w.pinned)));

    // 点页面空白（左下角是页面按钮，取右下角空地）。
    await page.mouse.click(760, 640);
    await page.waitForTimeout(400);
    const afterOutside = await readWindows(page);
    check('未置顶窗口被收起', afterOutside.count === 1, JSON.stringify({ count: afterOutside.count }));
    check('置顶窗口保持不动', afterOutside.windows.length === 1 && afterOutside.windows[0].pinned === true, JSON.stringify(afterOutside.windows.map((w) => w.pinned)));

    // 再点一次空白：置顶窗口仍然保留（置顶语义就是不被点走）。
    await page.mouse.click(780, 660);
    await page.waitForTimeout(350);
    const stillPinned = await readWindows(page);
    check('再点空白，置顶窗口仍在', stillPinned.count === 1 && stillPinned.windows[0].pinned === true, JSON.stringify({ count: stillPinned.count }));

    // 取消置顶后再点空白 → 全部收起。
    await page.evaluate((selector) => {
      document.querySelector(selector).shadowRoot.querySelector('.llm-chat-pin').click();
    }, PANEL_HOST);
    await page.waitForTimeout(250);
    await page.mouse.click(800, 680);
    await page.waitForTimeout(400);
    const allGone = await readWindows(page);
    check('取消置顶后点空白，窗口全部收起', allGone.count === 0, JSON.stringify({ count: allGone.count }));

    // 复原：从侧栏历史里重开**那条含 Markdown 回复的会话**，供 Markdown 与几何两段继续用。
    // 不要用「再问一次」来复原：那会新建一段会话，Markdown 断言就落到短回复上了。
    await page.locator(`${PANEL_HOST} .llm-rail`).dispatchEvent('click');
    await page.waitForTimeout(450);
    await page.evaluate((selector) => {
      const root = document.querySelector(selector).shadowRoot;
      const card = Array.from(root.querySelectorAll('.llm-history-list .llm-history-card'))
        .find((node) => (node.querySelector('.llm-card-title')?.textContent || '').includes('第一个问题'));
      card?.click();
    }, PANEL_HOST);
    await page.waitForTimeout(900);
    await page.locator(`${PANEL_HOST} .llm-rail`).dispatchEvent('click');
    await page.waitForTimeout(300);
    console.log('');

    // ---------- 七. Markdown 渲染 ----------
    console.log('【七】助手回复渲染 Markdown，且原始 HTML 不穿透');
    const md = (await readWindows(page)).windows[0].html[0] || '';
    check('标题渲染为 <h1>', /<h1>标题<\/h1>/.test(md), md.slice(0, 40));
    check('无序列表渲染为 <ul><li>', /<ul><li>第一项<\/li><li>第二项<\/li><\/ul>/.test(md), md.slice(0, 120));
    check('围栏代码块渲染为 <pre><code>', /<pre><code class="language-js">/.test(md), md.slice(-200));
    check('行内代码渲染为 <code>', /<code>代码<\/code>/.test(md), md.slice(-120));
    check('粗体渲染为 <strong>', /<strong>加粗<\/strong>/.test(md), md.slice(-120));
    // 安全边界：模型回复里的 script 必须被转义成可见文本，不能变成真的标签。
    check('原始 HTML 不穿透（script 被转义）', !/<script/i.test(md) && /&lt;script&gt;/.test(md), md.slice(-200));
    console.log('');

    // ---------- 八. 几何跨刷新保留 ----------
    console.log('【八】位置/大小/置顶跨刷新保留');
    await page.evaluate((selector) => {
      const dialog = document.querySelector(selector).shadowRoot.querySelectorAll('.llm-chat-dialog')[0];
      dialog.querySelector('.llm-chat-pin').click();
    }, PANEL_HOST); // 置顶后再刷新
    await page.waitForTimeout(300);
    const pinnedBefore = (await readWindows(page)).windows[0];
    const survivedGeometry = await optionsPage.evaluate(() => new Promise((resolve) => {
      chrome.storage.local.get('quickfind-llm-window-geometry', (stored) => resolve(stored?.['quickfind-llm-window-geometry'] || null));
    }));
    check('几何已写入本地存储', Boolean(survivedGeometry) && Object.keys(survivedGeometry).length > 0, JSON.stringify(survivedGeometry).slice(0, 160));

    // 刷新后用历史入口重开**同一个会话**，检查几何被还原。
    // 侧栏历史按更新时间倒序，第一张未必是这个窗口的会话，所以按标题文本定位。
    await page.reload();
    await page.waitForSelector(PANEL_HOST, { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(1200);
    await page.locator(`${PANEL_HOST} .llm-rail`).dispatchEvent('click');
    await page.waitForTimeout(500);
    const reopenedTitle = pinnedBefore.title;
    const clicked = await page.evaluate((payload) => {
      const root = document.querySelector(payload.selector).shadowRoot;
      const card = Array.from(root.querySelectorAll('.llm-history-list .llm-history-card'))
        .find((node) => (node.querySelector('.llm-card-title')?.textContent || '').includes(payload.title));
      if (!card) return false;
      card.click();
      return true;
    }, { selector: PANEL_HOST, title: reopenedTitle });
    check('在历史里找到刚才那个会话', clicked === true, String(reopenedTitle));
    await page.waitForTimeout(900);
    const restored = (await readWindows(page)).windows[0];
    check('刷新后重开同一会话，位置被还原',
      restored && restored.left === pinnedBefore.left && restored.top === pinnedBefore.top,
      restored ? `${pinnedBefore.left},${pinnedBefore.top} → ${restored.left},${restored.top}` : 'no window');
    check('刷新后重开同一会话，尺寸被还原',
      restored && Math.abs(restored.width - pinnedBefore.width) <= 2 && Math.abs(restored.height - pinnedBefore.height) <= 2,
      restored ? `${pinnedBefore.width}x${pinnedBefore.height} → ${restored.width}x${restored.height}` : 'no window');
    check('刷新后重开同一会话，置顶状态被还原',
      restored && restored.pinned === pinnedBefore.pinned,
      restored ? `${pinnedBefore.pinned} → ${restored.pinned}` : 'no window');
    console.log('');

    // ---------- 九. 新会话继承上次尺寸 ----------
    // 几何按会话 id 记，而「问 ai」每次都开一段**新对话**——只按会话记账的话，用户拖好的
    // 尺寸永远命不中，新窗口一律回落到硬编码的 420×560，用户看到的就是「尺寸记不住」。
    console.log('【九】新开的对话窗口继承上次用过的尺寸');
    const grip3 = await page.evaluate((selector) => {
      const dialog = document.querySelector(selector).shadowRoot.querySelectorAll('.llm-chat-dialog')[0];
      const rect = dialog.querySelector('.llm-chat-resize').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }, PANEL_HOST);
    await page.mouse.move(grip3.x, grip3.y);
    await page.mouse.down();
    await page.mouse.move(grip3.x - 120, grip3.y - 90, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const resized = (await readWindows(page)).windows[0];
    check('已把窗口改成一个区别于默认值的大小',
      resized && (resized.width !== 420 || resized.height !== 560),
      resized ? `${resized.width}x${resized.height}` : 'no window');

    // 关掉它，再开一段全新对话（新会话，几何键与刚才那个不同）。
    await page.evaluate((selector) => {
      document.querySelector(selector).shadowRoot.querySelectorAll('.llm-chat-dialog')[0].querySelector('.llm-chat-close').click();
    }, PANEL_HOST);
    await page.waitForTimeout(300);
    check('上一个窗口已关闭', (await readWindows(page)).count === 0, JSON.stringify({ count: (await readWindows(page)).count }));
    await askAi(page, '新会话看尺寸');
    const inherited = (await readWindows(page)).windows[0];
    check('新会话窗口的尺寸继承上次的值',
      inherited && Math.abs(inherited.width - resized.width) <= 2 && Math.abs(inherited.height - resized.height) <= 2,
      inherited ? `${resized.width}x${resized.height} → ${inherited.width}x${inherited.height}` : 'no window');
    console.log('');

    await page.close();
    return summary();
  } finally {
    await env.close();
    await new Promise((resolve) => stub.server.close(resolve));
  }
})().then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(2); });