/**
 * 两项行为的回归用例（自包含契约，不依赖 git HEAD）：
 *
 * 【一】常驻搜索框里的查询文字必须还原百分号编码。
 *   缺陷本体：站点的搜索地址若对查询参数编码了两次，`URLSearchParams` 只解一层，
 *   解出来仍是 `%E4%B8%AD%E6%96%87`。常驻栏以「页面查询」为准显示这个值，用户看到的
 *   就是一串「符号 + 数字」而不是中文；这串编码还会经搜索历史扩散到之后每个没有查询的页面。
 *
 * 【二】网页右侧栏已下线（`shared/features.ts` 的 `PAGE_SIDEBAR_ENABLED`）。
 *   侧栏曾是「滑杆 + 面板」，滑杆扫过或聚焦都会把面板拉出来，属于用户无法预期的自动展开。
 *   现在整块 UI 不再生成：dock 里没有 `.llm-rail` / `.llm-sidebar`，没有对话窗口时整层隐藏。
 *   用例同时守住「旧配置里 `llmDockVisible: true` 也看不见任何东西」——开关已不再决定它。
 *
 * 边界同时守住：数字与符号输入不被解码逻辑改动（C++、100%、纯数字），
 * 页面加载后也不会自动弹任何面板。
 */

const { createChecker, launchWithExtension } = require('./helpers.cjs');

const HOST = '#quickfind-pinned-search-host';
const DOCK_HOST = '#quickfind-shadow-host';
const { check, summary } = createChecker();

const PINNED = {
  sites: ['google', 'baidu', 'bing', 'yandex', 'zhihu', 'bilibili', 'douyin', 'google-scholar', 'duckduckgo', 'so', 'sogou'],
  customSites: [],
  defaultGroupCount: 4,
  collapseDelay: 60000,
  openInNewTab: false,
  allSites: true,
  siteConfigVersion: 3,
};

const PAGE = '<!doctype html><meta charset="utf-8"><title>qf cjk dock</title>'
  + '<body style="font:16px sans-serif"><form onsubmit="return false">'
  + '<input name="q" style="width:320px;height:30px"></form></body>';

/** 读常驻框的值与码位（码位用于排除终端渲染对中文的干扰）。 */
const readPinned = (page) => page.evaluate((selector) => {
  const input = document.querySelector(selector)?.shadowRoot?.querySelector('.pinned-query');
  const value = input ? input.value : null;
  return { value, codes: value ? Array.from(value).map((char) => char.codePointAt(0).toString(16)) : null };
}, HOST);

const expandPinned = (page) => page.evaluate((selector) => {
  document.querySelector(selector)?.shadowRoot?.querySelector('.reveal-handle')?.click();
}, HOST);

/** 读右侧 dock 的状态：侧栏已下线，这里要能证明「滑杆与面板都不在 DOM 里」。 */
const readDock = (page) => page.evaluate((selector) => {
  const root = document.querySelector(selector)?.shadowRoot;
  const dock = root?.querySelector('.llm-dock');
  if (!dock) return null;
  return {
    hidden: dock.hidden,
    hasRail: Boolean(root.querySelector('.llm-rail')),
    hasSidebar: Boolean(root.querySelector('.llm-sidebar')),
  };
}, DOCK_HOST);

(async () => {
  const env = await launchWithExtension();
  try {
    const optionsPage = await env.openOptionsPage();
    await optionsPage.evaluate((pinned) => new Promise((resolve) => chrome.storage.sync.set(
      { pinnedSearch: pinned, llmDockVisible: true }, resolve)), PINNED);
    const baseUrl = await env.serve(PAGE);

    const openAt = async (suffix = '') => {
      const page = await env.context.newPage();
      await page.goto(baseUrl + suffix);
      await page.waitForTimeout(1300);
      return page;
    };

    // ---------- 一. 编码还原 ----------
    console.log('【一】常驻搜索框的查询文字编码还原');

    const single = await openAt('?q=%E4%B8%AD%E6%96%87');
    await expandPinned(single);
    await single.waitForTimeout(400);
    const decoded = await readPinned(single);
    check('单层百分号编码还原为中文', decoded.value === '中文', JSON.stringify(decoded.value));
    await single.close();

    // 缺陷本体：双重编码。URLSearchParams 只解一层，剩下 %XX 会被直接显示。
    const double = await openAt('?q=%25E4%25B8%25AD%25E6%2596%2587');
    await expandPinned(double);
    await double.waitForTimeout(400);
    const twice = await readPinned(double);
    check('双重编码还原为中文（修复点）', twice.value === '中文', JSON.stringify(twice.value));
    check('还原后的码位是中文而非百分号（4e2d/6587）', JSON.stringify(twice.codes) === '["4e2d","6587"]', JSON.stringify(twice.codes));
    await double.close();

    // 非 UTF-8 字节序列（历史上用 GBK 的站点）超出这一层的能力：URLSearchParams 在
    // 到达这里之前就已把字节解成替换字符，无法还原。这条断言只守住「不退化成百分号转义」，
    // 即本层不会把编码串再留给用户看。乱码问题属既有行为，不在本次修复范围。
    const gbk = await openAt('?q=%D6%D0%CE%C4');
    await expandPinned(gbk);
    await gbk.waitForTimeout(400);
    const gbkValue = await readPinned(gbk);
    check('非 UTF-8 字节序列不退化成百分号转义（既有局限，不扩大）', !String(gbkValue.value).includes('%'), JSON.stringify(gbkValue.value));
    await gbk.close();

    // 既有处理不被破坏：数字、加号、百分号。
    const plain = await openAt('?q=2024');
    await expandPinned(plain);
    await plain.waitForTimeout(400);
    check('纯数字原样保留', (await readPinned(plain)).value === '2024', JSON.stringify((await readPinned(plain)).value));
    await plain.close();

    const symbols = await openAt('?q=C%2B%2B%20100%25');
    await expandPinned(symbols);
    await symbols.waitForTimeout(400);
    const symbolValue = await readPinned(symbols);
    check('加号与百分号按 URL 语义还原为 C++ 100%', symbolValue.value === 'C++ 100%', JSON.stringify(symbolValue.value));
    await symbols.close();

    // 搜索历史里的编码串也要被还原：否则它会作为兜底值铺满之后每个没有查询的页面。
    const historyPage = await env.context.newPage();
    await optionsPage.evaluate(() => new Promise((resolve) => chrome.storage.sync.set(
      { searchHistory: [{ query: '%E4%B8%AD%E6%96%87%E6%90%9C%E7%B4%A2', timestamp: Date.now() }] }, resolve)));
    await historyPage.goto(baseUrl);
    await historyPage.waitForTimeout(1300);
    await expandPinned(historyPage);
    await historyPage.waitForTimeout(400);
    const fromHistory = await readPinned(historyPage);
    check('历史兜底值同样还原为中文', fromHistory.value === '中文搜索', JSON.stringify(fromHistory.value));
    await historyPage.close();
    console.log('');

    // ---------- 二. 网页右侧栏已下线 ----------
    console.log('【二】网页右侧栏已下线（shared/features.ts 的 PAGE_SIDEBAR_ENABLED）');

    // 关键前置：配置里那个旧开关仍然写着「开」。侧栏已不再由它决定，
    // 所以这里顺带守住「旧配置开着也看不见任何东西」。
    const dock = await openAt();
    const initial = await readDock(dock);
    check('dock 里没有滑杆与侧栏节点', initial.hasRail === false && initial.hasSidebar === false, JSON.stringify(initial));
    check('没有对话窗口时 dock 整层隐藏', initial.hidden === true, JSON.stringify(initial));

    await dock.mouse.move(1090, 400);
    await dock.waitForTimeout(800);
    const hovered = await readDock(dock);
    check('鼠标停到右边缘没有任何东西展开（修复点）', hovered.hidden === true && hovered.hasSidebar === false, JSON.stringify(hovered));

    await dock.mouse.click(1098, 400);
    await dock.waitForTimeout(500);
    const clicked = await readDock(dock);
    check('点右边缘也弹不出侧栏', clicked.hidden === true && clicked.hasRail === false, JSON.stringify(clicked));

    await dock.close();
    console.log('');

    // ---------- 三. 进入对话不自动展开 ----------
    console.log('【三】页面加载后不会自动弹任何面板');
    const chat = await env.context.newPage();
    await chat.goto(baseUrl);
    await chat.waitForTimeout(1300);
    const beforeOpen = await readDock(chat);
    check('进入页面 dock 不可见、侧栏不存在', beforeOpen.hidden === true && beforeOpen.hasSidebar === false, JSON.stringify(beforeOpen));
    const layerHidden = await chat.evaluate((selector) => {
      const layer = document.querySelector(selector)?.shadowRoot?.querySelector('.llm-chat-layer');
      return layer ? layer.hidden : null;
    }, DOCK_HOST);
    check('对话层保持关闭（没有自动进入对话）', layerHidden === true, String(layerHidden));
    await chat.close();

    return summary();
  } finally {
    await env.close();
  }
})().then((code) => process.exit(code));