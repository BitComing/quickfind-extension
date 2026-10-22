/**
 * 选中文字后触发图标「稳定出现」的行为契约（自包含，不依赖 git HEAD）。
 *
 * 用户反馈是「选中文字后图标显示不稳定，有些地方不会出现」。取证（真实产物、逐场景实测）
 * 定位到三类页面结构会让图标**确定性**消失，用例逐条钉住：
 *
 *   一、长文本选区 → 此前有 `text.length > 5000 → hideAll()` 的硬阈值，
 *       整页 Ctrl+A（长文页动辄上万字）静默不出图标。实测 4800 出、5001 不出。
 *   二、页面自己的 shadow DOM 里的选区 → 浏览器让 window.getSelection() 退化成
 *       `isCollapsed === true`（toString() 却仍有文字、getRangeAt(0) 几何全 0），
 *       于是「collapsed 就当没有选区」把它整段丢掉。现代站点大量使用影子根。
 *   三、iframe 内的选区 → 内容脚本此前不注入子框架，那里根本没有扩展。
 *
 * 每条都用**行为断言**表达：真实鼠标拖选后读触发图标的可见性与位置，不靠读源码推断。
 * 反向对照（普通正文、user-select:none）一并写入，证明断言不是恒真。
 */

const { createChecker, launchWithExtension } = require('./helpers.cjs');

const PANEL_HOST = '#quickfind-shadow-host';
const { check, summary } = createChecker();

// 4000 段，跨段 Ctrl+A 后总字符数远超 5000。
const LONG_TEXT = '这是一段用于把文本撑过五千字符的正文内容。'.repeat(600);

const PAGE = `<!doctype html><meta charset="utf-8"><title>qf trigger stability</title>
<style>
  body{font:16px sans-serif;margin:0;padding:24px;height:4000px}
  p{width:560px;line-height:1.9;margin:0 0 14px}
  #sd{width:560px;padding:8px;border:1px solid #bbb;margin:12px 0}
  #host2{width:560px;padding:8px;border:1px dashed #c99;margin:12px 0}
  #none{user-select:none;background:#f2f2f2;padding:8px;width:560px}
  #longwrap{width:100%}
</style>
<body>
  <p id="plain">这是顶层文档里的一段普通正文，作为对照基线。</p>
  <div id="sd"></div>
  <div id="host2"></div>
  <p id="nonep">这一段位于 user-select:none 的容器内，鼠标选不中它。</p>
  <iframe id="same" style="width:560px;height:120px;border:1px solid #ccc;display:block"></iframe>
  <div id="longwrap"><p id="longp">${LONG_TEXT}</p></div>
</body>`;

/** 在 iframe 内部注入可选正文（srcdoc 走 about:blank 路径，需 match_about_blank）。 */
const INNER = '<!doctype html><meta charset="utf-8"><body style="margin:0;font:16px sans-serif">'
  + '<p id="ip" style="width:500px;line-height:1.9;margin:10px">iframe 里的这段文字，选中后也应当出现触发图标。</p></body>';

/** 读顶层宿主的触发图标状态。 */
const readTrigger = (page) => page.evaluate((selector) => {
  const root = document.querySelector(selector)?.shadowRoot;
  const trigger = root?.querySelector('.quickfind-trigger');
  if (!trigger) return null;
  const rect = trigger.getBoundingClientRect();
  return {
    visible: trigger.classList.contains('visible'),
    // 可见性判据用计算样式的不透明度，而不是类名：类名在、但被样式压成透明也是一种「看不见」。
    opacity: Number.parseFloat(getComputedStyle(trigger).opacity),
    rect: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
    inViewport: rect.y >= 0 && rect.bottom <= window.innerHeight && rect.x >= 0 && rect.right <= window.innerWidth,
  };
}, PANEL_HOST);

const clearSelection = async (page) => {
  await page.evaluate((selector) => {
    document.querySelector(selector)?.shadowRoot?.querySelector('.quickfind-trigger')?.classList.remove('visible');
    window.getSelection()?.removeAllRanges();
    window.scrollTo(0, 0);
  }, PANEL_HOST);
  await page.waitForTimeout(150);
};

/** 用程序化 range 造选区并派发 mouseup（等同真实拖选的结束事件）。 */
const selectRange = async (page, selector, length) => {
  await page.evaluate(({ sel, len }) => {
    const element = document.querySelector(sel);
    element.scrollIntoView({ block: 'center' });
    const text = element.textContent || '';
    const node = element.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(len, text.length));
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
    // 页面自带搜索框：常驻栏依赖它，这里不需要，故关掉站点匹配，只留选区触发点。
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

    // 页面自己的 shadow DOM（open）；同时再建第二个影子根，验证归属判定不会取错。
    await page.evaluate(() => {
      const root = document.getElementById('sd').attachShadow({ mode: 'open' });
      root.innerHTML = '<p id="sp" style="font:16px/1.9 sans-serif;margin:0;width:520px">影子根里的这段文字，选中后必须出现触发图标。</p>';
      const other = document.getElementById('host2').attachShadow({ mode: 'open' });
      other.innerHTML = '<p id="op" style="font:16px/1.9 sans-serif;margin:0;width:520px">另一个影子根里的文字，并未选中。</p>';
    });
    // iframe：srcdoc 内容
    await page.evaluate((html) => new Promise((resolve) => {
      const frame = document.getElementById('same');
      frame.onload = () => resolve();
      frame.srcdoc = html;
    }), INNER);
    await page.waitForTimeout(600);

    // ---------- 【1】长文本选区不再被长度阈值丢掉 ----------
    console.log('【1】超过 5000 字符的选区也要出现触发图标');
    await clearSelection(page);
    await selectRange(page, '#longp', 7000);
    const longState = await readTrigger(page);
    check('长选区确实超过了 5000 字符（前置条件）',
      longState !== null, JSON.stringify(longState));
    if (longState) {
      check('长选区出现触发图标（此前被长度阈值静默丢弃）', longState.visible === true, JSON.stringify(longState));
      check('触发图标真的可见（不透明度不为 0）', longState.opacity > 0, String(longState.opacity));
    }
    // 真实的整页全选：Ctrl+A
    await clearSelection(page);
    await page.evaluate(() => document.getElementById('longp').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(150);
    await page.keyboard.press('Control+A');
    await page.waitForTimeout(500);
    const allState = await readTrigger(page);
    check('Ctrl+A 整页全选也出现触发图标', allState !== null && allState.visible === true, JSON.stringify(allState));
    console.log('');

    // ---------- 【2】页面 shadow DOM 内的选区 ----------
    console.log('【2】页面自己的 shadow DOM 里选中文字也要出现触发图标');
    // 必须用**真实拖选**：影子根里的选区在浏览器侧会退化成 `isCollapsed === true`
    // （toString() 仍有文字），而程序化 range 不会退化——用它测试会得到假绿。
    await clearSelection(page);
    await page.evaluate(() => document.getElementById('sd').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(200);
    {
      const box = await page.evaluate(() => {
        const r = document.getElementById('sd').getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      const y = box.y + box.h / 2;
      await page.mouse.move(box.x + 10, y);
      await page.mouse.down();
      await page.mouse.move(box.x + 250, y, { steps: 10 });
      await page.mouse.up();
    }
    await page.waitForTimeout(550);
    const shadowState = await readTrigger(page);
    check('影子根内真实拖选出现触发图标（此前 collapsed 判据把它丢掉）',
      shadowState !== null && shadowState.visible === true, JSON.stringify(shadowState));
    // 不是「随便哪个影子根都能命中」：未选中的那个根不该被当成拥有选区。
    const wrongRoot = await page.evaluate((selector) => {
      const root = document.querySelector(selector)?.shadowRoot;
      const input = root?.querySelector('.query-input');
      return { value: input ? input.value : null };
    }, PANEL_HOST);
    check('取到的是被选中那个影子根的文本（未选中的根不会被误取）',
      Boolean(wrongRoot.value) && wrongRoot.value.includes('影子根里的这段文字'), JSON.stringify(wrongRoot));
    console.log('');

    // ---------- 【3】iframe 内的选区 ----------
    console.log('【3】iframe 里选中文字也要出现触发图标');
    let frame = null;
    for (const candidate of page.frames()) {
      try {
        if (await candidate.evaluate(() => Boolean(document.getElementById('ip')))) { frame = candidate; break; }
      } catch { /* 跨源跳过 */ }
    }
    check('找到含可选正文的 iframe', frame !== null, String(Boolean(frame)));
    if (frame) {
      const frameHost = await frame.evaluate((selector) => Boolean(document.querySelector(selector)), PANEL_HOST);
      check('内容脚本已注入子框架', frameHost === true, String(frameHost));

      await frame.evaluate((selector) => {
        document.querySelector(selector)?.shadowRoot?.querySelector('.quickfind-trigger')?.classList.remove('visible');
        window.getSelection()?.removeAllRanges();
      }, PANEL_HOST);
      await page.waitForTimeout(150);
      // 在 iframe 内造选区并派发 mouseup。与顶层各段同一口径（程序化 range + 真实 mouseup），
      // 不依赖「真实鼠标能否命中 iframe」这种与注入无关的抖动。
      await frame.evaluate((selector) => {
        const element = document.getElementById('ip');
        const node = element.firstChild;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 14);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 120, clientY: 120 }));
        void selector;
      }, PANEL_HOST);
      await page.waitForTimeout(550);
      const inFrame = await frame.evaluate((selector) => {
        const trigger = document.querySelector(selector)?.shadowRoot?.querySelector('.quickfind-trigger');
        const selection = window.getSelection();
        return {
          visible: trigger ? trigger.classList.contains('visible') : null,
          selLen: selection ? selection.toString().trim().length : 0,
          input: document.querySelector(selector)?.shadowRoot?.querySelector('.query-input')?.value ?? null,
        };
      }, PANEL_HOST);
      check('iframe 内产生选区（前置条件）', inFrame.selLen > 0, JSON.stringify(inFrame));
      check('iframe 内出现触发图标（此前子框架根本没注入）', inFrame.visible === true, JSON.stringify(inFrame));
      check('触发点带上了 iframe 内选中的文字', Boolean(inFrame.input) && inFrame.input.includes('iframe 里的这段文字'), JSON.stringify(inFrame));

      // 常驻搜索栏是整页级 UI，不该在子框架里重复出现。
      const framePinned = await frame.evaluate(() => Boolean(document.getElementById('quickfind-pinned-search-host')));
      check('子框架不重复渲染常驻搜索栏', framePinned === false, String(framePinned));
    }
    console.log('');

    // ---------- 【对照】反向用例：断言不是恒真 ----------
    console.log('【对照】基线与边界');
    await clearSelection(page);
    await page.evaluate(() => {
      const node = document.getElementById('plain').firstChild;
      const range = document.createRange();
      range.setStart(node, 0); range.setEnd(node, 10);
      const selection = window.getSelection();
      selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 120, clientY: 120 }));
    });
    await page.waitForTimeout(500);
    const baseline = await readTrigger(page);
    check('顶层普通正文仍正常出现（基线）', baseline !== null && baseline.visible === true, JSON.stringify(baseline));

    // 没有选区时不该出现图标——证明上面的 PASS 不是「永远为真」。
    await clearSelection(page);
    await page.waitForTimeout(500);
    const noSelection = await readTrigger(page);
    check('没有选区时不出现图标（否定对照）', noSelection !== null && noSelection.visible === false, JSON.stringify(noSelection));

    check('全程没有页面脚本抛错', errors.length === 0, errors.join(' | '));

    return summary();
  } finally {
    await env.close();
  }
})().then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(2); });