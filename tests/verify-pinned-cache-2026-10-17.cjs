// 一次性验证脚本（用完即删）。
// 目标：P1（schedulePinnedMount 守卫顺序）与 P2（站点/条目记忆化）的行为等价性。
//
// 这两项改动的风险不在「算得对不对」，而在「什么时候不算」：
//   P1 的早退多了一层，要证明它没有把「该挂载」的时机也挡掉；
//   P2 加了缓存，要证明设置变更后常驻栏能立刻跟着变（缓存失效）。
//
// 所有断言都落在真实扩展上：加载构建产物 → 打开真实页面 → 直接读 shadow root 与 storage。

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { resolvePlaywright, EXT, resolveChrome } = require('./helpers.cjs');
const { chromium } = resolvePlaywright();
const CHROME = resolveChrome(chromium);
const HOST = '#quickfind-pinned-search-host';

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  → ' + detail}`);
}

/** 读常驻栏的可见状态：它是否挂在页面上、是否可见、直接条目有哪些。 */
async function barState(page) {
  return page.evaluate((hostSelector) => {
    const host = document.querySelector(hostSelector);
    if (!host) return { attached: false, hidden: null, collapsed: null, entries: [], total: 0, hasHandle: null, hasMore: false };
    const root = host.shadowRoot;
    const label = (b) => b.dataset.sourceId || b.dataset.groupId || b.title || b.textContent.trim();
    const all = root ? Array.from(root.querySelectorAll('.entries .entry')) : [];
    // 「更多」按钮也是 .entry，但它不是一条搜索源，单独计。
    const real = all.filter((b) => b.dataset.pinnedMore !== 'true');
    const listEls = root ? Array.from(root.querySelectorAll('.pinned-group-list .entry')) : [];
    return {
      attached: true,
      hidden: host.hidden,
      display: getComputedStyle(host).display,
      collapsed: host.classList.contains('is-collapsed'),
      entries: real.map(label),
      groupEntries: listEls.map(label),
      total: real.length,
      hasMore: all.some((b) => b.dataset.pinnedMore === 'true'),
      hasHandle: Boolean(root && root.querySelector('.reveal-handle')),
    };
  }, HOST);
}

/**
 * 改 sync 存储模拟用户在选项页改设置。必须在扩展上下文里做：
 * 内容脚本跑在隔离世界，页面主世界看不到 chrome.storage。
 */
async function setSync(extPage, patch) {
  return extPage.evaluate((p) => new Promise((resolve) => chrome.storage.sync.set(p, resolve)), patch);
}

function pinnedPatch(overrides) {
  return {
    pinnedSearch: Object.assign({
      sites: ['google', 'baidu', 'google-scholar', 'duckduckgo', 'so', 'sogou', 'bing', 'yandex', 'zhihu', 'bilibili', 'douyin'],
      customSites: [], defaultGroupCount: 4, collapseDelay: 1000, openInNewTab: false, allSites: true, siteConfigVersion: 3,
    }, overrides),
  };
}

(async () => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><meta charset="utf-8"><title>qf pinned verify</title>
      <body style="font:16px sans-serif">
        <p id="text">常驻栏行为验证页面，用来提供一段可读文本。</p>
        <div id="mount"></div>
      </body>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const URL_UNDER_TEST = `http://127.0.0.1:${port}/`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-pinned-perf-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: !process.env.QF_HEADED,
    executablePath: CHROME,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
    viewport: { width: 1100, height: 800 },
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extId = new URL(worker.url()).host;
  console.log(`扩展已加载：${extId}\n`);

  // 先用选项页把配置落盘，再打开被测页面，避免「新装默认值尚未写入」的歧义。
  // 这个页面同时留作「扩展上下文」用来改存储（页面主世界访问不到 chrome.storage）。
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extId}/options.html`);
  await optionsPage.waitForTimeout(1500);
  await setSync(optionsPage, pinnedPatch({}));
  await optionsPage.waitForTimeout(400);

  const page = await context.newPage();
  page.on('pageerror', (error) => { failures += 1; console.log(`  FAIL  页面抛错：${error.message}`); });
  await page.goto(URL_UNDER_TEST);
  await page.waitForTimeout(1200);

  // ---------- 1. P1：默认配置（allSites=true）下必须挂上 ----------
  // 这一条同时兜住「守卫顺序改错」的风险：如果早退条件写反，这里会直接不挂载。
  console.log('【1】默认配置下常驻栏正常挂载（P1 守卫顺序未误伤）');
  const initial = await barState(page);
  check('常驻栏已挂到页面上', initial.attached, JSON.stringify({ attached: initial.attached }));
  check('未处于 hidden', initial.hidden === false);
  check('收起态把手存在', initial.hasHandle === true);
  check('直接条目数 = 默认分组展示数量 4', initial.total === 4, `实际 ${initial.total}: ${JSON.stringify(initial.entries)}`);
  console.log(`        条目：${JSON.stringify(initial.entries)}\n`);

  // ---------- 2. P2：设置变更必须立刻反映到常驻栏（缓存失效） ----------
  console.log('【2】改动设置后常驻栏立刻跟随（P2 缓存失效）');

  // 2a. 改 defaultGroupCount → 直接条目数应从 4 变 2（其余 2 条进「更多」）
  await setSync(optionsPage, pinnedPatch({ defaultGroupCount: 2 }));
  await page.waitForTimeout(700);
  const afterCount = await barState(page);
  check('defaultGroupCount 4→2 后直接条目数跟随', afterCount.total === 2, `实际 ${afterCount.total}: ${JSON.stringify(afterCount.entries)}`);
  check('超出部分转入「更多」按钮', afterCount.hasMore === true, JSON.stringify({ hasMore: afterCount.hasMore }));

  // 2b. 把 allSites 关掉、并把站点白名单清空 → 当前非搜索引擎页面应当不再出现常驻栏
  await setSync(optionsPage, pinnedPatch({ sites: [], allSites: false }));
  await page.waitForTimeout(700);
  const afterAllSitesOff = await barState(page);
  check('关掉 allSites 且白名单为空后常驻栏隐藏', afterAllSitesOff.hidden === true || afterAllSitesOff.display === 'none', JSON.stringify({ hidden: afterAllSitesOff.hidden, display: afterAllSitesOff.display }));

  // 2c. 恢复 allSites → 必须重新出现（证明缓存被正确重建，而不是残留「不该显示」的结论）
  await setSync(optionsPage, pinnedPatch({}));
  await page.waitForTimeout(700);
  const restored = await barState(page);
  check('恢复 allSites 后常驻栏重新出现', restored.hidden === false && restored.total === 4, JSON.stringify({ hidden: restored.hidden, total: restored.total }));
  console.log('');

  // ---------- 3. P2：缓存不得跨 URL 复用 ----------
  console.log('【3】路由变化后缓存按 URL 失效');
  await page.goto(`${URL_UNDER_TEST}#/route-changed`);
  await page.waitForTimeout(900);
  const afterHash = await barState(page);
  check('hash 变化后常驻栏仍正常（未因缓存 key 漂移而丢失）', afterHash.hidden === false && afterHash.total === 4, JSON.stringify({ hidden: afterHash.hidden, total: afterHash.total }));
  console.log('');

  // ---------- 4. P1：DOM 反复变动下不应重复重建（真实 SPA 压力） ----------
  console.log('【4】高频 DOM 变动下的稳定性（MutationObserver 压力）');
  await page.evaluate(() => {
    const mount = document.getElementById('mount');
    for (let i = 0; i < 300; i += 1) {
      const div = document.createElement('div');
      div.textContent = 'row ' + i;
      mount.appendChild(div);
    }
  });
  await page.waitForTimeout(1000);
  const afterChurn = await barState(page);
  check('大量 DOM 插入后常驻栏状态未被破坏', afterChurn.hidden === false && afterChurn.total === 4, JSON.stringify({ hidden: afterChurn.hidden, total: afterChurn.total }));

  // 展开与分组浮层仍可用（证明挂载路径本身没被早退伤到）
  await page.evaluate((hostSelector) => {
    const root = document.querySelector(hostSelector)?.shadowRoot;
    root?.querySelector('.reveal-handle')?.dispatchEvent(new MouseEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }));
  }, HOST);
  await page.waitForTimeout(400);
  const expandedState = await barState(page);
  check('划过把手可正常展开', expandedState.collapsed === false, JSON.stringify({ collapsed: expandedState.collapsed }));

  console.log('');
  console.log(`========== ${failures === 0 ? '全部通过' : failures + ' 项未通过'} ==========`);
  await context.close();
  await new Promise((resolve) => server.close(resolve));
  process.exit(failures === 0 ? 0 : 1);
})();