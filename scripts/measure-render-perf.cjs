/**
 * 渲染开销的实测脚本：常驻搜索栏（页面顶部那条栏）、顶栏图标排、大纲笔记、弹窗。
 *
 * 为什么需要它：这条栏挂在 window 的 scroll / pointermove 与 MutationObserver 上，改动的收益
 * 「看起来」明显，但没法靠读代码判断到底省了什么——尤其分不清「省的是 JS」和「省的是布局」。
 * 所以这里用真实产物 + Chromium 的 Performance 计数器量六类数：
 *
 *   1. 合成滚动事件的派发耗时（内容脚本的监听器就在这一次 dispatchEvent 里同步跑完）；
 *   2. 合成 pointermove 的派发耗时（收起态把手的热区判定走的就是这条路径）；
 *   3. 图标排来回重建 N 轮：每轮都会 replaceChildren 掉整排按钮，量的是「顶栏小图标」
 *      本身的重建成本（含读一次几何，逼样式与排版在当轮算完）；
 *   4. 大纲笔记 300 行时，搜索框每改一次触发的整表重渲染；
 *   5. 弹窗收到「与自身内容无关的存储写入」时，还会不会把标签与搜索源行整批重建；
 *   6. 页面每 40ms 增删一次节点时，每 120ms 一次的挂载在渲染流水线上留下多少次
 *      Layout / RecalcStyle。
 *
 * 第 4 项的关键是让被增删的容器 `display:none`：MutationObserver 照样触发、扩展照样走完整
 * 的挂载路径，但页面自己不需要重排——否则页面自身每帧的重排会把扩展的痕迹整段盖掉
 * （实测用可见节点时，挂不挂常驻栏两档的计数一模一样）。
 *
 * 量法上有两条经验，改脚本时别退化：
 *   - 耗时取 REPEATS 次的**最小值**。这台机器上后台负载能把同一份产物的耗时抬高 2~3 倍
 *     （同一份产物两次跑出 4.7ms / 8.8ms），最小值最接近代码本身要多久。
 *   - 计数（Layout / RecalcStyle）是确定的，取中位数即可，并且比耗时更能说明问题。
 *
 *   node scripts/measure-render-perf.cjs          # 需要先 npm run build
 *   QF_LABEL=改前 node scripts/measure-render-perf.cjs
 */

const { launchWithExtension } = require('../tests/helpers.cjs');

const PINNED_HOST = '#quickfind-pinned-search-host';
const SCROLL_EVENTS = 1000;
const POINTER_EVENTS = 2000;
const IDLE_WINDOW_MS = 3000;
const REBUILD_ROUNDS = 60;
const REPEATS = 5;

/**
 * 给这一批源挂上自定义图标（data URL，16×16）。内置源默认只用文字标记（G / 百 / 360…），
 * 走不到 <img> 那条路径；而「顶栏小图标」里最贵的一档恰恰是用户自己换过图标之后——
 * 每次重建都要重新立 <img>、重新解码。所以图标复用这一项必须用带图标的配置来量。
 */
const ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR42u3NMQEAAAgDoJnc6BpjDyQgd2XKlClTpkyZMmXK1AMLPgAB0Q3l0wAAAABJRU5ErkJggg==';
/** 带图标的源必须写全字段：收敛层（cleanSource）会把缺 name/url 的记录整条丢掉。 */
const ICON_SOURCES = [
  { id: 'google', name: '谷歌', mark: 'G', className: 'google', url: 'https://www.google.com/search?q={query}' },
  { id: 'baidu', name: '百度', mark: '百', className: 'baidu', url: 'https://www.baidu.com/s?wd={query}' },
  { id: 'google-scholar', name: '谷歌学术', mark: 'GS', className: 'google-scholar', url: 'https://scholar.google.com/scholar?q={query}' },
  { id: 'duckduckgo', name: 'DuckDuckGo', mark: 'D', className: 'duckduckgo', url: 'https://duckduckgo.com/?q={query}' },
  { id: 'so', name: '360 搜索', mark: '360', className: 'so', url: 'https://www.so.com/s?q={query}' },
  { id: 'bing', name: 'Bing', mark: 'b', className: 'bing', url: 'https://www.bing.com/search?q={query}' },
  { id: 'yandex', name: 'Yandex', mark: 'Я', className: 'yandex', url: 'https://yandex.com/search/?text={query}' },
  { id: 'bilibili', name: '哔哩哔哩', mark: 'B', className: 'bilibili', url: 'https://search.bilibili.com/all?keyword={query}' },
].map((source) => Object.assign({ enabled: true, iconOnly: false, iconUrl: ICON_DATA_URL }, source));

const config = (overrides = {}) => ({
  searchHistory: [{ query: '实测词', timestamp: Date.now() }],
  sources: ICON_SOURCES,
  sourceConfigVersion: 5,
  // 显式给出默认组与顺序：否则内容脚本会按内置的 engineOrder 兜底，
  // 只有一部分自建源会出现在直排区，图标排的规模就不对了。
  groups: [{ id: 'default', name: '默认', items: ICON_SOURCES.map((source) => source.id), visible: true }],
  engineOrder: ICON_SOURCES.map((source) => source.id),
  pinnedSearch: Object.assign({
    sites: [], customSites: [], defaultGroupCount: 6, collapseDelay: 600000,
    openInNewTab: true, allSites: true, siteConfigVersion: 3,
  }, overrides),
  triggerMode: 'click', editableTriggerMode: 'none', selectionTriggerDelay: 0, llmDockVisible: false,
});

/**
 * 被测页面。`nodes` 控制正文规模（真实结果页动辄上千节点）；`mutation` 选变动方式：
 * 'none' 静止、'visible' 增删可见节点、'hidden' 增删 display:none 里的节点（只惊动扩展）。
 */
const pageHtml = ({ nodes = 0, mutation = 'none' } = {}) => `<!doctype html><meta charset="utf-8"><title>qf perf</title>
<style>body{font:16px sans-serif;margin:0;padding:24px;height:4000px}#site-q{width:360px;height:32px}
#ticker div{height:18px}.results div{padding:4px 0;border-bottom:1px solid #eee}</style>
<body>
  <input id="site-q" name="q" value="实测词" placeholder="搜索" style="width:360px;height:32px">
  <div id="ticker"${mutation === 'hidden' ? ' style="display:none"' : ''}></div>
  <div class="results"></div>
  <script>
    if (${nodes}) {
      const box = document.querySelector('.results');
      for (let i = 0; i < ${nodes}; i += 1) {
        const d = document.createElement('div');
        d.textContent = '结果行 ' + i + ' ' + 'x'.repeat(24);
        box.append(d);
      }
    }
    if (${mutation !== 'none'}) {
      const ticker = document.getElementById('ticker');
      setInterval(() => {
        const d = document.createElement('div');
        d.textContent = String(Math.random()).slice(0, 8);
        ticker.append(d);
        if (ticker.childElementCount > 6) ticker.firstElementChild.remove();
      }, 40);
    }
  </script>
</body>`;

/** 派发一串合成事件，返回总耗时（ms）。监听器在 dispatchEvent 内同步执行。 */
function dispatchBurst(page, kind, count) {
  return page.evaluate(({ kind, count }) => {
    const make = () => (kind === 'pointer'
      ? new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 40, clientY: 700, bubbles: true })
      : new Event('scroll', { bubbles: true }));
    // 预热：JIT、首次样式计算与字体，不计入结果。
    for (let i = 0; i < 50; i += 1) document.body.dispatchEvent(make());
    const started = performance.now();
    for (let i = 0; i < count; i += 1) document.body.dispatchEvent(make());
    return performance.now() - started;
  }, { kind, count });
}

async function metrics(cdp) {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  const map = {};
  for (const item of list) map[item.name] = item.value;
  return map;
}

/** 用 CDP 计数器包住一段操作，返回耗时与增量计数。 */
async function countAround(cdp, fn) {
  await cdp.send('Performance.enable');
  const before = await metrics(cdp);
  const ms = await fn();
  const after = await metrics(cdp);
  return {
    ms,
    layout: after.LayoutCount - before.LayoutCount,
    style: after.RecalcStyleCount - before.RecalcStyleCount,
    layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
    styleMs: (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const fmt = (value) => (Math.round(value * 100) / 100).toFixed(2);

/** 重复 REPEATS 次：耗时取最小值，计数取中位数。 */
async function repeat(fn) {
  const runs = [];
  for (let i = 0; i < REPEATS; i += 1) runs.push(await fn());
  return {
    // 耗时取最小值：这台机器上单次测量会被后台负载抬高 2~3 倍（实测同一份产物两次跑出
    // 4.7ms 与 8.8ms），最小值最接近「这段代码本身要多久」。计数是确定的，取中位数即可。
    ms: Math.min(...runs.map((r) => r.ms)),
    layout: median(runs.map((r) => r.layout)),
    style: median(runs.map((r) => r.style)),
    layoutMs: median(runs.map((r) => r.layoutMs)),
  };
}

(async () => {
  const label = process.env.QF_LABEL || 'current';
  const env = await launchWithExtension();
  const rows = [];
  let collapsedState = null;
  try {
    const optionsPage = await env.openOptionsPage();
    const applyConfig = (value) => optionsPage.evaluate((v) => new Promise((r) => chrome.storage.sync.set(v, r)), value);
    await applyConfig(config());

    const cdpFor = async (page) => {
      const session = await page.context().newCDPSession(page);
      await session.send('Performance.enable');
      return session;
    };

    // ---------- A. 静止页面：滚动 / 指针 ----------
    const page = await env.context.newPage();
    await page.goto(await env.serve(pageHtml()));
    await page.waitForTimeout(1600);
    const mounted = await page.evaluate((host) => Boolean(document.querySelector(host)?.shadowRoot), PINNED_HOST);
    if (!mounted) throw new Error('常驻栏没有挂载，实测无意义');
    const cdp = await cdpFor(page);
    collapsedState = await page.evaluate((host) => document.querySelector(host).classList.contains('is-collapsed'), PINNED_HOST);

    rows.push(['收起态 · 滚动事件 ×' + SCROLL_EVENTS, await repeat(() => countAround(cdp, () => dispatchBurst(page, 'scroll', SCROLL_EVENTS)))]);
    rows.push(['收起态 · pointermove ×' + POINTER_EVENTS, await repeat(() => countAround(cdp, () => dispatchBurst(page, 'pointer', POINTER_EVENTS)))]);

    // 展开后同样的两组：展开态走「指针是否还在栏上」的坐标复核分支。
    await page.evaluate((host) => document.querySelector(host)?.shadowRoot?.querySelector('.reveal-handle')?.click(), PINNED_HOST);
    await page.waitForTimeout(500);
    rows.push(['展开态 · 滚动事件 ×' + SCROLL_EVENTS, await repeat(() => countAround(cdp, () => dispatchBurst(page, 'scroll', SCROLL_EVENTS)))]);
    rows.push(['展开态 · pointermove ×' + POINTER_EVENTS, await repeat(() => countAround(cdp, () => dispatchBurst(page, 'pointer', POINTER_EVENTS)))]);
    await page.close();

    // ---------- C. 图标排整批重建：来回切「更多」，每一轮都会 replaceChildren 掉整排按钮 ----------
    // 这一档量的是「顶栏小图标」本身：重建一次要立多少个节点、图标要不要重新解码。
    // 每轮读一次 .bar 的矩形，逼着样式与排版在这一轮内算完，不能靠「懒到下一帧」蒙混过去。
    const iconPage = await env.context.newPage();
    await iconPage.goto(await env.serve(pageHtml()));
    await iconPage.waitForTimeout(1600);
    await iconPage.evaluate((host) => document.querySelector(host)?.shadowRoot?.querySelector('.reveal-handle')?.click(), PINNED_HOST);
    await iconPage.waitForTimeout(400);
    const iconCdp = await cdpFor(iconPage);
    const iconProbe = await iconPage.evaluate((host) => {
      const root = document.querySelector(host).shadowRoot;
      return { entries: root.querySelectorAll('.entries .entry').length, images: root.querySelectorAll('.entries .mark img').length };
    }, PINNED_HOST);
    rows.push([`图标排重建 ×${REBUILD_ROUNDS}`, await repeat(() => countAround(iconCdp, () => iconPage.evaluate((rounds) => {
      const root = document.querySelector('#quickfind-pinned-search-host').shadowRoot;
      const bar = root.querySelector('.bar');
      const started = performance.now();
      for (let i = 0; i < rounds; i += 1) {
        // 「更多」每点一次都会改变结构指纹 → 整排按钮重建。
        root.querySelector('.entry[data-pinned-more="true"]')?.click();
        // 读一次几何，逼样式与排版在这一轮内算完（否则会被懒到下一帧，量到的只是建 DOM 的时间）。
        bar.getBoundingClientRect();
      }
      return performance.now() - started;
    }, REBUILD_ROUNDS)))]);
    await iconPage.close();

    // ---------- B. 页面变动：每 120ms 一次的挂载在渲染流水线上留下的痕迹 ----------
    // 变动的容器是 display:none，页面自身不需要重排 —— 数出来的每一步都是扩展的。
    for (const [name, cfg] of [
      ['变动页面 · 挂常驻栏', config()],
      ['变动页面 · 对照（不挂）', config({ allSites: false })],
    ]) {
      await applyConfig(cfg);
      const busy = await env.context.newPage();
      await busy.goto(await env.serve(pageHtml({ nodes: 1500, mutation: 'hidden' })));
      await busy.waitForTimeout(1600);
      const busyCdp = await cdpFor(busy);
      const mountedHere = await busy.evaluate((host) => Boolean(document.querySelector(host)?.hidden === false), PINNED_HOST);
      rows.push([`${name} · ${IDLE_WINDOW_MS}ms`, await repeat(() => countAround(busyCdp, () => busy.evaluate(
        (ms) => new Promise((r) => setTimeout(() => r(ms), ms)), IDLE_WINDOW_MS,
      ))), mountedHere]);
      await busy.close();
    }

    // ---------- D. 大纲笔记：搜索框每敲一次都会整表重渲染 ----------
    // 300 行、每行一个 textarea 自适应高度。改前是「挂一行→量一行」，量一次就把已挂上去的
    // 行全部重排一遍，Layout 次数与行数成正比；改后整表一次性挂上、再统一量，只该有 1 次。
    const NOTE_ROWS = 300;
    const NOTE_ROUNDS = 8;
    const notesConfig = {
      searchHistory: [],
      pinnedSearch: { sites: [], customSites: [], defaultGroupCount: 4, collapseDelay: 600000, openInNewTab: true, allSites: true, siteConfigVersion: 3 },
      triggerMode: 'click', editableTriggerMode: 'none', selectionTriggerDelay: 0, llmDockVisible: true,
      llm: { endpoint: '', apiKey: '', model: '', systemPrompt: '', enabled: false },
    };
    await applyConfig(notesConfig);
    const noteNode = (id, parentId, text) => ({ id, parentId, children: [], text, collapsed: false, completed: false, createdAt: 1, updatedAt: 1 });
    const seed = { version: 2, rootId: 'root', updatedAt: 1, nodes: { root: Object.assign(noteNode('root', null, ''), { children: [] }) } };
    for (let i = 0; i < NOTE_ROWS; i += 1) {
      const id = `n-${i}`;
      seed.nodes[id] = noteNode(id, 'root', `大纲项目 ${i} 的一段文字`);
      seed.nodes.root.children.push(id);
    }
    await optionsPage.evaluate((value) => new Promise((r) => chrome.storage.local.set({ 'quickfind-notes': value }, r)), seed);

    const notePage = await env.context.newPage();
    await notePage.goto(await env.serve(pageHtml({ mutation: 'hidden' })));
    await notePage.waitForSelector('#quickfind-shadow-host', { state: 'attached' });
    await notePage.waitForTimeout(1200);
    await notePage.locator('#quickfind-shadow-host .llm-tab[data-tab="outline"]').dispatchEvent('click');
    await notePage.waitForSelector('#quickfind-shadow-host .outline-list .note-row', { timeout: 8000 });
    const noteProbe = await notePage.evaluate(() => document.querySelector('#quickfind-shadow-host').shadowRoot.querySelectorAll('.outline-list .note-row').length);
    const noteCdp = await cdpFor(notePage);
    rows.push([`笔记搜索重渲染 ×${NOTE_ROUNDS}（${NOTE_ROWS} 行）`, await repeat(() => countAround(noteCdp, () => notePage.evaluate(async (rounds) => {
      const root = document.querySelector('#quickfind-shadow-host').shadowRoot;
      const box = root.querySelector('.outline-search-input');
      const started = performance.now();
      for (let i = 0; i < rounds; i += 1) {
        box.value = i % 2 ? '项目' : '项目 ' + i;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        // 搜索框背后有 120ms 防抖，等它真的重渲染完再进入下一轮。
        await new Promise((resolve) => setTimeout(resolve, 220));
      }
      return performance.now() - started;
    }, NOTE_ROUNDS)))]);
    await notePage.close();

    // ---------- E. 弹窗：与弹窗内容无关的存储写入不该触发整表重建 ----------
    // 每次写入一个与配置无关的键，弹窗的 storage.onChanged 就会把整份设置重取 + 重渲染。
    // 改前每写一次都重建「分组标签 + 全部搜索源行」；改后指纹不变，一次也不重建。
    const POPUP_ROUNDS = 10;
    const popupPage = await env.context.newPage();
    await popupPage.goto(`chrome-extension://${env.extId}/popup.html`);
    await popupPage.waitForTimeout(1200);
    const popupProbe = await popupPage.evaluate(() => ({
      tabs: document.querySelectorAll('#group-tabs .group-tab').length,
      rows: document.querySelectorAll('#engine-settings .engine-row').length,
    }));
    const popupCdp = await cdpFor(popupPage);
    rows.push([`弹窗无关存储写入 ×${POPUP_ROUNDS}`, await repeat(async () => countAround(popupCdp, async () => {
      const started = Date.now();
      for (let i = 0; i < POPUP_ROUNDS; i += 1) {
        await optionsPage.evaluate((n) => new Promise((r) => chrome.storage.sync.set({ qfPerfProbe: n }, r)), i);
        await popupPage.waitForTimeout(120);
      }
      return Date.now() - started;
    }))]);
    await popupPage.close();

    console.log('');
    console.log(`===== 常驻栏 / 笔记 / 弹窗 渲染开销（${label}）· 每档 ${REPEATS} 次取最小值 =====`);
    console.log('场景'.padEnd(34) + '耗时(ms)'.padStart(10) + 'Layout'.padStart(8) + 'Layout(ms)'.padStart(12) + 'Style'.padStart(7));
    for (const [name, r] of rows) {
      console.log(
        name.padEnd(34)
        + fmt(r.ms).padStart(10)
        + String(r.layout).padStart(8)
        + fmt(r.layoutMs).padStart(12)
        + String(r.style).padStart(7),
      );
    }
    console.log(`（收起态：${collapsedState}；图标排：${iconProbe.entries} 个条目 / ${iconProbe.images} 枚 <img>；`
      + `笔记：${noteProbe} 行；弹窗：${popupProbe.tabs} 个分组标签 / ${popupProbe.rows} 行搜索源）`);
  } finally {
    await env.close();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

