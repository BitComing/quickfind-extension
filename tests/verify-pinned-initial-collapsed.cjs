/**
 * 常驻搜索栏「打开就已是收起态」的回归用例。
 *
 * 用户报告：打开网页时，常驻搜索栏会**先展开一下再收起**（一刹那的展开/收起），
 * 正确行为是它从第一帧起就停在收起态（只剩那根细把手），中途不得出现展开帧。
 *
 * 为什么必须逐帧取证：这类缺陷用「加载完再看一眼」是测不出来的——1~2 帧的展开在
 * `waitForTimeout(1000)` 之后早已消失。所以用例在页面里注入一个 rAF 采样器，
 * 从导航开始记下**每一帧**的宿主状态（hidden / is-collapsed / .bar 实测高度），
 * 再断言整个过程里不存在「可见且未收起」的帧。
 *
 * 为什么要一条对照断言：全流程没有展开帧也可能是采样器压根没跑（宿主从未出现、
 * rAF 被节流）。所以最后主动展开一次，证明同一套采样器确实能抓到展开态，
 * 让「没有展开帧」这条断言不会是恒真的。
 *
 * 页面按真实结果页的特征造：加载即滚动（还原滚动位置）、DOM 持续增删（埋点/推荐位），
 * 这两条都会触发 positionPinnedBar / schedulePinnedMount 的早期路径。
 */

const { createChecker, launchWithExtension } = require('./helpers.cjs');

const PINNED_HOST = '#quickfind-pinned-search-host';
const { check, summary } = createChecker();

const pageHtml = `<!doctype html><meta charset="utf-8"><title>qf pinned initial collapse</title>
<style>body{font:16px sans-serif;margin:0;padding:24px;height:3000px}#site-q{width:360px;height:32px}
#ticker div{height:18px}</style>
<body>
  <input id="site-q" name="q" placeholder="搜索" style="width:360px;height:32px">
  <div id="ticker"></div>
  <script>
    // 真实结果页的常态：脚本在加载期滚动（还原位置 / 锚点 / 懒加载），DOM 持续增删。
    requestAnimationFrame(() => window.scrollTo(0, 24));
    setTimeout(() => window.scrollTo(0, 0), 60);
    setInterval(() => {
      const box = document.getElementById('ticker');
      const d = document.createElement('div');
      d.textContent = String(Math.random()).slice(0, 8);
      box.append(d);
      if (box.childElementCount > 6) box.firstElementChild.remove();
    }, 40);
  </script>
</body>`;

const config = () => ({
  searchHistory: [{ query: '回归词', timestamp: Date.now() }],
  pinnedSearch: {
    sites: [], customSites: [], defaultGroupCount: 4, collapseDelay: 1000,
    openInNewTab: true, allSites: true, siteConfigVersion: 3,
  },
  triggerMode: 'click', editableTriggerMode: 'none', selectionTriggerDelay: 0, llmDockVisible: false,
});

/**
 * 逐帧采样器。挂在 document_start（早于内容脚本），所以宿主一出现就能记到。
 * 每帧记一条：时间、hidden、is-collapsed、.bar 的实测高度。
 */
const sampler = () => {
  window.__qfStartSample = (durationMs) => {
    const frames = [];
    window.__qfFrames = frames;
    // 同一页里可以起多轮采样（对照组要用），所以完成标志必须在这里重置，
    // 否则上一轮的 true 会让 waitForFunction 立刻返回、只读到一两帧。
    window.__qfFramesDone = false;
    const t0 = performance.now();
    const tick = () => {
      const host = document.getElementById('quickfind-pinned-search-host');
      if (host) {
        const root = host.shadowRoot;
        const bar = root && root.querySelector('.bar');
        const box = bar ? bar.getBoundingClientRect() : null;
        frames.push({
          t: Math.round(performance.now() - t0),
          hidden: host.hidden === true,
          collapsed: host.classList.contains('is-collapsed'),
          barH: box ? Math.round(box.height * 10) / 10 : -1,
          entries: root ? root.querySelectorAll('.entries .entry').length : 0,
        });
      }
      if (performance.now() - t0 < durationMs) requestAnimationFrame(tick);
      else window.__qfFramesDone = true;
    };
    requestAnimationFrame(tick);
  };
  window.__qfStartSample(6000);
};

/** 从采样结果里提炼「第一次出现」「可见且展开的帧」两个量。 */
const readFrames = (page) => page.evaluate(() => {
  const frames = window.__qfFrames || [];
  const expanded = frames.filter((f) => !f.hidden && !f.collapsed);
  return {
    total: frames.length,
    done: window.__qfFramesDone === true,
    first: frames[0] || null,
    firstVisible: frames.find((f) => !f.hidden) || null,
    expanded,
    maxExpandedBarH: expanded.reduce((max, f) => Math.max(max, f.barH), 0),
  };
});

(async () => {
  const env = await launchWithExtension();
  try {
    const optionsPage = await env.openOptionsPage();
    await optionsPage.evaluate((value) => new Promise((resolve) => chrome.storage.sync.set(value, resolve)), config());

    const url = await env.serve(pageHtml);

    // ================= 1. 首次打开网页 =================
    console.log('【1】首次打开网页：宿主从第一帧起就是收起态');
    const page = await env.context.newPage();
    await page.addInitScript(sampler);
    await page.goto(url);
    await page.waitForFunction(() => window.__qfFramesDone === true, null, { timeout: 15000 });
    const first = await readFrames(page);
    check('采样覆盖到了宿主（断言非恒真的前提）', first.total > 20 && first.firstVisible !== null,
      `帧数 ${first.total}`);
    check('宿主第一次出现就是收起态（修复点）',
      Boolean(first.firstVisible) && first.firstVisible.collapsed === true,
      JSON.stringify(first.firstVisible));
    check('加载全程没有「可见且展开」的帧（修复点）', first.expanded.length === 0,
      first.expanded.length ? `出现 ${first.expanded.length} 帧展开，最大栏高 ${first.maxExpandedBarH}px，首次 t=${first.expanded[0].t}ms` : '0 帧');

    // 对照：主动展开后，同一套采样器必须能抓到展开帧（否则上一条断言是空的）。
    await page.evaluate(() => window.__qfStartSample(1200));
    await page.evaluate((host) => document.querySelector(host)?.shadowRoot?.querySelector('.reveal-handle')?.click(), PINNED_HOST);
    await page.waitForFunction(() => window.__qfFramesDone === true, null, { timeout: 8000 });
    const control = await readFrames(page);
    check('对照：主动展开后采样器能抓到展开帧（证明断言有效）',
      control.expanded.length > 0 && control.maxExpandedBarH > 4,
      `${control.expanded.length} 帧展开，最大栏高 ${control.maxExpandedBarH}px`);
    await page.close();
    console.log('');

    // ================= 2. 刷新同一页面 =================
    // 刷新比首次打开更容易撞上「浏览器还原滚动位置」这条路径（加载期必然有 scroll 事件）。
    console.log('【2】刷新页面：同样从第一帧起就是收起态');
    const page2 = await env.context.newPage();
    await page2.addInitScript(sampler);
    await page2.goto(url);
    await page2.waitForFunction(() => window.__qfFramesDone === true, null, { timeout: 15000 });
    await page2.evaluate(() => { window.__qfFrames = []; window.__qfFramesDone = false; window.__qfStartSample(6000); });
    await page2.reload();
    await page2.waitForFunction(() => window.__qfFramesDone === true, null, { timeout: 15000 });
    const reload = await readFrames(page2);
    check('刷新后宿主第一次出现就是收起态（修复点）',
      Boolean(reload.firstVisible) && reload.firstVisible.collapsed === true,
      JSON.stringify(reload.firstVisible));
    check('刷新全程没有「可见且展开」的帧（修复点）', reload.expanded.length === 0,
      reload.expanded.length ? `出现 ${reload.expanded.length} 帧展开，最大栏高 ${reload.maxExpandedBarH}px，首次 t=${reload.expanded[0].t}ms` : '0 帧');
    await page2.close();
  } finally {
    await env.close();
  }
  process.exit(summary());
})();