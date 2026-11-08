// 网页内搜索框：白色主题 + 搜索源图标右键「本标签打开 / 新建标签打开」。
//
// 断言都落在真实产物上：读浮层与常驻栏的计算样式，用真实右键事件开菜单，
// 再分别验证「新建标签打开」确实新开标签、「本标签打开」确实替换当前页。

const { launchWithExtension, createChecker } = require('./helpers.cjs');

const { check, summary } = createChecker();
const PANEL_HOST = '#quickfind-shadow-host';
const PINNED_HOST = '#quickfind-pinned-search-host';

const PAGE = `<!doctype html><meta charset="utf-8"><title>qf page search</title>
<body style="margin:0;padding:24px;font:16px/1.8 sans-serif">
  <p id="text">这是页面里的一段普通正文，用来选中后触发搜索浮层。</p>
</body>`;

/** 读浮层/常驻栏里指定元素的计算样式与菜单结构。 */
async function readStyle(page, hostSelector, selector) {
  return page.evaluate(({ hostSelector, selector }) => {
    const root = document.querySelector(hostSelector)?.shadowRoot;
    const menuItems = Array.from(root?.querySelectorAll('.qf-open-menu-item') || []).map((item) => item.textContent.trim());
    const menuCount = root?.querySelectorAll('.qf-open-menu').length || 0;
    const node = root?.querySelector(selector);
    if (!node) return { background: null, color: null, visible: false, menuItems, menuCount };
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    return {
      background: style.backgroundColor,
      color: style.color,
      visible: rect.width > 0 && rect.height > 0,
      menuItems,
      menuCount,
    };
  }, { hostSelector, selector });
}

/** 在扩展浮层里派发一次右键：Playwright 的右击对 shadow DOM 内按钮不够稳定，直接派发等价事件。 */
async function rightClick(page, hostSelector, selector) {
  return page.evaluate(({ hostSelector, selector }) => {
    const node = document.querySelector(hostSelector)?.shadowRoot?.querySelector(selector);
    if (!node) return false;
    const rect = node.getBoundingClientRect();
    const event = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: Math.max(10, Math.round(rect.left + rect.width / 2)),
      clientY: Math.max(10, Math.round(rect.top + rect.height / 2)),
    });
    return node.dispatchEvent(event);
  }, { hostSelector, selector });
}

/**
 * 一次**真实**右键：指针移过去 → 按下 → 抬起，contextmenu 由浏览器自己派发。
 *
 * 与上面的合成事件不是一回事：真实右键还会经过 document 上的 pointerdown / mousedown /
 * pointerup / mouseup，那几条路径上有选区浮层的收尾逻辑。用它才能测出
 * 「菜单出现一下马上消失」这类只发生在真实手势里的缺陷（见用例【4】）。
 */
async function realRightClick(page, hostSelector, selector) {
  const point = await page.evaluate(({ hostSelector, selector }) => {
    const rect = document.querySelector(hostSelector)?.shadowRoot?.querySelector(selector)?.getBoundingClientRect();
    if (!rect || !rect.width) return null;
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }, { hostSelector, selector });
  if (!point) return null;
  await page.mouse.move(point.x, point.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  return point;
}

/** 读菜单自身的位置，用来验证「贴在右键处」而不是被挤到别处。 */
async function readMenuRect(page, hostSelector) {
  return page.evaluate((hostSelector) => {
    const menu = document.querySelector(hostSelector)?.shadowRoot?.querySelector('.qf-open-menu');
    if (!menu) return null;
    const rect = menu.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }, hostSelector);
}

(async () => {
  const env = await launchWithExtension();
  try {
    const optionsPage = await env.openOptionsPage();
    const base = await env.serve(PAGE);
    const searchUrl = `${base}search?q={query}`;
    // 用指向本地服务的自定义源：两种打开方式都能落到断言得到到的 URL 上，不依赖外网。
    await optionsPage.evaluate(({ searchUrl }) => new Promise((resolve) => chrome.storage.sync.set({
      sources: [{ id: 'probe', name: '测试源', mark: 'T', className: 'custom', url: searchUrl, detail: searchUrl, enabled: true, iconOnly: false }],
      groups: [{ id: 'default', name: '默认组', items: ['probe'], visible: true }],
      triggerMode: 'click', editableTriggerMode: 'click',
      // 用产品默认值 200ms，不压成 0：真实右键后的「菜单被选区收尾带走」，
      // 消失时刻正好跟着这个延时走，压成 0 会让缺陷表现为「根本没显示」，反而看不出根因。
      selectionTriggerDelay: 200, defaultGroupCount: 10,
      searchHistory: [], llmDockVisible: false,
      pinnedSearch: { sites: [], customSites: [], defaultGroupCount: 4, collapseDelay: 60000, openInNewTab: true, allSites: true, siteConfigVersion: 3 },
    }, resolve)), { searchUrl });

    const page = await env.context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}?q=白色主题`);
    await page.waitForSelector(PANEL_HOST, { state: 'attached', timeout: 10000 });
    await page.waitForSelector(PINNED_HOST, { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(600);

    // ── 1. 常驻搜索框改成白色 ────────────────────────────────────────
    console.log('【1】网页常驻搜索框为白底');
    const bar = await readStyle(page, PINNED_HOST, '.bar');
    const query = await readStyle(page, PINNED_HOST, '.pinned-query');
    const entry = await readStyle(page, PINNED_HOST, '.entry');
    check('常驻栏底色是白色（半透明白）', /rgba?\(255, 255, 255/.test(bar?.background || ''), bar?.background);
    check('搜索输入框为白底', query?.background === 'rgb(255, 255, 255)', query?.background);
    check('搜索源按钮为白底', entry?.background === 'rgb(255, 255, 255)', entry?.background);

    // ── 2. 选中文字浮层同样是白底 ───────────────────────────────────
    console.log('【2】选中文字浮层为白底');
    await page.evaluate(() => {
      const node = document.getElementById('text');
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 120, clientY: 120 }));
    });
    await page.waitForTimeout(500);
    await page.locator('.quickfind-trigger').click();
    await page.waitForTimeout(300);
    const panel = await readStyle(page, PANEL_HOST, '.quickfind-panel');
    const engine = await readStyle(page, PANEL_HOST, '.engine-list .engine');
    check('浮层底色是白色（半透明白）', /rgba?\(255, 255, 255/.test(panel?.background || ''), panel?.background);
    check('浮层里的搜索源按钮为白底', engine?.background === 'rgb(255, 255, 255)', engine?.background);

    // ── 3. 右键菜单：选中文字浮层 ───────────────────────────────────
    console.log('【3】在浮层的搜索源图标上右键出菜单');
    await rightClick(page, PANEL_HOST, '.engine-list .engine');
    await page.waitForTimeout(200);
    const panelMenu = await readStyle(page, PANEL_HOST, '.qf-open-menu');
    check('浮层里出现一个菜单', panelMenu?.menuCount === 1, String(panelMenu?.menuCount));
    check('菜单恰好两项：本标签打开 / 新建标签打开', JSON.stringify(panelMenu?.menuItems) === JSON.stringify(['本标签打开', '新建标签打开']), JSON.stringify(panelMenu?.menuItems));

    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    const afterEsc = await readStyle(page, PANEL_HOST, '.qf-open-menu');
    check('Esc 关闭菜单', afterEsc?.menuCount === 0, String(afterEsc?.menuCount));

    // 重新选一次文字（Esc 把浮层与选区一起收掉了），走「本标签打开」。
    await page.evaluate(() => {
      const node = document.getElementById('text');
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 120, clientY: 120 }));
    });
    await page.waitForTimeout(500);
    await page.locator('.quickfind-trigger').click();
    await page.waitForTimeout(300);
    await rightClick(page, PANEL_HOST, '.engine-list .engine');
    await page.waitForTimeout(200);
    await Promise.all([
      page.waitForURL(/\/search\?q=/, { timeout: 10000 }),
      page.locator(`${PANEL_HOST} .qf-open-menu-item`, { hasText: '本标签打开' }).click(),
    ]);
    check('浮层菜单「本标签打开」在本标签完成跳转', page.url().includes('/search?q='), page.url());

    // ── 4. 右键菜单：常驻搜索栏（真实右键手势） ─────────────────────
    console.log('【4】在常驻栏的搜索源图标上真实右键出菜单');
    await page.goto(`${base}?q=白主题`);
    await page.waitForSelector(PINNED_HOST, { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(500);
    // 展开常驻栏再右键（收起态整条栏高度为 0）。
    await page.evaluate((hostSelector) => {
      document.querySelector(hostSelector)?.shadowRoot?.querySelector('.reveal-handle')
        ?.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }));
    }, PINNED_HOST);
    await page.waitForTimeout(400);
    const rightPoint = await realRightClick(page, PINNED_HOST, '.entries .entry');
    check('真实右键命中了常驻栏的搜索源图标', Boolean(rightPoint), JSON.stringify(rightPoint));
    await page.waitForTimeout(200);
    const pinnedMenu = await readStyle(page, PINNED_HOST, '.qf-open-menu');
    check('常驻栏里出现一个菜单', pinnedMenu?.menuCount === 1, String(pinnedMenu?.menuCount));
    check('常驻栏菜单同样是两项', JSON.stringify(pinnedMenu?.menuItems) === JSON.stringify(['本标签打开', '新建标签打开']), JSON.stringify(pinnedMenu?.menuItems));

    // 回归点：菜单曾被「这次右键自己的 mouseup」带走。
    // mouseup 会排定一次选区展示收尾（showForSelection → hideAll），延迟 = selectionTriggerDelay；
    // hideAll 原先无条件关菜单，于是菜单在 200ms 后凭空消失，用户看到的是「闪一下」。
    // 等过这个延时再断言，正是为了让这条路径真的跑过一遍。
    await page.waitForTimeout(600);
    const survived = await readStyle(page, PINNED_HOST, '.qf-open-menu');
    const menuRect = await readMenuRect(page, PINNED_HOST);
    check('600ms 后菜单仍在（不被本次 mouseup 的选区收尾带走）', survived?.menuCount === 1, String(survived?.menuCount));
    check('菜单出现在右键位置附近，而不是被挤走',
      Boolean(menuRect && rightPoint && Math.abs(menuRect.left - rightPoint.x) <= 12 && Math.abs(menuRect.top - rightPoint.y) <= 12),
      JSON.stringify({ menuRect, rightPoint }));

    // 菜单不只「还在」，还要真的点得动：真实鼠标点第二项。
    const [newPage] = await Promise.all([
      env.context.waitForEvent('page', { timeout: 10000 }),
      page.locator(`${PINNED_HOST} .qf-open-menu-item`, { hasText: '新建标签打开' }).click(),
    ]);
    await newPage.waitForLoadState('domcontentloaded').catch(() => {});
    check('「新建标签打开」新开了标签页', newPage.url().includes('/search?q='), newPage.url());
    check('原页面没有被替换', page.url().includes('q=%E7%99%BD%E8%89%B2%E4%B8%BB%E9%A2%98') || page.url().includes('白主题') || page.url().includes('%E7%99%BD%E4%B8%BB%E9%A2%98'), page.url());
    check('新标签带上了查询词', decodeURIComponent(newPage.url()).includes('q=白主题') || decodeURIComponent(newPage.url()).includes('q=白'), decodeURIComponent(newPage.url()));
    await newPage.close();
    const afterPick = await readStyle(page, PINNED_HOST, '.qf-open-menu');
    check('选完之后菜单自行关闭', afterPick?.menuCount === 0, String(afterPick?.menuCount));

    // ── 5. 本标签打开：常驻栏 ───────────────────────────────────────
    console.log('【5】常驻栏菜单「本标签打开」替换当前页');
    await page.waitForTimeout(300);
    await realRightClick(page, PINNED_HOST, '.entries .entry');
    await page.waitForTimeout(200);
    await Promise.all([
      page.waitForURL(/\/search\?q=/, { timeout: 10000 }),
      page.locator(`${PINNED_HOST} .qf-open-menu-item`, { hasText: '本标签打开' }).click(),
    ]);
    check('「本标签打开」在本标签完成跳转', page.url().includes('/search?q='), page.url());

    check('页面未抛出脚本错误', errors.length === 0, JSON.stringify(errors));
  } finally {
    await env.close();
  }
  process.exit(summary());
})().catch((error) => { console.error(error); process.exit(2); });