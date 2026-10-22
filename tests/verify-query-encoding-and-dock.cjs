/**
 * 两项行为的回归用例（自包含契约，不依赖 git HEAD）：
 *
 * 【一】常驻搜索框里的查询文字必须还原百分号编码。
 *   缺陷本体：站点的搜索地址若对查询参数编码了两次，`URLSearchParams` 只解一层，
 *   解出来仍是 `%E4%B8%AD%E6%96%87`。常驻栏以「页面查询」为准显示这个值，用户看到的
 *   就是一串「符号 + 数字」而不是中文；这串编码还会经搜索历史扩散到之后每个没有查询的页面。
 *
 * 【二】LLM 右侧栏只能由用户点击打开。
 *   缺陷本体：滑杆与侧栏此前挂了 pointerenter / focus / focusin 的自动展开，鼠标扫过
 *   右边缘或页面把焦点落到滑杆上时，整个面板会自己滑出来——用户无法预期，也关不干净。
 *
 * 边界同时守住：数字与符号输入不被解码逻辑改动（C++、100%、纯数字），侧栏的收起路径
 * 与点击展开后保持显示的行为都在。
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

/** 读侧栏的展开状态，全部取自真实 DOM 状态。 */
const readDock = (page) => page.evaluate((selector) => {
  const root = document.querySelector(selector)?.shadowRoot;
  const dock = root?.querySelector('.llm-dock');
  if (!dock) return null;
  return {
    open: dock.classList.contains('is-open'),
    ariaHidden: root.querySelector('.llm-sidebar')?.getAttribute('aria-hidden'),
    railExpanded: root.querySelector('.llm-rail')?.getAttribute('aria-expanded'),
  };
}, DOCK_HOST);

const clickRail = (page) => page.evaluate((selector) => {
  document.querySelector(selector)?.shadowRoot?.querySelector('.llm-rail')?.click();
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

    // ---------- 二. 侧栏只由点击打开 ----------
    console.log('【二】LLM 右侧栏只由用户点击打开');

    const dock = await openAt();
    const initial = await readDock(dock);
    check('页面加载后侧栏关闭', initial.open === false && initial.ariaHidden === 'true', JSON.stringify(initial));

    await dock.mouse.move(1090, 400);
    await dock.waitForTimeout(800);
    const hovered = await readDock(dock);
    check('鼠标停到右边缘不自动展开（修复点）', hovered.open === false, JSON.stringify(hovered));

    await dock.evaluate((selector) => {
      document.querySelector(selector)?.shadowRoot?.querySelector('.llm-rail')?.focus();
    }, DOCK_HOST);
    await dock.waitForTimeout(500);
    const focused = await readDock(dock);
    check('滑杆被聚焦不自动展开（修复点）', focused.open === false, JSON.stringify(focused));

    await clickRail(dock);
    await dock.waitForTimeout(500);
    const opened = await readDock(dock);
    check('点击滑杆后展开', opened.open === true && opened.railExpanded === 'true', JSON.stringify(opened));

    await dock.mouse.move(300, 300);
    await dock.waitForTimeout(900);
    const stayed = await readDock(dock);
    check('点击展开后鼠标移开仍保持显示', stayed.open === true, JSON.stringify(stayed));

    await clickRail(dock);
    await dock.waitForTimeout(600);
    const closed = await readDock(dock);
    check('再次点击收起', closed.open === false && closed.ariaHidden === 'true', JSON.stringify(closed));

    await dock.close();
    console.log('');

    // ---------- 三. 进入对话不自动展开 ----------
    console.log('【三】进入对话不自动展开（仅有会话时也不自动弹）');
    const chat = await env.context.newPage();
    await chat.goto(baseUrl);
    await chat.waitForTimeout(1300);
    const beforeOpen = await readDock(chat);
    check('进入页面对话层未打开、侧栏未展开', beforeOpen.open === false, JSON.stringify(beforeOpen));

    // 打开侧栏后点一张历史卡片（若历史为空则跳过），确认进入对话不会把侧栏状态搞乱。
    await clickRail(chat);
    await chat.waitForTimeout(500);
    const afterClick = await readDock(chat);
    check('点击后侧栏展开、对话层仍是关闭的', afterClick.open === true, JSON.stringify(afterClick));
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