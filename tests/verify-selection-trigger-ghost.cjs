/**
 * 「取消选词后，搜索图标还藏在旧位置影响使用」的行为契约。
 *
 * 用户反馈：滑动选词后取消选词，图标虽然看不见了，但旧位置的 25×25 区域还在，
 * 鼠标扫过去图标又会冒出来，点页面也点不动。
 *
 * 根因是触发点隐藏时只把 opacity 压到 0，`pointer-events` 仍是 auto：
 *   一、透明按钮继续参与命中测试，旧位置吞掉页面自己的点击；
 *   二、`:hover` 只认命中不认透明度，指针移上去会把图标重新点亮。
 *
 * 断言全部走真实拖选与真实点击，读计算样式和命中测试，不靠源码推断；
 * 最后再做一次重新选词的正向对照，证明触发点本身没有被修坏。
 */

const { createChecker, launchWithExtension } = require('./helpers.cjs');

const PANEL_HOST = '#quickfind-shadow-host';
const { check, summary } = createChecker();

const PAGE = `<!doctype html><meta charset="utf-8"><title>qf trigger ghost</title>
<style>
  body{font:16px/1.8 system-ui,sans-serif;margin:0;padding:24px;height:1600px}
  p{width:560px;margin:0 0 14px}
  #hitbtn{position:absolute;left:0;top:0;z-index:0}
</style>
<body>
  <p id="text">这一段文字用来做真实拖选，取消选词之后检查图标是否还残留在旧位置。</p>
  <p id="text2">重新选这一行，确认触发图标仍然能正常出现并接收点击。</p>
  <button id="hitbtn">页面自己的按钮</button>
</body>`;

/** 读触发点状态：可见类名、计算透明度 / pointer-events、旧位置的命中结果。 */
const readTrigger = (page) => page.evaluate((selector) => {
  const root = document.querySelector(selector)?.shadowRoot;
  const trigger = root?.querySelector('.quickfind-trigger');
  if (!trigger) return null;
  const rect = trigger.getBoundingClientRect();
  const style = getComputedStyle(trigger);
  const cx = Math.round(rect.left + rect.width / 2);
  const cy = Math.round(rect.top + rect.height / 2);
  const inner = root.elementFromPoint ? root.elementFromPoint(cx, cy) : null;
  return {
    visible: trigger.classList.contains('visible'),
    opacity: Number.parseFloat(style.opacity),
    pointerEvents: style.pointerEvents,
    center: [cx, cy],
    hitsTrigger: Boolean(inner && (inner === trigger || trigger.contains(inner))),
    selection: (window.getSelection()?.toString() || '').replace(/\s+/g, ' ').trim().slice(0, 24),
  };
}, PANEL_HOST);

/** 在指定段落上真实拖选一段文字。 */
const dragSelect = async (page, selector) => {
  const box = await page.evaluate((sel) => {
    const rect = document.querySelector(sel).getBoundingClientRect();
    return { x: rect.x + 4, y: rect.y + 10, ex: rect.x + 260, ey: rect.y + 10 };
  }, selector);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.ex, box.ey, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
};

(async () => {
  const env = await launchWithExtension();
  try {
    const optionsPage = await env.openOptionsPage();
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

    // ---------- 前置：真实拖选后图标出现，且可交互 ----------
    console.log('【1】拖选出现图标（前置条件）');
    await dragSelect(page, '#text');
    const shown = await readTrigger(page);
    check('拖选后图标可见', shown !== null && shown.visible === true, JSON.stringify(shown));
    check('可见图标的 pointer-events 为 auto（本来就能点）',
      shown !== null && shown.pointerEvents === 'auto', JSON.stringify(shown));

    // ---------- 点空白取消选词 ----------
    console.log('\n【2】取消选词后，旧位置不能留下透明热区');
    await page.mouse.click(760, 620);
    await page.waitForTimeout(600);
    const gone = await readTrigger(page);
    check('取消选词后图标收起（类名 + 不透明度）',
      gone !== null && gone.visible === false && gone.opacity === 0, JSON.stringify(gone));
    check('隐藏图标的 pointer-events 为 none（不再拦截指针）',
      gone !== null && gone.pointerEvents === 'none', JSON.stringify(gone));
    check('旧位置命中测试不会命中隐藏图标',
      gone !== null && gone.hitsTrigger === false, JSON.stringify(gone));

    // ---------- 指针移回旧位置，图标不能借 :hover 复活 ----------
    console.log('\n【3】指针扫过旧位置，隐藏图标不能重新出现');
    const [cx, cy] = gone.center;
    await page.mouse.move(cx - 3, cy - 3);
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(400);
    const hovered = await readTrigger(page);
    check('悬停旧位置后图标仍保持隐藏（不透明度为 0）',
      hovered !== null && hovered.visible === false && hovered.opacity === 0, JSON.stringify(hovered));

    // ---------- 旧位置上的页面元素必须能正常点击 ----------
    console.log('\n【4】旧位置上的页面按钮照常可点');
    await page.evaluate(({ x, y }) => {
      const btn = document.getElementById('hitbtn');
      btn.style.left = `${x - 30}px`;
      btn.style.top = `${y - 12}px`;
      btn.style.zIndex = '1';
      btn.addEventListener('click', () => { window.__hit = (window.__hit || 0) + 1; });
    }, { x: cx, y: cy });
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(400);
    const hit = await page.evaluate(() => ({
      count: window.__hit || 0,
      active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
    }));
    check('点击旧位置能落到页面按钮上', hit.count === 1 && hit.active === 'hitbtn', JSON.stringify(hit));

    // ---------- 正向对照：重新选词，图标照常出现并可交互 ----------
    console.log('\n【5】重新选词后图标照常出现（修复没有弄坏触发点）');
    await dragSelect(page, '#text2');
    const again = await readTrigger(page);
    check('重新拖选后图标再次可见', again !== null && again.visible === true, JSON.stringify(again));
    check('重新出现的图标 pointer-events 恢复为 auto',
      again !== null && again.pointerEvents === 'auto', JSON.stringify(again));
    check('重新出现的图标在旧位置上可被命中',
      again !== null && again.hitsTrigger === true, JSON.stringify(again));

    check('全程没有页面脚本抛错', errors.length === 0, errors.join(' | '));
    return summary();
  } finally {
    await env.close();
  }
})().then((code) => process.exit(code)).catch((error) => {
  console.error(error);
  process.exit(2);
});
