// 设置页「常驻搜索栏」：站点行与「所有站点都显示」互斥。
//
// 契约（2026-11-07 用户确认）：
//   「所有站点都显示」关闭时，「已启用」这一行才出现；开启时整行隐藏。
// 为什么是互斥而不是并存：全站显示之后，站点名单不再影响常驻栏出现在哪，
// 留着这行只会让人以为还得在这里挑站点。断言走真实产物 + 真实点击，
// 因为这条契约全部落在「看起来有没有」上，脚本直接改 hidden 测不到点击路径。

const { launchWithExtension, createChecker } = require('./helpers.cjs');

const { check, summary } = createChecker();

/** 行是否真的占位（hidden 属性可能被 display:flex 压过，只看属性不够）。 */
async function rowState(page) {
  return page.evaluate(() => {
    const row = document.querySelector('#pinned-sites-row');
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    const manage = document.querySelector('#manage-pinned-sites');
    return {
      hidden: row.hidden,
      height: Math.round(rect.height),
      display: getComputedStyle(row).display,
      summary: document.querySelector('#pinned-site-summary')?.textContent.trim() || '',
      manageVisible: Boolean(manage && manage.getBoundingClientRect().height > 0),
      allSites: document.querySelector('#pinned-all-sites')?.checked ?? null,
    };
  });
}

/** sync 存储里的 allSites，用来确认开关确实落盘而不只是改了页面。 */
async function storedAllSites(page) {
  return page.evaluate(() => new Promise((resolve) => {
    chrome.storage.sync.get(['pinnedSearch'], (all) => resolve(all?.pinnedSearch?.allSites ?? null));
  }));
}

(async () => {
  const env = await launchWithExtension();
  try {
    const page = await env.openOptionsPage();
    // 固定前置状态：全站显示打开。写入后必须重载，让页面走一遍「读配置 → 同步显隐」。
    await page.evaluate(() => new Promise((resolve) => {
      chrome.storage.sync.get(['pinnedSearch'], (all) => {
        chrome.storage.sync.set({
          pinnedSearch: { ...(all?.pinnedSearch || {}), allSites: true },
        }, resolve);
      });
    }));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#pinned-sites-row') && document.querySelector('#pinned-all-sites'));
    await page.click('.nav-item[data-panel="common"]');
    await page.waitForTimeout(200);

    console.log('【1】「所有站点都显示」开着时，站点行隐藏');
    const onState = await rowState(page);
    check('开关处于开启态', onState?.allSites === true, String(onState?.allSites));
    check('行带 hidden 属性', onState?.hidden === true, String(onState?.hidden));
    check('行不占位（display 收掉 / 高度为 0）', onState?.height === 0, `${onState?.display} / ${onState?.height}px`);
    check('「管理」按钮随之不可见', onState?.manageVisible === false, String(onState?.manageVisible));
    console.log('');

    console.log('【2】关掉开关：站点行出现');
    await page.click('#pinned-all-sites + span');
    await page.waitForTimeout(200);
    const offState = await rowState(page);
    check('开关已关闭', offState?.allSites === false, String(offState?.allSites));
    check('行已取消 hidden', offState?.hidden === false, String(offState?.hidden));
    check('行重新占位', (offState?.height || 0) > 0, `${offState?.display} / ${offState?.height}px`);
    check('「管理」按钮可见', offState?.manageVisible === true, String(offState?.manageVisible));
    check('站点摘要仍有内容', Boolean(offState?.summary), offState?.summary);
    check('开关状态已写入 sync', (await storedAllSites(page)) === false, String(await storedAllSites(page)));
    console.log('');

    console.log('【3】重新打开开关：站点行再次隐藏');
    await page.click('#pinned-all-sites + span');
    await page.waitForTimeout(200);
    const backState = await rowState(page);
    check('行再次隐藏', backState?.hidden === true && backState?.height === 0, `${backState?.hidden} / ${backState?.height}px`);
    check('开关状态已写入 sync', (await storedAllSites(page)) === true, String(await storedAllSites(page)));
    console.log('');

    console.log('【4】刷新后按存储恢复显隐（关闭态）');
    await page.evaluate(() => new Promise((resolve) => {
      chrome.storage.sync.get(['pinnedSearch'], (all) => {
        chrome.storage.sync.set({
          pinnedSearch: { ...(all?.pinnedSearch || {}), allSites: false },
        }, resolve);
      });
    }));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#pinned-all-sites'));
    await page.click('.nav-item[data-panel="common"]');
    await page.waitForTimeout(200);
    const reloaded = await rowState(page);
    check('刷新后开关为关闭态', reloaded?.allSites === false, String(reloaded?.allSites));
    check('刷新后站点行可见', reloaded?.hidden === false && (reloaded?.height || 0) > 0, `${reloaded?.hidden} / ${reloaded?.height}px`);
    check('首屏不是先显示再收起（无可见残留）', reloaded?.manageVisible === true, String(reloaded?.manageVisible));
  } finally {
    await env.close();
  }
  process.exit(summary());
})();