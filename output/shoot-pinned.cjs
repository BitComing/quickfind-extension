/**
 * 一次性截图：常驻栏收起态 / 展开态 / 分组飞层。
 * 用法：node output/shoot-pinned.cjs
 */
const path = require('path');
const fs = require('fs');
const { launchWithExtension } = require('../tests/helpers.cjs');

const PINNED_HOST = '#quickfind-pinned-search-host';
const OUT = path.resolve(__dirname, 'shots');

const PAGE = `<!doctype html><meta charset="utf-8"><title>shot</title>
<style>body{font:16px sans-serif;margin:0;padding:24px;height:3000px;background:#fff}
#site-q{width:360px;height:32px}h1{font-size:18px;color:#333}</style>
<body><h1>页面正文（用来衬托浮层位置）</h1>
<input id="site-q" name="q" placeholder="搜索" style="width:360px;height:32px">
<p>一段普通页面内容，用于确认浮层没有压住页面元素。</p></body>`;

const CONFIG = {
  searchHistory: [{ query: '绿电炼铝', timestamp: Date.now() }],
  pinnedSearch: { sites: [], customSites: [], defaultGroupCount: 20, collapseDelay: 60000,
    openInNewTab: false, allSites: true, siteConfigVersion: 3 },
  triggerMode: 'click', editableTriggerMode: 'none', selectionTriggerDelay: 0, llmDockVisible: false,
};

(async () => {
  const env = await launchWithExtension();
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const optionsPage = await env.openOptionsPage();
    await optionsPage.evaluate((v) => new Promise((r) => chrome.storage.sync.set(v, r)), CONFIG);
    const url = await env.serve(PAGE);
    const page = await env.context.newPage();
    await page.goto(url);
    await page.waitForTimeout(1600);

    const shotTop = (name) => page.screenshot({ path: path.join(OUT, name), clip: { x: 0, y: 0, width: 1100, height: 260 } });

    // 1. 收起态（贴边把手）
    await page.waitForTimeout(400);
    await shotTop('1-collapsed.png');
    console.log('已存 1-collapsed.png');

    // 2. 划过贴边把手展开
    const h = await page.evaluate((host) => {
      const el = document.querySelector(host);
      const r = el.shadowRoot.querySelector('.reveal-handle').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, PINNED_HOST);
    await page.mouse.move(700, 400);
    await page.mouse.move(700, 2);
    await page.mouse.move(h.x, 1);
    await page.mouse.move(h.x + 1, h.y);
    await page.waitForTimeout(700);
    await shotTop('2-expanded.png');
    console.log('已存 2-expanded.png');

    // 3. 点分组，飞层应贴在图标旁边
    await page.evaluate((host) => {
      const root = document.querySelector(host).shadowRoot;
      const btn = Array.from(root.querySelectorAll('.entries .entry')).find((b) => (b.querySelector('.name')?.textContent || '').trim() === '视频');
      btn?.click();
    }, PINNED_HOST);
    await page.waitForTimeout(500);
    await shotTop('3-flyout-video.png');
    console.log('已存 3-flyout-video.png');

    const geom = await page.evaluate((host) => {
      const root = document.querySelector(host).shadowRoot;
      const r = (n) => { const b = n.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
      const fly = root.querySelector('.pinned-group-list');
      const btn = Array.from(root.querySelectorAll('.entries .entry')).find((b) => (b.querySelector('.name')?.textContent || '').trim() === '视频');
      return { flyout: r(fly), icon: r(btn), bar: r(root.querySelector('.bar')) };
    }, PINNED_HOST);
    console.log('几何：', JSON.stringify(geom));
    console.log('截图目录：', OUT);
  } finally {
    await env.close();
  }
})().catch((e) => { console.error(e); process.exit(2); });