/**
 * 「没有选中文字，搜索图标却出现」的行为契约。
 *
 * 用户反馈是「有时候明明没选中任何文字，图标就出现了」。取证（自包含页面、逐场景实测）
 * 定位到的不是一种情况，而是同一类判据缺失：**是否显示触发点，只看「选区 API 里有没有
 * 选区」，不看「用户眼睛看不看得见这段选区」**。选区是脚本可以随意制造的状态，于是：
 *
 *   一、页面把选中的节点整段删掉 / 把消息重渲染成新节点 / 给祖先加 display:none 时，
 *       选区静默失效（collapsed 或几何归零），Chromium **不派发 selectionchange**，
 *       图标就留在原地——用户看到的是「没选中任何文字，却挂着一个图标」。
 *   二、页面用离屏元素做「复制到剪贴板」（textarea.select() 或
 *       range.selectNodeContents + execCommand('copy')），选区一直在、但一个字都没画在
 *       屏幕上；图标照样弹出来，还被 positionTrigger 夹到视口边角。
 *   三、选区被滚出视口后，图标被夹在屏幕边缘继续挂着。
 *
 * 每条都用**行为断言**表达：读触发图标的可见性与不透明度，不靠读源码推断。
 * 同时保留正向对照（真实拖选、整页 Ctrl+A），证明修复不是「一律不出图标」。
 */

const { createChecker, launchWithExtension } = require('./helpers.cjs');

const PANEL_HOST = '#quickfind-shadow-host';
const { check, summary } = createChecker();

const LONG_TEXT = '这是一段用于把页面撑得很长的正文内容，整页全选之后末行会远远落在视口之外。'.repeat(120);

const PAGE = `<!doctype html><meta charset="utf-8"><title>qf phantom</title>
<style>
  body{font:16px/1.7 system-ui,sans-serif;margin:0;padding:24px;height:3400px}
  p{width:560px;margin:0 0 14px}
  #wrap{width:560px;padding:10px;border:1px solid #ddd;margin:16px 0}
  #off{position:absolute;left:-9999px;top:0}
  #copyta{position:fixed;left:-9999px;top:0}
  .toolbar{margin:16px 0}
  .spacer{height:1200px}
</style>
<body>
  <p id="text">这一段可见的正文，用来做真实拖选与节点删除的正反对照。</p>
  <div id="wrap"><p id="inner">这条消息会被页面脚本重渲染掉，选区随之静默失效。</p></div>
  <div class="toolbar">
    <button id="copy-ta">复制（隐藏 textarea 手法）</button>
    <button id="copy-div">复制（离屏 div 手法）</button>
  </div>
  <p id="middle">中间段落。</p>
  <div class="spacer"></div>
  <p id="longp">${LONG_TEXT}</p>
  <div id="off">离屏的复制用文本，用户看不见这一行字。</div>
  <textarea id="copyta" readonly>隐藏 textarea 里的内容</textarea>
  <script>
    const ta = document.getElementById('copyta');
    document.getElementById('copy-ta').addEventListener('click', () => {
      ta.value = '隐藏 textarea 里的内容';
      ta.select();                        // 聚焦 + 全选：文本域在 -9999px，屏幕上什么都没有
      try { document.execCommand('copy'); } catch {}
    });
    document.getElementById('copy-div').addEventListener('click', () => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('off'));
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      try { document.execCommand('copy'); } catch {}
    });
  </script>
</body>`;

/** 读触发图标状态：类名 + 不透明度（类名在但被样式压成透明，也是一种「看不见」）。 */
const readTrigger = (page) => page.evaluate((selector) => {
  const root = document.querySelector(selector)?.shadowRoot;
  const trigger = root?.querySelector('.quickfind-trigger');
  if (!trigger) return null;
  const rect = trigger.getBoundingClientRect();
  const selection = window.getSelection();
  return {
    visible: trigger.classList.contains('visible'),
    opacity: Number.parseFloat(getComputedStyle(trigger).opacity),
    rect: [Math.round(rect.x), Math.round(rect.y)],
    selection: selection ? selection.toString().replace(/\s+/g, ' ').trim().slice(0, 24) : '',
    collapsed: selection ? selection.isCollapsed : null,
  };
}, PANEL_HOST);

/** 回到「没有选区、没有图标」的干净状态。 */
const reset = async (page) => {
  await page.evaluate((selector) => {
    const root = document.querySelector(selector)?.shadowRoot;
    root?.querySelector('.quickfind-trigger')?.classList.remove('visible');
    root?.querySelector('.quickfind-panel')?.classList.remove('visible');
    window.getSelection()?.removeAllRanges();
    document.activeElement?.blur?.();
    window.scrollTo(0, 0);
  }, PANEL_HOST);
  await page.waitForTimeout(400);
};

/** 程序化造选区并派发 mouseup（等同真实选区结束），然后等触发点出现。 */
const selectRange = async (page, selector, length) => {
  await page.evaluate(({ sel, len }) => {
    const element = document.querySelector(sel);
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(len, (element.textContent || '').length));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 120, clientY: 120 }));
  }, { sel: selector, len: length });
  await page.waitForTimeout(500);
};

(async () => {
  const env = await launchWithExtension();
  try {
    const optionsPage = await env.openOptionsPage();
    // editableTriggerMode 必须是 click：隐藏 textarea 那条用例走的就是输入框选区，
    // 若用默认的 none，它不弹图标是因为配置静音，而不是本用例要钉的判据。
    await optionsPage.evaluate(() => new Promise((resolve) => chrome.storage.sync.set({
      sources: [{ id: 'google', name: '谷歌', mark: 'G', className: 'google', url: 'https://www.google.com/search?q={query}', enabled: true, iconOnly: false }],
      groups: [{ id: 'default', name: '默认组', items: ['google'], visible: true }],
      triggerMode: 'click', editableTriggerMode: 'click', selectionTriggerDelay: 0, defaultGroupCount: 20,
      searchHistory: [], llmDockVisible: false,
      pinnedSearch: { sites: [], customSites: [], defaultGroupCount: 4, collapseDelay: 60000, openInNewTab: false, allSites: false, siteConfigVersion: 3 },
    }, resolve)));

    const page = await env.context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(await env.serve(PAGE));
    await page.waitForSelector(PANEL_HOST, { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(900);

    // ---------- 【对照】正向：真的选中可见文字，图标必须出现 ----------
    console.log('【对照】真的选中可见文字时，图标照常出现');
    await reset(page);
    {
      const box = await page.evaluate(() => {
        const rect = document.getElementById('text').getBoundingClientRect();
        return { x: rect.x + 4, y: rect.y + 8, ex: rect.x + 200, ey: rect.y + 8 };
      });
      await page.mouse.move(box.x, box.y);
      await page.mouse.down();
      await page.mouse.move(box.ex, box.ey, { steps: 8 });
      await page.mouse.up();
    }
    await page.waitForTimeout(700);
    const baseline = await readTrigger(page);
    check('真实拖选可见正文出现图标（基线）', baseline !== null && baseline.visible === true, JSON.stringify(baseline));

    // 整页 Ctrl+A：末行早已滚到视口之外，图标仍应出现——这是上一轮修复钉住的契约，
    // 不能被这次「只认看得见的选区」改成「长选区不出图标」。
    await reset(page);
    await page.evaluate(() => document.getElementById('longp').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+A');
    await page.waitForTimeout(700);
    const allSelected = await readTrigger(page);
    check('整页 Ctrl+A 仍出现图标（跨视口的长选区不被误杀）',
      allSelected !== null && allSelected.visible === true, JSON.stringify(allSelected));

    // ---------- 【一】选区被页面销毁，图标必须跟着收起 ----------
    console.log('\n【一】选区静默失效后，图标不能留在原地');
    await reset(page);
    await selectRange(page, '#text', 12);
    const beforeRemove = await readTrigger(page);
    check('前置条件：选中的正文先出现图标', beforeRemove.visible === true, JSON.stringify(beforeRemove));
    await page.evaluate(() => document.getElementById('text').remove());
    await page.waitForTimeout(900);
    const afterRemove = await readTrigger(page);
    check('选中的节点被整段删除后图标消失（Chromium 不派发 selectionchange）',
      afterRemove !== null && afterRemove.visible === false, JSON.stringify(afterRemove));

    await reset(page);
    await page.evaluate(() => { document.getElementById('inner').textContent = '这条消息会被页面脚本重渲染掉，选区随之静默失效。'; });
    await selectRange(page, '#inner', 12);
    await page.evaluate(() => { document.getElementById('inner').textContent = '重渲染之后的新文本内容，长度也变了。'; });
    await page.waitForTimeout(900);
    const afterRerender = await readTrigger(page);
    check('消息被重渲染（文本节点换新）后图标消失',
      afterRerender !== null && afterRerender.visible === false, JSON.stringify(afterRerender));

    await reset(page);
    await selectRange(page, '#inner', 12);
    await page.evaluate(() => { document.getElementById('wrap').style.display = 'none'; });
    await page.waitForTimeout(900);
    const afterHidden = await readTrigger(page);
    check('选区祖先被 display:none 后图标消失',
      afterHidden !== null && afterHidden.visible === false, JSON.stringify(afterHidden));
    await page.evaluate(() => { document.getElementById('wrap').style.display = ''; });

    // ---------- 【二】脚本制造的「看不见的选区」不该弹出图标 ----------
    console.log('\n【二】离屏元素上的复制用选区不弹出图标');
    await reset(page);
    await page.evaluate(() => {
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('off'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 300, clientY: 300 }));
    });
    await page.waitForTimeout(700);
    const offscreen = await readTrigger(page);
    check('离屏 div 被选中时不出现图标（此前会被夹到视口边角）',
      offscreen !== null && offscreen.visible === false, JSON.stringify(offscreen));

    await reset(page);
    {
      const point = await page.evaluate(() => {
        const rect = document.getElementById('copy-ta').getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      await page.mouse.click(point.x, point.y);
    }
    await page.waitForTimeout(700);
    const hiddenTextarea = await readTrigger(page);
    check('隐藏 textarea 被 select() 时不出现图标',
      hiddenTextarea !== null && hiddenTextarea.visible === false, JSON.stringify(hiddenTextarea));

    // ---------- 【三】选区被滚出视口后图标收起 ----------
    console.log('\n【三】选区被滚出视口后，图标不能挂在屏幕边缘');
    await reset(page);
    // 先把选区滚进视口（贴顶对齐，长段落居中会把开头几行推到视口上方），
    // 否则「选中即不可见」会走到另一条判据上，测不到滚动导致的失效。
    await page.evaluate(() => document.getElementById('longp').scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(300);
    await selectRange(page, '#longp', 30);
    const beforeScroll = await readTrigger(page);
    check('前置条件：选中的正文先出现图标', beforeScroll.visible === true, JSON.stringify(beforeScroll));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(700);
    const afterScroll = await readTrigger(page);
    check('选区滚出视口后图标收起',
      afterScroll !== null && afterScroll.visible === false, JSON.stringify(afterScroll));

    // ---------- 【否定对照】没有选区时不出现 ----------
    console.log('\n【否定对照】');
    await reset(page);
    await page.mouse.click(900, 700);
    await page.waitForTimeout(600);
    const noSelection = await readTrigger(page);
    check('没有选区时点击页面空白不出现图标', noSelection !== null && noSelection.visible === false, JSON.stringify(noSelection));

    check('全程没有页面脚本抛错', errors.length === 0, errors.join(' | '));
    return summary();
  } finally {
    await env.close();
  }
})().then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(2); });